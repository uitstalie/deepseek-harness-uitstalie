/**
 * `workspace_artifacts`: publish, reference, and resolve the files a workspace
 * produced.
 *
 * `publish` hashes one file inside the workspace root and records an immutable
 * reference; it never copies the file. `reference` attaches an existing
 * reference to a message or a task. `list` reports the latest published version
 * of each artifact in the workspace; `resolve` compares one recorded version
 * with the file on disk and reports `ok`, `changed`, or `missing` without
 * exposing content. A path outside the workspace root is `denied`, so the
 * reference never escapes the workspace it belongs to.
 * @module @deepseek-ai/dsh-workspace-tools/artifacts
 */

import { createHash } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Session } from '@deepseek-ai/dsh-session'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { WorkspaceArtifactError, WorkspaceRecordError } from './errors.ts'
import { pageOf } from './paging.ts'
import type { ArtifactCitation, ArtifactReference, ArtifactResolution, ArtifactResolutionStatus, ArtifactRecord } from './records.ts'
import { resolveWorkspace } from './scope.ts'
import {
  artifactVersion,
  listArtifacts,
  readArtifact,
  readMessage,
  readTask,
  writeArtifact,
  writeMessage,
  writeTask,
} from './store.ts'
import { requireCallerSession } from './tooling.ts'

/** Largest file `resolve` hashes, in bytes. */
export const ARTIFACT_RESOLVE_MAX_BYTES = 64 * 1024 * 1024

/** Largest file `publish` hashes, in bytes. */
export const ARTIFACT_PUBLISH_MAX_BYTES = 64 * 1024 * 1024

/** Every artifact resolution status. */
export const ARTIFACT_RESOLUTION_STATUSES: readonly ArtifactResolutionStatus[] = [
  'ok', 'changed', 'missing', 'denied', 'pending', 'expired',
]

/** One published artifact reference as the tool returns it. */
export interface ArtifactView {
  /** Stable artifact id. */
  readonly artifactId: string
  /** Workspace that owns the referenced file. */
  readonly workspaceId: string
  /** Workspace-relative path of the referenced file. */
  readonly path: string
  /** SHA-256 of the published content. */
  readonly sha256: string
  /** Published content size in bytes. */
  readonly size: number
  /** Publish version. */
  readonly version: number
  /** Artifact kind. */
  readonly kind: string
  /** Session that published the reference. */
  readonly sessionId: string
  /** ISO-8601 publish instant. */
  readonly createdAt: string
  /** Task the reference belongs to. */
  readonly taskId?: string
  /** Optional one-line summary. */
  readonly summary?: string
}

/** One `workspace_artifacts` result value. */
export interface WorkspaceArtifactsValue {
  /** Workspace the result belongs to. */
  readonly workspace: string
  /** Latest published reference per artifact. */
  readonly items?: ArtifactView[]
  /** Resolution of one reference. */
  readonly resolution?: ArtifactResolution
  /** The reference one `publish` or `reference` call produced. */
  readonly artifact?: ArtifactView
  /** Message or task one `reference` call attached the citation to. */
  readonly attachedTo?: { readonly messageId?: string; readonly taskId?: string }
  /** Cursor of the next page. */
  readonly nextCursor?: string
}

/**
 * Build `workspace_artifacts`.
 * @param ctx - context carrying the store and the filesystem.
 * @returns the tool definition.
 */
