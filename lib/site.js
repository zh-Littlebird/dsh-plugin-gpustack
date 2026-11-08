/**
 * GPUStack endpoint metadata persisted next to the encrypted credentials.
 *
 * The base URL and the small user-facing overrides (write switch, timeout,
 * organization) are not secrets; keeping them in one JSON file lets the
 * settings page and the CLI configure the plugin without editing
 * cordis.patch.yml and without restarting the Host.
 */

import { join } from 'node:path'
import { atomicWriteFile, ensureDir, readJson } from './fs-util.js'
import { GpuStackError } from './errors.js'

const EMPTY = {
  baseUrl: null,
  allowWrites: null,
  permissions: null,
  timeoutMs: null,
  organizationId: null,
  updatedAt: null,
}

/** Every operation category the settings page can switch independently. */
export const PERMISSION_KEYS = ['deploy', 'update', 'restart', 'delete', 'raw', 'inference']

export const PERMISSION_DEFAULTS = Object.freeze({
  deploy: true,
  update: true,
  restart: true,
  delete: true,
  raw: true,
  inference: true,
})

/** Normalize one permissions object; missing keys fall back to `true`. */
export function normalizePermissions(value) {
  const result = { ...PERMISSION_DEFAULTS }
  if (value === null || value === undefined) return result
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new GpuStackError('SITE_INVALID', 'permissions 必须是对象', {
      hint: `可用键：${PERMISSION_KEYS.join('、')}。`,
    })
  }
  for (const [key, entry] of Object.entries(value)) {
    if (!PERMISSION_KEYS.includes(key)) {
      throw new GpuStackError('SITE_INVALID', `permissions 含未知分类：${key}`, {
        hint: `可用键：${PERMISSION_KEYS.join('、')}。`,
      })
    }
    if (typeof entry !== 'boolean') {
      throw new GpuStackError('SITE_INVALID', `permissions.${key} 必须是布尔值`)
    }
    result[key] = entry
  }
  return result
}

function optionalBoolean(value, field) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'boolean') {
    throw new GpuStackError('SITE_INVALID', `${field} 必须是布尔值`, { hint: 'true 表示允许写操作，false 表示只读。' })
  }
  return value
}

function optionalTimeout(value) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new GpuStackError('SITE_INVALID', 'timeoutMs 必须是数字', { hint: '例如 60000。' })
  }
  return Math.min(600_000, Math.max(1_000, Math.floor(value)))
}

function optionalText(value, field) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') {
    throw new GpuStackError('SITE_INVALID', `${field} 必须是字符串`)
  }
  const text = value.trim()
  return text.length === 0 ? null : text
}

export class SiteStore {
  /** @param {{dir: string}} options */
  constructor(options) {
    this.dir = options.dir
    this.file = join(options.dir, 'site.json')
  }

  /** @returns {Promise<typeof EMPTY>} */
  async read() {
    const document = await readJson(this.file, null)
    if (document === null) return { ...EMPTY }
    if (typeof document !== 'object' || Array.isArray(document)) {
      throw new GpuStackError('SITE_INVALID', `站点配置文件格式无效：${this.file}`, {
        hint: '请在设置页重新保存，或运行 scripts/dsh-gpustack.mjs setup 重新写入。',
      })
    }
    return {
      baseUrl: typeof document.baseUrl === 'string' && document.baseUrl.length > 0 ? document.baseUrl : null,
      allowWrites: typeof document.allowWrites === 'boolean' ? document.allowWrites : null,
      permissions: document.permissions === undefined ? null : normalizePermissions(document.permissions),
      timeoutMs: typeof document.timeoutMs === 'number' ? document.timeoutMs : null,
      organizationId:
        typeof document.organizationId === 'string' && document.organizationId.length > 0
          ? document.organizationId
          : null,
      updatedAt: typeof document.updatedAt === 'string' ? document.updatedAt : null,
    }
  }

  /**
   * Merge and persist site metadata. `undefined` leaves a field unchanged;
   * `null` clears one. A `baseUrl` set here must be non-empty.
   */
  async write(patch) {
    const current = await this.read()
    const baseUrl =
      patch.baseUrl === undefined ? current.baseUrl : patch.baseUrl === null ? null : normalizeBaseUrl(patch.baseUrl)
    const allowWrites = patch.allowWrites === undefined ? current.allowWrites : optionalBoolean(patch.allowWrites, 'allowWrites')
    const permissions =
      patch.permissions === undefined
        ? { ...normalizePermissions(current.permissions) }
        : normalizePermissions({ ...normalizePermissions(current.permissions), ...patch.permissions })
    const timeoutMs = patch.timeoutMs === undefined ? current.timeoutMs : optionalTimeout(patch.timeoutMs)
    const organizationId =
      patch.organizationId === undefined ? current.organizationId : optionalText(patch.organizationId, 'organizationId')

    const document = {
      version: 3,
      baseUrl,
      allowWrites,
      permissions,
      timeoutMs,
      organizationId,
      updatedAt: new Date().toISOString(),
    }
    await ensureDir(this.dir, 0o700)
    await atomicWriteFile(this.file, `${JSON.stringify(document, null, 2)}\n`, 0o600)
    return document
  }
}

/** Validate and normalize a GPUStack root URL (a path prefix is allowed). */
export function normalizeBaseUrl(input) {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new GpuStackError('CONFIG_INVALID', 'baseUrl 为空', {
      hint: '请提供 GPUStack 根地址，例如 http://192.0.2.10:31901（不要带 /v1 或 /v2）。',
    })
  }
  let url
  try {
    url = new URL(input.trim())
  } catch {
    throw new GpuStackError('CONFIG_INVALID', `baseUrl 不是合法的 URL：${input}`, {
      hint: '示例：http://192.0.2.10:31901；只支持 http/https。',
    })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new GpuStackError('CONFIG_INVALID', `baseUrl 只支持 http/https，当前为 ${url.protocol}`, {
      hint: '请使用 https:// 或 http:// 开头的集群地址。',
    })
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new GpuStackError('CONFIG_INVALID', 'baseUrl 不能包含用户名或密码', {
      hint: '凭据应单独录入，不要写进 URL。',
    })
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    throw new GpuStackError('CONFIG_INVALID', 'baseUrl 不能包含查询参数或锚点', { hint: '只填写集群根地址。' })
  }
  let path = url.pathname.replace(/\/+$/, '')
  // Users often paste the docs page or an API prefix; accept those forms.
  path = path.replace(/\/(docs|openapi\.json|v1-openai|v1|v2|api)$/, '')
  url.pathname = path === '' ? '/' : path
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}
