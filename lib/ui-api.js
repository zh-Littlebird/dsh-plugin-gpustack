/**
 * Loopback-only settings API behind the Web "GPUStack" settings page and the
 * plugin row's configure page.
 *
 * It is mounted at `/gpustack-ui` on the Harness web server. Reads are limited
 * to loopback clients; writes must also carry the page's custom header and a
 * same-machine Origin, which keeps ordinary cross-site requests out.
 *
 * The API Key may be submitted here. It is written only to the encrypted
 * credential store and is never returned, audited, or logged.
 */

import { GpuStackError } from './errors.js'
import { normalizeBaseUrl } from './site.js'
import { probeGateway } from './probe.js'
import { SCOPE_LABELS } from './permissions.js'

export const ROUTE_PREFIX = '/gpustack-ui'
const WRITE_HEADER = 'x-gpustack-ui'

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(text)
}

function sendError(res, status, error) {
  if (error instanceof GpuStackError) {
    sendJson(res, status, { error: { code: error.code, message: error.message, hint: error.hint } })
    return
  }
  const message = error instanceof Error ? error.message : String(error)
  sendJson(res, status, { error: { code: 'INTERNAL', message: message.length === 0 ? '请求失败' : message, hint: null } })
}

function statusFor(error) {
  if (!(error instanceof GpuStackError)) return 500
  if (error.code === 'FORBIDDEN') return 403
  if (error.code === 'BODY_TOO_LARGE') return 413
  if (error.code === 'NOT_FOUND') return 404
  if (error.code === 'METHOD_NOT_ALLOWED') return 405
  if (error.code === 'WRITE_FORBIDDEN') return 403
  return 400
}

function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address.length === 0) return false
  return address === '::1' || address === '::ffff:127.0.0.1' || address.startsWith('127.')
}

function isLoopbackOrigin(origin) {
  try {
    const url = new URL(origin)
    return (
      url.hostname === '127.0.0.1' ||
      url.hostname === 'localhost' ||
      url.hostname === '[::1]' ||
      url.hostname === '::1'
    )
  } catch {
    return false
  }
}

function assertLoopback(req) {
  if (!isLoopbackAddress(req.socket?.remoteAddress ?? undefined)) {
    throw new GpuStackError('FORBIDDEN', '该接口只允许本机访问', { hint: '请在 Harness 所在机器上打开设置页。' })
  }
}

function assertWrite(req) {
  assertLoopback(req)
  const header = req.headers[WRITE_HEADER]
  const value = Array.isArray(header) ? header[0] : header
  if (value !== '1') {
    throw new GpuStackError('WRITE_FORBIDDEN', '缺少页面写入标记', { hint: '请从设置页操作，不要用脚本直接调用该写接口。' })
  }
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin.length > 0 && !isLoopbackOrigin(origin)) {
    throw new GpuStackError('WRITE_FORBIDDEN', '拒绝跨站写入', { hint: '设置页必须从本机地址打开。' })
  }
}

const MAX_BODY = 64 * 1024

async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    total += buffer.length
    if (total > MAX_BODY) {
      throw new GpuStackError('BODY_TOO_LARGE', '请求体过大', { hint: '请缩短输入后重试。' })
    }
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text.length === 0) return {}
  let value
  try {
    value = JSON.parse(text)
  } catch {
    throw new GpuStackError('INVALID_ARGS', '请求体不是合法 JSON', { hint: '请刷新页面后重试。' })
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new GpuStackError('INVALID_ARGS', '请求体必须是 JSON 对象', { hint: '请刷新页面后重试。' })
  }
  return value
}

function credentialStatus(settings) {
  if (settings.apiKeyError !== null) return 'unavailable'
  if (settings.apiKeySource === 'none') return 'unavailable'
  if (settings.apiKeySource === 'missing') return 'missing'
  return 'available'
}

