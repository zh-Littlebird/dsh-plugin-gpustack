/** `gpustack_update_model`: merge new fields into a model spec and optionally restart. */

import { defineTool } from '../tool.js'
import { S } from '../schema.js'
import { GpuStackError } from '../errors.js'
import { buildModelSpec, pickUpdateFields, requiresRestart } from '../spec.js'
import { requireScope } from '../permissions.js'
import { waitForModel } from '../wait.js'
import { modelRow } from './rows.js'
import { MODEL_ROW_SCHEMA, NULLABLE_INTEGER, NULLABLE_STRING } from './schemas.js'

const OUTPUT_SCHEMA = S.object(
  {
    ok: S.boolean({ required: true }),
    modelId: S.integer({ required: true }),
    name: S.string({ required: true }),
    changed: S.array(S.string(), { required: true }),
    restarted: S.boolean({ required: true }),
    restartMessage: NULLABLE_STRING,
    state: NULLABLE_STRING,
    readyReplicas: NULLABLE_INTEGER,
    replicas: NULLABLE_INTEGER,
    waited: S.boolean({ required: true }),
    waitTimedOut: S.boolean({ required: true }),
    waitState: NULLABLE_STRING,
    elapsedMs: S.integer({ required: true }),
    model: S.oneOf([MODEL_ROW_SCHEMA, S.null()]),
    hint: NULLABLE_STRING,
  },
  { additionalProperties: false },
)

function render(value) {
  const lines = [
    `已更新模型 #${value.modelId} ${value.name}`,
    `  变更字段: ${value.changed.length > 0 ? value.changed.join(', ') : '（无）'}`,
    `  状态: ${value.state ?? '未知'} ready=${value.readyReplicas ?? '?'}/${value.replicas ?? '?'}`,
    `  重启: ${value.restarted ? '已触发' : '未触发'}${value.restartMessage !== null ? `（${value.restartMessage}）` : ''}`,
  ]
  if (value.waited) {
    lines.push(`  等待 ${value.elapsedMs} ms：state=${value.waitState ?? '未知'}${value.waitTimedOut ? '（超时）' : ''}`)
  }
  if (value.hint !== null) lines.push('', value.hint)
  return [{ type: 'text', text: lines.join('\n') }]
}

