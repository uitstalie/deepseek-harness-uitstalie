/**
 * Tool-side role declarations.
 *
 * The role vocabulary belongs to `@deepseek-ai/dsh-agent`; this module owns the
 * pure minimum-role comparison and the declaration helper, so a feature package
 * can declare a tool gate by importing only the tool package. It does not
 * register, filter, or execute anything.
 * @module @deepseek-ai/dsh-tools/role
 */

import type { AgentRole } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition } from './contracts.ts'

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
export function withMinRole<const T extends ToolDefinition>(
  tool: T,
  minimum: AgentRole,
): T & { readonly minRole: AgentRole } {
  return { ...tool, minRole: minimum }
}

/** Read one tool's declared minimum role; an undeclared tool is available to every agent. */
export function toolMinRole(tool: ToolDefinition): AgentRole | undefined {
  const minimum = (tool as { minRole?: unknown }).minRole
  return minimum === 'subagent' || minimum === 'agent' || minimum === 'super' ? minimum : undefined
}
