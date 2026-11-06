/**
 * The request-layer tool-call pairing guarantee: an assistant tool call whose
 * result the derived history lost must never reach the provider unanswered.
 * @module dsh-agent-loop/tests/tool-pairing
 */
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Message, MessageId, ToolCallId, ToolResultMessage } from '@deepseek-ai/dsh-llm'
import { pairToolCalls } from '../src/tool-pairing.ts'

const id = (text: string) => brandString<MessageId>(text)

const assistant = (calls: readonly { id: string; name: string }[], text = ''): Message => ({
  id: id(`assistant-${calls.map(call => call.id).join('-')}`),
  role: 'assistant',
  source: { kind: 'model', provider: 'mock', model: 'mock' },
  content: [
    ...text === '' ? [] : [{ type: 'text' as const, text }],
    ...calls.map(call => ({
      type: 'tool-call' as const,
      id: brandString<ToolCallId>(call.id),
      name: call.name,
      arguments: '{}',
    })),
  ],
})

const tool = (callId: string): Message => ({
  id: id(`tool-${callId}`),
  role: 'tool',
  toolCallId: brandString<ToolCallId>(callId),
  isError: false,
  source: { kind: 'tool', callId: brandString<ToolCallId>(callId) },
  content: [{ type: 'text', text: 'ok' }],
})

const user = (text: string): Message => ({
  id: id(`user-${text}`),
  role: 'user',
  source: { kind: 'user' } as never,
  content: [{ type: 'text', text }],
})

const roles = (messages: readonly Message[]): string[] => messages.map(message => message.role)

