/**
 * Workspace write lease: one write-class tool call at a time, in arrival order.
 *
 * A `tools/execute` wrapper serializes write-class tool calls per canonical
 * workspace root. A call takes the lease immediately before its tool body runs
 * and gives it back as soon as that body settles, so two Sessions that both
 * write take turns per call instead of one Session owning the checkout for a
 * whole turn. Read-class and exempt calls never acquire.
 *
 * A write that finds the lease taken joins a FIFO queue. Every waiting call
 * appends one entry with a monotonically increasing sequence number, and a call
 * may take the lease only while it is the queue head: the decision is made by
 * the same exclusive read-decide-write step that writes the record, so a call
 * that arrives later can never overtake one that arrived earlier. Head and
 * holder both wait on the same poll, so the released lease passes straight down
 * the queue. A call that waits longer than `queueTimeoutMs` (two minutes by
 * default) leaves the queue and fails with `WORKSPACE_LEASE_QUEUE_TIMEOUT`; a
 * call whose cancellation signal fires leaves the queue as well, so the next
 * waiter advances. A Session that already holds the lease re-enters, so its own
 * parallel write calls cannot deadlock behind it.
 *
 * The record lives outside the workspace at `$DSH_HOME/workspaces/<key>/lease.json`,
 * the queue at `lease-queue.json` beside it, and one short-lived `lease.lock`
 * file makes each read-decide-write step atomic across every process sharing
 * the home: a process creates it exclusively, removes it in a `finally`, and
 * treats one older than `LEASE_LOCK_STALE_MS` as abandoned. Every acquisition,
 * queue join, refusal, reclaim, release, and loss appends one JSON line to
 * `$DSH_HOME/logs/workspace-lease.jsonl`.
 *
 * The holder renews the record every `LEASE_HEARTBEAT_MS` while its tool body
 * runs, so a long write keeps the lease; a record whose process is gone, or
 * that has not been renewed for one idle window, is reclaimed by the queue head
 * instead of stalling the queue. The record is also released when the holder's
 * turn ends and when its Session is disposed, which are the fallbacks for a
 * call that never reaches its own release.
 *
 * @module @deepseek-ai/dsh-workspace-tools/lease
 */

