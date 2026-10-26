/**
 * Tests for the model-visible tool surface and the write guard (decisions 84/96).
 *
 * The names, verbs and descriptions are an external contract with the model: a session that
 * learned `jira_issue` in one deployment must find the same verbs in another. The guard is a
 * separate contract — it decides **before** a handler runs, and its denial cannot be argued with
 * by a later plugin.
 *
 * The standalone package also compared these verbs with the CLI's command names. That comparison
 * now spans two packages (`jira-agent` cannot depend on `jira-cli`), and the CLI's own
 * table/handler/usage tests in `jira-cli` hold its side.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { removeTree } from '@deepseek-ai/dsh-jira-core/testing/removeTree.ts'
import {
  ISSUE_DESCRIPTION,
  ISSUE_PARAMETERS,
  KB_DESCRIPTION,
  KB_OUTPUT_SCHEMA,
  KB_PARAMETERS,
  KB_TOOL_NAME,
  LIST_DESCRIPTION,
  LIST_OUTPUT_SCHEMA,
  LIST_PARAMETERS,
  LIST_TOOL_NAME,
  READ_ACTIONS,
  READ_TIMEOUT_MS,
  TOOL_NAME,
  WRITE_ACTIONS,
  WRITE_TIMEOUT_MS,
  createJiraContribution,
} from './index.ts'
import * as jiraAgent from './index.ts'
import { concurrencySafe, createLedgerFixture, dispatchTool, mountJira, testAgent } from './testing/host.ts'

const actionEnum = (parameters: Readonly<Record<string, { enum?: readonly string[] }>>): readonly string[] =>
  parameters.action?.enum ?? []

describe('surfaces: the model-visible declarations', () => {
  it('keeps the ten issue verbs and their read/write split', () => {
    assert.deepEqual(actionEnum(ISSUE_PARAMETERS), [
      'get', 'create', 'update', 'switch_state', 'comment', 'assignee', 'link', 'tag_create', 'close', 'batch_close',
    ])
    assert.deepEqual([...WRITE_ACTIONS], ['create', 'update', 'switch_state', 'comment', 'assignee', 'link', 'tag_create', 'close', 'batch_close'])
    assert.deepEqual([...READ_ACTIONS], ['get'])
  })

  it('keeps the knowledge verbs, and the list tool without one', () => {
    assert.deepEqual(actionEnum(KB_PARAMETERS), ['get', 'create', 'update', 'search'])
    assert.equal(Object.hasOwn(LIST_PARAMETERS, 'action'), false)
  })

  it('keeps the model-facing descriptions that name the refusal behavior', () => {
    assert.match(ISSUE_DESCRIPTION, /Read or change one issue in the local dsh-jira ledger/u)
    assert.match(ISSUE_DESCRIPTION, /read-only and delegated sessions get `ok: false`/u)
    assert.match(ISSUE_DESCRIPTION, /`tag_create` registers one/u)
    assert.match(LIST_DESCRIPTION, /ready first and blocked last/u)
    assert.match(LIST_DESCRIPTION, /Read-only, and available to every session including subagents/u)
    assert.match(KB_DESCRIPTION, /runbooks, pitfalls, how-tos,/u)
    assert.match(KB_DESCRIPTION, /file:line so a claim can be traced/u)
  })

  it('declares the output envelope both tools share', () => {
    for (const schema of [KB_OUTPUT_SCHEMA, LIST_OUTPUT_SCHEMA]) {
      assert.deepEqual(schema.required, ['ok', 'writable', 'me'])
      assert.equal(schema.additionalProperties, true)
    }
  })

  it('declares a read budget for the read tool, and only reads as concurrency-safe', async () => {
    const ledger = await createLedgerFixture()
    const harness = await mountJira(ledger)
    try {
      const contribution = createJiraContribution(harness.host)
      assert.ok(contribution.tools !== undefined)
      const byName = new Map(contribution.tools(testAgent(harness.ctx, 'surface-agent')).map(definition => [definition.name, definition]))
      const toolOf = (name: string): ToolDefinition => {
        const found = byName.get(name)
        assert.ok(found !== undefined, `${name} must be contributed`)
        return found
      }
      const list = toolOf(LIST_TOOL_NAME)
      assert.equal(list.timeoutMs, READ_TIMEOUT_MS, 'a read must not be allowed to hang as long as a write')
      assert.equal(concurrencySafe(list, {}), true, 'a pure read may overlap a sibling call')

      const jira = toolOf(TOOL_NAME)
      assert.equal(jira.timeoutMs, WRITE_TIMEOUT_MS, 'a mixed tool takes the write budget')
      assert.equal(concurrencySafe(jira, { action: 'get' }), true, 'the read action may overlap')
      assert.equal(concurrencySafe(jira, { action: 'update' }), false, 'a write may not')
      assert.equal(concurrencySafe(jira, {}), false, 'and neither may a call we cannot classify')

      const kb = toolOf(KB_TOOL_NAME)
      assert.equal(concurrencySafe(kb, { action: 'search' }), true, 'a knowledge search is a read')
      assert.equal(concurrencySafe(kb, { action: 'create' }), false, 'a knowledge write may not overlap')
    } finally {
      await removeTree(ledger)
      await harness.dispose()
    }
  })
})

describe('surfaces: the monotonic write guard (decision 96)', () => {
  it('denies every write verb from a read-only session, and lets the read through', async () => {
    const ledger = await createLedgerFixture()
    const harness = await mountJira(ledger, { env: { DSH_READ_ONLY_SESSION: '1' } })
    // The plugin reads the process environment for the guard; the host facts are pinned to the
    // same value so one test covers the shipped wiring instead of a re-implementation of it.
    process.env.DSH_READ_ONLY_SESSION = '1'
    try {
      const fiber = await harness.ctx.plugin(jiraAgent)
      try {
        const agent = testAgent(harness.ctx, 'guard-agent')
        await harness.ctx.serial('agent/created', { agent, source: 'startup' })
        let denied = 0
        for (const action of WRITE_ACTIONS) {
          const result = await dispatchTool(harness, agent, TOOL_NAME, { action, key: 'DH-12' }, `guard-${action}`)
          assert.equal(result.isError, true, `${action} must be denied`)
          assert.match(
            result.content.filter(block => block.type === 'text').map(block => block.text).join(''),
            /writes the ledger, and this session may not write \(dsh-read-only\)/u,
          )
          denied += 1
        }
        assert.equal(denied, WRITE_ACTIONS.length, 'every write verb was covered')

        const read = await dispatchTool(harness, agent, TOOL_NAME, { action: 'get', key: 'DH-12' }, 'guard-read')
        assert.equal(read.isError, false, 'reads pass the guard')
      } finally {
        await fiber.dispose()
      }
    } finally {
      delete process.env.DSH_READ_ONLY_SESSION
      await removeTree(ledger)
      await harness.dispose()
    }
  })

  it('does not police tools that are not ours', async () => {
    const ledger = await createLedgerFixture()
    const harness = await mountJira(ledger, { env: { DSH_READ_ONLY_SESSION: '1' } })
    process.env.DSH_READ_ONLY_SESSION = '1'
    try {
      const fiber = await harness.ctx.plugin(jiraAgent)
      try {
        const agent = testAgent(harness.ctx, 'guard-agent')
        await harness.ctx.serial('agent/created', { agent, source: 'startup' })
        harness.ctx.tools.register({
          name: 'another_tool',
          description: 'not jira',
          parameters: { type: 'object', additionalProperties: false, properties: {} },
          output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: 'ok' }] },
          execute: () => Promise.resolve({}),
        })
        const result = await dispatchTool(harness, agent, 'another_tool', { action: 'update' }, 'guard-other')
        assert.equal(result.isError, false, 'other tools are not ours to police')
      } finally {
        await fiber.dispose()
      }
    } finally {
      delete process.env.DSH_READ_ONLY_SESSION
      await removeTree(ledger)
      await harness.dispose()
    }
  })
})
