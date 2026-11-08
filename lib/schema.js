/**
 * Tiny schema builders for the JSON-Schema subset the harness accepts:
 * type / oneOf / properties / required / additionalProperties / items /
 * enum / const plus annotations (description, title, default, examples).
 *
 * Object properties may be marked with `required: true`; the marker is removed
 * when the containing object is built and turned into the object-level
 * `required` array.
 */

const ANNOTATIONS = ['description', 'title', 'default', 'examples']

function withAnnotations(schema, options, allowRequired = true) {
  for (const key of ANNOTATIONS) {
    if (options[key] !== undefined) schema[key] = options[key]
  }
  if (allowRequired && options.required === true) schema.required = true
  return schema
}

function scalar(type, options = {}) {
  const schema = { type }
  withAnnotations(schema, options)
  if (Array.isArray(options.enum)) schema.enum = [...options.enum]
  if (options.const !== undefined) schema.const = options.const
  return schema
}

export const S = {
  string(options = {}) {
    return scalar('string', options)
  },
  number(options = {}) {
    return scalar('number', options)
  },
  integer(options = {}) {
    return scalar('integer', options)
  },
  boolean(options = {}) {
    return scalar('boolean', options)
  },
  null(options = {}) {
    return scalar('null', options)
  },
  /** Unconstrained JSON value; compiles to an annotation-only schema. */
  any(options = {}) {
    return withAnnotations({}, options)
  },
  array(items, options = {}) {
    const schema = { type: 'array', items }
    return withAnnotations(schema, options)
  },
  /** Exactly one branch must match. */
  oneOf(branches, options = {}) {
    if (!Array.isArray(branches) || branches.length < 2) {
      throw new Error('S.oneOf requires at least two branches')
    }
    return withAnnotations({ oneOf: branches }, options)
  },
  object(properties, options = {}) {
    const required = []
    const cleaned = {}
    for (const [key, value] of Object.entries(properties)) {
      if (value === null || typeof value !== 'object') {
        throw new Error(`property ${key} must be a schema object`)
      }
      if (value.required === true) required.push(key)
      const copy = { ...value }
      delete copy.required
      cleaned[key] = copy
    }
    const schema = {
      type: 'object',
      properties: cleaned,
      additionalProperties: options.additionalProperties === true,
    }
    if (required.length > 0) schema.required = required
    return withAnnotations(schema, options, false)
  },
  /** Shorthand for a nullable scalar/object. */
  nullable(schema, options = {}) {
    return S.oneOf([schema, { type: 'null' }], options)
  },
}

/** Convenience: object-typed parameter root. */
export function parameters(properties, options = {}) {
  return S.object(properties, { additionalProperties: false, ...options })
}
