/**
 * The always-on agent-context seam.
 *
 * This is one aspect of agent context, not a general injection layer: sources
 * registered here render text that joins the native instruction baseline
 * (workspace rules today; memory and personality later). Skills are not routed
 * here — they keep their own injection through the skill seam.
 * @module @deepseek-ai/dsh-agent-instructions-plus/sources
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { FileSystem } from '@deepseek-ai/dsh-fs'

/** Everything one source may read while rendering its contribution. */
export interface AgentContextInput {
  /** The agent whose step is being prepared. */
  agent: Agent
  /** Provider used for reads under the project. */
  fileSystem: FileSystem
  /** Project root the current session works in. */
  projectRoot: string
  /** Cancellation for the current step. */
  signal: AbortSignal
}

/** One source's rendered contribution. */
export interface AgentContextContribution {
  /** Text appended to the baseline message; empty when the source retains nothing. */
  text: string
  /** Change-detection digest over the source's retained set. */
  digest: string
}

/** A registered always-on context source. */
export interface AgentContextSource {
  /** Stable source name, unique within one registry. */
  readonly name: string
  /**
   * Render this source for one agent step.
   * @param input - agent, filesystem, project root, and cancellation.
   * @returns the contribution, or undefined when the source does not apply.
   */
  render(input: AgentContextInput): Promise<AgentContextContribution | undefined>
}

/** The source registry provided as `ctx.agentContextSources`. */
export interface AgentContextSources {
  /**
   * Register one source.
   * @param source - the source to register.
   * @returns the disposer removing it.
   */
  register(source: AgentContextSource): () => void
  /**
   * List the registered sources in registration order.
   * @returns a detached list.
   */
  list(): readonly AgentContextSource[]
}

declare module '@deepseek-ai/cordis' {
  /** The always-on agent-context source registry. */
  interface Context {
    agentContextSources: AgentContextSources
  }
}

/**
 * Create an empty source registry.
 * @returns a registry whose registrations are plain array entries.
 */
export function createAgentContextSources(): AgentContextSources {
  const sources: AgentContextSource[] = []
  return {
    register(source) {
      sources.push(source)
      return () => {
        const index = sources.indexOf(source)
        if (index >= 0) sources.splice(index, 1)
      }
    },
    list() {
      return [...sources]
    },
  }
}
