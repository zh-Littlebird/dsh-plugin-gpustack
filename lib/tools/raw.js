/** `gpustack_request`: escape hatch for endpoints not covered by typed tools. */

import { defineTool } from '../tool.js'
import { S } from '../schema.js'
import { GpuStackError } from '../errors.js'
import { normalizePath } from '../http.js'
import { requireScope } from '../permissions.js'
import { redactValue } from '../redact.js'
import { errorInfo, renderJson, truncateText } from './common.js'
import { ERROR_SCHEMA, NULLABLE_INTEGER, NULLABLE_STRING } from './schemas.js'

const OUTPUT_SCHEMA = S.object(
  {
    ok: S.boolean({ required: true }),
    status: NULLABLE_INTEGER,
    api: S.string({ required: true }),
    method: S.string({ required: true }),
    path: S.string({ required: true }),
    data: S.any(),
    text: NULLABLE_STRING,
    message: NULLABLE_STRING,
    truncated: S.boolean({ required: true }),
    durationMs: S.integer({ required: true }),
    requestId: NULLABLE_STRING,
    error: S.oneOf([ERROR_SCHEMA, S.null()]),
  },
  { additionalProperties: false },
)

function render(value) {
  const lines = [`${value.method} ${value.path} -> HTTP ${value.status ?? '无'}  ${value.ok ? '成功' : '失败'}`]
  if (value.message !== null) lines.push(`消息：${value.message}`)
  if (value.data !== null && value.data !== undefined) {
    lines.push('数据：', renderJson(value.data, 12_000))
  }
  if (value.text !== null) {
    lines.push('响应文本：', truncateText(value.text, 12_000))
  }
  if (value.truncated) lines.push('注意：响应超过 maxBytes，内容已截断，不能当成完整响应。')
  if (value.error !== null) {
    lines.push(`错误：[${value.error.code}] ${value.error.message}${value.error.hint ? `；${value.error.hint}` : ''}`)
  }
  lines.push(`耗时：${value.durationMs} ms`)
  return [{ type: 'text', text: lines.join('\n') }]
}

/** Register the raw-call tool. */
export function registerRequestTool(ctx, deps) {
  ctx.tools.register(
    defineTool({
      name: 'gpustack_request',
      description:
        '调用任意 GPUStack 端点，用于 typed 工具未覆盖的接口（API Key、用户、模型文件、缓存服务、压测、诊断、路由、供应商等）。' +
        'api=auto 按路径判断：/v2/* 走管理接口，/v1、/v1-openai、/v2/benchmark-proxy 走推理接口，/healthz、/version、/auth 为公开接口。' +
        '写操作（POST/PUT/PATCH/DELETE）必须在管理接口上显式 confirm=true，且受 allowWrites 配置限制；调用前先向用户确认目标与影响。' +
        'path 只写路径，查询参数放 query，JSON 请求体放 body；实例日志等 text/plain 响应会放进 text。密钥会脱敏，HTTP 失败以 ok=false 返回而不是抛异常。',
      parameters: S.object(
        {
          api: S.string({
            description: 'auto（默认）/ management / inference / public。',
            enum: ['auto', 'management', 'inference', 'public'],
          }),
          method: S.string({
            description: 'HTTP 方法，默认 GET。',
            enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
          }),
          path: S.string({ required: true, description: '集群内绝对路径，如 /v2/api-keys 或 /v2/models/12/revisions。' }),
          query: S.any({ description: '查询参数对象，如 {"page":1,"perPage":20}。' }),
          body: S.any({ description: 'JSON 请求体（对象或数组）；GET 通常不需要。' }),
          confirm: S.boolean({ description: '管理接口写操作必须为 true；推理 POST 不需要。' }),
          maxBytes: S.integer({ description: '本次响应读取上限（字节），不能超过插件配置 maxResponseBytes。' }),
          timeoutMs: S.integer({ description: '请求超时（毫秒），默认 60000。' }),
        },
        { additionalProperties: false },
      ),
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => render(value),
      },
      async execute(args, exec) {
        const { settings, transport } = await deps.context()
        const normalized = normalizePath(args.api ?? 'auto', args.path)
        const method = String(args.method ?? 'GET').toUpperCase()
        const writing = method !== 'GET'

        if (writing && normalized.api === 'management') {
          requireScope(settings, method === 'DELETE' ? 'delete' : 'raw')
        }
        if (writing && normalized.api !== 'inference' && args.confirm !== true) {
          throw new GpuStackError('CONFIRM_REQUIRED', `${method} ${normalized.path} 需要人工确认`, {
            hint: '先向用户说明目标与影响，确认后传 confirm=true 重试。推理 POST 不需要 confirm。',
          })
        }
        if (args.body !== undefined && args.body !== null && typeof args.body !== 'object') {
          throw new GpuStackError('INVALID_ARGS', 'body 必须是 JSON 对象或数组', {
            hint: '例如 {"name":"demo"}；multipart 文件上传不在本工具范围内。',
          })
        }

        const maxBytes =
          typeof args.maxBytes === 'number' && args.maxBytes > 0
            ? Math.min(settings.config.maxResponseBytes, Math.max(1_024, Math.floor(args.maxBytes)))
            : undefined
        const started = Date.now()
        try {
          const response = await transport.request({
            api: normalized.api,
            method,
            path: normalized.path,
            query: args.query,
            body: args.body,
            allowText: true,
            allowTruncated: true,
            includeText: true,
            maxBytes,
            signal: exec.signal,
            timeoutMs: args.timeoutMs,
          })
          const json = response.json
          const ok = !response.truncated && response.status >= 200 && response.status < 300
          const value = {
            ok,
            status: response.status,
            api: normalized.api,
            method,
            path: normalized.path,
            data: redactValue(json),
            text: json === null ? truncateText(response.text ?? '', 20_000) : null,
            message:
              json !== null && typeof json === 'object' && !Array.isArray(json) && typeof json.message === 'string'
                ? json.message
                : null,
            truncated: response.truncated,
            durationMs: response.durationMs,
            requestId: response.requestId,
            error: null,
          }
          deps.record('gpustack_request', {
            api: normalized.api,
            method,
            path: normalized.path,
            status: response.status,
            ok,
            durationMs: response.durationMs,
          })
          return value
        } catch (error) {
          const info = errorInfo(error)
          const value = {
            ok: false,
            status: info.status,
            api: normalized.api,
            method,
            path: normalized.path,
            data: null,
            text: null,
            message: info.message,
            truncated: false,
            durationMs: Date.now() - started,
            requestId: null,
            error: info,
          }
          deps.record('gpustack_request', {
            api: normalized.api,
            method,
            path: normalized.path,
            status: info.status,
            ok: false,
            errorCode: info.code,
            durationMs: value.durationMs,
          })
          return value
        }
      },
    }),
  )
}
