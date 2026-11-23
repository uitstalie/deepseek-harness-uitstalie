/**
 * Workspace write lease: one writer per checkout.
 *
 * A `tools/execute` wrapper serializes write-class tool calls per canonical
 * workspace root. The first write-class call of a Session acquires the lease
 * before dispatch; a Session that already holds it renews on every later write.
 * Read-class and exempt calls never acquire. The record lives outside the
 * workspace at `$DSH_HOME/workspaces/<key>/lease.json`, and every acquisition,
 * refusal, reclaim, release, and loss appends one JSON line to
 * `$DSH_HOME/logs/workspace-lease.jsonl`.
 *
 * A lease is held by a Session, not by one call or one turn, so a multi-step
 * edit does not reacquire. It is released when the holder's turn ends, when the
 * Session is disposed, or when another Session archives the holder. It expires
 * after ten idle minutes or eight hours of total life, whichever comes first,
 * as the fallback for a holder that never reaches a turn boundary (a crashed
 * host or a disposed listener). While the holder's turn is still open in this
 * process, the idle window becomes `LEASE_ACTIVE_TURN_GRACE_MS` measured from
 * the last renewal, so a long model call does not cost a live writer its lease;
 * the hard lifetime cap still applies, and a record written by another host or
 * process keeps the plain idle window. An expired or stale record is reclaimed
 * by the next writer. Every acquisition and reclaim bumps a fencing generation,
 * and a holder whose generation moved on is refused with the current holder and
 * the moment a single retry can reclaim the record; once that record is gone,
 * expired, or its process is dead, the fenced holder reclaims it and continues.
 *
 * @module @deepseek-ai/dsh-workspace-tools/lease
 */

import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
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

/**
 * Idle window granted while the holder's turn is still open in this process:
 * forty-five minutes. A turn can run long without writing, and the ten idle
 * minutes would otherwise hand a live writer's lease to the next Session.
 */
export const LEASE_ACTIVE_TURN_GRACE_MS = 45 * 60 * 1000

/** Refusal code for a write while another Session holds the workspace lease. */
export const WORKSPACE_LEASE_HELD = 'WORKSPACE_LEASE_HELD'

/** Refusal code for a write whose lease was reclaimed by another Session. */
export const WORKSPACE_LEASE_LOST = 'WORKSPACE_LEASE_LOST'

/** Tools that only read workspace content or harness state, so they never acquire. */
const READ_TOOLS: ReadonlySet<string> = new Set([
  'read', 'glob', 'grep', 'list',
  'session_search', 'session_event_read', 'session_event_search', 'session_trace', 'session_event_trace',
  'memory_search', 'web_search', 'web_fetch',
  'list_agents', 'list_subagent_models', 'wait_agent',
  'ask_user_question', 'ask_user_question_plus', 'todo_write', 'present', 'skill', 'count_tokens',
])

/** Control-plane tools whose writes are append-only or version-guarded, never checkout content. */
const EXEMPT_TOOLS: ReadonlySet<string> = new Set([
  'memory_write', 'memory_forget',
  'workspace_intents', 'workspace_tasks', 'workspace_message', 'workspace_artifacts',
  'send_message', 'subagent', 'subagent_fork', 'workflow',
  'schedule_create', 'schedule_edit', 'schedule_list', 'schedule_view',
])

/** `workspace_sessions` actions that never change checkout content. */
const EXEMPT_SESSION_ACTIONS: ReadonlySet<string> = new Set([
  'list', 'get', 'run', 'start', 'append', 'prompt', 'stop', 'abort', 'fork', 'archive', 'compact', 'delete',
])

/**
 * Classify one tool call.
 *
 * An unknown tool is a write: the failure this lease prevents is a missed
 * write, so the default must be restrictive. `workspace_sessions` is the one
 * name whose class depends on its action.
 * @param name - registered tool name.
 * @param args - parsed call arguments, read only for the action selector.
 * @returns the lease class of the call.
 */
export function classifyLeaseTool(name: string, args: unknown): LeaseClass {
  if (name === 'workspace_sessions') {
    const action = (args as { action?: unknown } | null)?.action
    return typeof action === 'string' && EXEMPT_SESSION_ACTIONS.has(action) ? 'exempt' : 'write'
  }
  if (READ_TOOLS.has(name)) return 'read'
  if (EXEMPT_TOOLS.has(name)) return 'exempt'
  return 'write'
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
  /** `enforce` refuses a conflicting write; `observe` audits it and lets it run. */
  readonly mode?: 'enforce' | 'observe'
  /** Idle window in milliseconds. */
  readonly idleMs?: number
  /** Hard lifetime cap in milliseconds. */
  readonly maxMs?: number
  /** Idle window granted while this process's holder keeps a turn open, in milliseconds. */
  readonly activeTurnGraceMs?: number
}

/** What the guard remembers about the lease one Session holds. */
interface HeldLease {
  readonly key: string
  readonly generation: number
}

