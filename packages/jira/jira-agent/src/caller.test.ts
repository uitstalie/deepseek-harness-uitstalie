/**
 * Tests for plugin/caller — the duck-typed lineage facts behind decision 89/96.
 *
 * These use the shapes the spike verified on both host versions
 * (`agent.session.header.origin|delegationDepth`, `agent.options.subagentDepth`).
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { callerSessionId, describeCaller, isSubagent } from './caller.ts'

const agent = (header: Record<string, unknown>, options: Record<string, unknown> = {}, id = 's-1') => ({
  id,
  session: { id, header },
  options,
})

describe('plugin/caller: who is asking', () => {
  it('treats a plain session as the main agent', () => {
    assert.equal(isSubagent(agent({})), false)
    const caller = describeCaller({ agent: agent({}) })
    assert.equal(caller.writable, true)
    assert.equal(caller.reason, undefined)
  })

  it('recognises a delegated subagent by origin', () => {
    const child = agent({ origin: 'subagent', parentSession: 'root' })
    assert.equal(isSubagent(child), true)
    const caller = describeCaller({ agent: child })
    assert.equal(caller.writable, false)
    assert.equal(caller.reason, 'subagent')
  })

  it('recognises a subagent by persisted delegationDepth, which survives a resume', () => {
    assert.equal(isSubagent(agent({ delegationDepth: 1 })), true)
    assert.equal(isSubagent(agent({ delegationDepth: 0 })), false)
  })

  it('recognises a subagent by runtime depth alone', () => {
    assert.equal(isSubagent(agent({}, { subagentDepth: 2 })), true)
    assert.equal(isSubagent(agent({}, { subagentDepth: 0 })), false)
  })

  it('degrades safely when the host gives it nothing recognisable', () => {
    assert.equal(isSubagent(undefined), false)
    assert.equal(isSubagent(null), false)
    assert.equal(isSubagent({}), false)
    assert.equal(isSubagent({ session: {} }), false)
    assert.equal(describeCaller({}).writable, true)
  })

  it('refuses writes in a read-only session, with its own reason (decision 93)', () => {
    const caller = describeCaller({ readOnly: true, agent: agent({}) })
    assert.equal(caller.writable, false)
    assert.equal(caller.reason, 'dsh-read-only')
  })

  it('reads the session id for `me`, and keeps it out of the identity when absent', () => {
    assert.equal(callerSessionId(agent({}, {}, 'sess-9')), 'sess-9')
    assert.equal(callerSessionId({ id: 'bare-agent' }), 'bare-agent')
    assert.equal(callerSessionId({}), undefined)
  })
})
