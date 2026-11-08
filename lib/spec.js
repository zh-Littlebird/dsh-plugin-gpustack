/**
 * ModelCreate / ModelUpdate request-body construction.
 *
 * Field names here mirror the OpenAPI models exactly. Values are only added
 * when the caller supplied them, so the server-side defaults stay in charge.
 */

import { GpuStackError } from './errors.js'

/** Fields accepted by `PUT /v2/models/{id}` (ModelUpdate). */
export const MODEL_UPDATE_FIELDS = [
  'source',
  'huggingface_repo_id',
  'huggingface_filename',
  'model_scope_model_id',
  'model_scope_file_path',
  'local_path',
  'name',
  'description',
  'meta',
  'replicas',
  'categories',
  'placement_strategy',
  'cpu_offloading',
  'distributed_inference_across_workers',
  'worker_selector',
  'gpu_selector',
  'gpu_type_selector',
  'backend',
  'backend_version',
  'backend_parameters',
  'image_name',
  'run_command',
  'native_anthropic_api',
  'env',
  'restart_on_error',
  'distributable',
  'extended_kv_cache',
  'speculative_config',
  'scaling_schedule',
  'generic_proxy',
  'lora_list',
  'roles',
  'disaggregation',
  'gather',
  'revision_history_limit',
  'cluster_id',
  'owner_principal_id',
  'access_policy',
]

/** Source-specific fields that must not be mixed. */
const SOURCE_FIELDS = {
  huggingface: ['huggingface_repo_id', 'huggingface_filename'],
  model_scope: ['model_scope_model_id', 'model_scope_file_path'],
  local_path: ['local_path'],
}

