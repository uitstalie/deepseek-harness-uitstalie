/**
 * Durable storage of the workspace toolset's own records.
 *
 * Records live under `$DSH_HOME/workspaces/<workspace-id>/` through the `.dsh`
 * store's global scope, beside the workspace's other toolset state and outside
 * every workspace directory. One JSON file per record keeps a single task,
 * message, or artifact version independent: a reader lists a directory and
 * gets bounded identities, then reads only the records it returns.
 * @module @deepseek-ai/dsh-workspace-tools/store
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { z } from 'zod'
import type {
  ArtifactRecord,
  ArtifactReference,
  MessageRecord,
  TaskRecord,
} from './records.ts'
import { MESSAGE_DELIVERY_STATUSES } from './records.ts'
import { WorkspaceRecordError } from './errors.ts'

/** Directory, under `$DSH_HOME`, that owns every workspace's toolset state. */
export const WORKSPACE_STATE_ROOT = 'workspaces'

/** Durable task schema. */
const taskSchema = z.strictObject({
  taskId: z.string().min(1),
  workspaceId: z.string().min(1),
  title: z.string(),
  goal: z.string(),
  acceptance: z.array(z.string()),
  boundaries: z.array(z.string()),
  outputForm: z.array(z.string()).optional(),
  status: z.enum(['pending', 'in_progress', 'waiting_review', 'done', 'blocked', 'cancelled']),
  assignee: z.string().optional(),
  targetSessionId: z.string().optional(),
  intentId: z.string().optional(),
  intentVersion: z.number().int().positive().optional(),
  coverage: z.array(z.strictObject({
    point: z.string().min(1),
    brief: z.string().min(1),
    note: z.string().optional(),
  })).optional(),
  nonCoverage: z.array(z.strictObject({
    point: z.string().min(1),
    reason: z.string().min(1),
  })).optional(),
  taskType: z.enum([
    'analysis-diagnosis', 'fix', 'test-verification', 'migration-deployment', 'design-document', 'other',
  ]).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  requestId: z.string(),
  lastRequestId: z.string().optional(),
  note: z.string().optional(),
  receipts: z.array(z.strictObject({
    receiptId: z.string().min(1),
    at: z.string(),
    status: z.enum(['pending', 'in_progress', 'waiting_review', 'done', 'blocked', 'cancelled']),
    note: z.string().optional(),
    requestId: z.string().optional(),
    alignment: z.strictObject({
      intentId: z.string().min(1),
      intentVersion: z.number().int().positive(),
      acceptance: z.array(z.strictObject({
        point: z.string().min(1),
        status: z.enum(['satisfied', 'not_satisfied', 'out_of_scope']),
        evidence: z.string().min(1),
      })),
      boundaries: z.array(z.strictObject({
        point: z.string().min(1),
        status: z.enum(['respected', 'violated']),
        evidence: z.string().min(1),
      })),
      outputForm: z.array(z.strictObject({
        point: z.string().min(1),
        status: z.enum(['matched', 'not_matched']),
        evidence: z.string().min(1),
      })),
    }).optional(),
  })),
  artifactIds: z.array(z.string()),
}) satisfies z.ZodType<TaskRecord>

/** Durable citation schema. */
const citationSchema = z.strictObject({
  artifactId: z.string().min(1),
  version: z.number().int().positive(),
  sha256: z.string().min(1),
})

/** Durable delivery state of one message. */
const messageDeliveryStatusSchema = z.enum(MESSAGE_DELIVERY_STATUSES)

/** Durable message schema. */
const messageSchema = z.strictObject({
  messageId: z.string().min(1),
  workspaceId: z.string().min(1),
  targetSessionId: z.string().min(1),
  sourceSessionId: z.string().min(1),
  text: z.string(),
  kind: z.enum(['message', 'followup']),
  priority: z.enum(['normal', 'urgent']),
  urgentReason: z.enum(['wrong-conclusion', 'stop-order', 'instruction-change']).optional(),
  replyTo: z.string().optional(),
  references: z.array(citationSchema),
  taskId: z.string().optional(),
  requestId: z.string(),
  status: messageDeliveryStatusSchema,
  createdAt: z.string(),
  deliveredAt: z.string().optional(),
  error: z.string().optional(),
  attempts: z.number().int().nonnegative().optional(),
  receipts: z.array(z.strictObject({
    at: z.string(),
    status: messageDeliveryStatusSchema,
  })),
}) satisfies z.ZodType<MessageRecord>

/** Durable artifact reference schema. */
const artifactReferenceSchema = z.strictObject({
  artifactId: z.string().min(1),
  workspaceId: z.string().min(1),
  path: z.string().min(1),
  sha256: z.string().min(1),
  size: z.number().int().nonnegative(),
  version: z.number().int().positive(),
  kind: z.string().min(1),
  sessionId: z.string().min(1),
  taskId: z.string().optional(),
  createdAt: z.string(),
  summary: z.string().optional(),
})