export function workspaceArtifactsTool(ctx: Context): ToolDefinition {
  return defineTool({
    name: 'workspace_artifacts',
    description:
      'Publish, reference, and read artifact references in a workspace. `publish` registers one file inside the '
      + 'workspace root and returns an immutable reference (path, version, sha256, size); it never copies the file. '
      + '`reference` attaches an existing reference to a message or task without copying it. `list` returns the '
      + 'latest reference per artifact, filtered by session, task, kind, or path prefix; `resolve` reports whether '
      + 'one recorded version still matches the file as `ok`, `changed`, `missing`, or `denied`, without returning '
      + 'content. Use `read` for the content. The caller\'s workspace is the default scope.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['publish', 'reference', 'list', 'resolve'],
        description: '`publish` registers a file; `reference` cites it on a message or task; `list` and `resolve` read.',
      },
      workspace: {
        type: 'string',
        description: 'Registered workspace id to address; defaults to the caller\'s workspace.',
      },
      path: {
        type: 'string',
        description: 'Workspace-relative path for `publish`; must resolve inside the workspace root.',
      },
      kind: {
        type: 'string',
        description: 'Artifact kind for `publish`; for `list`, filters references of this kind.',
      },
      summary: {
        type: 'string',
        description: 'Optional one-line summary recorded on a published reference.',
      },
      artifactId: {
        type: 'string',
        description: 'Artifact to `reference` or `resolve`.',
      },
      version: {
        type: 'integer',
        description: 'Version to `reference` or `resolve`; defaults to the latest published version.',
      },
      messageId: {
        type: 'string',
        description: 'Message `reference` attaches the citation to.',
      },
      taskId: {
        type: 'string',
        description: 'Task `reference` attaches the citation to; for `list`, filters references recorded for a task.',
      },
      sessionId: {
        type: 'string',
        description: 'Only list references published by this session.',
      },
      pathPrefix: {
        type: 'string',
        description: 'Only list references whose path starts with this prefix.',
      },
      requestId: {
        type: 'string',
        description: 'Idempotency key for `publish` and `reference`; a retry with the same key returns the first result.',
      },
      cursor: {
        type: 'string',
        description: 'Cursor a previous page returned; omit for the first page.',
      },
      limit: {
        type: 'integer',
        description: 'Page size, 1 to 100; defaults to 20.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          workspace: { type: 'string', required: true },
          items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                artifactId: { type: 'string', required: true },
                workspaceId: { type: 'string', required: true },
                path: { type: 'string', required: true },
                sha256: { type: 'string', required: true },
                size: { type: 'integer', required: true },
                version: { type: 'integer', required: true },
                kind: { type: 'string', required: true },
                sessionId: { type: 'string', required: true },
                taskId: { type: 'string' },
                createdAt: { type: 'string', required: true },
                summary: { type: 'string' },
              },
            },
          },
          resolution: {
            type: 'object',
            additionalProperties: false,
            properties: {
              artifactId: { type: 'string', required: true },
              version: { type: 'integer', required: true },
              status: { type: 'string', required: true, enum: [...ARTIFACT_RESOLUTION_STATUSES] },
              path: { type: 'string', required: true },
              sha256: { type: 'string', required: true },
            },
          },
          artifact: {
            type: 'object',
            additionalProperties: false,
            properties: {
              artifactId: { type: 'string', required: true },
              workspaceId: { type: 'string', required: true },
              path: { type: 'string', required: true },
              sha256: { type: 'string', required: true },
              size: { type: 'integer', required: true },
              version: { type: 'integer', required: true },
              kind: { type: 'string', required: true },
              sessionId: { type: 'string', required: true },
              taskId: { type: 'string' },
              createdAt: { type: 'string', required: true },
              summary: { type: 'string' },
            },
          },
          attachedTo: {
            type: 'object',
            additionalProperties: false,
            properties: {
              messageId: { type: 'string' },
              taskId: { type: 'string' },
            },
          },
          nextCursor: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderArtifacts(value) }],
    },
    async execute(args, exec) {
      const session = requireCallerSession(exec.agent?.session, 'workspace_artifacts')
      const scope = await resolveWorkspace(ctx, session, `artifacts.${args.action}`, args.workspace)
      if (args.action === 'publish') {
        return {
          workspace: String(scope.workspace.id),
          artifact: await publishArtifact(ctx, scope.workspace, session, args, exec.signal),
        }
      }
      if (args.action === 'reference') {
        return {
          workspace: String(scope.workspace.id),
          ...await referenceArtifact(ctx, scope.workspace, args, exec.signal),
        }
      }
      if (args.action === 'resolve') {
        const artifactId = args.artifactId
        if (artifactId === undefined) {
          throw new WorkspaceRecordError('workspace_artifacts with action "resolve" requires artifactId', 'WORKSPACE_RECORD_NOT_FOUND')
        }
        return {
          workspace: String(scope.workspace.id),
          resolution: await resolveReference(ctx, scope.workspace, artifactId, args.version, exec.signal),
        }
      }
      const page = await listWorkspaceArtifacts(ctx, scope.workspace, args, exec.signal)
      return {
        workspace: String(scope.workspace.id),
        items: page.items,
        ...page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor },
      }
    },
  })
}

