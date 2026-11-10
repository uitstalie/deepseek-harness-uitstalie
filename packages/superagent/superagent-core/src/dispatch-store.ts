/**
 * Durable dispatch state for the super agent.
 *
 * The domain is authoritative. The Markdown files under `.superagent/ledger/` remain a
 * human-readable projection so a checkout can be reviewed in git; every write first lands in the
 * domain and then appends the same section to the projection. A deployment without a storage
 * domain keeps using the Markdown ledger directly, which is the compatibility path for old hosts
 * and for compositions that deliberately do not mount storage.
 *
 * @module @deepseek-ai/dsh-superagent-core/dispatch-store
 */

import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable, type Domain, type KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {
  DispatchLedgerList, DispatchLedgerQuery, DispatchLedgerRow, DispatchLedgerTask, DispatchProjection, DispatchTaskPatch,
} from './dispatch-types.ts'

/** Stable domain name used by the deployment's storage-domain route. */
export const DISPATCH_DOMAIN_NAME = 'superagent_dispatch'

/** Workspace identity carried by one dispatch record. */
export const dispatchWorkspaceSchema = z.object({
  id: z.string(),
  title: z.string(),
  path: z.string(),
}).strict()

/**
 * One domain record, keyed by task id. `superSession` is what lets a report survive a reload and
 * find the super conversation that dispatched it; old Markdown imports may lack it and use the
 * visible-super-session fallback in `onTurnEnd`.
 */
export const dispatchRecordSchema = z.object({
  workspace: dispatchWorkspaceSchema,
  task: z.string(),
  sessionId: z.string().optional(),
  /** The prompt request identity that carried the task; see `DispatchLedgerTask.requestId`. */
  requestId: z.string().optional(),
  superSession: z.string().optional(),
  status: z.enum(['pending', 'returned', 'failed']),
  dispatchedAt: z.string(),
  updatedAt: z.string(),
  outcome: z.string().optional(),
  artifacts: z.array(z.string()).default([]),
  decisions: z.array(z.string()).default([]),
  issue: z.string().optional(),
  /** Set when the owning Session was archived/stopped; the record stays for audit. */
  orphanedAt: z.string().optional(),
}).strict()

/** Stored dispatch record. */
export type DispatchRecord = z.infer<typeof dispatchRecordSchema>

/** One opened domain's table. */
type DispatchTable = KvTable<string, DispatchRecord>

/** The slice of the storage-domain facility this package needs; kept optional on purpose. */
interface StorageDomainFacility {
  open(spec: typeof dispatchDomainSpec): Promise<Domain<typeof dispatchDomainSpec>>
}

/** The database-backed dispatch domain. `per-record` keeps one document per task. */
export const dispatchDomainSpec = defineDomain({
  name: DISPATCH_DOMAIN_NAME,
  version: 1,
  layout: 'per-record',
  tables: {
    dispatches: domainTable<string, DispatchRecord>(dispatchRecordSchema),
  },
})

/** One write result, shaped like the existing Markdown ledger result. */
export interface DispatchWrite {
  readonly task: DispatchLedgerTask
  /** The Markdown projection file, or the file the projection will use once it can be written. */
  readonly file: string
}

/** One domain lookup; `available: false` tells the caller to use the Markdown compatibility path. */
export interface DispatchLookup {
  readonly available: boolean
  readonly id?: string
  readonly record?: DispatchRecord
}

/** Read the optional domain facility without making storage a hard dependency. */
const storageDomainOf = (ctx: Context): StorageDomainFacility | undefined => {
  const get = (ctx as { get?: (key: string) => unknown }).get
  const service = typeof get === 'function' ? get.call(ctx, 'storageDomain') as Partial<StorageDomainFacility> | undefined : undefined
  return service !== undefined && typeof service.open === 'function' ? service as StorageDomainFacility : undefined
}

/**
 * Convert one Markdown ledger task into the durable record shape.
 * @param task - task and workspace fields from the projection.
 * @param superSession - original recipient Session, when known.
 * @returns the durable domain record.
 */
