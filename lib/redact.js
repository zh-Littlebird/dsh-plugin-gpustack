/**
 * Secret redaction for every value that leaves the plugin.
 *
 * Two independent protections are applied:
 * 1. Every resolved credential is registered in-process and replaced wherever
 *    it appears verbatim.
 * 2. Object keys that conventionally carry credentials are masked, and any
 *    `gpustack_...` key shape is masked even when it was never resolved here.
 *
 * Redaction is best-effort and deliberately never logs the original value.
 */

const MASK = '***'
const registered = new Set()
const MAX_REGISTERED = 64
const KEY_SHAPE = /gpustack_[A-Za-z0-9_-]{12,}/g

/** Remember one live secret so accidental echoes are scrubbed later. */
export function registerSecret(value) {
  if (typeof value !== 'string' || value.length < 6) return
  if (registered.has(value)) return
  if (registered.size >= MAX_REGISTERED) {
    const oldest = registered.values().next().value
    if (oldest !== undefined) registered.delete(oldest)
  }
  registered.add(value)
}

/** Mask a secret for display; short values reveal nothing. */
export function maskSecret(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  if (value.includes('*') && value.length <= 16) return value
  if (value.length <= 8) return MASK
  const prefix = value.startsWith('gpustack_') ? 'gpustack_' : ''
  const body = value.slice(prefix.length)
  if (body.length <= 8) return `${prefix}${MASK}`
  return `${prefix}${body.slice(0, 4)}${'*'.repeat(8)}${body.slice(-4)}`
}

/** Replace registered secrets and any recognizable key shape in one string. */
export function redactText(value) {
  if (typeof value !== 'string' || value.length === 0) return value
  let text = value
  for (const secret of registered) {
    if (secret.length >= 6 && text.includes(secret)) text = text.split(secret).join(MASK)
  }
  return text.replace(KEY_SHAPE, (match) => maskSecret(match) ?? MASK)
}

const SENSITIVE_KEY =
  /(^|[_-])(api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|private[_-]?key|authorization|credential|token)$/i

const API_KEY_OBJECT_HINTS = new Set([
  'masked_value',
  'allowed_model_names',
  'is_custom',
  'expires_at',
  'owner_principal_id',
])

function looksLikeApiKeyObject(object) {
  if (object === null || typeof object !== 'object' || Array.isArray(object)) return false
  for (const key of Object.keys(object)) {
    if (API_KEY_OBJECT_HINTS.has(key)) return true
  }
  return false
}

/**
 * Deep-copy a JSON-ish value with credentials masked.
 * @param {unknown} value
 * @param {{key?: string, parent?: unknown, seen?: WeakSet<object>}} [context]
 */
export function redactValue(value, context = {}) {
  if (typeof value === 'string') {
    const text = redactText(value)
    const key = context.key ?? ''
    if (SENSITIVE_KEY.test(key)) return MASK
    if (key === 'value') {
      // ApiKeyPublic carries the plaintext key only in the create response;
      // any other object with a `value` string is left untouched.
      const parent = context.parent
      if (value.startsWith('gpustack_') || looksLikeApiKeyObject(parent)) return maskSecret(value)
    }
    return text
  }
  if (value === null || typeof value !== 'object') return value
  if (context.seen?.has(value)) return '[circular]'
  const seen = context.seen ?? new WeakSet()
  seen.add(value)
  if (Array.isArray(value)) {
    return value.map((entry, index) => redactValue(entry, { key: String(index), parent: value, seen }))
  }
  const output = {}
  for (const [key, entry] of Object.entries(value)) {
    output[key] = redactValue(entry, { key, parent: value, seen })
  }
  return output
}

/** JSON.stringify with redaction, falling back to a readable placeholder. */
export function redactedJson(value, space = 2) {
  try {
    return JSON.stringify(redactValue(value), null, space)
  } catch {
    return '[unserializable]'
  }
}

/** Debug logger that never prints secrets. */
export function createDebugLogger(enabled) {
  return (message) => {
    if (!enabled) return
    try {
      console.error(`[gpustack] ${redactText(String(message))}`)
    } catch {
      // Diagnostics must never break a tool call.
    }
  }
}