/** One lease guard, shared by every Session in the host process. */
export interface WorkspaceLeaseGuard {
  /**
   * Decide one tool call: acquire, renew, refuse, or ignore it.
   * @param exec - dispatch view of the call, carrying the calling Agent.
   * @returns a refusal result, or undefined to let the call run.
   */
  beforeTool(exec: ToolDispatchExchange): Promise<ToolExecutionResult | undefined>
  /**
   * Record that a Session's turn is open, so its held lease keeps the
   * active-turn grace until {@link noteTurnEnd}.
   * @param sessionId - Session whose turn just started.
   */
  noteTurnStart(sessionId: string): void
  /**
   * Record that a Session's turn closed, dropping its active-turn grace. The
   * lease itself is released separately, at the turn boundary.
   * @param sessionId - Session whose turn just ended.
   */
  noteTurnEnd(sessionId: string): void
  /**
   * Release the lease one Session holds, if the record is still that Session's.
   * @param sessionId - Session releasing its lease.
   * @param operation - audit label for why the lease was released.
   * @returns true when a record was removed.
   */
  release(sessionId: string, operation: string): Promise<boolean>
}

/** The dispatch fields the guard reads. */
export type ToolDispatchExchange = Pick<ToolDispatchExecution, 'name' | 'agent' | 'arguments'>

