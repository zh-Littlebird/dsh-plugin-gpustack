/** `gpustack_model_action`: restart, rollback, preview rollback, or delete one model. */

import { defineTool } from '../tool.js'
import { S } from '../schema.js'
import { GpuStackError } from '../errors.js'
import { requireScope } from '../permissions.js'
import { waitForModel } from '../wait.js'
import { renderJson } from './common.js'
import { NULLABLE_INTEGER, NULLABLE_STRING } from './schemas.js'

const OUTPUT_SCHEMA = S.object(
  {
    ok: S.boolean({ required: true }),
    action: S.string({ required: true, enum: ['restart', 'rollback', 'preview-rollback', 'delete'] }),
    modelId: S.integer({ required: true }),
    modelName: NULLABLE_STRING,
    message: NULLABLE_STRING,
    restarted: S.oneOf([S.boolean(), S.null()]),
    deletedInstances: S.array(S.any(), { required: true }),
    revision: NULLABLE_INTEGER,
    state: NULLABLE_STRING,
    waited: S.boolean({ required: true }),
    waitState: NULLABLE_STRING,
    waitTimedOut: S.boolean({ required: true }),
    detail: S.any(),
    elapsedMs: S.integer({ required: true }),
    hint: NULLABLE_STRING,
  },
  { additionalProperties: false },
)

function render(value) {
  const lines = [`动作 ${value.action} 已执行：模型 #${value.modelId} ${value.modelName ?? ''}`.trimEnd()]
  if (value.message !== null) lines.push(`  消息: ${value.message}`)
  if (value.revision !== null) lines.push(`  目标修订: ${value.revision}`)
  if (value.state !== null) lines.push(`  当前状态: ${value.state}`)
  if (value.restarted === true) lines.push('  已触发重启（非幂等，整组重建）')
  if (value.deletedInstances.length > 0) lines.push(`  删除实例: ${value.deletedInstances.join(', ')}`)
  if (value.waited) {
    lines.push(`  等待结果: state=${value.waitState ?? '未知'}${value.waitTimedOut ? '（超时）' : ''}`)
  }
  if (value.action === 'preview-rollback' && value.detail !== null) {
    lines.push('  预览:', renderJson(value.detail, 6_000))
  }
  lines.push(`  耗时: ${value.elapsedMs} ms`)
  if (value.hint !== null) lines.push('', value.hint)
  return [{ type: 'text', text: lines.join('\n') }]
}

