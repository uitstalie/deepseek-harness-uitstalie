/**
 * The process facts the model surface reads: the environment switch that makes a session
 * read-only, and the evidence the ledger records about the tool that wrote it.
 *
 * The host shapes the standalone plugin declared in `host.ts` are gone: in the repository the
 * entry takes the real Cordis context, and the ledger's location and identity come from the
 * `jira` service rather than from this row's config.
 *
 * @module @deepseek-ai/dsh-jira-agent/env
 */

/** The process environment, as the `core` helpers that read `DSH_*` facts expect it. */
export type HostEnv = Readonly<Record<string, string | undefined>>

/**
 * Whether a session may not write.
 *
 * `DSH_READ_ONLY_SESSION` is the deployment's own switch: absent means writable, `0` means
 * writable, anything else reads as read-only. The session's permission preset is a separate
 * signal, read from the agent in `caller.ts`; either one refuses a write.
 * @param env - the process environment.
 * @returns whether the deployment marked this session read-only.
 */
export const readOnlySession = (env: HostEnv): boolean =>
  env.DSH_READ_ONLY_SESSION !== undefined && env.DSH_READ_ONLY_SESSION !== '0'

/**
 * The process environment, unless there is no process (a non-Node host).
 * @returns the environment the `core` helpers read their `DSH_*` facts from.
 */
export const defaultEnv = (): HostEnv => (typeof process === 'undefined' ? {} : process.env)
