/**
 * Model readiness polling shared by deploy/update/wait tools.
 *
 * Polls `GET /v2/models/{id}` at a fixed interval and stops on the terminal
 * `running` / `error` states or on timeout/cancellation. No timer outlives the
 * call: the sleep helper rejects as soon as the tool signal aborts.
 */

import { GpuStackError } from './errors.js'
import { sleep } from './tools/common.js'

export const TERMINAL_MODEL_STATES = new Set(['running', 'error'])

/**
 * @param {import('./api.js').GpuStackClient} client
 * @param {number} modelId
 * @param {{signal?: AbortSignal, timeoutMs?: number, intervalMs?: number}} [options]
 */
export async function waitForModel(client, modelId, options = {}) {
  const timeoutMs = Math.max(1_000, Math.min(3_600_000, options.timeoutMs ?? 300_000))
  const intervalMs = Math.max(500, Math.min(60_000, options.intervalMs ?? 5_000))
  const startedAt = Date.now()
  let last = null
  let attempts = 0
  let timedOut = false

  while (true) {
    attempts += 1
    const result = await client.get(`/v2/models/${modelId}`, {}, { signal: options.signal })
    const model = result.body
    if (model === null || typeof model !== 'object' || Array.isArray(model)) {
      throw new GpuStackError('UNEXPECTED_RESPONSE', `模型 ${modelId} 的详情不是对象`, {
        hint: '请用 gpustack_models 核对 id 是否存在。',
      })
    }
    last = model
    const state = typeof model.state === 'string' ? model.state : null
    if (state !== null && TERMINAL_MODEL_STATES.has(state)) break
    if (Date.now() - startedAt >= timeoutMs) {
      timedOut = true
      break
    }
    await sleep(Math.min(intervalMs, Math.max(200, timeoutMs - (Date.now() - startedAt))), options.signal)
  }

  let instances = []
  try {
    const result = await client.list(`/v2/models/${modelId}/instances`, { perPage: 100 }, { signal: options.signal })
    instances = result.items
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    // Instance listing is diagnostic; a failure here must not hide the state.
  }

  return {
    model: last,
    state: last !== null && typeof last.state === 'string' ? last.state : null,
    readyReplicas: typeof last?.ready_replicas === 'number' ? last.ready_replicas : null,
    replicas: typeof last?.replicas === 'number' ? last.replicas : null,
    stateMessage: typeof last?.state_message === 'string' ? last.state_message : null,
    instances,
    attempts,
    elapsedMs: Date.now() - startedAt,
    timedOut,
  }
}
