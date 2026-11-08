/** `gpustack_deploy_model`: create a model deployment from the ModelCreate spec. */

import { defineTool } from '../tool.js'
import { S } from '../schema.js'
import { GpuStackError } from '../errors.js'
import { buildModelSpec } from '../spec.js'
import { requireScope } from '../permissions.js'
import { waitForModel } from '../wait.js'
import { modelRow } from './rows.js'
import { MODEL_ROW_SCHEMA, NULLABLE_INTEGER, NULLABLE_STRING } from './schemas.js'

const OUTPUT_SCHEMA = S.object(
  {
    ok: S.boolean({ required: true }),
    modelId: NULLABLE_INTEGER,
    name: S.string({ required: true }),
    state: NULLABLE_STRING,
    readyReplicas: NULLABLE_INTEGER,
    replicas: NULLABLE_INTEGER,
    clusterId: NULLABLE_INTEGER,
    waited: S.boolean({ required: true }),
    waitTimedOut: S.boolean({ required: true }),
    waitState: NULLABLE_STRING,
    elapsedMs: S.integer({ required: true }),
    model: S.oneOf([MODEL_ROW_SCHEMA, S.null()]),
    hint: NULLABLE_STRING,
  },
  { additionalProperties: false },
)

function render(value) {
  const lines = [
    `已提交部署：${value.name}${value.modelId !== null ? `（#${value.modelId}）` : ''}`,
    `  当前状态: ${value.state ?? '未知'} ready=${value.readyReplicas ?? '?'}/${value.replicas ?? '?'} cluster=${value.clusterId ?? '?'}`,
  ]
  if (value.waited) {
    lines.push(
      `  已等待 ${value.elapsedMs} ms：state=${value.waitState ?? '未知'}${value.waitTimedOut ? '（超时，未到 running/error）' : ''}`,
    )
  }
  if (value.hint !== null) lines.push('', value.hint)
  return [{ type: 'text', text: lines.join('\n') }]
}

function requireWrites(settings) {
  requireScope(settings, 'deploy')
}

