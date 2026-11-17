/**
 * The dispatch-task service the workspace toolset provides as `ctx.workspaceTasks`.
 *
 * The model-facing `workspace_tasks` tool is the surface an agent calls; the
 * super agent's dispatch tool is the one other caller, and it must record the
 * same card-validated task. Exposing the creation and cancellation rules as a
 * service keeps one implementation of the card, coverage, and idempotency
 * checks instead of a second copy in the dispatch path.
 *
 * The service is not a model surface and carries no role check of its own: the
 * `workspace_tasks.create` tool enforces the dispatcher role, and only the
 * dispatcher tool calls this service. A caller that is not the super agent must
 * not reach it.
 * @module @deepseek-ai/dsh-workspace-tools/service
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { cancelDispatchTask, createDispatchTask } from './tasks.ts'
import type { DispatchTaskIdentity, DispatchTaskInput } from './tasks.ts'

/** Cancellation of one dispatch task whose Session never started. */
export interface CancelDispatchTaskInput {
  /** Workspace that owns the task. */
  readonly workspaceId: string
  /** Stable task id returned by {@link WorkspaceTasksService.createDispatchTask}. */
  readonly taskId: string
  /** Why the dispatch did not start; recorded on the cancelled task. */
  readonly reason: string
}

/** The dispatcher-only task path, provided as `ctx.workspaceTasks`. */
export interface WorkspaceTasksService {
  /**
   * Create the task record for one dispatch, against an active card version.
   * @param input - the workspace, card reference, brief, coverage, and idempotency key.
   * @param signal - cancellation for the store reads and writes.
   * @param session - calling session, whose sandbox mode gates the record write.
   * @returns the created or replayed task identity.
   * @throws WorkspaceIntentError when the card, coverage, or required fields refuse.
   */
  createDispatchTask(input: DispatchTaskInput, signal?: AbortSignal, session?: Session): Promise<DispatchTaskIdentity>
  /**
   * Cancel a dispatch task whose Session never started; a terminal task is left unchanged.
   * @param input - the workspace, task, and reason recorded on the task.
   * @param signal - cancellation for the store reads and writes.
   * @param session - calling session, whose sandbox mode gates the record write.
   * @returns whether the task moved to `cancelled`.
   */
  cancelDispatchTask(input: CancelDispatchTaskInput, signal?: AbortSignal, session?: Session): Promise<boolean>
}

declare module '@deepseek-ai/cordis' {
  /** The dispatch-task path provided by the workspace toolset. */
  interface Context {
    workspaceTasks: WorkspaceTasksService
  }
}

/**
 * Build the dispatch-task service over this plugin's context.
 * @param ctx - context carrying the `.dsh` store and the workspace registry.
 * @returns the service value registered as `ctx.workspaceTasks`.
 */
export function createWorkspaceTasksService(ctx: Context): WorkspaceTasksService {
  return Object.freeze({
    createDispatchTask: async (input: DispatchTaskInput, signal?: AbortSignal, session?: Session): Promise<DispatchTaskIdentity> =>
      await createDispatchTask(ctx, input, {
        dispatcher: true,
        ...session === undefined ? {} : { session },
        ...signal === undefined ? {} : { signal },
      }),
    cancelDispatchTask: async (input: CancelDispatchTaskInput, signal?: AbortSignal, session?: Session): Promise<boolean> =>
      await cancelDispatchTask(ctx, input, signal, session),
  })
}
