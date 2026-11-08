/** Unit tests: URL/path handling, schema validation, and spec building. */

import assert from 'node:assert/strict'
import { normalizeBaseUrl, normalizePermissions, PERMISSION_DEFAULTS } from '../lib/site.js'
import { isScopeAllowed } from '../lib/permissions.js'
import { buildQuery, detectApi, normalizePath } from '../lib/http.js'
import { buildModelSpec, pickUpdateFields, requiresRestart } from '../lib/spec.js'
import { checkSupportedSchema, validateSchema } from '../lib/tool.js'
import { S } from '../lib/schema.js'
import { mountPlugin, expectCode } from './helpers.mjs'

// --- base URL normalization -------------------------------------------------

assert.equal(normalizeBaseUrl('http://192.0.2.10:31901'), 'http://192.0.2.10:31901')
assert.equal(normalizeBaseUrl('http://192.0.2.10:31901/'), 'http://192.0.2.10:31901')
assert.equal(normalizeBaseUrl('http://192.0.2.10:31901/docs'), 'http://192.0.2.10:31901')
assert.equal(normalizeBaseUrl('http://192.0.2.10:31901/v2'), 'http://192.0.2.10:31901')
assert.equal(normalizeBaseUrl('https://example.com/gpustack/'), 'https://example.com/gpustack')
await expectCode(Promise.resolve().then(() => normalizeBaseUrl('ftp://x')), 'CONFIG_INVALID')
await expectCode(Promise.resolve().then(() => normalizeBaseUrl('http://u:p@host')), 'CONFIG_INVALID')

// --- path families ----------------------------------------------------------

assert.equal(detectApi('/v2/models'), 'management')
assert.equal(detectApi('/v2/benchmark-proxy/v1/chat/completions'), 'inference')
assert.equal(detectApi('/v1/chat/completions'), 'inference')
assert.equal(detectApi('/v1-openai/models'), 'inference')
assert.equal(detectApi('/healthz'), 'public')
assert.equal(detectApi('/auth/login'), 'public')
assert.equal(detectApi('/unknown'), null)
assert.deepEqual(normalizePath('auto', '/v2/models'), { api: 'management', path: '/v2/models' })
assert.deepEqual(normalizePath('management', 'models'), { api: 'management', path: '/v2/models' })
assert.deepEqual(normalizePath('inference', 'chat/completions'), { api: 'inference', path: '/v1/chat/completions' })
assert.deepEqual(normalizePath('public', '/version'), { api: 'public', path: '/version' })
await expectCode(Promise.resolve().then(() => normalizePath('auto', '/unknown')), 'INVALID_PATH')
await expectCode(Promise.resolve().then(() => normalizePath('auto', '/v2/models?x=1')), 'INVALID_PATH')

// --- query serialization ----------------------------------------------------

const query = buildQuery({ page: 1, perPage: 100, categories: ['a', 'b'], watch: false, empty: '' })
assert.equal(query.get('page'), '1')
assert.equal(query.getAll('categories').join(','), 'a,b')
assert.equal(query.get('watch'), 'false')
assert.equal(query.has('empty'), false)

// --- argument validation ----------------------------------------------------

const parameters = S.object(
  { action: S.string({ required: true, enum: ['show', 'set'] }), limit: S.integer() },
  { additionalProperties: false },
)
assert.deepEqual(validateSchema(parameters, { action: 'show' }), [])
assert.equal(validateSchema(parameters, { action: 'bogus' }).length, 1)
assert.equal(validateSchema(parameters, { action: 'show', extra: 1 }).length, 1)
assert.equal(validateSchema(parameters, {}).length, 1)

// --- model spec building ----------------------------------------------------