/** Durable artifact schema. */
const artifactSchema = z.strictObject({
  artifactId: z.string().min(1),
  workspaceId: z.string().min(1),
  versions: z.array(artifactReferenceSchema).min(1),
}) satisfies z.ZodType<ArtifactRecord>

/** Relative directory of one workspace's dispatch tasks. */
export function tasksDirectory(workspaceId: WorkspaceId | string): string {
  return `${WORKSPACE_STATE_ROOT}/${String(workspaceId)}/tasks`
}

/** Relative directory of one workspace's messages. */
export function messagesDirectory(workspaceId: WorkspaceId | string): string {
  return `${WORKSPACE_STATE_ROOT}/${String(workspaceId)}/messages`
}

/** Relative directory of one workspace's artifact references. */
export function artifactsDirectory(workspaceId: WorkspaceId | string): string {
  return `${WORKSPACE_STATE_ROOT}/${String(workspaceId)}/artifacts`
}

/** Relative path of one task record. */
export function taskPath(workspaceId: WorkspaceId | string, taskId: string): string {
  return `${tasksDirectory(workspaceId)}/${safeSegment(taskId)}.json`
}

/** Relative path of one message record. */
export function messagePath(workspaceId: WorkspaceId | string, messageId: string): string {
  return `${messagesDirectory(workspaceId)}/${safeSegment(messageId)}.json`
}

/** Relative path of one artifact record. */
export function artifactPath(workspaceId: WorkspaceId | string, artifactId: string): string {
  return `${artifactsDirectory(workspaceId)}/${safeSegment(artifactId)}.json`
}

/**
 * Read one task record.
 * @param ctx - context carrying the `.dsh` store.
 * @param workspaceId - workspace that owns the task.
 * @param taskId - task identity inside that workspace.
 * @param signal - cancellation for the store read.
 * @returns the record, its store version, or undefined when no such task exists.
 */
export async function readTask(
  ctx: Context,
  workspaceId: WorkspaceId | string,
  taskId: string,
  signal?: AbortSignal,
): Promise<{ readonly task: TaskRecord; readonly version?: string } | undefined> {
  const stored = await readJson(ctx, taskPath(workspaceId, taskId), taskSchema, signal)
  return stored === undefined ? undefined : { task: stored.value, ...stored.version === undefined ? {} : { version: stored.version } }
}

/**
 * Write one task record with an optional version guard.
 * @param ctx - context carrying the `.dsh` store.
 * @param workspaceId - workspace that owns the task.
 * @param task - complete record to persist.
 * @param options - expected store version for a guarded update.
 * @returns the store version after the write.
 */
export async function writeTask(
  ctx: Context,
  workspaceId: WorkspaceId | string,
  task: TaskRecord,
  options: { readonly expected?: string; readonly session?: Session } = {},
): Promise<{ readonly version?: string }> {
  const written = await ctx.dshStore.writeFile(options.session, taskPath(workspaceId, task.taskId), `${JSON.stringify(task, undefined, 2)}\n`, {
    scope: 'global',
    ...options.expected === undefined ? {} : { expected: options.expected },
  })
  return written.version === undefined ? {} : { version: written.version }
}

/**
 * List every task record of one workspace, sorted by most recently updated.
 * @param ctx - context carrying the `.dsh` store.
 * @param workspaceId - workspace whose tasks are listed.
 * @param signal - cancellation for the store reads.
 * @returns the records, newest update first.
 */
export async function listTasks(
  ctx: Context,
  workspaceId: WorkspaceId | string,
  signal?: AbortSignal,
): Promise<TaskRecord[]> {
  const tasks = await listJson(ctx, tasksDirectory(workspaceId), taskSchema, signal)
  return tasks.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.taskId.localeCompare(right.taskId))
}

/**
 * Read one message record.
 * @param ctx - context carrying the `.dsh` store.
 * @param workspaceId - workspace that owns the message.
 * @param messageId - message identity inside that workspace.
 * @param signal - cancellation for the store read.
 * @returns the record, its store version, or undefined when no such message exists.
 */
export async function readMessage(
  ctx: Context,
  workspaceId: WorkspaceId | string,
  messageId: string,
  signal?: AbortSignal,
): Promise<{ readonly message: MessageRecord; readonly version?: string } | undefined> {
  const stored = await readJson(ctx, messagePath(workspaceId, messageId), messageSchema, signal)
  return stored === undefined ? undefined : { message: stored.value, ...stored.version === undefined ? {} : { version: stored.version } }
}

/**
 * Write one message record with an optional version guard.
 * @param ctx - context carrying the `.dsh` store.
 * @param workspaceId - workspace that owns the message.
 * @param message - complete record to persist.
 * @param options - expected store version for a guarded update.
 * @returns the store version after the write.
 */
export async function writeMessage(
  ctx: Context,
  workspaceId: WorkspaceId | string,
  message: MessageRecord,
  options: { readonly expected?: string; readonly session?: Session } = {},
): Promise<{ readonly version?: string }> {
  const written = await ctx.dshStore.writeFile(options.session, messagePath(workspaceId, message.messageId), `${JSON.stringify(message, undefined, 2)}\n`, {
    scope: 'global',
    ...options.expected === undefined ? {} : { expected: options.expected },
  })
  return written.version === undefined ? {} : { version: written.version }
}

