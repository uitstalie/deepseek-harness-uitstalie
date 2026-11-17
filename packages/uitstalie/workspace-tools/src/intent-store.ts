/**
 * Append-only storage of workspace intent cards.
 *
 * One card lives under `$DSH_HOME/workspaces/<workspace-id>/intents/<intentId>/`
 * as an `index.json` plus immutable `versions/<n>.json` files. The index holds
 * the mutable bookkeeping — current state per version and the latest active
 * version — so a correction never rewrites an old version file and an old
 * version stays readable after it is superseded. Cards are workspace state
 * beside tasks, messages, and artifacts; they never enter memory or a
 * host-global intent directory.
 * @module @deepseek-ai/dsh-workspace-tools/intent-store
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { z } from 'zod'
import { WorkspaceRecordError } from './errors.ts'
import type { IntentIndex, IntentVersionRecord } from './records.ts'
import { WORKSPACE_STATE_ROOT, safeRecordSegment } from './store.ts'

/** Relative directory of one workspace's intent cards. */
export function intentsDirectory(workspaceId: WorkspaceId | string): string {
  return `${WORKSPACE_STATE_ROOT}/${String(workspaceId)}/intents`
}

/** Relative directory of one intent card. */
export function intentDirectory(workspaceId: WorkspaceId | string, intentId: string): string {
  return `${intentsDirectory(workspaceId)}/${safeRecordSegment(intentId)}`
}

/** Relative path of one card's index. */
export function intentIndexPath(workspaceId: WorkspaceId | string, intentId: string): string {
  return `${intentDirectory(workspaceId, intentId)}/index.json`
}

/** Relative path of one immutable card version. */
export function intentVersionPath(
  workspaceId: WorkspaceId | string,
  intentId: string,
  version: number,
): string {
  return `${intentDirectory(workspaceId, intentId)}/versions/${String(Math.trunc(version))}.json`
}

/** Durable item schema. */
const intentItemSchema = z.strictObject({
  text: z.string().min(1),
  source: z.enum(['user-verbatim', 'user-anchor', 'inference']),
  anchor: z.strictObject({
    path: z.string().min(1),
    heading: z.string().min(1).optional(),
  }).optional(),
  reason: z.string().min(1).optional(),
})

/** Durable items schema. */
const intentItemsSchema = z.strictObject({
  goal: z.array(intentItemSchema),
  acceptance: z.array(intentItemSchema),
  boundaries: z.array(intentItemSchema),
  outputForm: z.array(intentItemSchema),
})

/** Durable immutable version schema. */
const intentVersionSchema = z.strictObject({
  intentId: z.string().min(1),
  workspaceId: z.string().min(1),
  version: z.number().int().positive(),
  status: z.enum(['proposed', 'active']),
  rawUserText: z.string().min(1),
  items: intentItemsSchema,
  sourceSessionId: z.string().min(1).optional(),
  sourceTurn: z.number().int().nonnegative().optional(),
  createdAt: z.string(),
  author: z.string().min(1),
  supersedesVersion: z.number().int().positive().optional(),
  reason: z.string().min(1).optional(),
  correctionText: z.string().min(1).optional(),
  changedPoints: z.array(z.string()).optional(),
  changedPointRefs: z.array(z.string()).optional(),
  taskType: z.enum([
    'analysis-diagnosis', 'fix', 'test-verification', 'migration-deployment', 'design-document', 'other',
  ]).optional(),
  requestId: z.string().min(1),
}) satisfies z.ZodType<IntentVersionRecord>

/** Mutable version-summary schema. */
const intentVersionSummarySchema = z.strictObject({
  version: z.number().int().positive(),
  status: z.enum(['proposed', 'active', 'superseded']),
  createdAt: z.string(),
  author: z.string().min(1),
  confirmedAt: z.string().optional(),
  confirmedBy: z.string().min(1).optional(),
  confirmedPoints: z.array(z.string()).optional(),
  rejectedAt: z.string().optional(),
  rejectedBy: z.string().min(1).optional(),
  supersedesVersion: z.number().int().positive().optional(),
  reason: z.string().min(1).optional(),
  correction: z.boolean().optional(),
  changedPoints: z.array(z.string()).optional(),
  changedPointRefs: z.array(z.string()).optional(),
  taskType: z.enum([
    'analysis-diagnosis', 'fix', 'test-verification', 'migration-deployment', 'design-document', 'other',
  ]).optional(),
  requestId: z.string().min(1),
})

