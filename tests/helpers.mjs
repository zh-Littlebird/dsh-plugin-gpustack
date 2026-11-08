/** Test harness: mount the plugin on a minimal context and call tools. */

import assert from 'node:assert/strict'
import { apply } from '../index.js'

export function mountPlugin(config) {
  const tools = new Map()
  const ctx = {
    tools: {
      register(definition) {
        if (tools.has(definition.name)) throw new Error(`duplicate tool: ${definition.name}`)
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    effect(fn) {
      const dispose = fn()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
  }
  apply(ctx, config)
  return { tools, ctx }
}

export async function call(tools, name, args = {}) {
  const definition = tools.get(name)
  assert.ok(definition, `tool ${name} is not registered`)
  return definition.execute(args, {
    signal: new AbortController().signal,
    callId: `test-${name}`,
    deferContext() {},
    concludeTurn() {},
  })
}

export function render(tools, name, args, value) {
  const definition = tools.get(name)
  assert.ok(definition, `tool ${name} is not registered`)
  const blocks = definition.output.render(args, value)
  assert.ok(Array.isArray(blocks) && blocks.length > 0, `${name} render must return blocks`)
  const text = blocks.map((block) => block.text).join('\n')
  assert.ok(text.length > 0, `${name} render must produce text`)
  return text
}

/** Assert that a promise rejects with a specific GpuStackError code. */
export async function expectCode(promise, code) {
  try {
    await promise
  } catch (error) {
    assert.equal(error?.code, code, `expected ${code}, got ${error?.code}: ${error?.message}`)
    return error
  }
  throw new Error(`expected rejection with ${code}, but the call resolved`)
}
