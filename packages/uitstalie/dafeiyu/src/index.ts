/**
 * dafeiyu: the host-side capability organizer. It owns the capability
 * registry, the enable gate, per-agent contribution wiring, turn-end
 * dispatch, failure isolation, and disposal; providers only declare what they
 * contribute.
 *
 * The organizer is a composition-level service: it provides `ctx.dafeiyu`,
 * mounts the read-only `remote.dafeiyu` status face, and has no model surface
 * of its own. Capability tools and prompt sections reach agents through each
 * provider's contribution, so a provider never subscribes to lifecycle events
 * or assembles a store path by itself.
 *
 * The enable gate is a volatile configuration reference: a settings write to
 * `capabilities.<id>.enabled` swaps the snapshot and the organizer disposes or
 * rebuilds that capability without remounting any plugin row.
 *
 * @module @deepseek-ai/dsh-dafeiyu
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { Session, SessionId, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-app-boot'
import z from '@deepseek-ai/schemastery'
import type {
  CapabilityConfig,
  CapabilityContribution,
  CapabilityProvider,
  CapabilityProviderV2,
  CapabilityRuntime,
  CapabilityStatus,
  TurnEndInput,
} from './types.ts'
import DafeiyuRemote from './remote.ts'

export type {
  CapabilityConfig,
  CapabilityContribution,
  CapabilityProvider,
  CapabilityProviderV1,
  CapabilityProviderV2,
  CapabilityRuntime,
  CapabilitySettings,
  CapabilityStatus,
  Config,
  TurnEndInput,
} from './types.ts'
export { default as DafeiyuRemote } from './remote.ts'

/**
 * The organizer's row schema. `capabilities` is a volatile reference: a
 * settings write swaps the snapshot and emits `loader/volatile-update`, so the
 * service re-reads the gate instead of remounting the row.
 */
export const ConfigSchema = z.object({
  capabilities: z.dict(z.object({
    enabled: z.boolean().default(true),
  })).default({}).volatile(),
})

/** Resolved organizer configuration: `capabilities` is the live reference. */
export type ResolvedConfig = ReturnType<typeof ConfigSchema>

/** Capability contract versions this organizer understands. */
const CONTRACT_VERSIONS: readonly number[] = [1, 2]

/** Upper bound of one failure summary reported through `status()`. */
const FAILURE_SUMMARY_MAX_LENGTH = 240

/** Internal lifecycle state of one registration; `activating` has no public status value. */
type RegistrationState = 'activating' | 'active' | 'disabled' | 'failed'

/** Everything the organizer retains for one registered provider. */
interface Registration {
  readonly provider: CapabilityProvider
  /** Resolved enable gate, re-read on every volatile configuration update. */
  enabled: boolean
  /** Cancels the provider's `create()` and every hook it contributes. */
  controller: AbortController
  /** Resolves after `create()` settles, fails, or the registration is removed. */
  ready: Promise<void>
  settleReady: () => void
  contribution: CapabilityContribution | undefined
  state: RegistrationState
  failure: string | undefined
  lastTurnAt: number | undefined
  /** Per-agent disposers for the tools and prompt sections this registration added. */
  readonly registrations: Map<Agent, readonly (() => void)[]>
  /** Set when the registration was removed or the organizer is unloading. */
  retired: boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host-side capability organizer for memory, personality, and future providers. */
    dafeiyu: Dafeiyu
  }
}

/**
 * Host-side capability organizer.
 *
 * Providers register a {@link CapabilityProvider}; the organizer owns the
 * enable gate, calls `create()` once for an enabled registration, wires the
 * contribution onto each matching agent, dispatches completed turns serially
 * per session, and records failures without stopping other capabilities.
 */
export class Dafeiyu extends Service {
  static Config = ConfigSchema

  private readonly config: ResolvedConfig
  private readonly registrations = new Map<string, Registration>()
  private readonly turnChains = new Map<SessionId, Promise<void>>()
  private readonly warnedMissing = new Set<string>()
  private disposed = false

