/** `gpustack_inventory`: cluster / worker / GPU snapshot. */

import { defineTool } from '../tool.js'
import { S } from '../schema.js'
import { asBoolean, asInteger, asNumber, asString, bytesToGb, formatBytes, formatTime } from './common.js'
import { CLUSTER_ROW_SCHEMA, GPU_ROW_SCHEMA, NULLABLE_INTEGER, PAGINATION_SCHEMA, WORKER_ROW_SCHEMA } from './schemas.js'

const TOTALS_SCHEMA = S.object(
  {
    clusters: NULLABLE_INTEGER,
    workers: NULLABLE_INTEGER,
    gpus: NULLABLE_INTEGER,
  },
  { additionalProperties: false },
)

const PAGINATIONS_SCHEMA = S.object(
  {
    clusters: S.oneOf([PAGINATION_SCHEMA, S.null()]),
    workers: S.oneOf([PAGINATION_SCHEMA, S.null()]),
    gpus: S.oneOf([PAGINATION_SCHEMA, S.null()]),
  },
  { additionalProperties: false },
)

const OUTPUT_SCHEMA = S.object(
  {
    kind: S.string({ required: true, enum: ['all', 'clusters', 'workers', 'gpus'] }),
    clusters: S.array(CLUSTER_ROW_SCHEMA, { required: true }),
    workers: S.array(WORKER_ROW_SCHEMA, { required: true }),
    gpus: S.array(GPU_ROW_SCHEMA, { required: true }),
    totals: TOTALS_SCHEMA,
    pagination: PAGINATIONS_SCHEMA,
    hint: S.oneOf([S.string(), S.null()]),
  },
  { additionalProperties: false },
)

function clusterRow(cluster) {
  return {
    id: asInteger(cluster.id) ?? 0,
    name: asString(cluster.name) ?? '(未命名)',
    provider: asString(cluster.provider),
    state: asString(cluster.state),
    isDefault: asBoolean(cluster.is_default),
    workers: asInteger(cluster.workers),
    readyWorkers: asInteger(cluster.ready_workers),
    gpus: asInteger(cluster.gpus),
    models: asInteger(cluster.models),
    gatewayEndpoint: asString(cluster.gateway_endpoint) ?? asString(cluster.reported_gateway_endpoint),
  }
}

function labelsOf(worker) {
  if (worker.labels === null || typeof worker.labels !== 'object' || Array.isArray(worker.labels)) return []
  return Object.entries(worker.labels).map(([key, value]) => `${key}=${String(value)}`)
}

function workerRow(worker) {
  const status = worker.status !== null && typeof worker.status === 'object' ? worker.status : {}
  const gpuDevices = Array.isArray(status.gpu_devices) ? status.gpu_devices : null
  const maintenance =
    worker.maintenance !== null && typeof worker.maintenance === 'object'
      ? asBoolean(worker.maintenance.enabled)
      : asBoolean(worker.maintenance)
  return {
    id: asInteger(worker.id) ?? 0,
    name: asString(worker.name) ?? '(未命名)',
    state: asString(worker.state),
    ip: asString(worker.ip) ?? asString(worker.advertise_address),
    port: asInteger(worker.port),
    clusterId: asInteger(worker.cluster_id),
    heartbeatTime: formatTime(worker.heartbeat_time),
    unreachable: asBoolean(worker.unreachable),
    maintenance,
    gpuCount: gpuDevices === null ? null : gpuDevices.length,
    labels: labelsOf(worker),
  }
}

function gpuRow(device) {
  const memoryObject = device.memory !== null && typeof device.memory === 'object' ? device.memory : null
  const total = memoryObject === null ? asNumber(device.memory) : asNumber(memoryObject.total)
  const used = memoryObject === null ? null : asNumber(memoryObject.used)
  return {
    id: asString(device.id),
    uuid: asString(device.uuid),
    workerId: asInteger(device.worker_id),
    workerName: asString(device.worker_name),
    clusterId: asInteger(device.cluster_id),
    vendor: asString(device.vendor),
    type: asString(device.type),
    archFamily: asString(device.arch_family),
    index: asInteger(device.index) ?? asInteger(device.device_index),
    name: asString(device.name),
    memoryBytes: total,
    memoryGb: bytesToGb(total),
    memoryUsedBytes: used,
    memoryUsedGb: bytesToGb(used),
    utilization: memoryObject === null ? null : asNumber(memoryObject.utilization_rate),
    driverVersion: asString(device.driver_version),
    temperature: asNumber(device.temperature),
    power: asNumber(device.power_used) ?? asNumber(device.power),
  }
}

