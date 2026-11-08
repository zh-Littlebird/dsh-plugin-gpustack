/** Rendering, normalization, and timing helpers shared by tool modules. */

import { redactValue } from '../redact.js'

export function createDebug(enabled) {
  return (message) => {
    if (!enabled) return
    try {
      console.error(`[gpustack] ${message}`)
    } catch {
      // Diagnostics must never break a tool call.
    }
  }
}

/** Trim a JSON rendering to a model-friendly size. */
export function renderJson(value, maxChars = 6_000) {
  let text
  try {
    text = JSON.stringify(redactValue(value), null, 2)
  } catch {
    text = String(value)
  }
  if (text === undefined) return 'null'
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n... [truncated ${text.length - maxChars} chars]`
}

export function truncateText(value, maxChars) {
  if (typeof value !== 'string') return ''
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars)}\n... [truncated ${value.length - maxChars} chars]`
}

export function formatTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = value > 1e12 ? value : value * 1000
    try {
      return new Date(milliseconds).toISOString()
    } catch {
      return null
    }
  }
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString()
  }
  return null
}

export function asString(value) {
  return typeof value === 'string' ? value : value === null || value === undefined ? null : String(value)
}

export function asNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function asBoolean(value) {
  return typeof value === 'boolean' ? value : null
}

export function asInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}

export function splitList(value) {
  if (Array.isArray(value)) return value.map((entry) => String(entry)).filter((entry) => entry.length > 0)
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
  }
  return []
}

/** Human-readable byte size with a fixed unit. */
export function formatBytes(bytes) {
  const value = asNumber(bytes)
  if (value === null || value < 0) return null
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let scaled = value
  let index = 0
  while (scaled >= 1024 && index < units.length - 1) {
    scaled /= 1024
    index += 1
  }
  const rounded = index === 0 ? String(Math.round(scaled)) : scaled.toFixed(scaled >= 100 ? 0 : 1)
  return `${rounded} ${units[index]}`
}

/** Bytes to gibibytes for GPU memory display. */
export function bytesToGb(bytes) {
  const value = asNumber(bytes)
  if (value === null) return null
  return Math.round((value / 1024 ** 3) * 10) / 10
}

export function clampInteger(value, fallback, minimum, maximum) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(maximum, Math.max(minimum, Math.floor(value)))
}

export function renderError(error) {
  if (error === null || error === undefined) return ''
  const code = error.code ?? 'ERROR'
  const message = error.message ?? String(error)
  const hint = error.hint ? `\n提示：${error.hint}` : ''
  return `[${code}] ${message}${hint}`
}

/** Build the standard structured error block; callers must have already handled it. */
export function errorInfo(error) {
  if (error === null || typeof error !== 'object') {
    return { code: 'INTERNAL_ERROR', message: String(error), hint: null, status: null }
  }
  return {
    code: typeof error.code === 'string' ? error.code : 'INTERNAL_ERROR',
    message: typeof error.message === 'string' ? error.message : String(error),
    hint: typeof error.hint === 'string' ? error.hint : null,
    status: typeof error.status === 'number' ? error.status : null,
  }
}

function abortError() {
  const error = new Error('请求已被取消')
  error.name = 'AbortError'
  return error
}

/** Sleep that rejects with an AbortError as soon as the tool is cancelled. */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortError())
      return
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, Math.max(0, ms))
    const onAbort = () => {
      cleanup()
      reject(abortError())
    }
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

/** Today in UTC as `YYYY-MM-DD`. */
export function utcDateString(date = new Date()) {
  return date.toISOString().slice(0, 10)
}

/** Shift a `YYYY-MM-DD` string by whole days (UTC). */
export function shiftDate(dateString, days) {
  const parsed = new Date(`${dateString}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime())) return dateString
  parsed.setUTCDate(parsed.getUTCDate() + days)
  return parsed.toISOString().slice(0, 10)
}
