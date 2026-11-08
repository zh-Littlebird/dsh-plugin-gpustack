/** `gpustack_models`: list models or inspect one model with its instances. */

import { defineTool } from '../tool.js'
import { S } from '../schema.js'
import { GpuStackError } from '../errors.js'
import { instanceRow, modelLine, modelRow } from './rows.js'
import {
  INSTANCE_ROW_SCHEMA,
  MODEL_ROW_SCHEMA,
  NULLABLE_STRING,
  PAGINATION_SCHEMA,
} from './schemas.js'

const OUTPUT_SCHEMA = S.object(
  {
    mode: S.string({ required: true, enum: ['list', 'detail'] }),
    models: S.array(MODEL_ROW_SCHEMA, { required: true }),
    instances: S.array(INSTANCE_ROW_SCHEMA, { required: true }),
    total: S.oneOf([S.integer(), S.null()]),
    pagination: S.oneOf([PAGINATION_SCHEMA, S.null()]),
    hint: NULLABLE_STRING,
  },
  { additionalProperties: false },
)

function render(value) {
  const lines = []
  if (value.mode === 'list') {
    lines.push(`模型 ${value.models.length} 个${value.total !== null ? `（共 ${value.total}）` : ''}：`)
    for (const model of value.models) {
      lines.push(modelLine(model))
      if (model.stateMessage !== null) lines.push(`      ${model.stateMessage}`)
    }
    if (value.models.length === 0) lines.push('  （当前没有模型部署）')
  } else {
    const model = value.models[0]
    if (model === undefined) {
      lines.push('（没有返回模型详情）')
    } else {
      lines.push(
        `模型 #${model.id} ${model.name}`,
        `  state=${model.state ?? '?'} ready=${model.readyReplicas ?? '?'}/${model.replicas ?? '?'} cluster=${model.clusterId ?? '?'}`,
        `  来源: ${model.source ?? '?'} ${model.reference ?? ''}`.trimEnd(),
        `  后端: ${model.backend ?? '?'}${model.backendVersion ? `@${model.backendVersion}` : ''}${model.imageName ? ` image=${model.imageName}` : ''}`,
      )
      if (model.backendParameters.length > 0) lines.push(`  启动参数: ${model.backendParameters.join(' ')}`)
      if (model.stateMessage !== null) lines.push(`  state_message: ${model.stateMessage}`)
      if (model.restartingSince !== null) lines.push(`  重启中（restarting_since）: ${model.restartingSince}`)
      if (model.roleStatus !== null && typeof model.roleStatus === 'object') {
        const roles = Object.entries(model.roleStatus)
          .map(([role, status]) => `${role}${status && typeof status === 'object' ? `(desired=${status.desired ?? '?'},ready=${status.ready ?? '?'})` : ''}`)
          .join(' ')
        if (roles.length > 0) lines.push(`  角色状态: ${roles}`)
      }
      lines.push(`  实例 ${value.instances.length} 个：`)
      for (const instance of value.instances) {
        lines.push(
          `    #${instance.id} ${instance.name ?? '(未命名)'} state=${instance.state ?? '?'} worker=${instance.workerName ?? '?'} port=${instance.port ?? '?'} restart=${instance.restartCount ?? 0}${instance.role ? ` role=${instance.role}` : ''}`,
        )
        if (instance.stateMessage !== null) lines.push(`        ${instance.stateMessage}`)
      }
      if (value.instances.length === 0) lines.push('    （没有实例：可能 replicas=0，或仍在调度）')
    }
  }
  if (value.hint !== null) lines.push('', value.hint)
  return [{ type: 'text', text: lines.join('\n') }]
}