function paginationOf(pagination) {
  if (pagination === null || typeof pagination !== 'object') return null
  return {
    page: asInteger(pagination.page),
    perPage: asInteger(pagination.perPage),
    total: asInteger(pagination.total),
    totalPage: asInteger(pagination.totalPage),
  }
}

const RENDER_LIMIT = 40

function more(lineCount, total) {
  return lineCount > RENDER_LIMIT ? [`  ... 其余 ${lineCount - RENDER_LIMIT} 条未显示（共 ${total ?? lineCount} 条，可加 clusterId/search 缩小范围）`] : []
}

function render(value) {
  const lines = []
  if (value.kind === 'all' || value.kind === 'clusters') {
    lines.push(`集群 ${value.clusters.length} 个${value.totals.clusters !== null ? `（共 ${value.totals.clusters}）` : ''}：`)
    for (const cluster of value.clusters.slice(0, RENDER_LIMIT)) {
      const defaultMark = cluster.isDefault === true ? ' 默认' : ''
      lines.push(
        `  #${cluster.id} ${cluster.name}${defaultMark} provider=${cluster.provider ?? '?'} state=${cluster.state ?? '?'} ` +
          `worker=${cluster.readyWorkers ?? '?'}/${cluster.workers ?? '?'} gpu=${cluster.gpus ?? '?'} model=${cluster.models ?? '?'}`,
      )
    }
    if (value.clusters.length === 0) lines.push('  （没有集群）')
    lines.push(...more(value.clusters.length, value.totals.clusters))
  }
  if (value.kind === 'all' || value.kind === 'workers') {
    lines.push(`Worker ${value.workers.length} 个${value.totals.workers !== null ? `（共 ${value.totals.workers}）` : ''}：`)
    for (const worker of value.workers.slice(0, RENDER_LIMIT)) {
      const flags = []
      if (worker.unreachable === true) flags.push('unreachable')
      if (worker.maintenance === true) flags.push('maintenance')
      if (worker.labels.length > 0) flags.push(`labels=${worker.labels.join(',')}`)
      lines.push(
        `  #${worker.id} ${worker.name} state=${worker.state ?? '?'} ${worker.ip ?? '?'}:${worker.port ?? '?'} ` +
          `cluster=${worker.clusterId ?? '?'} gpu=${worker.gpuCount ?? '?'} heartbeat=${worker.heartbeatTime ?? '?'}` +
          `${flags.length > 0 ? ` ${flags.join(' ')}` : ''}`,
      )
    }
    if (value.workers.length === 0) lines.push('  （没有 worker）')
    lines.push(...more(value.workers.length, value.totals.workers))
  }
  if (value.kind === 'all' || value.kind === 'gpus') {
    lines.push(`GPU ${value.gpus.length} 张${value.totals.gpus !== null ? `（共 ${value.totals.gpus}）` : ''}：`)
    for (const gpu of value.gpus.slice(0, RENDER_LIMIT)) {
      const memory =
        gpu.memoryGb !== null
          ? `${gpu.memoryUsedGb ?? 0}/${gpu.memoryGb} GB${gpu.utilization !== null ? ` ${gpu.utilization}%` : ''}`
          : gpu.memoryBytes !== null
            ? formatBytes(gpu.memoryBytes)
            : '?'
      const extra = [
        gpu.archFamily !== null && gpu.archFamily !== gpu.name ? `arch=${gpu.archFamily}` : null,
        gpu.driverVersion !== null ? `driver=${gpu.driverVersion}` : null,
        gpu.temperature !== null ? `${gpu.temperature}°C` : null,
        gpu.power !== null ? `${gpu.power}W` : null,
      ].filter(Boolean)
      lines.push(
        `  ${gpu.workerName ?? '?'} #${gpu.index ?? '?'} ${gpu.name ?? gpu.archFamily ?? gpu.type ?? '?'} vendor=${gpu.vendor ?? '?'} ` +
          `mem=${memory}${extra.length > 0 ? ` ${extra.join(' ')}` : ''}`,
      )
    }
    if (value.gpus.length === 0) lines.push('  （没有 GPU 设备上报；确认 worker 是否 ready）')
    lines.push(...more(value.gpus.length, value.totals.gpus))
  }
  if (value.hint !== null) lines.push('', value.hint)
  return [{ type: 'text', text: lines.join('\n') }]
}

