/**
 * `workspace_sessions`: which sessions a workspace has and what each is doing.
 *
 * Status, current activity, and recent progress are folded from the session's
 * own log, so the answer is the durable record rather than a remembered copy.
 * The tool returns bounded one-line summaries; raw turns stay behind
 * `session_event_read`.
 * @module @deepseek-ai/dsh-workspace-tools/sessions
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { defineTool, ToolArgsError } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { Page } from './paging.ts'
import { pageOf } from './paging.ts'
import { WorkspaceRecordError } from './errors.ts'
import { resolveWorkspace, workspaceDirectory } from './scope.ts'
import { listArtifacts, listMessages, listTasks } from './store.ts'
import type { TaskRecord } from './records.ts'
import { oneLine, requireCallerSession } from './tooling.ts'

/** One derived status of a workspace session. */
export type WorkspaceSessionStatus = 'running' | 'idle' | 'blocked' | 'done'

/** Every accepted session status. */
export const WORKSPACE_SESSION_STATUSES: readonly WorkspaceSessionStatus[] = ['running', 'idle', 'blocked', 'done']

/** Reason recorded by the latest `turn/end` event. */
type TurnEndReason = Extract<SessionEvent, { type: 'turn/end' }>['data']['reason']

/** One recent progress line. */
export interface ProgressEntry {
  /** ISO-8601 instant of the line's event. */
  readonly at: string
  /** Bounded one-line summary. */
  readonly summary: string
}

/** Current facts about one workspace session. */
export interface SessionFacts {
  /** Effective status. */
  readonly status: WorkspaceSessionStatus
  /** Latest turn number the log recorded; zero when the log has no turn. */
  readonly currentTurn: number
  /** Bounded description of the last observed activity. */
  readonly currentActivity?: string
  /** ISO-8601 instant of the latest progress line. */
  readonly lastProgressAt?: string
  /** Latest assistant progress line. */
  readonly latestProgress?: string
  /** Recent assistant progress lines, oldest first. */
  readonly recentProgress: ProgressEntry[]
}

/** Session summary as the list action returns it. */
export interface SessionSummary {
  /** Session identity. */
  readonly sessionId: string
  /** Latest log-backed title, when the session has one. */
  readonly title?: string
  /** Effective status. */
  readonly status: WorkspaceSessionStatus
  /** Latest turn number. */
  readonly currentTurn: number
  /** Bounded description of the last observed activity. */
  readonly currentActivity?: string
  /** ISO-8601 instant of the latest progress line. */
  readonly lastProgressAt?: string
  /** Latest assistant progress line. */
  readonly latestProgress?: string
  /** Task the session is executing, when one targets it. */
  readonly taskId?: string
}

/** One `workspace_sessions` result value. */
export interface WorkspaceSessionsValue {
  /** Workspace the result belongs to. */
  readonly workspace: string
  /** Paged session summaries. */
  readonly items?: SessionSummary[]
  /** Detailed view returned by `get`. */
  readonly session?: SessionSummary & {
    readonly recentProgress: ProgressEntry[]
    readonly pendingInbox: number
    readonly artifactCount: number
  }
  /** Cursor of the next page. */
  readonly nextCursor?: string
}

/**
 * Build `workspace_sessions`.
 * @param ctx - context carrying session-query, the store, and the registries.
 * @returns the tool definition.
 */
