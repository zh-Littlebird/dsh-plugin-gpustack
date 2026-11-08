/** `gpustack_logs`: fetch serving logs for a model instance. */

import { defineTool } from '../tool.js'
import { S } from '../schema.js'
import { GpuStackError } from '../errors.js'
import { asInteger, asString, clampInteger, truncateText } from './common.js'
import { instanceRow } from './rows.js'
import { INSTANCE_ROW_SCHEMA, NULLABLE_INTEGER, NULLABLE_STRING } from './schemas.js'

const CANDIDATE_SCHEMA = S.object(
  {
    id: S.integer({ required: true }),
    name: NULLABLE_STRING,
    state: NULLABLE_STRING,
  },
  { additionalProperties: false },
)

const OUTPUT_SCHEMA = S.object(
  {
    instanceId: S.integer({ required: true }),
    modelId: NULLABLE_INTEGER,
    modelName: NULLABLE_STRING,
    instance: S.oneOf([INSTANCE_ROW_SCHEMA, S.null()]),
    previous: S.boolean({ required: true }),
    text: S.string({ required: true }),
    lines: S.integer({ required: true }),
    chars: S.integer({ required: true }),
    truncated: S.boolean({ required: true }),
    candidates: S.array(CANDIDATE_SCHEMA, { required: true }),
    hint: NULLABLE_STRING,
  },
  { additionalProperties: false },
)

