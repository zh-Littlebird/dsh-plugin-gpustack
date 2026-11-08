/**
 * HTTP transport for GPUStack v2.
 *
 * - Management calls (`/v2/*`) and inference calls (`/v1/*`) both authenticate
 *   with `X-API-Key`; the key never appears in a URL, log line, or tool output.
 * - Redirects are refused so a compromised gateway cannot bounce the key to
 *   another origin.
 * - Response bodies are capped before parsing; oversized JSON fails loudly
 *   instead of being silently truncated into an invalid document.
 * - `text/plain` responses (model instance logs) are returned verbatim.
 */

import { GpuStackError } from './errors.js'
import { requireApiKey, requireBaseUrl } from './config.js'
import { redactText } from './redact.js'

const PUBLIC_PATHS = new Set(['/healthz', '/readyz', '/version', '/openapi.json', '/docs', '/auth/config'])

function matchesPrefix(path, prefix) {
  return path === prefix || path.startsWith(`${prefix}/`)
}

/** Decide whether a path belongs to the management, inference, or public surface. */
export function detectApi(path) {
  if (path !== '/' && matchesPrefix(path, '/v2/benchmark-proxy')) return 'inference'
  if (PUBLIC_PATHS.has(path) || matchesPrefix(path, '/docs') || matchesPrefix(path, '/auth')) return 'public'
  if (matchesPrefix(path, '/v2')) return 'management'
  if (matchesPrefix(path, '/v1') || matchesPrefix(path, '/v1-openai')) return 'inference'
  return null
}

/** Validate a path and add the family prefix when the caller omitted it. */
export function normalizePath(api, input) {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new GpuStackError('INVALID_PATH', 'path 不能为空', { hint: '例如 /v2/models 或 /v1/models。' })
  }
  let path = input.trim()
  if (path.includes('?') || path.includes('#')) {
    throw new GpuStackError('INVALID_PATH', 'path 不能包含查询参数或锚点', {
      hint: '请把查询参数放进 query 字段，例如 {"path":"/v2/models","query":{"page":1}}。',
    })
  }
  if (path.includes('\\') || path.includes('..') || path.startsWith('//') || /[\u0000-\u001f]/.test(path)) {
    throw new GpuStackError('INVALID_PATH', `path 含不允许的字符：${path}`, {
      hint: '只填写集群内的绝对路径，例如 /v2/models。',
    })
  }
  if (!path.startsWith('/')) path = `/${path}`
  let family = api
  if (family === 'auto' || family === undefined) {
    family = detectApi(path)
    if (family === null) {
      throw new GpuStackError('INVALID_PATH', `无法判断 path 属于管理接口还是推理接口：${path}`, {
        hint: '请显式传 api="management" 或 api="inference"；管理接口以 /v2 开头，推理接口以 /v1 开头。',
      })
    }
    return { api: family, path }
  }
  if (family === 'management' || family === 'admin') {
    if (!matchesPrefix(path, '/v2') && !matchesPrefix(path, '/v1')) path = `/v2${path}`
    return { api: 'management', path }
  }
  if (family === 'inference' || family === 'ai') {
    if (!matchesPrefix(path, '/v1') && !matchesPrefix(path, '/v1-openai') && !matchesPrefix(path, '/v2/benchmark-proxy')) {
      path = `/v1${path}`
    }
    return { api: 'inference', path }
  }
  if (family === 'public') return { api: 'public', path }
  throw new GpuStackError('INVALID_PATH', `未知的 api 类型：${String(api)}`, {
    hint: '可选 auto、management、inference、public。',
  })
}

/** Serialize a query object; arrays repeat the parameter (FastAPI convention). */
export function buildQuery(query) {
  const params = new URLSearchParams()
  if (query === undefined || query === null) return params
  if (typeof query !== 'object' || Array.isArray(query)) {
    throw new GpuStackError('INVALID_QUERY', 'query 必须是对象', { hint: '例如 {"page":1,"perPage":100}。' })
  }
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (entry !== undefined && entry !== null && entry !== '') params.append(key, String(entry))
      }
    } else if (typeof value === 'boolean') {
      params.set(key, value ? 'true' : 'false')
    } else {
      params.set(key, String(value))
    }
  }
  return params
}

