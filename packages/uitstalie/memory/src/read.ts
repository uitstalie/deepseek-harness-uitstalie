/**
 * The `memory_read` conversation-surface reader.
 *
 * One call resolves an authorized target session to one completed turn — an
 * explicit turn number, the turn containing an event seq, or the latest turn
 * closed by `turn/end` — and renders that turn's conversation surface inside a
 * 16 KiB budget. User and assistant text is bounded per message to 2 KiB; every
 * tool call and result is one `- tool <name> · <status> · seq <n>` line with no
 * tool payload. Optional `before`/`after` counts extend the selected turn by
 * neighboring events, each bounded to ten.
 *
 * The caller's own session is always readable. Any other target must carry the
 * caller's exact `header.cwd`: the query service filters by target id and cwd,
 * and the observed header is compared again before its events are rendered. A
 * missing, unauthorized, or turn-less target returns a short text result rather
 * than throwing, so the model can recover and narrow its request.
 * @module @deepseek-ai/dsh-memory/read
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionResultFilter } from '@deepseek-ai/dsh-session-query'

/** Maximum rendered size of one `memory_read` result, in UTF-8 bytes. */
export const MEMORY_READ_MAX_BYTES = 16 * 1024

/** Maximum size of one user or assistant text in a read result, in UTF-8 bytes. */
export const MEMORY_READ_TEXT_MAX_BYTES = 2 * 1024

/** Maximum number of neighboring events one `before` or `after` value adds. */
export const MEMORY_READ_WINDOW_MAX_EVENTS = 10

/** Closing line appended when a read result reaches {@link MEMORY_READ_MAX_BYTES}. */
export const MEMORY_READ_NARROW_HINT = '(truncated at 16 KiB; narrow the turn range or use a seq window)'

/** Arguments accepted by `memory_read`. */
export interface MemoryReadRequest {
  /** Session to read; absent reads the caller's own session. */
  readonly sessionId?: string
  /** Completed turn number to read; absent falls through to `seq` or the latest turn. */
  readonly turn?: number
  /** Event seq whose containing turn to read. */
  readonly seq?: number
  /** Neighboring events to include before the selected turn, bounded to 10. */
  readonly before?: number
  /** Neighboring events to include after the selected turn, bounded to 10. */
  readonly after?: number
}

/** One turn closed by a matching `turn/start`..`turn/end` pair. */
interface TurnSpan {
  /** Turn number from the opening event. */
  readonly turn: number
  /** Index of `turn/start` in the observed log. */
  readonly startIndex: number
  /** Index of `turn/end` in the observed log. */
  readonly endIndex: number
  /** Seq of `turn/start`. */
  readonly startSeq: number
  /** Seq of `turn/end`. */
  readonly endSeq: number
}

/** One open `turn/start` awaiting its closing `turn/end`. */
interface OpenTurn {
  /** Turn number from the opening event. */
  readonly turn: number
  /** Index of `turn/start` in the observed log. */
  readonly startIndex: number
  /** Seq of `turn/start`. */
  readonly startSeq: number
}

/**
 * Read one authorized session's turn as a bounded conversation surface.
 * @param ctx - context carrying `sessionQuery`.
 * @param caller - owning agent session; its id and `header.cwd` define the authorization scope.
 * @param request - target session, turn or seq anchor, and neighbor counts.
 * @param signal - cancellation for the authorization query and the observation.
 * @returns the rendered turn, or a short text result when the target cannot be read.
 */
export async function readMemoryWindow(
  ctx: Context,
  caller: Session,
  request: MemoryReadRequest,
  signal: AbortSignal,
): Promise<string> {
  const target = request.sessionId === undefined ? caller.id : SessionId(request.sessionId)
  if (target !== caller.id && !(await workspaceAllows(ctx, caller, target, signal))) {
    return outsideWorkspace(target)
  }
  let header: SessionHeader
  let events: readonly SessionEvent[]
  {
    using observation = await ctx.sessionQuery.observeSession(target, { signal, projectionMode: 'none' })
    header = observation.header
    events = observation.events
  }
  /* The id and cwd filters above already select only this workspace; the header
   * comparison keeps the exact-cwd rule enforced by the authorization itself. */
  /* v8 ignore next -- defensive: the query filters cannot return another workspace. */
  if (header.cwd !== caller.header.cwd) return outsideWorkspace(target)
  const spans = foldCompletedTurns(events)
  const selected = selectTurn(spans, request)
  if (selected === undefined) return unresolved(target, request)
  return renderTurn(target, events, spans, selected, request)
}