/** Durable index schema. */
const intentIndexSchema = z.strictObject({
  intentId: z.string().min(1),
  workspaceId: z.string().min(1),
  createdAt: z.string(),
  latestVersion: z.number().int().positive(),
  latestActiveVersion: z.number().int().positive().optional(),
  versions: z.array(intentVersionSummarySchema).min(1),
}) satisfies z.ZodType<IntentIndex>

/** One stored intent index and the version that guards a rewrite. */
export interface StoredIntentIndex {
  /** Parsed index. */
  readonly index: IntentIndex
  /** Store version to pass as the next write's `expected`. */
  readonly version?: string
}

/**
 * Read one card index.
 * @param ctx - context carrying the `.dsh` store.
 * @param workspaceId - workspace that owns the card.
 * @param intentId - card identity inside that workspace.
 * @param signal - cancellation for the store read.
 * @returns the index and its store version, or undefined when no such card exists.
 */
export async function readIntentIndex(
  ctx: Context,
  workspaceId: WorkspaceId | string,
  intentId: string,
  signal?: AbortSignal,
): Promise<StoredIntentIndex | undefined> {
  const stored = await readJson(ctx, intentIndexPath(workspaceId, intentId), intentIndexSchema, signal)
  return stored === undefined
    ? undefined
    : { index: stored.value, ...stored.version === undefined ? {} : { version: stored.version } }
}

/**
 * List every card index of one workspace.
 * @param ctx - context carrying the `.dsh` store.
 * @param workspaceId - workspace whose cards are listed.
 * @param signal - cancellation for the store reads.
 * @returns the indexes, in directory order.
 */
export async function listIntentIndexes(
  ctx: Context,
  workspaceId: WorkspaceId | string,
  signal?: AbortSignal,
): Promise<IntentIndex[]> {
  const directory = intentsDirectory(workspaceId)
  const query = await ctx.dshStore.query(undefined, directory, {
    scope: 'global',
    ...signal === undefined ? {} : { signal },
  })
  if (query.kind === 'missing') return []
  if (query.kind !== 'directory') {
    throw new WorkspaceRecordError(`${directory} is not a directory`, 'WORKSPACE_RECORD_CORRUPT')
  }
  const indexes: IntentIndex[] = []
  for (const entry of query.entries) {
    if (entry.kind !== 'directory') continue
    const stored = await readJson(ctx, `${entry.path}/index.json`, intentIndexSchema, signal)
    if (stored !== undefined) indexes.push(stored.value)
  }
  return indexes
}

/**
 * Read one immutable card version.
 * @param ctx - context carrying the `.dsh` store.
 * @param workspaceId - workspace that owns the card.
 * @param intentId - card identity.
 * @param version - version number.
 * @param signal - cancellation for the store read.
 * @returns the version record and its store version, or undefined when absent.
 */
export async function readIntentVersion(
  ctx: Context,
  workspaceId: WorkspaceId | string,
  intentId: string,
  version: number,
  signal?: AbortSignal,
): Promise<{ readonly record: IntentVersionRecord; readonly version?: string } | undefined> {
  const stored = await readJson(ctx, intentVersionPath(workspaceId, intentId, version), intentVersionSchema, signal)
  return stored === undefined ? undefined : { record: stored.value, ...stored.version === undefined ? {} : { version: stored.version } }
}

/**
 * Write one immutable card version.
 * @param ctx - context carrying the `.dsh` store.
 * @param record - complete version record.
 * @returns the store version after the write.
 */
export async function writeIntentVersion(
  ctx: Context,
  record: IntentVersionRecord,
  session?: Session,
): Promise<{ readonly version?: string }> {
  const written = await ctx.dshStore.writeFile(
    session,
    intentVersionPath(record.workspaceId, record.intentId, record.version),
    `${JSON.stringify(record, undefined, 2)}\n`,
    { scope: 'global' },
  )
  return written.version === undefined ? {} : { version: written.version }
}

