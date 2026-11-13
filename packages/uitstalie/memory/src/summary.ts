/**
 * The memory summary job: one completed turn becomes one detail section of
 * MEMORY.md.
 *
 * The organizer hands every completed root turn to `MemorySummaryRunner`. With
 * `summarizeEveryTurns = 1` the runner keeps the previous per-turn behavior:
 * a turn that completes while a job runs leaves one pending input, and the job
 * settles into exactly one follow-up pass. A larger value accumulates turns
 * and sends one strict `{ turns: [...] }` request per batch, then writes every
 * turn's entries and frontmatter record in one version-guarded append; a
 * partial batch flushes when the session is disposed. Each pass reads only the
 * selected turns' conversation surface, asks the routed or configured model
 * for strict JSON, appends through the repository, migrates aged sections
 * through the same target, and refreshes the durable snapshot.
 *
 * Failures are contained. A model or repository failure before the detail append
 * leaves the previous MEMORY.md in place and appends one notice message per
 * session; a migration failure after a committed detail append keeps that
 * summary and only logs. Cancellation before a write leaves no new state. The
 * job owns no model surface of its own, so its output ring stays empty.
 * @module @deepseek-ai/dsh-memory/summary
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-compaction'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { TurnEndInput } from '@deepseek-ai/dsh-dafeiyu'
import type { JobHooks, JobId, JobKind, JobOutcome } from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-jobs'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { MemorySettings } from './config.ts'
import { classifySummaryFailure } from './failure.ts'
import type { MemorySummaryFailure, MemorySummaryFailureCode } from './failure.ts'
import {
  MEMORY_BRIEF_MAX_CHARS,
  MEMORY_BRIEF_MAX_ENTRIES,
  MEMORY_ENTRY_KINDS,
  appendTurnSummaries,
  appendTurnSummary,
  migrateMemoryTiers,
  readMemoryDocument,
  summaryPaused,
} from './memory-file.ts'
import type { MemoryDocument, MemoryEntry, MemoryTurnSummaryInput } from './memory-file.ts'
import { appendMemoryNotice, refreshMemorySnapshot } from './snapshot.ts'
import { byteLength, errorMessage, truncateToBytes } from './text.ts'
import type { SnapshotTextSink } from './tools.ts'
import type { TurnRange } from './window.ts'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    /** One turn's summary write into MEMORY.md. */
    memory: 'memory'
  }
}

/** Job kind registered for the per-session summary pass. */
export const MEMORY_SUMMARY_JOB_KIND: JobKind = 'memory'

/** Model-facing job label; the job never returns a result to the model. */
export const MEMORY_SUMMARY_JOB_LABEL = 'memory summary'

/** Byte cap applied to each extracted user or assistant text. */
export const MEMORY_SUMMARY_TEXT_MAX_BYTES = 2 * 1024

/** Byte cap applied to the complete extracted conversation surface. */
export const MEMORY_SUMMARY_INPUT_MAX_BYTES = 24 * 1024

/** Character cap applied to one model-written entry. */
export const MEMORY_SUMMARY_ENTRY_MAX_CHARS = 300

/** Opening phrase of every summary-failure notice; the code and cause follow it. */
export const MEMORY_SUMMARY_FAILURE_NOTICE = 'Memory summary failed'

export { classifySummaryFailure } from './failure.ts'
export type { MemorySummaryFailure, MemorySummaryFailureCode } from './failure.ts'

/** Attempts one pass makes before it gives up and leaves the previous memory in effect. */
export const MEMORY_SUMMARY_MAX_ATTEMPTS = 2

/** Delay before the one bounded retry, in milliseconds. */
const MEMORY_SUMMARY_RETRY_DELAY_MS = 100

/** Model-visible notice text for one classified failure, inside the 120-character notice bound. */
export function memorySummaryFailureNotice(failure: MemorySummaryFailure): string {
  return `${MEMORY_SUMMARY_FAILURE_NOTICE} [${failure.code}] (attempt ${String(failure.attempts)}/${String(MEMORY_SUMMARY_MAX_ATTEMPTS)}); `
    + `previous memory still in effect: ${failure.detail}`
}

/** Upstream codes that may clear on one immediate retry. */
const RETRYABLE_SUMMARY_CODES: ReadonlySet<string> = new Set([
  'RATE_LIMIT',
  'TIMEOUT',
  'SERVER',
  'TRANSPORT',
  'STREAM_CLOSED',
  'MALFORMED_RESPONSE',
  'EMPTY_RESPONSE',
])

/** Whether one summary call failure is safe and useful to retry once. */
function isRetryableSummaryFailure(error: unknown): boolean {
  if (error instanceof LlmError) return RETRYABLE_SUMMARY_CODES.has(error.code)
  return error instanceof Error && error.message.includes('produced no text')
}

/**
 * Wait bound used to claim the job's settlement.
 *
 * The internal job has no model-facing consumer, and `tool-jobs` reports every
 * unclaimed owned settlement to the owner. Registering a waiter marks the
 * settlement `awaited`, so the internal job does not wake the model. The bound
 * is the largest value Node's timer accepts, which is effectively no timeout
 * for a summary pass.
 */
const MEMORY_SUMMARY_WAIT_TIMEOUT_MS = 2_147_483_647

/** Prefix appended when the conversation surface exceeds the input budget. */
const TRUNCATION_NOTE = `\n[input truncated to ${String(MEMORY_SUMMARY_INPUT_MAX_BYTES / 1024)} KiB]`