/**
 * Test whether a target session exists in the caller's workspace.
 *
 * The caller's own session never reaches this check. A caller without a cwd has
 * no workspace to share, so every other target is refused.
 * @param ctx - context carrying `sessionQuery`.
 * @param caller - session that issued the read.
 * @param target - session id the read names.
 * @param signal - cancellation for the corpus listing.
 * @returns whether the target is the one session this workspace allows.
 */
async function workspaceAllows(
  ctx: Context,
  caller: Session,
  target: SessionId,
  signal: AbortSignal,
): Promise<boolean> {
  const cwd = caller.header.cwd
  if (cwd === undefined) return false
  const filters: readonly SessionResultFilter[] = [
    { kind: 'id', values: [target] },
    { kind: 'cwd', values: [cwd] },
  ]
  const records = await ctx.sessionQuery.filterSessions(filters, signal)
  return records.length === 1
}

/** Fold every matched `turn/start`..`turn/end` pair into a turn span. */
function foldCompletedTurns(events: readonly SessionEvent[]): TurnSpan[] {
  const spans: TurnSpan[] = []
  let open: OpenTurn | undefined
  for (const [index, event] of events.entries()) {
    switch (event.type) {
      case 'turn/start':
        open = { turn: event.data.turn, startIndex: index, startSeq: event.seq }
        break
      case 'turn/end': {
        const start = open
        /* The loop writes one matching turn/end per turn/start; this guard keeps
         * a repaired or hand-edited log from inventing a turn range. */
        /* v8 ignore next -- matched pairs are the only log shape the loop emits. */
        if (start?.turn !== event.data.turn) break
        spans.push({
          turn: start.turn,
          startIndex: start.startIndex,
          endIndex: index,
          startSeq: start.startSeq,
          endSeq: event.seq,
        })
        open = undefined
        break
      }
      default:
        break
    }
  }
  return spans
}

/**
 * Select the turn a request names.
 * @param spans - completed turns in log order.
 * @param request - turn or seq anchor; neither selects the latest completed turn.
 * @returns the selected span, or undefined when the anchor matches no completed turn.
 */
function selectTurn(
  spans: readonly TurnSpan[],
  request: MemoryReadRequest,
): TurnSpan | undefined {
  if (request.turn !== undefined) {
    return spans.findLast(span => span.turn === request.turn)
  }
  if (request.seq !== undefined) {
    const seq = request.seq
    return spans.find(span => span.startSeq <= seq && seq <= span.endSeq)
  }
  return spans.at(-1)
}

/** Render the selected turn and its optional neighbor window. */
function renderTurn(
  target: SessionId,
  events: readonly SessionEvent[],
  spans: readonly TurnSpan[],
  selected: TurnSpan,
  request: MemoryReadRequest,
): string {
  const startIndex = Math.max(0, selected.startIndex - clampNeighborCount(request.before))
  const endIndex = Math.min(events.length - 1, selected.endIndex + clampNeighborCount(request.after))
  const window = events.slice(startIndex, endIndex + 1)
  const [startTurn, endTurn] = windowTurns(spans, startIndex, endIndex, selected.turn)
  let startSeq = selected.startSeq
  let endSeq = selected.endSeq
  const chunks: string[] = []
  const toolNames = collectToolNames(events)
  for (const [index, event] of window.entries()) {
    if (index === 0) startSeq = event.seq
    endSeq = event.seq
    const chunk = renderEvent(event, toolNames)
    if (chunk !== undefined) chunks.push(chunk)
  }
  const header = `session ${target}, turn ${String(startTurn)}–${String(endTurn)}, seqs ${String(startSeq)}–${String(endSeq)}`
  return boundRead(header, chunks)
}

