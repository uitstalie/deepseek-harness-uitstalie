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

/**
 * Whether a role satisfies a tool's declared minimum.
 * @param role - the calling Agent's effective role.
 * @param minimum - the declaration's minimum; omitted means `subagent`.
 * @returns whether the role is at least the minimum.
 */
export function roleAllows(role: AgentRole, minimum: AgentRole = 'subagent'): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum]
}

/**
 * Attach a minimum role to one tool definition without changing its schema or execute path.
 * @param tool - the complete tool definition.
 * @param minimum - minimum role allowed to see and call it.
 * @returns the same definition shape with the exact `minRole` marker.
 */
export function withMinRole<const T extends ToolDefinition>(
  tool: T,
  minimum: AgentRole,
): T & { readonly minRole: AgentRole } {
  return { ...tool, minRole: minimum }
}

/**
 * Read one tool's declared minimum role.
 * @param tool - the registered or candidate definition.
 * @returns the valid declaration, or undefined when the tool has no role gate.
 */
export function toolMinRole(tool: ToolDefinition): AgentRole | undefined {
  const minimum = (tool as { minRole?: unknown }).minRole
  return minimum === 'subagent' || minimum === 'agent' || minimum === 'super' ? minimum : undefined
}
