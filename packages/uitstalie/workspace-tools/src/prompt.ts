/**
 * The static workspace directory the workspace toolset contributes to every
 * agent's system prompt.
 *
 * It lists registry identity only: title, id, and directory. No status, no
 * memory, and no task data appears, so the text is the same on every request
 * and the prompt prefix stays cacheable. The same list is registered for every
 * agent, ordinary or super: a query still has to name a workspace explicitly to
 * leave the caller's own scope.
 * @module @deepseek-ai/dsh-workspace-tools/prompt
 */

import type { Context } from '@deepseek-ai/cordis'

/** Registry name of the workspace directory section. */
export const WORKSPACE_DIRECTORY_SECTION_NAME = 'workspace-directory'

/** Section order: before the role-specific super-agent instructions (702). */
export const WORKSPACE_DIRECTORY_SECTION_ORDER = 700

/** Registry name of the workspace-request routing section. */
export const WORKSPACE_ROUTING_SECTION_NAME = 'workspace-routing'

/** Section order: right after the workspace directory. */
export const WORKSPACE_ROUTING_SECTION_ORDER = 701

/** Opening line that names the list's authority and the subdirectory rule. */
export const WORKSPACE_DIRECTORY_TITLE = 'Registered workspaces (the only workspaces; a subdirectory is not a workspace).'

/**
 * Render the registered workspace directory.
 *
 * Sorted by id so the text is stable across registry iteration order. A title
 * equal to the directory's basename is still written once as the title; the
 * line format is `- <title> (<id>) · <directory>`.
 * @param ctx - context that may carry the workspace registry.
 * @returns the section text, or `''` when no registry or no workspace is mounted.
 */
export function workspaceDirectoryText(ctx: Context): string {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) return ''
  const rows = [...registry.list()].sort((left, right) => {
    const a = String(left.id)
    const b = String(right.id)
    return a < b ? -1 : a > b ? 1 : 0
  })
  if (rows.length === 0) return ''
  return `${WORKSPACE_DIRECTORY_TITLE}\n`
    + rows.map(workspace => `- ${workspace.title} (${String(workspace.id)}) · ${workspace.path}`).join('\n')
}

/**
 * Render the workspace-request routing rules.
 *
 * Static text: no session or task data, so the prompt prefix stays cacheable.
 * It names only the rules an agent cannot infer from a tool schema: how to read
 * a sender header, how a dispatched Session routes a question, how many
 * replies a request gets, and the reuse/compact order before dispatch.
 * @returns the section text.
 */
export function workspaceRoutingText(): string {
  return [
    'Workspace requests and dispatch:',
    '- A request from another agent starts with a `[workspace_message]` or `[workspace_session]` header naming the sender, its role, and the Session to reply to. Reply to that Session with `workspace_message.send`; a task-bound header also names the task.',
    '- Do not call `ask_user_question` or `ask_user_question_plus` for a decision inside a request that came from another agent. Send the question to the super agent, the dispatcher named in the header, with `workspace_message.send`; the super agent is the only party that talks to the person and relays the question. The super agent itself always reaches the person.',
    '- Reply at most once per request: conclusion, evidence, next step. Do not keep the thread going just to reply.',
    '- Dispatch reuses a Session before it starts one: read `workspace_sessions.list`/`get`, then call `workspace_sessions.run`, which continues the existing Session and starts a new one only when the workspace has none. When the person explicitly asks for a new or isolated conversation, call `run` with `new_session: true`; do not reuse their Session then. Before dispatching, `compact` a target whose `contextUsage.percent` is high so the executor receives the task with room to work.',
  ].join('\n')
}
