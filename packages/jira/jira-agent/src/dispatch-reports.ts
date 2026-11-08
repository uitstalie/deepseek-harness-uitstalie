/**
 * Superagent-owned dispatch report bindings.
 *
 * The report path must not depend on the jira dispatch ledger. A workspace turn that completes has
 * to route its report even when the ledger entry is missing, malformed, or already settled — and a
 * repeated turn end must not post the same report twice. This store is the authoritative binding
 * (workspace Session + prompt identity -> dispatch) and the delivery settlement record.
 *
 * It deliberately imports nothing from the ledger or the jira domain: the only values it carries
 * from outside are plain strings. A deployment that replaces the jira implementation keeps this
 * store and the report flow; the ledger, when present, is a human-readable projection that is
 * updated best-effort *after* a report is delivered, never before and never as a precondition.
 *
 * Storage is an append-only journal under `<super>/.superagent/reports.jsonl`, one JSON record per
 * state transition; the latest line for an id wins. The journal is intentionally plain: it survives
 * a plugin remount, it needs no storage-domain composition, and a person can read it. The class is
 * the seam for a later move into a storage domain without touching callers.
 *
 * @module @deepseek-ai/dsh-jira-agent/dispatch-reports
 */

import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

/** Directory (relative to the super workspace) that owns the report journal. */
export const DISPATCH_REPORT_DIR = '.superagent'

/** Journal file name inside {@link DISPATCH_REPORT_DIR}. */
export const DISPATCH_REPORT_FILE = 'reports.jsonl'

/**
 * How long a `delivering` claim is trusted before a later turn end may retry it. A delivery is a
 * queued message, so the window only matters after a process loss between claim and settlement.
 */
const DELIVERY_LEASE_MS = 5 * 60_000

/** The lifecycle of one dispatch report. */
export type DispatchReportStatus = 'pending' | 'delivering' | 'delivered' | 'failed'

/** The workspace a dispatched Session works in, copied as plain data. */
export interface DispatchReportWorkspace {
  readonly id: string
  readonly title: string
  readonly path: string
}

/**
 * Optional opaque coordinates of the human-readable ledger entry this dispatch also recorded.
 *
 * The report flow never reads them: they are used only after delivery, by the caller that owns the
 * ledger, to append the outcome there. A deployment without that ledger simply leaves them unset.
 */
export interface DispatchReportLedgerRef {
  readonly root: string
  readonly taskId: string
}

/** What a dispatch records before its child prompt is admitted. */
export interface NewDispatchReport {
  /** Stable task id; minted when omitted. */
  readonly id?: string
  readonly workspace: DispatchReportWorkspace
  /** The workspace Session whose turn will carry the report. */
  readonly sessionId: string
  /** The super Session that receives the report; empty when the host could not name it. */
  readonly superSession?: string
  /** The prompt identity bound into the child's `user/message.source.rpcId`. */
  readonly requestId?: string
  /** The instruction sent to the child, kept for the report headline and the ledger projection. */
  readonly task: string
  /** Dispatch instant, fixed-width UTC. */
  readonly dispatchedAt: string
  readonly ledger?: DispatchReportLedgerRef
}

/** One durable dispatch report binding. */
export interface DispatchReportRecord {
  readonly id: string
  readonly workspace: DispatchReportWorkspace
  readonly sessionId: string
  readonly superSession: string
  readonly requestId?: string
  readonly task: string
  readonly dispatchedAt: string
  readonly status: DispatchReportStatus
  readonly updatedAt: string
  /** Delivery attempts claimed so far; more than one means an earlier claim never settled. */
  readonly attempts: number
  readonly deliveredAt?: string
  /** Why the last delivery attempt failed; the turn-end hook already logged the same message. */
  readonly error?: string
  readonly ledger?: DispatchReportLedgerRef
}

/** Mint a task id that is stable in the journal and readable in a report. */
export const newDispatchReportId = (): string => `task-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`

const STATUSES: readonly DispatchReportStatus[] = Object.freeze(['pending', 'delivering', 'delivered', 'failed'])