assert.deepEqual(buildModelSpec({ name: 'demo', source: 'huggingface', huggingfaceRepoId: 'Qwen/Qwen3-27B' }), {
  name: 'demo',
  source: 'huggingface',
  huggingface_repo_id: 'Qwen/Qwen3-27B',
})
await expectCode(
  Promise.resolve().then(() => buildModelSpec({ name: 'demo' }, { requireSource: true })),
  'INVALID_ARGS',
)
await expectCode(
  Promise.resolve().then(() => buildModelSpec({ name: 'demo', source: 'huggingface' })),
  'INVALID_ARGS',
)
await expectCode(
  Promise.resolve().then(() =>
    buildModelSpec({ name: 'demo', source: 'huggingface', huggingfaceRepoId: 'a/b', localPath: '/data/x' }),
  ),
  'INVALID_ARGS',
)
await expectCode(
  Promise.resolve().then(() =>
    buildModelSpec({ name: 'demo', source: 'local_path', localPath: '/data/x', backendParameters: '--x 1' }),
  ),
  'INVALID_ARGS',
)
await expectCode(
  Promise.resolve().then(() =>
    buildModelSpec({ name: 'demo', gpuIds: ['gpu-1'], gpuType: 'Ascend 910B' }),
  ),
  'INVALID_ARGS',
)
const advanced = buildModelSpec({
  name: 'demo',
  source: 'huggingface',
  huggingfaceRepoId: 'a/b',
  extra: { disaggregation: { mode: 'vllm-mooncake' } },
})
assert.deepEqual(advanced.disaggregation, { mode: 'vllm-mooncake' })
assert.equal(advanced.name, 'demo')

assert.deepEqual(pickUpdateFields({ id: 1, name: 'x', source: 'local_path', local_path: '/p', state: 'running' }), {
  name: 'x',
  source: 'local_path',
  local_path: '/p',
})
assert.equal(requiresRestart(['replicas']), false)
assert.equal(requiresRestart(['backend_parameters']), true)

// --- operation permissions --------------------------------------------------

assert.deepEqual(normalizePermissions(undefined), { ...PERMISSION_DEFAULTS })
assert.deepEqual(normalizePermissions({ delete: false }), { ...PERMISSION_DEFAULTS, delete: false })
await expectCode(Promise.resolve().then(() => normalizePermissions({ nope: true })), 'SITE_INVALID')
await expectCode(Promise.resolve().then(() => normalizePermissions({ deploy: 'yes' })), 'SITE_INVALID')

const allAllowed = { config: { allowWrites: true, permissions: { ...PERMISSION_DEFAULTS } } }
assert.equal(isScopeAllowed(allAllowed, 'deploy'), true)
assert.equal(isScopeAllowed(allAllowed, 'inference'), true)
const deleteClosed = {
  config: { allowWrites: true, permissions: { ...PERMISSION_DEFAULTS, delete: false } },
}
assert.equal(isScopeAllowed(deleteClosed, 'delete'), false)
assert.equal(isScopeAllowed(deleteClosed, 'deploy'), true)
const readOnly = { config: { allowWrites: false, permissions: { ...PERMISSION_DEFAULTS } } }
assert.equal(isScopeAllowed(readOnly, 'deploy'), false)
assert.equal(isScopeAllowed(readOnly, 'raw'), false)
assert.equal(isScopeAllowed(readOnly, 'inference'), true)

// --- every registered tool uses the supported schema subset -----------------

const { tools } = mountPlugin({ dataDir: 'schemas-only', baseUrl: '', secretsBackend: 'none' })
assert.equal(tools.size, 12)
for (const [name, definition] of tools) {
  assert.ok(name.startsWith('gpustack_'), `unexpected tool name: ${name}`)
  assert.ok(typeof definition.description === 'string' && definition.description.length > 20, `${name} description`)
  const parameterViolations = checkSupportedSchema(definition.parameters, `${name}.parameters`)
  assert.deepEqual(parameterViolations, [], `${name} parameters: ${parameterViolations.join('; ')}`)
  const outputViolations = checkSupportedSchema(definition.output.schema, `${name}.output.schema`)
  assert.deepEqual(outputViolations, [], `${name} output: ${outputViolations.join('; ')}`)
}

console.log('unit tests passed')