export const recordFromTask = (task: DispatchLedgerTask, superSession?: string): DispatchRecord => ({
  workspace: {
    id: task.workspaceId,
    title: task.workspaceTitle,
    path: task.workspacePath,
  },
  task: task.task,
  ...(task.sessionId === undefined ? {} : { sessionId: task.sessionId }),
  ...(task.requestId === undefined ? {} : { requestId: task.requestId }),
  ...(superSession === undefined || superSession === '' ? {} : { superSession }),
  status: task.status,
  dispatchedAt: task.dispatchedAt,
  updatedAt: task.updatedAt,
  ...(task.outcome === undefined ? {} : { outcome: task.outcome }),
  artifacts: [...task.artifacts],
  decisions: [...task.decisions],
  ...(task.issue === undefined ? {} : { issue: task.issue }),
})

/**
 * Convert a durable record back to the shape tools and the Markdown projection use.
 * @param record - stored domain record.
 * @param id - task key omitted from the stored value.
 * @returns the task with its stable identifier.
 */
export const taskFromRecord = (record: DispatchRecord, id: string): DispatchLedgerTask => Object.freeze({
  id,
  workspaceId: record.workspace.id,
  workspaceTitle: record.workspace.title,
  workspacePath: record.workspace.path,
  task: record.task,
  dispatchedAt: record.dispatchedAt,
  status: record.status,
  updatedAt: record.updatedAt,
  ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
  ...(record.requestId === undefined ? {} : { requestId: record.requestId }),
  ...(record.issue === undefined ? {} : { issue: record.issue }),
  artifacts: Object.freeze([...record.artifacts]),
  ...(record.outcome === undefined ? {} : { outcome: record.outcome }),
  decisions: Object.freeze([...record.decisions]),
})

/** Whether the Markdown projection already shows exactly this stored state. */
const sameProjection = (projected: DispatchLedgerTask | undefined, record: DispatchRecord, id: string): boolean => {
  if (projected === undefined) return false
  const current = taskFromRecord(record, id)
  return projected.status === current.status
    && projected.updatedAt === current.updatedAt
    && projected.outcome === current.outcome
    && projected.sessionId === current.sessionId
    && projected.requestId === current.requestId
    && projected.issue === current.issue
    && projected.artifacts.join('\u0000') === current.artifacts.join('\u0000')
    && projected.decisions.join('\u0000') === current.decisions.join('\u0000')
}

/**
 * Owns one super workspace's dispatch domain and its Markdown projection.
 *
 * Construction never throws. Opening is lazy and awaits the storage-domain service when present;
 * if the service is absent, the route is missing, or migration fails, `available` stays false and
 * every caller falls back to the existing Markdown ledger rather than failing the tool or turn.
 */
export class DispatchStore {
  private domain: Domain<typeof dispatchDomainSpec> | undefined
  private table: DispatchTable | undefined
  private readonly opening: Promise<boolean>

  /**
   * @param ctx - plugin context, for the optional storage-domain service and logging.
   * @param root - the super workspace root that owns `.superagent/ledger/`.
   */
  constructor(private readonly ctx: Context, readonly root: string, private readonly projection: DispatchProjection) {
    const facility = storageDomainOf(ctx)
    this.opening = facility === undefined ? Promise.resolve(false) : this.open(facility)
  }

  /**
   * Report whether a domain is open and usable.
   * @returns false when callers must use the Markdown fallback.
   */
  async available(): Promise<boolean> {
    return await this.opening
  }

  private async open(facility: StorageDomainFacility): Promise<boolean> {
    let domain: Domain<typeof dispatchDomainSpec> | undefined
    try {
      domain = await facility.open(dispatchDomainSpec)
      this.domain = domain
      this.table = domain.table('dispatches')
      await this.migrate()
      await this.syncProjection()
      return true
    } catch (error: unknown) {
      this.domain = undefined
      this.table = undefined
      if (domain !== undefined) {
        try { await domain.close() } catch (closeError: unknown) {
          this.ctx.logger.warn('superagent: closing the failed dispatch domain failed: %s', String(closeError))
        }
      }
      this.ctx.logger.warn(
        'superagent: the durable dispatch store is unavailable; using the Markdown ledger only: %s',
        error instanceof Error ? error.message : String(error),
      )
      return false
    }
  }

  /** Import every existing Markdown task once; existing domain keys win. */
  private async migrate(): Promise<void> {
    const table = this.table
    if (table === undefined) return
    for (const row of await this.projection.readAll()) {
      if (table.get(row.id) !== undefined) continue
      await table.put(row.id, recordFromTask(row))
    }
  }