/** The summarization instruction delivered with the turn transcript. */
const SUMMARY_INSTRUCTION = [
  'You summarize one completed turn of an AI coding assistant session into durable memory entries.',
  '',
  'Return STRICT JSON only, without prose or a code fence, in this form:',
  '{"entries":[{"kind":"decision","text":"..."}]}',
  '',
  'Produce one to four entries. Each text is one concise line. The allowed kinds are:',
  '- decision: a durable decision and its reason',
  '- files: a file or path changed, created, or worth revisiting',
  '- open: unfinished work or an open question',
  '- preference: a user preference that should persist across sessions',
  '',
  'Record only durable conclusions. Do not speculate beyond the transcript and do not restate task facts that will not matter later. If the turn recorded nothing durable, return one decision entry saying so.',
  '',
  'Turn transcript:',
  '',
].join('\n')

/** The batch summarization instruction used when summarizeEveryTurns > 1. */
const BATCH_SUMMARY_INSTRUCTION = [
  'You summarize several completed turns of an AI coding assistant session into durable memory entries.',
  '',
  'Return STRICT JSON only, without prose or a code fence, in this form:',
  '{"turns":[{"turn":1,"entries":[{"kind":"decision","text":"..."}]}]}',
  '',
  'Include exactly the listed turn numbers, each with one to four entries. Do not merge turns and do not invent a turn. Each text is one concise line. The allowed kinds are:',
  '- decision: a durable decision and its reason',
  '- files: a file or path changed, created, or worth revisiting',
  '- open: unfinished work or an open question',
  '- preference: a user preference that should persist across sessions',
  '',
  'Record only durable conclusions. If a turn recorded nothing durable, return one decision entry for that turn saying so.',
  '',
  'Turns:',
  '',
].join('\n')

/** The compression instruction delivered with one section's detail entries. */
const BRIEF_INSTRUCTION = [
  'You compress the stored detail summary of one turn range into a brief memory checkpoint.',
  '',
  'Return STRICT JSON only, without prose or a code fence, in this form:',
  '{"entries":[{"kind":"decision","text":"..."}]}',
  '',
  `Use one or two entries whose texts total at most ${String(MEMORY_BRIEF_MAX_CHARS)} characters. Keep durable decisions, files, and open work; drop repetition and task detail. The allowed kinds are decision, files, open, and preference.`,
  '',
  'Detail entries:',
  '',
].join('\n')

/** Per-session summary state; the provider owns exactly one runner. */
interface SessionSummaryState {
  /** Whether a job pass currently owns the session. */
  running: boolean
  /** Latest completed turn that arrived while a pass was running (summarizeEveryTurns = 1). */
  pending: TurnEndInput | undefined
  /** Completed turns accumulated toward the next batch (summarizeEveryTurns > 1). */
  batch: TurnEndInput[]
  /** Batch currently owned by the running job. */
  inFlight: TurnEndInput[]
  /** A session-end flush asked for the partial batch to start now. */
  flushRequested: boolean
}

/** One completed turn's extracted conversation surface and seq range. */
interface TurnConversation {
  /** Extracted, bounded transcript text. */
  readonly text: string
  /** Inclusive seq range of the turn's events. */
  readonly seq: readonly [number, number]
}

/** One turn in a batch with its extracted transcript. */
interface BatchTurn {
  /** Completed-turn input from the organizer. */
  readonly input: TurnEndInput
  /** Extracted, bounded transcript and seq range. */
  readonly conversation: TurnConversation
}

/** Provider/model target of one summarization call. */
interface SummaryTarget {
  /** Registered provider route. */
  readonly provider: string
  /** Provider model id. */
  readonly model: string
}

/**
 * The last compaction boundary recorded in a session's log, when one happened.
 *
 * Compaction rewrites history, so it is the only point where a memory surface replace is free:
 * the provider's prefix cache is rebuilt for the new history anyway. Between compactions the
 * surface must stay append-only.
 * @param ctx - plugin context carrying the Session query service.
 * @param session - session whose durable events are scanned.
 * @param signal - cancellation for the query read.
 * @returns the newest `compaction/end` seq, or undefined without one.
 */
const lastCompactionSeq = async (ctx: Context, session: Session, signal: AbortSignal): Promise<number | undefined> => {
  using observation = await ctx.sessionQuery.observeSession(session.id, { projectionMode: 'none', signal })
  let last: number | undefined
  for (const event of observation.events) {
    if (event.type === 'compaction/end') last = event.seq
  }
  return last
}

/**
 * The highest memory checkpoint seq already recorded for one session in MEMORY.md.
 * @param document - parsed MEMORY.md, or undefined when none exists.
 * @param sessionId - session whose turns are inspected.
 * @returns the highest checkpoint seq, or undefined when no replacement was published.
 */
const lastCheckpointSeq = (document: MemoryDocument | undefined, sessionId: string): number | undefined => {
  const record = document?.sessions.find(session => session.id === sessionId)
  if (record === undefined) return undefined
  let last: number | undefined
  for (const turn of record.turns) {
    if (turn.checkpointSeq !== undefined && (last === undefined || turn.checkpointSeq > last)) {
      last = turn.checkpointSeq
    }
  }
  return last
}

/**
 * Per-session summary job coordinator.
 *
 * The provider filters turn endings before calling {@link MemorySummaryRunner.onTurnEnd}, so this
 * runner only ever sees completed root turns. A session with a running pass records the latest
 * turn as pending; when the pass settles, exactly one follow-up pass starts for that turn.
 */
export class MemorySummaryRunner {
  private readonly sessions = new Map<SessionId, SessionSummaryState>()
  private readonly noticed = new Map<SessionId, MemorySummaryFailureCode>()
  private disposed = false

  /**
   * @param ctx - plugin context carrying `jobs`, `llm`, `sessionQuery`, the
   *   store, and the logger.
   * @param settings - resolved provider settings.
   * @param runtimeSignal - registration signal; aborting it stops new work.
   */
  constructor(
    private readonly ctx: Context,
    private readonly settings: MemorySettings,
    private readonly runtimeSignal: AbortSignal,
    private readonly onSnapshotText?: SnapshotTextSink,
  ) {}