function same(a, b) {
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return a === b
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Register the update tool. */
export function registerUpdateTool(ctx, deps) {
  ctx.tools.register(
    defineTool({
      name: 'gpustack_update_model',
      description:
        '更新已有模型的规格（PUT /v2/models/{id}）：先回读当前模型，合并本次字段后整体提交，只报告真正变化的字段。' +
        '改副本数是扩容入口（replicas）；改 backendParameters/env/镜像/PD 配置属于引擎启动参数，必须 restart=true 才会落到进程，只看到 PUT 200 不能算生效。' +
        'env 与 workerSelector 是按键合并而不是整体替换，避免误删已有配置。' +
        '其余 ModelUpdate 字段放 extra；非预期的字段名会被服务端 422 拒绝。',
      parameters: S.object(
        {
          modelId: S.integer({ required: true, description: '要更新的模型 id。' }),
          replicas: S.integer({ description: '新的副本数（扩容/缩容）。' }),
          backend: S.string({ description: '推理后端名。' }),
          backendVersion: S.string({ description: '后端版本。' }),
          backendParameters: S.array(S.string(), { description: '后端启动参数（逐 token；重启后生效）。' }),
          env: S.any({ description: '要新增/覆盖的环境变量（按键合并）。' }),
          imageName: S.string({ description: '覆盖镜像（重启后生效）。' }),
          runCommand: S.string({ description: '覆盖启动命令（重启后生效）。' }),
          description: S.string({ description: '备注。' }),
          categories: S.array(S.string(), { description: '分类标签（整体替换）。' }),
          accessPolicy: S.string({ description: '访问策略。', enum: ['public', 'authed', 'allowed_principals'] }),
          gpuType: S.string({ description: '按卡型放置（与 gpuIds 二选一）。' }),
          gpusPerReplica: S.integer({ description: '每副本卡数。' }),
          gpuIds: S.array(S.string(), { description: '绑定具体 GPU 的 id/uuid 列表。' }),
          slicedMemoryPercentage: S.integer({ description: '卡型切片显存百分比（0-100）。' }),
          workerSelector: S.any({ description: 'worker 标签选择器（按键合并）。' }),
          clusterId: S.integer({ description: '迁移到另一个集群（谨慎）。' }),
          extra: S.any({ description: '其余 ModelUpdate 字段原样合并，如 disaggregation、extended_kv_cache、scaling_schedule、lora_list。' }),
          restart: S.boolean({ description: '提交后是否 POST /restart 让新规格落到进程（默认 false）。' }),
          wait: S.boolean({ description: '是否等待到 running/error（默认 false；restart=true 时建议开启）。' }),
          waitTimeoutSec: S.integer({ description: 'wait=true 时的等待上限（秒），默认 300，最大 3600。' }),
        },
        { additionalProperties: false },
      ),
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => render(value),
      },
      async execute(args, exec) {
        const { settings, client } = await deps.context()
        requireScope(settings, 'update')

        const startedAt = Date.now()
        const current = await client.get(`/v2/models/${args.modelId}`, {}, { signal: exec.signal })
        const model = current.body
        if (model === null || typeof model !== 'object' || Array.isArray(model)) {
          throw new GpuStackError('UNEXPECTED_RESPONSE', `模型 ${args.modelId} 的详情不是对象`, {
            hint: '确认 id 存在；先 gpustack_models 列出模型。',
          })
        }

        const patch = buildModelSpec(args)
        if (Object.keys(patch).length === 0) {
          throw new GpuStackError('INVALID_ARGS', '没有任何要更新的字段', {
            hint: '至少提供一个字段（如 replicas、backendParameters、env、extra）。',
          })
        }

        const base = pickUpdateFields(model)
        if (patch.env !== undefined) {
          patch.env = { ...(isPlainObject(base.env) ? base.env : {}), ...patch.env }
        }
        if (patch.worker_selector !== undefined) {
          patch.worker_selector = {
            ...(isPlainObject(base.worker_selector) ? base.worker_selector : {}),
            ...patch.worker_selector,
          }
        }

        const candidate = { ...base, ...patch }
        const changed = Object.keys(patch).filter((field) => !same(base[field], candidate[field]))
        if (changed.length === 0) {
          const value = {
            ok: true,
            modelId: args.modelId,
            name: typeof model.name === 'string' ? model.name : '',
            changed: [],
            restarted: false,
            restartMessage: null,
            state: typeof model.state === 'string' ? model.state : null,
            readyReplicas: typeof model.ready_replicas === 'number' ? model.ready_replicas : null,
            replicas: typeof model.replicas === 'number' ? model.replicas : null,
            waited: false,
            waitTimedOut: false,
            waitState: null,
            elapsedMs: Date.now() - startedAt,
            model: modelRow(model),
            hint: '提交的字段与当前值完全相同，未发起 PUT。',
          }
          return value
        }

        const updated = await client.request({
          method: 'PUT',
          path: `/v2/models/${args.modelId}`,
          body: candidate,
          signal: exec.signal,
        })
        deps.record('gpustack_update_model', {
          api: 'management',
          method: 'PUT',
          path: `/v2/models/${args.modelId}`,
          status: updated.status,
          ok: true,
          durationMs: updated.durationMs,
        })

        let restarted = false
        let restartMessage = null
        if (args.restart === true) {
          const restart = await client.request({
            method: 'POST',
            path: `/v2/models/${args.modelId}/restart`,
            signal: exec.signal,
          })
          restarted = true
          restartMessage =
            restart.json !== null && typeof restart.json === 'object' && typeof restart.json.message === 'string'
              ? restart.json.message
              : null
        }

        let state = typeof updated.json?.state === 'string' ? updated.json.state : null
        let readyReplicas = typeof updated.json?.ready_replicas === 'number' ? updated.json.ready_replicas : null
        let replicas = typeof updated.json?.replicas === 'number' ? updated.json.replicas : null
        let waitedFlag = false
        let waitTimedOut = false
        let waitState = null

        if (args.wait === true) {
          const timeoutSec = typeof args.waitTimeoutSec === 'number' ? Math.min(3600, Math.max(5, args.waitTimeoutSec)) : 300
          const waited = await waitForModel(client, args.modelId, {
            signal: exec.signal,
            timeoutMs: timeoutSec * 1000,
            intervalMs: 5_000,
          })
          waitedFlag = true
          waitTimedOut = waited.timedOut
          waitState = waited.state
          state = waited.state
          readyReplicas = waited.readyReplicas
          replicas = waited.replicas
        } else if (restarted) {
          // A restarting model reports transitional state; report it verbatim.
          const fresh = await client.get(`/v2/models/${args.modelId}`, {}, { signal: exec.signal })
          state = typeof fresh.body?.state === 'string' ? fresh.body.state : state
          readyReplicas = typeof fresh.body?.ready_replicas === 'number' ? fresh.body.ready_replicas : readyReplicas
          replicas = typeof fresh.body?.replicas === 'number' ? fresh.body.replicas : replicas
        }

        const engineChanged = requiresRestart(changed)
        let hint = null
        if (engineChanged && args.restart !== true) {
          hint =
            '本次改动包含引擎启动参数（backendParameters/env/镜像/PD 等），只更新了规格记录；需要让用户确认后用 restart=true（或 gpustack_model_action restart）整组重建，否则进程仍跑旧参数。'
        } else if (restarted && !waitedFlag) {
          hint = '重启已触发（非幂等、整组重建）；用 gpustack_wait_model 等 state=running，重启未收敛前再次 restart 会返回 409。'
        } else if (args.wait === true && waitTimedOut) {
          hint = `等待超时：state=${state ?? '未知'}；用 gpustack_logs 看实例日志，或继续 gpustack_wait_model。`
        }

        return {
          ok: true,
          modelId: args.modelId,
          name: typeof model.name === 'string' ? model.name : '',
          changed,
          restarted,
          restartMessage,
          state,
          readyReplicas,
          replicas,
          waited: waitedFlag,
          waitTimedOut,
          waitState,
          elapsedMs: Date.now() - startedAt,
          model: updated.json !== null && typeof updated.json === 'object' ? modelRow(updated.json) : null,
          hint,
        }
      },
    }),
  )
}