/**
 * List every message record of one workspace, newest first.
 * @param ctx - context carrying the `.dsh` store.
 * @param workspaceId - workspace whose messages are listed.
 * @param signal - cancellation for the store reads.
 * @returns the records, newest first.
 */
export async function listMessages(
  ctx: Context,
  workspaceId: WorkspaceId | string,
  signal?: AbortSignal,
): Promise<MessageRecord[]> {
  const messages = await listJson(ctx, messagesDirectory(workspaceId), messageSchema, signal)
  return messages.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.messageId.localeCompare(right.messageId))
}

/**
 * Read one artifact record.
 * @param ctx - context carrying the `.dsh` store.
 * @param workspaceId - workspace that owns the artifact.
 * @param artifactId - stable artifact id.
 * @param signal - cancellation for the store read.
 * @returns the record, its store version, or undefined when no such artifact exists.
 */
export async function readArtifact(
  ctx: Context,
  workspaceId: WorkspaceId | string,
  artifactId: string,
  signal?: AbortSignal,
): Promise<{ readonly record: ArtifactRecord; readonly version?: string } | undefined> {
  const stored = await readJson(ctx, artifactPath(workspaceId, artifactId), artifactSchema, signal)
  return stored === undefined ? undefined : { record: stored.value, ...stored.version === undefined ? {} : { version: stored.version } }
}

/**
 * Write one artifact record with an optional version guard.
 * @param ctx - context carrying the `.dsh` store.
 * @param workspaceId - workspace that owns the artifact.
 * @param record - complete record to persist.
 * @param options - expected store version for a guarded update.
 * @returns the store version after the write.
 */
export async function writeArtifact(
  ctx: Context,
  workspaceId: WorkspaceId | string,
  record: ArtifactRecord,
  options: { readonly expected?: string; readonly session?: Session } = {},
): Promise<{ readonly version?: string }> {
  const written = await ctx.dshStore.writeFile(options.session, artifactPath(workspaceId, record.artifactId), `${JSON.stringify(record, undefined, 2)}\n`, {
    scope: 'global',
    ...options.expected === undefined ? {} : { expected: options.expected },
  })
  return written.version === undefined ? {} : { version: written.version }
}

/**
 * List every artifact record of one workspace.
 * @param ctx - context carrying the `.dsh` store.
 * @param workspaceId - workspace whose artifacts are listed.
 * @param signal - cancellation for the store reads.
 * @returns the records in artifact-id order.
 */
export async function listArtifacts(
  ctx: Context,
  workspaceId: WorkspaceId | string,
  signal?: AbortSignal,
): Promise<ArtifactRecord[]> {
  const artifacts = await listJson(ctx, artifactsDirectory(workspaceId), artifactSchema, signal)
  return artifacts.sort((left, right) => left.artifactId.localeCompare(right.artifactId))
}

/**
 * Select one version of an artifact record.
 * @param record - artifact record with its published versions.
 * @param version - requested version, or undefined for the latest.
 * @returns the reference, or undefined when the record has no such version.
 */
export function artifactVersion(record: ArtifactRecord, version?: number): ArtifactReference | undefined {
  return version === undefined
    ? record.versions.at(-1)
    : record.versions.find(candidate => candidate.version === version)
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

/**
 * Read and validate every `.json` record in one global-store directory.
 * @param ctx - context carrying the `.dsh` store.
 * @param directory - store-relative directory of the records.
 * @param schema - durable-boundary validator for each record.
 * @param signal - cancellation for the store reads.
 * @returns the parsed records, in directory order.
 */
async function listJson<T>(
  ctx: Context,
  directory: string,
  schema: z.ZodType<T>,
  signal: AbortSignal | undefined,
): Promise<T[]> {
  const query = await ctx.dshStore.query(undefined, directory, {
    scope: 'global',
    ...signal === undefined ? {} : { signal },
  })
  if (query.kind === 'missing') return []
  if (query.kind !== 'directory') {
    throw new WorkspaceRecordError(`${directory} is not a directory`, 'WORKSPACE_RECORD_CORRUPT')
  }
  const prefix = `${directory}/`
  const records: T[] = []
  for (const entry of query.entries) {
    if (entry.kind !== 'file' || !entry.path.startsWith(prefix) || !entry.path.endsWith('.json')) continue
    const stored = await readJson(ctx, entry.path, schema, signal)
    if (stored !== undefined) records.push(stored.value)
  }
  return records
}

/** Keep one id usable as a single path segment. */
export function safeRecordSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/gu, '_')
  if (safe.length === 0 || safe === '.' || safe === '..') {
    throw new WorkspaceRecordError(`invalid record id ${JSON.stringify(value)}`, 'WORKSPACE_RECORD_CORRUPT')
  }
  return safe
}

/** Keep one id usable as a single path segment. */
function safeSegment(value: string): string {
  return safeRecordSegment(value)
}
