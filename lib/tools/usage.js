/** `gpustack_usage`: token usage summary and breakdown. */

import { defineTool } from '../tool.js'
import { S } from '../schema.js'
import { GpuStackError } from '../errors.js'
import { asNumber, renderJson, shiftDate, truncateText, utcDateString } from './common.js'
import { NULLABLE_STRING, PAGINATION_SCHEMA } from './schemas.js'

const SUMMARY_SCHEMA = S.object(
  {
    inputTokens: S.oneOf([S.integer(), S.null()]),
    outputTokens: S.oneOf([S.integer(), S.null()]),
    cachedTokens: S.oneOf([S.integer(), S.null()]),
    totalTokens: S.oneOf([S.integer(), S.null()]),
    apiRequests: S.oneOf([S.integer(), S.null()]),
    modelsCalled: S.oneOf([S.integer(), S.null()]),
    activeUsers: S.oneOf([S.integer(), S.null()]),
  },
  { additionalProperties: false },
)

const META_SCHEMA = S.object(
  {
    groupBys: S.array(S.string(), { required: true }),
    granularities: S.array(S.string(), { required: true }),
    metrics: S.array(S.string(), { required: true }),
  },
  { additionalProperties: false },
)

const BREAKDOWN_SCHEMA = S.object(
  {
    groupBy: S.array(S.string(), { required: true }),
    granularity: NULLABLE_STRING,
    rows: S.array(S.any(), { required: true }),
    pagination: S.oneOf([PAGINATION_SCHEMA, S.null()]),
  },
  { additionalProperties: false },
)

const OUTPUT_SCHEMA = S.object(
  {
    startDate: S.string({ required: true }),
    endDate: S.string({ required: true }),
    summary: SUMMARY_SCHEMA,
    meta: S.oneOf([META_SCHEMA, S.null()]),
    breakdown: S.oneOf([BREAKDOWN_SCHEMA, S.null()]),
    hint: NULLABLE_STRING,
  },
  { additionalProperties: false },
)

function intOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null
}

function summaryOf(value) {
  const body = value !== null && typeof value === 'object' ? value : {}
  return {
    inputTokens: intOrNull(body.input_tokens),
    outputTokens: intOrNull(body.output_tokens),
    cachedTokens: intOrNull(body.input_cached_tokens),
    totalTokens: intOrNull(body.total_tokens),
    apiRequests: intOrNull(body.api_requests),
    modelsCalled: intOrNull(body.models_called),
    activeUsers: intOrNull(body.token_active_users) ?? intOrNull(body.active_users),
  }
}

/** `/v2/usage/meta` returns `{key,label}` objects; accept plain strings too. */
function dimensionKeys(value) {
  if (!Array.isArray(value)) return []
  const keys = []
  for (const entry of value) {
    if (typeof entry === 'string') {
      keys.push(entry)
    } else if (entry !== null && typeof entry === 'object') {
      const key = typeof entry.key === 'string' ? entry.key : typeof entry.name === 'string' ? entry.name : null
      if (key !== null) keys.push(key)
    }
  }
  return keys
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Descriptor objects carry `label`, or `identity.value` for filter entries. */
function objectLabel(value) {
  if (!isPlainObject(value)) return null
  if (typeof value.label === 'string' && value.label.length > 0) return value.label
  const identity = isPlainObject(value.identity) ? value.identity.value : null
  if (isPlainObject(identity)) {
    const parts = Object.values(identity).filter((entry) => typeof entry === 'string' || typeof entry === 'number')
    if (parts.length > 0) return parts.join(' / ')
  }
  if (typeof value.name === 'string') return value.name
  return null
}

function renderRow(row) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return String(row)
  const parts = []
  for (const [key, value] of Object.entries(row)) {
    if (value === null || value === undefined) continue
    if (isPlainObject(value)) {
      const label = objectLabel(value)
      if (label !== null) parts.push(`${key}=${label}`)
      continue
    }
    if (Array.isArray(value)) continue
    parts.push(`${key}=${value}`)
  }
  return parts.join(' ')
}