  /** Effective batch size, clamped to the schema's positive integer. */
  private every(): number {
    return Math.max(1, Math.floor(this.settings.summarizeEveryTurns))
  }

  /**
   * Start a summary pass, or record this turn as the single pending pass.
   * @param input - the completed turn dispatched by the organizer.
   */
  onTurnEnd(input: TurnEndInput): void {
    if (this.disposed || this.runtimeSignal.aborted) return
    const state = this.stateFor(input.session.id)
    if (this.every() === 1) {
      if (state.running) {
        state.pending = input
        return
      }
      this.start(input)
      return
    }
    state.batch.push(input)
    if (!state.running && state.batch.length >= this.every()) this.startNextBatch(state)
  }

  /**
   * Flush a session's partial batch, or every session's when no id is given.
   *
   * Called on session disposal, where a partial batch would otherwise stay
   * unsummarized forever. A running pass records the request and flushes when
   * it settles; a failed flush keeps the turns in the batch for the next
   * trigger.
   * @param sessionId - session to flush; omitted flushes every retained session.
   */
  flush(sessionId?: SessionId | string): void {
    if (this.disposed || this.runtimeSignal.aborted) return
    for (const [id, state] of this.sessions) {
      if (sessionId !== undefined && String(sessionId) !== String(id)) continue
      if (state.batch.length === 0) continue
      if (state.running) {
        state.flushRequested = true
        continue
      }
      this.startNextBatch(state, true)
    }
  }

  /** Stop starting passes and flush partial batches as a last attempt; a live job settles on its signal. */
  dispose(): void {
    this.flush()
    this.disposed = true
    this.noticed.clear()
  }

  /** Return the retained state for one session, creating it on first use. */
  private stateFor(sessionId: SessionId): SessionSummaryState {
    let state = this.sessions.get(sessionId)
    if (state === undefined) {
      state = { running: false, pending: undefined, batch: [], inFlight: [], flushRequested: false }
      this.sessions.set(sessionId, state)
    }
    return state
  }

  /** Start one job for the completed turn, containing an unavailable registry to a debug log. */
  private start(input: TurnEndInput): void {
    const state = this.stateFor(input.session.id)
    const jobs = this.ctx.get('jobs')
    if (jobs === undefined) {
      this.ctx.logger.debug('memory: background jobs are not available; skipping turn %d', input.turn)
      return
    }
    state.running = true
    state.pending = undefined
    const controller = new AbortController()
    const signal = AbortSignal.any([this.runtimeSignal, input.signal, controller.signal])
    let jobId: JobId
    try {
      jobId = jobs.start({
        kind: MEMORY_SUMMARY_JOB_KIND,
        owner: input.session.id,
        label: MEMORY_SUMMARY_JOB_LABEL,
        run: (): JobHooks => {
          const work = this.runPass(input, signal)
          void work.finally(() => { this.afterPass(input.session.id) })
          return startJobHooks(work, controller)
        },
      })
    } catch (error: unknown) {
      // A composition without a controller cannot start work; the turn stays
      // unsummarized rather than surfacing an error to the model.
      state.running = false
      this.ctx.logger.debug('memory: summary job not started for turn %d: %s', input.turn, errorMessage(error))
      return
    }
    // Claim the settlement so the internal job never becomes a model notice,
    // then drop its record: the model never receives this job id, and a long
    // session would otherwise retain one settled record per completed turn.
    void jobs.wait(jobId, MEMORY_SUMMARY_WAIT_TIMEOUT_MS, input.session.id).then(
      (settled) => {
        if (settled.status === 'running' || settled.status === 'stopping') return
        try {
          jobs.remove(jobId, input.session.id)
        } catch (error: unknown) {
          this.ctx.logger.debug('memory: could not remove the settled summary job: %s', errorMessage(error))
        }
      },
      (error: unknown) => {
        this.ctx.logger.debug('memory: summary job wait ended early: %s', errorMessage(error))
      },
    )
  }

  /** Start the next batch (up to N turns) from the session's accumulated queue. */
  private startNextBatch(state: SessionSummaryState, flush = false): void {
    if (this.disposed || this.runtimeSignal.aborted) return
    const count = flush ? state.batch.length : Math.min(state.batch.length, this.every())
    if (count === 0) return
    this.startBatch(state.batch.splice(0, count))
  }

  /** Start one job that summarizes a whole batch with a single model call. */
  private startBatch(batch: readonly TurnEndInput[]): void {
    if (batch.length === 0) return
    const sessionId = batch[0]?.session.id
    if (sessionId === undefined) return
    const state = this.stateFor(sessionId)
    const jobs = this.ctx.get('jobs')
    if (jobs === undefined) {
      state.batch = [...batch, ...state.batch]
      this.ctx.logger.debug('memory: background jobs are not available; keeping %d pending turn(s)', batch.length)
      return
    }
    state.running = true
    state.inFlight = [...batch]
    state.flushRequested = false
    const controller = new AbortController()
    const signal = AbortSignal.any([
      this.runtimeSignal,
      ...batch.map(input => input.signal),
      controller.signal,
    ])
    let jobId: JobId
    try {
      jobId = jobs.start({
        kind: MEMORY_SUMMARY_JOB_KIND,
        owner: sessionId,
        label: MEMORY_SUMMARY_JOB_LABEL,
        run: (): JobHooks => {
          const work = this.runBatchPass(batch, signal)
          void work.then(
            (outcome) => { this.afterBatch(sessionId, batch, outcome) },
            () => { this.afterBatch(sessionId, batch, { status: 'failed' }) },
          )
          return startJobHooks(work, controller)
        },
      })
    } catch (error: unknown) {
      state.running = false
      state.inFlight = []
      state.batch = [...batch, ...state.batch]
      this.ctx.logger.debug('memory: summary batch job not started: %s', errorMessage(error))
      return
    }
    void jobs.wait(jobId, MEMORY_SUMMARY_WAIT_TIMEOUT_MS, sessionId).then(
      (settled) => {
        if (settled.status === 'running' || settled.status === 'stopping') return
        try {
          jobs.remove(jobId, sessionId)
        } catch (error: unknown) {
          this.ctx.logger.debug('memory: could not remove the settled summary job: %s', errorMessage(error))
        }
      },
      (error: unknown) => {
        this.ctx.logger.debug('memory: summary job wait ended early: %s', errorMessage(error))
      },
    )
  }

