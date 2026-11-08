/**
 * Error type shared by every GPUStack operation.
 *
 * A GpuStackError always carries a stable machine code, a model-facing Chinese
 * message, and an optional actionable hint. API keys never enter these fields.
 */

export class GpuStackError extends Error {
  /**
   * @param {string} code stable machine-readable code, e.g. HTTP_401
   * @param {string} message Chinese message shown to the model
   * @param {{hint?: string|null, status?: number|null, details?: unknown, cause?: unknown}} [options]
   */
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'GpuStackError'
    this.code = String(code)
    this.hint = typeof options.hint === 'string' && options.hint.length > 0 ? options.hint : null
    this.status = typeof options.status === 'number' ? options.status : null
    this.details = options.details ?? null
  }

  /** Message used by the tool pipeline, which only displays `Error: <message>`. */
  get displayMessage() {
    const parts = [`[${this.code}] ${this.message}`]
    if (this.hint !== null) parts.push(`提示：${this.hint}`)
    return parts.join('\n')
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      hint: this.hint,
      status: this.status,
    }
  }
}

/** Normalize any thrown value into the structured error block used by tools. */
export function errorBlock(error) {
  if (error instanceof GpuStackError) {
    return { code: error.code, message: error.message, hint: error.hint, status: error.status }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { code: 'INTERNAL_ERROR', message, hint: null, status: null }
}

/** Throw a GpuStackError; kept as a helper so call sites stay terse. */
export function fail(code, message, options) {
  throw new GpuStackError(code, message, options)
}

/** True when a fetch rejection was caused by the caller cancelling the tool. */
export function isAbort(error) {
  return (
    (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) ||
    (typeof error === 'object' &&
      error !== null &&
      'name' in error &&
      (error.name === 'AbortError' || error.name === 'TimeoutError'))
  )
}