/** Combine a base URL, path, and query into a validated URL. */
export function buildUrl(baseUrl, path, query) {
  let base
  try {
    base = new URL(baseUrl)
  } catch {
    throw new GpuStackError('CONFIG_INVALID', `baseUrl 不是合法的 URL：${baseUrl}`, {
      hint: '请运行 scripts/dsh-gpustack.mjs setup 重新配置。',
    })
  }
  let url
  try {
    url = new URL(`${base.toString().replace(/\/$/, '')}${path}`)
  } catch {
    throw new GpuStackError('INVALID_PATH', `无法拼接请求地址：${path}`, { hint: '请检查 path 是否合法。' })
  }
  if (url.origin !== base.origin) {
    throw new GpuStackError('INVALID_PATH', 'path 不能指向其他站点', {
      hint: '只允许访问配置的集群同源地址。',
    })
  }
  const params = buildQuery(query)
  const queryText = params.toString()
  if (queryText.length > 0) url.search = queryText
  return url
}

function authHeaders(api, settings) {
  const common = {
    accept: 'application/json',
    'user-agent': 'dsh-plugin-gpustack/1.0.0 (+https://github.com/deepseek-ai/deepseek-harness)',
  }
  if (api === 'public') {
    const organizationId = typeof settings.organizationId === 'string' ? settings.organizationId : ''
    return organizationId.length > 0 ? { ...common, 'x-organization-id': organizationId } : common
  }
  const key = requireApiKey(settings)
  const headers = { ...common, 'x-api-key': key }
  const organizationId = typeof settings.organizationId === 'string' ? settings.organizationId : ''
  if (organizationId.length > 0) headers['x-organization-id'] = organizationId
  return headers
}

function networkCode(error) {
  const code = error?.cause?.code ?? error?.code
  return typeof code === 'string' ? code : null
}

function networkHint(code) {
  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return '域名解析失败：请检查 baseUrl 的域名与当前网络/DNS。'
    case 'ECONNREFUSED':
      return '连接被拒绝：请确认 GPUStack 地址和端口正确，服务已启动。'
    case 'ECONNRESET':
      return '连接被重置：服务端或中间代理中断了连接，可稍后重试。'
    case 'ETIMEDOUT':
      return 'TCP 连接超时：请检查网络、防火墙或代理。'
    case 'CERT_HAS_EXPIRED':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return 'TLS 证书校验失败：请使用受信任的 HTTPS 证书，不要关闭校验。'
    default:
      return '请检查 baseUrl、网络连通性和代理设置。'
  }
}

/** Read a response body with a hard byte cap. */
export async function readLimited(response, maxBytes) {
  const limit = typeof maxBytes === 'number' && maxBytes > 0 ? maxBytes : 8 * 1024 * 1024
  const reader = response.body?.getReader()
  if (reader === undefined) {
    const text = await response.text()
    const bytes = Buffer.byteLength(text, 'utf8')
    return {
      text: bytes > limit ? text.slice(0, limit) : text,
      bytes,
      truncated: bytes > limit,
    }
  }
  const chunks = []
  let bytes = 0
  let truncated = false
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value === undefined) continue
    bytes += value.byteLength
    if (bytes > limit) {
      const previous = bytes - value.byteLength
      const keep = Math.max(0, limit - previous)
      if (keep > 0) chunks.push(value.subarray(0, keep))
      truncated = true
      await reader.cancel().catch(() => undefined)
      break
    }
    chunks.push(value)
  }
  return {
    text: Buffer.concat(chunks).toString('utf8'),
    bytes,
    truncated,
  }
}

