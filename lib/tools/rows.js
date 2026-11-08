/** Row mappers shared by model, deploy, wait, and action tools. */

import { asInteger, asString, formatTime } from './common.js'

/** Empty strings are treated as absent so renders do not print blank lines. */
function textOrNull(value) {
  const text = asString(value)
  return text === null || text.length === 0 ? null : text
}

/** Human-readable model source reference from the mutually exclusive fields. */
export function referenceOf(model) {
  const source = asString(model.source)
  if (source === 'huggingface') {
    const repo = asString(model.huggingface_repo_id)
    const file = asString(model.huggingface_filename)
    return repo === null ? null : file === null ? repo : `${repo}（${file}）`
  }
  if (source === 'model_scope') {
    const repo = asString(model.model_scope_model_id)
    const file = asString(model.model_scope_file_path)
    return repo === null ? null : file === null ? repo : `${repo}（${file}）`
  }
  if (source === 'local_path') return asString(model.local_path)
  return null
}

export function stringList(value) {
  if (!Array.isArray(value)) return []
  return value.map((entry) => (typeof entry === 'string' ? entry : String(entry)))
}

/** Public model summary used by list and detail results. */
export function modelRow(model) {
  return {
    id: asInteger(model.id) ?? 0,
    name: asString(model.name) ?? '(未命名)',
    state: asString(model.state),
    readyReplicas: asInteger(model.ready_replicas),
    replicas: asInteger(model.replicas),
    clusterId: asInteger(model.cluster_id),
    backend: asString(model.backend),
    backendVersion: asString(model.backend_version),
    source: asString(model.source),
    reference: referenceOf(model),
    stateMessage: textOrNull(model.state_message),
    restartingSince: formatTime(model.restarting_since),
    roleStatus: model.role_status ?? null,
    createdAt: formatTime(model.created_at),
    backendParameters: stringList(model.backend_parameters),
    imageName: textOrNull(model.image_name),
  }
}

/** Public instance summary. */
export function instanceRow(instance) {
  return {
    id: asInteger(instance.id) ?? 0,
    name: asString(instance.name),
    state: asString(instance.state),
    stateMessage: textOrNull(instance.state_message),
    workerId: asInteger(instance.worker_id),
    workerName: asString(instance.worker_name),
    port: asInteger(instance.port),
    restartCount: asInteger(instance.restart_count),
    role: asString(instance.role),
    gpuIndexes: Array.isArray(instance.gpu_indexes) ? instance.gpu_indexes : [],
  }
}

/** Render one model line without the field details. */
export function modelLine(model) {
  const replicas =
    model.readyReplicas !== null || model.replicas !== null
      ? ` ${model.readyReplicas ?? '?'}/${model.replicas ?? '?'}`
      : ''
  return `  #${model.id} ${model.name} state=${model.state ?? '?'}${replicas} backend=${model.backend ?? '?'}${model.backendVersion ? `@${model.backendVersion}` : ''} cluster=${model.clusterId ?? '?'}`
}