async function stateOf(deps) {
  const settings = await deps.runtime.resolveSettings({ tolerateSecretErrors: true })
  const baseUrl = settings.baseUrl.length > 0 ? settings.baseUrl : null
  const lockedByEnv = settings.baseUrlSource === 'env:GPUSTACK_BASE_URL'
  const credential = credentialStatus(settings)
  const permissions = settings.config.permissions
  const disabledScopes = Object.entries(permissions)
    .filter(([key, allowed]) => key in SCOPE_LABELS && allowed === false)
    .map(([key]) => SCOPE_LABELS[key])

  let hint = null
  if (baseUrl === null) hint = '还没有配置集群地址：填写 GPUStack 根地址（如 http://192.0.2.10:31901）后保存。'
  else if (credential === 'missing') hint = '还没有 API Key：在下方填写后保存。密钥只写入本机加密文件。'
  else if (lockedByEnv) hint = '集群地址来自环境变量 GPUSTACK_BASE_URL；要在此修改，请先取消该环境变量。'
  else if (settings.config.allowWrites !== true) hint = '写操作总开关已关闭（只读模式）：部署、改配、重启、删除与通用写都会被拒绝，只读查询与推理开关仍按分类生效。'
  else if (disabledScopes.length > 0) hint = `已关闭分类：${disabledScopes.join('、')}。其余操作不受影响。`

  return {
    ok: true,
    baseUrl,
    baseUrlSource: settings.baseUrlSource,
    baseUrlEditable: !lockedByEnv,
    credentials: { apiKey: credential, source: settings.apiKeySource },
    config: {
      secretsBackend: settings.config.secretsBackend,
      apiKeyEnv: settings.config.apiKeyEnv,
      timeoutMs: settings.config.timeoutMs,
      allowWrites: settings.config.allowWrites,
      permissions,
      audit: settings.config.audit,
      organizationId: settings.config.organizationId,
    },
    files: {
      dataDir: settings.dataDir,
      siteFile: settings.siteFile,
      credentialsFile: settings.credentialsFile,
    },
    hint,
  }
}

/**
 * Build the request handler. Exported so tests can drive it without Cordis.
 * @param {{runtime: any, clientFor: Function, audit: any, debug: Function}} deps
 */
