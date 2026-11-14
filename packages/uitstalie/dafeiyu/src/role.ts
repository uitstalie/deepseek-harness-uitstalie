/**
 * Tool-visibility declarations reserved for the role model.
 *
 * Role ownership lives in `@deepseek-ai/dsh-agent`; this module only defines
 * how a tool declares its future minimum role. The organizer does not filter
 * with these helpers yet.
 * @module @deepseek-ai/dsh-dafeiyu/role
 */

import type { AgentRole } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

/** Rank one role for minimum-role comparisons. */
const ROLE_RANK: Readonly<Record<AgentRole, number>> = Object.freeze({
  subagent: 0,
  agent: 1,
  super: 2,
})

/** Whether a role satisfies a tool's declared minimum. */
export function roleAllows(role: AgentRole, minimum: AgentRole = 'subagent'): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum]
}

/** Attach a minimum role to one tool definition without changing its schema or execute path. */
export function withMinRole<const T extends ToolDefinition>(tool: T, minimum: AgentRole): T & { readonly minRole: AgentRole } {
  return { ...tool, minRole: minimum }
}

/** Read one tool's declared minimum role; an undeclared tool is available to every agent. */
export function toolMinRole(tool: ToolDefinition): AgentRole | undefined {
  const minimum = (tool as { minRole?: unknown }).minRole
  return minimum === 'subagent' || minimum === 'agent' || minimum === 'super' ? minimum : undefined
}
