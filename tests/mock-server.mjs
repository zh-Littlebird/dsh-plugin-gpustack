/** Minimal GPUStack v2 mock used by the integration tests. */

import { createServer } from 'node:http'

export const MOCK_API_KEY = 'gpustack_test_key_abcdef1234567890'

function send(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

function sendText(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(text)
}

const MODEL = {
  id: 12,
  name: 'qwen3-demo',
  source: 'huggingface',
  huggingface_repo_id: 'Qwen/Qwen3-27B',
  backend: 'vllm',
  backend_version: '0.10.2',
  backend_parameters: ['--max-model-len', '32768'],
  env: { VLLM_USE_V1: '1' },
  image_name: null,
  replicas: 1,
  ready_replicas: 1,
  cluster_id: 1,
  state: 'running',
  state_message: null,
  access_policy: 'authed',
  created_at: '2026-11-01T10:00:00Z',
  updated_at: '2026-11-01T10:05:00Z',
}

const INSTANCE = {
  id: 34,
  name: 'qwen3-demo-abc12',
  model_id: 12,
  model_name: 'qwen3-demo',
  worker_id: 2,
  worker_name: 'worker-a',
  port: 41000,
  state: 'running',
  state_message: null,
  restart_count: 0,
  gpu_indexes: [0],
  cluster_id: 1,
}

const CLUSTER = {
  id: 1,
  name: 'default',
  provider: 'Docker',
  state: 'ready',
  is_default: true,
  workers: 2,
  ready_workers: 2,
  gpus: 2,
  models: 1,
  gateway_endpoint: 'http://192.0.2.10:31901',
}

const WORKERS = [
  {
    id: 2,
    name: 'worker-a',
    state: 'ready',
    ip: '192.0.2.150',
    port: 10150,
    cluster_id: 1,
    heartbeat_time: '2026-11-06T02:40:00Z',
    unreachable: false,
    maintenance: { enabled: false },
    labels: { 'gpu-vendor': 'nvidia' },
    status: { gpu_devices: [{ id: 'gpu-1' }, { id: 'gpu-2' }] },
  },
  {
    id: 3,
    name: 'worker-b',
    state: 'ready',
    ip: '192.0.2.151',
    port: 10150,
    cluster_id: 1,
    heartbeat_time: '2026-11-06T02:41:00Z',
    unreachable: false,
    maintenance: { enabled: true, message: 'upgrade' },
    labels: {},
    status: { gpu_devices: [] },
  },
]

const GPUS = [
  {
    id: 'gpu-1',
    uuid: 'GPU-0001',
    worker_id: 2,
    worker_name: 'worker-a',
    cluster_id: 1,
    vendor: 'NVIDIA',
    type: 'cuda',
    arch_family: 'NVIDIA-A100-80GB',
    index: 0,
    name: 'A100-80GB',
    memory: { total: 68719476736, used: 8589934592, utilization_rate: 12.5, is_unified_memory: false },
    driver_version: '24.1.0',
    temperature: 45,
    power_used: 120,
  },
  {
    id: 'gpu-2',
    uuid: 'GPU-0002',
    worker_id: 2,
    worker_name: 'worker-a',
    cluster_id: 1,
    vendor: 'NVIDIA',
    type: 'cuda',
    arch_family: 'NVIDIA-A100-80GB',
    index: 1,
    name: 'A100-80GB',
    memory: { total: 68719476736, used: 0, utilization_rate: 0 },
    driver_version: '24.1.0',
    temperature: 44,
    power_used: 118,
  },
]

function pagination(total, page = 1, perPage = 100) {
  return { page, perPage, total, totalPage: Math.max(1, Math.ceil(total / perPage)) }
}

/** Start a loopback server; call `close()` in a test teardown. */
export async function startMock() {
  const requests = []
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    let raw = ''
    for await (const chunk of req) raw += chunk
    let body = null
    if (raw.trim().length > 0) {
      try {
        body = JSON.parse(raw)
      } catch {
        body = raw
      }
    }
    const path = url.pathname
    requests.push({ method: req.method, path, query: Object.fromEntries(url.searchParams), body, headers: req.headers })

    if (path === '/healthz' || path === '/readyz') {
      send(res, 200, 'ok')
      return
    }
    if (path === '/version') {
      send(res, 200, { version: 'v2.3.0', git_commit: 'mock' })
      return
    }
    if (path === '/auth/config') {
      send(res, 200, { external_auth: null, is_oidc: false, is_saml: false })
      return
    }

    const authorized = req.headers['x-api-key'] === MOCK_API_KEY
    if ((path.startsWith('/v2/') || path.startsWith('/v1') || path === '/v2') && !authorized) {
      send(res, 401, { code: 401, reason: 'Unauthorized', message: 'Invalid authentication credentials' })
      return
    }

    if (path === '/v2/users/me') {
      send(res, 200, { id: 1, username: 'admin', is_admin: true, is_active: true, source: 'local' })
      return
    }
    if (path === '/v2/clusters') {
      send(res, 200, { items: [CLUSTER], pagination: pagination(1) })
      return
    }
    if (path === '/v2/workers') {
      send(res, 200, { items: WORKERS, pagination: pagination(WORKERS.length) })
      return
    }
    if (path === '/v2/gpu-devices') {
      send(res, 200, { items: GPUS, pagination: pagination(GPUS.length) })
      return
    }
    if (path === '/v2/models' && req.method === 'GET') {
      const state = url.searchParams.get('state')
      if (state !== null && !['ready', 'not_ready', 'stopped'].includes(state)) {
        send(res, 422, {
          code: 422,
          reason: 'Unprocessable Entity',
          message: `state: Input should be 'ready', 'not_ready' or 'stopped'`,
          details: null,
        })
        return
      }
      send(res, 200, { items: [MODEL], pagination: pagination(1) })
      return
    }
    if (path === '/v2/models' && req.method === 'POST') {
      if (typeof body?.name !== 'string' || typeof body?.source !== 'string') {
        send(res, 422, {
          code: 422,
          reason: 'Unprocessable Entity',
          message: 'name and source are required',
          details: { name: 'required', source: 'required' },
        })
        return
      }
      send(res, 200, {
        ...MODEL,
        id: 13,
        name: body.name,
        source: body.source,
        huggingface_repo_id: body.huggingface_repo_id ?? null,
        backend: body.backend ?? 'vllm',
        state: 'pending',
        ready_replicas: 0,
        replicas: body.replicas ?? 1,
        cluster_id: body.cluster_id ?? 1,
        backend_parameters: body.backend_parameters ?? [],
      })
      return
    }
    if (path === '/v2/models/12' && req.method === 'GET') {
      send(res, 200, MODEL)
      return
    }
    if (path === '/v2/models/12' && req.method === 'PUT') {
      send(res, 200, { ...MODEL, ...body, id: 12 })
      return
    }
    if (path === '/v2/models/12' && req.method === 'DELETE') {
      send(res, 200, {})
      return
    }
    if (path === '/v2/models/12/instances') {
      send(res, 200, { items: [INSTANCE], pagination: pagination(1) })
      return
    }
    if (path === '/v2/models/12/restart') {
      send(res, 200, { spec_digest: 'digest-1', restarted: true, deleted_instances: [34], message: 'restart triggered' })
      return
    }
    if (path === '/v2/models/12/rollback' || path === '/v2/models/12/rollback-preview') {
      send(res, 200, { id: 12, state: 'pending', spec: { replicas: 1 }, target_revision: body?.target_revision ?? null })
      return
    }
    if (path === '/v2/models/99') {
      send(res, 404, { code: 404, reason: 'Not Found', message: 'model not found' })
      return
    }
    if (path === '/v2/model-instances/34') {
      send(res, 200, INSTANCE)
      return
    }
    if (path === '/v2/model-instances/34/logs') {
      sendText(res, 200, 'INFO starting vllm 0.10.2\nINFO listening on 41000\nINFO health check ok\n')
      return
    }
    if (path === '/v2/usage/summary') {
      send(res, 200, {
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
        token_active_users: 2,
        gpu_hours: 0,
      })
      return
    }
    if (path === '/v2/usage/meta') {
      send(res, 200, {
        metrics: [
          { key: 'input_tokens', label: 'Input Tokens' },
          { key: 'total_tokens', label: 'Total Tokens' },
        ],
        granularities: [
          { key: 'day', label: 'Day' },
          { key: 'hour', label: 'Hour' },
        ],
        group_bys: [
          { key: 'route', label: 'Route' },
          { key: 'date', label: 'Date' },
          { key: 'user', label: 'User' },
        ],
        filters: { users: [], api_keys: [], routes: [], organizations: [] },
      })
      return
    }
    if (path === '/v2/usage/breakdown') {
      send(res, 200, {
        summary: {
          input_tokens: 100,
          output_tokens: 50,
          input_cached_tokens: 10,
          total_tokens: 150,
          api_requests: 3,
          models_called: 1,
        },
        group_by: body?.group_by ?? ['route'],
        granularity: body?.granularity ?? 'day',
        items: [
          {
            route: { identity: { value: { route_name: 'qwen3-demo' } }, label: 'qwen3-demo', deleted: false },
            input_tokens: 100,
            output_tokens: 50,
            input_cached_tokens: 10,
            total_tokens: 150,
            api_requests: 3,
            models_called: 1,
            last_active: '2026-11-06',
          },
        ],
        pagination: pagination(1, body?.page ?? 1, body?.perPage ?? 20),
      })
      return
    }
    if (path === '/v2/api-keys' && req.method === 'GET') {
      send(res, 200, {
        items: [
          { id: 5, name: 'ci', scope: ['management'], masked_value: 'gpustack_****abcd', value: undefined },
        ],
        pagination: pagination(1),
      })
      return
    }
    if (path === '/v1/models') {
      send(res, 200, { object: 'list', data: [{ id: 'qwen3-demo', object: 'model', owned_by: 'gpustack' }] })
      return
    }
    if (path === '/v1/chat/completions' && req.method === 'POST') {
      send(res, 200, {
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        model: body?.model ?? 'unknown',
        choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      })
      return
    }

    send(res, 404, { code: 404, reason: 'Not Found', message: `not found: ${path}` })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    async close() {
      await new Promise((resolve) => server.close(resolve))
    },
  }
}
