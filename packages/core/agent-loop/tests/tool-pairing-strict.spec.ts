/**
 * The request history handed to a strict provider must satisfy that provider's
 * tool-call pairing rules, whatever the durable log holds. `pairToolCalls` is the
 * only pass between the derived history and the wire, so these cases run its
 * output through a strict local serializer: the rules DeepSeek Messages and
 * OpenAI-compatible providers enforce, and the request that failed here is
 * exactly the one a violation produces (every later turn repeats it).
 * @module dsh-agent-loop/tests/tool-pairing-strict
 */
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Message, MessageId, ToolCallId, ToolResultMessage } from '@deepseek-ai/dsh-llm'
import { pairToolCalls } from '../src/tool-pairing.ts'

const id = (text: string) => brandString<MessageId>(text)
const callId = (text: string) => brandString<ToolCallId>(text)

const assistant = (calls: readonly { id: string; name: string }[], text = ''): Message => ({
  id: id(`assistant-${calls.map(call => call.id).join('-')}${text}`),
  role: 'assistant',
  source: { kind: 'model', provider: 'mock', model: 'mock' },
  content: [
    ...text === '' ? [] : [{ type: 'text' as const, text }],
    ...calls.map(call => ({ type: 'tool-call' as const, id: callId(call.id), name: call.name, arguments: '{}' })),
  ],
})

const tool = (call: string, isError = false): Message => ({
  id: id(`tool-${call}`),
  role: 'tool',
  toolCallId: callId(call),
  isError,
  source: { kind: 'tool', callId: callId(call) },
  content: [{ type: 'text', text: isError ? 'error' : 'ok' }],
})

const user = (text: string): Message => ({
  id: id(`user-${text}`),
  role: 'user',
  source: { kind: 'user' } as never,
  content: [{ type: 'text', text }],
})

/**
 * Reject a history a strict provider would 400, using that provider's rules:
 * every tool message answers exactly one open call, no call is answered twice,
 * and no call stays open once a non-tool message begins.
 * @param messages - request history in wire order.
 * @throws when the history is not provider-legal.
 */
function assertStrictPairing(messages: readonly Message[]): void {
  const open = new Set<string>()
  const answered = new Set<string>()
  for (const [index, message] of messages.entries()) {
    if (message.role === 'assistant') {
      if (open.size > 0) throw new Error(`assistant message at ${String(index)} while calls ${[...open].join(',')} are open`)
      for (const block of message.content) {
        if (block.type !== 'tool-call') continue
        if (answered.has(String(block.id)) || open.has(String(block.id))) throw new Error(`duplicate tool call ${String(block.id)}`)
        open.add(String(block.id))
      }
      continue
    }
    if (message.role === 'tool') {
      const call = String(message.toolCallId)
      if (!open.has(call)) throw new Error(`tool result ${call} at ${String(index)} answers no open call`)
      if (answered.has(call)) throw new Error(`tool result ${call} answered twice`)
      open.delete(call)
      answered.add(call)
      continue
    }
    if (open.size > 0) throw new Error(`${message.role} message at ${String(index)} while calls ${[...open].join(',')} are open`)
  }
  if (open.size > 0) throw new Error(`history ends with open calls ${[...open].join(',')}`)
}

describe('pairToolCalls output is legal for a strict provider serializer', () => {
  it('repairs a compaction cut that split a call from its result', () => {
    const split = [
      user('summarized'),
      assistant([{ id: 'kept', name: 'read' }]),
      tool('kept'),
      // The compaction boundary kept this call and shadowed its result.
      assistant([{ id: 'cut', name: 'pwsh' }]),
      assistant([], 'next'),
    ]
    expect(() => assertStrictPairing(split)).toThrow(/assistant message/u)
    const repaired = pairToolCalls(split)
    expect(repaired.repairs.map(repair => String(repair.callId))).toEqual(['cut'])
    expect(() => assertStrictPairing(repaired.messages)).not.toThrow()
    expect(repaired.messages.filter(message => message.role === 'tool').map(message => String(message.toolCallId)))
      .toEqual(['kept', 'cut'])
  })

  it('repairs an interrupted turn that left the call unanswered', () => {
    const interrupted = [
      user('go'),
      assistant([{ id: 'aborted', name: 'write' }]),
      // The step was interrupted before the executor committed a result.
      user('continue'),
    ]
    expect(() => assertStrictPairing(interrupted)).toThrow(/user message at 2 while calls aborted are open/u)
    const repaired = pairToolCalls(interrupted)
    expect(() => assertStrictPairing(repaired.messages)).not.toThrow()
    const synthesized = repaired.messages[2] as ToolResultMessage
    expect(String(synthesized.toolCallId)).toBe('aborted')
    expect(synthesized.isError).toBe(true)
  })

  it('drops a duplicate result so the call is answered once', () => {
    const duplicated = [
      user('go'),
      assistant([{ id: 'dup', name: 'read' }]),
      tool('dup'),
      // A surface replace re-appended the same call's result.
      tool('dup'),
      assistant([], 'done'),
    ]
    expect(() => assertStrictPairing(duplicated)).toThrow(/answers no open call/u)
    const repaired = pairToolCalls(duplicated)
    expect(repaired.dropped.map(drop => [String(drop.callId), drop.reason])).toEqual([['dup', 'duplicate']])
    expect(() => assertStrictPairing(repaired.messages)).not.toThrow()
    expect(repaired.messages.filter(message => message.role === 'tool')).toHaveLength(1)
  })

  it('keeps a repaired request legal when all three causes appear together', () => {
    const mixed = [
      user('go'),
      assistant([{ id: 'cut', name: 'pwsh' }]),
      // ① compaction cut the answer away; ② an interrupted call follows; ③ a duplicate result.
      tool('other'),
      assistant([{ id: 'aborted', name: 'write' }], 'continuing'),
      tool('cut'),
      tool('cut'),
      assistant([], 'done'),
    ]
    expect(() => assertStrictPairing(mixed)).toThrow()
    const repaired = pairToolCalls(mixed)
    expect(() => assertStrictPairing(repaired.messages)).not.toThrow()
    const answers = repaired.messages.filter(message => message.role === 'tool').map(message => String(message.toolCallId))
    expect(new Set(answers).size).toBe(answers.length)
  })
})
