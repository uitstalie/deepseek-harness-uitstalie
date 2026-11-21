/** The mounted gate keeps a dispatched turn open once, then blocks it, and stays off when disabled. */
import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  update: vi.fn(async () => undefined),
  list: vi.fn(async () => [{ sourceSessionId: 'session-22222222-2222-2222-2222-222222222222', targetSessionId: 'session-other', status: 'delivered', createdAt: new Date(1_000).toISOString() }]),
}))
vi.mock('../src/store.ts', () => ({ listMessages: mocks.list, updateDispatchReplyState: mocks.update }))
vi.mock('../src/scope.ts', () => ({ resolveWorkspace: async () => ({ workspace: { id: 'w1' } }) }))

const { mountReplyGate } = await import('../src/reply-gate.ts')

const HEADER = '[workspace_message] from agent session-11111111-1111-1111-1111-111111111111 in W (w1)\nTask t1 · reply to session-11111111-1111-1111-1111-111111111111 with workspace_message.send'

type Handlers = Map<string, unknown>

function harness(mode: 'off' | 'enforce') {
  const handlers: Handlers = new Map()
  const appended: unknown[] = []
  const ctx = {
    on: (name: string, handler: unknown) => { handlers.set(name, handler); return () => {} },
    logger: { warn: () => {} },
  }
  mountReplyGate(ctx as never, { mode })
  const session = { id: 'session-22222222-2222-2222-2222-222222222222' }
  const agent = { session, inbox: { append: (_target: string, message: unknown) => { appended.push(message) } } }
  const sessionEvent = (event: { type: string; time: number; data: unknown }) => (handlers.get('session/event') as (s: unknown, e: unknown) => void)(session, event)
  return { handlers, appended, sessionEvent, session, agent }
}

describe('mountReplyGate', () => {
  it('lets the first miss steer, then blocks the turn and records pendingReply', async () => {
    const h = harness('enforce')
    h.sessionEvent({ type: 'turn/start', time: 1_000, data: { turn: 7 } })
    h.sessionEvent({ type: 'user/message', time: 1_001, data: { content: [{ type: 'text', text: HEADER }] } })
    const stopping = h.handlers.get('agent/turn-stopping') as (p: unknown) => Promise<{ blocked?: string } | undefined>
    expect(await stopping({ agent: h.agent, turn: 7 })).toBeUndefined()
    expect(h.appended).toHaveLength(1)
    expect(mocks.update).toHaveBeenCalledWith(expect.anything(), 'w1', 'session-11111111-1111-1111-1111-111111111111', 'session-22222222-2222-2222-2222-222222222222', { replyRemindedAt: expect.any(String) })
    expect(await stopping({ agent: h.agent, turn: 7 })).toEqual({ blocked: expect.stringContaining('workspace_message.send') })
    expect(mocks.update).toHaveBeenLastCalledWith(expect.anything(), 'w1', 'session-11111111-1111-1111-1111-111111111111', 'session-22222222-2222-2222-2222-222222222222', { pendingReplyAt: expect.any(String), pendingReplyTurn: 7 })
    expect(h.appended).toHaveLength(1)
  })

  it('registers nothing when the gate is off', () => {
    const h = harness('off')
    expect(h.handlers.size).toBe(0)
  })
})
