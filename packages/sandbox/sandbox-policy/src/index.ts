/**
 * The sandbox POLICY home (`ctx.sandboxPolicy`): the single owner of the
 * deployment's sandbox fallbacks plus per-session resolution: the file-effect
 * {@link SandboxMode}, the `workspace-write` root, the explicit extra writable
 * directories from configuration and live Session registrations, and the override
 * kit (the `sandbox/mode` event, its fold, and its write path; the fold is the
 * `sandboxMode` session-projection unit
 * registered here, while the event and write path come from
 * `./session-mode.ts`).
 * Before each agent request, the owner also contributes the resolved policy to
 * the cache-safe runtime-context snapshot. The agent loop logs that snapshot as
 * model history, so replay reconstructs the same mode and root the enforcing
 * consumers resolve without rewriting the stable system prompt.
 *
 * Enforcing filesystem, one-shot bash, and terminal backends read the SAME
 * resolved policy here. The context describes that policy without inventorying
 * capabilities, while each backend retains its own enforcement dialect and each
 * tool owns its operation-specific denial and escalation guidance. The service
 * reads session state once at each operation boundary; executors and providers
 * remain session-free.
 *
 * @module @deepseek-ai/dsh-sandbox-policy
 */

import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { z as zod } from 'zod'
import { homeWriteTool } from './home-write-tool.ts'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
// uitstalie-deepseek-flash, 2026/11/06, DH-902, home-write disabled (Low-integrity whole-tree relabel; no auto-rollback)
import { HOME_WRITE_ENABLED, SandboxInvalidRootError, assertSandboxModeEnabled, homeWriteRoots, normalizeSandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-system-prompt'

export { SANDBOX_MODES, setSandboxMode } from './session-mode.ts'
export { HOME_WRITE_TOOL_NAME, homeWriteTool } from './home-write-tool.ts'

/** Whether a path is usable as an execution-world grant: absolute and free of NUL bytes. */
function isExecutionWorldPath(path: string): boolean {
  return isAbsolute(path) && !path.includes('\0')
}

/**
 * Validate and detach the configured extra writable directories. They stay in
 * their execution-world spelling here: a local host must not canonicalize a
 * remote path. The enforcing host validates each physical directory before granting.
 * @param roots - the configured extra roots, or the empty schema default.
 * @returns a frozen copy, or `undefined` when no extra grant exists.
 */
function resolveAdditionalWritableRoots(roots: readonly string[] | undefined): readonly string[] | undefined {
  if (roots === undefined || roots.length === 0) return undefined
  for (const root of roots) {
    if (!isAbsolute(root) || root.includes('\0')) {
      throw new Error('sandbox-policy: writable directories must be absolute execution-world paths without NUL bytes')
    }
  }
  return Object.freeze([...new Set(roots)])
}

/** Resolve one configured directory, enforcing the physical-path rule and symlink opt-in. */
const configuredRoot = (path: string, allowSymlinked: boolean, label: string): string => {
  if (path.trim() === '' || !isAbsolute(path) || path.includes('\0')) {
    throw new Error(`sandbox-policy: ${label} must be an absolute path without NUL bytes; got ${JSON.stringify(path)}`)
  }
  let physical: string
  try {
    physical = realpathSync.native(path)
  } catch (error: unknown) {
    throw new Error(`sandbox-policy: ${label} ${JSON.stringify(path)} cannot be resolved: ${String(error)}`)
  }
  if (!statSync(physical).isDirectory()) {
    throw new Error(`sandbox-policy: ${label} ${JSON.stringify(path)} is not a directory`)
  }
  if (!allowSymlinked && physical !== resolve(path)) {
    throw new Error(
      `sandbox-policy: ${label} ${JSON.stringify(path)} is a symlink spelling; use ${JSON.stringify(physical)} or enable homeWriteAllowSymlinkedRoots`,
    )
  }
  return physical
}

/** Render the policy without claiming which capabilities are mounted. */
function renderPolicyContext(policy: SandboxExecutionPolicy): string {
  switch (policy.mode) {
    case 'read-only':
      return 'Current DSH file policy: read-only. Any available operation enforced by the DSH file sandbox cannot modify files in the standing mode. Do not refuse a required modification from this policy alone: try an available tool normally and follow any denial and escalation guidance it returns.'
    case 'workspace-write': {
      const additional = policy.additionalWritableRoots
      const extra = additional === undefined
        ? ''
        : ` Additional writable directories: ${JSON.stringify(additional)}. On Windows, these additional grants apply to file tools only, not sandboxed processes.`
      return `Current DSH file policy: workspace-write. Any available operation enforced by the DSH file sandbox may modify files under the session workspace: ${JSON.stringify(policy.workspaceRoot)}.${extra} Some platform temporary areas may also be writable.`
    }
    case 'home-write': {
      // uitstalie-deepseek-flash, 2026/11/06, DH-902, home-write disabled: kept
      // for the preserved implementation; `resolve()` refuses the mode before
      // this branch can render.
      const extra = policy.homeWriteTempRoots === undefined || policy.homeWriteTempRoots.length === 0
        ? ''
        : ` Temporary exceptions: ${JSON.stringify(policy.homeWriteTempRoots)}.`
      const excludes = policy.excludePaths === undefined || policy.excludePaths.length === 0
        ? ''
        : ` Excluded (forced read-only even inside a writable root): ${JSON.stringify(policy.excludePaths)}.`
      return `Current DSH file policy: home-write. The DSH file sandbox may modify files under the session workspace: ${JSON.stringify(policy.workspaceRoot)},${extra} and the home-write roots: ${JSON.stringify(policy.homeWriteRoots)}.${excludes} On Windows the roots are C:\\Users\\<user> plus every fixed drive except the system drive; on Linux and macOS they are the signed-in user's home directory ($HOME, hidden entries included). Everything else is read-only; exclusions win over every root.`
    }
    case 'danger-full-access':
      return 'Current DSH file policy: danger-full-access. The DSH file sandbox does not restrict file modifications by available operations.'
    /* v8 ignore next 4 -- SandboxMode is a typed same-process closed union; this branch is only the static exhaustiveness guard. */
    default: {
      const mode: never = policy.mode
      throw new Error(`unreachable sandbox mode: ${String(mode)}`)
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sandboxPolicy: SandboxPolicyService
  }
}

/**
 * Plugin config: the deployment's sandbox default. All optional — `Config`
 * supplies the defaults (`mode: 'read-only'` is the fail-safe default; a
 * deployment that wants a workspace-writable agent opts in explicitly). The
 * runner choice is NOT here (it is the `ctx.sandbox` provider's config), nor
 * is any per-family knob: this is the one shared policy home.
 */
export interface Config {
  /** File-sandbox mode a session starts from (default: `read-only`). */
  mode?: SandboxMode | 'non-critical-write'
  /**
   * Absolute fallback root for agentless calls and sessions without a cwd (default:
   * `process.cwd()`). Normal agent calls use their session cwd instead.
   */
  workspaceRoot?: string
  /**
   * Extra physical absolute directories that `workspace-write` may also write under
   * (default: none). Entries are execution-world paths: this service validates
   * absoluteness and detaches the list, while the enforcing host rejects
   * missing, non-directory, or symlinked paths. They grant nothing under
   * `read-only`. Windows process confinement ignores them; harness file tools honor them.
   */
  additionalWritableRoots?: string[]
  /**
   * Explicit roots for `home-write`; default: the user home plus every
   * non-system fixed drive on Windows, the user home elsewhere. Replace the
   * default, not appended to it. Entries are execution-world paths and may
   * start with `~`; the session workspace is always added separately. On
   * Windows a C: root outside the user home is dropped (C: stays read-only).
   *
   * Compatibility: `nonCriticalRoots` (the folded mode's old key) and
   * `homeWriteRoot` (a single root) are accepted aliases.
   */
  homeWriteRoots?: string[]
  /** Compatibility alias for `homeWriteRoots` (the folded `non-critical-write` key). */
  nonCriticalRoots?: string[]
  /** Compatibility alias for a single-root `homeWriteRoots` configuration. */
  homeWriteRoot?: string
  /**
   * Directories forced read-only inside `home-write`, even when they sit under
   * a writable root (default: none — the home is fully writable, credential
   * stores included). Entries are execution-world absolute paths; a leading
   * `~` expands on the enforcing host. A trailing `/*` or `/**` means the same
   * directory subtree; any other glob syntax is rejected. The path must exist
   * when a confined call resolves the policy.
   *
   * Compatibility: `homeWriteReadOnlyRoots` is accepted as an alias.
   */
  excludePaths?: string[]
  /** Compatibility alias for `excludePaths`. */
  homeWriteReadOnlyRoots?: string[]
  /** Temporary directories also writable under `home-write` (default: none). */
  homeWriteTempRoots?: string[]
  /** Allow symlink spellings for configured home-write roots (default false). */
  homeWriteAllowSymlinkedRoots?: boolean
}

/** Inputs that select the sandbox policy for one capability call. */
export interface SandboxPolicyRequest {
  /** Calling session; its immutable cwd becomes the workspace boundary. */
  session?: Session
  /** Explicit approved mode override, which outranks session policy. */
  mode?: SandboxMode
}

/**
 * Capability-scoped provider of filesystem-fence-only writable directories for
 * one session. The provider decides from the session alone whether it grants
 * anything (for example, only a dispatcher's own Sessions); the service
 * validates that each entry is absolute and never widens a process sandbox.
 */
export type FsWritableRootsProvider = (session: Session) => readonly string[] | undefined

/** The sandbox-mode projection's state schema (state equals the public shape). */
const sandboxModeStateSchema = zod.union([
  zod.literal('read-only'),
  zod.literal('workspace-write'),
  // uitstalie-deepseek-flash, 2026/11/06, DH-902, home-write disabled: kept so a
  // persisted home-write/non-critical-write override still decodes; `resolve()`
  // then refuses it with the disabled-mode error instead of silently widening.
  zod.literal('home-write'),
  // Compatibility: logs written before the mode was folded into home-write.
  zod.literal('non-critical-write').transform(() => 'home-write' as const),
  zod.literal('danger-full-access'),
]).nullable()

/**
 * The sandbox-policy service (`ctx.sandboxPolicy`). Owns the deployment
 * default mode, fallback workspace root, session-scoped directory grants, and
 * request-time policy section. Tool layers call {@link resolve} for each execution so a session's
 * mode log and immutable cwd travel together to every enforcing capability.
 */
export class SandboxPolicyService extends Service {
  // Inline schema call: the config catalog walks `static Config` statically.
  static Config: z<Config> = z.object({
    // uitstalie-deepseek-flash, 2026/11/06, DH-902, home-write disabled:
    // the literals stay accepted so the constructor refuses them with the
    // explicit disabled-home-write message instead of a generic union error.
    mode: z.union(['read-only', 'workspace-write', 'home-write', 'non-critical-write', 'danger-full-access'] as const).default('read-only'),
    // No schema default: process.cwd() is resolved in the constructor so the
    // stored root is always absolute regardless of how it was supplied.
    workspaceRoot: z.string(),
    additionalWritableRoots: z.array(z.string()).default([]),
    // uitstalie-deepseek-flash, 2026/11/06, DH-902, home-write disabled: the
    // homeWrite* keys stay accepted so existing profiles keep loading, but they
    // grant nothing because the mode itself is refused at load and on resolve.
    homeWriteRoots: z.array(z.string()).default([]),
    nonCriticalRoots: z.array(z.string()).default([]),
    homeWriteRoot: z.string(),
    excludePaths: z.array(z.string()).default([]),
    homeWriteReadOnlyRoots: z.array(z.string()).default([]),
    homeWriteTempRoots: z.array(z.string()).default([]),
    homeWriteAllowSymlinkedRoots: z.boolean().default(false),
  })

  static inject = ['sessionProjections']

  /** The deployment default mode — the fallback beneath a session override. */
  readonly defaultMode: SandboxMode
  /** The absolute workspace-write fallback root for calls without a session cwd. */
  readonly workspaceRoot: string
  /** The frozen extra writable directories shared by every resolved policy, or `undefined` for none. */
  readonly additionalWritableRoots: readonly string[] | undefined
  /** Canonical home-write roots (home and, on Windows, every non-system drive). */
  readonly homeWriteRoots: readonly string[]
  /** Canonical temporary exceptions under home-write (default: none). */
  readonly homeWriteTempRoots: readonly string[]
  /** Canonical read-only holes under home-write (`excludePaths`; default: none). */
  readonly excludePaths: readonly string[] | undefined
  /** Whether configured roots may use a symlink spelling. */
  readonly homeWriteAllowSymlinkedRoots: boolean
  /** Independently owned grants for each live Session; never restored from its log. */
  private readonly writableRootRegistrations = new WeakMap<Session, Map<symbol, string>>()
  private sandboxModeProjectionHandle!: ProjectionHandle<SandboxMode | null>
  /** Session-scoped fs-only grants contributed by capabilities. */
  private readonly fsRootProviders = new Set<FsWritableRootsProvider>()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'sandboxPolicy')
    // The schema union accepts the folded mode name; every consumer sees the
    // current vocabulary while old configurations keep loading.
    this.defaultMode = normalizeSandboxMode(config.mode ?? 'read-only')
    // uitstalie-deepseek-flash, 2026/11/06, DH-902, home-write disabled: fail the deployment default at load
    assertSandboxModeEnabled(this.defaultMode)
    // Execution-world spelling is preserved; enforcing providers resolve filesystem identity on their host.
    const workspaceRoot = config.workspaceRoot ?? process.cwd()
    if (!isExecutionWorldPath(workspaceRoot)) {
      throw new Error('sandbox-policy: workspace root must be an absolute execution-world path without NUL bytes')
    }
    this.workspaceRoot = workspaceRoot
    this.additionalWritableRoots = resolveAdditionalWritableRoots(config.additionalWritableRoots)
    const allowSymlinked = config.homeWriteAllowSymlinkedRoots === true
    this.homeWriteAllowSymlinkedRoots = allowSymlinked
    const rootInputs = (config.homeWriteRoots?.length ?? 0) > 0
      ? config.homeWriteRoots
      : (config.nonCriticalRoots?.length ?? 0) > 0
        ? config.nonCriticalRoots
        : config.homeWriteRoot !== undefined
          ? [config.homeWriteRoot]
          : undefined
    this.homeWriteRoots = Object.freeze(homeWriteRoots(rootInputs === undefined ? {} : { configured: rootInputs })
      // configuredRoot owns the diagnostic (symlink spelling, not a directory,
      // unresolvable); homeWriteRoots already dropped a missing entry.
      .map(path => configuredRoot(path, allowSymlinked, 'homeWriteRoots')))
    const tempInputs = config.homeWriteTempRoots ?? []
    this.homeWriteTempRoots = Object.freeze([...new Set(tempInputs.map(path => configuredRoot(path, true, 'homeWriteTempRoots')))])
    const excludeInputs = config.excludePaths !== undefined && config.excludePaths.length > 0
      ? config.excludePaths
      : config.homeWriteReadOnlyRoots ?? []
    this.excludePaths = excludeInputs.length === 0 ? undefined : Object.freeze([...new Set(excludeInputs)])
  }

  protected async [Service.init](): Promise<void> {
    const ctx = this.ctx
    this.sandboxModeProjectionHandle = await ctx.sessionProjections.register({
      key: 'sandboxMode',
      stateVersion: 1,
      stateSchema: sandboxModeStateSchema,
      init: () => null,
      apply: (state, event) => (event.type === 'sandbox/mode' ? event.data.mode : state),
    })

    ctx.inject(['tools'], (scope: Context) => {
      // BEGIN uitstalie-deepseek-flash, 2026/11/06, DH-902, home-write disabled (Low-integrity whole-tree relabel; no auto-rollback)
      /* v8 ignore next 8 -- disabled gate; the registration body is preserved for a documented re-enable. */
      if (HOME_WRITE_ENABLED) {
        scope.tools.register(homeWriteTool(scope, {
          homeWriteRoots: this.homeWriteRoots,
          homeWriteTempRoots: this.homeWriteTempRoots,
          excludePaths: this.excludePaths ?? [],
          homeWriteAllowSymlinkedRoots: this.homeWriteAllowSymlinkedRoots,
        }))
      }
      // END uitstalie-deepseek-flash
    })

    ctx.inject(['systemPrompt'], (scope: Context) => {
      scope.systemPrompt.context({
        name: 'sandbox:policy',
        order: scope.systemPrompt.getContextOrder('SANDBOX_POLICY'),
        text: (context) => {
          const session = context.agent?.session
          return session === undefined
            ? ''
            : renderPolicyContext(this.resolve({ session }))
        },
      })
    })
  }

  /**
   * Resolve the complete policy for one capability call. An approved explicit
   * mode outranks the session's last `sandbox/mode` event, which outranks the
   * deployment default. A session cwd is its workspace-write boundary; the
   * configured root is the fallback for agentless calls and sessions without a
   * cwd. Configured extra roots, this Session's active registrations, and
   * capability-registered fs-only grants are snapshotted together, so the
   * in-process filesystem fence can receive directories that process
   * confinement deliberately does not; existing operations and processes keep
   * their policy.
   * @param request - optional session and approved mode override.
   * @returns the fully resolved per-call mode and absolute workspace root.
   * @throws `SandboxInvalidRootError` (`SANDBOX_INVALID_ROOT`) when the session's recorded cwd is
   *   relative or contains a NUL byte.
   */
  resolve(request: SandboxPolicyRequest = {}): SandboxExecutionPolicy {
    const { session } = request
    const mode = normalizeSandboxMode(request.mode ?? (session === undefined ? undefined : this.overrideOf(session)) ?? this.defaultMode)
    // uitstalie-deepseek-flash, 2026/11/06, DH-902, home-write disabled: refuse session/approved overrides before any backend sees the mode
    assertSandboxModeEnabled(mode)
    const fsRoots = mode === 'workspace-write' ? this.fsRootsOf(session) : undefined
    const registrations = session === undefined ? undefined : this.writableRootRegistrations.get(session)
    const additionalWritableRoots = registrations === undefined
      ? this.additionalWritableRoots
      : resolveAdditionalWritableRoots([...(this.additionalWritableRoots ?? []), ...registrations.values()])
    return {
      mode,
      workspaceRoot: this.sessionWorkspaceRoot(session),
      ...mode === 'workspace-write' && additionalWritableRoots !== undefined
        ? { additionalWritableRoots }
        : {},
      ...fsRoots === undefined ? {} : { fsAdditionalWritableRoots: fsRoots },
      ...mode === 'home-write'
        ? {
          homeWriteRoots: this.homeWriteRoots,
          homeWriteTempRoots: this.homeWriteTempRoots,
          ...this.excludePaths === undefined ? {} : { excludePaths: this.excludePaths },
        }
        : {},
      ...session === undefined ? {} : { sessionId: session.id },
    }
  }

  /** The session's recorded cwd, or the configured root, as the workspace-write boundary. */
  private sessionWorkspaceRoot(session: Session | undefined): string {
    const cwd = session?.header.cwd
    if (cwd === undefined) return this.workspaceRoot
    if (!isExecutionWorldPath(cwd)) {
      throw new SandboxInvalidRootError(cwd, 'the Session working directory must be an absolute execution-world path without NUL bytes', 'sandbox workspace root')
    }
    return cwd
  }

  /**
   * Permit writes under one directory in this Session's future workspace-write
   * operations. The calling context owns the effect; disposal removes only this
   * registration. Other grants to the directory remain effective. Existing
   * operations and persistent processes retain their resolved permissions.
   * Grants are runtime-only and must be registered again after resume or fork.
   * On Windows, only harness file tools honor extra grants; process permissions stay unchanged.
   * @param session - exact live Session receiving the grant; other Sessions and agentless calls are unaffected.
   * @param directory - absolute execution-world path; execution rejects missing, non-directory, or symlinked paths.
   * @returns the exact Cordis effect disposer for this registration.
   * @throws when the directory is relative or contains a NUL byte.
   */
  registerWritableRoot(session: Session, directory: string): () => void {
    resolveAdditionalWritableRoots([directory])
    const dispose = this.ctx.effect(() => {
      let registrations = this.writableRootRegistrations.get(session)
      if (registrations === undefined) {
        registrations = new Map()
        this.writableRootRegistrations.set(session, registrations)
      }
      const key = Symbol()
      registrations.set(key, directory)
      return () => {
        registrations.delete(key)
        if (registrations.size === 0) this.writableRootRegistrations.delete(session)
      }
    }, 'sandboxPolicy.registerWritableRoot()')
    // oxlint-disable-next-line typescript/no-misused-promises -- synchronous cleanup preserves the exact Cordis effect disposer
    return dispose
  }

  /**
   * Register one session-scoped filesystem-fence grant. The provider is
   * consulted on every resolution; a failing provider is logged and ignored so
   * a broken capability cannot take the whole tool surface down. Only absolute
   * entries are kept, and duplicates are dropped. The grant never reaches a
   * process sandbox: see {@link SandboxExecutionPolicy.fsAdditionalWritableRoots}.
   * @param provider - the session → extra directories function.
   * @returns the exact disposer that removes the provider.
   */
  registerFsWritableRoots(provider: FsWritableRootsProvider): () => void {
    this.fsRootProviders.add(provider)
    return () => { this.fsRootProviders.delete(provider) }
  }

  /** Collect the registered fs-only grants for one session, validating each entry. */
  private fsRootsOf(session: Session | undefined): readonly string[] | undefined {
    if (session === undefined || this.fsRootProviders.size === 0) return undefined
    const roots: string[] = []
    for (const provider of this.fsRootProviders) {
      let contributed: readonly string[] | undefined
      try {
        contributed = provider(session)
      } catch (error: unknown) {
        this.ctx.logger.warn('sandbox-policy: an fs writable-roots provider failed: %s', String(error))
        continue
      }
      for (const root of contributed ?? []) {
        if (!isAbsolute(root) || root.includes('\0') || roots.includes(root)) continue
        roots.push(root)
      }
    }
    return roots.length === 0 ? undefined : Object.freeze(roots)
  }

  /**
   * Read the session override without applying the deployment default.
   * @param session - session whose log supplies the override.
   * @returns the last logged mode, or `undefined` without one.
   */
  overrideOf(session: Session): SandboxMode | undefined {
    return this.sandboxModeProjectionHandle.stateOf(session) ?? undefined
  }
}

export default SandboxPolicyService