  /** Release a settled batch and start the next full batch or a requested flush. */
  private afterBatch(
    sessionId: SessionId,
    batch: readonly TurnEndInput[],
    outcome: JobOutcome,
  ): void {
    const state = this.stateFor(sessionId)
    state.running = false
    state.inFlight = []
    if (this.disposed || this.runtimeSignal.aborted) return
    if (outcome.status !== 'completed') {
      // Keep the failed batch ahead of turns that arrived meanwhile. The next
      // completed turn (or a later flush) retries it; this avoids a hot loop.
      state.batch = [...batch, ...state.batch]
      return
    }
    if (state.flushRequested && state.batch.length > 0) {
      this.startNextBatch(state, true)
      return
    }
    if (state.batch.length >= this.every()) this.startNextBatch(state)
  }

  /** Release the session and start the one pending pass, if any. */
  private afterPass(sessionId: SessionId): void {
    const state = this.stateFor(sessionId)
    state.running = false
    const pending = state.pending
    state.pending = undefined
    if (pending === undefined || this.disposed || this.runtimeSignal.aborted) return
    this.start(pending)
  }

  /** Summarize one turn, containing every failure to an outcome and a notice. */
  private async runPass(input: TurnEndInput, signal: AbortSignal): Promise<JobOutcome> {
    const startedAt = Date.now()
    let inputBytes = 0
    let target = 'none'
    let attempts = 0
    try {
      // A paused workspace keeps its file untouched; the turn stays unsummarized so resuming continues
      // from the current window instead of backfilling turns the user paused through.
      const current = await readMemoryDocument(this.ctx, input.session, signal)
      if (summaryPaused(current.document)) {
        this.ctx.logger.debug('memory: summary paused; skipping turn %d', input.turn)
        return { status: 'completed' }
      }
      const conversation = await readTurnConversation(this.ctx, input.session, input.turn, signal)
      if (conversation.text.length === 0) {
        this.ctx.logger.debug('memory: turn %d has no conversation surface; nothing to summarize', input.turn)
        return { status: 'completed' }
      }
      inputBytes = byteLength(conversation.text)
      const resolved = resolveSummaryTarget(this.settings, input.agent)
      if (resolved === undefined) {
        throw new Error(
          'no provider/model available for memory summarization: set summarizationProvider and summarizationModel,'
          + ' route one request, or set both AgentOptions fields',
        )
      }
      target = `${resolved.provider}/${resolved.model}`
      const raw = await streamSummaryWithRetry(
        this.ctx,
        resolved,
        conversation.text,
        input.session.id,
        signal,
        () => { attempts += 1 },
      )
      const entries = parseSummaryEntries(raw)
      signal.throwIfAborted()
      // Tier migration runs before the append (DH-710): a body at its byte budget would otherwise
      // refuse the append, and the migration that frees space could never run. A migration failure
      // still does not block the summary, which is written below.
      // Surface tier folding is allowed only at a compaction boundary: between compactions the
      // surface must stay append-only (a replaced early range breaks the provider prefix cache).
      const compactionSeq = await lastCompactionSeq(this.ctx, input.session, signal)
      const checkpointSeq = lastCheckpointSeq(current.document, String(input.session.id))
      const allowSurfaceReplace = compactionSeq !== undefined
        && (checkpointSeq === undefined || compactionSeq > checkpointSeq)
      try {
        await migrateMemoryTiers(
          this.ctx,
          input.session,
          input.turn,
          (range, detail, migrationSignal) => compressBriefEntries(
            this.ctx,
            resolved,
            range,
            detail,
            input.session.id,
            migrationSignal,
          ),
          signal,
          {
            window: this.settings.window,
            maxBytes: this.settings.maxBytes,
            maxEntries: this.settings.maxEntries,
            allowSurfaceReplace,
          },
        )
      } catch (error: unknown) {
        if (signal.aborted) return { status: 'killed' }
        this.ctx.logger.warn('memory: tier migration failed before turn %d: %s', input.turn, errorMessage(error))
      }
      await appendTurnSummary(this.ctx, input.session, {
        turn: input.turn,
        seq: conversation.seq,
        entries,
      }, signal, {
        window: this.settings.window,
        maxBytes: this.settings.maxBytes,
        maxEntries: this.settings.maxEntries,
        openTtlDays: this.settings.openTtlDays,
        filesTtlDays: this.settings.filesTtlDays,
        supersessionMinSharedTags: this.settings.supersessionMinSharedTags,
      })
      await refreshMemorySnapshot(this.ctx, input.agent, signal, {
        template: this.settings.snapshotTemplate,
        position: this.settings.snapshotPosition,
        ...this.onSnapshotText === undefined ? {} : { onText: this.onSnapshotText },
      })
      this.noticed.delete(input.session.id)
      this.ctx.logger.debug(
        'memory: summarized turn %d (%d input bytes, model %s, %d ms, %d attempt(s))',
        input.turn,
        inputBytes,
        target,
        Date.now() - startedAt,
        attempts,
      )
      return { status: 'completed' }
    } catch (error: unknown) {
      if (signal.aborted) return { status: 'killed' }
      const failure = classifySummaryFailure(error, attempts)
      this.ctx.logger.warn(
        'memory: summary job failed for turn %d (%d input bytes, model %s, %d ms, code %s, %d attempt(s)): %s',
        input.turn,
        inputBytes,
        target,
        Date.now() - startedAt,
        failure.code,
        failure.attempts,
        errorMessage(error),
      )
      this.ctx.logger.debug('memory: summary failure detail: %o', error)
      this.appendFailureNotice(input.session, failure)
      return { status: 'failed', detail: `[${failure.code}] ${errorMessage(error)}`.slice(0, 240) }
    }
  }

