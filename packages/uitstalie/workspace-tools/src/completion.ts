/**
 * Task-bound dispatch completion notices.
 *
 * When an executor Session finishes a turn and it is the `targetSessionId` of a
 * dispatch task with a `dispatcherSessionId`, the dispatcher receives one user
 * message so an idle dispatcher is woken for a new turn. The notice only
 * reports that the turn ended; the task state machine stays owned by
 * `workspace_tasks`, and the notice never changes the task.
 *
 * A turn whose own input is a notice is skipped, so a wake cannot chain into
 * another notice for the same task. Turns with a `taskId`-linked
 * `workspace_message` reply are also skipped: the reply is the report.
 * @module @deepseek-ai/dsh-workspace-tools/completion
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { isArchivedSession, messageDeliveryController, requestDelivery } from './delivery.ts'
import { resolveWorkspace } from './scope.ts'
import { listMessages, listTasks } from './store.ts'
import type { TaskRecord } from './records.ts'
import { oneLine } from './tooling.ts'

/** First line that marks a completion notice; also suppresses notices from a notice turn. */
export const COMPLETION_NOTICE_MARKER = '[workspace-task-settled]'

/** When completion notices are delivered: never, or only for task-bound dispatches. */
export type CompletionNoticeMode = 'off' | 'task-bound'

/** Limits and switch for completion notices. */
export interface CompletionNoticeOptions {
  /** Whether notices are delivered at all. */
  readonly mode: CompletionNoticeMode
  /** Most notices one task may receive inside {@link ttlMs}; older entries expire. */
  readonly maxPerTask: number
  /** Notice window for the per-task cap and the duplicate guard. */
  readonly ttlMs: number
}

/** Defaults for deployments that do not configure the notice. */
export const DEFAULT_NOTICE_MAX_PER_TASK = 32

/** Default notice window: one day. */
export const DEFAULT_NOTICE_TTL_MS = 86_400_000

/** One Session's open turn, as the notice guard needs it. */
interface OpenTurn {
  readonly turn: number
  readonly startedAt: number
  noticeTurn: boolean
}

/** One captured turn end handed to the asynchronous worker. */
interface FinishedTurn extends OpenTurn {
  readonly endedAt: number
  readonly reason: TurnEndReason
}

/**
 * Mount the completion-notice listener when the feature is on.
 *
 * The listener never throws into the Session append path: every failure is
 * logged and dropped, because a notice is a convenience, not part of the
 * executor's turn.
 * @param ctx - plugin context carrying the store, registry, and logger.
 * @param options - switch, per-task cap, and expiry window.
 */
export function mountCompletionNotices(ctx: Context, options: CompletionNoticeOptions): void {
  if (options.mode === 'off') return
  const abort = new AbortController()
  ctx.effect(() => () => { abort.abort() }, 'workspace-tools.completion-notices')
  const open = new Map<string, OpenTurn>()
  const notified = new Map<string, number>()
  const taskNotices = new Map<string, number[]>()

  ctx.on('session/event', (session: Session, event: SessionEvent): void => {
    const sessionId = String(session.id)
    if (event.type === 'turn/start') {
      open.set(sessionId, { turn: event.data.turn, startedAt: event.time, noticeTurn: false })
      return
    }
    if (event.type === 'user/message') {
      const turn = open.get(sessionId)
      if (turn !== undefined && userMessageHasMarker(event)) turn.noticeTurn = true
      return
    }
    if (event.type !== 'turn/end') return
    const turn = open.get(sessionId)
    open.delete(sessionId)
    if (turn === undefined || turn.turn !== event.data.turn) return
    const finished: FinishedTurn = { ...turn, endedAt: event.time, reason: event.data.reason }
    void handleFinishedTurn(ctx, options, session, finished, { notified, taskNotices }, abort.signal)
      .catch((error: unknown) => {
        ctx.logger.warn('workspace-tools: completion notice for session %s failed: %s', sessionId, String(error))
      })
  }, { global: true })
}

/**
 * Whether one user message is a delivered completion notice.
 * @param event - the `user/message` event to inspect.
 * @returns whether any text block starts with {@link COMPLETION_NOTICE_MARKER}.
 */
function userMessageHasMarker(event: SessionEvent<'user/message'>): boolean {
  return event.data.content.some(block => block.type === 'text' && block.text.trimStart().startsWith(COMPLETION_NOTICE_MARKER))
}

/**
 * Resolve the executor's workspace and deliver one notice per eligible task.
 * @param ctx - plugin context.
 * @param options - switch and limits.
 * @param session - executor Session whose turn ended.
 * @param turn - captured turn facts.
 * @param state - duplicate and per-task windows shared across turns.
 * @param signal - teardown cancellation for deliveries.
 */
