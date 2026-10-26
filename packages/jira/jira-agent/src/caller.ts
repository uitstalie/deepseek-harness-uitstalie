/**
 * plugin/caller — what the host tells us about whoever is calling.
 *
 * Decision 96 settled the seam: a tool handler receives the calling agent, and the agent's
 * session header carries the lineage facts. We read them **duck-typed** (decision 108: the
 * adapter imports no host package), so this file states the small shape we depend on and
 * every field stays optional — a host that stops providing one must degrade loudly, not
 * crash.
 *
 * Decision 89: the main agent writes, subagents only read.
 */

import { type Identity, asIdentity } from '@deepseek-ai/dsh-jira-core/entity.ts'

/**
 * The write guard's verdict about the calling session (decisions 89/93): whether it may write, why
 * not when it may not, and the lineage facts a write is attributed to. The tools read `writable`
 * before acting and echo the verdict in every result.
 */
export type Caller = Readonly<{
  /** `<model>|<tool>|<machine_id>|<session_id>` once we can fill it; absent otherwise. */
  identity?: Identity
  /** False for a delegated subagent (decision 89) and for an explicitly read-only session. */
  writable: boolean
  /** Why writing is refused, when it is. */
  reason?: string
  /** The checkout of this session (decision 131): a first write is attributed to it. */
  readonly cwd?: string
  /** The host session id (decision 10): a session record and its scan key on it. */
  readonly sessionId?: string
}>

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const asNonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined

/**
 * Read the lineage facts the host exposes on the calling agent:
 * `exec.agent.session.header.{origin,delegationDepth}` (persisted) and
 * `exec.agent.options.subagentDepth` (runtime). Both mean "this is a delegated child".
 * @param agent - the calling agent, read duck-typed; anything else is not a subagent.
 * @returns whether the host marks this session as a delegated child.
 */
export const isSubagent = (agent: unknown): boolean => {
  const record = asRecord(agent)
  if (record === undefined) return false
  const header = asRecord(asRecord(record.session)?.header)
  if (asNonEmptyString(header?.origin) === 'subagent') return true
  const persisted = header?.delegationDepth
  if (typeof persisted === 'number' && persisted > 0) return true
  const runtime = asRecord(record.options)?.subagentDepth
  return typeof runtime === 'number' && runtime > 0
}

/**
 * The session id, when the host surfaces one. Used for `me` and for audit trails.
 * @param agent - the calling agent, read duck-typed.
 * @returns the host session id, or undefined when the host provides none.
 */
export const callerSessionId = (agent: unknown): string | undefined => {
  const record = asRecord(agent)
  if (record === undefined) return undefined
  const session = asRecord(record.session)
  return asNonEmptyString(session?.id) ?? asNonEmptyString(record.id)
}

/**
 * Decision 93: the host carries the session's permission preset on the agent
 * (`agent.options.agentPreset`, names like `readOnly`/`workspaceWrite`). It is the only
 * read-only signal a plugin can actually see — the environment variable the first version
 * relied on is set by nothing (verified against two host checkouts).
 */
const READ_ONLY_PRESET = /read[-_]?only/iu

/**
 * Read the session's permission preset name from the agent (decision 93) — the only read-only
 * signal a plugin can see. The option is read under its current and its legacy names.
 * @param agent - the calling agent, read duck-typed.
 * @returns the preset name when the host exposes one, otherwise undefined.
 */
export const agentPresetOf = (agent: unknown): string | undefined => {
  const options = asRecord(asRecord(agent)?.options)
  return asNonEmptyString(options?.agentPreset) ?? asNonEmptyString(options?.permissionPreset) ?? asNonEmptyString(options?.preset)
}

export type CallerFacts = Readonly<{
  agent?: unknown
  /** The model name, if the host passed one through. */
  model?: string
  /** This machine's id, so the identity carries the full tuple (decision 48). */
  machine?: string
  /** A read-only session (DSH sandbox/permission mode) refuses writes too (decision 93). */
  readOnly?: boolean
}>

/**
 * The identity a write is recorded under (decision 48):
 * `agent:<model>|<tool>|<machine_id>|<session_id>`. An unknown model reads as `unknown`
 * rather than as an empty slot, so the string stays legible in a file a human reads.
 */
const identityOf = (facts: CallerFacts): Identity | undefined => {
  const sessionId = callerSessionId(facts.agent)
  if (sessionId === undefined) return undefined
  const identity = `agent:${facts.model ?? 'unknown'}|dsh|${facts.machine ?? ''}|${sessionId}`
  return asIdentity(identity)
}

/**
 * Build the {@link Caller} the tools check: a read-only preset or a subagent is refused (decisions
 * 89/93); everyone else writes under the identity their session header yields.
 * @param facts - the host facts this call gathered: the agent, model, machine and read-only flag.
 * @returns the frozen verdict, carrying cwd, session id and identity where the host provided them.
 */
export const describeCaller = (facts: CallerFacts): Caller => {
  const cwd = callerCwd(facts.agent)
  const checkout = cwd === undefined ? {} : { cwd }
  const sessionId = callerSessionId(facts.agent)
  const session = sessionId === undefined ? {} : { sessionId }
  if (READ_ONLY_PRESET.test(agentPresetOf(facts.agent) ?? '')) {
    return Object.freeze({ writable: false, reason: 'dsh-read-only', ...checkout })
  }
  if (facts.readOnly === true) return Object.freeze({ writable: false, reason: 'dsh-read-only', ...checkout })
  const identity = identityOf(facts)
  if (isSubagent(facts.agent)) {
    return Object.freeze({
      writable: false,
      reason: 'subagent',
      ...checkout,
      ...session,
      ...(identity === undefined ? {} : { identity }),
    })
  }
  return Object.freeze({
    writable: true,
    ...checkout,
    ...session,
    ...(identity === undefined ? {} : { identity }),
  })
}
/**
 * The session's checkout — `SessionHeader.cwd`, which §2.5 fixes at creation and which the design
 * names as the reliable basis for attributing a session to a project. Read duck-typed for the same
 * reason as the rest of this file (decision 108).
 * @param agent - the calling agent, read duck-typed.
 * @returns the checkout recorded in the session header, or undefined when it is absent.
 */
export const callerCwd = (agent: unknown): string | undefined => {
  const record = asRecord(agent)
  const header = asRecord(asRecord(record?.session)?.header)
  const cwd = header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}