  /** Bring the human projection up to the authoritative domain state. */
  private async syncProjection(): Promise<void> {
    const table = this.table
    if (table === undefined) return
    const projected = new Map((await this.projection.readAll()).map(row => [row.id, row]))
    for (const [id, record] of table.entries()) {
      if (sameProjection(projected.get(id), record, id)) continue
      try {
        await this.projection.append(record.workspace, taskFromRecord(record, id))
      } catch (error: unknown) {
        this.ctx.logger.warn('superagent: updating the Markdown dispatch projection for %s failed: %s', id, String(error))
      }
    }
  }

  private async readyTable(): Promise<DispatchTable | undefined> {
    return await this.opening ? this.table : undefined
  }

  /**
   * Read a bounded domain listing with counts for every match.
   * @param query - workspace, status, text, and result-limit filters.
   * @returns the filtered page, or undefined to use the Markdown fallback.
   */
  async query(query: DispatchLedgerQuery = {}): Promise<DispatchLedgerList | undefined> {
    const table = await this.readyTable()
    if (table === undefined) return undefined
    const rows = [...table.entries()]
      .map(([id, record]) => Object.freeze({ ...taskFromRecord(record, id), file: this.projection.fileFor(record.workspace.id) }))
    return this.projection.query(rows, query)
  }

  /**
   * Read rows from the authoritative domain.
   * @param query - workspace, status, text, and result-limit filters.
   * @returns matching rows, or undefined to use the Markdown fallback.
   */
  async list(query: DispatchLedgerQuery = {}): Promise<DispatchLedgerRow[] | undefined> {
    const entries = (await this.query(query))?.entries
    return entries === undefined ? undefined : [...entries]
  }

  /**
   * Append the current domain state when its human projection is absent or stale.
   * @param id - task identifier to project.
   * @returns the task and projection file, or undefined when unavailable.
   */
  async project(id: string): Promise<DispatchWrite | undefined> {
    const table = await this.readyTable()
    if (table === undefined) return undefined
    const record = table.get(id)
    if (record === undefined) return undefined
    const projected = (await this.projection.readAll()).find(row => row.id === id)
    if (!sameProjection(projected, record, id)) {
      await this.projection.append(record.workspace, taskFromRecord(record, id))
    }
    return { task: taskFromRecord(record, id), file: this.projection.fileFor(record.workspace.id) }
  }

  /**
   * Look up one task without applying the bounded list window.
   * @param id - task identifier.
   * @returns the task and projection file, or undefined when unavailable.
   */
  async find(id: string): Promise<DispatchWrite | undefined> {
    const table = await this.readyTable()
    if (table === undefined) return undefined
    const record = table.get(id)
    if (record === undefined) return undefined
    return { task: taskFromRecord(record, id), file: this.projection.fileFor(record.workspace.id) }
  }

  /**
   * Persist a new pending task, then append its human projection.
   * @param task - complete pending task.
   * @param superSession - original recipient Session, when known.
   * @returns the stored task and projection file, or undefined when unavailable.
   */
  async record(task: DispatchLedgerTask, superSession?: string): Promise<DispatchWrite | undefined> {
    const table = await this.readyTable()
    if (table === undefined) return undefined
    const record = recordFromTask(task, superSession)
    await table.put(task.id, record)
    const file = this.projection.fileFor(record.workspace.id)
    try {
      await this.projection.append(record.workspace, taskFromRecord(record, task.id))
    } catch (error: unknown) {
      this.ctx.logger.warn('superagent: appending the Markdown projection for %s failed: %s', task.id, String(error))
    }
    return { task: taskFromRecord(record, task.id), file }
  }

  /** Whether a resolve changes a projected field rather than only its update timestamp. */
  private changed(current: DispatchRecord, next: DispatchRecord): boolean {
    return !sameProjection(taskFromRecord(current, 'current'), { ...next, updatedAt: current.updatedAt }, 'next')
  }