  /** Summarize a whole batch with one model call, containing every failure to an outcome and a notice. */
  private async runBatchPass(batch: readonly TurnEndInput[], signal: AbortSignal): Promise<JobOutcome> {
    const startedAt = Date.now()
    let inputBytes = 0
    let target = 'none'
    let attempts = 0
    const first = batch[0]
    if (first === undefined) return { status: 'completed' }
    const session = first.session
    const turnLabel = batch.map(input => String(input.turn)).join(',')
    try {
      const current = await readMemoryDocument(this.ctx, session, signal)
      if (summaryPaused(current.document)) {
        this.ctx.logger.debug('memory: summary paused; skipping turns %s', turnLabel)
        return { status: 'completed' }
      }
      const turns: BatchTurn[] = []
      for (const input of batch) {
        const conversation = await readTurnConversation(this.ctx, session, input.turn, signal)
        if (conversation.text.length === 0) {
          this.ctx.logger.debug('memory: turn %d has no conversation surface; omitted from the batch', input.turn)
          continue
        }
        turns.push({ input, conversation })
        inputBytes += byteLength(conversation.text)
      }
      if (turns.length === 0) return { status: 'completed' }
      const resolved = resolveSummaryTarget(this.settings, first.agent)
      if (resolved === undefined) {
        throw new Error(
          'no provider/model available for memory summarization: set summarizationProvider and summarizationModel,'
          + ' route one request, or set both AgentOptions fields',
        )
      }
      target = `${resolved.provider}/${resolved.model}`
      const raw = await streamBatchSummaryWithRetry(
        this.ctx,
        resolved,
        turns,
        session.id,
        signal,
        () => { attempts += 1 },
      )
      const summaries = parseBatchSummaryEntries(raw, turns.map(turn => ({
        turn: turn.input.turn,
        seq: turn.conversation.seq,
      })))
      signal.throwIfAborted()
      const latestTurn = Math.max(...turns.map(turn => turn.input.turn))
      const compactionSeq = await lastCompactionSeq(this.ctx, session, signal)
      const checkpointSeq = lastCheckpointSeq(current.document, String(session.id))
      const allowSurfaceReplace = compactionSeq !== undefined
        && (checkpointSeq === undefined || compactionSeq > checkpointSeq)
      try {
        await migrateMemoryTiers(
          this.ctx,
          session,
          latestTurn,
          (range, detail, migrationSignal) => compressBriefEntries(
            this.ctx,
            resolved,
            range,
            detail,
            session.id,
            migrationSignal,
          ),
          signal,
          {
            window: this.settings.window,
            maxBytes: this.settings.maxBytes,
            maxEntries: this.settings.maxEntries,
            allowSurfaceReplace,
          },
        )
      } catch (error: unknown) {
        if (signal.aborted) return { status: 'killed' }
        this.ctx.logger.warn('memory: tier migration failed before turns %s: %s', turnLabel, errorMessage(error))
      }
      await appendTurnSummaries(this.ctx, session, summaries, signal, {
        window: this.settings.window,
        maxBytes: this.settings.maxBytes,
        maxEntries: this.settings.maxEntries,
        openTtlDays: this.settings.openTtlDays,
        filesTtlDays: this.settings.filesTtlDays,
        supersessionMinSharedTags: this.settings.supersessionMinSharedTags,
      })
      await refreshMemorySnapshot(this.ctx, first.agent, signal, {
        template: this.settings.snapshotTemplate,
        position: this.settings.snapshotPosition,
        ...this.onSnapshotText === undefined ? {} : { onText: this.onSnapshotText },
      })
      this.noticed.delete(session.id)
      this.ctx.logger.debug(
        'memory: summarized turns %s (%d input bytes, model %s, %d ms, %d attempt(s), batch %d)',
        turnLabel,
        inputBytes,
        target,
        Date.now() - startedAt,
        attempts,
        turns.length,
      )
      return { status: 'completed' }
    } catch (error: unknown) {
      if (signal.aborted) return { status: 'killed' }
      const failure = classifySummaryFailure(error, attempts)
      this.ctx.logger.warn(
        'memory: summary batch failed for turns %s (%d input bytes, model %s, %d ms, code %s, %d attempt(s)): %s',
        turnLabel,
        inputBytes,
        target,
        Date.now() - startedAt,
        failure.code,
        failure.attempts,
        errorMessage(error),
      )
      this.ctx.logger.debug('memory: summary batch failure detail: %o', error)
      this.appendFailureNotice(session, failure)
      return { status: 'failed', detail: `[${failure.code}] ${errorMessage(error)}`.slice(0, 240) }
    }
  }