/** Host identity: one value per process, so records from another host are recognizable. */
const PROCESS_HOST_ID = randomUUID()

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
  const activeTurnGraceMs = options.activeTurnGraceMs ?? LEASE_ACTIVE_TURN_GRACE_MS
  const held = new Map<string, HeldLease>()
  const roots = new Map<string, string | undefined>()
  const openTurns = new Set<string>()

  const leasePath = (key: string): string => join(options.home, 'workspaces', key, 'lease.json')
  const auditPath = (): string => join(options.home, 'logs', 'workspace-lease.jsonl')

  async function audit(entry: Record<string, unknown>): Promise<void> {
    const line = `${JSON.stringify({ ts: new Date(now()).toISOString(), ...entry })}\n`
    await mkdir(dirname(auditPath()), { recursive: true })
    await appendFile(auditPath(), line, 'utf8')
  }

  async function readRecord(key: string): Promise<LeaseRecord | undefined> {
    try {
      const parsed = JSON.parse(await readFile(leasePath(key), 'utf8')) as LeaseRecord
      return parsed.version === 1 ? parsed : undefined
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

  /**
   * Whether this process holds `record` for a Session whose turn is still open.
   * The host identity is minted once per process, so a record written by another
   * host or process never inherits the grace.
   * @param record - lease record under evaluation.
   * @returns true when the holder is a live in-process turn.
   */
  function activeTurnHolder(record: LeaseRecord): boolean {
    return record.hostId === hostId && record.pid === pid && openTurns.has(record.sessionId)
  }

  /**
   * Moment this record becomes reclaimable: its idle expiry, extended to the
   * active-turn grace while this process's holder keeps a turn open, and never
   * past the hard lifetime cap.
   * @param record - lease record under evaluation.
   * @returns epoch milliseconds of the reclaim moment.
   */
  function reclaimAt(record: LeaseRecord): number {
    const idle = Date.parse(record.idleExpiresAt)
    const idleWithGrace = activeTurnHolder(record)
      ? Math.max(idle, Date.parse(record.renewedAt) + activeTurnGraceMs)
      : idle
    return Math.min(idleWithGrace, Date.parse(record.maxExpiresAt))
  }

  function expired(record: LeaseRecord): boolean {
    return now() > reclaimAt(record)
  }

  function deadProcess(record: LeaseRecord): boolean {
    if (record.hostId !== hostId || record.pid === pid) return false
    try {
      process.kill(record.pid, 0)
      return false
    } catch (error: unknown) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH'
    }
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
      + 'next write: retry once after that moment and this write proceeds. If the holder\'s turn is still running, '
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

  async function beforeTool(exec: ToolDispatchExchange): Promise<ToolExecutionResult | undefined> {
    const agent: Agent | undefined = exec.agent
    if (agent === undefined) return undefined
    if (classifyLeaseTool(exec.name, exec.arguments) !== 'write') return undefined
    const session = agent.session
    const resolved = await keyOf(session)
    if (resolved === undefined) return undefined
    const { key, root } = resolved
    const sessionId = String(session.id)
    const current = await readRecord(key)
    const mine = held.get(sessionId)

    // A Session that still remembers holding the lease and finds the record
    // gone or regenerated is fenced. It recovers by reclaiming whenever no
    // active writer withdrew it — the record is missing, its lease expired, or
    // its process died; an active foreign holder still refuses the write.
    if (mine !== undefined && (current === undefined
      || current.sessionId !== sessionId || current.generation !== mine.generation)) {
      const activeForeignHolder = current !== undefined
        && current.sessionId !== sessionId
        && !expired(current)
        && !deadProcess(current)
      if (activeForeignHolder) {
        await audit({ event: 'lost', workspace: root, sessionId, operation: exec.name, generation: mine.generation })
        if (mode === 'observe') return undefined
        return lostRefusal(root, mine, current)
      }
      const generation = (current?.generation ?? mine.generation) + 1
      await writeRecord(key, recordFor(root, sessionId, generation, exec.name))
      held.set(sessionId, { key, generation })
      await audit({
        event: 'reclaimed', workspace: root, sessionId, operation: exec.name,
        holder: current?.sessionId ?? 'unknown', generation,
      })
      await audit({ event: 'acquired', workspace: root, sessionId, operation: exec.name, generation })
      return undefined
    }

    if (current !== undefined && current.sessionId !== sessionId) {
      if (expired(current) || deadProcess(current)) {
        const generation = current.generation + 1
        await writeRecord(key, recordFor(root, sessionId, generation, exec.name))
        held.set(sessionId, { key, generation })
        await audit({ event: 'reclaimed', workspace: root, sessionId, operation: exec.name, holder: current.sessionId, generation })
        await audit({ event: 'acquired', workspace: root, sessionId, operation: exec.name, generation })
        return undefined
      }
      await audit({
        event: 'denied', workspace: root, sessionId, operation: exec.name, result: mode,
        holder: current.sessionId, generation: current.generation,
      })
      if (mode === 'observe') return undefined
      const reclaim = reclaimAt(current)
      const retryAfterMs = Math.max(0, reclaim - now())
      return refusal(
        WORKSPACE_LEASE_HELD,
        `WORKSPACE_LEASE_HELD\nworkspace:  ${root}\nholder:     ${describe(current)}\n`
        + `The holder's lease frees when its turn ends, or at latest ${new Date(reclaim).toISOString()} (in `
        + `${String(Math.ceil(retryAfterMs / 1000))}s). This is temporary: retry once after that moment and the `
        + 'expired record is reclaimed automatically. Only escalate if a retry after the expiry is still '
        + 'refused; do not retry in a loop.',
        {
          root,
          holderSessionId: current.sessionId,
          holderOperation: current.lastOperation,
          idleExpiresAt: current.idleExpiresAt,
          retryAfterMs,
        },
      )
    }

    if (current === undefined) {
      await writeRecord(key, recordFor(root, sessionId, 1, exec.name))
      held.set(sessionId, { key, generation: 1 })
      await audit({ event: 'acquired', workspace: root, sessionId, operation: exec.name, generation: 1 })
      return undefined
    }

    await writeRecord(key, {
      ...current,
      renewedAt: new Date(now()).toISOString(),
      lastOperation: exec.name,
      idleExpiresAt: new Date(now() + idleMs).toISOString(),
    })
    held.set(sessionId, { key, generation: current.generation })
    return undefined
  }

  function noteTurnStart(sessionId: string): void {
    openTurns.add(sessionId)
  }

  function noteTurnEnd(sessionId: string): void {
    openTurns.delete(sessionId)
  }

  async function release(sessionId: string, operation: string): Promise<boolean> {
    const mine = held.get(sessionId)
    if (mine === undefined) return false
    held.delete(sessionId)
    const current = await readRecord(mine.key)
    if (current === undefined || current.sessionId !== sessionId || current.generation !== mine.generation) return false
    await rm(leasePath(mine.key), { force: true })
    await audit({ event: 'released', workspace: current.root, sessionId, operation, generation: current.generation })
    return true
  }

  return { beforeTool, release, noteTurnStart, noteTurnEnd }
}

/**
 * Mount the guard on a plugin context: refuse conflicting writes, track each
 * Session's open turn so its lease keeps the active-turn grace, release a
 * Session's lease when its turn ends, when it is archived, and again on
 * disposal for a turn that never reaches its end event.
 * @param ctx - plugin context that provides tools and carries the workspace registry.
 * @param options - home, clock, identity, mode, and lease windows.
 * @returns the mounted guard.
 */
export function mountWorkspaceLease(ctx: Context, options: LeaseGuardOptions): WorkspaceLeaseGuard {
  const guard = createWorkspaceLeaseGuard(ctx, options)
  ctx.on('tools/execute', async (exec, next): Promise<ToolExecutionResult> => {
    const exchange: ToolDispatchExchange = exec.agent === undefined
      ? { name: exec.name, arguments: exec.arguments }
      : { name: exec.name, agent: exec.agent, arguments: exec.arguments }
    const decision = await guard.beforeTool(exchange)
    if (decision !== undefined) return decision
    const result = await next()
    // An archive succeeded, so the archived Session can never write again: drop
    // its lease now instead of waiting for an idle expiry that no turn will end.
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
  })
  ctx.on('session/event', (session: Session, event: SessionEvent): void => {
    const sessionId = String(session.id)
    if (event.type === 'turn/start') {
      guard.noteTurnStart(sessionId)
      return
    }
    if (event.type !== 'turn/end') return
    guard.noteTurnEnd(sessionId)
    // The turn has irrevocably ended (agent-loop appends `turn/end` only after
    // `agent/turn-stopping` lets it close), so no further write of this turn
    // can follow. `agent/turn-stopping` is not a release point: the reply gate
    // can steer or veto there and the same turn keeps running.
    void guard.release(sessionId, 'turn end')
  })
  ctx.on('agent/disposed', ({ agent }) => {
    void guard.release(String(agent.session.id), 'session disposed')
  })
  return guard
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