/** Register the inventory tool. */
export function registerInventoryTool(ctx, deps) {
  ctx.tools.register(
    defineTool({
      name: 'gpustack_inventory',
      description:
        '盘点 GPUStack 集群、Worker 与 GPU：返回集群的就绪节点/卡数/模型数、worker 的 state/心跳/标签/维护态、GPU 的型号显存与归属。' +
        '部署前先调用它确认放置条件（哪些 worker ready、有哪些卡型、余量是否够）；GPU 的 memory 是总量，可用量要结合运行中的模型实例判断。' +
        'kind=all 一次返回三类资源；分页参数是 perPage。',
      parameters: S.object(
        {
          kind: S.string({
            description: '要盘点哪类资源：all（默认）/ clusters / workers / gpus。',
            enum: ['all', 'clusters', 'workers', 'gpus'],
          }),
          clusterId: S.integer({ description: '只看某个集群（cluster_id 过滤）。' }),
          search: S.string({ description: '按名称模糊搜索。' }),
          page: S.integer({ description: '页码，默认 1。' }),
          perPage: S.integer({ description: '每页条数，默认 100，最大 500。' }),
        },
        { additionalProperties: false },
      ),
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => render(value),
      },
      async execute(args, exec) {
        const kind = args.kind ?? 'all'
        const page = typeof args.page === 'number' && args.page > 0 ? Math.floor(args.page) : 1
        const perPage =
          typeof args.perPage === 'number' && args.perPage > 0 ? Math.min(500, Math.floor(args.perPage)) : 100
        const { client } = await deps.context()
        const result = {
          kind,
          clusters: [],
          workers: [],
          gpus: [],
          totals: { clusters: null, workers: null, gpus: null },
          pagination: { clusters: null, workers: null, gpus: null },
          hint: null,
        }

        if (kind === 'all' || kind === 'clusters') {
          const listed = await client.list(
            '/v2/clusters',
            { page, perPage, search: args.search },
            { signal: exec.signal },
          )
          result.clusters = listed.items.map(clusterRow)
          result.pagination.clusters = paginationOf(listed.pagination)
          result.totals.clusters = result.pagination.clusters?.total ?? result.clusters.length
        }
        if (kind === 'all' || kind === 'workers') {
          const listed = await client.list(
            '/v2/workers',
            { page, perPage, cluster_id: args.clusterId, search: args.search },
            { signal: exec.signal },
          )
          result.workers = listed.items.map(workerRow)
          result.pagination.workers = paginationOf(listed.pagination)
          result.totals.workers = result.pagination.workers?.total ?? result.workers.length
        }
        if (kind === 'all' || kind === 'gpus') {
          const listed = await client.list(
            '/v2/gpu-devices',
            { page, perPage, cluster_id: args.clusterId, search: args.search },
            { signal: exec.signal },
          )
          result.gpus = listed.items.map(gpuRow)
          result.pagination.gpus = paginationOf(listed.pagination)
          result.totals.gpus = result.pagination.gpus?.total ?? result.gpus.length
        }

        const truncated = [
          result.pagination.clusters !== null && result.pagination.clusters.totalPage !== null
            ? result.pagination.clusters.page < result.pagination.clusters.totalPage
            : false,
          result.pagination.workers !== null && result.pagination.workers.totalPage !== null
            ? result.pagination.workers.page < result.pagination.workers.totalPage
            : false,
          result.pagination.gpus !== null && result.pagination.gpus.totalPage !== null
            ? result.pagination.gpus.page < result.pagination.gpus.totalPage
            : false,
        ].some(Boolean)
        if (truncated) result.hint = `当前只返回第 ${page} 页（perPage=${perPage}）；还有更多数据，用 page 翻页或加 clusterId/search 缩小范围。`

        deps.record('gpustack_inventory', { api: 'management', method: 'GET', path: '/v2/clusters|workers|gpu-devices', ok: true })
        return result
      },
    }),
  )
}
