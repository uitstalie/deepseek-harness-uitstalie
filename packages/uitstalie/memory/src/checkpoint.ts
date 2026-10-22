/**
 * Surface checkpoints for tiered turn summaries.
 *
 * A checkpoint is a `user/message` with the memory producer's `notice` source
 * plus a `window` naming the turn run and tier it replaces. The message replaces
 * either the raw turn's contiguous surface nodes or the previous memory
 * checkpoint for the same run. It never appends: a range that left the live
 * surface, contains a snapshot, or touches a compaction checkpoint is skipped
 * with a debug log, so the surface stays consistent with what a caller can see.
 * @module @deepseek-ai/dsh-memory/checkpoint
 */

import type { Context } from '@deepseek-ai/cordis'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageSource, UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionSeq, SurfaceEvent } from '@deepseek-ai/dsh-session'
import type { MemoryTier } from './memory-file.ts'
import type { TurnRange } from './window.ts'

/** Turn-window metadata carried by a memory checkpoint's source. */
export interface MemoryCheckpointWindow {
  /** First turn the checkpoint summarizes. */
  readonly from: number
  /** Last turn the checkpoint summarizes. */
  readonly to: number
  /** Tier of the summary text in the checkpoint. */
  readonly tier: MemoryTier
}

/** Content of one checkpoint replacement. */
export interface SurfaceCheckpoint {
  /** Model-visible summary or pointer text. */
  readonly text: string
  /** Tier the text represents. */
  readonly tier: MemoryTier
}

/** One resolved replacement target on the live surface. */
interface SurfaceTarget {
  /** First shadowed surface node. */
  readonly start: SessionSeq
  /** Last shadowed surface node. */
  readonly end: SessionSeq
  /** Every shadowed surface node, in surface order. */
  readonly seqs: readonly SessionSeq[]
}

/** Whether target resolution succeeded, with a reason when it did not. */
type SurfaceTargetResult =
  | { readonly ok: true; readonly target: SurfaceTarget }
  | { readonly ok: false; readonly reason: string }

/**
 * Replace one turn run on the live surface with a memory checkpoint.
 *
 * Resolution order is the recorded checkpoint seq, a live memory checkpoint
 * whose window matches the same turns, then the raw turn's surface nodes. A raw
 * target must be a non-empty contiguous run that contains no memory snapshot
 * and no compaction checkpoint. The append is attempted once; a surface refusal
 * skips the range without appending, and the next pass recomputes from the live
 * surface.
 * @param ctx - context carrying `sessionQuery` and the logger.
 * @param session - session whose surface receives the checkpoint.
 * @param range - turn run and its recorded checkpoint seq, when known.
 * @param checkpoint - summary text and tier to publish.
 * @returns the new checkpoint seq, or undefined when the range was skipped.
 */
export async function replaceSurfaceRange(
  ctx: Context,
  session: Session,
  range: TurnRange,
  checkpoint: SurfaceCheckpoint,
): Promise<SessionSeq | undefined> {
  if (checkpoint.text.trim().length === 0) {
    ctx.logger.debug(
      'memory: skipping checkpoint for turns %d–%d because its text is empty',
      range.startTurn,
      range.endTurn,
    )
    return undefined
  }
  const surface = await ctx.sessionQuery.readSurface(session.id)
  const resolved = resolveSurfaceTarget(surface.events, range)
  if (!resolved.ok) {
    ctx.logger.debug(
      'memory: skipping checkpoint for turns %d–%d: %s',
      range.startTurn,
      range.endTurn,
      resolved.reason,
    )
    return undefined
  }
  const message = createCheckpointMessage(range, checkpoint)
  const target = resolved.target
  try {
    return session.append('user/message', message, {
      surfaceOp: { op: 'replace', startSeq: target.start, endSeq: target.end },
      sourceEventSeqs: [...target.seqs],
    }).seq
  } catch (error: unknown) {
    ctx.logger.debug(
      'memory: surface refused the checkpoint for turns %d–%d: %s',
      range.startTurn,
      range.endTurn,
      errorMessage(error),
    )
    return undefined
  }
}

/**
 * Test whether a persisted source is a memory checkpoint.
 * @param source - source restored from a surface user message.
 * @returns whether the source carries the memory checkpoint window.
 */
export function isMemoryCheckpointSource(source: MessageSource): boolean {
  return checkpointWindow(source) !== undefined
}

