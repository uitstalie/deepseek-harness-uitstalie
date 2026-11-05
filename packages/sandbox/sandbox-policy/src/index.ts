/**
 * The sandbox POLICY home (`ctx.sandboxPolicy`): the single owner of the
 * deployment's sandbox fallbacks plus per-session resolution: the file-effect
 * {@link SandboxMode}, the `workspace-write` root, the explicit extra writable
 * directories, and the override kit (the `sandbox/mode` event, its fold, and
 * its write path; the fold is the `sandboxMode` session-projection unit
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

import { homedir, tmpdir } from 'node:os'
import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { z as zod } from 'zod'
import { homeWriteTool } from './home-write-tool.ts'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-system-prompt'

export { SANDBOX_MODES, setSandboxMode } from './session-mode.ts'
export { HOME_WRITE_TOOL_NAME, homeWriteTool } from './home-write-tool.ts'

/** Preserve execution-world spelling; enforcing providers resolve filesystem identity on their host. */
function resolveWorkspaceRoot(path: string): string {
  if (!isAbsolute(path) || path.includes('\0')) throw new Error('sandbox-policy: workspace root must be an absolute execution-world path without NUL bytes')
  return path
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
      throw new Error('sandbox-policy: additionalWritableRoots entries must be absolute execution-world paths')
    }
  }
  return Object.freeze([...new Set(roots)])
}

/** Default force-read-only entries under home when the deployment does not override the list. */
export const DEFAULT_HOME_WRITE_READ_ONLY_SUBDIRS: readonly string[] = Object.freeze([
  '.ssh',
  '.gnupg',
  '.aws',
  '.config/gh',
  '.kube',
  '.docker',
])

