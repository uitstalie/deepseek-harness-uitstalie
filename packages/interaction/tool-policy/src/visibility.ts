/**
 * Per-agent tool visibility: a restricted agent does not see the denied tools
 * in its model schema or PTC SDK. This is the cosmetic half of tool denial —
 * the monotonic guard in `guard.ts` is the enforcement.
 *
 * `run_code` is deliberately never passed to `tools.restrict()`: the registry
 * reserves the PTC transport and refuses to restrict it, so the guard owns that
 * denial. A profile change lifts the previous mask and applies the new one.
 *
 * @module @deepseek-ai/dsh-tool-policy/visibility
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import type { PreparedProfile } from './types.ts'
import type { ToolPolicyService } from './index.ts'

/** One agent's applied restriction. */
interface AppliedVisibility {
  /** Names hidden from the agent. */
  readonly deny: readonly string[]
  /** The restriction disposer. */
  readonly dispose: () => void
}

/**
 * Tool names from `profile` that the registry can actually restrict.
 * Unknown/optional tools are ignored; `run_code` stays with the guard.
 * @param profile - the profile in force.
 * @param known - global tool names currently registered.
 * @returns the exact deny list for `ctx.tools.restrict()`.
 */
export function restrictableDeny(profile: PreparedProfile, known: ReadonlySet<string>): string[] {
  return profile.tools
    .map(rule => rule.name)
    .filter(name => name !== 'run_code' && known.has(name))
}

/**
 * Apply (or lift) one agent's visibility for its current profile.
 * Exported for unit tests with a fabricated agent.
 * @param service - the policy service.
 * @param agent - the agent whose scoped `ctx.tools` receives the restriction.
 * @param known - global tool names currently registered.
 * @returns the deny list and restriction disposer, or undefined when nothing is hidden.
 */
export function applyVisibilityForAgent(
  service: ToolPolicyService,
  agent: Agent,
  known: ReadonlySet<string>,
): { deny: readonly string[]; dispose: () => void } | undefined {
  const profile = service.profileForAgent(agent)
  const deny = restrictableDeny(profile, known)
  if (deny.length === 0) return undefined
  return { deny, dispose: agent.ctx.tools.restrict({ deny }) }
}

/**
 * Install the agent-created/profile-change visibility lifecycle.
 * @param ctx - plugin context with optional `agents`/`tools` children.
 * @param service - the policy service.
 * @returns the full lifecycle disposer.
 */
export function installVisibility(ctx: Context, service: ToolPolicyService): () => void {
  const agents = ctx.get('agents')
  if (agents === undefined) return () => {}
  const applied = new Map<string, AppliedVisibility>()

  const lift = (agentId: string): void => {
    const current = applied.get(agentId)
    if (current === undefined) return
    applied.delete(agentId)
    current.dispose()
  }

  const apply = (agent: Agent): void => {
    lift(agent.id)
    if (!ctx.get('tools')) return
    try {
      const known = new Set(ctx.tools.schemas().map(schema => schema.name))
      const next = applyVisibilityForAgent(service, agent, known)
      if (next === undefined) return
      applied.set(agent.id, next)
    } catch (error: unknown) {
      // Visibility is cosmetic; the guard still enforces. Never take the tool
      // surface down because a mask could not be applied.
      ctx.logger.warn(`tool-policy: could not apply tool visibility: ${String(error)}`)
    }
  }

  for (const agent of agents.list()) apply(agent)
  ctx.on('agent/created', ({ agent }) => { apply(agent) })
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'permission/preset') return
    for (const agent of agents.list()) {
      if (agent.session.id === session.id) apply(agent)
    }
  }, { global: true })

  return () => {
    for (const agentId of [...applied.keys()]) lift(agentId)
  }
}
