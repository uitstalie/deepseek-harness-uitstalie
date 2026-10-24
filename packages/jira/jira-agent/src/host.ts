/**
 * plugin/host — the host surface this plugin depends on, **declared** rather than imported
 * (decision 108). Split out of `index.ts` under decision 186: the entry point wires behaviour;
 * the shapes it wires against live here.
 *
 * Optional services are reachable *only* through `JiraHostContext.get`. The host throws
 * `cannot get property "<name>" without inject` for a property read of a service the plugin did
 * not declare in `inject`, while declaring them required would stop the plugin loading at all in
 * a profile with no command or skill registry.
 */

/** Decision 57's Config, narrowed to what this increment reads. */
export type JiraConfig = Readonly<{
  root?: string
  machine_id?: string
  host?: string
  /** Decision 57's `push` group: the debounced queue of decision 60. */
  push?: Readonly<{ enabled?: boolean; debounce_ms?: number }>
  /** The shared data repository every machine joins (decision 119). */
  remote?: string
}>

export type JiraExec = Readonly<{
  signal?: AbortSignal
  /** The calling agent, if the host set one (`exec.agent`). */
  agent?: unknown
  /** The model name, when the host passes one through. */
  model?: string
}>

export type ToolGuard = (execution: { name?: string; arguments?: unknown; agent?: unknown }) => string | undefined

export type JiraToolDefinition = Readonly<{
  name: string
  description: string
  parameters: Record<string, unknown>
  output: Readonly<{
    schema: Record<string, unknown>
    render: (args: unknown, value: unknown) => readonly unknown[]
  }>
  execute: (args: unknown, exec: JiraExec) => Promise<unknown>
  timeoutMs?: number
  /** Decision 84: pure classifier; only `true` opts into a parallel group. */
  isConcurrencySafe?: (args: unknown) => boolean
}>

export type JiraHostContext = Readonly<{
  tools: Readonly<{
    register(definition: JiraToolDefinition): () => void
    /** Decision 96: monotonic — no other plugin can force-allow what this denies. */
    guard?: (guard: (execution: { name?: string; arguments?: unknown; agent?: unknown }) => string | undefined) => unknown
  }>
  /**
   * The service accessor for **optional** dependencies.
   *
   * They are deliberately **absent from this type** as well: with `ctx.commands` untypeable,
   * `tsc` refuses the read that the host refuses at runtime (2026-10-15).
   * (`docs/user/develop/framework/service.md:95` — "Optional: omit inject and query with
   * `ctx.get()` at the use site.")
   */
  get?: (name: string) => unknown
  /** `agent/created`, used for the session-end push flush (decision 100). */
  on?: (event: string, listener: (payload: { agent?: unknown; source?: string }) => void) => unknown
}>

export type HostEnv = Readonly<Record<string, string | undefined>>

/** The process environment, unless there is no process (a non-Node host). */
export const defaultEnv = (): HostEnv => (typeof process === 'undefined' ? {} : process.env)
