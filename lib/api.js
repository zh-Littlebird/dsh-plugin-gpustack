/**
 * Typed GPUStack v2 client.
 *
 * Every method funnels through `HttpTransport`, so authentication, timeouts,
 * redaction, and error mapping stay in one place. Callers pass the tool's
 * abort signal down so cancellation is immediate.
 */

import { GpuStackError } from './errors.js'

/** Maximum page size the API accepts (defaults to 100 server-side). */
export const MAX_PAGE_SIZE = 500

export class GpuStackClient {
  /** @param {{settings: any, transport: any, debug?: (message: string) => void}} options */
  constructor(options) {
    this.settings = options.settings
    this.transport = options.transport
    this.debug = options.debug ?? (() => {})
  }

  /** One request; returns the transport result (json, text, status, duration). */
  async request(options) {
    return this.transport.request(options)
  }

  /** One request that must yield a JSON object (or array when declared). */
  async json(options) {
    const result = await this.transport.request(options)
    return result
  }

  /**
   * List one collection. GPUStack wraps items as `{items, pagination}`.
   * @returns {Promise<{items: any[], pagination: any|null, durationMs: number, status: number, requestId: string|null}>}
   */
  async list(path, query = {}, options = {}) {
    const result = await this.transport.request({
      method: 'GET',
      path,
      query,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      maxBytes: options.maxBytes,
    })
    const body = result.json
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new GpuStackError('UNEXPECTED_RESPONSE', `列表接口返回了非预期结构：${path}`, {
        hint: '响应不是 {items, pagination} 信封；请用 gpustack_request 查看原始响应。',
      })
    }
    return {
      items: Array.isArray(body.items) ? body.items : [],
      pagination: body.pagination !== undefined && body.pagination !== null ? body.pagination : null,
      durationMs: result.durationMs,
      status: result.status,
      requestId: result.requestId,
    }
  }

  /** GET one object. */
  async get(path, query = {}, options = {}) {
    const result = await this.transport.request({
      method: 'GET',
      path,
      query,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      maxBytes: options.maxBytes,
    })
    return { body: result.json, durationMs: result.durationMs, status: result.status }
  }

  /** GET plain-text payload (model instance logs). */
  async text(path, query = {}, options = {}) {
    return this.transport.request({
      method: 'GET',
      path,
      query,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      maxBytes: options.maxBytes,
      allowText: true,
      allowTruncated: true,
      includeText: true,
    })
  }

  /** OpenAI-compatible chat completion. */
  async chat(body, options = {}) {
    return this.transport.request({
      method: 'POST',
      api: 'inference',
      path: '/v1/chat/completions',
      body,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    })
  }

  /** Identity behind the configured API key; proves management scope works. */
  async whoami(options = {}) {
    return this.get('/v2/users/me', {}, { signal: options.signal, timeoutMs: options.timeoutMs })
  }
}