function render(value) {
  const header = [
    `实例 #${value.instanceId}${value.instance ? ` ${value.instance.name ?? ''}` : ''} 日志` +
      `${value.previous ? '（上一次重启前）' : ''}`,
    `  模型: ${value.modelName ?? '?'}#${value.modelId ?? '?'}  state=${value.instance?.state ?? '?'} worker=${value.instance?.workerName ?? '?'} port=${value.instance?.port ?? '?'}`,
    `  行数: ${value.lines}  字符: ${value.chars}${value.truncated ? '（已按 maxChars 截断）' : ''}`,
  ]
  const body = value.text.length > 0 ? value.text : '（日志为空：实例可能刚启动，或 previous=true 时还没有上一轮日志）'
  const lines = [...header, '', body]
  if (value.candidates.length > 1) {
    lines.push('', `同一模型还有其它实例：${value.candidates.map((entry) => `#${entry.id}(${entry.state ?? '?'})`).join(' ')}`)
  }
  if (value.hint !== null) lines.push('', value.hint)
  return [{ type: 'text', text: lines.join('\n') }]
}

/** Resolve one instance for a model: running first, otherwise the first one. */
async function resolveInstance(client, args, signal) {
  if (args.instanceId !== undefined) {
    const detail = await client.get(`/v2/model-instances/${args.instanceId}`, {}, { signal })
    return { instance: detail.body, candidates: [] }
  }
  const listed = await client.list(`/v2/models/${args.modelId}/instances`, { perPage: 100 }, { signal })
  const candidates = listed.items
  if (candidates.length === 0) {
    throw new GpuStackError('NO_INSTANCE', `模型 ${args.modelId} 当前没有实例`, {
      hint: '该模型可能 replicas=0 或尚未调度出实例；先 gpustack_models modelId 查看状态与 state_message。',
    })
  }
  const running = candidates.find((entry) => entry.state === 'running')
  return { instance: running ?? candidates[0], candidates }
}

/** Register the logs tool. */
export function registerLogsTool(ctx, deps) {
  ctx.tools.register(
    defineTool({
      name: 'gpustack_logs',
      description:
        '拉取模型实例的服务日志（GET /v2/model-instances/{id}/logs，返回 text/plain）。' +
        '给 instanceId 直接取该实例；只给 modelId 时自动选 running 实例并列出其它候选。' +
        'tail 取末尾 N 行（默认 200）；previous=true 看上一次重启前的日志（重启后排查启动失败常用）；' +
        'offset+limit 分段读取，与 tail 互斥。多 worker 分布式实例可用 workerId 指定。' +
        '日志可能含 token 与内网地址，转述给用户时要截断并脱敏。',
      parameters: S.object(
        {
          instanceId: S.integer({ description: '模型实例 id（优先使用）。' }),
          modelId: S.integer({ description: '模型 id：未给 instanceId 时用它自动定位实例。' }),
          tail: S.integer({ description: '末尾行数，默认 200；-1 表示全部（可能很大）。' }),
          previous: S.boolean({ description: '是否取上一次重启前的日志。' }),
          workerId: S.integer({ description: '多 worker 分布式实例时指定 worker。' }),
          containerName: S.string({ description: '指定容器名。' }),
          offset: S.integer({ description: '分段读取的起始行（与 limit 搭配，不能和 tail 同用）。' }),
          limit: S.integer({ description: '分段读取的行数（与 offset 搭配）。' }),
          maxChars: S.integer({ description: '返回给模型的最大字符数，默认 20000，最大 60000。' }),
        },
        { additionalProperties: false },
      ),
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => render(value),
      },
      async execute(args, exec) {
        if (args.instanceId === undefined && args.modelId === undefined) {
          throw new GpuStackError('INVALID_ARGS', '需要 instanceId 或 modelId', {
            hint: '先用 gpustack_models 拿模型 id，再拉日志。',
          })
        }
        const { client } = await deps.context()
        const { instance, candidates } = await resolveInstance(client, args, exec.signal)
        if (instance === null || typeof instance !== 'object' || Array.isArray(instance)) {
          throw new GpuStackError('UNEXPECTED_RESPONSE', '实例详情不是对象', { hint: '确认 instanceId 是否存在。' })
        }
        const instanceId = asInteger(instance.id) ?? args.instanceId ?? args.modelId

        const query = {}
        const segment = args.offset !== undefined || args.limit !== undefined
        if (segment) {
          if (args.offset !== undefined) query.offset = Math.max(0, Math.floor(args.offset))
          if (args.limit !== undefined) query.limit = clampInteger(args.limit, 1000, 1, 10_000)
        } else {
          query.tail = args.tail === undefined ? 200 : clampInteger(args.tail, 200, -1, 20_000)
        }
        if (args.previous !== undefined) query.previous = args.previous
        if (args.workerId !== undefined) query.worker_id = args.workerId
        if (args.containerName !== undefined) query.container_name = args.containerName

        const result = await client.text(`/v2/model-instances/${instanceId}/logs`, query, { signal: exec.signal })
        const raw = typeof result.text === 'string' ? result.text : ''
        const maxChars = clampInteger(args.maxChars, 20_000, 1_000, 60_000)
        const text = truncateText(raw, maxChars)

        deps.record('gpustack_logs', {
          api: 'management',
          method: 'GET',
          path: `/v2/model-instances/${instanceId}/logs`,
          status: result.status,
          ok: result.ok,
          durationMs: result.durationMs,
        })

        let hint = null
        if (raw.length === 0) {
          hint = args.previous === true ? '没有上一轮日志：该实例可能尚未重启过，或已清理。' : '日志为空：实例刚启动时可能还没有输出，可稍后重试。'
        } else if (text.length < raw.length) {
          hint = `原始日志 ${raw.length} 字符，已截断到 ${maxChars}；需要更多请缩小 tail 或分段 offset/limit。`
        }

        return {
          instanceId,
          modelId: asInteger(instance.model_id) ?? args.modelId ?? null,
          modelName: asString(instance.model_name),
          instance: instanceRow(instance),
          previous: args.previous === true,
          text,
          lines: raw.length === 0 ? 0 : raw.replace(/\r?\n$/, '').split('\n').length,
          chars: raw.length,
          truncated: text.length < raw.length,
          candidates: candidates.slice(0, 20).map((entry) => ({
            id: asInteger(entry.id) ?? 0,
            name: asString(entry.name),
            state: asString(entry.state),
          })),
          hint,
        }
      },
    }),
  )
}
