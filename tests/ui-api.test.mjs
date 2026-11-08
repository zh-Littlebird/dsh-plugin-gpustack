/** Settings API tests: state, save, credential write, and connection test. */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRuntime } from '../lib/config.js'
import { HttpTransport } from '../lib/http.js'
import { GpuStackClient } from '../lib/api.js'
import { createUiHandler } from '../lib/ui-api.js'
import { MOCK_API_KEY, startMock } from './mock-server.mjs'

const mock = await startMock()
const dataDir = join(tmpdir(), `dsh-gpustack-ui-${process.pid}-${Date.now()}`)
const runtime = createRuntime({
  baseUrl: '',
  apiKeyEnv: 'GPUSTACK_UI_TEST_KEY',
  secretsBackend: 'file',
  dataDir,
  audit: false,
})
const clientFor = ({ settings }) => {
  const transport = new HttpTransport({ settings, debug: () => {} })
  return { transport, client: new GpuStackClient({ settings, transport }) }
}
const handler = createUiHandler({
  runtime,
  clientFor,
  audit: { append() {} },
  debug: () => {},
})
const server = createServer((req, res) => {
  handler(req, res)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
const port = typeof address === 'object' && address !== null ? address.port : 0
const base = `http://127.0.0.1:${port}`

async function call(method, path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      accept: 'application/json',
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.header === true ? { 'x-gpustack-ui': '1' } : {}),
      ...(options.origin === undefined ? {} : { origin: options.origin }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const body = await response.json()
  return { status: response.status, body }
}

try {
  // Initial state: no cluster configured, no key.
  const initial = await call('GET', '/gpustack-ui/state')
  assert.equal(initial.status, 200)
  assert.equal(initial.body.baseUrl, null)
  assert.equal(initial.body.credentials.apiKey, 'missing')

  // Writes require the page header.
  const rejected = await call('POST', '/gpustack-ui/config', { body: { baseUrl: mock.baseUrl } })
  assert.equal(rejected.status, 403)
  assert.equal(rejected.body.error.code, 'WRITE_FORBIDDEN')

  // Cross-site origin is refused even with the header.
  const crossSite = await call('POST', '/gpustack-ui/config', {
    header: true,
    origin: 'http://evil.example',
    body: { baseUrl: mock.baseUrl },
  })
  assert.equal(crossSite.status, 403)

  // Save address + write switch + timeout.
  const saved = await call('POST', '/gpustack-ui/config', {
    header: true,
    body: { baseUrl: `${mock.baseUrl}/docs`, allowWrites: false, timeoutMs: 5000 },
  })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.baseUrl, mock.baseUrl, 'docs suffix must be stripped')
  assert.equal(saved.body.config.allowWrites, false)
  assert.equal(saved.body.config.timeoutMs, 5000)
  assert.deepEqual(saved.body.saved.sort(), ['allowWrites', 'baseUrl', 'timeoutMs'])

  // The saved values drive tool resolution immediately (no restart).
  const settings = await runtime.resolveSettings({ tolerateSecretErrors: true })
  assert.equal(settings.config.allowWrites, false)
  assert.equal(settings.config.timeoutMs, 5000)

  // Per-category permissions save independently and reject unknown keys.
  const permissionsSaved = await call('POST', '/gpustack-ui/config', {
    header: true,
    body: { permissions: { delete: false } },
  })
  assert.equal(permissionsSaved.status, 200)
  assert.equal(permissionsSaved.body.config.permissions.delete, false)
  assert.equal(permissionsSaved.body.config.permissions.deploy, true)
  const unknownPermission = await call('POST', '/gpustack-ui/config', {
    header: true,
    body: { permissions: { nope: true } },
  })
  assert.equal(unknownPermission.status, 400)

  // A too-short key is rejected; a real one is stored and never echoed.
  const short = await call('PUT', '/gpustack-ui/api-key', { header: true, body: { value: 'x' } })
  assert.equal(short.status, 400)
  const stored = await call('PUT', '/gpustack-ui/api-key', { header: true, body: { value: MOCK_API_KEY } })
  assert.equal(stored.status, 200)
  assert.equal(stored.body.credentials.apiKey, 'available')
  assert.equal(JSON.stringify(stored.body).includes(MOCK_API_KEY), false)

  // With a key present, the read-only master switch is what the page reports.
  const afterKey = await call('GET', '/gpustack-ui/state')
  assert.match(afterKey.body.hint ?? '', /只读/)

  // Connection test reaches the mock cluster.
  const tested = await call('POST', '/gpustack-ui/test', { header: true })
  assert.equal(tested.status, 200)
  assert.equal(tested.body.ok, true, JSON.stringify(tested.body))
  assert.equal(tested.body.version, 'v2.3.0')
  assert.equal(tested.body.management.status, 'ok')
  assert.equal(tested.body.inference.modelCount, 1)

  // Clearing the key leaves the address in place.
  const cleared = await call('DELETE', '/gpustack-ui/api-key', { header: true })
  assert.equal(cleared.status, 200)
  assert.equal(cleared.body.credentials.apiKey, 'missing')
  assert.equal(cleared.body.baseUrl, mock.baseUrl)

  // An explicit empty address clears it.
  const unset = await call('POST', '/gpustack-ui/config', { header: true, body: { baseUrl: null } })
  assert.equal(unset.status, 200)
  assert.equal(unset.body.baseUrl, null)

  console.log('ui-api tests passed')
} finally {
  await new Promise((resolve) => server.close(resolve))
  await mock.close()
}
