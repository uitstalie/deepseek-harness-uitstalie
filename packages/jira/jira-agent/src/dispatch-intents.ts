/**
 * The dispatch entry's contract with the workspace toolset's intent cards.
 *
 * A dispatch is not a message: it is a task record in the target workspace,
 * created against an active intent card version and a coverage map, and then
 * executed by a Session. This module is the one place that calls
 * `ctx.workspaceTasks.createDispatchTask`, so the super agent's control tool
 * cannot start work that `workspace_tasks.create` would have refused.
 *
 * The service belongs to `@deepseek-ai/dsh-workspace-tools`. It is reached
 * through the context rather than imported: that package is a capability
 * provider, and this package must still load (and refuse dispatch with a clear
 * message) in a composition that does not mount it.
 * @module @deepseek-ai/dsh-jira-agent/dispatch-intents
 */

import { invalidInput, type JiraError } from '@deepseek-ai/dsh-jira-core'
import type { Session } from '@deepseek-ai/dsh-session'

/** One card point mapped to the task-brief item that covers it. */
export interface DispatchCoverage {
  /** Card point, such as `acceptance[0]`. */
  readonly point: string
  /** Exact text of the task-brief item that covers the point. */
  readonly brief: string
  /** Optional note on how the brief item covers the point. */
  readonly note?: string
}

/** One card point the dispatch explicitly leaves uncovered. */
export interface DispatchNonCoverage {
  /** Card point, such as `outputForm[0]`. */
  readonly point: string
  /** Why the task does not cover the point. */
  readonly reason: string
}

/** The six task types the workspace toolset accepts; the closed list from the design. */
export const DISPATCH_TASK_TYPES = [
  'analysis-diagnosis',
  'fix',
  'test-verification',
  'migration-deployment',
  'design-document',
  'other',
] as const

/** One task type the workspace toolset accepts. */
export type DispatchTaskType = (typeof DISPATCH_TASK_TYPES)[number]

/** The part of `ctx.workspaceTasks` the dispatch path calls. */
export interface WorkspaceTasksBridge {
  /**
   * Create the task record for one dispatch against an active card version.
   * @param input - the workspace, card reference, brief, coverage, and idempotency key.
   * @param signal - cancellation for the store reads and writes.
   * @returns the created or replayed task identity.
   */
  createDispatchTask(input: {
    readonly workspaceId: string
    readonly goal: string
    readonly title?: string
    readonly acceptance: readonly string[]
    readonly boundaries: readonly string[]
    readonly outputForm?: readonly string[]
    readonly intentId: string
    readonly intentVersion: number
    readonly coverage?: readonly DispatchCoverage[]
    readonly nonCoverage?: readonly DispatchNonCoverage[]
    readonly taskType: DispatchTaskType
    readonly requestId: string
  }, signal?: AbortSignal, session?: Session): Promise<{
    readonly workspace: string
    readonly taskId: string
    readonly status: string
    readonly createdAt?: string
    readonly replayed?: boolean
  }>
  /**
   * Cancel a dispatch task whose Session never started.
   * @param input - the workspace, task, and reason.
   * @param signal - cancellation for the store operations.
   * @returns whether the task moved to `cancelled`.
   */
  cancelDispatchTask(input: {
    readonly workspaceId: string
    readonly taskId: string
    readonly reason: string
  }, signal?: AbortSignal, session?: Session): Promise<boolean>
}

/**
 * Resolve the workspace toolset's dispatch-task service.
 * @param ctx - the plugin context the tool runs against.
 * @returns the service, or undefined when this composition does not mount the workspace toolset.
 */
export const workspaceTasksOf = (ctx: unknown): WorkspaceTasksBridge | undefined => {
  const get = (ctx as { get?: (key: string) => unknown } | undefined)?.get
  if (typeof get !== 'function') return undefined
  const service = get.call(ctx, 'workspaceTasks') as Partial<WorkspaceTasksBridge> | undefined
  return typeof service?.createDispatchTask === 'function' && typeof service.cancelDispatchTask === 'function'
    ? service as WorkspaceTasksBridge
    : undefined
}

/** One dispatch the start action is about to record. */
export interface StartDispatchInput {
  /** Workspace the Session runs in and the task belongs to. */
  readonly workspaceId: string
  /** Idempotency key of the task, shared with the prompt request when one exists. */
  readonly requestId: string
  /** The brief sent to the Session; it becomes the task goal. */
  readonly goal: string
  /** Durable Session purpose title, when one was given. */
  readonly title?: string
  /** Active card the task references; missing means `INTENT_INCOMPLETE`. */
  readonly intentId?: string
  /** Card version the task references; missing means `INTENT_INCOMPLETE`. */
  readonly intentVersion?: number
  /** The brief's acceptance items. */
  readonly acceptance?: readonly string[]
  /** The brief's boundaries. */
  readonly boundaries?: readonly string[]
  /** The brief's deliverable items. */
  readonly outputForm?: readonly string[]
  /** One mapping per card point. */
  readonly coverage?: readonly DispatchCoverage[]
  /** Explicit non-coverage for a card point. */
  readonly nonCoverage?: readonly DispatchNonCoverage[]
  /** The six-category task type. */
  readonly taskType?: string
}