export function workspaceSessionsTool(ctx: Context): ToolDefinition {
  return defineTool({
    name: 'workspace_sessions',
    description:
      'List the sessions of a workspace and report what each is doing, or read one session\'s status, '
      + 'current activity, recent progress, pending inbox, and artifact count. The caller\'s workspace is the '
      + 'default scope; reading another workspace requires its registered id.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['list', 'get'],
        description: '`list` returns bounded session summaries; `get` adds recent progress and counts for one session.',
      },
      workspace: {
        type: 'string',
        description: 'Registered workspace id to read; defaults to the caller\'s workspace.',
      },
      sessionId: {
        type: 'string',
        description: 'Target session for `get`; required there and unused by `list`.',
      },
      status: {
        type: 'string',
        enum: [...WORKSPACE_SESSION_STATUSES],
        description: 'Only list sessions in this status.',
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
                sessionId: { type: 'string', required: true },
                title: { type: 'string' },
                status: { type: 'string', required: true, enum: [...WORKSPACE_SESSION_STATUSES] },
                currentTurn: { type: 'integer', required: true },
                currentActivity: { type: 'string' },
                lastProgressAt: { type: 'string' },
                latestProgress: { type: 'string' },
                taskId: { type: 'string' },
              },
            },
          },
          session: {
            type: 'object',
            additionalProperties: false,
            properties: {
              sessionId: { type: 'string', required: true },
              title: { type: 'string' },
              status: { type: 'string', required: true, enum: [...WORKSPACE_SESSION_STATUSES] },
              currentTurn: { type: 'integer', required: true },
              currentActivity: { type: 'string' },
              lastProgressAt: { type: 'string' },
              latestProgress: { type: 'string' },
              taskId: { type: 'string' },
              recentProgress: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    at: { type: 'string', required: true },
                    summary: { type: 'string', required: true },
                  },
                },
              },
              pendingInbox: { type: 'integer', required: true },
              artifactCount: { type: 'integer', required: true },
            },
          },
          nextCursor: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderSessions(value) }],
    },
    async execute(args, exec) {
      const session = requireCallerSession(exec.agent?.session, 'workspace_sessions')
      if (args.action === 'get' && args.sessionId === undefined) {
        throw new ToolArgsError(['workspace_sessions with action "get" requires sessionId'])
      }
      const scope = await resolveWorkspace(ctx, session, `sessions.${args.action}`, args.workspace)
      if (args.action === 'get') {
        const target = args.sessionId
        if (target === undefined) throw new ToolArgsError(['workspace_sessions with action "get" requires sessionId'])
        return { workspace: String(scope.workspace.id), session: await describeSession(ctx, scope.workspace, target, exec.signal) }
      }
      const page = await listWorkspaceSessions(ctx, scope.workspace, args, exec.signal)
      return {
        workspace: String(scope.workspace.id),
        items: page.items,
        ...page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor },
      }
    },
  })
}

/**
 * List the sessions a workspace accounts for, filtered and paged.
 * @param ctx - context carrying session-query, the store, and the registries.
 * @param workspace - workspace whose sessions are listed.
 * @param request - status filter, cursor, and page size.
 * @param signal - cancellation for the log and record reads.
 * @returns the page of summaries.
 */
async function listWorkspaceSessions(
  ctx: Context,
  workspace: Workspace,
  request: { readonly status?: WorkspaceSessionStatus; readonly cursor?: string; readonly limit?: number },
  signal: AbortSignal | undefined,
): Promise<Page<SessionSummary>> {
  const ids = workspace.sessionIds
  if (ids.length === 0) return { items: [] }
  const records = await ctx.sessionQuery.filterSessions([{ kind: 'id', values: ids }], signal)
  records.sort((left, right) => right.header.createdAt - left.header.createdAt
    || String(left.header.id).localeCompare(String(right.header.id)))
  const taskOf = activeTaskBySession(await listTasks(ctx, workspace.id, signal))
  const archived = new Set(workspaceDirectory(ctx).archivedSessionIds.map(id => String(id)))
  const summaries: SessionSummary[] = []
  for (const record of records) {
    const id = String(record.header.id)
    const facts = await readSessionFacts(ctx, id, archived.has(id), signal)
    if (request.status !== undefined && facts.status !== request.status) continue
    const taskId = taskOf.get(id)
    summaries.push({
      sessionId: id,
      status: facts.status,
      currentTurn: facts.currentTurn,
      ...facts.currentActivity === undefined ? {} : { currentActivity: facts.currentActivity },
      ...facts.lastProgressAt === undefined ? {} : { lastProgressAt: facts.lastProgressAt },
      ...facts.latestProgress === undefined ? {} : { latestProgress: facts.latestProgress },
      ...taskId === undefined ? {} : { taskId },
    })
  }
  const page = pageOf(summaries, request.limit, request.cursor)
  const titles = await sessionTitles(ctx, page.items.map(item => item.sessionId), signal)
  return {
    items: page.items.map((item) => {
      const title = titles.get(item.sessionId)
      return title === undefined ? item : { ...item, title }
    }),
    ...page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor },
  }
}

/**
 * Describe one session in full: summary, recent progress, pending inbox, and artifact count.
 * @param ctx - context carrying session-query and the store.
 * @param workspace - workspace the session must belong to.
 * @param sessionId - target session id.
 * @param signal - cancellation for the log and record reads.
 * @returns the detailed session view.
 * @throws WorkspaceRecordError when the id is not a session of this workspace.
 */
