/** The reply gate decides whether a dispatched turn may close; the prompt rule alone is not enough. */
import { describe, expect, it } from 'vitest'
import { decideReplyGate, deliveredBy, exemptInput } from '../src/reply-gate.ts'

const base = { initiatedBySend: true, replied: false, exempt: false, reminded: false }

describe('decideReplyGate', () => {
  it('reminds once, then blocks, when a dispatched turn sent no reply', () => {
    expect(decideReplyGate(base)).toBe('remind')
    expect(decideReplyGate({ ...base, reminded: true })).toBe('block')
  })

  it('allows a turn that replied, a user turn, and an exempt delivery', () => {
    expect(decideReplyGate({ ...base, replied: true })).toBe('allow')
    expect(decideReplyGate({ ...base, initiatedBySend: false })).toBe('allow')
    expect(decideReplyGate({ ...base, exempt: true })).toBe('allow')
  })
})

describe('deliveredBy', () => {
  it('reads the sender Session from the delivery header', () => {
    const text = '[workspace_message] from agent session-1687c99e-7cd0-4c57-9d9a-f031628bb2d8 in Jira (33d8)\nTask t1 · reply to session-1687c99e-7cd0-4c57-9d9a-f031628bb2d8 with workspace_message.send'
    expect(deliveredBy(text)).toBe('session-1687c99e-7cd0-4c57-9d9a-f031628bb2d8')
  })

  it('returns undefined for a user message and for another header', () => {
    expect(deliveredBy('hello there')).toBeUndefined()
    expect(deliveredBy('[workspace_session] from super session-2fc48070-ac99-4a81-8594-34700f37c431')).toBeUndefined()
  })
})

describe('exemptInput', () => {
  it('exempts a task completion notice and an explicit no-reply declaration', () => {
    expect(exemptInput('[workspace-task-settled] t1 · Executor finished turn 3')).toBe(true)
    expect(exemptInput('[workspace_message] from agent session-abc in W (1)\nreply-required: no')).toBe(true)
  })

  it('exempts non-delivery input but not a plain delivery', () => {
    expect(exemptInput('just a user question')).toBe(true)
    expect(exemptInput('[workspace_message] from super session-2fc48070-ac99-4a81-8594-34700f37c431 in S (1)\nTask t')).toBe(false)
  })
})