/** Arguments one publish call uses. */
interface PublishRequest {
  readonly path?: string
  readonly kind?: string
  readonly summary?: string
  readonly taskId?: string
  readonly requestId?: string
}

/**
 * Hash one workspace file and record its next immutable version.
 *
 * The artifact id is stable per `workspace|path|kind`, so re-publishing an
 * unchanged file returns the recorded version instead of minting a duplicate.
 * The file is hashed from the workspace root; a path that resolves outside it
 * is refused rather than followed.
 * @param ctx - context carrying the store and the filesystem.
 * @param workspace - workspace that owns the file.
 * @param session - publishing Session.
 * @param request - path, kind, summary, and optional task.
 * @param signal - cancellation for the filesystem and store operations.
 * @returns the published reference.
 * @throws WorkspaceArtifactError when the path leaves the workspace or is not a regular file.
 */
async function publishArtifact(
  ctx: Context,
  workspace: Workspace,
  session: Session,
  request: PublishRequest,
  signal: AbortSignal | undefined,
): Promise<ArtifactView> {
  if ((request.requestId ?? '').trim() === '') {
    throw new WorkspaceArtifactError(
      'workspace_artifacts with action "publish" requires requestId so a retry cannot publish twice',
      'ARTIFACT_INVALID',
    )
  }
  const relative = request.path?.trim() ?? ''
  const kind = request.kind?.trim() ?? ''
  if (relative === '') {
    throw new WorkspaceArtifactError('workspace_artifacts with action "publish" requires path', 'ARTIFACT_INVALID')
  }
  if (kind === '') {
    throw new WorkspaceArtifactError('workspace_artifacts with action "publish" requires kind', 'ARTIFACT_INVALID')
  }
  if (isAbsolute(relative)) {
    throw new WorkspaceArtifactError(
      `publish path ${JSON.stringify(relative)} is absolute; use a workspace-relative path`,
      'ARTIFACT_PATH_OUTSIDE',
    )
  }
  const root = await ctx.fs.resolve(workspace.path, signal === undefined ? {} : { signal })
  const target = await ctx.fs.resolve(join(workspace.path, relative), signal === undefined ? {} : { signal })
  if (!ctx.fs.contains(root, target)) {
    throw new WorkspaceArtifactError(
      `publish path ${JSON.stringify(relative)} resolves outside workspace ${String(workspace.id)}`,
      'ARTIFACT_PATH_OUTSIDE',
    )
  }
  const info = await ctx.fs.stat(target, signal)
  if (info === undefined) {
    throw new WorkspaceArtifactError(
      `publish path ${JSON.stringify(relative)} does not exist in workspace ${String(workspace.id)}`,
      'ARTIFACT_NOT_A_FILE',
    )
  }
  if (info.type !== 'file') {
    throw new WorkspaceArtifactError(
      `publish path ${JSON.stringify(relative)} is not a regular file`,
      'ARTIFACT_NOT_A_FILE',
    )
  }
  let bytes: Uint8Array
  try {
    bytes = await ctx.fs.readBytes(target, signal, ARTIFACT_PUBLISH_MAX_BYTES)
  } catch (error: unknown) {
    if (error instanceof Error && (error as { code?: unknown }).code === 'FS_TOO_LARGE') {
      throw new WorkspaceArtifactError(
        `publish path ${JSON.stringify(relative)} exceeds the ${String(ARTIFACT_PUBLISH_MAX_BYTES)}-byte publish bound`,
        'ARTIFACT_TOO_LARGE',
      )
    }
    throw error
  }
  if (request.taskId !== undefined && await readTask(ctx, workspace.id, request.taskId, signal) === undefined) {
    throw new WorkspaceRecordError(
      `workspace ${String(workspace.id)} holds no task ${JSON.stringify(request.taskId)}`,
      'WORKSPACE_RECORD_NOT_FOUND',
    )
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const artifactId = `artifact-${createHash('sha256')
    .update(`${String(workspace.id)}|${relative}|${kind}`)
    .digest('hex')
    .slice(0, 16)}`
  const stored = await readArtifact(ctx, workspace.id, artifactId, signal)
  const latest = stored === undefined ? undefined : artifactVersion(stored.record)
  if (latest !== undefined && latest.sha256 === sha256 && latest.size === bytes.byteLength
    && latest.path === relative && latest.kind === kind) {
    return artifactView(latest)
  }
  const reference: ArtifactReference = {
    artifactId,
    workspaceId: String(workspace.id),
    path: relative,
    sha256,
    size: bytes.byteLength,
    version: (latest?.version ?? 0) + 1,
    kind,
    sessionId: String(session.id),
    ...request.taskId === undefined ? {} : { taskId: request.taskId },
    createdAt: new Date().toISOString(),
    ...request.summary === undefined ? {} : { summary: request.summary },
  }
  const record: ArtifactRecord = {
    artifactId,
    workspaceId: String(workspace.id),
    versions: [...stored?.record.versions ?? [], reference],
  }
  await writeArtifact(ctx, workspace.id, record, {
    session,
    ...stored?.version === undefined ? {} : { expected: stored.version },
  })
  return artifactView(reference)
}

/**
 * Attach one existing reference to a message or task.
 *
 * The citation captures the artifact id, version, and hash; the file is never
 * copied. Attaching the same artifact twice is a no-op.
 * @param ctx - context carrying the store.
 * @param workspace - workspace that owns the artifact.
 * @param request - artifact id and version, plus the message or task to attach to.
 * @param signal - cancellation for the store operations.
 * @returns the reference and what it was attached to.
 * @throws WorkspaceRecordError when the artifact, message, or task does not exist.
 */
async function referenceArtifact(
  ctx: Context,
  workspace: Workspace,
  request: {
    readonly artifactId?: string
    readonly version?: number
    readonly messageId?: string
    readonly taskId?: string
    readonly requestId?: string
  },
  signal: AbortSignal | undefined,
): Promise<{ readonly artifact: ArtifactView; readonly attachedTo?: { readonly messageId?: string; readonly taskId?: string } }> {
  if ((request.requestId ?? '').trim() === '') {
    throw new WorkspaceArtifactError(
      'workspace_artifacts with action "reference" requires requestId so a retry cannot attach twice',
      'ARTIFACT_INVALID',
    )
  }
  const artifactId = request.artifactId?.trim() ?? ''
  if (artifactId === '') {
    throw new WorkspaceRecordError('workspace_artifacts with action "reference" requires artifactId', 'WORKSPACE_RECORD_NOT_FOUND')
  }
  const stored = await readArtifact(ctx, workspace.id, artifactId, signal)
  const reference = stored === undefined ? undefined : artifactVersion(stored.record, request.version)
  if (reference === undefined) {
    throw new WorkspaceRecordError(
      `workspace ${String(workspace.id)} holds no artifact ${JSON.stringify(artifactId)}`
      + (request.version === undefined ? '' : ` version ${String(request.version)}`),
      'WORKSPACE_RECORD_NOT_FOUND',
    )
  }
  const citation: ArtifactCitation = {
    artifactId: reference.artifactId,
    version: reference.version,
    sha256: reference.sha256,
  }
  const attachedTo: { messageId?: string; taskId?: string } = {}
  if (request.messageId !== undefined) {
    const message = await readMessage(ctx, workspace.id, request.messageId, signal)
    if (message === undefined) {
      throw new WorkspaceRecordError(
        `workspace ${String(workspace.id)} holds no message ${JSON.stringify(request.messageId)}`,
        'WORKSPACE_RECORD_NOT_FOUND',
      )
    }
    if (!message.message.references.some(existing => existing.artifactId === citation.artifactId
      && existing.version === citation.version)) {
      await writeMessage(ctx, workspace.id, {
        ...message.message,
        references: [...message.message.references, citation],
      }, {
        ...message.version === undefined ? {} : { expected: message.version },
      })
    }
    attachedTo.messageId = request.messageId
  }
  if (request.taskId !== undefined) {
    const task = await readTask(ctx, workspace.id, request.taskId, signal)
    if (task === undefined) {
      throw new WorkspaceRecordError(
        `workspace ${String(workspace.id)} holds no task ${JSON.stringify(request.taskId)}`,
        'WORKSPACE_RECORD_NOT_FOUND',
      )
    }
    if (!task.task.artifactIds.includes(citation.artifactId)) {
      await writeTask(ctx, workspace.id, {
        ...task.task,
        artifactIds: [...task.task.artifactIds, citation.artifactId],
        updatedAt: new Date().toISOString(),
      }, {
        ...task.version === undefined ? {} : { expected: task.version },
      })
    }
    attachedTo.taskId = request.taskId
  }
  return {
    artifact: artifactView(reference),
    ...request.messageId === undefined && request.taskId === undefined ? {} : { attachedTo },
  }
}

/**
 * List the latest published reference of each artifact, filtered and paged.
 * @param ctx - context carrying the store.
 * @param workspace - workspace whose artifacts are listed.
 * @param request - session, task, kind, and path-prefix filters plus paging.
 * @param signal - cancellation for the store reads.
 * @returns the page of references.
 */
async function listWorkspaceArtifacts(
  ctx: Context,
  workspace: Workspace,
  request: {
    readonly sessionId?: string
    readonly taskId?: string
    readonly kind?: string
    readonly pathPrefix?: string
    readonly cursor?: string
    readonly limit?: number
  },
  signal: AbortSignal | undefined,
): Promise<{ readonly items: ArtifactView[]; readonly nextCursor?: string }> {
  const records = await listArtifacts(ctx, workspace.id, signal)
  const references = records.flatMap((record) => {
    const reference = artifactVersion(record)
    if (reference === undefined) return []
    if (request.sessionId !== undefined && reference.sessionId !== request.sessionId) return []
    if (request.taskId !== undefined && reference.taskId !== request.taskId) return []
    if (request.kind !== undefined && reference.kind !== request.kind) return []
    if (request.pathPrefix !== undefined && !reference.path.startsWith(request.pathPrefix)) return []
    return [artifactView(reference)]
  })
  references.sort((left, right) => left.path.localeCompare(right.path) || left.artifactId.localeCompare(right.artifactId))
  const page = pageOf(references, request.limit, request.cursor)
  return { items: page.items, ...page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor } }
}