/** Register the models tool. */
export function registerModelsTool(ctx, deps) {
  ctx.tools.register(
    defineTool({
      name: 'gpustack_models',
      description:
        '列出 GPUStack 模型（state/就绪副本/后端/来源）或查看单个模型详情与实例（worker、端口、GPU、重启次数、state_message）。' +
        '响应里的 state 取值 pending|partial|running|error；判定可用看 state=running 且 ready_replicas 达标，不要只看部署请求返回 200。' +
        '注意 ?state= 查询参数是"就绪过滤"（ready|not_ready|stopped），不是模型状态字段；要按模型状态筛选用 modelState（在当前页内客户端过滤）。' +
        '传 modelId 进入详情模式并同时列实例；排障先看这里再看 gpustack_logs。',
      parameters: S.object(
        {
          modelId: S.integer({ description: '模型 id：提供后返回该模型详情与实例。' }),
          state: S.string({
            description: '服务端就绪过滤 ready|not_ready|stopped（?state= 的语义，与响应里的 state 字段不同）。',
            enum: ['ready', 'not_ready', 'stopped'],
          }),
          modelState: S.string({
            description: '按响应里的模型状态筛选（在当前返回页内客户端过滤）。',
            enum: ['pending', 'partial', 'running', 'error'],
          }),
          clusterId: S.integer({ description: '按集群过滤（仅列表模式）。' }),
          search: S.string({ description: '按模型名模糊搜索（仅列表模式）。' }),
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
        const { client } = await deps.context()

        if (args.modelId !== undefined) {
          if (!Number.isInteger(args.modelId) || args.modelId <= 0) {
            throw new GpuStackError('INVALID_ARGS', 'modelId 必须是正整数', { hint: '先用列表模式拿真实 id。' })
          }
          const detail = await client.get(`/v2/models/${args.modelId}`, {}, { signal: exec.signal })
          const model = detail.body
          if (model === null || typeof model !== 'object' || Array.isArray(model)) {
            throw new GpuStackError('UNEXPECTED_RESPONSE', `模型 ${args.modelId} 的详情不是对象`, {
              hint: '确认 id 属于当前组织；可用 gpustack_models 重新列出。',
            })
          }
          const listed = await client.list(
            `/v2/models/${args.modelId}/instances`,
            { perPage: 100 },
            { signal: exec.signal },
          )
          deps.record('gpustack_models', { api: 'management', method: 'GET', path: `/v2/models/${args.modelId}`, ok: true })
          return {
            mode: 'detail',
            models: [modelRow(model)],
            instances: listed.items.map(instanceRow),
            total: null,
            pagination: null,
            hint:
              model.state === 'running'
                ? null
                : '模型未处于 running：看实例的 state 与 state_message，再用 gpustack_logs 拉日志；需要重新拉起可 gpustack_model_action restart。',
          }
        }

        const page = typeof args.page === 'number' && args.page > 0 ? Math.floor(args.page) : 1
        const perPage =
          typeof args.perPage === 'number' && args.perPage > 0 ? Math.min(500, Math.floor(args.perPage)) : 100
        const listed = await client.list(
          '/v2/models',
          {
            state: args.state,
            cluster_id: args.clusterId,
            search: args.search,
            page,
            perPage,
          },
          { signal: exec.signal },
        )
        let items = listed.items
        let hint = null
        if (args.modelState !== undefined) {
          const before = items.length
          items = items.filter((entry) => entry.state === args.modelState)
          hint = `modelState=${args.modelState} 是在当前返回页（${items.length}/${before} 条）内做的客户端过滤；跨页统计请去掉它或加大 perPage。`
        }
        const pagination = listed.pagination
        deps.record('gpustack_models', { api: 'management', method: 'GET', path: '/v2/models', ok: true })
        return {
          mode: 'list',
          models: items.map(modelRow),
          instances: [],
          total:
            args.modelState !== undefined
              ? items.length
              : typeof pagination?.total === 'number'
                ? pagination.total
                : items.length,
          pagination:
            pagination === null
              ? null
              : {
                  page: typeof pagination.page === 'number' ? pagination.page : null,
                  perPage: typeof pagination.perPage === 'number' ? pagination.perPage : null,
                  total: typeof pagination.total === 'number' ? pagination.total : null,
                  totalPage: typeof pagination.totalPage === 'number' ? pagination.totalPage : null,
                },
          hint,
        }
      },
    }),
  )
}