const isStatus = (value: unknown): value is DispatchReportStatus =>
  typeof value === 'string' && (STATUSES as readonly string[]).includes(value)

/** Parse one journal line, rejecting records that cannot carry a binding. */
const parseRecord = (line: string): DispatchReportRecord | undefined => {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as Partial<DispatchReportRecord>
  if (typeof record.id !== 'string' || record.id === '') return undefined
  if (typeof record.sessionId !== 'string' || record.sessionId === '') return undefined
  if (!isStatus(record.status)) return undefined
  if (typeof record.workspace !== 'object' || record.workspace === null) return undefined
  const workspace = record.workspace as Partial<DispatchReportWorkspace>
  if (typeof workspace.id !== 'string' || typeof workspace.title !== 'string' || typeof workspace.path !== 'string') return undefined
  if (typeof record.task !== 'string' || typeof record.dispatchedAt !== 'string' || typeof record.updatedAt !== 'string') return undefined
  return Object.freeze({
    id: record.id,
    workspace: Object.freeze({ id: workspace.id, title: workspace.title, path: workspace.path }),
    sessionId: record.sessionId,
    superSession: typeof record.superSession === 'string' ? record.superSession : '',
    ...(typeof record.requestId === 'string' && record.requestId !== '' ? { requestId: record.requestId } : {}),
    task: record.task,
    dispatchedAt: record.dispatchedAt,
    status: record.status,
    updatedAt: record.updatedAt,
    attempts: typeof record.attempts === 'number' ? record.attempts : 0,
    ...(typeof record.deliveredAt === 'string' ? { deliveredAt: record.deliveredAt } : {}),
    ...(typeof record.error === 'string' ? { error: record.error } : {}),
    ...(typeof record.ledger === 'object' && record.ledger !== null
      && typeof (record.ledger as DispatchReportLedgerRef).root === 'string'
      && typeof (record.ledger as DispatchReportLedgerRef).taskId === 'string'
      ? {
        ledger: Object.freeze({
          root: (record.ledger as DispatchReportLedgerRef).root,
          taskId: (record.ledger as DispatchReportLedgerRef).taskId,
        }),
      }
      : {}),
  })
}

/** One claim result: the record to deliver, and whether an earlier claim had to be retried. */
export interface DispatchReportClaim {
  readonly record: DispatchReportRecord
  readonly retried: boolean
}

/**
 * The superagent report journal for one super workspace.
 *
 * Writes are serialized per store instance so two tool calls cannot interleave a claim with a
 * settlement. Reads always see every line written before the call, which is what lets a plugin
 * remount (a fresh instance) recover an in-flight dispatch from the journal alone.
 */
export class DispatchReportStore {
  private chain: Promise<unknown> = Promise.resolve()
  private ensured: Promise<void> | undefined

  /** @param root - the super workspace root that owns `.superagent/reports.jsonl`. */
  constructor(readonly root: string) {}