  /**
   * Resolve or correct one task in the domain, including after an automatic result. A missing task
   * returns undefined so the caller can try the Markdown compatibility store. An unchanged patch is
   * a no-op; every changed field is persisted and appended to the human projection.
   * @param id - task identifier.
   * @param patch - result fields to replace.
   * @param options - whether to append the changed state to the projection.
   * @returns the task and projection file, or undefined when unavailable.
   */
  async resolve(
    id: string,
    patch: DispatchTaskPatch,
    options: { readonly project?: boolean } = {},
  ): Promise<DispatchWrite | undefined> {
    const table = await this.readyTable()
    if (table === undefined) return undefined
    const current = table.get(id)
    if (current === undefined) return undefined
    const file = this.projection.fileFor(current.workspace.id)
    const next: DispatchRecord = {
      ...current,
      status: patch.status,
      updatedAt: patch.updatedAt,
      ...(patch.outcome === undefined ? {} : { outcome: patch.outcome }),
      artifacts: [...(patch.artifacts ?? current.artifacts)],
      decisions: [...(patch.decisions ?? current.decisions)],
      ...(patch.sessionId === undefined ? {} : { sessionId: patch.sessionId }),
      ...(patch.issue === undefined ? {} : { issue: patch.issue }),
    }
    if (!this.changed(current, next)) return { task: taskFromRecord(current, id), file }
    await table.put(id, next)
    if (options.project !== false) {
      try {
        await this.projection.append(next.workspace, taskFromRecord(next, id))
      } catch (error: unknown) {
        this.ctx.logger.warn('superagent: appending the Markdown resolution for %s failed: %s', id, String(error))
      }
    }
    return { task: taskFromRecord(next, id), file }
  }

  /**
   * Read every record bound to one Session.
   * @param sessionId - dispatched Session identifier.
   * @returns records oldest dispatch first; ties keep insertion order.
   */
  async recordsForSession(sessionId: string): Promise<readonly { id: string; record: DispatchRecord }[]> {
    const table = await this.readyTable()
    if (table === undefined) return []
    return [...table.entries()]
      .filter(([, record]) => record.sessionId === sessionId)
      .map(([id, record]) => ({ id, record }))
      .sort((left, right) => left.record.dispatchedAt < right.record.dispatchedAt
        ? -1
        : left.record.dispatchedAt > right.record.dispatchedAt
          ? 1
          : 0)
  }

  /**
   * Read the newest record for a Session, including its dispatcher binding.
   * @param sessionId - dispatched Session identifier.
   * @returns availability and the newest binding when one exists.
   */
  async lookupSession(sessionId: string): Promise<DispatchLookup> {
    const records = await this.recordsForSession(sessionId)
    const newest = records.at(-1)
    if (records.length === 0) return { available: (await this.readyTable()) !== undefined }
    return {
      available: true,
      ...(newest?.id === undefined ? {} : { id: newest.id }),
      ...(newest?.record === undefined ? {} : { record: newest.record }),
    }
  }

  /**
   * Mark pending records for an archived/stopped Session; audit history stays in the domain.
   * @param sessionId - archived or stopped Session identifier.
   * @param at - orphan timestamp.
   */
  async markOrphaned(sessionId: string, at: string): Promise<void> {
    await this.markArchivedSessions([sessionId], at)
  }

  /**
   * Mark pending records for every archived/stopped Session in one workspace-domain change.
   * @param sessionIds - archived or stopped Session identifiers.
   * @param at - orphan timestamp.
   */
  async markArchivedSessions(sessionIds: readonly string[], at: string): Promise<void> {
    const table = await this.readyTable()
    if (table === undefined || sessionIds.length === 0) return
    const archived = new Set(sessionIds)
    for (const [id, record] of table.entries()) {
      if (record.sessionId === undefined || !archived.has(record.sessionId)
        || record.status !== 'pending' || record.orphanedAt !== undefined) continue
      await table.put(id, { ...record, orphanedAt: at })
    }
  }

  /** Release the domain handle; safe when storage was never available. */
  async close(): Promise<void> {
    await this.opening.catch(() => false)
    const domain = this.domain
    this.domain = undefined
    this.table = undefined
    if (domain !== undefined) await domain.close()
  }
}

/**
 * Build the optional store for one super workspace.
 * @param ctx - plugin context supplying the optional storage-domain service.
 * @param root - super workspace root; omitted disables the store.
 * @param projection - projection implementation; omitted disables the store.
 * @returns the store when both required inputs are present.
 */
export const createDispatchStore = (ctx: Context, root: string | undefined, projection?: DispatchProjection): DispatchStore | undefined =>
  root === undefined || projection === undefined ? undefined : new DispatchStore(ctx, root, projection)