/** Outcome of recording one dispatch task. */
export type StartDispatchOutcome =
  | { readonly ok: true; readonly taskId: string }
  | { readonly ok: false; readonly error: JiraError }

/** The failure code carried in context when the workspace toolset is not composed. */
export const WORKSPACE_TASKS_UNAVAILABLE = 'WORKSPACE_TASKS_UNAVAILABLE'

/**
 * Build the refusal for a dispatch the intent-card rules rejected.
 *
 * The workspace toolset's codes are the actionable contract, so they travel in
 * the message and in `context.intentCode`; the ledger's own `code` stays
 * `INVALID_INPUT` because the twelve ledger codes are a closed wire vocabulary.
 * @param error - the thrown workspace-toolset error.
 * @param input - the dispatch that was refused, for context.
 * @returns the typed refusal.
 */
const dispatchRefusal = (error: unknown, input: StartDispatchInput): JiraError => {
  const code = typeof (error as { code?: unknown } | undefined)?.code === 'string'
    ? (error as { code: string }).code
    : 'INTENT_INVALID'
  const message = error instanceof Error ? error.message : String(error)
  return invalidInput(`${code}: ${message}`, {
    intentCode: code,
    workspace: input.workspaceId,
    ...(input.intentId === undefined ? {} : { intentId: input.intentId }),
    ...(input.intentVersion === undefined ? {} : { intentVersion: input.intentVersion }),
  })
}

/**
 * Record the dispatch task before any Session is started or prompted.
 *
 * A missing card reference or version refuses with `INTENT_INCOMPLETE` before
 * the service is called; every other card, coverage, and field refusal comes
 * from the same code the `workspace_tasks.create` tool runs.
 * @param ctx - the plugin context carrying `workspaceTasks`, when composed.
 * @param input - the dispatch the start action is about to perform.
 * @param signal - cancellation for the store reads and writes.
 * @param session - calling session, whose sandbox mode gates the record write.
 * @returns the task id, or the refusal that blocked the dispatch.
 */
export const startDispatchTask = async (
  ctx: unknown,
  input: StartDispatchInput,
  signal?: AbortSignal,
  session?: Session,
): Promise<StartDispatchOutcome> => {
  if (input.intentId === undefined || input.intentId.trim() === ''
    || input.intentVersion === undefined || !Number.isInteger(input.intentVersion) || input.intentVersion < 1) {
    return {
      ok: false,
      error: invalidInput(
        'INTENT_INCOMPLETE: a dispatch needs the active intent card: read it with `workspace_intents` and pass `intentId` and `intentVersion`',
        {
          intentCode: 'INTENT_INCOMPLETE',
          workspace: input.workspaceId,
          ...(input.intentId === undefined ? {} : { intentId: input.intentId }),
        },
      ),
    }
  }
  const service = workspaceTasksOf(ctx)
  if (service === undefined) {
    return {
      ok: false,
      error: invalidInput(`${WORKSPACE_TASKS_UNAVAILABLE}: this composition does not mount the workspace toolset, so no intent card can be checked and no task can be recorded; mount @deepseek-ai/dsh-workspace-tools`, {
        code: WORKSPACE_TASKS_UNAVAILABLE,
        workspace: input.workspaceId,
      }),
    }
  }
  const taskType = input.taskType
  if (taskType === undefined || !(DISPATCH_TASK_TYPES as readonly string[]).includes(taskType)) {
    return {
      ok: false,
      error: invalidInput(`INTENT_INCOMPLETE: workspace_tasks.create requires taskType (one of ${DISPATCH_TASK_TYPES.join(', ')})`, {
        intentCode: 'INTENT_INCOMPLETE',
        workspace: input.workspaceId,
      }),
    }
  }
  try {
    const created = await service.createDispatchTask({
      workspaceId: input.workspaceId,
      goal: input.goal,
      requestId: input.requestId,
      acceptance: input.acceptance ?? [],
      boundaries: input.boundaries ?? [],
      intentId: input.intentId,
      intentVersion: input.intentVersion,
      taskType: taskType as DispatchTaskType,
      ...input.title === undefined ? {} : { title: input.title },
      ...input.outputForm === undefined ? {} : { outputForm: input.outputForm },
      ...input.coverage === undefined ? {} : { coverage: input.coverage },
      ...input.nonCoverage === undefined ? {} : { nonCoverage: input.nonCoverage },
    }, signal, session)
    return { ok: true, taskId: created.taskId }
  } catch (error: unknown) {
    return { ok: false, error: dispatchRefusal(error, input) }
  }
}

/**
 * Cancel the task a refused dispatch left behind; best effort, never masking the
 * refusal that caused it.
 * @param ctx - the plugin context carrying `workspaceTasks`, when composed.
 * @param input - the workspace, task, and reason.
 * @param signal - cancellation for the store operations.
 * @param session - calling session, whose sandbox mode gates the record write.
 */
export const cancelDispatchedTask = async (
  ctx: unknown,
  input: { readonly workspaceId: string; readonly taskId: string; readonly reason: string },
  signal?: AbortSignal,
  session?: Session,
): Promise<void> => {
  const service = workspaceTasksOf(ctx)
  if (service === undefined) return
  try {
    await service.cancelDispatchTask(input, signal, session)
  } catch {
    // The dispatch already failed; a cancelled record is bookkeeping, not the answer.
  }
}