/** Register the model-action tool. */
export function registerActionsTool(ctx, deps) {
  ctx.tools.register(
    defineTool({
      name: 'gpustack_model_action',
      description:
        '对单个模型执行破坏性或重建类动作：restart（整组重建、非幂等，用于进程卡死但控制面仍显示 running）、' +
        'rollback（回退到指定 revision，需 revision）、preview-rollback（先看差异）、delete（删除模型及其实例，必须 confirm=true）。' +
        '调用前先用 id+name 回读目标并向用户确认影响；重启未收敛时再次 restart 会返回 409，应等待而不是重复提交。' +
        '删除不可恢复；回滚依据 gpustack_models 之外可用 GET /v2/models/{id}/revisions 查看历史。',
      parameters: S.object(
        {
          modelId: S.integer({ required: true, description: '目标模型 id。' }),
          action: S.string({
            required: true,
            description: 'restart / rollback / preview-rollback / delete。',
            enum: ['restart', 'rollback', 'preview-rollback', 'delete'],
          }),
          revision: S.integer({ description: 'rollback 与 preview-rollback 的目标修订号。' }),
          confirm: S.boolean({ description: 'delete 必须为 true；其余动作不需要。' }),
          wait: S.boolean({ description: 'restart/rollback 后是否等待到 running/error（默认 false）。' }),
          waitTimeoutSec: S.integer({ description: 'wait=true 的等待上限（秒），默认 300。' }),
        },
        { additionalProperties: false },
      ),
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => render(value),
      },
      async execute(args, exec) {
        const { settings, client } = await deps.context()
        requireScope(settings, args.action === 'delete' ? 'delete' : 'restart')

        const startedAt = Date.now()
        const current = await client.get(`/v2/models/${args.modelId}`, {}, { signal: exec.signal })
        const model = current.body
        const modelName = typeof model?.name === 'string' ? model.name : null

        const value = {
          ok: true,
          action: args.action,
          modelId: args.modelId,
          modelName,
          message: null,
          restarted: null,
          deletedInstances: [],
          revision: args.revision ?? null,
          state: typeof model?.state === 'string' ? model.state : null,
          waited: false,
          waitState: null,
          waitTimedOut: false,
          detail: null,
          elapsedMs: 0,
          hint: null,
        }

        if (args.action === 'delete') {
          if (args.confirm !== true) {
            throw new GpuStackError(
              'CONFIRM_REQUIRED',
              `删除模型 #${args.modelId} ${modelName ?? ''} 需要人工确认`.trim(),
              {
                hint: '删除会移除模型定义与其运行实例且不可恢复。先向用户确认目标与影响，再传 confirm=true 重试。',
              },
            )
          }
          const deleted = await client.request({
            method: 'DELETE',
            path: `/v2/models/${args.modelId}`,
            signal: exec.signal,
          })
          deps.record('gpustack_model_action', {
            api: 'management',
            method: 'DELETE',
            path: `/v2/models/${args.modelId}`,
            status: deleted.status,
            ok: true,
            durationMs: deleted.durationMs,
          })
          value.message = '模型已删除'
          value.hint = '如需重新部署，用 gpustack_deploy_model 重建；旧 id 不可复用。'
          value.elapsedMs = Date.now() - startedAt
          return value
        }

        if (args.action === 'preview-rollback' || args.action === 'rollback') {
          if (args.revision === undefined) {
            throw new GpuStackError('INVALID_ARGS', `${args.action} 需要 revision`, {
              hint: '先用 GET /v2/models/{id}/revisions（可通过 gpustack_request）查看可用修订号。',
            })
          }
          const path =
            args.action === 'rollback'
              ? `/v2/models/${args.modelId}/rollback`
              : `/v2/models/${args.modelId}/rollback-preview`
          const result = await client.request({
            method: 'POST',
            path,
            body: { target_revision: args.revision },
            signal: exec.signal,
          })
          deps.record('gpustack_model_action', {
            api: 'management',
            method: 'POST',
            path,
            status: result.status,
            ok: true,
            durationMs: result.durationMs,
          })
          value.detail = result.json ?? null
          if (args.action === 'preview-rollback') {
            value.message = '已生成回滚预览（未改变线上规格）'
            value.hint = '确认差异后再执行 rollback。'
          } else {
            value.message = '已回滚到指定修订'
            value.state = typeof result.json?.state === 'string' ? result.json.state : value.state
            value.hint = '回滚只切换规格代际，需要时再 restart 让进程落到新规格；请回读 state 与实例确认。'
          }
          value.elapsedMs = Date.now() - startedAt
          return value
        }

        // restart
        const restart = await client.request({
          method: 'POST',
          path: `/v2/models/${args.modelId}/restart`,
          signal: exec.signal,
        })
        deps.record('gpustack_model_action', {
          api: 'management',
          method: 'POST',
          path: `/v2/models/${args.modelId}/restart`,
          status: restart.status,
          ok: true,
          durationMs: restart.durationMs,
        })
        const body = restart.json ?? {}
        value.restarted = typeof body.restarted === 'boolean' ? body.restarted : true
        value.message = typeof body.message === 'string' ? body.message : '已触发重启'
        value.deletedInstances = Array.isArray(body.deleted_instances) ? body.deleted_instances : []

        if (args.wait === true) {
          const timeoutSec =
            typeof args.waitTimeoutSec === 'number' ? Math.min(3600, Math.max(5, args.waitTimeoutSec)) : 300
          const waited = await waitForModel(client, args.modelId, {
            signal: exec.signal,
            timeoutMs: timeoutSec * 1000,
            intervalMs: 5_000,
          })
          value.waited = true
          value.waitState = waited.state
          value.waitTimedOut = waited.timedOut
          value.state = waited.state
          value.hint = waited.timedOut
            ? `等待超时（${timeoutSec}s）：继续 gpustack_wait_model，或 gpustack_logs 看日志。`
            : waited.state === 'error'
              ? '重启后进入 error：用 gpustack_logs 看实例日志定位启动失败原因。'
              : null
        } else {
          value.hint = '重启是整组重建且非幂等：用 gpustack_wait_model 等 state=running；restarting_since 未清空前再次 restart 会 409。'
        }
        value.elapsedMs = Date.now() - startedAt
        return value
      },
    }),
  )
}