/** Register the deployment tool. */
export function registerDeployTool(ctx, deps) {
  ctx.tools.register(
    defineTool({
      name: 'gpustack_deploy_model',
      description:
        '在 GPUStack 上创建模型部署（POST /v2/models，必填 name 与 source）。' +
        'source=huggingface 配 huggingfaceRepoId；model_scope 配 modelScopeModelId；local_path 配 localPath。' +
        '常用放置字段：backend、backendVersion、replicas、clusterId、placementStrategy、gpuType/gpusPerReplica 或 gpuIds、workerSelector。' +
        'backendParameters 必须逐 token 传数组（如 ["--max-model-len","32768"]）。' +
        'PD 分离、KV 缓存卸载、投机解码、定时伸缩等高级字段放 extra（字段名同 ModelCreate）。' +
        '创建成功只代表规格已入库：默认 wait=false，请随后用 gpustack_wait_model 或 gpustack_models 确认 state=running，再用 gpustack_chat 验收推理。',
      parameters: S.object(
        {
          name: S.string({ required: true, description: '模型名（也是 /v1 推理的 model 取值之一）。' }),
          source: S.string({
            required: true,
            description: '模型来源：huggingface / model_scope / local_path。',
            enum: ['huggingface', 'model_scope', 'local_path'],
          }),
          huggingfaceRepoId: S.string({ description: 'Hugging Face 仓库 ID，如 Qwen/Qwen3-27B。' }),
          huggingfaceFilename: S.string({ description: 'Hugging Face 单文件/GGUF 文件名（可选）。' }),
          modelScopeModelId: S.string({ description: 'ModelScope 模型 ID。' }),
          modelScopeFilePath: S.string({ description: 'ModelScope 单文件路径（可选）。' }),
          localPath: S.string({ description: 'worker 上的模型绝对路径（source=local_path 时必填）。' }),
          backend: S.string({ description: '推理后端，如 vllm、sglang、mindie、llama-box；合法值查 /v2/inference-backends/list。' }),
          backendVersion: S.string({ description: '后端版本；取 inference-backends 的 version_configs 键。' }),
          replicas: S.integer({ description: '副本数；0 表示先建不跑。' }),
          clusterId: S.integer({ description: '集群 id；不传用默认集群。' }),
          placementStrategy: S.string({ description: '放置策略 spread（默认）或 binpack。', enum: ['spread', 'binpack'] }),
          gpuType: S.string({ description: '按卡型选择，如 "Ascend 910B"、"NVIDIA-A100-80GB"；与 gpuIds 二选一。' }),
          gpusPerReplica: S.integer({ description: '每副本卡数。' }),
          gpuIds: S.array(S.string(), { description: '绑定具体 GPU 的 id/uuid 列表；与 gpuType 二选一。' }),
          slicedMemoryPercentage: S.integer({ description: '按卡型切片时的显存百分比（0-100）。' }),
          workerSelector: S.any({ description: '按 worker 标签选节点，如 {"gpu-vendor":"ascend"}。' }),
          backendParameters: S.array(S.string(), {
            description: '后端启动参数，逐 token，如 ["--max-model-len","32768","--gpu-memory-utilization","0.9"]。',
          }),
          env: S.any({ description: '容器环境变量对象，如 {"VLLM_USE_V1":"1"}。' }),
          imageName: S.string({ description: '覆盖默认镜像。' }),
          runCommand: S.string({ description: '覆盖启动命令（自定义后端，支持 {{port}}/{{model_path}}）。' }),
          distributedAcrossWorkers: S.boolean({ description: '是否允许跨 worker 分布式推理（vLLM/SGLang/MindIE 缺省 true）。' }),
          cpuOffloading: S.boolean({ description: 'CPU offload（GGUF 或显存不足时）。' }),
          accessPolicy: S.string({
            description: '模型访问策略。',
            enum: ['public', 'authed', 'allowed_principals'],
          }),
          enableModelRoute: S.boolean({ description: '是否同时建立对外模型路由。' }),
          restartOnError: S.boolean({ description: '实例异常时自动重启，默认 true。' }),
          description: S.string({ description: '备注。' }),
          categories: S.array(S.string(), { description: '分类标签。' }),
          extra: S.any({
            description: 'ModelCreate 的其余字段原样合并，如 disaggregation、extended_kv_cache、speculative_config、scaling_schedule、lora_list、revision_history_limit。',
          }),
          wait: S.boolean({ description: '是否等待到 running/error（默认 false）。' }),
          waitTimeoutSec: S.integer({ description: 'wait=true 时的等待上限（秒），默认 300，最大 3600。' }),
        },
        { additionalProperties: false },
      ),
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => render(value),
      },
      async execute(args, exec) {
        const { settings, client } = await deps.context()
        requireWrites(settings)

        const spec = buildModelSpec(args, { requireSource: true })
        const startedAt = Date.now()
        const created = await client.request({
          method: 'POST',
          path: '/v2/models',
          body: spec,
          signal: exec.signal,
        })
        const model = created.json
        if (model === null || typeof model !== 'object' || Array.isArray(model)) {
          throw new GpuStackError('UNEXPECTED_RESPONSE', '创建模型没有返回模型对象', {
            hint: '请用 gpustack_models 确认是否已创建，避免重复提交。',
          })
        }
        const modelId = typeof model.id === 'number' ? model.id : null
        deps.record('gpustack_deploy_model', {
          api: 'management',
          method: 'POST',
          path: '/v2/models',
          status: created.status,
          ok: true,
          durationMs: created.durationMs,
        })

        const value = {
          ok: true,
          modelId,
          name: typeof model.name === 'string' ? model.name : spec.name,
          state: typeof model.state === 'string' ? model.state : null,
          readyReplicas: typeof model.ready_replicas === 'number' ? model.ready_replicas : null,
          replicas: typeof model.replicas === 'number' ? model.replicas : null,
          clusterId: typeof model.cluster_id === 'number' ? model.cluster_id : null,
          waited: false,
          waitTimedOut: false,
          waitState: null,
          elapsedMs: Date.now() - startedAt,
          model: modelRow(model),
          hint: null,
        }

        if (args.wait === true && modelId !== null) {
          const timeoutSec = typeof args.waitTimeoutSec === 'number' ? Math.min(3600, Math.max(5, args.waitTimeoutSec)) : 300
          const waited = await waitForModel(client, modelId, {
            signal: exec.signal,
            timeoutMs: timeoutSec * 1000,
            intervalMs: 5_000,
          })
          value.waited = true
          value.waitTimedOut = waited.timedOut
          value.waitState = waited.state
          value.state = waited.state
          value.readyReplicas = waited.readyReplicas
          value.replicas = waited.replicas
          value.elapsedMs = Date.now() - startedAt
          value.hint = waited.timedOut
            ? `等待超时（${timeoutSec}s）仍未到 running/error：继续用 gpustack_wait_model 观察，或 gpustack_logs 看实例日志。`
            : waited.state === 'error'
              ? `部署进入 error：用 gpustack_models modelId=${modelId} 看 state_message，再用 gpustack_logs 拉实例日志定位。`
              : null
        } else {
          value.hint = `部署已提交（id=${modelId ?? '未知'}）。请用 gpustack_wait_model 等到 state=running，或用 gpustack_models modelId=${modelId ?? '?'} 查看进度；不要在未就绪时报告成功。`
        }

        return value
      },
    }),
  )
}