async function handleFinishedTurn(
  ctx: Context,
  options: CompletionNoticeOptions,
  session: Session,
  turn: FinishedTurn,
  state: { readonly notified: Map<string, number>; readonly taskNotices: Map<string, number[]> },
  signal: AbortSignal,
): Promise<void> {
  if (turn.noticeTurn) return
  const workspace = await workspaceOf(ctx, session)
  if (workspace === undefined) return
  const tasks = await listTasks(ctx, workspace.id)
  const sessionId = String(session.id)
  const eligible = tasks.filter((task): task is TaskRecord & { readonly dispatcherSessionId: string } =>
    task.targetSessionId === sessionId
    && task.dispatcherSessionId !== undefined
    && task.dispatcherSessionId !== sessionId
    && task.status !== 'done'
    && task.status !== 'cancelled')
  if (eligible.length === 0) return
  const messages = await listMessages(ctx, workspace.id)
  pruneNotified(state.notified, turn.endedAt, options.ttlMs)
  for (const task of eligible) {
    const dispatcherSessionId = task.dispatcherSessionId
    const key = noticeKey(task.taskId, sessionId, turn.turn)
    if (state.notified.has(key)) continue
    const replied = messages.some(message =>
      message.sourceSessionId === sessionId
      && message.taskId === task.taskId
      && Date.parse(message.createdAt) >= turn.startedAt)
    if (replied) {
      state.notified.set(key, turn.endedAt)
      continue
    }
    const recent = recentForTask(state.taskNotices, task.taskId, turn.endedAt, options.ttlMs)
    if (recent.length >= options.maxPerTask) {
      ctx.logger.debug('workspace-tools: completion notice for task %s exceeded %d notices per %d ms; skipped',
        task.taskId, options.maxPerTask, options.ttlMs)
      state.notified.set(key, turn.endedAt)
      continue
    }
    if (isArchivedSession(ctx, dispatcherSessionId)) {
      state.notified.set(key, turn.endedAt)
      continue
    }
    const delivery = messageDeliveryController(ctx)
    if (delivery === undefined) {
      ctx.logger.warn('workspace-tools: no Session controller, so the completion notice for task %s was not delivered',
        task.taskId)
      continue
    }
    const outcome = await requestDelivery(delivery, {
      requestId: requestIdFor(task.taskId, sessionId, turn.turn),
      sessionId: dispatcherSessionId,
      mode: 'queue',
      content: [{ type: 'text', text: noticeText(task, sessionId, turn) }],
    }, signal)
    if (!outcome.accepted) {
      ctx.logger.warn('workspace-tools: completion notice for task %s was refused: %s', task.taskId, outcome.error)
      continue
    }
    state.notified.set(key, turn.endedAt)
    recent.push(turn.endedAt)
  }
}

/**
 * Find the registered workspace that accounts for one Session.
 * @param ctx - plugin context.
 * @param session - executor Session.
 * @returns the workspace, or undefined when the Session has none.
 */
async function workspaceOf(ctx: Context, session: Session): Promise<Workspace | undefined> {
  try {
    return (await resolveWorkspace(ctx, session, 'completion-notice')).workspace
  } catch {
    // A Session outside every registered workspace has no task to notify; scope refusal ends this turn's work.
    return undefined
  }
}

/**
 * Build the duplicate key for one task turn.
 * @param taskId - task whose notice would be sent.
 * @param sessionId - executor Session.
 * @param turn - finished turn number.
 * @returns the key.
 */
function noticeKey(taskId: string, sessionId: string, turn: number): string {
  return `${taskId}|${sessionId}|${String(turn)}`
}

/**
 * Build the host request identity for one notice.
 * @param taskId - task whose notice is sent.
 * @param sessionId - executor Session.
 * @param turn - finished turn number.
 * @returns the stable request id.
 */
function requestIdFor(taskId: string, sessionId: string, turn: number): string {
  return `workspace-task-settled-${taskId}-${sessionId}-${String(turn)}`
}

/**
 * Drop duplicate entries older than the notice window.
 * @param notified - duplicate guard map, timestamped by turn end.
 * @param endedAt - current turn end instant.
 * @param ttlMs - notice window.
 */
function pruneNotified(notified: Map<string, number>, endedAt: number, ttlMs: number): void {
  for (const [key, time] of notified) {
    if (time < endedAt - ttlMs) notified.delete(key)
  }
}

/**
 * Read and prune one task's notice window.
 * @param taskNotices - per-task notice timestamps.
 * @param taskId - task to read.
 * @param endedAt - current turn end instant.
 * @param ttlMs - notice window.
 * @returns the task's notices inside the window, oldest first.
 */
function recentForTask(
  taskNotices: Map<string, number[]>,
  taskId: string,
  endedAt: number,
  ttlMs: number,
): number[] {
  const recent = (taskNotices.get(taskId) ?? []).filter(time => time >= endedAt - ttlMs)
  taskNotices.set(taskId, recent)
  return recent
}

/**
 * Render one notice message.
 * @param task - task the notice reports on.
 * @param sessionId - executor Session.
 * @param turn - finished turn facts.
 * @returns the bounded user-message text; the first line carries the marker.
 */
function noticeText(task: TaskRecord, sessionId: string, turn: FinishedTurn): string {
  const reason = turn.reason.kind
  return [
    `${COMPLETION_NOTICE_MARKER} ${task.taskId} · ${oneLine(task.title, 80)}`,
    `Executor ${sessionId} finished turn ${String(turn.turn)} (${reason}); task status: ${task.status}.`,
    'Read the report with workspace_message.read or workspace_tasks.get; reply with workspace_message.send.',
  ].join('\n')
}
