/**
 * Public capability contract for the dafeiyu organizer: what a provider
 * declares, what the organizer passes back, and what `status()` reports.
 *
 * @module @deepseek-ai/dsh-dafeiyu/types
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

/** Where a v2 provider's own settings page sits in the settings navigation. */
export interface CapabilitySettings {
  /** Settings section the provider owns; the capability list opens it. */
  readonly sectionId: string
  /** Sort order inside the settings navigation. */
  readonly order: number
}

/** What every capability contract version declares. */
interface CapabilityProviderBase {
  /** Stable capability name, for example `memory` or `personality`. */
  readonly id: string
  /** Provider-owned configuration the organizer stores but never interprets. */
  readonly config: unknown
  /**
   * Build this capability's contribution. The organizer calls this once per
   * enabled registration and waits for the returned promise before wiring it.
   * @param runtime - profile context and cancellation for this registration.
   * @returns the contribution to wire and later dispose.
   */
  create(runtime: CapabilityRuntime): CapabilityContribution | Promise<CapabilityContribution>
}

/** Contract version 1: a contribution with no UI metadata. */
export interface CapabilityProviderV1 extends CapabilityProviderBase {
  /** Contract version the provider implements; the organizer accepts `1` and `2`. */
  readonly contractVersion: 1
}

/** Contract version 2: a contribution plus the metadata the capability list renders. */
export interface CapabilityProviderV2 extends CapabilityProviderBase {
  /** Contract version the provider implements; the organizer accepts `1` and `2`. */
  readonly contractVersion: 2
  /** Display name in the capability list. */
  readonly label: string
  /** One sentence describing what the capability does. */
  readonly description: string
  /** Gate value used when the organizer's configuration omits this capability. Defaults to `true`. */
  readonly enabledByDefault?: boolean
  /** The provider's own settings page, when it has one. */
  readonly settings?: CapabilitySettings
}

/** One capability provider registered with the organizer. */
export type CapabilityProvider = CapabilityProviderV1 | CapabilityProviderV2

/** Execution environment of one capability registration. */
export interface CapabilityRuntime {
  /** Profile-level context the provider may use for its own resources. */
  readonly ctx: Context
  /** Aborted when the registration is removed or the organizer unloads. */
  readonly signal: AbortSignal
}

/** What one enabled capability contributes to the composed agents. */
export interface CapabilityContribution {
  /** Which agents receive the contribution; `root` skips child agents. Defaults to `all`. */
  readonly scope?: 'root' | 'all'
  /**
   * Tools to register on one agent's context.
   * @param agent - the agent being wired.
   * @returns the tools to register; registration errors fail this capability only.
   */
  tools?(agent: Agent): readonly ToolDefinition[]
  /**
   * Prompt sections to register on one agent's context.
   * @param agent - the agent being wired.
   * @returns the sections to register; registration errors fail this capability only.
   */
  promptSections?(agent: Agent): readonly PromptSection[]
  /**
   * Receive each agent this capability is wired to, for resources the two
   * registration hooks cannot express.
   * @param agent - the agent being wired.
   */
  onAgentCreated?(agent: Agent): void
  /**
   * Run once for each successfully completed turn.
   * @param input - the agent, session, turn number, event, and registration signal.
   * @returns a promise the organizer awaits before dispatching this session's next turn.
   */
  onTurnEnd?(input: TurnEndInput): Promise<void> | void
  /** Release provider resources once; failures are logged and do not block other capabilities. */
  dispose?(): void
}

/** One completed turn handed to a capability hook. */
export interface TurnEndInput {
  /** Live agent that owns the session. */
  readonly agent: Agent
  /** Session whose turn completed. */
  readonly session: Session
  /** Turn number from the `turn/end` event. */
  readonly turn: number
  /** The committed `turn/end` event. */
  readonly event: SessionEvent<'turn/end'>
  /** Aborted when the registration is removed or the organizer unloads. */
  readonly signal: AbortSignal
}

/** One capability as observed through {@link Dafeiyu.status}. */
export interface CapabilityStatus {
  /** Capability id, registered or only configured. */
  readonly id: string
  /** Whether a provider registered this id. */
  readonly present: boolean
  /** Whether the organizer's enable gate is open. */
  readonly enabled: boolean
  /**
   * Effective state. `missing` means the id is configured without a provider;
   * `disabled` covers both a closed gate and a `create()` that has not settled.
   */
  readonly state: 'active' | 'disabled' | 'missing' | 'failed'
  /** One-line summary of the most recent failure, when the state is `failed`. */
  readonly failure?: string
  /** Timestamp of the last completed turn dispatched to this capability. */
  readonly lastTurnAt?: number
  /** Display name from a v2 descriptor; absent for v1 providers and missing ids. */
  readonly label?: string
  /** One-sentence description from a v2 descriptor. */
  readonly description?: string
  /** The provider's own settings page from a v2 descriptor. */
  readonly settings?: CapabilitySettings
}

/** Per-capability organizer configuration. */
export interface CapabilityConfig {
  /** Whether the organizer creates and wires this capability. Absent means the provider default. */
  enabled?: boolean
}

/** Organizer configuration as written in a profile row. */
export interface Config {
  /** Per-capability switches keyed by capability id; an absent entry means the provider default. */
  capabilities?: Record<string, CapabilityConfig>
}