export function createUiHandler(deps) {
  return async (req, res) => {
    try {
      assertLoopback(req)
      const url = new URL(req.url ?? ROUTE_PREFIX, 'http://127.0.0.1')
      const pathname = url.pathname.replace(/\/+$/, '') || ROUTE_PREFIX
      const method = (req.method ?? 'GET').toUpperCase()

      if (pathname === `${ROUTE_PREFIX}/health`) {
        sendJson(res, 200, { ok: true, route: ROUTE_PREFIX })
        return
      }

      if (pathname === `${ROUTE_PREFIX}/state`) {
        if (method !== 'GET' && method !== 'HEAD') {
          throw new GpuStackError('METHOD_NOT_ALLOWED', '该端点只接受 GET', { hint: '请刷新页面后重试。' })
        }
        sendJson(res, 200, await stateOf(deps))
        return
      }

      if (pathname === `${ROUTE_PREFIX}/config`) {
        if (method !== 'POST') {
          throw new GpuStackError('METHOD_NOT_ALLOWED', '该端点只接受 POST', { hint: '请刷新页面后重试。' })
        }
        assertWrite(req)
        const body = await readJsonBody(req)
        const patch = {}
        if (Object.hasOwn(body, 'baseUrl')) {
          if (body.baseUrl === null) {
            patch.baseUrl = null
          } else if (typeof body.baseUrl === 'string') {
            patch.baseUrl = body.baseUrl.trim().length === 0 ? null : normalizeBaseUrl(body.baseUrl)
          } else {
            throw new GpuStackError('INVALID_ARGS', 'baseUrl 必须是字符串或 null')
          }
        }
        if (Object.hasOwn(body, 'allowWrites')) {
          if (typeof body.allowWrites !== 'boolean') {
            throw new GpuStackError('INVALID_ARGS', 'allowWrites 必须是布尔值')
          }
          patch.allowWrites = body.allowWrites
        }
        if (Object.hasOwn(body, 'timeoutMs')) {
          const value = body.timeoutMs
          if (typeof value !== 'number' || !Number.isFinite(value)) {
            throw new GpuStackError('INVALID_ARGS', 'timeoutMs 必须是数字')
          }
          patch.timeoutMs = value
        }
        if (Object.hasOwn(body, 'permissions')) {
          if (body.permissions === null || typeof body.permissions !== 'object' || Array.isArray(body.permissions)) {
            throw new GpuStackError('INVALID_ARGS', 'permissions 必须是对象', {
              hint: '例如 {"deploy":true,"delete":false}。',
            })
          }
          patch.permissions = body.permissions
        }
        if (Object.hasOwn(body, 'organizationId')) {
          if (body.organizationId !== null && typeof body.organizationId !== 'string') {
            throw new GpuStackError('INVALID_ARGS', 'organizationId 必须是字符串或 null')
          }
          patch.organizationId = body.organizationId
        }
        if (Object.keys(patch).length === 0) {
          throw new GpuStackError('INVALID_ARGS', '没有要保存的字段', { hint: '至少提供 baseUrl、allowWrites、timeoutMs 或 organizationId。' })
        }
        await deps.runtime.siteStore.write(patch)
        deps.audit.append({ tool: 'settings', action: 'config', ok: true })
        const state = await stateOf(deps)
        sendJson(res, 200, { ...state, saved: Object.keys(patch) })
        return
      }

      if (pathname === `${ROUTE_PREFIX}/api-key`) {
        if (method === 'PUT' || method === 'POST') {
          assertWrite(req)
          const body = await readJsonBody(req)
          if (typeof body.value !== 'string' || body.value.trim().length < 8) {
            throw new GpuStackError('INVALID_ARGS', 'API Key 太短', { hint: '形如 gpustack_xxx；粘贴完整 Key 后重试。' })
          }
          const settings = await deps.runtime.resolveSettings({ tolerateSecretErrors: true })
          await settings.secretStore.set('site:apiKey', body.value.trim())
          deps.audit.append({ tool: 'settings', action: 'api-key-set', ok: true })
          sendJson(res, 200, await stateOf(deps))
          return
        }
        if (method === 'DELETE') {
          assertWrite(req)
          const settings = await deps.runtime.resolveSettings({ tolerateSecretErrors: true })
          await settings.secretStore.delete('site:apiKey')
          deps.audit.append({ tool: 'settings', action: 'api-key-clear', ok: true })
          sendJson(res, 200, await stateOf(deps))
          return
        }
        throw new GpuStackError('METHOD_NOT_ALLOWED', '该端点只接受 PUT 或 DELETE', { hint: '请刷新页面后重试。' })
      }

      if (pathname === `${ROUTE_PREFIX}/test`) {
        if (method !== 'POST') {
          throw new GpuStackError('METHOD_NOT_ALLOWED', '该端点只接受 POST', { hint: '请刷新页面后重试。' })
        }
        assertWrite(req)
        const settings = await deps.runtime.resolveSettings({ tolerateSecretErrors: true })
        if (settings.baseUrl.length === 0) {
          sendJson(res, 200, {
            ok: false,
            reachable: false,
            version: null,
            management: { status: 'missing', username: null, isAdmin: null, message: '还没有配置集群地址' },
            inference: { status: 'skipped', modelCount: null, message: null },
            durationMs: 0,
            hint: '先填写并保存集群地址，再测试连接。',
          })
          return
        }
        const { client } = deps.clientFor({ settings })
        const result = await probeGateway(client, {})
        deps.audit.append({ tool: 'settings', action: 'test', ok: result.reachable, durationMs: result.durationMs })
        sendJson(res, 200, {
          ok: result.reachable && result.auth.management.status === 'ok',
          reachable: result.reachable,
          version: result.version,
          management: {
            status: result.auth.management.status,
            username: result.auth.management.username,
            isAdmin: result.auth.management.isAdmin,
            message: result.auth.management.message,
          },
          inference: {
            status: result.auth.inference.status,
            modelCount: result.auth.inference.modelCount,
            message: result.auth.inference.message,
          },
          durationMs: result.durationMs,
          hint: result.hint,
        })
        return
      }

      throw new GpuStackError('NOT_FOUND', '未知端点', { hint: `可用端点：${ROUTE_PREFIX}/state` })
    } catch (error) {
      if (deps.debug) deps.debug(`ui-api error: ${error instanceof Error ? error.message : String(error)}`)
      sendError(res, statusFor(error), error)
    }
  }
}

/** Register the settings API once the Harness web server is available. */
export function registerUiRoute(ctx, deps) {
  const route = { kind: 'prefix', path: ROUTE_PREFIX, handler: createUiHandler(deps) }

  const attach = (owning, mode) => {
    let webServer
    try {
      webServer = typeof owning.get === 'function' ? owning.get('webServer') : undefined
    } catch {
      webServer = undefined
    }
    if (webServer === undefined) {
      deps.debug(`ui route not mounted (${mode}): webServer unavailable`)
      return () => {}
    }
    try {
      const dispose = webServer.register(route)
      deps.debug(`ui route mounted at ${ROUTE_PREFIX} (${mode})`)
      return dispose
    } catch (error) {
      deps.debug(`ui route registration failed: ${error instanceof Error ? error.message : String(error)}`)
      return () => {}
    }
  }

  const inject = typeof ctx.inject === 'function' ? ctx.inject.bind(ctx) : undefined
  if (inject !== undefined) {
    inject(['webServer'], (inner) => attach(inner, 'inject'))
    return
  }
  ctx.effect(() => attach(ctx, 'direct'))
}
