/**
 * Runtime configuration resolution.
 *
 * Precedence for non-secret fields: explicit plugin config > environment >
 * `$DSH_HOME/gpustack/site.json`. The API key comes from the environment when
 * the backend allows it, otherwise from the encrypted file store; environment
 * wins in `auto` mode.
 */

import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GpuStackError } from './errors.js'
import { SecretStore } from './secrets.js'
import { PERMISSION_DEFAULTS, SiteStore, normalizeBaseUrl, normalizePermissions } from './site.js'

export const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const PLUGIN_VERSION = '1.0.0'

export const DEFAULTS = {
  baseUrl: '',
  apiKeyEnv: 'GPUSTACK_API_KEY',
  organizationId: '',
  dataDir: '',
  secretsBackend: 'auto',
  timeoutMs: 60_000,
  maxResponseBytes: 8 * 1024 * 1024,
  allowWrites: true,
  permissions: { ...PERMISSION_DEFAULTS },
  audit: true,
  debug: false,
}

const BACKENDS = new Set(['auto', 'env', 'file', 'none'])

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function clampInteger(value, fallback, minimum, maximum) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(maximum, Math.max(minimum, Math.floor(value)))
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const candidate = text(value)
    if (candidate.length > 0) return candidate
  }
  return ''
}

/** `$DSH_HOME/gpustack`, or an explicit `dataDir`. */
export function resolveDataDir(config = {}) {
  const override = firstNonEmpty(process.env.DSH_GPUSTACK_DATA_DIR, config.dataDir)
  if (override.length > 0) return resolve(override)
  const home = firstNonEmpty(process.env.DSH_HOME) || join(homedir(), '.dsh')
  return resolve(home, 'gpustack')
}

/** Normalize the raw plugin config (patch YAML or programmatic object). */
export function normalizeConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const backend = text(input.secretsBackend).toLowerCase()
  return {
    baseUrl: text(input.baseUrl),
    apiKeyEnv: firstNonEmpty(input.apiKeyEnv, DEFAULTS.apiKeyEnv),
    organizationId: text(input.organizationId),
    dataDir: text(input.dataDir),
    secretsBackend: BACKENDS.has(backend) ? backend : DEFAULTS.secretsBackend,
    timeoutMs: clampInteger(input.timeoutMs, DEFAULTS.timeoutMs, 1_000, 600_000),
    maxResponseBytes: clampInteger(input.maxResponseBytes, DEFAULTS.maxResponseBytes, 64 * 1024, 64 * 1024 * 1024),
    allowWrites: typeof input.allowWrites === 'boolean' ? input.allowWrites : DEFAULTS.allowWrites,
    permissions: normalizePermissions(input.permissions),
    audit: typeof input.audit === 'boolean' ? input.audit : DEFAULTS.audit,
    debug: typeof input.debug === 'boolean' ? input.debug : DEFAULTS.debug,
  }
}

/** Command the user can run locally to provision the missing piece. */
export function cliCommand(args) {
  return `node "${join(PLUGIN_DIR, 'scripts', 'dsh-gpustack.mjs')}" ${args}`
}

/**
 * Create the per-mount runtime. `resolveSettings()` is called per tool
 * invocation so edits to site.json or the environment do not need a restart.
 */
export function createRuntime(rawConfig) {
  const config = normalizeConfig(rawConfig)
  const dataDir = resolveDataDir(config)
  const siteStore = new SiteStore({ dir: dataDir })
  const secretStore = new SecretStore({ dir: dataDir })

  /**
   * @param {{tolerateSecretErrors?: boolean}} [options]
   */
  async function resolveSettings(options = {}) {
    const site = await siteStore.read()

    // Precedence: environment > site.json (set by the settings page or CLI) >
    // plugin config (the deployment default from cordis.patch.yml).
    const envBaseUrl = text(process.env.GPUSTACK_BASE_URL)
    const baseUrlInput = firstNonEmpty(envBaseUrl, site.baseUrl, config.baseUrl)
    const baseUrl = baseUrlInput.length > 0 ? normalizeBaseUrl(baseUrlInput) : ''
    const baseUrlSource =
      envBaseUrl.length > 0
        ? 'env:GPUSTACK_BASE_URL'
        : site.baseUrl !== null
          ? 'site.json'
          : text(config.baseUrl).length > 0
            ? 'config'
            : null

    const effectiveConfig = {
      ...config,
      allowWrites: site.allowWrites ?? config.allowWrites,
      permissions: { ...config.permissions, ...(site.permissions ?? {}) },
      timeoutMs: site.timeoutMs ?? config.timeoutMs,
      organizationId: site.organizationId ?? config.organizationId,
    }

    let apiKey
    let apiKeyError = null

    const backend = config.secretsBackend
    const envApiKey = text(process.env[config.apiKeyEnv])

    if (backend === 'env' || backend === 'auto') {
      if (envApiKey.length > 0) apiKey = envApiKey
    }

    if (apiKey === undefined && (backend === 'file' || backend === 'auto')) {
      try {
        apiKey = await secretStore.get('site:apiKey')
      } catch (error) {
        if (!options.tolerateSecretErrors) throw error
        apiKeyError = error instanceof Error ? error.message : String(error)
      }
    }

    const apiKeySource =
      envApiKey.length > 0 && (backend === 'env' || backend === 'auto')
        ? `env:${config.apiKeyEnv}`
        : backend === 'none'
          ? 'none'
          : apiKey !== undefined
            ? 'file'
            : 'missing'

    return {
      config: effectiveConfig,
      dataDir,
      site,
      siteFile: siteStore.file,
      credentialsFile: secretStore.credentialsFile,
      organizationId: effectiveConfig.organizationId,
      baseUrl,
      baseUrlSource,
      apiKey,
      apiKeySource,
      apiKeyError,
      secretStore,
      siteStore,
    }
  }

  return { config, dataDir, siteStore, secretStore, resolveSettings }
}

export function requireBaseUrl(settings) {
  if (settings.baseUrl.length > 0) return settings.baseUrl
  throw new GpuStackError('CONFIG_MISSING', '还没有配置 GPUStack 集群地址', {
    hint: `请由用户在本机运行 ${cliCommand('setup --base-url http://<host>:<port>')}，或让用户在本机设置环境变量 GPUSTACK_BASE_URL。`,
  })
}

export function requireApiKey(settings) {
  if (typeof settings.apiKey === 'string' && settings.apiKey.length > 0) return settings.apiKey
  throw new GpuStackError('CONFIG_MISSING', '缺少 GPUStack API Key', {
    hint: `请由用户在本机运行 ${cliCommand('set --api-key')} 录入，或设置环境变量 ${settings.config.apiKeyEnv}。模型不会接收 API Key。`,
  })
}