import { appendFile, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolDispatchExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { realpathNormalize } from '@deepseek-ai/dsh-workspace'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** How one tool call relates to the write lease. */
export type LeaseClass = 'write' | 'read' | 'exempt'

/** Idle window after which an unrenewed lease may be reclaimed: ten minutes. */
export const LEASE_IDLE_MS = 10 * 60 * 1000

/** Hard cap on one lease's life, renewed or not: eight hours. */
export const LEASE_MAX_MS = 8 * 60 * 60 * 1000

/** How long one write call waits in the queue before it fails: two minutes. */
export const LEASE_QUEUE_TIMEOUT_MS = 2 * 60 * 1000

/** Poll interval of a waiting call, before the per-wait jitter: fifty milliseconds. */
export const LEASE_POLL_MS = 50

/** Renewal interval of a holder whose tool body runs long: five seconds. */
export const LEASE_HEARTBEAT_MS = 5 * 1000

/** Age after which an abandoned `lease.lock` file is reclaimed: ten seconds. */
export const LEASE_LOCK_STALE_MS = 10 * 1000

/** How long one state transition waits for `lease.lock` before it fails: fifteen seconds. */
export const LEASE_LOCK_WAIT_MS = 15 * 1000

/** Silence after which a queue entry from another process is assumed abandoned: one minute. */
export const LEASE_QUEUE_ENTRY_STALE_MS = 60 * 1000

/** Refusal code for a write refused without queueing, when queueing is disabled. */
export const WORKSPACE_LEASE_HELD = 'WORKSPACE_LEASE_HELD'

/** Refusal code for a write whose lease was reclaimed by another Session. */
export const WORKSPACE_LEASE_LOST = 'WORKSPACE_LEASE_LOST'

/** Refusal code for a write that waited `queueTimeoutMs` without reaching the lease. */
export const WORKSPACE_LEASE_QUEUE_TIMEOUT = 'WORKSPACE_LEASE_QUEUE_TIMEOUT'

/** Tools that only read workspace content or harness state, so they never acquire. */
const READ_TOOLS: ReadonlySet<string> = new Set([
  'read', 'read_image', 'glob', 'grep',
  'session_search', 'session_event_read', 'session_event_search', 'session_trace', 'session_event_trace',
  'memory_search', 'web_search', 'web_fetch',
  'list_agents', 'list_subagent_models', 'wait_agent',
  'job_list', 'job_output',
  'cordis_inspect', 'load_workspace_dependencies',
  'get_goal', 'personality_analyze',
  'ask_user_question', 'ask_user_question_plus', 'todo_write', 'present', 'skill', 'count_tokens',
])

/** Control-plane tools whose writes are append-only or version-guarded, never checkout content. */
const EXEMPT_TOOLS: ReadonlySet<string> = new Set([
  'memory_write', 'memory_forget',
  'workspace_intents', 'workspace_tasks', 'workspace_message', 'workspace_artifacts',
  'send_message', 'subagent', 'subagent_fork', 'workflow',
  'create_goal', 'update_goal', 'job_kill', 'personality_apply',
  'schedule_create', 'schedule_edit', 'schedule_list', 'schedule_view',
])

/** `workspace_sessions` actions that never change checkout content. */
const EXEMPT_SESSION_ACTIONS: ReadonlySet<string> = new Set([
  'list', 'get', 'run', 'start', 'append', 'prompt', 'stop', 'abort', 'fork', 'archive', 'compact', 'delete',
])

/** `persona_state` actions that only read the recorded persona state. */
const READ_PERSONA_ACTIONS: ReadonlySet<string> = new Set([
  'show',
])

/** `plugin_manager` actions that only read the installed profile. */
const READ_PLUGIN_ACTIONS: ReadonlySet<string> = new Set([
  'list_plugins', 'list_bundles', 'list_version_exemptions',
])

/**
 * `plugin_manager` actions that change the profile, never checkout content.
 * Installing or removing a plugin runs that plugin's install scripts, which is
 * the profile owner's decision and not another Session's checkout: serializing
 * it behind a workspace write would refuse a profile change for a writer that
 * touches no files in that checkout.
 */
const PROFILE_PLUGIN_ACTIONS: ReadonlySet<string> = new Set([
  'install_bundle', 'set_plugin', 'set_bundle', 'remove_bundle', 'set_version_exemption',
])

/** Tools whose class comes from the call's action rather than from the name alone. */
const ACTION_SCOPED_TOOLS: ReadonlySet<string> = new Set([
  'workspace_sessions', 'persona_state', 'plugin_manager',
])

/**
 * Read the action selector out of a call's arguments.
 * @param args - parsed call arguments of any shape.
 * @returns the action name, or undefined when the call carries none.
 */
function actionOf(args: unknown): string | undefined {
  const action = (args as { action?: unknown } | null)?.action
  return typeof action === 'string' ? action : undefined
}

/**
 * Classify one tool call.
 *
 * An unknown tool is a write: the failure this lease prevents is a missed
 * write, so the default must be restrictive. `workspace_sessions`,
 * `persona_state`, and `plugin_manager` are the names whose class depends on
 * their action; a missing or unrecognized action falls back to write.
 * @param name - registered tool name.
 * @param args - parsed call arguments, read only for the action selector.
 * @returns the lease class of the call.
 */
export function classifyLeaseTool(name: string, args: unknown): LeaseClass {
  const action = actionOf(args)
  if (name === 'workspace_sessions') {
    return action !== undefined && EXEMPT_SESSION_ACTIONS.has(action) ? 'exempt' : 'write'
  }
  if (name === 'persona_state') {
    return action !== undefined && READ_PERSONA_ACTIONS.has(action) ? 'read' : 'write'
  }
  if (name === 'plugin_manager') {
    if (action !== undefined && READ_PLUGIN_ACTIONS.has(action)) return 'read'
    if (action !== undefined && PROFILE_PLUGIN_ACTIONS.has(action)) return 'exempt'
    return 'write'
  }
  if (READ_TOOLS.has(name)) return 'read'
  if (EXEMPT_TOOLS.has(name)) return 'exempt'
  return 'write'
}

/**
 * Whether {@link classifyLeaseTool} resolves a name from an explicit entry
 * instead of the write default. A tool that lands without a decision keeps the
 * restrictive default; the classification tests use this predicate to fail
 * before that default silently serializes a read behind a writer.
 * @param name - registered tool name.
 * @returns true for an explicit read, exempt, or action-scoped entry.
 */
export function hasExplicitLeaseClass(name: string): boolean {
  return ACTION_SCOPED_TOOLS.has(name) || READ_TOOLS.has(name) || EXEMPT_TOOLS.has(name)
}

/** One durable lease record. */
interface LeaseRecord {
  readonly version: 1
  readonly root: string
  readonly sessionId: string
  readonly generation: number
  readonly acquiredAt: string
  readonly renewedAt: string
  readonly lastOperation: string
  readonly idleExpiresAt: string
  readonly maxExpiresAt: string
  readonly hostId: string
  readonly pid: number
}

/** One write call waiting for the lease, ordered by `seq`. */
interface QueueEntry {
  readonly seq: number
  readonly sessionId: string
  readonly operation: string
  readonly pid: number
  readonly hostId: string
  readonly enqueuedAt: string
  readonly heartbeatAt: string
}

/** The queue file beside the record. */
interface QueueFile {
  version: 1
  nextSeq: number
  entries: QueueEntry[]
}

/** Injectable environment for the guard, so tests own the clock, home, and host identity. */
export interface LeaseGuardOptions {
  /** Harness home that holds the lease records and the audit log. */
  readonly home: string
  /** Clock override; defaults to the wall clock. */
  readonly now?: () => number
  /** Host identity written into each record; defaults to one value per process. */
  readonly hostId?: string
  /** Process id written into each record; defaults to the current process. */
  readonly pid?: number
  /** `enforce` serializes writes; `observe` audits a conflict and lets the call run. */
  readonly mode?: 'enforce' | 'observe'
  /** Idle window in milliseconds. */
  readonly idleMs?: number
  /** Hard lifetime cap in milliseconds. */
  readonly maxMs?: number
  /** How long one call waits in the queue, in milliseconds; `0` refuses instead of queueing. */
  readonly queueTimeoutMs?: number
  /** Poll interval of a waiting call, in milliseconds. */
  readonly pollMs?: number
  /** Renewal interval of a long-running holder, in milliseconds. */
  readonly heartbeatMs?: number
  /** Age after which an abandoned lock file is reclaimed, in milliseconds. */
  readonly lockStaleMs?: number
  /** How long one state transition waits for the lock, in milliseconds. */
  readonly lockWaitMs?: number
  /** Silence after which another process's queue entry is abandoned, in milliseconds. */
  readonly queueEntryStaleMs?: number
}

/** What the guard remembers about the lease one Session holds. */
interface HeldLease {
  readonly key: string
  readonly generation: number
  /** Open write calls of this Session holding the lease; the record goes away at zero. */
  count: number
}

/** What one dispatch may do with the lease. */
export interface LeaseDecision {
  /** Refusal to return instead of dispatching, when the call may not run. */
  readonly result?: ToolExecutionResult
  /** Whether this call added one hold that {@link WorkspaceLeaseGuard.afterTool} must give back. */
  readonly held: boolean
}

/** One lease guard, shared by every Session in the host process. */
export interface WorkspaceLeaseGuard {
  /**
   * Take the lease for one write call, waiting in the queue when it is taken.
   * @param exec - dispatch view of the call, carrying the calling Agent and its signal.
   * @returns the refusal to return, and whether the call now holds the lease.
   */
  beforeTool(exec: ToolDispatchExchange): Promise<LeaseDecision>
  /**
   * Give the lease back after one write call settled. Call it only for a
   * decision that reported `held`.
   * @param sessionId - Session whose call finished.
   */
  afterTool(sessionId: string): Promise<void>
  /**
   * Drop every hold of one Session, remove its record when that record is
   * still the Session's, and take it out of a queue it is waiting in. The
   * fallback for a call that never reached {@link WorkspaceLeaseGuard.afterTool}.
   * @param sessionId - Session releasing its lease.
   * @param operation - audit label for why the lease was released.
   * @returns true when a record or queue entry was removed.
   */
  release(sessionId: string, operation: string): Promise<boolean>
}

/** The dispatch fields the guard reads. */
export type ToolDispatchExchange = Pick<ToolDispatchExecution, 'name' | 'agent' | 'arguments'> & {
  /** Cancellation signal of the dispatching call; a queued wait aborts when it fires. */
  readonly signal?: AbortSignal
}

/** Host identity: one value per process, so records from another host are recognizable. */
const PROCESS_HOST_ID = randomUUID()

/** What one review of the record and the queue decided. */
type Claim =
  | { readonly kind: 'granted' }
  | { readonly kind: 'held'; readonly holder?: LeaseRecord; readonly position: number; readonly queueDepth: number }
  | { readonly kind: 'lost'; readonly holder: LeaseRecord }

/** What happened to one call that wanted the lease. */
type ClaimOutcome =
  | { readonly kind: 'granted'; readonly waitMs: number }
  | { readonly kind: 'lost'; readonly holder: LeaseRecord }
  | {
    readonly kind: 'refused'
    readonly timedOut: boolean
    readonly waitMs: number
    readonly holder?: LeaseRecord
    readonly position?: number
    readonly queueDepth?: number
  }

/**
 * Build the guard. One instance per host process; the plugin registers it on
 * `tools/execute` and releases on `session/event` turn ends and `agent/disposed`.
 * @param ctx - plugin context that carries the workspace registry.
 * @param options - home, clock, identity, mode, and lease windows.
 * @returns the guard.
 */
export function createWorkspaceLeaseGuard(ctx: Context, options: LeaseGuardOptions): WorkspaceLeaseGuard {
  const now = options.now ?? Date.now
  const hostId = options.hostId ?? PROCESS_HOST_ID
  const pid = options.pid ?? process.pid
  const mode = options.mode ?? 'enforce'
  const idleMs = options.idleMs ?? LEASE_IDLE_MS
  const maxMs = options.maxMs ?? LEASE_MAX_MS
  const queueTimeoutMs = options.queueTimeoutMs ?? LEASE_QUEUE_TIMEOUT_MS
  const pollMs = options.pollMs ?? LEASE_POLL_MS
  const heartbeatMs = options.heartbeatMs ?? LEASE_HEARTBEAT_MS
  const lockStaleMs = options.lockStaleMs ?? LEASE_LOCK_STALE_MS
  const lockWaitMs = options.lockWaitMs ?? LEASE_LOCK_WAIT_MS
  const queueEntryStaleMs = options.queueEntryStaleMs ?? LEASE_QUEUE_ENTRY_STALE_MS
  const held = new Map<string, HeldLease>()
  /** Sessions waiting in a queue right now, so a turn end can take them out. */
  const waiting = new Map<string, { key: string; root: string; operation: string }>()
  /** Bumped when a waiting Session is taken out of the queue, to stop its wait loop. */
  const waitEpoch = new Map<string, number>()
  const roots = new Map<string, string | undefined>()
  const chains = new Map<string, Promise<unknown>>()
  const heartbeats = new Map<string, NodeJS.Timeout>()

  const leasePath = (key: string): string => join(options.home, 'workspaces', key, 'lease.json')
  const queuePath = (key: string): string => join(options.home, 'workspaces', key, 'lease-queue.json')
  const lockPath = (key: string): string => join(options.home, 'workspaces', key, 'lease.lock')
  const auditPath = (): string => join(options.home, 'logs', 'workspace-lease.jsonl')

  async function audit(entry: Record<string, unknown>): Promise<void> {
    const line = `${JSON.stringify({ ts: new Date(now()).toISOString(), ...entry })}\n`
    await mkdir(dirname(auditPath()), { recursive: true })
    await appendFile(auditPath(), line, 'utf8')
  }

  /**
   * Run one state transition with no other transition of this checkout running,
   * in this process and in any other process sharing the home.
   * @param key - checkout key.
   * @param run - the transition, which must not await anything but file I/O.
   * @returns the transition's value.
   */
  async function transactional<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = chains.get(key) ?? Promise.resolve()
    const current = previous.then(run, run)
    const settled = current.then(() => undefined, () => undefined)
    chains.set(key, settled)
    try {
      return await current
    } finally {
      if (chains.get(key) === settled) chains.delete(key)
    }
  }

  /**
   * Take the lock file, waiting for a concurrent transition to finish.
   * @param key - checkout key.
   * @returns the token that identifies this transition's lock file.
   */
  async function lock(key: string): Promise<string> {
    const target = lockPath(key)
    await mkdir(dirname(target), { recursive: true })
    const token = randomUUID()
    const deadline = Date.now() + lockWaitMs
    for (;;) {
      try {
        const handle = await open(target, 'wx')
        try {
          await handle.writeFile(JSON.stringify({ pid, hostId, token }), 'utf8')
        } finally {
          await handle.close()
        }
        return token
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        let stale = false
        try {
          stale = (Date.now() - (await stat(target)).mtimeMs) > lockStaleMs
        } catch {
          // The holder removed the lock after the failed create and before this probe.
        }
        if (stale) {
          await rm(target, { force: true })
          continue
        }
        if (Date.now() > deadline) {
          throw new Error(`workspace lease: could not take ${target} within ${String(lockWaitMs)}ms`)
        }
        await sleep(5 + Math.random() * 15)
      }
    }
  }

  /**
   * Remove the lock file only when it is still this transition's. Another
   * process may have reclaimed an over-age lock while this process was paused,
   * and deleting that one would let two transitions run at once.
   * @param key - checkout key.
   * @param token - the value {@link lock} wrote into this transition's file.
   */
  async function unlock(key: string, token: string): Promise<void> {
    const target = lockPath(key)
    try {
      const holder = JSON.parse(await readFile(target, 'utf8')) as { token?: unknown }
      if (holder.token !== token) return
      await rm(target, { force: true })
    } catch {
      // The lock is already gone, or it was reclaimed and replaced.
    }
  }

  async function exclusive<T>(key: string, run: () => Promise<T>): Promise<T> {
    return transactional(key, async () => {
      const token = await lock(key)
      try {
        return await run()
      } finally {
        await unlock(key, token)
      }
    })
  }

  async function readRecord(key: string): Promise<LeaseRecord | undefined> {
    try {
      const parsed: unknown = JSON.parse(await readFile(leasePath(key), 'utf8'))
      if (parsed === null || typeof parsed !== 'object') return undefined
      const candidate = parsed as { version?: unknown; sessionId?: unknown; generation?: unknown }
      if (candidate.version !== 1 || typeof candidate.sessionId !== 'string'
        || typeof candidate.generation !== 'number') {
        return undefined
      }
      return parsed as LeaseRecord
    } catch {
      return undefined
    }
  }

  async function writeRecord(key: string, record: LeaseRecord): Promise<void> {
    const target = leasePath(key)
    await mkdir(dirname(target), { recursive: true })
    const temporary = `${target}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(record, undefined, 2)}\n`, 'utf8')
    await rename(temporary, target)
  }

  async function readQueue(key: string): Promise<QueueFile> {
    try {
      const parsed: unknown = JSON.parse(await readFile(queuePath(key), 'utf8'))
      if (parsed === null || typeof parsed !== 'object') return { version: 1, nextSeq: 1, entries: [] }
      const file = parsed as Partial<QueueFile>
      const entries = Array.isArray(file.entries) ? file.entries.filter(queueEntryOf) : []
      const nextSeq = typeof file.nextSeq === 'number' ? file.nextSeq : highestSeq(entries) + 1
      return { version: 1, nextSeq, entries }
    } catch {
      return { version: 1, nextSeq: 1, entries: [] }
    }
  }

  async function writeQueue(key: string, queue: QueueFile): Promise<void> {
    const target = queuePath(key)
    await mkdir(dirname(target), { recursive: true })
    const temporary = `${target}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(queue, undefined, 2)}\n`, 'utf8')
    await rename(temporary, target)
  }

  /**
   * Whether the record's owning process is gone. Only a record from this host
   * can be probed; a record from another host keeps the idle window instead.
   * @param record - lease record under evaluation.
   * @returns true when the recorded process no longer exists.
   */
  function processGone(record: LeaseRecord): boolean {
    if (record.hostId !== hostId || record.pid === pid) return false
    return !processAlive(record.pid)
  }

  /**
   * Moment this record becomes reclaimable: its idle expiry, capped by its
   * maximum life. The holder renews the idle expiry while its body runs.
   * @param record - lease record under evaluation.
   * @returns epoch milliseconds of the reclaim moment.
   */
  function reclaimAt(record: LeaseRecord): number {
    return Math.min(Date.parse(record.idleExpiresAt), Date.parse(record.maxExpiresAt))
  }

  function reclaimable(record: LeaseRecord): boolean {
    return now() > reclaimAt(record) || processGone(record)
  }

  /**
   * Whether a queue entry no longer has a waiter behind it. This process's own
   * entries are never stale while its wait loop refreshes them; another
   * process's entry is stale once its process is gone or its heartbeat aged out.
   * @param entry - queue entry under evaluation.
   * @returns true when the entry may be dropped.
   */
  function entryGone(entry: QueueEntry): boolean {
    if (entry.hostId === hostId && entry.pid === pid) return false
    if (now() - Date.parse(entry.heartbeatAt) > queueEntryStaleMs) return true
    return entry.hostId === hostId && !processAlive(entry.pid)
  }

  function refusal(
    code: string,
    text: string,
    info: Record<string, unknown> = {},
  ): ToolExecutionResult {
    return {
      content: [{ type: 'text', text }],
      isError: true,
      error: { message: text, info: { name: 'WorkspaceLeaseError', code, ...info } },
    }
  }

  function describe(record: LeaseRecord): string {
    return `session ${record.sessionId} acquired ${record.acquiredAt} (last ${record.lastOperation}; `
      + `idle expiry ${record.idleExpiresAt}; maximum life ${record.maxExpiresAt})`
  }

  /**
   * Refusal for a fenced writer: name the Session that now owns the lease and
   * the moment one retry reclaims it, so the conflict is actionable rather than
   * a permanent stop.
   * @param root - canonical workspace root the record is keyed by.
   * @param mine - the lease state this Session remembers holding.
   * @param current - the record the other Session now owns.
   * @returns the refusal result with its structured identity.
   */
  function lostRefusal(root: string, mine: HeldLease, current: LeaseRecord): ToolExecutionResult {
    const reclaim = reclaimAt(current)
    const retryAfterMs = Math.max(0, reclaim - now())
    return refusal(
      WORKSPACE_LEASE_LOST,
      `WORKSPACE_LEASE_LOST\nworkspace:  ${root}\nholder:     ${describe(current)}\n`
      + `lease generation ${String(current.generation)} replaced ${String(mine.generation)}; another Session now holds `
      + `the write lease. The record becomes reclaimable in ${String(Math.ceil(retryAfterMs / 1000))}s (at `
      + `${new Date(reclaim).toISOString()}), and an expired record is reclaimed automatically on your `
      + 'next write: retry once after that moment and this write proceeds. If the holder\'s write is still running, '
      + 'wait for it to end first; report the conflict only if a retry after that moment is still refused.',
      {
        root,
        holderSessionId: current.sessionId,
        holderOperation: current.lastOperation,
        idleExpiresAt: current.idleExpiresAt,
        retryAfterMs,
      },
    )
  }

  /**
   * Refusal for a write whose FIFO wait ran out: the record stayed taken for
   * the whole window, so this call left the queue without running.
   * @param root - canonical workspace root the record is keyed by.
   * @param holder - the record that was held for the whole wait, when it still exists.
   * @param waitMs - how long this call waited.
   * @param position - the queue position this call held while waiting.
   * @param queueDepth - how many calls were queued when it gave up.
   * @returns the refusal result with its structured identity.
   */
  function queueTimeoutRefusal(
    root: string,
    holder: LeaseRecord | undefined,
    waitMs: number,
    position: number | undefined,
    queueDepth: number | undefined,
  ): ToolExecutionResult {
    const reclaim = holder === undefined ? now() : reclaimAt(holder)
    const retryAfterMs = Math.max(0, reclaim - now())
    const behind = position === undefined ? 'the queue' : `queue position ${String(position)}`
    const who = holder === undefined ? 'holder:     unknown\n' : `holder:     ${describe(holder)}\n`
    return refusal(
      WORKSPACE_LEASE_QUEUE_TIMEOUT,
      `WORKSPACE_LEASE_QUEUE_TIMEOUT\nworkspace:  ${root}\n${who}`
      + `waited ${String(Math.ceil(waitMs / 1000))}s in a first-in-first-out queue at ${behind} `
      + `(${String(queueDepth ?? 0)} queued) without reaching the lease, so this write did not run and left the queue. `
      + 'The holder\'s write is still running or its process did not release the lease. Retry the same call later; '
      + `the record becomes reclaimable at ${new Date(reclaim).toISOString()} (in `
      + `${String(Math.ceil(retryAfterMs / 1000))}s) if it is abandoned.`,
      {
        root,
        waitMs,
        ...(position === undefined ? {} : { queuePosition: position }),
        ...(queueDepth === undefined ? {} : { queueDepth }),
        ...(holder === undefined
          ? {}
          : {
            holderSessionId: holder.sessionId,
            holderOperation: holder.lastOperation,
            idleExpiresAt: holder.idleExpiresAt,
            retryAfterMs,
          }),
      },
    )
  }

  /**
   * Refusal for a write the guard must not queue, which today means queueing is
   * switched off (`queueTimeoutMs: 0`).
   * @param root - canonical workspace root the record is keyed by.
   * @param holder - the record another Session holds.
   * @returns the refusal result with its structured identity.
   */
  function heldRefusal(root: string, holder: LeaseRecord): ToolExecutionResult {
    const reclaim = reclaimAt(holder)
    const retryAfterMs = Math.max(0, reclaim - now())
    return refusal(
      WORKSPACE_LEASE_HELD,
      `WORKSPACE_LEASE_HELD\nworkspace:  ${root}\nholder:     ${describe(holder)}\n`
      + 'Queueing is off (queueTimeoutMs: 0), so this write was refused instead of waiting. The holder\'s write frees '
      + `the lease when it finishes, or at latest ${new Date(reclaim).toISOString()} (in `
      + `${String(Math.ceil(retryAfterMs / 1000))}s), when the record becomes reclaimable. Retry once after that `
      + 'moment; do not retry in a loop.',
      {
        root,
        holderSessionId: holder.sessionId,
        holderOperation: holder.lastOperation,
        idleExpiresAt: holder.idleExpiresAt,
        retryAfterMs,
      },
    )
  }

  function recordFor(root: string, sessionId: string, generation: number, operation: string): LeaseRecord {
    const at = new Date(now()).toISOString()
    return {
      version: 1,
      root,
      sessionId,
      generation,
      acquiredAt: at,
      renewedAt: at,
      lastOperation: operation,
      idleExpiresAt: new Date(now() + idleMs).toISOString(),
      maxExpiresAt: new Date(now() + maxMs).toISOString(),
      hostId,
      pid,
    }
  }

  async function rootOf(session: Session): Promise<string | undefined> {
    const accounted: Workspace | undefined = ctx.get('workspaceRegistry')
      ?.list().find(workspace => workspace.sessionIds.includes(session.id))
    if (accounted !== undefined) return accounted.path
    const cwd = session.header.cwd
    if (cwd === undefined) return undefined
    try {
      return await realpathNormalize(cwd)
    } catch {
      return resolve(cwd)
    }
  }

  async function keyOf(session: Session): Promise<{ key: string; root: string } | undefined> {
    const cached = roots.get(String(session.id))
    const root = cached ?? await rootOf(session)
    roots.set(String(session.id), root)
    if (root === undefined) return undefined
    const accounted = ctx.get('workspaceRegistry')?.list().find(workspace => workspace.path === root)
    const key = accounted === undefined
      ? `lease-${createHash('sha256').update(root).digest('hex').slice(0, 16)}`
      : String(accounted.id)
    return { key, root }
  }

  /** Keep the record fresh while a long tool body runs, so the queue does not reclaim it. */
  function startHeartbeat(sessionId: string, key: string, generation: number): void {
    stopHeartbeat(sessionId)
    if (heartbeatMs <= 0) return
    const timer = setInterval(() => {
      void beat(sessionId, key, generation)
    }, heartbeatMs)
    timer.unref()
    heartbeats.set(sessionId, timer)
  }

  function stopHeartbeat(sessionId: string): void {
    const timer = heartbeats.get(sessionId)
    if (timer === undefined) return
    clearInterval(timer)
    heartbeats.delete(sessionId)
  }

  async function beat(sessionId: string, key: string, generation: number): Promise<void> {
    try {
      await exclusive(key, async () => {
        const record = await readRecord(key)
        if (record === undefined || record.sessionId !== sessionId || record.generation !== generation) return
        await writeRecord(key, {
          ...record,
          renewedAt: new Date(now()).toISOString(),
          idleExpiresAt: new Date(now() + idleMs).toISOString(),
        })
      })
    } catch (error: unknown) {
      ctx.logger.warn(
        'workspace-tools: lease heartbeat for %s failed: %s',
        sessionId,
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  /**
   * Read the record and the queue, then grant, keep waiting, or report the
   * lease was lost. Every mutation of either file happens here, under the lock,
   * which is what makes arrival order the grant order.
   * @param input - checkout, Session, operation, and whether this call waited.
   * @returns the decision for this call.
   */
  async function review(input: {
    readonly key: string
    readonly root: string
    readonly sessionId: string
    readonly operation: string
    readonly waited: boolean
    readonly waitMs: number
    /** How long this call may queue; `0` refuses instead of joining the queue. */
    readonly queueMs: number
  }): Promise<Claim> {
    const { key, root, sessionId, operation } = input
    return exclusive(key, async () => {
      const record = await readRecord(key)
      const queue = await readQueue(key)
      const kept = queue.entries.filter(entry => !entryGone(entry))
      let dirty = kept.length !== queue.entries.length
      queue.entries = kept
      const mine = held.get(sessionId)

      const dropMine = (): void => {
        const index = queue.entries.findIndex(entry => entry.sessionId === sessionId)
        if (index < 0) return
        queue.entries.splice(index, 1)
        dirty = true
      }

      if (record !== undefined && record.sessionId === sessionId) {
        // The Session already holds the lease — a parallel call re-enters, and a
        // serial call renews. Both count as one open call on top of the holding.
        const count = (mine !== undefined && mine.key === key ? mine.count : 0) + 1
        await writeRecord(key, {
          ...record,
          renewedAt: new Date(now()).toISOString(),
          lastOperation: operation,
          idleExpiresAt: new Date(now() + idleMs).toISOString(),
        })
        dropMine()
        if (dirty) await writeQueue(key, queue)
        waiting.delete(sessionId)
        held.set(sessionId, { key, generation: record.generation, count })
        startHeartbeat(sessionId, key, record.generation)
        return { kind: 'granted' }
      }

      if (mine !== undefined && mine.key === key && mine.count > 0
        && record !== undefined && !reclaimable(record)) {
        // This Session believed it held the lease, and another Session now does:
        // the fencing generation moved on while these calls were open.
        await audit({ event: 'lost', workspace: root, sessionId, operation, generation: mine.generation })
        return { kind: 'lost', holder: record }
      }

      const ahead = queue.entries.findIndex(entry => entry.sessionId === sessionId)
      const queuedBefore = ahead < 0 ? queue.entries.length : ahead

      const wait = async (): Promise<Claim> => {
        let index = queue.entries.findIndex(entry => entry.sessionId === sessionId)
        let joined = false
        if (index < 0 && input.queueMs > 0) {
          const seq = queue.nextSeq
          const at = new Date(now()).toISOString()
          queue.nextSeq = seq + 1
          queue.entries.push({ seq, sessionId, operation, pid, hostId, enqueuedAt: at, heartbeatAt: at })
          index = queue.entries.length - 1
          dirty = true
          joined = true
        } else if (index >= 0) {
          const entry = queue.entries[index]
          if (entry !== undefined && now() - Date.parse(entry.heartbeatAt) > heartbeatMs) {
            queue.entries[index] = { ...entry, heartbeatAt: new Date(now()).toISOString() }
            dirty = true
          }
        }
        if (dirty) await writeQueue(key, queue)
        if (joined) {
          await audit({
            event: 'queued', workspace: root, sessionId, operation,
            position: index + 1, queueDepth: queue.entries.length,
          })
        }
        if (index >= 0) waiting.set(sessionId, { key, root, operation })
        return {
          kind: 'held',
          ...(record === undefined ? {} : { holder: record }),
          position: index + 1,
          queueDepth: queue.entries.length,
        }
      }

      const admit = async (): Promise<Claim> => {
        const generation = record === undefined ? 1 : record.generation + 1
        await writeRecord(key, recordFor(root, sessionId, generation, operation))
        if (record !== undefined) {
          await audit({
            event: 'reclaimed', workspace: root, sessionId, operation,
            holder: record.sessionId, generation,
          })
        }
        dropMine()
        if (dirty) await writeQueue(key, queue)
        waiting.delete(sessionId)
        held.set(sessionId, {
          key,
          generation,
          count: (mine !== undefined && mine.key === key ? mine.count : 0) + 1,
        })
        startHeartbeat(sessionId, key, generation)
        await audit({
          event: 'acquired', workspace: root, sessionId, operation, generation,
          ...(input.waited ? { waitMs: input.waitMs, queueDepth: queue.entries.length + 1 } : {}),
        })
        return { kind: 'granted' }
      }

      if (record === undefined || reclaimable(record)) {
        // Free, or abandoned: only the queue head may take it, so a call that
        // arrived earlier is never overtaken.
        if (queuedBefore > 0) return wait()
        return admit()
      }

      // Held by another live Session.
      return wait()
    })
  }

  /**
   * Remove this Session's queue entry, so a cancelled or timed-out call does
   * not block the calls behind it.
   * @param key - checkout key.
   * @param root - canonical workspace root, for the audit line.
   * @param sessionId - Session leaving the queue.
   * @param operation - the tool call it was waiting for.
   * @param reason - audit label.
   */
  async function leaveQueue(
    key: string,
    root: string,
    sessionId: string,
    operation: string,
    reason: string,
  ): Promise<void> {
    await exclusive(key, async () => {
      const queue = await readQueue(key)
      const index = queue.entries.findIndex(entry => entry.sessionId === sessionId)
      if (index < 0) return
      queue.entries.splice(index, 1)
      await writeQueue(key, queue)
      await audit({ event: reason, workspace: root, sessionId, operation, queueDepth: queue.entries.length })
    })
    waiting.delete(sessionId)
  }

  /**
   * Take the lease for one call, waiting in the queue while another Session
   * holds it.
   * @param input - checkout, Session, operation, and the call's signal.
   * @returns what happened to the call.
   */
  async function claim(input: {
    readonly key: string
    readonly root: string
    readonly sessionId: string
    readonly operation: string
    readonly queueMs: number
    readonly signal?: AbortSignal
  }): Promise<ClaimOutcome> {
    const startedAt = now()
    const epoch = waitEpoch.get(input.sessionId) ?? 0
    for (;;) {
      if (input.signal?.aborted === true || (waitEpoch.get(input.sessionId) ?? 0) !== epoch) {
        await leaveQueue(input.key, input.root, input.sessionId, input.operation, 'queue_cancelled')
        throw input.signal?.aborted === true
          ? input.signal.reason
          : new Error('workspace lease: the waiting Session stopped waiting')
      }
      const waited = now() - startedAt
      const step = await review({ ...input, waited: waited > 0, waitMs: waited })
      if (step.kind === 'granted') {
        waiting.delete(input.sessionId)
        return { kind: 'granted', waitMs: waited }
      }
      if (step.kind === 'lost') return { kind: 'lost', holder: step.holder }
      if (input.queueMs <= 0) {
        await leaveQueue(input.key, input.root, input.sessionId, input.operation, 'queue_refused')
        return {
          kind: 'refused', timedOut: false, waitMs: waited,
          ...(step.holder === undefined ? {} : { holder: step.holder }),
          position: step.position,
          queueDepth: step.queueDepth,
        }
      }
      if (waited >= input.queueMs) {
        await leaveQueue(input.key, input.root, input.sessionId, input.operation, 'queue_timeout')
        return {
          kind: 'refused', timedOut: true, waitMs: waited,
          ...(step.holder === undefined ? {} : { holder: step.holder }),
          position: step.position,
          queueDepth: step.queueDepth,
        }
      }
      await sleep(pollMs + Math.random() * pollMs)
    }
  }

  async function beforeTool(exec: ToolDispatchExchange): Promise<LeaseDecision> {
    const agent: Agent | undefined = exec.agent
    if (agent === undefined) return { held: false }
    if (classifyLeaseTool(exec.name, exec.arguments) !== 'write') return { held: false }
    const resolved = await keyOf(agent.session)
    if (resolved === undefined) return { held: false }
    const { key, root } = resolved
    const sessionId = String(agent.session.id)

    const observe = mode === 'observe'
    const outcome = await claim({
      key,
      root,
      sessionId,
      operation: exec.name,
      queueMs: observe ? 0 : queueTimeoutMs,
      ...(exec.signal === undefined ? {} : { signal: exec.signal }),
    })
    if (outcome.kind === 'granted') return { held: true }
    if (outcome.kind === 'lost') {
      // Observe mode never refuses: a replaced record is audited only by `lost`.
      if (observe) return { held: false }
      const mine = held.get(sessionId)
      if (mine === undefined) return { held: false }
      return { result: lostRefusal(root, mine, outcome.holder), held: false }
    }
    if (observe) {
      await audit({
        event: 'denied', workspace: root, sessionId, operation: exec.name, result: 'observe',
        ...(outcome.holder === undefined
          ? {}
          : { holder: outcome.holder.sessionId, generation: outcome.holder.generation }),
      })
      return { held: false }
    }
    if (outcome.timedOut) {
      return {
        result: queueTimeoutRefusal(root, outcome.holder, outcome.waitMs, outcome.position, outcome.queueDepth),
        held: false,
      }
    }
    if (outcome.holder === undefined) return { held: false }
    return { result: heldRefusal(root, outcome.holder), held: false }
  }

  async function afterTool(sessionId: string): Promise<void> {
    const mine = held.get(sessionId)
    if (mine === undefined) return
    if (mine.count > 1) {
      mine.count -= 1
      return
    }
    held.delete(sessionId)
    stopHeartbeat(sessionId)
    const current = await readRecord(mine.key)
    if (current === undefined || current.sessionId !== sessionId || current.generation !== mine.generation) return
    await exclusive(mine.key, async () => {
      const record = await readRecord(mine.key)
      if (record === undefined || record.sessionId !== sessionId || record.generation !== mine.generation) return
      await rm(leasePath(mine.key), { force: true })
      await audit({
        event: 'released', workspace: record.root, sessionId, operation: 'tool end',
        generation: record.generation,
      })
    })
  }

  async function release(sessionId: string, operation: string): Promise<boolean> {
    const mine = held.get(sessionId)
    if (mine === undefined) {
      // A Session that ended its turn, was disposed, or was archived while it
      // waited leaves the queue here, so the calls behind it keep moving.
      const pending = waiting.get(sessionId)
      if (pending === undefined) return false
      waiting.delete(sessionId)
      waitEpoch.set(sessionId, (waitEpoch.get(sessionId) ?? 0) + 1)
      await leaveQueue(pending.key, pending.root, sessionId, pending.operation, 'queue_cancelled')
      return true
    }
    held.delete(sessionId)
    stopHeartbeat(sessionId)
    return exclusive(mine.key, async () => {
      const record = await readRecord(mine.key)
      if (record === undefined || record.sessionId !== sessionId || record.generation !== mine.generation) return false
      await rm(leasePath(mine.key), { force: true })
      await audit({
        event: 'released', workspace: record.root, sessionId, operation,
        generation: record.generation,
      })
      return true
    })
  }

  return { beforeTool, afterTool, release }
}

/**
 * Mount the guard on a plugin context: take the lease for every write-class
 * call, give it back when that call settles, and release a Session's lease when
 * its turn ends, when it is archived, and again on disposal for a call that
 * never reached its own release.
 * @param ctx - plugin context that provides tools and carries the workspace registry.
 * @param options - home, clock, identity, mode, and lease windows.
 * @returns the mounted guard.
 */
export function mountWorkspaceLease(ctx: Context, options: LeaseGuardOptions): WorkspaceLeaseGuard {
  const guard = createWorkspaceLeaseGuard(ctx, options)
  ctx.on('tools/execute', async (exec, next): Promise<ToolExecutionResult> => {
    const session = exec.agent?.session
    const exchange: ToolDispatchExchange = exec.agent === undefined
      ? { name: exec.name, arguments: exec.arguments, signal: exec.signal }
      : { name: exec.name, agent: exec.agent, arguments: exec.arguments, signal: exec.signal }
    const decision = await guard.beforeTool(exchange)
    if (decision.result !== undefined) return decision.result
    try {
      const result = await next()
      // An archive succeeded, so the archived Session can never write again:
      // drop its lease now instead of waiting for a turn that will never end.
      const archived = archivedSessionOf(exec)
      if (archived !== undefined && !result.isError) {
        try {
          await guard.release(archived, 'session archived')
        } catch (error: unknown) {
          ctx.logger.warn(
            'workspace-tools: lease release after archiving %s failed: %s',
            archived,
            error instanceof Error ? error.message : String(error),
          )
        }
      }
      return result
    } finally {
      // Released even when the body threw or was cancelled, so the next writer
      // in the queue is never blocked by this call. Only a call that took a
      // hold gives one back; a read, a refused call, and an observe-mode call
      // that ran unheld leave the Session's open holds alone.
      if (decision.held && session !== undefined) {
        try {
          await guard.afterTool(String(session.id))
        } catch (error: unknown) {
          ctx.logger.warn(
            'workspace-tools: lease release after %s failed: %s',
            exec.name,
            error instanceof Error ? error.message : String(error),
          )
        }
      }
    }
  })
  ctx.on('session/event', (session: Session, event: SessionEvent): void => {
    if (event.type !== 'turn/end') return
    // The turn has irrevocably ended (agent-loop appends `turn/end` only after
    // `agent/turn-stopping` lets it close), so no further write of this turn can
    // follow. A call that never reached its own release is cleaned up here.
    void guard.release(String(session.id), 'turn end')
  })
  ctx.on('agent/disposed', ({ agent }) => {
    void guard.release(String(agent.session.id), 'session disposed')
  })
  return guard
}

/**
 * Parse one queue entry, or undefined when the durable record is malformed.
 * @param value - one element of the queue file's `entries` array.
 * @returns the entry when every field is present and typed.
 */
function queueEntryOf(value: unknown): value is QueueEntry {
  if (value === null || typeof value !== 'object') return false
  const entry = value as Partial<QueueEntry>
  return typeof entry.seq === 'number'
    && typeof entry.sessionId === 'string'
    && typeof entry.operation === 'string'
    && typeof entry.pid === 'number'
    && typeof entry.hostId === 'string'
    && typeof entry.enqueuedAt === 'string'
    && typeof entry.heartbeatAt === 'string'
}

/**
 * Highest sequence number in a queue, so a queue file without `nextSeq` cannot
 * hand out a number twice.
 * @param entries - parsed queue entries.
 * @returns the highest `seq`, or 0 when the queue is empty.
 */
function highestSeq(entries: readonly QueueEntry[]): number {
  return entries.reduce((highest, entry) => Math.max(highest, entry.seq), 0)
}

/**
 * Probe one process id without sending a signal.
 * @param target - process id to probe.
 * @returns true while the process exists.
 */
function processAlive(target: number): boolean {
  try {
    process.kill(target, 0)
    return true
  } catch (error: unknown) {
    // ESRCH means the process is gone; any other failure (for example EPERM)
    // leaves it alive from this caller's point of view.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/**
 * Wait for one poll interval.
 * @param ms - milliseconds to wait.
 */
function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolveSleep) => {
    setTimeout(resolveSleep, ms)
  })
}

/**
 * The Session a `workspace_sessions` archive call archived, when this call is
 * one. The caller may archive another Session, so the target is the argument,
 * not the calling Session.
 * @param exec - dispatch view of the call.
 * @returns the archived Session id, or undefined for any other call.
 */
function archivedSessionOf(exec: ToolDispatchExecution): string | undefined {
  if (exec.name !== 'workspace_sessions') return undefined
  const args = exec.arguments as { action?: unknown; sessionId?: unknown } | null | undefined
  if (args?.action !== 'archive') return undefined
  const sessionId = args.sessionId
  return typeof sessionId === 'string' && sessionId.trim() !== '' ? sessionId.trim() : undefined
}

/**
 * Resolve the default harness home for the guard.
 * @returns the home path the plugin records leases and audit lines under.
 */
export function defaultLeaseHome(): string {
  return resolveDshHome()
}