function payloadMessage(json, text) {
  if (json !== null && typeof json === 'object' && !Array.isArray(json)) {
    const candidates = [json.message, json.reason, json.error?.message, json.detail, json.error]
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim()
    }
  }
  const trimmed = typeof text === 'string' ? text.trim() : ''
  if (trimmed.length > 0) return trimmed.slice(0, 500)
  return '服务端没有返回错误详情'
}

function statusHint(api, status) {
  if (status === 401) {
    return 'API Key 缺失或无效：请由用户在本机运行 scripts/dsh-gpustack.mjs set --api-key 重新录入，或设置环境变量 GPUSTACK_API_KEY。'
  }
  if (status === 403) {
    return '权限不足：该 Key 的 scope 可能只有 inference（不能调 /v2 管理接口）或 allowed_model_names 不含该模型；管理操作请换 management scope 的 Key。'
  }
  if (status === 404) {
    return api === 'inference'
      ? '模型或端点不存在：/v1 的 model 必须是路由名（effective_name）或模型名，不能用实例名。先查 gpustack_models 与 /v1/models。'
      : '资源不存在或不属于当前组织：先重新列出资源拿真实 id，不要复用旧 id。'
  }
  if (status === 409) {
    return '状态冲突（重名、重启进行中、实例替换中）：读取 message 后等待当前操作收敛，不要立即重复提交。'
  }
  if (status === 422) {
    return '请求参数校验失败：按 message/details 修正字段名、类型与必填项；body 字段必须来自对应 openapi 模型（如 ModelCreate/ModelUpdate），query 参数名要与端点声明一致，不要猜测。'
  }
  if (status === 429) {
    return '触发限流：降低并发或稍后重试。'
  }
  if (status >= 500) {
    return '服务端或上游依赖异常：检查 /healthz、/readyz 与服务端日志。'
  }
  return '请结合服务端日志排查。'
}

function httpError(api, status, json, text) {
  const message = payloadMessage(json, text)
  const details = json !== null && typeof json === 'object' && !Array.isArray(json) ? json.details ?? null : null
  return new GpuStackError(`HTTP_${status}`, `HTTP ${status}：${message}`, {
    status,
    hint: statusHint(api, status),
    details,
  })
}

export class HttpTransport {
  /** @param {{settings: any, debug: (message: string) => void}} options */
  constructor(options) {
    this.settings = options.settings
    this.debug = options.debug
  }

  /**
   * Open a request without reading the body. The caller must consume or
   * discard `response.body`.
   */
  async open(request) {
    const baseUrl = requireBaseUrl(this.settings)
    const method = String(request.method ?? 'GET').toUpperCase()
    const { api, path } = normalizePath(request.api ?? 'auto', request.path)
    const url = buildUrl(baseUrl, path, request.query)
    const headers = {
      ...authHeaders(api, this.settings),
      ...(request.headers ?? {}),
    }
    let body
    if (request.body !== undefined) {
      body = typeof request.body === 'string' ? request.body : JSON.stringify(request.body)
      if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
        headers['content-type'] = 'application/json'
      }
    }

    const timeoutMs = Math.max(
      1_000,
      Math.min(
        600_000,
        Number.isFinite(request.timeoutMs) ? Math.floor(request.timeoutMs) : this.settings.config.timeoutMs,
      ),
    )
    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    const combined = request.signal === undefined ? timeoutSignal : AbortSignal.any([request.signal, timeoutSignal])
    const startedAt = Date.now()

