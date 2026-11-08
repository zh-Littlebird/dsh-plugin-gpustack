/**
 * Gateway self-check shared by the `gpustack_test` tool and the settings page.
 *
 * It never throws for an upstream failure: every probe records a status so the
 * caller can show which layer is broken (network, management scope, inference
 * scope, model authorization).
 */

import { GpuStackError } from './errors.js'
import { cliCommand } from './config.js'

function authErrorStatus(error) {
  if (error?.status === 401 || error?.status === 403) return 'unauthorized'
  if (error?.code === 'CONFIG_MISSING') return 'missing'
  return 'error'
}

/**
 * @param {import('./api.js').GpuStackClient} client
 * @param {{timeoutMs?: number, signal?: AbortSignal, skipInference?: boolean}} [options]
 */
export async function probeGateway(client, options = {}) {
  const startedAt = Date.now()
  const timeoutMs =
    typeof options.timeoutMs === 'number' && options.timeoutMs > 0 ? Math.max(1_000, options.timeoutMs) : 8_000

  const probe = async (path) => {
    try {
      const result = await client.request({
        api: 'public',
        method: 'GET',
        path,
        allowText: true,
        timeoutMs,
        signal: options.signal,
      })
      return { ok: true, value: result.json ?? result.text ?? null, status: result.status }
    } catch (error) {
      return { ok: false, value: null, status: error?.status ?? null, error }
    }
  }

  const healthz = await probe('/healthz')
  const readyz = await probe('/readyz')
  const versionProbe = await probe('/version')
  const versionValue = versionProbe.value
  const version =
    versionValue !== null && typeof versionValue === 'object'
      ? typeof versionValue.version === 'string'
        ? versionValue.version
        : JSON.stringify(versionValue)
      : typeof versionValue === 'string'
        ? versionValue
        : null

  const auth = {
    configured: typeof client.settings?.apiKey === 'string' && client.settings.apiKey.length > 0,
    source: client.settings?.apiKeySource ?? 'missing',
    management: { status: 'skipped', message: null, userId: null, username: null, isAdmin: null },
    inference: { status: 'skipped', message: null, modelCount: null },
  }

  if (auth.configured) {
    try {
      const result = await client.request({
        method: 'GET',
        path: '/v2/users/me',
        timeoutMs,
        signal: options.signal,
      })
      const user = result.json ?? {}
      auth.management = {
        status: 'ok',
        message: null,
        userId: typeof user.id === 'number' ? user.id : null,
        username: typeof user.username === 'string' ? user.username : null,
        isAdmin: typeof user.is_admin === 'boolean' ? user.is_admin : null,
      }
    } catch (error) {
      auth.management = {
        status: authErrorStatus(error),
        message: error instanceof Error ? error.message : String(error),
        userId: null,
        username: null,
        isAdmin: null,
      }
    }

    if (options.skipInference !== true) {
      try {
        const result = await client.request({
          api: 'inference',
          method: 'GET',
          path: '/v1/models',
          timeoutMs,
          signal: options.signal,
        })
        const body = result.json ?? {}
        const items = Array.isArray(body?.data) ? body.data : Array.isArray(body?.items) ? body.items : []
        auth.inference = { status: 'ok', message: null, modelCount: items.length }
      } catch (error) {
        auth.inference = {
          status: authErrorStatus(error),
          message: error instanceof Error ? error.message : String(error),
          modelCount: null,
        }
      }
    }
  } else {
    auth.management = { status: 'missing', message: '没有可用的 API Key', userId: null, username: null, isAdmin: null }
    auth.inference = { status: 'missing', message: '没有可用的 API Key', modelCount: null }
  }

  const reachable = healthz.ok
  let hint = null
  if (!reachable) {
    hint =
      healthz.error instanceof GpuStackError && healthz.error.hint !== null
        ? healthz.error.hint
        : '无法访问 /healthz：请确认地址、端口与网络，必要时修正集群地址。'
  } else if (!auth.configured) {
    hint = `缺少 API Key。请运行：${cliCommand('set --api-key')}，或在本页填写后保存；密钥不会进入会话记录。`
  } else if (auth.management.status === 'unauthorized') {
    hint = '管理接口鉴权失败：Key 可能无效或只有 inference scope。请换用 management scope 的 Key（或 scope 含 * 的 Key）。'
  } else if (auth.management.status === 'error') {
    hint = '管理接口请求失败：查看 message；若是 5xx，先检查 /readyz 与服务端日志。'
  } else if (auth.inference.status === 'unauthorized') {
    hint = '推理接口鉴权失败：Key 的 scope 可能不含 inference，或 allowed_model_names 未覆盖任何模型。'
  } else if (auth.inference.status === 'ok' && auth.inference.modelCount === 0) {
    hint = '推理接口可用，但当前没有可调用模型：确认是否已部署模型且该 Key 被授权。'
  }

  return {
    reachable,
    healthz: healthz.ok ? 'ok' : null,
    readyz: readyz.ok ? 'ok' : null,
    version,
    auth,
    hint,
    durationMs: Date.now() - startedAt,
  }
}