/** Attempts one index mutation makes when a concurrent writer moved the file. */
const INDEX_WRITE_ATTEMPTS = 3

/**
 * Read, mutate, and write one card index under a version guard.
 *
 * A concurrent writer surfaces as a stale version, so the mutation is retried
 * against the new index instead of silently overwriting it.
 * @param ctx - context carrying the `.dsh` store.
 * @param workspaceId - workspace that owns the card.
 * @param intentId - card identity.
 * @param mutate - pure mutation of the current index; return the next index.
 * @param signal - cancellation for the store reads.
 * @returns the written index.
 * @throws WorkspaceRecordError when the card is absent or the write keeps losing the race.
 */
export async function updateIntentIndex(
  ctx: Context,
  workspaceId: WorkspaceId | string,
  intentId: string,
  mutate: (current: IntentIndex) => IntentIndex,
  signal?: AbortSignal,
  session?: Session,
): Promise<IntentIndex> {
  for (let attempt = 0; attempt < INDEX_WRITE_ATTEMPTS; attempt += 1) {
    const stored = await readIntentIndex(ctx, workspaceId, intentId, signal)
    if (stored === undefined) {
      throw new WorkspaceRecordError(
        `workspace ${String(workspaceId)} holds no intent card ${JSON.stringify(intentId)}`,
        'WORKSPACE_RECORD_NOT_FOUND',
      )
    }
    const next = mutate(stored.index)
    try {
      await ctx.dshStore.writeFile(session, intentIndexPath(workspaceId, intentId), `${JSON.stringify(next, undefined, 2)}\n`, {
        scope: 'global',
        ...stored.version === undefined ? {} : { expected: stored.version },
      })
      return next
    } catch (error: unknown) {
      if (!isStaleVersion(error)) throw error
    }
  }
  throw new WorkspaceRecordError(
    `intent card ${JSON.stringify(intentId)} kept changing while it was updated; re-read the card and retry`,
    'WORKSPACE_RECORD_CORRUPT',
  )
}

/**
 * Write a new card index without a version guard.
 * @param ctx - context carrying the `.dsh` store.
 * @param index - complete index to persist.
 */
export async function writeIntentIndex(ctx: Context, index: IntentIndex, session?: Session): Promise<void> {
  await ctx.dshStore.writeFile(
    session,
    intentIndexPath(index.workspaceId, index.intentId),
    `${JSON.stringify(index, undefined, 2)}\n`,
    { scope: 'global' },
  )
}

/**
 * Whether one failure is the store's stale-version refusal.
 * @param error - thrown value from a guarded write.
 * @returns whether the write lost the version race.
 */
function isStaleVersion(error: unknown): boolean {
  return error instanceof Error && (error as { code?: unknown }).code === 'FS_STALE_VERSION'
}

/**
 * Read and validate one JSON record below the global store root.
 * @param ctx - context carrying the `.dsh` store.
 * @param path - store-relative path of the record.
 * @param schema - durable-boundary validator for the record.
 * @param signal - cancellation for the store read.
 * @returns the parsed record and its store version, or undefined when absent.
 */
async function readJson<T>(
  ctx: Context,
  path: string,
  schema: z.ZodType<T>,
  signal: AbortSignal | undefined,
): Promise<{ readonly value: T; readonly version?: string } | undefined> {
  const read = await ctx.dshStore.readFile(undefined, path, {
    scope: 'global',
    ...signal === undefined ? {} : { signal },
  })
  if (read.text === undefined) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(read.text)
  } catch (error: unknown) {
    throw new WorkspaceRecordError(
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      'WORKSPACE_RECORD_CORRUPT',
    )
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    throw new WorkspaceRecordError(`${path} does not match its record schema: ${parsed.error.message}`, 'WORKSPACE_RECORD_CORRUPT')
  }
  return { value: parsed.data, ...read.version === undefined ? {} : { version: read.version } }
}
