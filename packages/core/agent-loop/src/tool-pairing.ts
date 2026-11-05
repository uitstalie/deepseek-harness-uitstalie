/**
 * Request-layer guarantee that every assistant tool call is answered.
 *
 * The durable log pairs calls with results through `tool/result` recovery
 * (`dsh-session/repair`), but three surfaces can still hand the request builder
 * an unanswered call: a message projection or surface replace that removes a
 * result while keeping its call, a compaction summary boundary that keeps one
 * half of a pair, and a crash-recovered history whose closer was never
 * committed. Providers that validate `tool_calls` pairing (kimi/OpenAI-compat)
 * answer such a request with a hard 400, and the failing turn cannot recover on
 * its own because every later request repeats the same history.
 *
 * Rather than dropping the model's words, each unanswered call receives a
 * synthetic error tool message at the position its answer would have had. The
 * transcript stays truthful — the model sees its call was never answered — and
 * the request becomes valid again. The derived history is NOT rewritten; the
 * next turn still sees the gap and repairs it the same way.
 *
 * @module dsh-agent-loop/tool-pairing
 */

import type { Message, MessageId, ToolCallId, ToolResultMessage } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * The request builder answered assistant tool calls whose results the derived history had
     * lost (interruption, surface replace, compaction boundary, an uncommitted crash closer) —
     * log-only, no surfaceOp. The synthetic results live only in that one request; the log keeps
     * the truthful gap, and this event is the durable record that the request was repaired.
     */
    'agent/tool-pair-repair': {
      turn: number
      step: number
      /** The unanswered calls, in transcript order. */
      repaired: readonly { callId: ToolCallId; name: string }[]
    }
  }
}

/** One synthesized pairing fix, for the diagnostic event. */
export interface ToolPairRepair {
  /** The assistant message (by array index) carrying the unanswered call. */
  readonly messageIndex: number
  /** The unanswered call that received a synthetic result. */
  readonly callId: ToolCallId
  readonly name: string
}

/** The pairing pass's outcome: the messages to send plus what it had to invent. */
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
 * open when its answer position passes receives a synthetic error result immediately after the
 * last real answer of that batch — the exact slot providers require it in.
 *
 * Two window rules decide where a call's answers may sit, matching what strict providers
 * (kimi/OpenAI-compat) validate: every answer must follow its assistant message, and no second
 * assistant message may begin while a call of the previous one is still open. A surface replace
 * that shadows one result of a multi-call batch breaks the second rule without breaking
 * "answered at all", so both are repaired: the still-open calls receive synthetic error results
 * before the next assistant message. Tool results answering an unknown call (their assistant
 * message was compacted away) are kept: they pair with nothing but violate no provider rule.
 *
 * @param messages - the derived request history (not mutated).
 * @returns the repaired history and the repairs it made, `repairs` empty when already paired.
 */
export const pairToolCalls = (messages: readonly Message[]): ToolPairingResult => {
  const out: Message[] = []
  const repairs: ToolPairRepair[] = []
  // Calls the most recent assistant message opened, in order, with their names for diagnostics.
  let open: readonly { id: ToolCallId; name: string }[] = []
  let openIndex = -1
  const flush = (): void => {
    for (const call of open) {
      out.push(syntheticResult(call.id))
      repairs.push({ messageIndex: openIndex, callId: call.id, name: call.name })
    }
    open = []
    openIndex = -1
  }
  for (const [index, message] of messages.entries()) {
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
