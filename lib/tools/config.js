/** `gpustack_config`: inspect or update the non-secret cluster metadata. */

import { defineTool } from '../tool.js'
import { S } from '../schema.js'
import { cliCommand } from '../config.js'
import { GpuStackError } from '../errors.js'
import { normalizeBaseUrl } from '../site.js'
import { NULLABLE_STRING } from './schemas.js'

const CREDENTIAL_STATUS = S.string({ required: true, enum: ['available', 'missing', 'unavailable'] })

const OUTPUT_SCHEMA = S.object(
  {
    configured: S.boolean({ required: true }),
    saved: S.boolean({ required: true }),
    baseUrl: NULLABLE_STRING,
    source: S.object(
      {
        baseUrl: NULLABLE_STRING,
        apiKey: S.string({ required: true }),
      },
      { additionalProperties: false },
    ),
    credentials: S.object({ apiKey: CREDENTIAL_STATUS }, { additionalProperties: false }),
    organizationId: S.string({ required: true }),
    dataDir: S.string({ required: true }),
    siteFile: S.string({ required: true }),
    credentialsFile: S.string({ required: true }),
    config: S.object(
      {
        secretsBackend: S.string({ required: true }),
        timeoutMs: S.integer({ required: true }),
        maxResponseBytes: S.integer({ required: true }),
        allowWrites: S.boolean({ required: true }),
        permissions: S.object(
          {
            deploy: S.boolean({ required: true }),
            update: S.boolean({ required: true }),
            restart: S.boolean({ required: true }),
            delete: S.boolean({ required: true }),
            raw: S.boolean({ required: true }),
            inference: S.boolean({ required: true }),
          },
          { additionalProperties: false },
        ),
        audit: S.boolean({ required: true }),
        apiKeyEnv: S.string({ required: true }),
      },
      { additionalProperties: false },
    ),
    hint: NULLABLE_STRING,
  },
  { additionalProperties: false },
)

function credentialStatus(source, error) {
  if (error !== null) return 'unavailable'
  if (source === 'none') return 'unavailable'
  if (source === 'missing') return 'missing'
  return 'available'
}

function hintFor(settings) {
  if (settings.baseUrl.length === 0) {
    return '尚未配置集群地址。请让用户在 设置 → GPUStack 填写，或在本机运行：' + cliCommand('setup --base-url http://<host>:<port>')
  }
  if (settings.apiKeySource === 'missing') {
    return `缺少 API Key。请让用户在 设置 → GPUStack 填写并保存，或运行：${cliCommand('set --api-key')}（密钥不会进入会话记录）。`
  }
  if (settings.baseUrlSource === 'env:GPUSTACK_BASE_URL') {
    return '当前 baseUrl 来自环境变量 GPUSTACK_BASE_URL（优先级最高）；要修改请取消该变量或改设置页。'
  }
  return null
}

function view(settings, saved) {
  return {
    configured: settings.baseUrl.length > 0,
    saved,
    baseUrl: settings.baseUrl.length > 0 ? settings.baseUrl : null,
    source: { baseUrl: settings.baseUrlSource, apiKey: settings.apiKeySource },
    credentials: { apiKey: credentialStatus(settings.apiKeySource, settings.apiKeyError) },
    organizationId: settings.config.organizationId,
    dataDir: settings.dataDir,
    siteFile: settings.siteFile,
    credentialsFile: settings.credentialsFile,
    config: {
      secretsBackend: settings.config.secretsBackend,
      timeoutMs: settings.config.timeoutMs,
      maxResponseBytes: settings.config.maxResponseBytes,
      allowWrites: settings.config.allowWrites,
      permissions: settings.config.permissions,
      audit: settings.config.audit,
      apiKeyEnv: settings.config.apiKeyEnv,
    },
    hint: hintFor(settings),
  }
}

function render(value) {
  const lines = [
    `GPUStack 集群配置${value.saved ? '（已保存 site.json）' : ''}`,
    `  集群地址: ${value.baseUrl ?? '（未配置）'}`,
    `  地址来源: ${value.source.baseUrl ?? '（未配置）'}`,
    `  API Key: ${value.credentials.apiKey}（来源 ${value.source.apiKey}；环境变量名 ${value.config.apiKeyEnv}）`,
    `  组织 ID: ${value.organizationId.length > 0 ? value.organizationId : '（未设置，跨组织操作时才会用到）'}`,
    `  数据目录: ${value.dataDir}`,
    `  站点文件: ${value.siteFile}`,
    `  凭据文件: ${value.credentialsFile}`,
    `  配置: backend=${value.config.secretsBackend} timeout=${value.config.timeoutMs}ms 写操作=${value.config.allowWrites ? '允许' : '只读'} 审计=${value.config.audit ? '开' : '关'}`,
    `  操作权限: 部署=${value.config.permissions.deploy ? '开' : '关'} 改配=${value.config.permissions.update ? '开' : '关'} 重启=${value.config.permissions.restart ? '开' : '关'} 删除=${value.config.permissions.delete ? '开' : '关'} 通用写=${value.config.permissions.raw ? '开' : '关'} 推理=${value.config.permissions.inference ? '开' : '关'}`,
  ]
  if (value.hint !== null) lines.push('', value.hint)
  return [{ type: 'text', text: lines.join('\n') }]
}

/** Register the config tool. */
export function registerConfigTool(ctx, deps) {
  ctx.tools.register(
    defineTool({
      name: 'gpustack_config',
      description:
        '查看或设置 GPUStack 集群的根地址（不接收任何 API Key）。' +
        '当 gpustack_test 报 CONFIG_MISSING，或用户要切换集群时，先 action="show" 查看当前配置，再 action="set" 写入 baseUrl。' +
        'API Key 由用户在 设置 → GPUStack 页面填写，或在本机运行 scripts/dsh-gpustack.mjs 录入；绝不要通过本工具或任何工具参数传递密钥。' +
        '环境变量 GPUSTACK_BASE_URL 的优先级高于 site.json。',
      parameters: S.object(
        {
          action: S.string({ description: 'show=查看（默认），set=写入 site.json', enum: ['show', 'set'] }),
          baseUrl: S.string({
            description: '集群根地址，如 http://192.0.2.10:31901；不要带 /docs、/v1 或 /v2。',
          }),
        },
        { additionalProperties: false },
      ),
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => render(value),
      },
      async execute(args) {
        if (args.action === 'set') {
          if (args.baseUrl === undefined) {
            throw new GpuStackError('INVALID_ARGS', 'action=set 需要 baseUrl', {
              hint: '例如 {"action":"set","baseUrl":"http://192.0.2.10:31901"}。',
            })
          }
          const baseUrl = normalizeBaseUrl(args.baseUrl)
          await deps.runtime.siteStore.write({ baseUrl })
        }
        const settings = await deps.runtime.resolveSettings({ tolerateSecretErrors: true })
        return view(settings, args.action === 'set')
      },
    }),
  )
}