  /**
   * @param ctx - plugin context; `agents` is optional because the registry can be mounted before an agent service exists.
   * @param config - per-capability enable switches and their live reference.
   */
  constructor(ctx: Context, config: ResolvedConfig) {
    super(ctx, 'dafeiyu')
    this.config = config
    ctx.on('agent/created', ({ agent }) => this.admitAgent(agent).then(() => undefined))
    ctx.on('agent/disposed', ({ agent }) => { this.forgetAgent(agent) })
    ctx.on('session/event', (session, event) => { this.observeSession(session, event) })
    ctx.on('loader/volatile-update', () => { this.reconcileGates() })
    ctx.on('app-boot/config-reload', () => { this.reloadRegistrations() })
    ctx.effect(() => () => { this.shutdown() }, 'dafeiyu.shutdown()')
    void ctx.plugin(DafeiyuRemote)
  }

  /**
   * Register one capability provider.
   *
   * `create()` runs immediately when the enable gate is open; a duplicate id,
   * an unsupported contract version, or an invalid v2 descriptor is rejected
   * with an error naming the id.
   * @param provider - the capability declaration to register.
   * @returns the disposer that removes the registration and its contributions.
   * @throws Error when the service is disposed, the id is already registered,
   *   `contractVersion` is neither `1` nor `2`, or a v2 descriptor lacks its
   *   list metadata.
   */
  register(provider: CapabilityProvider): () => void {
    if (this.disposed) throw new Error('dafeiyu: cannot register a capability after the organizer unloaded')
    const version: number = provider.contractVersion
    if (!CONTRACT_VERSIONS.includes(version)) {
      throw new Error(
        `dafeiyu: capability "${provider.id}" declares contractVersion ${version}; expected ${CONTRACT_VERSIONS.join(' or ')}`,
      )
    }
    assertDescriptor(provider)
    if (this.registrations.has(provider.id)) {
      throw new Error(`dafeiyu: capability "${provider.id}" is already registered`)
    }
    const registration = this.createRegistration(provider)
    this.registrations.set(provider.id, registration)
    return () => { this.unregister(provider.id, registration) }
  }

  /**
   * Read the current capability snapshot. Never reads disk and never calls
   * `create()` again; a configured id without a provider is reported as
   * `missing`, and a still-settling registration as `disabled`.
   * @returns one status record per registered provider, followed by configured ids that have no provider.
   */
  status(): readonly CapabilityStatus[] {
    const statuses = [...this.registrations.values()].map(registration => statusOf(registration))
    for (const [id, config] of Object.entries(this.gates())) {
      if (this.registrations.has(id)) continue
      statuses.push({
        id,
        present: false,
        enabled: config.enabled ?? true,
        state: 'missing',
      })
    }
    return statuses
  }

  /** Build the retained state and start activation when the gate is open. */
  private createRegistration(provider: CapabilityProvider): Registration {
    const { promise, resolve } = Promise.withResolvers<void>()
    const enabled = this.gateFor(provider)
    const registration: Registration = {
      provider,
      enabled,
      controller: new AbortController(),
      ready: promise,
      settleReady: resolve,
      contribution: undefined,
      state: enabled ? 'activating' : 'disabled',
      failure: undefined,
      lastTurnAt: undefined,
      registrations: new Map(),
      retired: false,
    }
    if (!enabled) {
      resolve()
      return registration
    }
    void this.activate(registration)
    return registration
  }

  /** Call the provider's `create()` once and retain its contribution. */
  private async activate(registration: Registration): Promise<void> {
    const runtime: CapabilityRuntime = { ctx: this.ctx, signal: registration.controller.signal }
    try {
      const contribution = await registration.provider.create(runtime)
      if (registration.retired || this.disposed || registration.controller.signal.aborted) {
        this.disposeContribution(registration, contribution)
        return
      }
      registration.contribution = contribution
      registration.state = 'active'
    } catch (error: unknown) {
      this.fail(registration, 'create()', error)
    } finally {
      registration.settleReady()
    }
  }

  /** Wire one capability onto one agent; a provider failure rolls back this capability's additions. */
  private wire(registration: Registration, agent: Agent, contribution: CapabilityContribution): void {
    const disposers: (() => void)[] = []
    try {
      for (const tool of contribution.tools?.(agent) ?? []) disposers.push(agent.ctx.tools.register(tool))
      for (const section of contribution.promptSections?.(agent) ?? []) {
        disposers.push(agent.ctx.systemPrompt.section(section))
      }
      contribution.onAgentCreated?.(agent)
    } catch (error: unknown) {
      for (const disposer of disposers.toReversed()) this.runDisposer(registration, disposer)
      this.fail(registration, 'agent wiring', error)
      return
    }
    registration.registrations.set(agent, disposers)
  }

