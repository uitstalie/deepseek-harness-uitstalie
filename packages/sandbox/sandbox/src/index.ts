/**
 * Service Definition for the same-world process-confinement capability seam: wrap exact subprocess argv under a
 * host-path file policy. Containers, microVMs, and remote execution replace the
 * surrounding capability seam instead; this service shares the host kernel and filesystem.
 * @module @deepseek-ai/dsh-sandbox
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

export {
  ESCALATION_TARGETS,
  SANDBOX_ESCALATION_ERROR_CODES,
  SandboxEscalationError,
  WIDER_MODES,
  approveEscalation,
  escalationHintMarker,
  sandboxDenialMarker,
  sandboxPermissionsDescription,
  validateEscalationArgs,
} from './escalation.ts'
export type {
  EscalationApproval,
  EscalationApprover,
  EscalationOutcome,
  EscalationRequest,
  SandboxEscalationErrorCode,
} from './escalation.ts'
export {
  canonicalPath,
  fsWritableRoots,
  homeWriteReadOnlyRoots,
  homeWriteWritableRoots,
  isHomeWriteAllowed,
  isWithinRoot,
  workspaceWritableRoots,
  writableRoots,
  SandboxInvalidRootError,
} from './roots.ts'
export {
  SandboxHomeWriteUnavailableError,
  SandboxInvalidExcludeError,
  excludePrefix,
  expandConfiguredPath,
  homeWriteRoots,
  isPathAtOrUnder,
  matchingExclude,
  resolvedExcludePaths,
  resolvedHome,
  windowsNonSystemDrives,
} from './home-write.ts'
export type { HomeWriteRootOptions } from './home-write.ts'
export { SANDBOX_MODE_ALIASES, normalizeSandboxMode } from './modes.ts'
// uitstalie-deepseek-flash, 2026/11/06, DH-902, home-write disabled: one switch every entry point consults
export { HOME_WRITE_DISABLED_MESSAGE, HOME_WRITE_ENABLED, assertSandboxModeEnabled } from './modes.ts'

/**
 * File-effect policy for confined processes. `read-only` permits only required
 * sinks such as `/dev/null`; `workspace-write` also permits the workspace,
 * explicit extra roots where supported, and backend-defined temp areas; `home-write` permits the canonical
 * home, every non-system fixed drive on Windows, the session workspace, and configured
 * temp exceptions, with `excludePaths` carving read-only holes out of all of them;
 * `danger-full-access` bypasses confinement. Network and process visibility are outside
 * this vocabulary.
 */
export type SandboxMode = 'read-only' | 'workspace-write' | 'home-write' | 'danger-full-access'

/** A confining (non-`danger-full-access`) mode — the modes a {@link SandboxPolicy} can carry. */
export type ConfinedSandboxMode = Exclude<SandboxMode, 'danger-full-access'>

/**
 * The complete file-effect policy resolved for one capability call. The root
 * is carried even under modes that do not consume it so callers can resolve
 * policy once before choosing the enforcement path.
 */
