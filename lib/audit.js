/**
 * Append-only audit trail for mutating and diagnostic operations.
 *
 * Bodies and query strings are deliberately not recorded: they may contain
 * prompts, model specs, or token material. Only the action, method, path,
 * status, duration, and outcome are written.
 */

import { appendFile, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { ensureDir } from './fs-util.js'
import { redactText } from './redact.js'

export class AuditLog {
  /** @param {{dataDir: string, enabled: boolean, debug: (message: string) => void}} options */
  constructor(options) {
    this.file = join(options.dataDir, 'audit.log')
    this.enabled = options.enabled
    this.debug = options.debug
    this.queue = Promise.resolve()
  }

  /**
   * @param {{tool: string, api?: string, method?: string, path?: string, status?: number|null, ok?: boolean, durationMs?: number, errorCode?: string|null}} entry
   */
  append(entry) {
    if (!this.enabled) return
    const record = {
      ts: new Date().toISOString(),
      tool: entry.tool,
      api: entry.api ?? null,
      method: entry.method ?? null,
      path: entry.path ?? null,
      status: entry.status ?? null,
      ok: entry.ok === true,
      durationMs: entry.durationMs ?? null,
      errorCode: entry.errorCode ?? null,
    }
    const line = `${redactText(JSON.stringify(record))}\n`
    this.queue = this.queue
      .then(async () => {
        await ensureDir(join(this.file, '..'), 0o700)
        await appendFile(this.file, line, { encoding: 'utf8', mode: 0o600 })
        await chmod(this.file, 0o600).catch(() => undefined)
      })
      .catch((error) => {
        this.debug(`audit append failed: ${error instanceof Error ? error.message : String(error)}`)
      })
  }

  async flush() {
    await this.queue.catch(() => undefined)
  }
}