/** Clamp one model-supplied neighbor count into `0..MEMORY_READ_WINDOW_MAX_EVENTS`. */
function clampNeighborCount(count: number | undefined): number {
  if (count === undefined) return 0
  return Math.min(Math.max(Math.trunc(count), 0), MEMORY_READ_WINDOW_MAX_EVENTS)
}

/** Resolve the turn label of an event window that may cross into neighbor turns. */
function windowTurns(
  spans: readonly TurnSpan[],
  startIndex: number,
  endIndex: number,
  fallbackTurn: number,
): readonly [number, number] {
  let startTurn = fallbackTurn
  let endTurn = fallbackTurn
  for (const span of spans) {
    if (span.endIndex < startIndex) continue
    startTurn = span.turn
    break
  }
  for (const span of [...spans].reverse()) {
    if (span.startIndex > endIndex) continue
    endTurn = span.turn
    break
  }
  return [startTurn, endTurn]
}

/** Map every tool call id in the log to its tool name, so a partial window still names results. */
function collectToolNames(events: readonly SessionEvent[]): ReadonlyMap<string, string> {
  const names = new Map<string, string>()
  for (const event of events) {
    if (event.type !== 'tool/call') continue
    names.set(event.data.callId, event.data.name)
  }
  return names
}

/** Render one event as a conversation chunk, or undefined when it carries none. */
function renderEvent(event: SessionEvent, toolNames: ReadonlyMap<string, string>): string | undefined {
  switch (event.type) {
    case 'user/message':
      return event.data.source.kind === 'memory'
        ? undefined
        : textChunk('[user]', event.data.content)
    case 'assistant/message':
      return textChunk('[assistant]', event.data.message.content)
    case 'tool/call':
      return `- tool ${event.data.name} · called · seq ${String(event.seq)}`
    case 'tool/result': {
      const name = toolNames.get(event.data.message.toolCallId) ?? 'unknown'
      const status = event.data.message.isError === true ? 'error' : 'ok'
      return `- tool ${name} · ${status} · seq ${String(event.seq)}`
    }
    default:
      return undefined
  }
}

/** Render one message's text blocks, bounded per message; empty text renders nothing. */
function textChunk(prefix: string, content: readonly ContentBlock[]): string | undefined {
  const text = content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
    .trim()
  if (text.length === 0) return undefined
  return `${prefix} ${truncateToBytes(text, MEMORY_READ_TEXT_MAX_BYTES)}`
}

/** Join the header and chunks, truncating the complete text at the total budget. */
function boundRead(header: string, chunks: readonly string[]): string {
  const text = [header, ...chunks].join('\n')
  if (byteLength(text) <= MEMORY_READ_MAX_BYTES) return text
  const budget = MEMORY_READ_MAX_BYTES - byteLength(MEMORY_READ_NARROW_HINT) - 1
  return `${truncateToBytes(text, budget)}\n${MEMORY_READ_NARROW_HINT}`
}

/** Truncate text to a byte budget, appending an ellipsis when shortened. */
function truncateToBytes(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text
  const ellipsis = '…'
  let used = byteLength(ellipsis)
  const kept: string[] = []
  for (const character of text) {
    used += byteLength(character)
    if (used > maxBytes) break
    kept.push(character)
  }
  return `${kept.join('')}${ellipsis}`
}

/** Count UTF-8 bytes. */
function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/** Short text result for a target outside the caller's workspace. */
function outsideWorkspace(target: SessionId): string {
  return `memory_read: session ${target} is outside the caller workspace.`
}

/** Short text result for an anchor that matches no completed turn. */
function unresolved(target: SessionId, request: MemoryReadRequest): string {
  if (request.turn !== undefined) {
    return `memory_read: session ${target} has no completed turn ${String(request.turn)}.`
  }
  if (request.seq !== undefined) {
    return `memory_read: session ${target} has no turn containing seq ${String(request.seq)}.`
  }
  return `memory_read: session ${target} has no completed turns.`
}
