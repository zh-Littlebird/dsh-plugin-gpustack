/** `gpustack_wait_model`: block until a model reaches running or error. */

import { defineTool } from '../tool.js'
import { S } from '../schema.js'
import { waitForModel } from '../wait.js'
import { asString } from './common.js'
import { instanceRow } from './rows.js'
import { INSTANCE_ROW_SCHEMA, NULLABLE_INTEGER, NULLABLE_STRING } from './schemas.js'

const OUTPUT_SCHEMA = S.object(
  {
    modelId: S.integer({ required: true }),
    name: NULLABLE_STRING,
    state: NULLABLE_STRING,
    readyReplicas: NULLABLE_INTEGER,
    replicas: NULLABLE_INTEGER,
    stateMessage: NULLABLE_STRING,
    attempts: S.integer({ required: true }),
    elapsedMs: S.integer({ required: true }),
    timedOut: S.boolean({ required: true }),
    instances: S.array(INSTANCE_ROW_SCHEMA, { required: true }),
    hint: NULLABLE_STRING,
  },
  { additionalProperties: false },
)

function render(value) {
  const lines = [
    `等待模型 #${value.modelId}${value.name !== null ? ` ${value.name}` : ''}：state=${value.state ?? '未知'} ready=${value.readyReplicas ?? '?'}/${value.replicas ?? '?'}`,
    `  轮询 ${value.attempts} 次，耗时 ${value.elapsedMs} ms${value.timedOut ? '（超时）' : ''}`,
  ]
  if (value.stateMessage !== null) lines.push(`  state_message: ${value.stateMessage}`)
  if (value.instances.length > 0) {
    lines.push('  实例：')
    for (const instance of value.instances) {
      lines.push(
        `    #${instance.id} state=${instance.state ?? '?'} worker=${instance.workerName ?? '?'} port=${instance.port ?? '?'} restart=${instance.restartCount ?? 0}` +
          `${instance.stateMessage !== null ? `  ${instance.stateMessage}` : ''}`,
      )
    }
  }
  if (value.hint !== null) lines.push('', value.hint)
  return [{ type: 'text', text: lines.join('\n') }]
}

/** Register the wait tool. */
export function registerWaitTool(ctx, deps) {
  ctx.tools.register(
    defineTool({
      name: 'gpustack_wait_model',
      description:
        '轮询等待模型进入终态：state=running（就绪）或 error（失败），返回就绪副本数与实例状态。' +
        '部署、改配、重启之后用它代替"立刻报告成功"；超时不会抛异常，而是 timedOut=true，可继续调用。' +
        '到 error 或长时间 pending 时，用 gpustack_logs 看实例日志与 state_message，不要盲目重启。',
      parameters: S.object(
        {
          modelId: S.integer({ required: true, description: '模型 id。' }),
          timeoutSec: S.integer({ description: '最长等待秒数，默认 300，范围 5-3600。' }),
          intervalSec: S.integer({ description: '轮询间隔秒数，默认 5，范围 1-60。' }),
        },
        { additionalProperties: false },
      ),
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => render(value),
      },
      async execute(args, exec) {
        const { client } = await deps.context()
        const timeoutSec = typeof args.timeoutSec === 'number' ? Math.min(3600, Math.max(5, args.timeoutSec)) : 300
        const intervalSec = typeof args.intervalSec === 'number' ? Math.min(60, Math.max(1, args.intervalSec)) : 5
        const result = await waitForModel(client, args.modelId, {
          signal: exec.signal,
          timeoutMs: timeoutSec * 1000,
          intervalMs: intervalSec * 1000,
        })

        let hint = null
        if (result.timedOut) {
          hint = `等待超时（${timeoutSec}s）仍未到 running/error：模型仍可能在调度或拉镜像；继续等待或看 gpustack_logs。`
        } else if (result.state === 'error') {
          hint = '模型进入 error：用 gpustack_logs 拉实例日志，再按 state_message 修正镜像、模型路径或引擎参数；修复后再 restart。'
        } else if (result.state === 'running' && result.readyReplicas !== null && result.replicas !== null) {
          if (result.readyReplicas < result.replicas) {
            hint = `state=running 但就绪副本不足（${result.readyReplicas}/${result.replicas}）：注意仍可能有实例未就绪。`
          }
        }

        deps.record('gpustack_wait_model', {
          api: 'management',
          method: 'GET',
          path: `/v2/models/${args.modelId}`,
          ok: result.state === 'running',
          durationMs: result.elapsedMs,
        })

        return {
          modelId: args.modelId,
          name: asString(result.model?.name),
          state: result.state,
          readyReplicas: result.readyReplicas,
          replicas: result.replicas,
          stateMessage: result.stateMessage,
          attempts: result.attempts,
          elapsedMs: result.elapsedMs,
          timedOut: result.timedOut,
          instances: result.instances.map(instanceRow),
          hint,
        }
      },
    }),
  )
}