  /** The journal path this store appends to. */
  get file(): string {
    return resolve(this.root, DISPATCH_REPORT_DIR, DISPATCH_REPORT_FILE)
  }

  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.chain.then(run, run)
    this.chain = next.then(() => undefined, () => undefined)
    return next
  }

  private async append(record: DispatchReportRecord): Promise<void> {
    this.ensured ??= mkdir(dirname(this.file), { recursive: true }).then(() => undefined)
    await this.ensured
    await appendFile(this.file, `${JSON.stringify(record)}\n`, 'utf8')
  }

  /** Every latest record, keyed by task id. A missing journal is an empty store. */
  async all(): Promise<Map<string, DispatchReportRecord>> {
    let text: string
    try {
      text = await readFile(this.file, 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map()
      throw error
    }
    const latest = new Map<string, DispatchReportRecord>()
    for (const line of text.split(/\r?\n/u)) {
      if (line.trim() === '') continue
      const record = parseRecord(line)
      // A torn final line is expected after a crash; later complete lines for the same id win.
      if (record !== undefined) latest.set(record.id, record)
    }
    return latest
  }

  /** Append the binding for one dispatch; this is the only way a report becomes discoverable. */
  async record(input: NewDispatchReport): Promise<DispatchReportRecord> {
    return await this.exclusive(async () => {
      const record: DispatchReportRecord = Object.freeze({
        id: input.id ?? newDispatchReportId(),
        workspace: Object.freeze({ ...input.workspace }),
        sessionId: input.sessionId,
        superSession: input.superSession ?? '',
        ...(input.requestId === undefined || input.requestId === '' ? {} : { requestId: input.requestId }),
        task: input.task,
        dispatchedAt: input.dispatchedAt,
        status: 'pending',
        updatedAt: input.dispatchedAt,
        attempts: 0,
        ...(input.ledger === undefined ? {} : { ledger: Object.freeze({ ...input.ledger }) }),
      })
      await this.append(record)
      return record
    })
  }

  /** Every binding for one workspace Session, oldest dispatch first. */
  async forSession(sessionId: string): Promise<readonly DispatchReportRecord[]> {
    const latest = await this.all()
    return [...latest.values()]
      .filter(record => record.sessionId === sessionId)
      .sort((left, right) => left.dispatchedAt === right.dispatchedAt
        ? (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
        : (left.dispatchedAt < right.dispatchedAt ? -1 : 1))
  }

  /**
   * Claim one pending report for delivery. A record already delivered or failed is not claimable;
   * a `delivering` record is claimable again only after the lease expired, and the result then says
   * `retried` so the caller can warn about the earlier unsettled attempt.
   */
  async claim(id: string, at: string): Promise<DispatchReportClaim | undefined> {
    return await this.exclusive(async () => {
      const current = (await this.all()).get(id)
      if (current === undefined) return undefined
      if (current.status === 'delivered' || current.status === 'failed') return undefined
      const retried = current.status === 'delivering'
      if (retried) {
        const claimedAt = Date.parse(current.updatedAt)
        const now = Date.parse(at)
        if (Number.isFinite(claimedAt) && Number.isFinite(now) && now - claimedAt < DELIVERY_LEASE_MS) return undefined
      }
      const next: DispatchReportRecord = Object.freeze({
        ...current,
        status: 'delivering',
        updatedAt: at,
        attempts: current.attempts + 1,
      })
      await this.append(next)
      return Object.freeze({ record: next, retried })
    })
  }

  /**
   * Fail every still-pending report for archived or stopped Sessions.
   *
   * A Session that can no longer run a turn will never report, so leaving its binding `pending`
   * would make the journal lie. The record stays for audit, as a failed delivery with the reason.
   * @param sessionIds - the Sessions the lifecycle signal named.
   * @param at - the signal instant.
   * @param reason - why the pending reports cannot be delivered.
   * @returns how many bindings became failed.
   */
  async failPendingForSessions(sessionIds: readonly string[], at: string, reason: string): Promise<number> {
    return await this.exclusive(async () => {
      if (sessionIds.length === 0) return 0
      const stopped = new Set(sessionIds)
      let failed = 0
      for (const record of (await this.all()).values()) {
        if (!stopped.has(record.sessionId) || record.status !== 'pending') continue
        await this.append(Object.freeze({ ...record, status: 'failed', updatedAt: at, error: reason }))
        failed += 1
      }
      return failed
    })
  }

  /** Settle one claim: `delivered`, or `failed` with the reason the report could not be sent. */
  async settle(
    id: string,
    status: 'delivered' | 'failed',
    at: string,
    error?: string,
  ): Promise<DispatchReportRecord | undefined> {
    return await this.exclusive(async () => {
      const current = (await this.all()).get(id)
      if (current === undefined) return undefined
      const next: DispatchReportRecord = Object.freeze({
        ...current,
        status,
        updatedAt: at,
        ...(status === 'delivered' ? { deliveredAt: at } : {}),
        ...(status === 'failed' && error !== undefined ? { error } : {}),
      })
      await this.append(next)
      return next
    })
  }
}
