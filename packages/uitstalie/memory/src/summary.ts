/**
 * The memory summary job: one completed turn becomes one detail section of
 * MEMORY.md.
 *
 * The organizer hands every completed root turn to `MemorySummaryRunner`. The
 * runner keeps one summary job per session: a turn that completes while a job
 * runs leaves one pending input, and the job settles into exactly one follow-up
 * pass. Each pass reads only the turn's conversation surface (user text,
 * assistant text, and tool names with status), asks the routed or configured
 * model for strict JSON entries, appends them through the version-guarded
 * repository, and refreshes the durable snapshot.
 *
 * Failures are contained. A model, repository, or write failure leaves the
 * previous MEMORY.md in place and appends one notice message per session;
 * cancellation writes nothing. The job owns no model surface of its own, so its
 * output ring stays empty.
 * @module @deepseek-ai/dsh-memory/summary
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { TurnEndInput } from '@deepseek-ai/dsh-dafeiyu'
import type { JobHooks, JobId, JobKind, JobOutcome } from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-jobs'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { MemorySettings } from './config.ts'
import { MEMORY_ENTRY_KINDS, appendTurnSummary } from './memory-file.ts'
import type { MemoryEntry } from './memory-file.ts'
import { appendMemoryNotice, refreshMemorySnapshot } from './snapshot.ts'

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

/** Notice appended once per session after the first failed summary. */
export const MEMORY_SUMMARY_FAILURE_NOTICE = 'Memory summary failed; the previous memory is still in effect.'

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

/** Per-session summary state; the provider owns exactly one runner. */
interface SessionSummaryState {
  /** Whether a job pass currently owns the session. */
  running: boolean
  /** Latest completed turn that arrived while the pass was running. */
  pending: TurnEndInput | undefined
}

/** One completed turn's extracted conversation surface and seq range. */
interface TurnConversation {
  /** Extracted, bounded transcript text. */
  readonly text: string
  /** Inclusive seq range of the turn's events. */
  readonly seq: readonly [number, number]
}

/** Provider/model target of one summarization call. */
interface SummaryTarget {
  /** Registered provider route. */
  readonly provider: string
  /** Provider model id. */
  readonly model: string
}

/**
 * Per-session summary job coordinator.
 *
 * The organizer calls {@link MemorySummaryRunner.onTurnEnd} for completed root
 * turns only. A session with a running pass records the latest turn as pending;
 * when the pass settles, exactly one follow-up pass starts for that turn.
 */
export class MemorySummaryRunner {
  private readonly sessions = new Map<SessionId, SessionSummaryState>()
  private readonly noticed = new Set<SessionId>()
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
  ) {}

  /**
   * Start a summary pass, or record this turn as the single pending pass.
   * @param input - the completed turn dispatched by the organizer.
   */
  onTurnEnd(input: TurnEndInput): void {
    if (this.disposed || this.runtimeSignal.aborted) return
    const state = this.stateFor(input.session.id)
    if (state.running) {
      state.pending = input
      return
    }
    this.start(input)
  }

  /** Stop starting passes and drop per-session state; a live job settles on its signal. */
  dispose(): void {
    this.disposed = true
    this.sessions.clear()
    this.noticed.clear()
  }

  /** Return the retained state for one session, creating it on first use. */
  private stateFor(sessionId: SessionId): SessionSummaryState {
    let state = this.sessions.get(sessionId)
    if (state === undefined) {
      state = { running: false, pending: undefined }
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
    try {
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
      const raw = await streamSummary(this.ctx, resolved, conversation.text, input.session.id, signal)
      const entries = parseSummaryEntries(raw)
      signal.throwIfAborted()
      await appendTurnSummary(this.ctx, input.session, {
        turn: input.turn,
        seq: conversation.seq,
        entries,
      }, signal, { window: this.settings.window, maxBytes: this.settings.maxBytes })
      await refreshMemorySnapshot(this.ctx, input.agent, signal)
      this.ctx.logger.debug(
        'memory: summarized turn %d (%d input bytes, model %s, %d ms)',
        input.turn,
        inputBytes,
        target,
        Date.now() - startedAt,
      )
      return { status: 'completed' }
    } catch (error: unknown) {
      if (signal.aborted) return { status: 'killed' }
      this.ctx.logger.warn(
        'memory: summary job failed for turn %d (%d input bytes, model %s, %d ms): %s',
        input.turn,
        inputBytes,
        target,
        Date.now() - startedAt,
        errorMessage(error),
      )
      this.appendFailureNotice(input.session)
      return { status: 'failed', detail: errorMessage(error).slice(0, 240) }
    }
  }

  /** Append the session's one failure notice, never throwing into the job outcome. */
  private appendFailureNotice(session: Session): void {
    if (this.noticed.has(session.id)) return
    this.noticed.add(session.id)
    try {
      appendMemoryNotice(session, MEMORY_SUMMARY_FAILURE_NOTICE)
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

/** Run one one-shot summarization call and return the assembled text. */
async function streamSummary(
  ctx: Context,
  target: SummaryTarget,
  conversation: string,
  sessionId: SessionId,
  signal: AbortSignal,
): Promise<string> {
  const assembler = new BlockAssembler()
  const options: GenerateOptions = {
    provider: target.provider,
    model: target.model,
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: `${SUMMARY_INSTRUCTION}\n${conversation}` }],
    }],
    sessionId,
    signal,
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
      return new Error(`memory: summarization failed: ${finish.failure.message}`)
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

/** Count UTF-8 bytes. */
function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/** Truncate text to a byte budget, appending an ellipsis when shortened. */
function truncateToBytes(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text
  const ellipsis = '…'
  let used = byteLength(ellipsis)
  if (used > maxBytes) return ''
  const kept: string[] = []
  for (const character of text) {
    used += byteLength(character)
    if (used > maxBytes) break
    kept.push(character)
  }
  return `${kept.join('')}${ellipsis}`
}

/** Flatten a thrown value into one line. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