/** Read the checkpoint window from a merge-extensible message source. */
function checkpointWindow(source: MessageSource): MemoryCheckpointWindow | undefined {
  const candidate: { readonly kind?: string; readonly form?: string; readonly window?: MemoryCheckpointWindow } = source
  if (candidate.kind !== 'memory' || candidate.form !== 'notice') return undefined
  return candidate.window
}

/** Resolve a range against the current live surface. */
function resolveSurfaceTarget(events: readonly SurfaceEvent[], range: TurnRange): SurfaceTargetResult {
  if (range.checkpointSeq !== undefined) {
    return recordedCheckpointTarget(events, range.checkpointSeq)
  }
  const matching = matchingWindowTarget(events, range)
  if (matching !== undefined) return { ok: true, target: matching }
  return rawTurnTarget(events, range)
}

/** Resolve an explicitly recorded checkpoint seq. */
function recordedCheckpointTarget(events: readonly SurfaceEvent[], seq: number): SurfaceTargetResult {
  const event = events.find(candidate => candidate.seq === seq)
  if (event === undefined) return { ok: false, reason: `recorded checkpoint seq ${String(seq)} is not on the surface` }
  if (event.type !== 'user/message' || !isMemoryCheckpointSource(event.data.source)) {
    return { ok: false, reason: `recorded seq ${String(seq)} is not a memory checkpoint` }
  }
  return { ok: true, target: { start: event.seq, end: event.seq, seqs: [event.seq] } }
}

/** Find one live memory checkpoint that already covers the same turn run. */
function matchingWindowTarget(events: readonly SurfaceEvent[], range: TurnRange): SurfaceTarget | undefined {
  let target: SurfaceTarget | undefined
  for (const event of events) {
    if (event.type !== 'user/message') continue
    const window = checkpointWindow(event.data.source)
    if (window === undefined || window.from !== range.startTurn || window.to !== range.endTurn) continue
    target = { start: event.seq, end: event.seq, seqs: [event.seq] }
  }
  return target
}

/** Resolve the raw turn's contiguous surface nodes. */
function rawTurnTarget(events: readonly SurfaceEvent[], range: TurnRange): SurfaceTargetResult {
  const indices: number[] = []
  for (const [index, event] of events.entries()) {
    if (event.seq >= range.seq[0] && event.seq <= range.seq[1]) indices.push(index)
  }
  const first = indices[0]
  const last = indices.at(-1)
  if (first === undefined || last === undefined) {
    return { ok: false, reason: `no surface nodes in seq ${String(range.seq[0])}–${String(range.seq[1])}` }
  }
  if (last - first + 1 !== indices.length) {
    return { ok: false, reason: 'the turn nodes are not contiguous on the surface' }
  }
  const selected = indices.map(index => events[index] as SurfaceEvent)
  for (const event of selected) {
    if (event.type === 'user/message' && isSnapshotSource(event.data.source)) {
      return { ok: false, reason: 'the range contains a memory snapshot' }
    }
    if (event.type === 'user/message' && isCompactionCheckpoint(event.data.source)) {
      return { ok: false, reason: 'the range contains a compaction checkpoint' }
    }
  }
  if (selected.some(event => event.type === 'user/message' && isMemoryCheckpointSource(event.data.source))) {
    return { ok: false, reason: 'the raw range contains a memory checkpoint with another window' }
  }
  const start = selected[0]?.seq
  const end = selected.at(-1)?.seq
  if (start === undefined || end === undefined) {
    return { ok: false, reason: 'the turn range has no surface nodes' }
  }
  return { ok: true, target: { start, end, seqs: selected.map(event => event.seq) } }
}

/** Whether a source is the memory producer's snapshot form. */
function isSnapshotSource(source: MessageSource): boolean {
  const candidate: { readonly kind?: string; readonly form?: string } = source
  return candidate.kind === 'memory' && candidate.form === 'snapshot'
}

/** Whether a merge-extensible source is a compaction checkpoint. */
function isCompactionCheckpoint(source: MessageSource): boolean {
  const kind: string = source.kind
  return kind === 'compact-checkpoint'
}

/** Build the model-facing checkpoint message. */
function createCheckpointMessage(range: TurnRange, checkpoint: SurfaceCheckpoint): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: checkpoint.text }],
    source: {
      kind: 'memory',
      form: 'notice',
      summary: boundContextSummary(checkpoint.text),
      window: { from: range.startTurn, to: range.endTurn, tier: checkpoint.tier },
    },
  })
}

/** Flatten a thrown value into one line. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