  /** Await activation, then wire every matching capability onto one created agent. */
  private async admitAgent(agent: Agent): Promise<void> {
    if (this.disposed) return
    const registrations = [...this.registrations.values()]
    await Promise.all(registrations.map(registration => registration.ready))
    if (this.isDisposed()) return
    const agents = this.ctx.get('agents')
    const isRoot = agents === undefined || isRootAgent(agents, agent)
    for (const registration of registrations) {
      if (this.registrations.get(registration.provider.id) !== registration) continue
      if (!isContributing(registration)) continue
      const contribution = registration.contribution
      if (contribution === undefined) continue
      if (contribution.scope === 'root' && !isRoot) continue
      this.wire(registration, agent, contribution)
    }
    this.warnMissingCapabilities()
  }

  /** Drop the bookkeeping of an agent whose scoped registrations already unwound. */
  private forgetAgent(agent: Agent): void {
    for (const registration of this.registrations.values()) registration.registrations.delete(agent)
  }

  /** Filter and enqueue a completed turn for one session. */
  private observeSession(session: Session, event: SessionEvent): void {
    if (this.disposed || event.type !== 'turn/end') return
    if (event.data.reason.kind !== 'completed') return
    this.enqueueTurnEnd(session, event)
  }

  /** Dispatch one completed turn to matching capabilities, serialized per session. */
  private enqueueTurnEnd(session: Session, event: SessionEvent<'turn/end'>): void {
    const agents = this.ctx.get('agents')
    const agent = agents?.get(session.id)
    if (agents === undefined || agent === undefined) return
    const isRoot = isRootAgent(agents, agent)
    const targets = [...this.registrations.values()].filter(registration =>
      shouldDispatchTurnEnd(registration, isRoot))
    if (targets.length === 0) return
    const previous = this.turnChains.get(session.id) ?? Promise.resolve()
    const current = previous.then(async () => {
      await this.dispatchTurnEnd(agent, session, event, targets)
    })
    const settled = current.catch((error: unknown) => {
      this.ctx.logger.warn('dafeiyu: turn dispatch failed: %s', errorSummary(error))
    })
    this.turnChains.set(session.id, settled)
    void settled.then(() => {
      if (this.turnChains.get(session.id) === settled) this.turnChains.delete(session.id)
    })
  }

  /** Run each target hook in order; one failure never blocks the remaining capabilities. */
  private async dispatchTurnEnd(
    agent: Agent,
    session: Session,
    event: SessionEvent<'turn/end'>,
    targets: readonly Registration[],
  ): Promise<void> {
    for (const registration of targets) {
      const contribution = registration.contribution
      if (contribution?.onTurnEnd === undefined || !isContributing(registration)) continue
      registration.lastTurnAt = event.time
      const input: TurnEndInput = {
        agent,
        session,
        turn: event.data.turn,
        event,
        signal: registration.controller.signal,
      }
      try {
        await contribution.onTurnEnd(input)
      } catch (error: unknown) {
        // A reload or a disabled gate aborts the hook; the abort is not a capability failure.
        if (input.signal.aborted) return
        this.fail(registration, `onTurnEnd() for turn ${event.data.turn}`, error)
      }
    }
  }

  /** Remove one registration and every resource it owned. */
  private unregister(id: string, registration: Registration): void {
    if (this.registrations.get(id) !== registration) return
    this.registrations.delete(id)
    this.retire(registration)
  }

  /** Abort, dispose the contribution, and revoke the agent-level registrations. */
  private retire(registration: Registration): void {
    registration.retired = true
    registration.controller.abort()
    this.disposeContribution(registration, registration.contribution)
    registration.contribution = undefined
    this.disposeRegistrations(registration)
    registration.settleReady()
  }

  /** Dispose every registration and clear the organizer's state. */
  private shutdown(): void {
    if (this.disposed) return
    this.disposed = true
    const registrations = [...this.registrations.values()]
    this.registrations.clear()
    for (const registration of registrations) {
      registration.retired = true
      registration.controller.abort()
      registration.settleReady()
    }
    for (const registration of registrations) this.disposeContribution(registration, registration.contribution)
    for (const registration of registrations) this.disposeRegistrations(registration)
    this.turnChains.clear()
  }

