/**
 * Client module load test: run `client/index.js` in a VM with a stubbed module
 * loader, React, and slots service, then assert both slot registrations.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const code = await readFile(new URL('../client/index.js', import.meta.url), 'utf8')

let spec = null
const sandbox = {
  window: { __ModuleLoader__: { load(value) { spec = value } } },
  console,
}
vm.runInNewContext(code, sandbox, { filename: 'client/index.js' })

assert.ok(spec, 'client module must call window.__ModuleLoader__.load')
assert.equal(spec.id, 'dsh-plugin-gpustack')
assert.equal(typeof spec.factory, 'function')

const reactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
}
const registered = []
const plugin = spec.factory((name) => {
  if (name === 'react') return reactStub
  throw new Error(`unexpected require: ${name}`)
})
assert.deepEqual([...plugin.inject], ['slots', 'locale'])

const locales = []
const ctx = {
  effect(fn) {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  locale: {
    register(ns, locale) {
      locales.push(`${ns}:${locale}`)
      return () => {}
    },
    bind: () => (key) => key,
  },
  slots: {
    inject(_name, callback) {
      callback()
    },
    register(options, component) {
      registered.push({ ...options, component })
      return () => {}
    },
  },
}
plugin.apply(ctx)

assert.ok(locales.includes('gpustack:en'), 'english dictionary registered')
assert.ok(locales.includes('gpustack:zh'), 'chinese dictionary registered')
const section = registered.find((entry) => entry.name === 'settings.section')
assert.ok(section, 'settings.section registration')
assert.equal(section.id, 'gpustack')
assert.equal(typeof section.label(), 'string')
const row = registered.find((entry) => entry.name === 'plugins.row.config')
assert.ok(row, 'plugins.row.config registration')
assert.equal(row.key, 'dsh-plugin-gpustack#gpustack')

// Render once in both modes with the hook stub: catches reference errors in
// the initial (loading) render without a DOM.
const t = (key) => key
for (const component of [section.component, row.component]) {
  assert.equal(typeof component, 'function')
  assert.ok(component({ view: 'page', t, close() {} }), 'page view renders')
  assert.ok(component({ view: 'summary', t }), 'summary view renders')
}

console.log('client module tests passed')