describe('pairToolCalls: the request never carries an unanswered tool call', () => {
  it('returns a paired history untouched', () => {
    const history = [
      user('go'),
      assistant([{ id: 'c1', name: 'read' }]),
      tool('c1'),
      assistant([], 'done'),
    ]
    const result = pairToolCalls(history)
    expect(result.repairs).toEqual([])
    expect(result.messages).toEqual(history)
  })

  it('synthesizes an error result for an interrupted call (cancel after model commit)', () => {
    const history = [
      user('go'),
      assistant([{ id: 'c1', name: 'pwsh' }], 'running it'),
      // The turn was aborted before the tool answered; the next request must still pair.
      user('what happened'),
    ]
    const result = pairToolCalls(history)
    expect(result.repairs).toHaveLength(1)
    expect(result.repairs[0]?.callId).toBe('c1')
    expect(result.repairs[0]?.name).toBe('pwsh')
    const synthesized = result.messages[2] as ToolResultMessage
    expect(synthesized.role).toBe('tool')
    expect(synthesized.toolCallId).toBe('c1')
    expect(synthesized.isError).toBe(true)
    expect((synthesized.content[0] as { text: string }).text).toMatch(/no result was recorded/u)
    // The synthetic result sits exactly where providers require it: before the next user message.
    expect(roles(result.messages)).toEqual(['user', 'assistant', 'tool', 'user'])
    // The input is not mutated.
    expect(history).toHaveLength(3)
  })

  it('synthesizes results after a surface replace removed the originals', () => {
    const history = [
      assistant([{ id: 'a', name: 'read' }, { id: 'b', name: 'pwsh' }]),
      tool('a'),
      // b's result was shadowed by a replace; the call remains.
      user('continue'),
    ]
    const result = pairToolCalls(history)
    expect(result.repairs.map(repair => repair.callId)).toEqual(['b'])
    expect(roles(result.messages)).toEqual(['assistant', 'tool', 'tool', 'user'])
    expect((result.messages[2] as ToolResultMessage).toolCallId).toBe('b')
  })

  it('pairs across a compaction boundary: a summary keeps the call, the result stayed shadowed', () => {
    const history = [
      user('summarized work'),
      // The compaction summary shadows the middle, then an answered pair, then an orphaned call.
      assistant([{ id: 'kept', name: 'read' }]),
      tool('kept'),
      assistant([{ id: 'orphan', name: 'pwsh' }]),
      assistant([], 'final text'),
    ]
    const result = pairToolCalls(history)
    expect(result.repairs.map(repair => repair.callId)).toEqual(['orphan'])
    expect(roles(result.messages)).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool', 'assistant'])
  })

  it('keeps a tool result whose call was compacted away (no pairing violation)', () => {
    const history = [
      user('context'),
      // The assistant message was shadowed; its result survived the replace.
      tool('gone-call'),
      assistant([], 'noted'),
    ]
    const result = pairToolCalls(history)
    expect(result.repairs).toEqual([])
    expect(result.messages).toEqual(history)
  })

  it('answers every call of a multi-call assistant message', () => {
    const history = [
      assistant([{ id: 'x', name: 'read' }, { id: 'y', name: 'pwsh' }, { id: 'z', name: 'glob' }]),
      tool('y'),
      user('next'),
    ]
    const result = pairToolCalls(history)
    expect(result.repairs.map(repair => repair.callId)).toEqual(['x', 'z'])
    expect(roles(result.messages)).toEqual(['assistant', 'tool', 'tool', 'tool', 'user'])
  })

  it('closes a trailing open call at the end of history', () => {
    const history = [user('go'), assistant([{ id: 'tail', name: 'pwsh' }])]
    const result = pairToolCalls(history)
    expect(result.repairs.map(repair => repair.callId)).toEqual(['tail'])
    expect((result.messages.at(-1) as ToolResultMessage).toolCallId).toBe('tail')
  })

  it('relocates a real answer that a notice split away from its call', () => {
    // The memory plugin appends its "Memory updated" notice from inside the tool handler, so the
    // notice lands between the call and the call's own result. Synthesizing a second answer made
    // the DeepSeek serializer reject the request ("tool result has no matching call") on every
    // turn, which bricked the Session: the gap is durable, so each retry repeated it.
    const history = [
      user('go'),
      assistant([{ id: 'm1', name: 'memory_write' }]),
      user('Memory updated: - [decision] sandbox tiers'),
      tool('m1'),
      assistant([], 'done'),
    ]
    const result = pairToolCalls(history)
    expect(result.repairs.map(repair => repair.callId)).toEqual(['m1'])
    // One answer, moved into the slot providers require, then the notice.
    expect(roles(result.messages)).toEqual(['user', 'assistant', 'tool', 'user', 'assistant'])
    expect(result.messages.filter(message => message.role === 'tool')).toHaveLength(1)
    expect((result.messages[2] as ToolResultMessage).toolCallId).toBe('m1')
  })

  it('relocates a result shadowed out of order instead of answering its call twice', () => {
    // A two-call batch whose second result was shadowed by a prune replace, so the NEXT assistant
    // message starts while the call is still open — kimi answers the whole request 400
    // ("tool_call_ids did not have response messages"). The answer still exists later in the
    // history, so it moves into its window rather than being duplicated by a synthetic result.
    const history = [
      assistant([{ id: 'first', name: 'read' }, { id: 'shadowed', name: 'pwsh' }]),
      tool('first'),
      // shadowed's result sat here once; a replace removed it from the derived surface.
      assistant([{ id: 'next', name: 'read' }]),
      tool('next'),
      tool('shadowed'), // the answer exists, but out of its window
      user('go on'),
    ]
    const result = pairToolCalls(history)
    expect(result.repairs.map(repair => repair.callId)).toEqual(['shadowed'])
    // The real answer lands before the second assistant message and is not repeated later.
    expect(roles(result.messages)).toEqual(['assistant', 'tool', 'tool', 'assistant', 'tool', 'user'])
    expect(result.messages.filter(message => message.role === 'tool')).toHaveLength(3)
    expect((result.messages[2] as ToolResultMessage).toolCallId).toBe('shadowed')
  })
})