  /**
   * Append one notice when the failure code changes, never throwing into the job outcome.
   *
   * A repeat of the same failure is already visible on the surface and only logs; a different
   * failure (or the first one after a success) is worth a fresh line.
   */
  private appendFailureNotice(session: Session, failure: MemorySummaryFailure): void {
    if (this.noticed.get(session.id) === failure.code) return
    this.noticed.set(session.id, failure.code)
    try {
      appendMemoryNotice(session, memorySummaryFailureNotice(failure))
    } catch (error: unknown) {
      this.ctx.logger.warn('memory: could not append the summary failure notice: %s', errorMessage(error))
    }
  }
}

/** Build the job hooks over the pass already in flight. */
function startJobHooks(work: Promise<JobOutcome>, controller: AbortController): JobHooks {
  return {
    cancel: (reason?: string) => { controller.abort(reason ?? 'memory summary cancelled') },
    done: work.then(
      outcome => outcome,
      (error: unknown): JobOutcome => ({ status: 'failed', detail: errorMessage(error) }),
    ),
  }
}

/**
 * Resolve the provider/model for one summary call.
 *
 * The configured pair wins; otherwise the latest routed request's config
 * applies, and a session that never routed a request falls back to the agent's
 * explicit options, matching `compaction-basic`'s target order.
 * @param settings - resolved provider settings.
 * @param agent - agent whose session is summarized.
 * @returns the target, or undefined when the session has no routed model.
 */
function resolveSummaryTarget(settings: MemorySettings, agent: Agent): SummaryTarget | undefined {
  if (settings.summarizationProvider.length > 0) {
    return { provider: settings.summarizationProvider, model: settings.summarizationModel }
  }
  const latest = agent.session.requestHeader()?.config
  if (latest !== undefined) return { provider: latest.provider, model: latest.model }
  const { provider, model } = agent.options
  if (provider !== undefined && provider.length > 0 && model !== undefined && model.length > 0) {
    return { provider, model }
  }
  return undefined
}

/** Read the completed turn's conversation surface and its seq range. */
async function readTurnConversation(
  ctx: Context,
  session: Session,
  turn: number,
  signal: AbortSignal,
): Promise<TurnConversation> {
  using observation = await ctx.sessionQuery.observeSession(session.id, { signal, projectionMode: 'none' })
  const events = observation.events
  let startIndex = -1
  let endIndex = -1
  for (const [index, event] of events.entries()) {
    if (event.type === 'turn/start' && event.data.turn === turn) startIndex = index
    if (event.type === 'turn/end' && event.data.turn === turn && event.data.reason.kind === 'completed') {
      endIndex = index
    }
  }
  const start = events[startIndex]
  const end = events[endIndex]
  if (startIndex < 0 || endIndex < startIndex || start === undefined || end === undefined) {
    throw new Error(`memory: the session log has no completed turn ${String(turn)} to summarize`)
  }
  return { text: renderConversation(events.slice(startIndex, endIndex + 1)), seq: [start.seq, end.seq] }
}

/**
 * Extract the conversation surface of one turn.
 *
 * Only user text, assistant text, and tool names with their result status are
 * kept; tool output, reasoning, system prompts, and memory's own messages are
 * omitted. Each text is bounded to 2 KiB and the complete transcript to 24 KiB,
 * with a truncation note when the latter bound is reached.
 * @param events - the turn's events in log order.
 * @returns the bounded transcript text.
 */
function renderConversation(events: readonly SessionEvent[]): string {
  const toolNames = new Map<string, string>()
  const lines: string[] = []
  for (const event of events) {
    switch (event.type) {
      case 'user/message': {
        if (event.data.source.kind === 'memory') break
        pushLine(lines, '[user]', textContent(event.data.content))
        break
      }
      case 'assistant/message':
        pushLine(lines, '[assistant]', textContent(event.data.message.content))
        break
      case 'tool/call':
        toolNames.set(event.data.callId, event.data.name)
        pushLine(lines, '[tool]', event.data.name)
        break
      case 'tool/result': {
        const name = toolNames.get(event.data.message.toolCallId) ?? 'tool'
        pushLine(lines, '[tool]', `${name}: ${event.data.message.isError === true ? 'error' : 'ok'}`)
        break
      }
      default:
        // Log-only lifecycle events and non-conversation surface events do not
        // contribute facts the summary should record.
        break
    }
  }
  return boundConversation(lines)
}

/** Append one normalized conversation line when it carries text. */
function pushLine(lines: string[], prefix: string, text: string): void {
  const line = singleLine(text)
  if (line.length === 0) return
  lines.push(`${prefix} ${truncateToBytes(line, MEMORY_SUMMARY_TEXT_MAX_BYTES)}`)
}

/** Join the lines inside the input budget, truncating the first overflow with a note. */
function boundConversation(lines: readonly string[]): string {
  const noteBytes = byteLength(TRUNCATION_NOTE)
  const budget = MEMORY_SUMMARY_INPUT_MAX_BYTES - noteBytes
  const kept: string[] = []
  let used = 0
  for (const line of lines) {
    const separator = kept.length === 0 ? 0 : 1
    const size = byteLength(line) + separator
    if (used + size <= budget) {
      kept.push(line)
      used += size
      continue
    }
    const remaining = budget - used - separator
    if (remaining > 0) kept.push(truncateToBytes(line, remaining))
    return `${kept.join('\n')}${TRUNCATION_NOTE}`
  }
  return kept.join('\n')
}

/** Run one one-shot summary call and return the assembled text. */
async function streamSummary(
  ctx: Context,
  target: SummaryTarget,
  conversation: string,
  sessionId: SessionId,
  signal: AbortSignal,
): Promise<string> {
  return streamInstruction(ctx, target, `${SUMMARY_INSTRUCTION}\n${conversation}`, sessionId, signal)
}

