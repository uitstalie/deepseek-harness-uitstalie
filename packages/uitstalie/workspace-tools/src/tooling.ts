/**
 * Shared helpers of the workspace toolset's model-facing tools.
 * @module @deepseek-ai/dsh-workspace-tools/tooling
 */

import type { Session } from '@deepseek-ai/dsh-session'
import { ToolContextUnavailableError } from '@deepseek-ai/dsh-tools'

/**
 * Require the calling agent's session, which scopes every tool in this package.
 * @param session - the calling agent's session, when one is attached.
 * @param tool - tool name used in the failure message.
 * @returns the calling session.
 * @throws ToolContextUnavailableError when the call has no owning agent session.
 */
export function requireCallerSession(session: Session | undefined, tool: string): Session {
  if (session === undefined) throw new ToolContextUnavailableError(`${tool} requires an owning agent session`)
  return session
}

/**
 * Collapse whitespace and bound one line of text for a summary.
 * @param text - source text.
 * @param max - maximum characters kept, ellipsis included.
 * @returns the collapsed line.
 */
export function oneLine(text: string, max: number): string {
  const collapsed = text.replace(/\s+/gu, ' ').trim()
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, Math.max(max - 1, 0))}…`
}
