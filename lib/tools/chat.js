/** `gpustack_chat`: OpenAI-compatible inference check against a GPUStack model. */

import { defineTool } from '../tool.js'
import { S } from '../schema.js'
import { GpuStackError } from '../errors.js'
import { requireScope } from '../permissions.js'
import { truncateText } from './common.js'
import { NULLABLE_INTEGER, NULLABLE_STRING, USAGE_TOKENS_SCHEMA } from './schemas.js'

const MESSAGE_SCHEMA = S.object(
  {
    role: S.string({ required: true, description: 'system / user / assistant', enum: ['system', 'user', 'assistant'] }),
    content: S.string({ required: true, description: '消息文本。' }),
  },
  { additionalProperties: false },
)

const OUTPUT_SCHEMA = S.object(
  {
    model: S.string({ required: true }),
    content: S.string({ required: true }),
    reasoningContent: NULLABLE_STRING,
    finishReason: NULLABLE_STRING,
    usage: USAGE_TOKENS_SCHEMA,
    durationMs: S.integer({ required: true }),
    requestId: NULLABLE_STRING,
    hint: NULLABLE_STRING,
  },
  { additionalProperties: false },
)

function textOfContent(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part !== null && typeof part === 'object' && typeof part.text === 'string') return part.text
        return ''
      })
      .join('')
  }
  return ''
}

function usageOf(usage) {
  if (usage === null || typeof usage !== 'object') return null
  return {
    promptTokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : null,
    completionTokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : null,
    totalTokens: typeof usage.total_tokens === 'number' ? usage.total_tokens : null,
    cachedTokens:
      typeof usage.prompt_tokens_details?.cached_tokens === 'number' ? usage.prompt_tokens_details.cached_tokens : null,
  }
}

function render(value) {
  const lines = [`模型 ${value.model} 的推理结果：`]
  if (value.finishReason !== null) lines.push(`  finish_reason: ${value.finishReason}`)
  if (value.usage.totalTokens !== null) {
    lines.push(
      `  用量: prompt=${value.usage.promptTokens ?? '?'} completion=${value.usage.completionTokens ?? '?'} total=${value.usage.totalTokens}`,
    )
  }
  lines.push('', truncateText(value.content, 8_000))
  if (value.reasoningContent !== null && value.reasoningContent.length > 0) {
    lines.push('', '（推理过程）', truncateText(value.reasoningContent, 2_000))
  }
  lines.push('', `耗时: ${value.durationMs} ms`)
  if (value.hint !== null) lines.push('', value.hint)
  return [{ type: 'text', text: lines.join('\n') }]
}

/** Register the chat tool. */
export function registerChatTool(ctx, deps) {
  ctx.tools.register(
    defineTool({
      name: 'gpustack_chat',
      description:
        '用 OpenAI 兼容接口（POST /v1/chat/completions）跑一次真实推理，作为部署后的验收手段。' +
        'model 必须是 /v1/models 里的路由名（effective_name）或模型名，实例名、worker 名一律不行。' +
        '给 prompt（单轮）或 messages（多轮）；默认 maxTokens=256、非流式。' +
        '该调用受「推理调用」权限开关控制（关闭后仍可做只读运维）。' +
        '404/model not found 先查 gpustack_models 与 /v1/models；401/403 查 Key 的 scope、allowed_model_names 与模型 access_policy。',
      parameters: S.object(
        {
          model: S.string({ required: true, description: '模型名或路由名（/v1/models 返回的 id）。' }),
          prompt: S.string({ description: '单轮用户消息；与 messages 二选一。' }),
          messages: S.array(MESSAGE_SCHEMA, { description: '多轮消息数组；与 prompt 二选一。' }),
          maxTokens: S.integer({ description: '最大生成 token 数，默认 256。' }),
          temperature: S.number({ description: '采样温度，如 0.2。' }),
          topP: S.number({ description: 'top_p。' }),
          timeoutMs: S.integer({ description: '请求超时（毫秒），默认用插件配置。' }),
        },
        { additionalProperties: false },
      ),
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => render(value),
      },
      async execute(args, exec) {
        const messages =
          args.messages !== undefined
            ? args.messages.map((message) => ({ role: message.role, content: message.content }))
            : args.prompt !== undefined
              ? [{ role: 'user', content: args.prompt }]
              : null
        if (messages === null || messages.length === 0) {
          throw new GpuStackError('INVALID_ARGS', '需要 prompt 或非空 messages', {
            hint: '单轮用 {"model":"<name>","prompt":"ping"}；多轮用 messages。',
          })
        }
        const body = {
          model: args.model,
          messages,
          max_tokens: typeof args.maxTokens === 'number' ? Math.max(1, Math.floor(args.maxTokens)) : 256,
          stream: false,
        }
        if (args.temperature !== undefined) body.temperature = args.temperature
        if (args.topP !== undefined) body.top_p = args.topP

        const { settings, client } = await deps.context()
        requireScope(settings, 'inference')
        const result = await client.chat(body, { signal: exec.signal, timeoutMs: args.timeoutMs })
        const payload = result.json ?? {}

        if (payload !== null && typeof payload === 'object' && typeof payload.error === 'object' && payload.error !== null) {
          throw new GpuStackError('INFERENCE_ERROR', `推理失败：${payload.error.message ?? '未知错误'}`, {
            hint: '上游错误被原样透出；同时核对 Key 的模型授权与实例日志。',
          })
        }

        const choice = Array.isArray(payload.choices) ? payload.choices[0] : null
        const message = choice !== null && typeof choice === 'object' ? choice.message ?? {} : {}
        const content = textOfContent(message.content)
        const reasoning =
          typeof message.reasoning_content === 'string'
            ? message.reasoning_content
            : typeof message.reasoning === 'string'
              ? message.reasoning
              : null
        const usage = usageOf(payload.usage) ?? {
          promptTokens: null,
          completionTokens: null,
          totalTokens: null,
          cachedTokens: null,
        }

        deps.record('gpustack_chat', {
          api: 'inference',
          method: 'POST',
          path: '/v1/chat/completions',
          status: result.status,
          ok: true,
          durationMs: result.durationMs,
        })

        return {
          model: typeof payload.model === 'string' ? payload.model : args.model,
          content,
          reasoningContent: reasoning,
          finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : null,
          usage,
          durationMs: result.durationMs,
          requestId: result.requestId,
          hint:
            content.length === 0
              ? '返回内容为空：检查模型输出参数与实例日志；思考模型可能只产出 reasoning_content。'
              : null,
        }
      },
    }),
  )
}
