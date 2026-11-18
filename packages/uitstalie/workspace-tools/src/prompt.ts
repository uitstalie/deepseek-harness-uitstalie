/**
 * The static prompt sections the workspace toolset contributes.
 *
 * The workspace directory lists registry identity only — title, id, and
 * directory — so every agent sees the same cacheable list. The dispatch
 * section is the super agent's own: it states the order (read the card, build
 * the task and its coverage list, then start the Session) and how results are
 * reported. An ordinary agent never receives it.
 * @module @deepseek-ai/dsh-workspace-tools/prompt
 */

import type { Context } from '@deepseek-ai/cordis'

/** Registry name of the workspace directory section. */
export const WORKSPACE_DIRECTORY_SECTION_NAME = 'workspace-directory'

/** Section order: before the role-specific super-agent instructions (702). */
export const WORKSPACE_DIRECTORY_SECTION_ORDER = 700

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

/** Registry name of the super agent's dispatch section. */
export const WORKSPACE_DISPATCH_SECTION_NAME = 'workspace-dispatch'

/** Section order: one step after the workspace directory, before the branch's later sections. */
export const WORKSPACE_DISPATCH_SECTION_ORDER = 702

/**
 * The super agent's dispatch instructions.
 *
 * Static and short: the constraints themselves live in the tool schema and the
 * card/coverage checks, so this section only fixes the order and the reporting
 * path. Inserted text is stable across requests so the prompt prefix stays
 * cacheable.
 */
export const WORKSPACE_DISPATCH_TEXT = 'You dispatch work to workspace Sessions. The order is fixed:\n'
  + '1. Read the intent card with `workspace_intents` (`get`; use `history` when it changed). A `proposed` '
  + 'version needs the person\'s confirmation with `confirm` before dispatch; a version that is not the latest '
  + 'active one is stale, so re-read it.\n'
  + '2. Build the task brief and its coverage list. Every card point gets one `coverage` entry naming the brief '
  + 'item that covers it, or an explicit `nonCoverage` reason; there is no default pass.\n'
  + '3. Dispatch with `workspace_sessions` `start`: `workspace`, `title`, `task`, `intentId`, `intentVersion`, '
  + '`acceptance`, `boundaries`, `taskType`, and the `coverage` list (or `nonCoverage`). The task record is '
  + 'created before the Session is prompted; when the task already exists, pass its `taskId` instead.\n'
  + '4. Continue work with `append` or `prompt` and, when one applies, the task\'s `taskId`.\n'
  + '5. The executor\'s turn end reports back without polling: it delivers one `[task-report]` to this Session '
  + '(task id, executor session, state, conclusion and evidence pointers) and appends an automatic receipt '
  + 'that moves the task to `waiting_review`, or to `blocked` when the turn failed. Only that task-bound report '
  + 'may cross workspaces; an executor\'s ordinary `workspace_message` sends outside its workspace stay '
  + 'refused.\n'
  + 'Report with `workspace_tasks` `receipt`: check every card point with evidence, then move the task with '
  + '`update`. A receipt with a `not_satisfied` acceptance item or a `violated` boundary cannot be `done`; it '
  + 'lands in `waiting_review` or `blocked`. Tell the person what was sent where and what is still owed; do '
  + 'not paste the whole report.'