function render(value) {
  const lines = [
    `用量统计 ${value.startDate} → ${value.endDate}`,
    `  输入 token: ${value.summary.inputTokens ?? '?'}  输出: ${value.summary.outputTokens ?? '?'}  缓存命中: ${value.summary.cachedTokens ?? '?'}  合计: ${value.summary.totalTokens ?? '?'}`,
    `  请求数: ${value.summary.apiRequests ?? '?'}  涉及模型: ${value.summary.modelsCalled ?? '?'}  活跃用户: ${value.summary.activeUsers ?? '?'}`,
  ]
  if (value.summary.cachedTokens === null || value.summary.apiRequests === null) {
    lines.push('  （汇总接口只给 token 总量；缓存命中/请求数需要带 groupBy 查明细）')
  }
  if (value.meta !== null) {
    lines.push('')
    lines.push(`可用维度: group_by=${value.meta.groupBys.join('|') || '（未返回）'}`)
    lines.push(`           granularity=${value.meta.granularities.join('|') || '（未返回）'}`)
    lines.push(`           metrics=${value.meta.metrics.join('|') || '（未返回）'}`)
  }
  if (value.breakdown !== null) {
    lines.push('')
    lines.push(`明细（group_by=${value.breakdown.groupBy.join(',')}${value.breakdown.granularity !== null ? `, granularity=${value.breakdown.granularity}` : ''}）：`)
    if (value.breakdown.rows.length === 0) lines.push('  （没有数据）')
    for (const row of value.breakdown.rows.slice(0, 50)) lines.push(`  - ${renderRow(row)}`)
    if (value.breakdown.rows.length > 50) lines.push(`  ... 还有 ${value.breakdown.rows.length - 50} 行未显示`)
    if (value.breakdown.pagination !== null && value.breakdown.pagination.total !== null) {
      lines.push(`  合计 ${value.breakdown.pagination.total} 行，第 ${value.breakdown.pagination.page ?? '?'} 页`)
    }
  }
  if (value.hint !== null) lines.push('', value.hint)
  return [{ type: 'text', text: lines.join('\n') }]
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** Register the usage tool. */
export function registerUsageTool(ctx, deps) {
  ctx.tools.register(
    defineTool({
      name: 'gpustack_usage',
      description:
        '查询 GPUStack 的 token 用量：默认返回时间窗内的总量（输入/输出/总 token、活跃用户），给 groupBy 时再查明细。' +
        'groupBy 合法值来自 /v2/usage/meta 的 group_bys（常见 date、user、api_key、route、organization；注意没有 model 维度，模型数是明细里的 models_called 指标）。' +
        '汇总接口不含缓存命中与请求数，这两个值在带 groupBy 的明细 summary 里补齐。' +
        '日期是 YYYY-MM-DD，按 UTC 解释；用于容量复盘与计费核对，不产生推理费用。',
      parameters: S.object(
        {
          startDate: S.string({ description: '起始日期 YYYY-MM-DD；默认 endDate 前 6 天。' }),
          endDate: S.string({ description: '结束日期 YYYY-MM-DD；默认今天（UTC）。' }),
          groupBy: S.array(S.string(), {
            description: '明细分组维度，如 ["route"]、["date","route"]；不传则只返回汇总。',
          }),
          granularity: S.string({ description: '明细时间粒度；取值以 meta.granularities 为准。' }),
          scope: S.string({ description: '统计范围，默认服务端 all。' }),
          page: S.integer({ description: '明细页码，默认 1。' }),
          perPage: S.integer({ description: '明细每页条数，默认 20，最大 100。' }),
          includeMeta: S.boolean({ description: '是否返回维度字典（默认 true）。' }),
        },
        { additionalProperties: false },
      ),
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => render(value),
      },
      async execute(args, exec) {
        const endDate = args.endDate !== undefined ? args.endDate.trim() : utcDateString()
        if (!DATE_PATTERN.test(endDate)) {
          throw new GpuStackError('INVALID_ARGS', `endDate 必须是 YYYY-MM-DD：${endDate}`)
        }
        const startDate = args.startDate !== undefined ? args.startDate.trim() : shiftDate(endDate, -6)
        if (!DATE_PATTERN.test(startDate)) {
          throw new GpuStackError('INVALID_ARGS', `startDate 必须是 YYYY-MM-DD：${startDate}`)
        }
        if (startDate > endDate) {
          throw new GpuStackError('INVALID_ARGS', `startDate(${startDate}) 不能晚于 endDate(${endDate})`)
        }

        const { client } = await deps.context()
        const summaryResult = await client.get(
          '/v2/usage/summary',
          { start_date: startDate, end_date: endDate, scope: args.scope },
          { signal: exec.signal },
        )
        const summary = summaryOf(summaryResult.body)

        let meta = null
        if (args.includeMeta !== false) {
          try {
            const metaResult = await client.get('/v2/usage/meta', {}, { signal: exec.signal })
            const body = metaResult.body ?? {}
            meta = {
              groupBys: dimensionKeys(body.group_bys ?? body.groupBys),
              granularities: dimensionKeys(body.granularities),
              metrics: dimensionKeys(body.metrics),
            }
          } catch (error) {
            if (error?.name === 'AbortError') throw error
            // The dictionary is advisory; a failure must not hide the summary.
            meta = null
          }
        }

        let breakdown = null
        let hint = null
        if (args.groupBy !== undefined && args.groupBy.length > 0) {
          const groupBy = args.groupBy.map((entry) => String(entry).trim()).filter((entry) => entry.length > 0)
          if (groupBy.length === 0) {
            throw new GpuStackError('INVALID_ARGS', 'groupBy 不能为空数组')
          }
          if (meta !== null && meta.groupBys.length > 0) {
            const allowed = new Set(meta.groupBys.map((entry) => entry.toLowerCase()))
            const unknown = groupBy.filter((entry) => !allowed.has(entry.toLowerCase()))
            if (unknown.length > 0) {
              throw new GpuStackError('INVALID_ARGS', `不支持的 groupBy：${unknown.join(', ')}`, {
                hint: `本实例可用维度：${meta.groupBys.join(', ')}。`,
              })
            }
          }
          const body = {
            start_date: startDate,
            end_date: endDate,
            group_by: groupBy,
          }
          if (args.granularity !== undefined) body.granularity = args.granularity
          if (args.scope !== undefined) body.scope = args.scope
          if (args.page !== undefined) body.page = Math.max(1, Math.floor(args.page))
          if (args.perPage !== undefined) body.perPage = Math.min(100, Math.max(1, Math.floor(args.perPage)))

          const result = await client.request({
            method: 'POST',
            path: '/v2/usage/breakdown',
            body,
            signal: exec.signal,
          })
          const payload = result.json ?? {}
          // The breakdown response carries the complete summary (cached tokens,
          // request count, models called); the summary endpoint omits them.
          const breakdownSummary = summaryOf(payload.summary)
          for (const key of Object.keys(summary)) {
            if (summary[key] === null && breakdownSummary[key] !== null) summary[key] = breakdownSummary[key]
          }
          breakdown = {
            groupBy,
            granularity: typeof payload.granularity === 'string' ? payload.granularity : (args.granularity ?? null),
            rows: Array.isArray(payload.items) ? payload.items : [],
            pagination:
              payload.pagination !== null && typeof payload.pagination === 'object'
                ? {
                    page: typeof payload.pagination.page === 'number' ? payload.pagination.page : null,
                    perPage: typeof payload.pagination.perPage === 'number' ? payload.pagination.perPage : null,
                    total: typeof payload.pagination.total === 'number' ? payload.pagination.total : null,
                    totalPage: typeof payload.pagination.totalPage === 'number' ? payload.pagination.totalPage : null,
                  }
                : null,
          }
        } else if (meta !== null && meta.groupBys.length > 0) {
          hint = `需要明细时传 groupBy（可用维度：${meta.groupBys.join(', ')}）。`
        }

        if (summary.totalTokens === null && summary.apiRequests === null) {
          hint = hint ?? '汇总为空：该时间窗内可能没有推理请求，或当前账号看不到这些数据。'
        }

        deps.record('gpustack_usage', {
          api: 'management',
          method: breakdown === null ? 'GET' : 'POST',
          path: breakdown === null ? '/v2/usage/summary' : '/v2/usage/breakdown',
          ok: true,
        })

        return { startDate, endDate, summary, meta, breakdown, hint }
      },
    }),
  )
}
