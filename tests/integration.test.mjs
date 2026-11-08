/** Integration tests against a loopback GPUStack mock. */

import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MOCK_API_KEY, startMock } from './mock-server.mjs'
import { mountPlugin, call, render, expectCode } from './helpers.mjs'
import { SiteStore } from '../lib/site.js'

process.env.GPUSTACK_TEST_KEY = MOCK_API_KEY
process.env.GPUSTACK_TEST_BAD_KEY = 'gpustack_wrong_key_000000000000'

const mock = await startMock()
const dataDir = join(tmpdir(), `dsh-gpustack-test-${process.pid}-${Date.now()}`)
const { tools } = mountPlugin({
  baseUrl: mock.baseUrl,
  apiKeyEnv: 'GPUSTACK_TEST_KEY',
  secretsBackend: 'env',
  dataDir,
  audit: false,
})
const bad = mountPlugin({
  baseUrl: mock.baseUrl,
  apiKeyEnv: 'GPUSTACK_TEST_BAD_KEY',
  secretsBackend: 'env',
  dataDir: `${dataDir}-bad`,
  audit: false,
})

// A second mount whose settings page has closed deploy/delete/inference.
const restrictedDir = join(tmpdir(), `dsh-gpustack-restricted-${process.pid}-${Date.now()}`)
const restrictedSite = new SiteStore({ dir: restrictedDir })
await restrictedSite.write({
  baseUrl: mock.baseUrl,
  permissions: { deploy: false, delete: false, inference: false },
})
const restricted = mountPlugin({
  baseUrl: '',
  apiKeyEnv: 'GPUSTACK_TEST_KEY',
  secretsBackend: 'env',
  dataDir: restrictedDir,
  audit: false,
})