async function describeSession(
  ctx: Context,
  workspace: Workspace,
  sessionId: string,
  signal: AbortSignal | undefined,
): Promise<NonNullable<WorkspaceSessionsValue['session']>> {
  if (!workspace.sessionIds.includes(SessionId(sessionId))) {
    throw new WorkspaceRecordError(
      `session ${sessionId} is not a session of workspace ${String(workspace.id)}`,
      'WORKSPACE_RECORD_NOT_FOUND',
    )
  }
  const archived = workspaceDirectory(ctx).archivedSessionIds.map(id => String(id)).includes(sessionId)
  const facts = await readSessionFacts(ctx, sessionId, archived, signal)
  const title = (await sessionTitles(ctx, [sessionId], signal)).get(sessionId)
  const taskId = activeTaskBySession(await listTasks(ctx, workspace.id, signal)).get(sessionId)
  const messages = await listMessages(ctx, workspace.id, signal)
  const pendingInbox = messages.filter(message => message.targetSessionId === sessionId && message.status === 'queued').length
  const artifacts = await listArtifacts(ctx, workspace.id, signal)
  const artifactCount = artifacts.filter(record => record.versions.some(reference => reference.sessionId === sessionId)).length
  return {
    sessionId,
    ...title === undefined ? {} : { title },
    status: facts.status,
    currentTurn: facts.currentTurn,
    ...facts.currentActivity === undefined ? {} : { currentActivity: facts.currentActivity },
    ...facts.lastProgressAt === undefined ? {} : { lastProgressAt: facts.lastProgressAt },
    ...facts.latestProgress === undefined ? {} : { latestProgress: facts.latestProgress },
    ...taskId === undefined ? {} : { taskId },
    recentProgress: facts.recentProgress,
    pendingInbox,
    artifactCount,
  }
}

/**
 * Fold status and progress out of one session log.
 * @param ctx - context carrying session-query and the live agent registry.
 * @param sessionId - session whose log is observed.
 * @param archived - whether the registry holds this session in its archive set.
 * @param signal - cancellation for the observation.
 * @returns the folded facts.
 */
async function readSessionFacts(
  ctx: Context,
  sessionId: string,
  archived: boolean,
  signal: AbortSignal | undefined,
): Promise<SessionFacts> {
  const id = SessionId(sessionId)
  using observation = await ctx.sessionQuery.observeSession(id, {
    projectionMode: 'none',
    ...signal === undefined ? {} : { signal },
  })
  const folded = foldLog(observation.events)
  const live = ctx.get('agents')?.get(id)
  return {
    status: archived ? 'done' : statusOf(live?.status, folded.lastEndReason),
    currentTurn: folded.currentTurn,
    ...folded.currentActivity === undefined ? {} : { currentActivity: folded.currentActivity },
    ...folded.lastProgressAt === undefined ? {} : { lastProgressAt: folded.lastProgressAt },
    ...folded.latestProgress === undefined ? {} : { latestProgress: folded.latestProgress },
    recentProgress: folded.recentProgress,
  }
}

/** Folded activity facts of one event log. */
interface LogFacts {
  /** Latest turn number. */
  readonly currentTurn: number
  /** Last observed activity line. */
  readonly currentActivity?: string
  /** Instant of the latest progress line. */
  readonly lastProgressAt?: string
  /** Latest assistant progress line. */
  readonly latestProgress?: string
  /** Recent assistant progress lines. */
  readonly recentProgress: ProgressEntry[]
  /** Reason of the latest `turn/end`. */
  readonly lastEndReason?: TurnEndReason
}

/**
 * Fold the parts of one log that answer "what is this session doing".
 * @param events - complete event log in seq order.
 * @returns turn, activity, and recent progress lines.
 */
function foldLog(events: readonly SessionEvent[]): LogFacts {
  let currentTurn = 0
  let currentActivity: string | undefined
  let lastEndReason: TurnEndReason | undefined
  const progress: ProgressEntry[] = []
  for (const event of events) {
    switch (event.type) {
      case 'turn/start':
        currentTurn = event.data.turn
        break
      case 'assistant/message': {
        const text = event.data.message.content
          .flatMap(block => block.type === 'text' ? [block.text] : [])
          .join(' ')
          .trim()
        if (text.length === 0) break
        progress.push({ at: new Date(event.time).toISOString(), summary: oneLine(text, 200) })
        currentActivity = `Assistant: ${oneLine(text, 120)}`
        break
      }
      case 'tool/call':
        currentActivity = `Calling ${event.data.name}`
        break
      case 'turn/end':
        lastEndReason = event.data.reason
        currentActivity = reasonLine(event.data.reason)
        break
      default:
        break
    }
  }
  const latest = progress.at(-1)
  return {
    currentTurn,
    ...currentActivity === undefined ? {} : { currentActivity },
    ...latest === undefined ? {} : { lastProgressAt: latest.at },
    ...latest === undefined ? {} : { latestProgress: latest.summary },
    recentProgress: progress.slice(-5),
    ...lastEndReason === undefined ? {} : { lastEndReason },
  }
}

