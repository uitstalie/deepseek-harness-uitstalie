/**
 * Request-layer guarantee that every assistant tool call is answered.
 *
 * The durable log pairs calls with results through `tool/result` recovery
 * (`dsh-session/repair`), but four surfaces can still hand the request builder
 * an unanswered call: a message projection or surface replace that removes a
 * result while keeping its call, a compaction summary boundary that keeps one
 * half of a pair, a crash-recovered history whose closer was never committed,
 * and a message another component appended between a call and its own result
 * (a tool handler's notice, an interrupting user message). Providers that
 * validate `tool_calls` pairing (DeepSeek Messages, kimi/OpenAI-compat) reject
 * such a request hard, and the failing turn cannot recover on its own because
 * every later request repeats the same history.
 *
 * Rather than dropping the model's words, each unanswered call is answered in the position its
 * answer would have had: the real result moves there when a later part of the history holds it,
 * and only a call whose result is gone receives a synthetic error tool message. The transcript
 * stays truthful — the model sees every call answered once — and the request becomes valid again.
 * The derived history is NOT rewritten; the next turn still sees the gap and repairs it the same
 * way.
 *
 * @module dsh-agent-loop/tool-pairing
 */

import type { Message, MessageId, ToolCallId, ToolResultMessage } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * The request builder placed the answer to assistant tool calls whose results the derived
     * history had lost or left outside their answering window (interruption, surface replace,
     * compaction boundary, an uncommitted crash closer, a notice between call and result) —
     * log-only, no surfaceOp. A synthetic result lives only in that one request, and a relocated
     * result is moved there; the log keeps the truthful order, and this event is the durable
     * record that the request was repaired.
     */
    'agent/tool-pair-repair': {
      turn: number
      step: number
      /** The repaired calls, in transcript order. */
      repaired: readonly { callId: ToolCallId; name: string }[]
    }
  }
}

/** One pairing fix, for the diagnostic event: a call whose answer the request builder had to place. */
export interface ToolPairRepair {
  /** The assistant message (by array index) carrying the repaired call. */
  readonly messageIndex: number
  /** The call whose answer was synthesized or relocated. */
  readonly callId: ToolCallId
  readonly name: string
}

/** The pairing pass's outcome: the messages to send plus what it had to place. */
export interface ToolPairingResult {
  readonly messages: Message[]
  readonly repairs: readonly ToolPairRepair[]
}

/** Model-visible wording of one synthesized error result. */
const ORPHAN_TEXT =
  'This tool call was recorded in the conversation history but no result was recorded for it '
  + '(the turn was interrupted, the result was compacted away, or a surface replace removed it). '
  + 'Its outcome is unknown. Decide whether to retry from the tool semantics: retry only if the '
  + 'operation is read-only or idempotent; if it may have side effects, first verify external '
  + 'state or ask the user. Do not retry blindly.'

/** One synthetic error result answering a call that has none. */
const syntheticResult = (callId: ToolCallId): ToolResultMessage => ({
  id: brandString<MessageId>(`pair-repair-${callId}`),
  role: 'tool',
  toolCallId: callId,
  isError: true,
  source: { kind: 'tool', callId },
  content: [{ type: 'text', text: ORPHAN_TEXT }],
})

/**
 * Answer every assistant tool call the request history leaves pending.
 *
 * Walks the derived messages in order, tracking open calls; each message boundary closes the
 * calls its assistant message opened once a following tool message answered them. A call still
 * open when its answer position passes is repaired in that slot: its real result moves there when
 * the history holds it (a notice, a user message or a later assistant message pushed it out of the
 * window), otherwise a synthetic error result stands in. Two answers for one call are as invalid
 * as none — the DeepSeek serializer rejects the duplicate as "tool result has no matching call",
 * and the request cannot recover because every later turn repeats the same history.
 *
 * Two window rules decide where a call's answers may sit, matching what strict providers
 * (kimi/OpenAI-compat) validate: every answer must follow its assistant message, and no second
 * assistant message may begin while a call of the previous one is still open. A surface replace
 * that shadows one result of a multi-call batch breaks the second rule without breaking
 * "answered at all", so both are repaired: the still-open calls receive their answer before the
 * next assistant message, moving a later real result rather than duplicating it. Tool results
 * answering an unknown call (their assistant message was compacted away) are kept: they pair with
 * nothing but violate no provider rule.
 *
 * @param messages - the derived request history (not mutated).
 * @returns the repaired history and the repairs it made, `repairs` empty when already paired.
 */
export const pairToolCalls = (messages: readonly Message[]): ToolPairingResult => {
  const out: Message[] = []
  const repairs: ToolPairRepair[] = []
  // Every real answer in the history, by call id, in transcript order. A call closed out of its
  // window takes the answer from here instead of receiving a second, synthetic one.
  const answers = new Map<ToolCallId, number[]>()
  for (const [index, message] of messages.entries()) {
    if (message.role !== 'tool') continue
    const positions = answers.get(message.toolCallId)
    if (positions === undefined) answers.set(message.toolCallId, [index])
    else positions.push(index)
  }
  // Answers already emitted early; their original position is skipped when the walk reaches it.
  const relocated = new Set<number>()
  // Calls the most recent assistant message opened, in order, with their names for diagnostics.
  let open: readonly { id: ToolCallId; name: string }[] = []
  let openIndex = -1
  const realAnswer = (callId: ToolCallId): Message | undefined => {
    const positions = answers.get(callId)
    while (positions !== undefined && positions.length > 0) {
      const index = positions.shift() as number
      // Only an answer after its own assistant message can fill that call's slot, and each real
      // answer serves one slot: the duplicate case this pass exists to prevent.
      if (index <= openIndex || relocated.has(index)) continue
      relocated.add(index)
      return messages[index]
    }
    return undefined
  }
  const flush = (): void => {
    for (const call of open) {
      out.push(realAnswer(call.id) ?? syntheticResult(call.id))
      repairs.push({ messageIndex: openIndex, callId: call.id, name: call.name })
    }
    open = []
    openIndex = -1
  }
  for (const [index, message] of messages.entries()) {
    // An answer this pass already moved into its slot; emitting it here would duplicate it.
    if (relocated.has(index)) continue
    if (message.role === 'assistant') {
      // A new assistant message ends the answering window of the previous one: providers reject a
      // second assistant message while a call is still open, so the open calls are answered now.
      flush()
      const calls = message.content.filter(block => block.type === 'tool-call')
      if (calls.length > 0) {
        open = calls.map(block => ({ id: (block as { id: ToolCallId }).id, name: (block as { name: string }).name }))
        openIndex = index
      }
      out.push(message)
      continue
    }
    if (message.role === 'tool') {
      const position = open.findIndex(call => call.id === message.toolCallId)
      if (position >= 0) open = open.filter((_, at) => at !== position)
      out.push(message)
      continue
    }
    // Any other role (user, system, developer) also ends the answering window.
    flush()
    out.push(message)
  }
  flush()
  return Object.freeze({ messages: out, repairs: Object.freeze(repairs) })
}
