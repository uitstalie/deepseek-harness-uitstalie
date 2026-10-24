/**
 * Tests that the schemas we hand the host belong to the host's supported subset.
 *
 * Decision 110 learned this the hard way: a per-property `required: true` made the host throw
 * `JsonSchemaError` at `ctx.tools.register(...)`, which does not fail the boot — it only warns
 * `1 entry did not activate`, so the plugin was silently absent and the tools never appeared.
 *
 * The rules below are **mirrored** from the host rather than imported (decision 108: this package
 * imports no host package):
 *
 *   `packages/core/tools/src/json-schema.ts` (DSH 0.2.0-rc.2 / cli-desktop 0.2.1-alpha.2),
 *   `allowedFor`: `properties`/`required`/`additionalProperties` only on `object`, `items` only on
 *   `array`, `enum`/`const` only on scalars; `required` must be an array of names that exist in
 *   `properties`.
 *
 * If the host's subset grows, this file is the one place to widen — and the place to notice.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { objectSchema, type FieldSpec } from '../core/schema.ts'
import { type JiraToolDefinition, KB_TOOL_NAME, LIST_TOOL_NAME, TOOL_NAME, apply, type JiraHostContext } from './index.ts'

/** The host's `allowedFor` table, verbatim in shape. */
const ALLOWED_FOR: Readonly<Record<string, readonly string[]>> = Object.freeze({
  properties: ['object'],
  required: ['object'],
  additionalProperties: ['object'],
  items: ['array'],
  enum: ['string', 'number', 'integer', 'boolean', 'null'],
  const: ['string', 'number', 'integer', 'boolean', 'null'],
})

const ANNOTATIONS = new Set(['description', 'title', 'default', 'examples', '$comment'])
const CORE = new Set(['type', 'oneOf'])

type Violation = string

/** Walk a schema the way the host does and collect everything it would reject. */
const violationsIn = (schema: unknown, path = 'schema'): readonly Violation[] => {
  const found: Violation[] = []
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return found
  const node = schema as Record<string, unknown>
  const type = typeof node.type === 'string' ? node.type : undefined

  for (const [key, value] of Object.entries(node)) {
    if (ANNOTATIONS.has(key) || CORE.has(key)) continue
    const allowedTypes = ALLOWED_FOR[key]
    if (allowedTypes === undefined) {
      found.push(`${path}.${key} is not a supported keyword`)
      continue
    }
    if (type === undefined || !allowedTypes.includes(type)) {
      found.push(`${path}.${key} is not supported on type "${String(type)}"`)
    }
    void value
  }

  if (Object.hasOwn(node, 'required')) {
    const required = node.required
    if (!Array.isArray(required) || required.some(entry => typeof entry !== 'string')) {
      found.push(`${path}.required must be an array of strings`)
    } else {
      const properties = (node.properties ?? {}) as Record<string, unknown>
      for (const name of required as string[]) {
        if (!Object.hasOwn(properties, name)) found.push(`${path}.required names "${name}" which is not in properties`)
      }
    }
  }

  for (const [key, value] of Object.entries((node.properties ?? {}) as Record<string, unknown>)) {
    found.push(...violationsIn(value, `${path}.properties.${key}`))
  }
  for (const [index, branch] of (Array.isArray(node.oneOf) ? node.oneOf : []).entries()) {
    found.push(...violationsIn(branch, `${path}.oneOf[${String(index)}]`))
  }
  if (node.items !== undefined) found.push(...violationsIn(node.items, `${path}.items`))
  return found
}

const registrations: JiraToolDefinition[] = []
const host: JiraHostContext = {
  get: () => undefined,
  on: () => undefined,
  tools: { register: (definition) => {
    registrations.push(definition)
    return () => undefined
  } },
}

describe('schema: what we register belongs to the host subset', () => {
  it('registers both tools with schemas the host would accept', async () => {
    registrations.length = 0
    await apply(host, { root: process.cwd() + '/fixtures' }, {}, () => Date.parse('2026-10-15T12:00:00Z'))
    assert.deepEqual(registrations.map(definition => definition.name), [TOOL_NAME, LIST_TOOL_NAME, KB_TOOL_NAME])

    for (const definition of registrations) {
      for (const [label, schema] of [['parameters', definition.parameters], ['output.schema', definition.output.schema]] as const) {
        assert.deepEqual(violationsIn(schema), [], `${definition.name} ${label} would be rejected by the host`)
        assert.equal((schema as { type?: string }).type, 'object', `${definition.name} ${label} must be object-rooted`)
      }
    }
  })

  it('never puts `required` on anything but an object node', () => {
    // The exact shape that broke the plugin: a boolean property carrying `required: true`.
    const broken = { type: 'object', properties: { ok: { type: 'boolean', required: true } } }
    assert.ok(
      violationsIn(broken).includes('schema.properties.ok.required is not supported on type "boolean"'),
      `the host would reject this: ${JSON.stringify(violationsIn(broken))}`,
    )
  })

  it('builds `required` as an array of names that exist in properties', () => {
    const spec: Readonly<Record<string, FieldSpec>> = Object.freeze({
      action: { type: 'string', required: true, enum: ['get'] },
      key: { type: 'string' },
    })
    const schema = objectSchema(spec)
    assert.deepEqual(schema.required, ['action'])
    assert.equal(Object.hasOwn((schema.properties as Record<string, unknown>).action as object, 'required'), false)
    assert.deepEqual(violationsIn(schema), [])
  })

  it('keeps a spec with no required field free of the keyword entirely', () => {
    const schema = objectSchema({ note: { type: 'string' } })
    assert.equal(Object.hasOwn(schema, 'required'), false, 'an empty list is not the same as no list')
    assert.deepEqual(violationsIn(schema), [])
  })
})