/**
 * Project one durable reference into the tool's view.
 * @param reference - the durable artifact reference.
 * @returns the view, with absent optional fields omitted.
 */
export function artifactView(reference: ArtifactReference): ArtifactView {
  return {
    artifactId: reference.artifactId,
    workspaceId: reference.workspaceId,
    path: reference.path,
    sha256: reference.sha256,
    size: reference.size,
    version: reference.version,
    kind: reference.kind,
    sessionId: reference.sessionId,
    createdAt: reference.createdAt,
    ...reference.taskId === undefined ? {} : { taskId: reference.taskId },
    ...reference.summary === undefined ? {} : { summary: reference.summary },
  }
}

/**
 * Resolve one recorded artifact version against the current file.
 * @param ctx - context carrying the store and the filesystem.
 * @param workspace - workspace that owns the artifact.
 * @param artifactId - artifact identity.
 * @param version - recorded version, or undefined for the latest.
 * @param signal - cancellation for the store and filesystem reads.
 * @returns the resolution.
 * @throws WorkspaceRecordError when the workspace holds no such artifact or version.
 * @throws WorkspaceArtifactError when the file exceeds {@link ARTIFACT_RESOLVE_MAX_BYTES}.
 */
async function resolveReference(
  ctx: Context,
  workspace: Workspace,
  artifactId: string,
  version: number | undefined,
  signal: AbortSignal | undefined,
): Promise<ArtifactResolution> {
  const stored = await readArtifactRecord(ctx, workspace, artifactId, signal)
  const reference = artifactVersion(stored, version)
  if (reference === undefined) {
    throw new WorkspaceRecordError(
      `artifact ${JSON.stringify(artifactId)} has no recorded version ${String(version)}`,
      'WORKSPACE_RECORD_NOT_FOUND',
    )
  }
  const base: ArtifactResolution = {
    artifactId: reference.artifactId,
    version: reference.version,
    path: reference.path,
    sha256: reference.sha256,
    status: 'missing',
  }
  const root = await ctx.fs.resolve(workspace.path, signal === undefined ? {} : { signal })
  const target = await ctx.fs.resolve(join(workspace.path, reference.path), signal === undefined ? {} : { signal })
  if (!ctx.fs.contains(root, target)) return { ...base, status: 'denied' }
  const info = await ctx.fs.stat(target, signal)
  if (info === undefined) return base
  if (info.type !== 'file') return { ...base, status: 'denied' }
  let bytes: Uint8Array
  try {
    bytes = await ctx.fs.readBytes(target, signal, ARTIFACT_RESOLVE_MAX_BYTES)
  } catch (error: unknown) {
    if (error instanceof Error && (error as { code?: unknown }).code === 'FS_TOO_LARGE') {
      throw new WorkspaceArtifactError(
        `artifact ${reference.artifactId} v${String(reference.version)} exceeds the ${String(ARTIFACT_RESOLVE_MAX_BYTES)}-byte resolve bound`,
        'ARTIFACT_TOO_LARGE',
      )
    }
    throw error
  }
  const digest = createHash('sha256').update(bytes).digest('hex')
  return { ...base, status: digest === reference.sha256 ? 'ok' : 'changed' }
}

