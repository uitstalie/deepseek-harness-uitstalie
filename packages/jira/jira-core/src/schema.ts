/**
 * core/schema — the minimal JSON-Schema surface our tools declare, plus strict argument
 * checking.
 *
 * Why hand-written (decision 108): the host's `defineTool` only converts a spec into JSON
 * Schema and validates it, and we must reject unknown keys with our own typed error anyway
 * (decision 49). Declaring the two shapes directly keeps the package free of host imports,
 * which is what lets it build and install offline on both machines (decision 65).
 *
 * The host's dialect puts `required: true` on the property itself and closes objects with
 * `additionalProperties: false`.
 */

import { type JiraError, invalidInput } from './errors.ts'
import { type Result, err, ok } from './result.ts'

export type FieldType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null'

export type FieldSpec = Readonly<{
  type: FieldType
  required?: boolean
  description?: string
  enum?: readonly string[]
}>

export type JsonSchema = Readonly<Record<string, unknown>>

/**
 * Build the parameters (or output) schema for an object. `additionalProperties: false` is
 * not decoration: the host shows this to the model, and it is what makes a stray argument
 * a visible mistake instead of a silent no-op.
 */
export const objectSchema = (fields: Readonly<Record<string, FieldSpec>>): JsonSchema => {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [name, spec] of Object.entries(fields)) {
    properties[name] = Object.freeze({
      type: spec.type,
      ...(spec.description === undefined ? {} : { description: spec.description }),
      ...(spec.enum === undefined ? {} : { enum: spec.enum }),
    })
    if (spec.required === true) required.push(name)
  }
  // The host's runtime dialect is standard JSON Schema: `required` is an **array of
  // property names**. The per-property `required: true` form belongs to the host's
  // `defineTool` spec, which we deliberately do not use (decision 108) — and passing it
  // here is rejected with `required is not supported on type "boolean"`.
  return Object.freeze({
    type: 'object',
    additionalProperties: false,
    properties: Object.freeze(properties),
    ...(required.length === 0 ? {} : { required: Object.freeze(required) }),
  })
}

const matchesType = (value: unknown, type: FieldType): boolean => {
  switch (type) {
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return typeof value === 'number' && Number.isSafeInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value)
    case 'array':
      return Array.isArray(value)
    case 'null':
      return value === null
    default:
      return false
  }
}

/**
 * Strict validation, in one pass, reporting **every** problem in `context.issues` so a
 * caller can fix them together instead of one round trip at a time.
 */
export const validateArgs = (
  fields: Readonly<Record<string, FieldSpec>>,
  args: unknown,
): Result<Readonly<Record<string, unknown>>, JiraError> => {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return err(invalidInput('arguments must be an object', { received: typeof args }))
  }
  const input = args as Record<string, unknown>
  const issues: string[] = []

  for (const name of Object.keys(input)) {
    if (!(name in fields)) issues.push(`unknown argument "${name}"`)
  }
  for (const [name, spec] of Object.entries(fields)) {
    const value = input[name]
    if (value === undefined || value === null) {
      if (spec.required === true) issues.push(`missing required argument "${name}"`)
      continue
    }
    if (!matchesType(value, spec.type)) {
      issues.push(`argument "${name}" must be ${spec.type}`)
      continue
    }
    if (spec.enum !== undefined && !spec.enum.includes(String(value))) {
      issues.push(`argument "${name}" must be one of: ${spec.enum.join(', ')}`)
    }
  }

  return issues.length === 0
    ? ok(Object.freeze({ ...input }))
    : err(invalidInput(`${issues.length} argument problem(s)`, { issues: Object.freeze(issues) }))
}

/**
 * Check a free-form object against the keys we accept (decision 49: an unknown key is
 * refused, and *named*, rather than ignored). Nested objects keep their own checks.
 */
export const pickKnownKeys = (
  value: unknown,
  allowed: readonly string[],
  field: string,
): Result<Readonly<Record<string, unknown>>, JiraError> => {
  if (value === undefined || value === null) return ok(Object.freeze({}))
  if (typeof value !== 'object' || Array.isArray(value)) {
    return err(invalidInput(`\`${field}\` must be an object`, { field, received: typeof value }))
  }
  const record = value as Record<string, unknown>
  const unknown = Object.keys(record).filter(key => !allowed.includes(key))
  if (unknown.length > 0) {
    return err(invalidInput(`unknown ${field} field(s): ${unknown.join(', ')}`, {
      field,
      unknown: Object.freeze(unknown),
      allowed: Object.freeze([...allowed]),
    }))
  }
  return ok(Object.freeze({ ...record }))
}
