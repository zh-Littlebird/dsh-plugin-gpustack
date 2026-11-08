/**
 * Local tool-definition helper.
 *
 * The harness accepts a plain definition whose `parameters` and `output.schema`
 * are already raw JSON Schema. This module builds that definition and adds the
 * argument validation the harness's `defineTool` would otherwise supply, so the
 * plugin has no hard dependency on harness packages and can be tested with
 * plain Node.
 */

import { GpuStackError } from './errors.js'

const SCHEMA_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null', 'array', 'object'])
const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples'])
const CONSTRAINT_KEYWORDS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
])

function typeName(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return typeof value
}

function valueMatchesType(schemaType, value) {
  switch (schemaType) {
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'null':
      return value === null
    case 'array':
      return Array.isArray(value)
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value)
    default:
      return false
  }
}

/**
 * Validate a value against the supported raw-schema subset.
 * @returns {string[]} path-qualified violations; empty means valid.
 */
export function validateSchema(schema, value, path = 'arguments') {
  const violations = []
  walk(schema, value, path, violations, new Set())
  return violations
}

function walk(schema, value, path, violations, seen) {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    violations.push(`${path} 的 schema 无效`)
    return
  }
  if (seen.has(schema)) {
    violations.push(`${path} 的 schema 循环引用`)
    return
  }
  seen.add(schema)
  try {
    if (Object.hasOwn(schema, 'oneOf')) {
      if (!Array.isArray(schema.oneOf) || schema.oneOf.length < 2) {
        violations.push(`${path} 的 oneOf 至少需要两个分支`)
        return
      }
      let matched = 0
      const branchErrors = []
      for (const branch of schema.oneOf) {
        const branchViolations = []
        walk(branch, value, path, branchViolations, new Set())
        if (branchViolations.length === 0) matched++
        else branchErrors.push(branchViolations[0])
      }
      if (matched !== 1) {
        const suffix = branchErrors.length > 0 ? `（${branchErrors.join('；')}）` : ''
        violations.push(`${path} 必须且只能匹配一种允许的格式${suffix}`)
      }
      return
    }
    const type = schema.type
    if (typeof type !== 'string' || !SCHEMA_TYPES.has(type)) {
      // Annotation-only schema: accepts any JSON value.
      if (type === undefined) return
      violations.push(`${path} 的 schema type 不受支持：${String(type)}`)
      return
    }
    if (!valueMatchesType(type, value)) {
      violations.push(`${path} 应为 ${type}，实际为 ${typeName(value)}`)
      return
    }
    if (Object.hasOwn(schema, 'enum')) {
      const allowed = schema.enum
      if (!Array.isArray(allowed) || !allowed.some((entry) => valueMatchesType(type, entry) && Object.is(entry, value))) {
        violations.push(`${path} 的取值必须是 ${JSON.stringify(allowed)} 之一`)
        return
      }
    }
    if (Object.hasOwn(schema, 'const') && !Object.is(schema.const, value)) {
      violations.push(`${path} 的取值必须是 ${JSON.stringify(schema.const)}`)
      return
    }
    if (type === 'object') {
      const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {}
      const required = Array.isArray(schema.required) ? schema.required : []
      for (const key of required) {
        if (!Object.hasOwn(value, key) || value[key] === undefined) {
          violations.push(`${path}.${key} 为必填项`)
        }
      }
      for (const [key, entry] of Object.entries(value)) {
        if (Object.hasOwn(properties, key)) {
          walk(properties[key], entry, `${path}.${key}`, violations, seen)
        } else if (schema.additionalProperties === false) {
          violations.push(`${path}.${key} 不是允许的参数`)
        }
      }
      return
    }
    if (type === 'array') {
      if (schema.items !== undefined) {
        value.forEach((entry, index) => walk(schema.items, entry, `${path}[${index}]`, violations, seen))
      }
    }
  } finally {
    seen.delete(schema)
  }
}

/**
 * Assert that a schema uses only the keyword subset the harness accepts.
 * This is intentionally a test-time helper; registration performs the same
 * check inside the host.
 * @returns {string[]}
 */