/**
 * Read one artifact record, failing when the workspace holds no such artifact.
 * @param ctx - context carrying the store.
 * @param workspace - workspace that owns the artifact.
 * @param artifactId - artifact identity.
 * @param signal - cancellation for the store read.
 * @returns the artifact record.
 * @throws WorkspaceRecordError when the workspace holds no such artifact.
 */
async function readArtifactRecord(
  ctx: Context,
  workspace: Workspace,
  artifactId: string,
  signal: AbortSignal | undefined,
): Promise<ArtifactRecord> {
  const stored = await readArtifact(ctx, workspace.id, artifactId, signal)
  if (stored === undefined) {
    throw new WorkspaceRecordError(
      `workspace ${String(workspace.id)} holds no artifact ${JSON.stringify(artifactId)}`,
      'WORKSPACE_RECORD_NOT_FOUND',
    )
  }
  return stored.record
}

/**
 * Render one artifacts value for the model.
 * @param value - the tool result.
 * @returns the model-facing text.
 */
function renderArtifacts(value: WorkspaceArtifactsValue): string {
  const artifact = value.artifact
  if (artifact !== undefined) {
    const attached = value.attachedTo === undefined
      ? ''
      : ` · attached to ${[
        value.attachedTo.messageId === undefined ? undefined : `message ${value.attachedTo.messageId}`,
        value.attachedTo.taskId === undefined ? undefined : `task ${value.attachedTo.taskId}`,
      ].filter((part): part is string => part !== undefined).join(' and ')}`
    return `${artifact.artifactId} v${String(artifact.version)} · ${artifact.path} · ${artifact.kind}`
      + ` · ${String(artifact.size)} bytes · sha256 ${artifact.sha256}${attached}`
  }
  const resolution = value.resolution
  if (resolution !== undefined) {
    const detail = resolution.status === 'ok'
      ? 'the file matches the recorded version'
      : resolution.status === 'changed'
        ? 'the file exists but its hash differs from the recorded version'
        : resolution.status === 'missing'
          ? 'the file no longer exists'
          : resolution.status === 'denied'
            ? 'the path leaves the workspace or is not a regular file'
            : resolution.status === 'pending'
              ? 'an access request exists without a decision'
              : 'the access grant expired'
    return `${resolution.artifactId} v${String(resolution.version)} · ${resolution.status}: ${detail} (${resolution.path})`
  }
  const items = value.items ?? []
  if (items.length === 0) return `No artifacts in workspace ${value.workspace}.`
  const lines = items.map(reference =>
    `- ${reference.artifactId} v${String(reference.version)} · ${reference.path} · ${reference.kind}`
    + ` · ${String(reference.size)} bytes · session ${reference.sessionId}`
    + (reference.taskId === undefined ? '' : ` · task ${reference.taskId}`))
  if (value.nextCursor !== undefined) lines.push(`(more artifacts: pass cursor ${value.nextCursor})`)
  return lines.join('\n')
}