const SOURCE_LABELS = {
  huggingface: 'huggingface_repo_id',
  model_scope: 'model_scope_model_id',
  local_path: 'local_path',
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Build the request body from typed tool arguments.
 *
 * @param {Record<string, any>} args
 * @param {{requireSource?: boolean}} [options]
 */
export function buildModelSpec(args, options = {}) {
  const requireSource = options.requireSource === true

  if (requireSource && args.source === undefined) {
    throw new GpuStackError('INVALID_ARGS', '缺少 source（模型来源）', {
      hint: 'source 取 huggingface、model_scope 或 local_path，并配套对应来源字段。',
    })
  }
  if (args.source !== undefined && typeof args.source !== 'string') {
    throw new GpuStackError('INVALID_ARGS', 'source 必须是字符串', { hint: '取 huggingface、model_scope、local_path。' })
  }

  const spec = {}

  if (args.name !== undefined) {
    const name = String(args.name).trim()
    if (name.length === 0) throw new GpuStackError('INVALID_ARGS', 'name 不能为空')
    spec.name = name
  }
  if (args.source !== undefined) spec.source = args.source
  if (args.huggingfaceRepoId !== undefined) spec.huggingface_repo_id = args.huggingfaceRepoId
  if (args.huggingfaceFilename !== undefined) spec.huggingface_filename = args.huggingfaceFilename
  if (args.modelScopeModelId !== undefined) spec.model_scope_model_id = args.modelScopeModelId
  if (args.modelScopeFilePath !== undefined) spec.model_scope_file_path = args.modelScopeFilePath
  if (args.localPath !== undefined) spec.local_path = args.localPath
  if (args.backend !== undefined) spec.backend = args.backend
  if (args.backendVersion !== undefined) spec.backend_version = args.backendVersion
  if (args.replicas !== undefined) spec.replicas = args.replicas
  if (args.clusterId !== undefined) spec.cluster_id = args.clusterId
  if (args.placementStrategy !== undefined) spec.placement_strategy = args.placementStrategy
  if (args.workerSelector !== undefined) spec.worker_selector = args.workerSelector
  if (args.backendParameters !== undefined) {
    if (!Array.isArray(args.backendParameters) || args.backendParameters.some((entry) => typeof entry !== 'string')) {
      throw new GpuStackError('INVALID_ARGS', 'backendParameters 必须是字符串数组，每个 token 一项', {
        hint: '例如 ["--max-model-len","32768"]，不要拼成一个字符串。',
      })
    }
    spec.backend_parameters = args.backendParameters
  }
  if (args.env !== undefined) {
    if (!isPlainObject(args.env)) {
      throw new GpuStackError('INVALID_ARGS', 'env 必须是字符串键值对象', { hint: '例如 {"VLLM_USE_V1":"1"}。' })
    }
    spec.env = args.env
  }
  if (args.imageName !== undefined) spec.image_name = args.imageName
  if (args.runCommand !== undefined) spec.run_command = args.runCommand
  if (args.distributedAcrossWorkers !== undefined) {
    spec.distributed_inference_across_workers = args.distributedAcrossWorkers
  }
  if (args.cpuOffloading !== undefined) spec.cpu_offloading = args.cpuOffloading
  if (args.restartOnError !== undefined) spec.restart_on_error = args.restartOnError
  if (args.accessPolicy !== undefined) spec.access_policy = args.accessPolicy
  if (args.enableModelRoute !== undefined) spec.enable_model_route = args.enableModelRoute
  if (args.description !== undefined) spec.description = args.description
  if (args.categories !== undefined) {
    if (!Array.isArray(args.categories)) throw new GpuStackError('INVALID_ARGS', 'categories 必须是字符串数组')
    spec.categories = args.categories
  }

  const gpuSelector = {}
  if (args.gpuIds !== undefined) {
    if (!Array.isArray(args.gpuIds) || args.gpuIds.some((entry) => typeof entry !== 'string')) {
      throw new GpuStackError('INVALID_ARGS', 'gpuIds 必须是 GPU id/uuid 字符串数组', {
        hint: '先用 gpustack_inventory kind=gpus 查真实 id/uuid。',
      })
    }
    gpuSelector.gpu_ids = args.gpuIds
  }
  if (args.gpusPerReplica !== undefined) gpuSelector.gpus_per_replica = args.gpusPerReplica
  if (Object.keys(gpuSelector).length > 0) spec.gpu_selector = gpuSelector

  const gpuTypeSelector = {}
  if (args.gpuType !== undefined) gpuTypeSelector.type = args.gpuType
  if (args.slicedMemoryPercentage !== undefined) {
    gpuTypeSelector.accelerator_sliced_memory_percentage = args.slicedMemoryPercentage
  }
  if (Object.keys(gpuTypeSelector).length > 0) {
    if (spec.gpu_selector?.gpu_ids !== undefined) {
      throw new GpuStackError('INVALID_ARGS', 'gpuIds 与 gpuType 不能同时指定', {
        hint: '绑定具体卡用 gpuIds；按卡型调度用 gpuType（可加 slicedMemoryPercentage）。',
      })
    }
    spec.gpu_type_selector = gpuTypeSelector
  }

  if (args.extra !== undefined) {
    if (!isPlainObject(args.extra)) {
      throw new GpuStackError('INVALID_ARGS', 'extra 必须是对象', {
        hint: 'extra 用于 PD 分离、KV 卸载、投机解码、定时伸缩等 ModelCreate 高级字段。',
      })
    }
    for (const [key, value] of Object.entries(args.extra)) {
      if (Object.hasOwn(spec, key)) {
        throw new GpuStackError('INVALID_ARGS', `extra.${key} 与显式参数重复`, {
          hint: '同一个字段只在一个位置提供，避免两处取值冲突。',
        })
      }
      spec[key] = value
    }
  }

  // Source consistency: exactly one family, and the required member present.
  if (spec.source !== undefined) {
    const allowed = SOURCE_FIELDS[spec.source]
    if (allowed === undefined) {
      throw new GpuStackError('INVALID_ARGS', `不支持的 source：${spec.source}`, {
        hint: 'source 取 huggingface、model_scope 或 local_path。',
      })
    }
    for (const [family, fields] of Object.entries(SOURCE_FIELDS)) {
      if (family === spec.source) continue
      for (const field of fields) {
        if (spec[field] !== undefined) {
          throw new GpuStackError('INVALID_ARGS', `source=${spec.source} 不能同时携带 ${field}`, {
            hint: '来源字段互斥；先清掉另一来源的字段再提交。',
          })
        }
      }
    }
    const required = SOURCE_LABELS[spec.source]
    if (spec[required] === undefined || spec[required] === '') {
      throw new GpuStackError('INVALID_ARGS', `source=${spec.source} 需要 ${required}`, {
        hint:
          spec.source === 'local_path'
            ? 'local_path 是 worker 上的绝对路径。'
            : '请提供对应的仓库 ID（如 Qwen/Qwen3-27B）。',
      })
    }
  }

  return spec
}

/** Keep only ModelUpdate fields; used before PUT with a merged candidate. */
export function pickUpdateFields(model) {
  const spec = {}
  for (const field of MODEL_UPDATE_FIELDS) {
    if (model[field] !== undefined) spec[field] = model[field]
  }
  return spec
}

/** True when a spec change only takes effect after a restart. */
export function requiresRestart(changed) {
  const engineFields = new Set([
    'backend',
    'backend_version',
    'backend_parameters',
    'env',
    'image_name',
    'run_command',
    'disaggregation',
    'extended_kv_cache',
    'speculative_config',
    'roles',
    'gpu_selector',
    'gpu_type_selector',
  ])
  return changed.some((field) => engineFields.has(field))
}