export interface SandboxExecutionPolicy {
  /** The file-effect mode this execution runs under. */
  mode: SandboxMode
  /** Absolute root directory the workspace-writable modes may write under. */
  workspaceRoot: string
  /**
   * Explicit `home-write` roots replacing the platform default (Windows: the
   * user home plus every non-system fixed drive; Linux/macOS: `$HOME`).
   * Absence means the enforcing host derives the default; `~` expands there.
   * The session workspace is always added separately.
   */
  homeWriteRoots?: readonly string[]
  /**
   * Read-only holes carved out of `home-write`: a matching path stays
   * read-only even inside a writable root. Entries are execution-world paths
   * (`~` expands on the enforcing host) naming an existing directory; a
   * trailing `/*` or `/**` means the same directory subtree, and any other glob
   * syntax is rejected. Absence means no exclusions — the mode's default.
   */
  excludePaths?: readonly string[]
  /**
   * Extra physical absolute directories `workspace-write` may also write under.
   * Absence means none. The enforcing host rejects missing, non-directory, and
   * symlinked entries on each call. Remote paths are checked on the remote host.
   * Windows process confinement ignores these; harness filesystem operations honor them.
   * These grant nothing under `read-only` or `danger-full-access`.
   */
  additionalWritableRoots?: readonly string[]
  /**
   * Extra physical absolute directories only the in-process filesystem fence
   * (`@deepseek-ai/dsh-fs-sandbox`) may write under.
   *
   * This is the narrow grant for a capability that must hand files to a
   * directory without widening what confined processes (shell, terminal, PTC)
   * may write: those backends ignore this field, so a host whose confinement
   * cannot express extra roots (Windows ACL) keeps working. The fence skips
   * entries that are missing, are not directories, or are symlinked; unlike
   * {@link additionalWritableRoots}, an unusable entry denies only itself
   * instead of failing the whole policy. Grants nothing under `read-only` or
   * `danger-full-access`.
   */
  fsAdditionalWritableRoots?: readonly string[]
  /** Extra directories writable under `home-write` (default: none). */
  homeWriteTempRoots?: readonly string[]
  /**
   * Opaque identity of the calling session (the branded `dsh-session`
   * SessionId). Backends key per-session state off it (e.g. windows-acl gives
   * each live session/workspace pair a random private temp directory and SID,
   * while the workspace SID and standing grant remain per-workspace); absent
   * for agentless calls, which fall back to per-call backend state.
   */
  sessionId?: SessionId
}

/**
 * Enforcement completeness for this host. `partial` means an active backend or
 * older kernel ABI cannot govern every promised file effect; callers requiring
 * an absolute boundary must not treat it as `full`.
 */
export type SandboxEnforcement = 'full' | 'partial'

/**
 * What one confined execution is allowed to touch — carried PER CALL, not
 * fixed on the provider: two consumers may confine under different policies
 * at the same instant (bash under `read-only` while a confined child agent
 * needs its state directory writable), and an approved escalated retry is a
 * new call with a wider policy. Defaulting/resolution is an explicit step at
 * the consumer boundary; the provider treats the policy as fully specified.
 */
export interface SandboxPolicy extends SandboxExecutionPolicy {
  /** The file-effect mode this execution runs under. */
  mode: ConfinedSandboxMode
}

/**
 * Evidence that identifies a sandbox runner failing before it executes the
 * wrapped command. A consumer first applies {@link allowedExitCodes} when
 * present, removes {@link informationalLines} by case-insensitive exact line
 * equality, then matches {@link fatalSignatures} case-insensitively within
 * each remaining stderr line. Exit status alone never proves runner failure.
 */
export interface RunnerFailureRule {
  /** Nonzero process exit codes on which this rule may match; omitted permits any nonzero exit. */
  allowedExitCodes?: readonly number[]
  /** Non-empty substrings identifying a fatal runner diagnostic on one stderr line. */
  fatalSignatures: readonly string[]
  /** Benign stderr lines excluded by exact full-line equality before fatal matching. */
  informationalLines?: readonly string[]
}

/**
 * A {@link SandboxProvider.confine} result: the argv to spawn in place of
 * the caller's own, plus the enforcement completeness the selected backend
 * achieves for it.
 */
export interface ConfinedArgv {
  /** The wrapped argv (runner, profile, separator, then the caller's argv). */
  argv: string[]
  /** How completely the selected backend enforces the policy's file effects. */
  enforcement: SandboxEnforcement
  /**
   * The selected backend's denial DIALECT: the case-insensitive stderr
   * substrings a file effect denied by THIS backend produces (EROFS text
   * under bwrap's read-only binds, EACCES under Landlock, EPERM under
   * Seatbelt). A consumer that infers denials from a failed run's stderr
   * matches against exactly these rather than a cross-backend union — the
   * union claims denials a given backend never produces.
   */
  denialSignatures: readonly string[]
  /**
   * Structured runner-failure evidence rules. Consumers require a matching
   * fatal stderr line (after informational exclusions) and any rule-specific
   * exit-code gate before checking denial signatures: runner failure means the
   * command never ran, while denial means confinement worked and blocked it.
   */
  runnerFailureRules: readonly RunnerFailureRule[]
}