/**
 * Run one summary call with one bounded retry for transient upstream failures.
 *
 * The retry repeats only the model call: no repository write has happened yet, so a repeated
 * attempt cannot duplicate a summary. Authorization, budget, and malformed-target failures are
 * deterministic and surface after one attempt.
 * @param ctx - context carrying the LLM service.
 * @param target - provider/model to call.
 * @param conversation - bounded transcript.
 * @param sessionId - session attribution for the request.
 * @param signal - cancellation for both the call and the retry delay.
 * @param onAttempt - called immediately before each model call.
 * @returns the assembled model text.
 */
async function streamSummaryWithRetry(
  ctx: Context,
  target: SummaryTarget,
  conversation: string,
  sessionId: SessionId,
  signal: AbortSignal,
  onAttempt: () => void,
): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    onAttempt()
    try {
      return await streamSummary(ctx, target, conversation, sessionId, signal)
    } catch (error: unknown) {
      if (signal.aborted || attempt >= MEMORY_SUMMARY_MAX_ATTEMPTS || !isRetryableSummaryFailure(error)) throw error
      await new Promise<void>((resolve) => { setTimeout(resolve, MEMORY_SUMMARY_RETRY_DELAY_MS) })
      signal.throwIfAborted()
    }
  }
}

/** Render the bounded transcript for a batch, naming each turn's seq range. */
function renderBatchTranscript(turns: readonly BatchTurn[]): string {
  const lines: string[] = []
  for (const turn of turns) {
    const [start, end] = turn.conversation.seq
    lines.push(`=== turn ${String(turn.input.turn)} (seq ${String(start)}–${String(end)}) ===`)
    lines.push(turn.conversation.text)
  }
  return boundConversation(lines)
}

/** Run one one-shot batch summary call and return the assembled text. */
async function streamBatchSummary(
  ctx: Context,
  target: SummaryTarget,
  turns: readonly BatchTurn[],
  sessionId: SessionId,
  signal: AbortSignal,
): Promise<string> {
  return streamInstruction(
    ctx,
    target,
    `${BATCH_SUMMARY_INSTRUCTION}
${renderBatchTranscript(turns)}`,
    sessionId,
    signal,
  )
}

/** Run one batch summary call with one bounded retry for transient upstream failures. */
async function streamBatchSummaryWithRetry(
  ctx: Context,
  target: SummaryTarget,
  turns: readonly BatchTurn[],
  sessionId: SessionId,
  signal: AbortSignal,
  onAttempt: () => void,
): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    onAttempt()
    try {
      return await streamBatchSummary(ctx, target, turns, sessionId, signal)
    } catch (error: unknown) {
      if (signal.aborted || attempt >= MEMORY_SUMMARY_MAX_ATTEMPTS || !isRetryableSummaryFailure(error)) throw error
      await new Promise<void>((resolve) => { setTimeout(resolve, MEMORY_SUMMARY_RETRY_DELAY_MS) })
      signal.throwIfAborted()
    }
  }
}

/** Compress one detail section with the same model target as the summary job. */
async function compressBriefEntries(
  ctx: Context,
  target: SummaryTarget,
  range: TurnRange,
  entries: readonly MemoryEntry[],
  sessionId: SessionId,
  signal: AbortSignal | undefined,
): Promise<readonly MemoryEntry[]> {
  const detail = entries.map(entry => `- [${entry.kind}] ${entry.text}`).join('\n')
  const span = range.startTurn === range.endTurn
    ? `turn ${String(range.startTurn)}`
    : `turns ${String(range.startTurn)}–${String(range.endTurn)}`
  const text = `${BRIEF_INSTRUCTION}${span}\n\n${detail}`
  const raw = await streamInstruction(ctx, target, text, sessionId, signal)
  return parseBriefEntries(raw)
}

/** Run one one-shot model call returning the assembled text. */
async function streamInstruction(
  ctx: Context,
  target: SummaryTarget,
  instruction: string,
  sessionId: SessionId,
  signal: AbortSignal | undefined,
): Promise<string> {
  const assembler = new BlockAssembler()
  const options: GenerateOptions = {
    provider: target.provider,
    model: target.model,
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: instruction }],
    }],
    sessionId,
    ...signal === undefined ? {} : { signal },
  }
  for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
  const failure = finishError(assembler.finish)
  if (failure !== undefined) throw failure
  const text = textContent(assembler.blocks()).trim()
  if (text.length === 0) throw new Error('memory: summarization produced no text')
  return text
}

/** Map a terminal non-success finish to the error that fails the job. */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'error':
      return LlmError.fromFailure(finish.failure)
    case 'aborted':
      return new Error('memory: summarization was aborted')
    case 'max-tokens':
      return new Error('memory: summarization hit the output token cap')
    case 'stop':
    case 'tool-calls':
      return undefined
    default:
      // A provider-specific finish reason still ends the stream; assemble what
      // arrived rather than inventing a failure for an unknown successful stop.
      return undefined
  }
}

/**
 * Parse the model output into validated memory entries.
 *
 * A fenced or prose-wrapped JSON object/array is accepted. Each entry's kind
 * must be in the registry and its text must be a non-empty single line, capped
 * at 300 characters; invalid entries are dropped. When no entry survives,
 * including when the output is not JSON at all, one `decision` entry carries
 * the raw output so the turn is still recorded.
 * @param text - raw model output.
 * @returns one to four validated entries, never empty.
 */
export function parseSummaryEntries(text: string): readonly MemoryEntry[] {
  const parsed = parseSummaryJson(text)
  const candidates = summaryCandidates(parsed)
  const entries: MemoryEntry[] = []
  for (const candidate of candidates) {
    const entry = parseSummaryEntry(candidate)
    if (entry === undefined) continue
    entries.push(entry)
    if (entries.length === 4) break
  }
  if (entries.length > 0) return entries
  return [{ kind: 'decision', text: fallbackEntryText(text) }]
}