/**
 * Derive the status from the live agent and the last turn outcome.
 * @param liveStatus - status of the live agent, or undefined when the session is not live.
 * @param lastEndReason - reason of the last `turn/end`, when the log has one.
 * @returns the effective status.
 */
function statusOf(
  liveStatus: 'idle' | 'running' | undefined,
  lastEndReason: TurnEndReason | undefined,
): WorkspaceSessionStatus {
  if (liveStatus === 'running') return 'running'
  if (lastEndReason?.kind === 'blocked') return 'blocked'
  return 'idle'
}

/**
 * Render one turn-ending reason as a bounded activity line.
 * @param reason - the durable turn-ending reason.
 * @returns the activity line.
 */
function reasonLine(reason: TurnEndReason): string {
  switch (reason.kind) {
    case 'completed':
      return 'Turn completed'
    case 'blocked':
      return 'Blocked'
    case 'error':
      return `Turn failed: ${oneLine(reason.error.message, 120)}`
    case 'aborted':
      return 'Turn aborted'
    case 'max-tokens':
      return 'Turn reached the output token cap'
    case 'interrupted':
      return 'Turn was interrupted'
    case 'forked':
      return 'Turn was closed by a fork'
    default:
      return 'Turn ended'
  }
}

/**
 * Read the latest log-backed title of each session.
 * @param ctx - context carrying session-query.
 * @param sessionIds - sessions whose titles are read.
 * @param signal - cancellation for the reads.
 * @returns title text by session id, for the sessions that carry one.
 */
async function sessionTitles(
  ctx: Context,
  sessionIds: readonly string[],
  signal: AbortSignal | undefined,
): Promise<ReadonlyMap<string, string>> {
  const ids = [...new Set(sessionIds)]
  if (ids.length === 0) return new Map()
  const observations = await ctx.sessionQuery.readTitleSnapshots(ids.map(id => SessionId(id)), signal)
  const titles = new Map<string, string>()
  ids.forEach((id, index) => {
    const observation = observations[index]
    if (observation === undefined || observation.status === 'rejected') return
    const title = observation.value.title?.title
    if (title !== undefined) titles.set(id, title)
  })
  return titles
}

/**
 * Map each session to the task currently targeting it.
 * @param tasks - workspace tasks, most recently updated first.
 * @returns the first active task's id by target session.
 */
function activeTaskBySession(tasks: readonly TaskRecord[]): ReadonlyMap<string, string> {
  const active = new Map<string, string>()
  for (const task of tasks) {
    if (task.targetSessionId === undefined) continue
    if (task.status !== 'pending' && task.status !== 'in_progress' && task.status !== 'waiting_review') continue
    if (!active.has(task.targetSessionId)) active.set(task.targetSessionId, task.taskId)
  }
  return active
}

/**
 * Render one sessions value for the model.
 * @param value - the tool result.
 * @returns the model-facing text.
 */
function renderSessions(value: WorkspaceSessionsValue): string {
  const details = value.session
  if (details !== undefined) {
    const lines = [
      (details.title === undefined ? details.sessionId : `${details.title} (${details.sessionId})`)
      + ` · ${details.status} · turn ${String(details.currentTurn)}`
      + (details.taskId === undefined ? '' : ` · task ${details.taskId}`)
      + ` · ${String(details.pendingInbox)} queued · ${String(details.artifactCount)} artifacts`,
      `Current: ${details.currentActivity ?? 'no activity recorded'}${details.lastProgressAt === undefined ? '' : ` (${details.lastProgressAt})`}`,
    ]
    if (details.recentProgress.length > 0) {
      lines.push('Recent progress:')
      for (const entry of details.recentProgress) lines.push(`- ${entry.at} · ${entry.summary}`)
    }
    return lines.join('\n')
  }
  const items = value.items ?? []
  if (items.length === 0) return `No sessions in workspace ${value.workspace}.`
  const lines = items.map(item =>
    `- ${item.title === undefined ? item.sessionId : `${item.title} (${item.sessionId})`}`
    + ` · ${item.status} · turn ${String(item.currentTurn)}`
    + (item.currentActivity === undefined ? '' : ` · ${item.currentActivity}`)
    + (item.taskId === undefined ? '' : ` · task ${item.taskId}`))
  if (value.nextCursor !== undefined) lines.push(`(more sessions: pass cursor ${value.nextCursor})`)
  return lines.join('\n')
}