try {
  // --- connectivity self-check ----------------------------------------------
  const test = await call(tools, 'gpustack_test', {})
  assert.equal(test.ok, true, JSON.stringify(test))
  assert.equal(test.version, 'v2.3.0')
  assert.equal(test.auth.management.status, 'ok')
  assert.equal(test.auth.management.username, 'admin')
  assert.equal(test.auth.inference.status, 'ok')
  assert.equal(test.auth.inference.modelCount, 1)
  const testText = render(tools, 'gpustack_test', {}, test)
  assert.match(testText, /通过/)

  // --- inventory -------------------------------------------------------------
  const inventory = await call(tools, 'gpustack_inventory', {})
  assert.equal(inventory.clusters.length, 1)
  assert.equal(inventory.workers.length, 2)
  assert.equal(inventory.gpus.length, 2)
  assert.equal(inventory.workers[0].gpuCount, 2)
  assert.equal(inventory.workers[1].maintenance, true)
  assert.equal(inventory.gpus[0].memoryGb, 64)
  assert.equal(inventory.gpus[0].memoryUsedGb, 8)
  assert.equal(inventory.gpus[0].utilization, 12.5)
  assert.equal(inventory.gpus[0].name, 'A100-80GB')
  assert.match(render(tools, 'gpustack_inventory', {}, inventory), /A100-80GB/)

  // --- models: list and detail ----------------------------------------------
  const list = await call(tools, 'gpustack_models', {})
  assert.equal(list.mode, 'list')
  assert.equal(list.models.length, 1)
  assert.equal(list.models[0].state, 'running')
  assert.equal(list.models[0].reference, 'Qwen/Qwen3-27B')
  assert.equal(list.total, 1)
  assert.match(render(tools, 'gpustack_models', {}, list), /qwen3-demo/)

  const detail = await call(tools, 'gpustack_models', { modelId: 12 })
  assert.equal(detail.mode, 'detail')
  assert.equal(detail.instances.length, 1)
  assert.equal(detail.instances[0].id, 34)
  assert.equal(detail.instances[0].workerName, 'worker-a')
  assert.match(render(tools, 'gpustack_models', {}, detail), /实例 1 个/)

  // `state` is the readiness filter; `running` must be rejected as an argument
  // instead of being sent to the server, and modelState filters client-side.
  await expectCode(call(tools, 'gpustack_models', { state: 'running' }), 'INVALID_ARGS')
  const ready = await call(tools, 'gpustack_models', { state: 'ready' })
  assert.equal(ready.models.length, 1)
  const filtered = await call(tools, 'gpustack_models', { modelState: 'pending' })
  assert.equal(filtered.models.length, 0)
  assert.match(filtered.hint ?? '', /客户端过滤/)

  // --- deploy ---------------------------------------------------------------
  const deployed = await call(tools, 'gpustack_deploy_model', {
    name: 'qwen3-new',
    source: 'huggingface',
    huggingfaceRepoId: 'Qwen/Qwen3-27B',
    backend: 'vllm',
    replicas: 2,
    backendParameters: ['--max-model-len', '32768'],
    env: { VLLM_USE_V1: '1' },
  })
  assert.equal(deployed.modelId, 13)
  assert.equal(deployed.state, 'pending')
  assert.equal(deployed.waited, false)
  assert.notEqual(deployed.hint, null)
  const createRequest = mock.requests.filter((entry) => entry.method === 'POST' && entry.path === '/v2/models').at(-1)
  assert.equal(createRequest.body.huggingface_repo_id, 'Qwen/Qwen3-27B')
  assert.deepEqual(createRequest.body.backend_parameters, ['--max-model-len', '32768'])
  assert.deepEqual(createRequest.body.env, { VLLM_USE_V1: '1' })
  assert.equal(createRequest.body.replicas, 2)

  await expectCode(
    call(tools, 'gpustack_deploy_model', { name: 'bad', source: 'huggingface' }),
    'INVALID_ARGS',
  )

  // --- update: merge env, report changes ------------------------------------
  const updated = await call(tools, 'gpustack_update_model', {
    modelId: 12,
    replicas: 2,
    env: { NEW_FLAG: '1' },
  })
  assert.deepEqual(new Set(updated.changed), new Set(['replicas', 'env']))
  assert.equal(updated.restarted, false)
  const putRequest = mock.requests.filter((entry) => entry.method === 'PUT' && entry.path === '/v2/models/12').at(-1)
  assert.equal(putRequest.body.replicas, 2)
  assert.deepEqual(putRequest.body.env, { VLLM_USE_V1: '1', NEW_FLAG: '1' })
  assert.equal(putRequest.body.name, 'qwen3-demo')
  assert.equal(putRequest.body.source, 'huggingface')

  const engineChange = await call(tools, 'gpustack_update_model', {
    modelId: 12,
    backendParameters: ['--max-model-len', '16384'],
  })
  assert.ok(engineChange.changed.includes('backend_parameters'))
  assert.match(engineChange.hint ?? '', /restart/)

  // --- restart / rollback / delete ------------------------------------------
  const restarted = await call(tools, 'gpustack_model_action', { modelId: 12, action: 'restart' })
  assert.equal(restarted.restarted, true)
  assert.deepEqual(restarted.deletedInstances, [34])
  assert.match(render(tools, 'gpustack_model_action', {}, restarted), /整组重建/)

  const preview = await call(tools, 'gpustack_model_action', {
    modelId: 12,
    action: 'preview-rollback',
    revision: 3,
  })
  assert.equal(preview.detail.target_revision, 3)
  assert.equal(preview.state, 'running')

  await expectCode(call(tools, 'gpustack_model_action', { modelId: 12, action: 'delete' }), 'CONFIRM_REQUIRED')
  const deleted = await call(tools, 'gpustack_model_action', { modelId: 12, action: 'delete', confirm: true })
  assert.equal(deleted.message, '模型已删除')

  // --- logs -----------------------------------------------------------------
  const logs = await call(tools, 'gpustack_logs', { modelId: 12, tail: 100 })
  assert.equal(logs.instanceId, 34)
  assert.equal(logs.modelName, 'qwen3-demo')
  assert.match(logs.text, /vllm 0\.10\.2/)
  assert.equal(logs.lines, 3)
  assert.match(render(tools, 'gpustack_logs', {}, logs), /日志/)

  // --- wait -----------------------------------------------------------------
  const waited = await call(tools, 'gpustack_wait_model', { modelId: 12, timeoutSec: 10, intervalSec: 1 })
  assert.equal(waited.state, 'running')
  assert.equal(waited.timedOut, false)
  assert.equal(waited.readyReplicas, 1)
  assert.equal(waited.instances.length, 1)

  // --- inference ------------------------------------------------------------
  const chat = await call(tools, 'gpustack_chat', { model: 'qwen3-demo', prompt: 'ping', maxTokens: 8 })
  assert.equal(chat.content, 'pong')
  assert.equal(chat.finishReason, 'stop')
  assert.equal(chat.usage.totalTokens, 6)
  assert.match(render(tools, 'gpustack_chat', {}, chat), /pong/)

  // --- usage ----------------------------------------------------------------
  const usage = await call(tools, 'gpustack_usage', { endDate: '2026-11-06' })
  assert.equal(usage.summary.totalTokens, 150)
  assert.equal(usage.summary.activeUsers, 2)
  assert.equal(usage.summary.cachedTokens, null)
  assert.ok(usage.meta.groupBys.includes('route'))
  assert.equal(usage.breakdown, null)
  assert.match(usage.hint ?? '', /groupBy/)

  const breakdown = await call(tools, 'gpustack_usage', {
    endDate: '2026-11-06',
    groupBy: ['route'],
    granularity: 'day',
  })
  assert.equal(breakdown.breakdown.rows.length, 1)
  assert.equal(breakdown.breakdown.rows[0].total_tokens, 150)
  assert.equal(breakdown.summary.cachedTokens, 10)
  assert.equal(breakdown.summary.apiRequests, 3)
  assert.match(render(tools, 'gpustack_usage', {}, breakdown), /route=qwen3-demo/)
  await expectCode(
    call(tools, 'gpustack_usage', { endDate: '2026-11-06', groupBy: ['bogus'] }),
    'INVALID_ARGS',
  )

  // --- generic request ------------------------------------------------------
  const keys = await call(tools, 'gpustack_request', { path: '/v2/api-keys', method: 'GET' })
  assert.equal(keys.ok, true)
  assert.equal(keys.status, 200)
  assert.equal(keys.data.items.length, 1)
  assert.equal(keys.data.items[0].value, undefined)

  await expectCode(
    call(tools, 'gpustack_request', { path: '/v2/models', method: 'POST', body: { name: 'x', source: 'local_path' } }),
    'CONFIRM_REQUIRED',
  )
  const write = await call(tools, 'gpustack_request', {
    path: '/v2/models',
    method: 'POST',
    body: { name: 'x', source: 'local_path' },
    confirm: true,
  })
  assert.equal(write.ok, true)

  const missing = await call(tools, 'gpustack_request', { path: '/v2/models/99' })
  assert.equal(missing.ok, false)
  assert.equal(missing.status, 404)
  assert.match(missing.error.hint ?? '', /重新列出/)

  // --- per-category permissions ---------------------------------------------
  const deniedDeploy = await expectCode(
    call(restricted.tools, 'gpustack_deploy_model', {
      name: 'denied',
      source: 'local_path',
      localPath: '/data/denied',
    }),
    'PERMISSION_DENIED',
  )
  assert.match(deniedDeploy.message, /部署/)
  const allowedUpdate = await call(restricted.tools, 'gpustack_update_model', { modelId: 12, replicas: 3 })
  assert.equal(allowedUpdate.modelId, 12)
  await expectCode(
    call(restricted.tools, 'gpustack_model_action', { modelId: 12, action: 'delete', confirm: true }),
    'PERMISSION_DENIED',
  )
  const allowedRestart = await call(restricted.tools, 'gpustack_model_action', { modelId: 12, action: 'restart' })
  assert.equal(allowedRestart.restarted, true)
  const deniedChat = await expectCode(
    call(restricted.tools, 'gpustack_chat', { model: 'qwen3-demo', prompt: 'ping' }),
    'PERMISSION_DENIED',
  )
  assert.match(deniedChat.message, /推理/)
  await expectCode(
    call(restricted.tools, 'gpustack_request', { method: 'DELETE', path: '/v2/models/12', confirm: true }),
    'PERMISSION_DENIED',
  )
  const rawPost = await call(restricted.tools, 'gpustack_request', {
    method: 'POST',
    path: '/v2/models',
    body: { name: 'x', source: 'local_path' },
    confirm: true,
  })
  assert.equal(rawPost.ok, true, 'raw writes stay allowed while only delete is closed')

  // --- bad credential -------------------------------------------------------
  const badTest = await call(bad.tools, 'gpustack_test', {})
  assert.equal(badTest.ok, false)
  assert.equal(badTest.auth.management.status, 'unauthorized')
  assert.match(badTest.hint ?? '', /management scope/)
  const badModels = await expectCode(call(bad.tools, 'gpustack_models', {}), 'HTTP_401')
  assert.match(badModels.hint ?? '', /dsh-gpustack\.mjs/)

  // --- config tool renders without a key -----------------------------------
  const config = await call(bad.tools, 'gpustack_config', {})
  assert.equal(config.configured, true)
  assert.equal(config.credentials.apiKey, 'available')
  assert.match(render(bad.tools, 'gpustack_config', {}, config), /API Key: available/)
} finally {
  await mock.close()
}

console.log('integration tests passed')
