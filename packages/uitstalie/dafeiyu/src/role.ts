/**
 * One explicit Agent role and the minimum-role gate for model tools.
 *
 * The role belongs to the Agent, not to an individual capability. It comes
 * from `agent.options.role`; an undeclared root is the least-privileged
 * `agent`, and any delegated child is always `subagent`. No cwd, workspace
 * title, preset name, or tool-presence heuristic participates.
 * @module @deepseek-ai/dsh-dafeiyu/role
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

/** Agent roles, ordered from least to most privileged. */
export type AgentRole = 'subagent' | 'agent' | 'super'

declare module '@deepseek-ai/dsh-agent' {
  interface AgentOptions {
    /** Explicit role; absent means `agent` for a root and `subagent` for a child. */
    readonly role?: AgentRole
  }
}

/** Rank one role for minimum-role comparisons. */
const ROLE_RANK: Readonly<Record<AgentRole, number>> = Object.freeze({
  subagent: 0,
  agent: 1,
  super: 2,
})

/** Resolve one Agent's effective role; child lineage wins over a declared value. */
export function roleOf(agent: Agent): AgentRole {
  const header = agent.session.header
  if (header.origin === 'subagent'
    || header.parentSession !== undefined
    || (header.delegationDepth ?? 0) > 0) return 'subagent'
  const declared = (agent as { options?: { role?: unknown } }).options?.role
  return declared === 'super' || declared === 'subagent' ? declared : 'agent'
}

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