/** Whether `candidate` is the same as or below `root` (case-insensitive on Windows). */
const underRoot = (root: string, candidate: string): boolean => {
  if (process.platform === 'win32') {
    const base = root.toLowerCase().replace(/[\\/]+$/u, '')
    const target = candidate.toLowerCase()
    return target === base || target.startsWith(`${base}\\`) || target.startsWith(`${base}/`)
  }
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
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

/** Build the read-only defaults from home, keeping lexical paths when a default does not exist yet. */
const defaultReadOnlyRoots = (home: string): readonly string[] =>
  Object.freeze(DEFAULT_HOME_WRITE_READ_ONLY_SUBDIRS.map((subdir) => {
    const path = resolve(home, subdir)
    try {
      return realpathSync.native(path)
    } catch {
      return path
    }
  }))

/** Render the policy without claiming which capabilities are mounted. */
function renderPolicyContext(policy: SandboxExecutionPolicy): string {
  switch (policy.mode) {
    case 'read-only':
      return 'Current DSH file policy: read-only. Any available operation enforced by the DSH file sandbox cannot modify files in the standing mode. Do not refuse a required modification from this policy alone: try an available tool normally and follow any denial and escalation guidance it returns.'
    case 'workspace-write': {
      const additional = policy.additionalWritableRoots
      const extra = additional === undefined
        ? ''
        : ` Additional writable directories: ${JSON.stringify(additional)}.`
      return `Current DSH file policy: workspace-write. Any available operation enforced by the DSH file sandbox may modify files under the session workspace: ${JSON.stringify(policy.workspaceRoot)}.${extra} Some platform temporary areas may also be writable.`
    }
    case 'home-write': {
      const extra = policy.homeWriteTempRoots === undefined || policy.homeWriteTempRoots.length === 0
        ? ''
        : ` Temporary exceptions: ${JSON.stringify(policy.homeWriteTempRoots)}.`
      const readOnly = policy.homeWriteReadOnlyRoots === undefined || policy.homeWriteReadOnlyRoots.length === 0
        ? ''
        : ` Force-read-only directories: ${JSON.stringify(policy.homeWriteReadOnlyRoots)}.`
      return `Current DSH file policy: home-write. The DSH file sandbox may modify files under the user's home: ${JSON.stringify(policy.homeWriteRoot)}.${extra}${readOnly} Everything else is read-only; force-read-only entries win over the home.`
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
  mode?: SandboxMode
  /**
   * Absolute fallback root for agentless calls and sessions without a cwd (default:
   * `process.cwd()`). Normal agent calls use their session cwd instead.
   */
  workspaceRoot?: string
  /**
   * Extra physical absolute directories that `workspace-write` may also write under
   * (default: none). The supervisor names them explicitly; there is no
   * automatic repository or gitfile discovery. Entries are execution-world
   * paths: this service validates absoluteness and detaches the list, while
   * the enforcing host rejects missing, non-directory, or symlinked paths. They grant nothing under
   * `read-only`.
   */
  additionalWritableRoots?: string[]
  /**
   * Explicit home directory for `home-write`; default `os.homedir()`. On
   * Windows the default must be under `C:\\Users\\<user>`; a home elsewhere must
   * be opted in here.
   */
  homeWriteRoot?: string
  /**
   * Force-read-only directories for `home-write`, absolute and canonicalized.
   * Undefined enables the built-in safety list (`~/.ssh`, `~/.gnupg`,
   * `~/.aws`, `~/.config/gh`, `~/.kube`, `~/.docker`); an explicit empty array
   * disables the defaults.
   */
  homeWriteReadOnlyRoots?: string[]
  /** Temporary directories also writable under `home-write`; default `os.tmpdir()`. */
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
  zod.literal('home-write'),
  zod.literal('danger-full-access'),
]).nullable()

/**
 * The sandbox-policy service (`ctx.sandboxPolicy`). Owns the deployment
 * default mode, fallback workspace root, and current request-time policy
 * section. Tool layers call {@link resolve} for each execution so a session's
 * mode log and immutable cwd travel together to every enforcing capability.
 */
export class SandboxPolicyService extends Service {
  // Inline schema call: the config catalog walks `static Config` statically.
  static Config: z<Config> = z.object({
    mode: z.union(['read-only', 'workspace-write', 'home-write', 'danger-full-access'] as const).default('read-only'),
    // No schema default: process.cwd() is resolved in the constructor so the
    // stored root is always absolute regardless of how it was supplied.
    workspaceRoot: z.string(),
    additionalWritableRoots: z.array(z.string()).default([]),
    homeWriteRoot: z.string(),
    homeWriteReadOnlyRoots: z.array(z.string()).default([...DEFAULT_HOME_WRITE_READ_ONLY_SUBDIRS]),
    homeWriteTempRoots: z.array(z.string()).default(process.platform === 'win32' ? [] : [tmpdir()]),
    homeWriteAllowSymlinkedRoots: z.boolean().default(false),
  })

  static inject = ['sessionProjections']

  /** The deployment default mode — the fallback beneath a session override. */
  readonly defaultMode: SandboxMode
  /** The absolute `workspace-write` fallback root for calls without a session cwd. */
  readonly workspaceRoot: string
  /** The frozen extra writable directories shared by every resolved policy, or `undefined` for none. */
  readonly additionalWritableRoots: readonly string[] | undefined
  /** Canonical home-write boundary; also used to judge workspace-write → home-write escalation. */
  readonly homeWriteRoot: string
  /** Canonical temporary exceptions under home-write. */
  readonly homeWriteTempRoots: readonly string[]
  /** Canonical force-read-only roots under home-write. */
  readonly homeWriteReadOnlyRoots: readonly string[]
  /** Whether configured roots may use a symlink spelling. */
  readonly homeWriteAllowSymlinkedRoots: boolean
  /** Why the default Windows home cannot be used; checked only when home-write is selected. */
  readonly homeWriteProblem?: string
  private sandboxModeProjectionHandle!: ProjectionHandle<SandboxMode | null>
  /** Session-scoped fs-only grants contributed by capabilities. */
  private readonly fsRootProviders = new Set<FsWritableRootsProvider>()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'sandboxPolicy')
    // schemastery (static Config) already filled `mode`; the cast records that
    // runtime fact. `workspaceRoot` has NO schema default, so its fallback to
    // the process cwd is real branching, resolved absolute either way.
    this.defaultMode = config.mode as SandboxMode
    this.workspaceRoot = resolveWorkspaceRoot(config.workspaceRoot ?? process.cwd())
    this.additionalWritableRoots = resolveAdditionalWritableRoots(config.additionalWritableRoots)
    const allowSymlinked = config.homeWriteAllowSymlinkedRoots === true
    const defaultHome = homedir()
    const homeInput = config.homeWriteRoot ?? defaultHome
    this.homeWriteAllowSymlinkedRoots = allowSymlinked
    this.homeWriteRoot = configuredRoot(homeInput, allowSymlinked, 'homeWriteRoot')
    const tempInputs = config.homeWriteTempRoots ?? (process.platform === 'win32' ? [] : [tmpdir()])
    this.homeWriteTempRoots = Object.freeze([...new Set(tempInputs.map(path => configuredRoot(path, true, 'homeWriteTempRoots')))])
    const readonlyInputs = config.homeWriteReadOnlyRoots
    const usesDefaultReadOnly = readonlyInputs === undefined
      || (readonlyInputs.length === DEFAULT_HOME_WRITE_READ_ONLY_SUBDIRS.length
        && readonlyInputs.every((entry, index) => entry === DEFAULT_HOME_WRITE_READ_ONLY_SUBDIRS[index]))
    this.homeWriteReadOnlyRoots = usesDefaultReadOnly
      ? defaultReadOnlyRoots(this.homeWriteRoot)
      : Object.freeze(readonlyInputs.map((path) => {
        const physical = configuredRoot(path, allowSymlinked, 'homeWriteReadOnlyRoots')
        if (allowSymlinked
          && !this.homeWriteTempRoots.some(root => underRoot(root, physical))
          && !underRoot(this.homeWriteRoot, physical)) {
          throw new Error(`sandbox-policy: homeWriteReadOnlyRoots target ${JSON.stringify(physical)} must stay inside the home or a temp exception`)
        }
        return physical
      }))
    if (process.platform === 'win32' && config.homeWriteRoot === undefined
      && !/^[a-z]:[\\/]Users[\\/]/iu.test(this.homeWriteRoot)) {
      this.homeWriteProblem = 'on Windows the default homeWriteRoot must be under C:\\Users\\<user>; set homeWriteRoot explicitly for a home elsewhere'
    }
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
      scope.tools.register(homeWriteTool(scope, {
        homeWriteRoot: this.homeWriteRoot,
        homeWriteTempRoots: this.homeWriteTempRoots,
        homeWriteReadOnlyRoots: this.homeWriteReadOnlyRoots,
        homeWriteAllowSymlinkedRoots: this.homeWriteAllowSymlinkedRoots,
      }))
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
   * cwd. Capability-registered fs-only grants are resolved here too, so the
   * in-process filesystem fence can receive directories that process
   * confinement deliberately does not.
   * @param request - optional session and approved mode override.
   * @returns the fully resolved per-call mode and absolute workspace root.
   */
  resolve(request: SandboxPolicyRequest = {}): SandboxExecutionPolicy {
    const { session } = request
    const mode = request.mode ?? (session === undefined ? undefined : this.overrideOf(session)) ?? this.defaultMode
    if (mode === 'home-write' && this.homeWriteProblem !== undefined) {
      throw new Error(`sandbox-policy: ${this.homeWriteProblem}`)
    }
    const fsRoots = mode === 'workspace-write' ? this.fsRootsOf(session) : undefined
    return {
      mode,
      workspaceRoot: resolveWorkspaceRoot(session?.header.cwd ?? this.workspaceRoot),
      ...mode === 'workspace-write' && this.additionalWritableRoots !== undefined
        ? { additionalWritableRoots: this.additionalWritableRoots }
        : {},
      ...fsRoots === undefined ? {} : { fsAdditionalWritableRoots: fsRoots },
      ...mode === 'home-write'
        ? {
          homeWriteRoot: this.homeWriteRoot,
          homeWriteTempRoots: this.homeWriteTempRoots,
          homeWriteReadOnlyRoots: this.homeWriteReadOnlyRoots,
        }
        : {},
      ...session === undefined ? {} : { sessionId: session.id },
    }
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