  /** Call a provider's contribution disposer once, containing both throws and rejections. */
  private disposeContribution(registration: Registration, contribution: CapabilityContribution | undefined): void {
    if (contribution?.dispose === undefined) return
    this.contain(`capability "${registration.provider.id}" dispose()`, () => contribution.dispose?.())
  }

  /** Revoke the tools and prompt sections this registration added to agents. */
  private disposeRegistrations(registration: Registration): void {
    for (const disposers of registration.registrations.values()) {
      for (const disposer of disposers.toReversed()) this.runDisposer(registration, disposer)
    }
    registration.registrations.clear()
  }

  /** Run one registration disposer without letting it block the remaining capabilities. */
  private runDisposer(registration: Registration, disposer: () => void): void {
    this.contain(`capability "${registration.provider.id}" agent registration disposer`, disposer)
  }

  /** Run an owned operation and report a contained failure. */
  private contain(label: string, operation: () => unknown): void {
    try {
      const result: unknown = operation()
      if (result !== undefined) {
        void Promise.resolve(result).catch((error: unknown) => {
          this.ctx.logger.warn('dafeiyu: %s failed: %s', label, errorSummary(error))
        })
      }
    } catch (error: unknown) {
      this.ctx.logger.warn('dafeiyu: %s failed: %s', label, errorSummary(error))
    }
  }

  /** Read the unload flag through a call so a check after an await stays observable to readers and the type checker. */
  private isDisposed(): boolean {
    return this.disposed
  }

  /** Record the one-line failure summary and mark the capability failed. */
  private fail(registration: Registration, operation: string, error: unknown): void {
    const summary = errorSummary(error)
    registration.state = 'failed'
    registration.failure = summary
    this.ctx.logger.warn(
      'dafeiyu: capability "%s" %s failed: %s',
      registration.provider.id,
      operation,
      summary,
    )
  }

  /** Warn once per configured id that has no provider, after composition has settled. */
  private warnMissingCapabilities(): void {
    for (const id of Object.keys(this.gates())) {
      if (this.registrations.has(id) || this.warnedMissing.has(id)) continue
      this.warnedMissing.add(id)
      this.ctx.logger.warn(
        'dafeiyu: capability "%s" is configured but no provider registered; its plugin row may be absent or disabled',
        id,
      )
    }
  }

  /** The live capability switches, read through the volatile reference on every use. */
  private gates(): Readonly<Record<string, CapabilityConfig>> {
    return this.config.capabilities.get()
  }

  /** Resolve one provider's gate: explicit configuration wins over the descriptor default. */
  private gateFor(provider: CapabilityProvider): boolean {
    const configured = this.gates()[provider.id]?.enabled
    return configured ?? enabledByDefaultOf(provider)
  }

  /** Apply a swapped gate snapshot without remounting any plugin row. */
  private reconcileGates(): void {
    if (this.disposed) return
    for (const registration of this.registrations.values()) {
      const enabled = this.gateFor(registration.provider)
      if (enabled === registration.enabled) continue
      registration.enabled = enabled
      if (enabled) this.activateRegistration(registration)
      else this.disableRegistration(registration)
    }
  }

  /** Rebuild one registration whose gate reopened: a fresh abort scope and a fresh `create()`. */
  private activateRegistration(registration: Registration): void {
    const { promise, resolve } = Promise.withResolvers<void>()
    registration.ready = promise
    registration.settleReady = resolve
    registration.controller = new AbortController()
    registration.state = 'activating'
    registration.failure = undefined
    void this.activate(registration)
  }

  /** Tear one registration down while the provider stays registered; agents created later receive nothing. */
  private disableRegistration(registration: Registration): void {
    registration.controller.abort()
    this.disposeContribution(registration, registration.contribution)
    registration.contribution = undefined
    this.disposeRegistrations(registration)
    registration.state = 'disabled'
    registration.settleReady()
  }