export function checkSupportedSchema(schema, path = 'schema') {
  const violations = []
  const seen = new Set()
  const visit = (node, nodePath) => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) {
      violations.push(`${nodePath} 必须是 schema 对象`)
      return
    }
    if (seen.has(node)) {
      violations.push(`${nodePath} 循环引用`)
      return
    }
    seen.add(node)
    try {
      for (const key of Object.keys(node)) {
        if (!CONSTRAINT_KEYWORDS.has(key) && !ANNOTATION_KEYWORDS.has(key)) {
          violations.push(`${nodePath}.${key} 不是支持的 schema 关键字`)
        }
      }
      const hasType = Object.hasOwn(node, 'type')
      const hasOneOf = Object.hasOwn(node, 'oneOf')
      if (hasType && hasOneOf) violations.push(`${nodePath} 不能同时声明 type 与 oneOf`)
      if (!hasType && !hasOneOf) {
        for (const key of ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const']) {
          if (Object.hasOwn(node, key)) violations.push(`${nodePath}.${key} 需要 type 或 oneOf`)
        }
        return
      }
      if (hasOneOf) {
        if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) violations.push(`${nodePath}.oneOf 至少需要两个分支`)
        else node.oneOf.forEach((branch, index) => visit(branch, `${nodePath}.oneOf[${index}]`))
        return
      }
      const type = node.type
      if (!SCHEMA_TYPES.has(type)) {
        violations.push(`${nodePath}.type 不受支持：${String(type)}`)
        return
      }
      if (type === 'object') {
        if (node.properties !== undefined) {
          if (node.properties === null || typeof node.properties !== 'object' || Array.isArray(node.properties)) {
            violations.push(`${nodePath}.properties 必须是对象`)
          } else {
            for (const [key, entry] of Object.entries(node.properties)) visit(entry, `${nodePath}.properties.${key}`)
          }
        }
        if (node.required !== undefined && (!Array.isArray(node.required) || node.required.length === 0)) {
          violations.push(`${nodePath}.required 必须是非空数组`)
        }
        if (node.additionalProperties !== undefined && typeof node.additionalProperties !== 'boolean') {
          violations.push(`${nodePath}.additionalProperties 必须是布尔值`)
        }
      } else if (type === 'array') {
        if (node.items !== undefined) visit(node.items, `${nodePath}.items`)
      } else if (node.enum !== undefined) {
        if (!Array.isArray(node.enum) || node.enum.length === 0) violations.push(`${nodePath}.enum 必须是非空数组`)
      }
    } finally {
      seen.delete(node)
    }
  }
  visit(schema, path)
  return violations
}

/**
 * Build a registry-ready tool definition.
 *
 * @template {Record<string, unknown>} A
 * @template O
 * @param {{
 *   name: string,
 *   description: string,
 *   parameters: Record<string, unknown>,
 *   output: { schema: Record<string, unknown>, render: (args: A, value: O) => Array<{type:'text', text:string}> },
 *   timeoutMs?: number,
 *   isConcurrencySafe?: (args: A) => boolean,
 *   presentCall?: (args: A) => unknown,
 *   presentResult?: (args: A, result: unknown) => unknown,
 *   execute: (args: A, exec: any) => Promise<O>
 * }} options
 */
export function defineTool(options) {
  if (typeof options.name !== 'string' || options.name.length === 0) throw new Error('tool name is required')
  if (typeof options.execute !== 'function') throw new Error(`tool ${options.name}: execute is required`)
  if (options.output === null || typeof options.output !== 'object' || typeof options.output.render !== 'function') {
    throw new Error(`tool ${options.name}: output.render is required`)
  }
  const definition = {
    name: options.name,
    description: options.description,
    parameters: options.parameters,
    output: {
      schema: options.output.schema,
      render: (args, value) => options.output.render(args, value),
    },
    async execute(args, exec) {
      const violations = validateSchema(options.parameters, args)
      if (violations.length > 0) {
        throw new GpuStackError('INVALID_ARGS', `参数不合法：${violations.join('；')}`, {
          hint: '请按工具参数说明修正后重试，不要猜测字段名。',
        })
      }
      return options.execute(args, exec)
    },
  }
  if (options.timeoutMs !== undefined) definition.timeoutMs = options.timeoutMs
  if (typeof options.isConcurrencySafe === 'function') {
    definition.isConcurrencySafe = (args) => options.isConcurrencySafe(args)
  }
  if (typeof options.presentCall === 'function') {
    definition.presentCall = (args) => options.presentCall(args)
  }
  return definition
}
