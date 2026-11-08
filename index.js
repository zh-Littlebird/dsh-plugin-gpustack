/**
 * dsh-plugin-gpustack — GPUStack v2 cluster tools for DeepSeek Harness.
 *
 * Exposes a typed surface for the operations documented at `/docs`: cluster
 * inventory, model deployment and lifecycle, instance logs, readiness waits,
 * inference acceptance, usage accounting, and a generic endpoint caller.
 *
 * State lives under `$DSH_HOME/gpustack` (site.json, encrypted credentials,
 * audit.log). The API key never enters a tool argument, a tool result, or the
 * session log; the user provisions it locally with scripts/dsh-gpustack.mjs.
 */

import { createRuntime } from './lib/config.js'
import { AuditLog } from './lib/audit.js'
import { HttpTransport } from './lib/http.js'
import { GpuStackClient } from './lib/api.js'
import { createDebugLogger } from './lib/redact.js'
import { registerConfigTool } from './lib/tools/config.js'
import { registerTestTool } from './lib/tools/status.js'
import { registerInventoryTool } from './lib/tools/inventory.js'
import { registerModelsTool } from './lib/tools/models.js'
import { registerDeployTool } from './lib/tools/deploy.js'
import { registerUpdateTool } from './lib/tools/update.js'
import { registerActionsTool } from './lib/tools/actions.js'
import { registerLogsTool } from './lib/tools/logs.js'
import { registerWaitTool } from './lib/tools/wait-model.js'
import { registerChatTool } from './lib/tools/chat.js'
import { registerUsageTool } from './lib/tools/usage.js'
import { registerRequestTool } from './lib/tools/raw.js'
import { registerUiRoute } from './lib/ui-api.js'

export const name = 'gpustack'

/** The tool registry is the only required service. */
export const inject = ['tools']

/**
 * Mount the GPUStack tools.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown> | undefined} rawConfig
 */
export function apply(ctx, rawConfig) {
  const runtime = createRuntime(rawConfig)
  const debug = createDebugLogger(runtime.config.debug)
  const audit = new AuditLog({
    dataDir: runtime.dataDir,
    enabled: runtime.config.audit,
    debug,
  })

  /** Build a client for already-resolved settings. */
  const clientFor = (options) => {
    const transport = new HttpTransport({ settings: options.settings, debug })
    return { transport, client: new GpuStackClient({ settings: options.settings, transport, debug }) }
  }

  const deps = {
    runtime,
    debug,
    audit,
    clientFor,
    /** Resolve settings and build the transport/client for one invocation. */
    async context(options = {}) {
      const settings = await runtime.resolveSettings(options)
      const { transport, client } = clientFor({ settings })
      return { settings, transport, client }
    },
    /** Append one redacted audit record; never includes bodies or query strings. */
    record(tool, entry) {
      audit.append({ tool, ...entry })
    },
  }

  registerConfigTool(ctx, deps)
  registerTestTool(ctx, deps)
  registerInventoryTool(ctx, deps)
  registerModelsTool(ctx, deps)
  registerDeployTool(ctx, deps)
  registerUpdateTool(ctx, deps)
  registerActionsTool(ctx, deps)
  registerLogsTool(ctx, deps)
  registerWaitTool(ctx, deps)
  registerChatTool(ctx, deps)
  registerUsageTool(ctx, deps)
  registerRequestTool(ctx, deps)

  // Loopback-only settings API used by the Web settings page and the plugin
  // row's configure page. It writes site.json / the credential store only;
  // no Host restart is needed for those values to take effect.
  registerUiRoute(ctx, {
    runtime,
    clientFor,
    audit,
    debug,
    dataDir: runtime.dataDir,
  })

  // There are no sockets or timers to close; flush queued audit writes.
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      void audit.flush()
    })
  }
  debug(`mounted with dataDir=${runtime.dataDir} backend=${runtime.config.secretsBackend}`)
}
