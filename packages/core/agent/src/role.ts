/**
 * Resolve one Agent's explicit role.
 *
 * The role is global Agent metadata, not a personality or organizer concern:
 * it comes from `agent.options.role`, an undeclared root is `agent`, and any
 * delegated child is `subagent` from durable lineage. Cwd, workspace titles,
 * preset names, and tool presence never participate.
 * @module @deepseek-ai/dsh-agent/role
 */

import type { Agent } from './types.ts'
import type { AgentRole } from './runtime-types.ts'

/**
 * Resolve one Agent's effective role; child lineage wins over a declared value.
 * @param agent - live Agent carrying the durable header and live options.
 * @returns the effective role.
 */
export function agentRoleOf(agent: Agent): AgentRole {
  const header = agent.session.header
  if (header.origin === 'subagent'
    || header.parentSession !== undefined
    || (header.delegationDepth ?? 0) > 0) return 'subagent'
  const declared = (agent as { options?: { role?: unknown } }).options?.role
  return declared === 'super' || declared === 'subagent' ? declared : 'agent'
}
