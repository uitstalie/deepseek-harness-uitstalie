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
