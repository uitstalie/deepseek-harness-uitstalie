/**
 * Tests that every schema the agent hands the host belongs to the host's supported subset.
 *
 * These assertions used to mirror the host's rules by hand (the standalone package could not
 * import them). In the repository the real checker is available, so the test asserts with the
 * same function `ctx.tools.register()` uses: a schema the mirrored table would have accepted and
 * the host rejects can no longer pass here.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { objectSchema, type FieldSpec } from '@deepseek-ai/dsh-jira-core/schema.ts'
import {
  assertSupportedJsonSchema,
  validateJsonSchemaValue,
  type ToolDefinition,
} from '@deepseek-ai/dsh-tools'
import { KB_TOOL_NAME, LIST_TOOL_NAME, TOOL_NAME, createJiraContribution } from './index.ts'
import { createLedgerFixture, dispatchTool, mountJira, testAgent, type JiraHarness } from './testing/host.ts'
import { removeTree } from '@deepseek-ai/dsh-jira-core/testing/removeTree.ts'

/** The three definitions one contribution contributes. */
const definitionsOf = (harness: JiraHarness): readonly ToolDefinition[] => {
  const contribution = createJiraContribution(harness.host)
  assert.ok(contribution.tools !== undefined, 'the capability must contribute tools')
  return contribution.tools(testAgent(harness.ctx, 'schema-agent'))
}

describe('schema: what we register belongs to the host subset', () => {
  it('registers both tools with schemas the host accepts, object-rooted', async () => {
    const ledger = await createLedgerFixture()
    const harness = await mountJira(ledger)
    try {
      const definitions = definitionsOf(harness)
      assert.deepEqual(definitions.map(definition => definition.name), [TOOL_NAME, LIST_TOOL_NAME, KB_TOOL_NAME])
      for (const definition of definitions) {
        for (const [label, schema] of [['parameters', definition.parameters], ['output.schema', definition.output.schema]] as const) {
          assert.doesNotThrow(() => { assertSupportedJsonSchema(schema) }, `${definition.name} ${label} would be rejected by the host`)
          assert.equal((schema as { type?: string }).type, 'object', `${definition.name} ${label} must be object-rooted`)
        }
      }
    } finally {
      await removeTree(ledger)
      await harness.dispose()
    }
  })

  it('accepts the values the runners actually produce', async () => {
    const ledger = await createLedgerFixture()
    const harness = await mountJira(ledger)
    try {
      const agent = testAgent(harness.ctx, 'schema-agent')
      const definitions = definitionsOf(harness)
      for (const definition of definitions) harness.ctx.tools.register(definition)
      const probes: readonly (readonly [string, unknown])[] = [
        [TOOL_NAME, { action: 'get', key: 'DH-12' }],
        [TOOL_NAME, { action: 'get', key: 'DH-99' }],
        [LIST_TOOL_NAME, { include_closed: true }],
        [KB_TOOL_NAME, { action: 'search', query: 'nothing' }],
      ]
      for (const [index, [name, args]] of probes.entries()) {
        const result = await dispatchTool(harness, agent, name, args, `schema-${name}-${String(index)}`)
        assert.equal(result.isError, false, name)
        const definition = definitions.find(entry => entry.name === name)
        assert.ok(definition !== undefined)
        assert.deepEqual(validateJsonSchemaValue(definition.output.schema, result.value), [], `${name} returned a value its own schema rejects`)
      }
    } finally {
      await removeTree(ledger)
      await harness.dispose()
    }
  })

  it('rejects the shape that broke the plugin: a boolean property carrying `required`', () => {
    const broken = { type: 'object', properties: { ok: { type: 'boolean', required: true } } }
    assert.throws(() => { assertSupportedJsonSchema(broken) }, /required/u)
  })

  it('builds `required` as an array of names that exist in properties', () => {
    const spec: Readonly<Record<string, FieldSpec>> = Object.freeze({
      action: { type: 'string', required: true, enum: ['get'] },
      key: { type: 'string' },
    })
    const schema = objectSchema(spec)
    assert.deepEqual(schema.required, ['action'])
    assert.equal(Object.hasOwn((schema.properties as Record<string, unknown>).action as object, 'required'), false)
    assert.doesNotThrow(() => { assertSupportedJsonSchema(schema) })
  })

  it('keeps a spec with no required field free of the keyword entirely', () => {
    const schema = objectSchema({ note: { type: 'string' } })
    assert.equal(Object.hasOwn(schema, 'required'), false, 'an empty list is not the same as no list')
    assert.doesNotThrow(() => { assertSupportedJsonSchema(schema) })
  })
})
