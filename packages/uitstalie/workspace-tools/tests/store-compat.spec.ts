/** Durable message records written before `requestId` existed stay readable. */
import { describe, expect, it } from 'vitest'
import { readMessage } from '../src/store.ts'

const legacy = {
  messageId: 'message-legacy',
  workspaceId: 'workspace-1',
  targetSessionId: 'session-target',
  sourceSessionId: 'session-source',
  text: 'legacy body',
  kind: 'message',
  priority: 'normal',
  references: [],
  status: 'delivered',
  createdAt: '2026-11-21T00:00:00.000Z',
  deliveredAt: '2026-11-21T00:00:00.000Z',
  attempts: 1,
  receipts: [{ at: '2026-11-21T00:00:00.000Z', status: 'delivered' }],
}

function context(text: string) {
  return {
    dshStore: {
      readFile: async () => ({ text, version: 'v1' }),
      query: async () => ({ kind: 'missing' }),
    },
  } as never
}

describe('message record compatibility', () => {
  it('falls back to messageId for a record that predates requestId', async () => {
    const stored = await readMessage(context(JSON.stringify(legacy)), 'workspace-1', 'message-legacy')
    expect(stored?.message.messageId).toBe('message-legacy')
    expect(stored?.message.requestId).toBe('message-legacy')
    expect(stored?.version).toBe('v1')
  })

  it('reads a record that carries requestId', async () => {
    const stored = await readMessage(context(JSON.stringify({ ...legacy, requestId: 'send-1' })), 'workspace-1', 'message-legacy')
    expect(stored?.message.requestId).toBe('send-1')
  })

  it('still refuses a record that violates another field', async () => {
    const broken = JSON.stringify({ ...legacy, status: 'unknown-state' })
    await expect(readMessage(context(broken), 'workspace-1', 'message-legacy')).rejects.toThrow(/record schema/u)
  })
})