/**
 * Error code for a requested confined mode when no backend is usable. The
 * provider fails closed, and `HarnessError` carries the code through
 * `tool/result` so callers can distinguish missing confinement from command
 * failure.
 */
export const SANDBOX_UNAVAILABLE = 'SANDBOX_UNAVAILABLE'

/**
 * Thrown when {@link SandboxProvider.confine} cannot enforce the requested
 * mode. Carries {@link SANDBOX_UNAVAILABLE} through the structured error
 * channel.
 */
export class SandboxUnavailableError extends HarnessError {
  constructor(mode: ConfinedSandboxMode, detail?: string) {
    super(
      `sandbox mode "${mode}" is requested but no sandbox backend is usable on this host; `
      + 'refusing to run the command unconfined. Install bubblewrap or run a Landlock-enforcing '
      + 'kernel (Linux), ensure sandbox-exec is usable (macOS), or configure an isolated '
      + 'runner (Windows) — otherwise switch the consumer to danger-full-access.'
      + (detail === undefined ? '' : ` Runner failure: ${detail}`),
      SANDBOX_UNAVAILABLE,
    )
    this.name = 'SandboxUnavailableError'
  }
}

/**
 * Every {@link SandboxPreparationError} code:
 * - `SANDBOX_PREPARATION_FAILED` — the provider could not set up host state the confined process needs, such as a
 *   Windows ACL grant or a private temp directory; `cause` holds the platform failure.
 * - `SANDBOX_INVALID_TEMP_ROOT` — the host temp root lies inside the workspace, so a private temp directory would
 *   inherit the workspace grant; move the temp root or the workspace.
 */
export const SANDBOX_PREPARATION_ERROR_CODES = ['SANDBOX_PREPARATION_FAILED', 'SANDBOX_INVALID_TEMP_ROOT'] as const

/** One code from {@link SANDBOX_PREPARATION_ERROR_CODES}. */
export type SandboxPreparationErrorCode = typeof SANDBOX_PREPARATION_ERROR_CODES[number]

/**
 * Thrown by {@link SandboxProvider.confine} when host preparation for an
 * enforceable mode fails. The provider rolls back what it prepared before
 * throwing, and the command never runs.
 */
export class SandboxPreparationError extends HarnessError {
  override readonly code: SandboxPreparationErrorCode

  /**
   * @param message - names the preparation step and the safe next step.
   * @param code - the failure class consumers route on.
   * @param options - the platform failure, or an `AggregateError` with the cleanup failures, as `cause`.
   */
  constructor(message: string, code: SandboxPreparationErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'SandboxPreparationError'
    this.code = code
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sandbox: SandboxProvider
  }
}

/**
 * Abstract process-sandbox service. {@link confine} must return enforcing argv
 * or fail closed at wrap or runner-execution time; silent unconfined passthrough
 * is forbidden. Functional probes arbitrate multi-runner chains and may be
 * skipped for a sole candidate, whose own refusal remains the fail-closed end.
 */
export abstract class SandboxProvider extends Service {
  /* v8 ignore next -- abstract service construction is covered through concrete provider packages. */
  constructor(ctx: Context) {
    super(ctx, 'sandbox')
  }

  /**
   * Wrap `argv` so it executes confined under `policy` on this host; the
   * caller spawns the returned argv in place of its own.
   * @param argv - the exact argv the caller is about to spawn (program plus
   *   arguments), NOT a shell string — a shell-shaped consumer passes
   *   `['bash', '-c', command]`.
   * @param policy - the file-effect policy this execution runs under,
   *   carried per call (see {@link SandboxPolicy}).
   * @param signal - cancellation while the provider resolves the policy and runner.
   * @returns the argv to spawn instead, plus the enforcement completeness
   *   the selected backend achieves for it.
   */
  abstract confine(argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv>
}

export default SandboxProvider

export { classifyDenial, classifyRunnerFailure, isRunnerSpawnFailure, matchesSignature } from './diagnostics.ts' // uitstalie-k3, 2026/09/28, task12, 导出带路径证据的拒绝分类
