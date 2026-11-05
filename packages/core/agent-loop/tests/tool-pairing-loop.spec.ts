/**
 * The loop's request builder never sends an assistant tool call without its
 * answer: an aborted turn's live-step recovery already pairs the durable log,
 * and a surface replace or projection that deletes a result is repaired
 * request-locally with a synthetic error result — plus a log-only
 * `agent/tool-pair-repair` event so the repair is auditable.
 * @module dsh-agent-loop/tests/tool-pairing-loop
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'

async function harness(adapter: MockAdapter) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function send(agent: Agent, text: string) {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
}

/** Every tool-call id in one request's assistant history, with the tool-role ids that answer them. */
function pairings(messages: readonly { role: string; content?: readonly { type: string; id?: string }[]; toolCallId?: string }[]) {
  const calls: string[] = []
  const answers: string[] = []
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const block of message.content ?? []) if (block.type === 'tool-call') calls.push(String(block.id))
    } else if (message.role === 'tool') {
      answers.push(String(message.toolCallId))
    }
  }
  return { calls, answers }
}

describe('request tool-call pairing at the loop boundary', () => {
  it('an aborted turn reaches the next request fully paired (log recovery, no request repair)', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('hung', 'never-answers', {}),
      textResponse('second turn'),
    ])
    const ctx = await harness(adapter)
    try {
      ctx.tools.register(defineContentToolFixture({
        name: 'never-answers',
        description: 'must not run after cancellation',
        parameters: {},
        execute: () => new Promise(() => {}), // never settles: the cancel closes the turn
      }))
      const agent = await ctx.agentLoop.create(SessionId('pair-after-abort'), { provider: 'mock', model: 'mock' })
      // Cancel once the model's tool call is committed, before the tool settles.
      const dispose = ctx.on('session/event', (session, event) => {
        if (session === agent.session && event.type === 'assistant/message') {
          agent.cancel({ kind: 'user' })
        }
      })

      send(agent, 'run the tool')
      await waitForIdle(ctx, agent)
      dispose()

      // The log itself was balanced: the cancelled call received its interrupted-cause result.
      const events = agent.session.snapshotEvents()
      const result = events.find(e => e.type === 'tool/result')
      expect(result?.type === 'tool/result' ? result.data.message.toolCallId : undefined).toBe('hung')

      send(agent, 'continue')
      await waitForIdle(ctx, agent)
      const request = adapter.requests[1]!
      const { calls, answers } = pairings(request.messages)
      expect(calls).toEqual(answers)
      expect(agent.session.snapshotEvents().some(e => e.type === 'agent/tool-pair-repair')).toBe(false)
      expect(adapter.requests[1]!.messages.length).toBeGreaterThan(0)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('a surface replace that removes a result is repaired in the request, and the repair is logged', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('victim', 'echo-fixture', { text: 'x' }),
      textResponse('second request'),
    ])
    const ctx = await harness(adapter)
    try {
      ctx.tools.register(defineContentToolFixture({
        name: 'echo-fixture',
        description: 'a tool that echoes its input',
        parameters: { text: { type: 'string', description: 'the text to echo' } },
        execute: async args => [{ type: 'text', text: args.text ?? '' }],
      }))
      const agent = await ctx.agentLoop.create(SessionId('pair-after-replace'), { provider: 'mock', model: 'mock' })

      send(agent, 'call the tool')
      await agent.whenIdle()

      // A compaction-style replace shadows the tool/result while the assistant call stays live —
      // exactly the c25e7107 shape (prune shadowed one result of a batch).
      const resultEvent = agent.session.snapshotEvents().find(e => e.type === 'tool/result')!
      agent.session.append('user/message',
        createUserMessage({ content: [{ type: 'text', text: '(result shadowed)' }], source: { kind: 'user' } }),
        { surfaceOp: { op: 'replace', startSeq: resultEvent.seq, endSeq: resultEvent.seq }, sourceEventSeqs: [resultEvent.seq] })
      const derived = agent.session.deriveMessages()
      expect(derived.some(m => m.role === 'tool'
        && String((m as { toolCallId?: string }).toolCallId) === 'victim')).toBe(false)

      send(agent, 'continue')
      await agent.whenIdle()

      // The turn the follow-up opens repairs its FIRST request — the one that still carries the
      // shadowed call unanswered (the first turn's later step already contained the real result).
      const request = adapter.requests[2]!
      const { calls, answers } = pairings(request.messages)
      expect(calls).toContain('victim')
      expect(answers).toContain('victim')
      // The synthetic error answer is the only result the request carries for the shadowed call.
      const results = request.messages.filter(m => m.role === 'tool'
        && String((m as { toolCallId?: string }).toolCallId) === 'victim')
      expect(results).toHaveLength(1)
      expect((results[0] as { isError?: boolean }).isError).toBe(true)
      expect(JSON.stringify(results[0])).toContain('no result was recorded')
      // The repair is a durable, log-only fact.
      const repair = agent.session.snapshotEvents().find(e => e.type === 'agent/tool-pair-repair')
      expect(repair).toBeDefined()
      // The derived history keeps the truthful gap — only the request was repaired.
      expect(agent.session.deriveMessages()
        .some(m => m.role === 'tool' && String((m as { toolCallId?: string }).toolCallId) === 'victim')).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('a compaction-style range replace that drops a result is repaired the same way', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('summarized-call', 'echo-fixture', { text: 'x' }),
      textResponse('second request'),
    ])
    const ctx = await harness(adapter)
    try {
      ctx.tools.register(defineContentToolFixture({
        name: 'echo-fixture',
        description: 'a tool that echoes its input',
        parameters: { text: { type: 'string', description: 'the text to echo' } },
        execute: async args => [{ type: 'text', text: args.text ?? '' }],
      }))
      const agent = await ctx.agentLoop.create(SessionId('pair-after-compaction'), { provider: 'mock', model: 'mock' })

      send(agent, 'call the tool')
      await agent.whenIdle()

      // A compaction summary shadows the call AND its result together, so a real compaction
      // boundary never orphans a call; the request simply stops carrying the pair.
      const events = agent.session.snapshotEvents()
      const assistant = events.find(e => e.type === 'assistant/message')!
      const result = events.find(e => e.type === 'tool/result')!
      agent.session.append('user/message',
        createUserMessage({ content: [{ type: 'text', text: '(summary of earlier work)' }], source: { kind: 'compact-checkpoint', compactionId: 'test' as never } }),
        { surfaceOp: { op: 'replace', startSeq: assistant.seq, endSeq: result.seq }, sourceEventSeqs: [assistant.seq, result.seq] })
      send(agent, 'continue')
      await agent.whenIdle()
      const request = adapter.requests.at(-1)!
      const { calls, answers } = pairings(request.messages)
      expect(calls).not.toContain('summarized-call')
      expect(answers).not.toContain('summarized-call')
      expect(agent.session.snapshotEvents().some(e => e.type === 'agent/tool-pair-repair')).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
