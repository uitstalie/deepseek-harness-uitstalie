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

/** The JSON types a tool argument or output field may declare. */
export type FieldType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null'

/**
 * One field of a tool's object schema: its type, whether it is required, how it reads to the
 * model, and the values it accepts when it is an enumeration.
 */
export type FieldSpec = Readonly<{
  /** Omitted only for a `oneOf` property. */
  type?: FieldType
  required?: boolean
  description?: string
  enum?: readonly string[]
  /** Nested object properties, emitted as a real JSON Schema object. */
  properties?: Readonly<Record<string, FieldSpec>>
  /** Array item schema, emitted as `items`. */
  items?: FieldSpec
  /** Object closure; defaults to false when `properties` is present. */
  additionalProperties?: boolean
  /** Exact-one union for nullable/scalar variants; emits a JSON Schema `oneOf`. */
  oneOf?: readonly FieldSpec[]
}>

/** A JSON Schema object as this package declares it: a plain frozen record the host serializes. */
export type JsonSchema = Readonly<Record<string, unknown>>

/**
 * Build the parameters (or output) schema for an object. `additionalProperties: false` is
 * not decoration: the host shows this to the model, and it is what makes a stray argument
 * a visible mistake instead of a silent no-op.
 * @param fields - the object's fields, keyed by their argument names.
 * @returns the closed object schema, with the required names collected into an array.
 */
export const objectSchema = (fields: Readonly<Record<string, FieldSpec>>): JsonSchema => {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [name, spec] of Object.entries(fields)) {
    properties[name] = propertySchema(spec)
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

/** Render one property, recursively expanding nested object/array declarations. */
const propertySchema = (spec: FieldSpec): Record<string, unknown> => {
  const nested = spec.properties === undefined ? undefined : Object.entries(spec.properties)
  const required = nested === undefined
    ? []
    : nested.filter(([, property]) => property.required === true).map(([name]) => name)
  return Object.freeze({
    ...(spec.oneOf === undefined ? { type: spec.type } : { oneOf: spec.oneOf.map(propertySchema) }),
    ...(spec.description === undefined ? {} : { description: spec.description }),
    ...(spec.enum === undefined ? {} : { enum: spec.enum }),
    ...(nested === undefined
      ? {}
      : {
        properties: Object.freeze(Object.fromEntries(nested.map(([name, property]) => [name, propertySchema(property)]))),
        ...(required.length === 0 ? {} : { required: Object.freeze(required) }),
        additionalProperties: spec.additionalProperties ?? false,
      }),
    ...(spec.items === undefined ? {} : { items: propertySchema(spec.items) }),
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
 * @param fields - the fields the arguments are checked against.
 * @param args - the arguments the caller supplied.
 * @returns every argument problem at once, or the arguments as a frozen record.
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
  validateObject(fields, input, '', false, issues)

  const message = issues.length === 1 && issues[0]?.startsWith('unknown ')
    ? issues[0]
    : `${issues.length} argument problem(s)`
  return issues.length === 0
    ? ok(Object.freeze({ ...input }))
    : err(invalidInput(message, { issues: Object.freeze(issues) }))
}

const childPath = (path: string, name: string): string => path === '' ? name : `${path}.${name}`

const validateObject = (
  fields: Readonly<Record<string, FieldSpec>>,
  input: Readonly<Record<string, unknown>>,
  path: string,
  additionalProperties: boolean,
  issues: string[],
): void => {
  for (const name of Object.keys(input)) {
    if (!Object.hasOwn(fields, name) && !additionalProperties) {
      issues.push(path === ''
        ? `unknown argument "${name}"`
        : `unknown ${path} field(s): ${name}`)
    }
  }
  for (const [name, spec] of Object.entries(fields)) {
    const fieldPath = childPath(path, name)
    const value = input[name]
    if (value === undefined) {
      if (spec.required === true) issues.push(`missing required argument "${fieldPath}"`)
      continue
    }
    validateField(value, spec, fieldPath, issues)
  }
}

const validateField = (value: unknown, spec: FieldSpec, path: string, issues: string[]): void => {
  if (spec.oneOf !== undefined) {
    const alternatives = spec.oneOf.map((alternative) => {
      const alternativeIssues: string[] = []
      validateField(value, alternative, path, alternativeIssues)
      return alternativeIssues
    })
    if (!alternatives.some(alternativeIssues => alternativeIssues.length === 0)) {
      issues.push(`argument "${path}" must match one of: ${spec.oneOf.map(alternative => alternative.type ?? 'oneOf').join(', ')}`)
    }
    return
  }
  if (spec.type !== undefined && !matchesType(value, spec.type)) {
    issues.push(`argument "${path}" must be ${spec.type}`)
    return
  }
  if (spec.enum !== undefined && !spec.enum.includes(String(value))) {
    issues.push(`argument "${path}" must be one of: ${spec.enum.join(', ')}`)
  }
  if (spec.properties !== undefined && typeof value === 'object' && value !== null && !Array.isArray(value)) {
    validateObject(spec.properties, value as Record<string, unknown>, path, spec.additionalProperties ?? false, issues)
  }
  if (spec.items !== undefined && Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      validateField(item, spec.items, `${path}[${String(index)}]`, issues)
    }
  }
}

/**
 * Check a free-form object against the keys we accept (decision 49: an unknown key is
 * refused, and *named*, rather than ignored). Nested objects keep their own checks.
 * @param value - the object to check; absent or null reads as empty.
 * @param allowed - the keys this field accepts.
 * @param field - the field's name, used in the error.
 * @returns the object's own keys, or the refusal naming the unknown ones.
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