  /**
   * Rebuild every capability after the profile configuration reloaded.
   *
   * The call disposes each contribution and its agent-level registrations, then
   * calls `create()` again for the registrations whose gate is open and re-wires
   * the agents that were already wired. It makes no per-capability diff: the
   * reload may have changed any provider's configuration, and re-creating one
   * capability at a time would leave the rest reading the previous profile.
   */
  private reloadRegistrations(): void {
    if (this.disposed) return
    const agents = this.ctx.get('agents')
    for (const registration of this.registrations.values()) {
      const wired = [...registration.registrations.keys()]
      registration.controller.abort()
      this.disposeContribution(registration, registration.contribution)
      registration.contribution = undefined
      this.disposeRegistrations(registration)
      const enabled = this.gateFor(registration.provider)
      registration.enabled = enabled
      if (!enabled) {
        registration.state = 'disabled'
        registration.settleReady()
        continue
      }
      this.activateRegistration(registration)
      void registration.ready.then(() => {
        if (this.disposed || registration.retired) return
        const contribution = registration.contribution
        if (registration.state !== 'active' || contribution === undefined) return
        for (const agent of wired) {
          // An agent disposed during the rebuild must not receive the new contribution.
          if (agents?.get(agent.session.id) !== agent) continue
          this.wire(registration, agent, contribution)
        }
      })
    }
  }
}

export default Dafeiyu

/** Derive the public status record for one registration. */
function statusOf(registration: Registration): CapabilityStatus {
  return {
    id: registration.provider.id,
    present: true,
    enabled: registration.enabled,
    state: publicState(registration.state),
    ...registration.failure === undefined ? {} : { failure: registration.failure },
    ...registration.lastTurnAt === undefined ? {} : { lastTurnAt: registration.lastTurnAt },
    ...metadataOf(registration.provider),
  }
}

/** The v2 list metadata carried onto a status record; v1 providers contribute none. */
function metadataOf(provider: CapabilityProvider): Partial<CapabilityStatus> {
  if (provider.contractVersion !== 2) return {}
  return {
    label: provider.label,
    description: provider.description,
    ...provider.settings === undefined ? {} : {
      settings: { sectionId: provider.settings.sectionId, order: provider.settings.order },
    },
  }
}

/** Whether the descriptor's gate opens when the organizer's configuration omits the capability. */
function enabledByDefaultOf(provider: CapabilityProvider): boolean {
  return provider.contractVersion === 2 ? provider.enabledByDefault ?? true : true
}

/** Reject a v2 descriptor that cannot render in the capability list. */
function assertDescriptor(provider: CapabilityProvider): void {
  if (provider.contractVersion !== 2) return
  const descriptor = provider as CapabilityProviderV2
  if (typeof descriptor.label !== 'string' || descriptor.label.trim() === '') {
    throw new Error(`dafeiyu: capability "${descriptor.id}" declares contractVersion 2 without a label`)
  }
  if (typeof descriptor.description !== 'string' || descriptor.description.trim() === '') {
    throw new Error(`dafeiyu: capability "${descriptor.id}" declares contractVersion 2 without a description`)
  }
  if (descriptor.settings !== undefined && (typeof descriptor.settings.sectionId !== 'string' || descriptor.settings.sectionId === '')) {
    throw new Error(`dafeiyu: capability "${descriptor.id}" declares settings without a sectionId`)
  }
}

/** Map the internal registration state onto the four public states. */
function publicState(state: RegistrationState): CapabilityStatus['state'] {
  switch (state) {
    case 'active': return 'active'
    case 'failed': return 'failed'
    case 'disabled':
    case 'activating':
      // The four-state contract has no pending value; a settling registration
      // contributes nothing yet and becomes active when `create()` resolves.
      return 'disabled'
  }
}

/** Whether a registration can still receive agents and turns. */
function isContributing(registration: Registration): boolean {
  return !registration.retired
    && registration.state === 'active'
    && registration.contribution !== undefined
}

/** Whether a turn belongs to a root agent, using the registry's runtime ownership. */
function isRootAgent(agents: AgentRegistry, agent: Agent): boolean {
  return agents.roots().includes(agent)
}

/** Whether one registration's turn hook should run for this agent scope. */
function shouldDispatchTurnEnd(registration: Registration, isRoot: boolean): boolean {
  if (!isContributing(registration)) return false
  const contribution = registration.contribution
  if (contribution?.onTurnEnd === undefined) return false
  return contribution.scope !== 'root' || isRoot
}

/** Flatten any thrown value into a single-line summary for status and logs. */
function errorSummary(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  const line = text.replaceAll(/\s+/gu, ' ').trim()
  const summary = line.length === 0 ? 'unknown failure' : line
  return summary.length <= FAILURE_SUMMARY_MAX_LENGTH
    ? summary
    : `${summary.slice(0, FAILURE_SUMMARY_MAX_LENGTH)}…`
}
