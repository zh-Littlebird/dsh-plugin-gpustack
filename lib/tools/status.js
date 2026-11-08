/** `gpustack_test`: connectivity and credential self-check. */

import { defineTool } from '../tool.js'
import { S } from '../schema.js'
import { cliCommand } from '../config.js'
import { probeGateway } from '../probe.js'
import { NULLABLE_INTEGER, NULLABLE_STRING } from './schemas.js'

const AUTH_STATUS = S.string({ required: true, enum: ['ok', 'missing', 'unauthorized', 'error', 'skipped'] })

const OUTPUT_SCHEMA = S.object(
  {
    ok: S.boolean({ required: true }),
    baseUrl: S.string({ required: true }),
    reachable: S.boolean({ required: true }),
    healthz: NULLABLE_STRING,
    readyz: NULLABLE_STRING,
    version: NULLABLE_STRING,
    auth: S.object(
      {
        configured: S.boolean({ required: true }),
        source: S.string({ required: true }),
        management: S.object(
          {
            status: AUTH_STATUS,
            message: NULLABLE_STRING,
            userId: NULLABLE_INTEGER,
            username: NULLABLE_STRING,
            isAdmin: S.oneOf([S.boolean(), S.null()]),
          },
          { additionalProperties: false },
        ),
        inference: S.object(
          {
            status: AUTH_STATUS,
            message: NULLABLE_STRING,
            modelCount: NULLABLE_INTEGER,
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
    durationMs: S.integer({ required: true }),
    hint: NULLABLE_STRING,
  },
  { additionalProperties: false },
)

function emptyAuth(settings) {
  const configured = typeof settings.apiKey === 'string' && settings.apiKey.length > 0
  return {
    configured,
    source: settings.apiKeySource,
    management: { status: configured ? 'skipped' : 'missing', message: null, userId: null, username: null, isAdmin: null },
    inference: { status: configured ? 'skipped' : 'missing', message: null, modelCount: null },
  }
}

function render(value) {
  const lines = [
    `GPUStack 自检：${value.ok ? '通过' : '未通过'}`,
    `  地址: ${value.baseUrl}`,
    `  连通性: healthz=${value.healthz ?? '失败'} readyz=${value.readyz ?? '失败'} version=${value.version ?? '未知'}`,
    `  管理接口: ${value.auth.management.status}${value.auth.management.username ? `（用户 ${value.auth.management.username}${value.auth.management.isAdmin === true ? '，管理员' : ''}）` : ''}`,
    `  推理接口: ${value.auth.inference.status}${value.auth.inference.modelCount !== null ? `（${value.auth.inference.modelCount} 个模型）` : ''}`,
    `  API Key 来源: ${value.auth.source}`,
  ]
  if (value.auth.management.message !== null) lines.push(`  管理接口消息: ${value.auth.management.message}`)
  if (value.auth.inference.message !== null) lines.push(`  推理接口消息: ${value.auth.inference.message}`)
  lines.push(`  耗时: ${value.durationMs} ms`)
  if (value.hint !== null) lines.push('', value.hint)
  return [{ type: 'text', text: lines.join('\n') }]
}

/** Register the self-check tool. */
export function registerTestTool(ctx, deps) {
  ctx.tools.register(
    defineTool({
      name: 'gpustack_test',
      description:
        '检查 GPUStack 是否可达、API Key 是否有效、管理/推理两个接口面是否可用。' +
        '配置缺失、401/403、证书或网络错误时先调用它定位问题：它不会抛异常，而是分项返回健康检查、版本、身份与模型数。' +
        '管理接口失败通常是 Key 的 scope 只有 inference；推理接口失败多为 allowed_model_names 或模型访问策略限制。',
      parameters: S.object(
        {
          timeoutMs: S.integer({ description: '单项请求超时（毫秒），默认 8000。' }),
          skipInference: S.boolean({ description: '只测管理与连通性，不请求 /v1/models。' }),
        },
        { additionalProperties: false },
      ),
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => render(value),
      },
      async execute(args, exec) {
        const startedAt = Date.now()
        const settings = await deps.runtime.resolveSettings({ tolerateSecretErrors: true })

        if (settings.baseUrl.length === 0) {
          return {
            ok: false,
            baseUrl: '',
            reachable: false,
            healthz: null,
            readyz: null,
            version: null,
            auth: emptyAuth(settings),
            durationMs: Date.now() - startedAt,
            hint: `尚未配置集群地址。请打开 设置 → GPUStack 填写，或运行：${cliCommand('setup --base-url http://<host>:<port>')}`,
          }
        }

        const { client } = deps.clientFor({ settings })
        const result = await probeGateway(client, {
          timeoutMs: args.timeoutMs,
          signal: exec.signal,
          skipInference: args.skipInference === true,
        })

        return {
          ok: result.reachable && result.auth.management.status === 'ok',
          baseUrl: settings.baseUrl,
          reachable: result.reachable,
          healthz: result.healthz,
          readyz: result.readyz,
          version: result.version,
          auth: result.auth,
          durationMs: result.durationMs,
          hint: result.hint,
        }
      },
    }),
  )
}