    let response
    try {
      response = await fetch(url, {
        method,
        headers,
        body,
        redirect: 'error',
        signal: combined,
      })
    } catch (error) {
      if (request.signal?.aborted === true) {
        throw new GpuStackError('ABORTED', '请求已被取消', { hint: '这是调用方取消，不是服务端错误。' })
      }
      if (timeoutSignal.aborted) {
        throw new GpuStackError('TIMEOUT', `请求超时（${timeoutMs} ms）`, {
          hint: '可提高 timeoutMs，或缩小请求范围（分页查询、减少日志行数）。',
        })
      }
      const code = networkCode(error)
      if (error instanceof Error && error.name === 'TypeError' && /redirect/i.test(error.message)) {
        throw new GpuStackError('REDIRECT_REFUSED', '服务端返回了重定向，已拒绝跟随', {
          hint: '请把 baseUrl 改为最终地址，避免 API Key 被转发到其他站点。',
          cause: error,
        })
      }
      throw new GpuStackError(
        'NETWORK_ERROR',
        `无法连接 GPUStack：${error instanceof Error ? error.message : String(error)}`,
        { hint: networkHint(code), cause: error },
      )
    }

    this.debug(`${method} ${url.origin}${url.pathname} -> ${response.status}`)
    return {
      response,
      url,
      api,
      method,
      path,
      timeoutSignal,
      callerSignal: request.signal,
      startedAt,
      headers,
    }
  }

  /** Read a response body, throwing a structured error for an HTTP failure. */
  async finish(opened, options = {}) {
    const { response } = opened
    const maxBytes = options.maxBytes ?? this.settings.config.maxResponseBytes
    let read
    try {
      read = await readLimited(response, maxBytes)
    } catch (error) {
      if (opened.callerSignal?.aborted === true) {
        throw new GpuStackError('ABORTED', '请求已被取消', { hint: '这是调用方取消，不是服务端错误。' })
      }
      if (opened.timeoutSignal?.aborted) {
        throw new GpuStackError('TIMEOUT', '读取响应超时', {
          hint: '可提高 timeoutMs，或缩小请求范围（分页、减少日志行数）。',
          cause: error,
        })
      }
      throw new GpuStackError(
        'NETWORK_ERROR',
        `读取响应失败：${error instanceof Error ? error.message : String(error)}`,
        { hint: '连接可能被服务端或代理中断，可稍后重试。', cause: error },
      )
    }
    const contentType = response.headers.get('content-type') ?? ''
    let json = null
    let parseError = null
    if (read.text.trim().length > 0) {
      try {
        json = JSON.parse(read.text)
      } catch (error) {
        parseError = error
      }
    }

    if (!response.ok) {
      throw httpError(opened.api, response.status, json, read.text)
    }
    if (read.truncated && options.allowTruncated !== true) {
      throw new GpuStackError('RESPONSE_TOO_LARGE', `响应超过 ${maxBytes} 字节上限，已中断读取`, {
        hint: '请缩小请求范围（分页、减少日志行数、过滤字段），或提高插件配置 maxResponseBytes。',
      })
    }
    if (json === null && read.text.trim().length > 0) {
      if (options.allowText === true) {
        return {
          status: response.status,
          ok: response.ok,
          json: null,
          text: redactText(read.text),
          bytes: read.bytes,
          truncated: read.truncated,
          contentType,
          requestId: response.headers.get('x-request-id') ?? response.headers.get('request-id') ?? null,
          durationMs: Date.now() - opened.startedAt,
        }
      }
      throw new GpuStackError('INVALID_JSON', `服务端返回了非 JSON 内容（${contentType || '未知 Content-Type'}）`, {
        hint: `响应片段：${redactText(read.text).slice(0, 300)}`,
        details: { parseError: parseError instanceof Error ? parseError.message : null },
      })
    }

    return {
      status: response.status,
      ok: response.ok,
      json,
      text: options.includeText === true ? redactText(read.text) : null,
      bytes: read.bytes,
      truncated: read.truncated,
      contentType,
      requestId: response.headers.get('x-request-id') ?? response.headers.get('request-id') ?? null,
      durationMs: Date.now() - opened.startedAt,
    }
  }

  /** Open, read, and parse one request in a single call. */
  async request(request) {
    const opened = await this.open(request)
    return this.finish(opened, {
      maxBytes: request.maxBytes,
      allowTruncated: request.allowTruncated,
      allowText: request.allowText,
      includeText: request.includeText,
    })
  }
}