/**
 * Parse a batch reply into one entry group per requested turn.
 *
 * This path is strict: every requested turn must appear exactly once with one
 * to four valid entries. Unlike the single-turn fallback, a malformed batch is
 * an error so the whole batch stays pending and is retried rather than being
 * recorded under the wrong turn.
 * @param text - raw model output.
 * @param turns - requested turns and their seq ranges, in batch order.
 * @returns one validated entry group per requested turn.
 * @throws Error when the reply is not a complete `{ turns: [...] }` document for this batch.
 */
export function parseBatchSummaryEntries(
  text: string,
  turns: readonly { readonly turn: number; readonly seq: readonly [number, number] }[],
): readonly MemoryTurnSummaryInput[] {
  const parsed = parseSummaryJson(text)
  const values = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)['turns']
    : undefined
  if (!Array.isArray(values)) throw new Error('memory: batch summary returned no turns array')
  const expected = new Set(turns.map(turn => turn.turn))
  const byTurn = new Map<number, readonly MemoryEntry[]>()
  for (const value of values) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('memory: batch summary turn is not an object')
    }
    const record = value as Record<string, unknown>
    const turn = record['turn']
    if (typeof turn !== 'number' || !Number.isInteger(turn) || !expected.has(turn)) {
      throw new Error(`memory: batch summary returned an unexpected turn ${String(turn)}`)
    }
    if (byTurn.has(turn)) throw new Error(`memory: batch summary repeats turn ${String(turn)}`)
    const candidates = record['entries']
    if (!Array.isArray(candidates)) throw new Error(`memory: batch summary turn ${String(turn)} has no entries array`)
    const entries: MemoryEntry[] = []
    for (const candidate of candidates) {
      const entry = parseSummaryEntry(candidate)
      if (entry === undefined) continue
      entries.push(entry)
      if (entries.length === 4) break
    }
    if (entries.length === 0) throw new Error(`memory: batch summary turn ${String(turn)} has no valid entries`)
    byTurn.set(turn, entries)
  }
  return turns.map((turn) => {
    const entries = byTurn.get(turn.turn)
    if (entries === undefined) throw new Error(`memory: batch summary omitted turn ${String(turn.turn)}`)
    return { turn: turn.turn, seq: turn.seq, entries }
  })
}

/**
 * Parse a brief compression reply into bounded entries.
 *
 * At most {@link MEMORY_BRIEF_MAX_ENTRIES} entries survive, and their texts total
 * at most {@link MEMORY_BRIEF_MAX_CHARS} characters; longer text is ellipsized.
 * A reply with no valid entry throws so the caller keeps the detail section.
 * @param text - raw model output.
 * @returns one or two entries within the brief bounds.
 * @throws Error when the output carries no valid entry.
 */
export function parseBriefEntries(text: string): readonly MemoryEntry[] {
  const candidates = summaryCandidates(parseSummaryJson(text))
  const entries: MemoryEntry[] = []
  let characters = 0
  for (const candidate of candidates) {
    if (entries.length === MEMORY_BRIEF_MAX_ENTRIES) break
    const remaining = MEMORY_BRIEF_MAX_CHARS - characters
    if (remaining <= 0) break
    const entry = parseSummaryEntry(candidate)
    if (entry === undefined) continue
    const bounded = entry.text.length <= remaining ? entry.text : truncateChars(entry.text, remaining)
    entries.push({ kind: entry.kind, text: bounded })
    characters += bounded.length
  }
  if (entries.length === 0) throw new Error('memory: brief compression returned no valid entries')
  return entries
}

/** Parse the first JSON object or array in the output, tolerating fences and prose. */
function parseSummaryJson(text: string): unknown {
  const start = text.search(/[[{]/u)
  if (start < 0) return undefined
  const candidate = text.slice(start)
  const end = candidate.startsWith('[') ? candidate.lastIndexOf(']') : candidate.lastIndexOf('}')
  if (end < 0) return undefined
  try {
    return JSON.parse(candidate.slice(0, end + 1))
  } catch {
    // Model output is an untrusted JSON boundary; a parse failure takes the fallback.
    return undefined
  }
}

/** Read the entry array from a parsed summary value. */
function summaryCandidates(parsed: unknown): readonly unknown[] {
  if (Array.isArray(parsed)) return parsed
  if (typeof parsed !== 'object' || parsed === null) return []
  const entries = (parsed as Record<string, unknown>)['entries']
  return Array.isArray(entries) ? entries : []
}

/** Validate one model-written entry. */
function parseSummaryEntry(value: unknown): MemoryEntry | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const kind = MEMORY_ENTRY_KINDS.find(candidate => candidate === record['kind'])
  if (kind === undefined) return undefined
  const text = typeof record['text'] === 'string' ? singleLine(record['text']) : ''
  if (text.length === 0) return undefined
  return { kind, text: text.slice(0, MEMORY_SUMMARY_ENTRY_MAX_CHARS) }
}

/** Fallback entry text from raw model output, bounded and single-line. */
function fallbackEntryText(text: string): string {
  const normalized = singleLine(text)
  const fallback = normalized.length > 0 ? normalized : '(the model returned no summary text)'
  return fallback.slice(0, MEMORY_SUMMARY_ENTRY_MAX_CHARS)
}

/** Join text content blocks. */
function textContent(content: readonly ContentBlock[]): string {
  return content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** Collapse a value into one line. */
function singleLine(text: string): string {
  return text.replaceAll(/\s+/gu, ' ').trim()
}

/** Truncate text to a character budget, appending an ellipsis when shortened. */
function truncateChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  if (maxChars <= 1) return '…'.slice(0, maxChars)
  return `${text.slice(0, maxChars - 1)}…`
}
