/**
 * Explicit personality role for one Agent.
 *
 * The role is supplied by session/agent configuration as
 * `agentOptions.personalityRole`; it is never inferred from cwd, a workspace
 * title, or which tools happen to be registered. A delegated child always
 * resolves to `subagent`, and an undeclared root resolves to `root` (the safe,
 * non-super side).
 * @module @deepseek-ai/dsh-personality/role
 */

import type { Agent } from '@deepseek-ai/dsh-agent'

/** The three personality consumers. */
export type PersonalityRole = 'subagent' | 'root' | 'super'

declare module '@deepseek-ai/dsh-agent' {
  interface AgentOptions {
    /** Explicit role; absent means root for a root Session and subagent for a child. */
    readonly personalityRole?: PersonalityRole
  }
}

/**
 * Resolve one Agent's role. Child lineage wins over any declared value, so a
 * child cannot promote itself; an absent or invalid root value stays `root`.
 * @param agent - live Agent carrying the durable header and live options.
 * @returns the effective personality role.
 */
export function agentRole(agent: Agent): PersonalityRole {
  const header = agent.session.header
  if (header.origin === 'subagent'
    || header.parentSession !== undefined
    || (header.delegationDepth ?? 0) > 0) return 'subagent'
  const declared = (agent as { options?: { personalityRole?: unknown } }).options?.personalityRole
  return declared === 'super' || declared === 'subagent' ? declared : 'root'
}
