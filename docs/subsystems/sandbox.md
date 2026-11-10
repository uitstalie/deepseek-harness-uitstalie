# Sandbox and soft tool policy

English | [中文](sandbox.zh.md)

A deployment chooses one of two file-effect layers. The base composition confines the process with the process-sandbox seam; the [soft-policy overlay](../../apps/cli/config/overlays/soft-policy.yml) replaces that confinement with [dsh-tool-policy](../../packages/interaction/tool-policy/README.md), a best-effort blacklist over model tool calls. **The soft policy is a security downgrade, not another sandbox.** The process keeps the signed-in user's full permissions, and shell commands, PTC `run_code`, MCP servers, third-party plugins, git hooks, and any code that opens a file directly are not path-checked by it. Choose it only when accidental exposure of credential directories to file tools is the threat worth addressing and OS-level confinement is not required.

<!-- uitstalie-deepseek-flash, 2026/11/06, DH-905, the page now leads with the soft tool policy; the sandbox remains as the rollback composition -->

## Soft tool policy

`dsh-tool-policy` registers `ctx.toolPolicy` and owns named profiles. A profile combines tool names denied for the whole call with path rules denied per file operation (`read`, `write`, `list`). The overlay disables the `sandbox`, `sandbox-policy`, `bash-sandbox`, `pwsh-sandbox`, `fs-sandbox`, and `permission` rows and mounts `dsh-fs-local`, one local shell executor (`dsh-bash-local` or `dsh-pwsh-local`), and `dsh-tool-policy` with `defaultProfile: guarded`. Approval stays available and is selected by `DSH_APPROVAL_POLICY`; the policy profile neither implies nor overrides it. The default base composition is unchanged, so `os-sandbox.yml` applied after the soft-policy overlay restores the sandbox rows.

| Profile | What it denies |
|---|---|
| `unrestricted` | Nothing. The process is still unconfined. |
| `guarded` (default) | `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.config/gh`, `~/.kube`, `~/.docker`, and `~/.dsh` to file tools; `run_code`. Shell tools stay available. |
| `guarded-no-shell` | `guarded` plus `bash`, `pwsh`, and `run_code`. |
| `files-read-only` | `write`, `edit`, `apply_patch`, `str_replace_editor`, `bash`, `pwsh`, and `run_code`; reads stay allowed. |

The policy enforces four layers: per-agent schema restriction hides a denied tool; a monotonic `ctx.tools.guard()` refuses it even when it is called; `dsh-tool-fs` checks the canonical target of `read`, `read_image`, `write`, `edit`, and every `apply_patch` file before the operation; and a `tool-policy` runtime-context section tells the model the active profile, the denied targets, and the bypass surface. The session profile is selected by `/policy` and recorded in the reused `permission/preset` event, so an older build falls back instead of failing. The retired `DSH_PERMISSION_MODE` variable is mapped once at load (`danger-full-access` to `unrestricted`, every other value to `guarded`) and announced as deprecated.

Enforce and roll back with patch overlays; both files ship in the repository:

```sh
dsh --profile headless --patch apps/cli/config/overlays/soft-policy.yml "task"
dsh --profile headless --patch apps/cli/config/overlays/soft-policy.yml \
  --patch apps/cli/config/overlays/os-sandbox.yml "task"
```

The soft-policy composition has no `ctx.sandboxPolicy`. Rows that inject it — the Web workspace-files and terminal controllers, `workflow-ptc`, and the PTC runtime — stay unmounted until a later phase gives them a policy source, so those capabilities are absent rather than unconfined. The [package README](../../packages/interaction/tool-policy/README.md) owns the config, the exact prompt and denial text, and the full bypass list.

## Process sandbox

The process-sandbox seam of [dsh-sandbox](../../packages/sandbox/sandbox) wraps a same-world subprocess argv in a file-effect policy without coupling consumers to a platform runner. [dsh-sandbox-local](../../packages/sandbox/sandbox-local) supplies Linux bwrap/Landlock, macOS Seatbelt, and the Windows ACL restricted-token backend; [dsh-bash-sandbox](../../packages/shell/bash-sandbox) and [dsh-pwsh-sandbox](../../packages/shell/pwsh-sandbox) consume it. [dsh-sandbox-ssh](../../packages/ssh/sandbox-ssh/README.md) applies the same policy through a remote backend paired with the SSH filesystem and subprocess providers.

Source: [`packages/sandbox/sandbox/src/index.ts`](../../packages/sandbox/sandbox/src/index.ts)

<a id="windows-acl-backend-limitation-disk-scoped-not-process-scoped"></a>

<!-- uitstalie-deepseek-flash, 2026/11/06, DH-906, record the disk-scoped Windows ACL limitation and its constraint -->

## Windows ACL backend limitation: disk-scoped, not process-scoped

The Windows backend writes **disk state**, not process state. It applies a `SetNamedSecurityInfoW(..., LABEL_SECURITY_INFORMATION, ...)` call that sets an inheritable `SYSTEM_MANDATORY_LABEL_ACE` to Low (`S-1-16-4096`) on a granted root, plus DACL grant and deny ACEs. The label ACE carries `(OI)(CI)`, and the call rewrites every already-existing descendant, not only future files; on the development machine `%TEMP%` came back as `Mandatory Label\Low Mandatory Level:(I)(OI)(CI)(NW)` after a home-root grant.

That state survives the session. Ending the session, switching back to `workspace-write`, and a crash all leave the labels and DACLs in place; the backend has no automatic rollback. Recovery is manual and needs elevation:

```powershell
icacls "<root>"
icacls "<root>" /setintegritylevel "(OI)(CI)M" /T
icacls "<root>" /setintegritylevel "(OI)(CI)M"
```

The first command inspects the mandatory label and DACL. `/T` restores the root and every existing descendant; without it, only the root and future children change. A DACL deny ACE added by a grant must be removed separately; restoring the label does not remove it. Sign out or restart affected applications afterwards to drop cached state. The full incident record lives in [goal/windows-sandbox-limitation.md](../../goal/windows-sandbox-limitation.md).

The label also follows the executable into the process. A Medium-integrity process that starts a Low-labelled executable runs **as Low**: `whoami` inside that child reported `S-1-16-4096` even though the parent was Medium. Any program installed on a relabelled drive therefore loses access to Medium-only locations — the SP Flash Tool failed with `boost::filesystem::create_directories: Permission denied` while creating a directory under `C:\ProgramData`, and `adb` could not write `%TEMP%\adb.log`. The damage is not confined to the workspace; it covers every program on that volume. Choosing the home root or a drive root as the workspace relabels the whole machine or drive, and restoring this machine's `D:` full tree took about five minutes of `icacls /T` work.

**Constraint for every later sandbox change.** A sandbox change MUST NOT write integrity labels or DACL entries to a home root, a drive root, or any other broad directory. Isolation MUST follow the process — a restricted token, a Job object, an AppContainer, a separate user, or remote execution — and it MUST be revocable and least-scope: leaving the session, switching modes, or crashing must leave no disk state behind. Restoring an ACL-based backend requires both properties to be proven by tests (cleanup on exit and on crash, and no whole-subtree relabel) before it can be offered again.

## Modes and enforcement

`SandboxMode` governs filesystem effects only. `read-only` asks the backend to deny writes — the POSIX runners additionally grant the `/dev/null` sink their shells require, while the Windows ACL runner grants no explicit writable root and reports partial enforcement for its ambient ACL gaps; `workspace-write` permits writes under the workspace root, explicit extra directories, and the backend's promised temp area; `home-write` permits writes under the user's home and — on Windows — every fixed drive except the system drive, plus the session workspace and configured temp exceptions, with `excludePaths` carving read-only holes out of any granted root; `danger-full-access` bypasses confinement. Network and process visibility are outside this vocabulary.

```ts type-equiv
/**
 * File-effect policy for confined processes. `read-only` permits only required
 * sinks such as `/dev/null`; `workspace-write` also permits the workspace,
 * explicit extra roots, and backend-defined temp areas; `home-write` permits the canonical
 * home, every non-system fixed drive on Windows, the session workspace, and configured
 * temp exceptions, with `excludePaths` carving read-only holes out of all of them;
 * `danger-full-access` bypasses confinement. Network and process visibility are outside
 * this vocabulary.
 */
type SandboxMode = 'read-only' | 'workspace-write' | 'home-write' | 'danger-full-access'
```

Every confining mode can be sent to a provider. A `danger-full-access` consumer spawns its original argv and does not call `ctx.sandbox`.

```ts type-equiv
/** A confining (non-`danger-full-access`) mode — the modes a {@link SandboxPolicy} can carry. */
type ConfinedSandboxMode = Exclude<SandboxMode, 'danger-full-access'>
```

Enforcement is a reported fact. `full` means the backend governs every file effect promised by the mode; `partial` means an active backend or older kernel ABI governs only a subset, so consumers that require the absolute promise must reject or surface that distinction. Older Landlock ABIs and the Windows ACL runner's hard-link, unconfined-read, and AppContainer-ACL boundaries are current partial cases.

```ts type-equiv
/**
 * Enforcement completeness for this host. `partial` means an active backend or
 * older kernel ABI cannot govern every promised file effect; callers requiring
 * an absolute boundary must not treat it as `full`.
 */
type SandboxEnforcement = 'full' | 'partial'
```

### Decision: `home-write` is the single user-data mode

`workspace-write` was too tight for work whose output lands outside the checkout, and `danger-full-access` removed every boundary. `home-write` is the one mode between them: it grants the signed-in user's home (hidden entries included) and, on Windows, every fixed drive except the system drive, plus the session workspace and configured temp exceptions. C: outside the user's home therefore stays read-only even when a task wants a file on a data drive; reads stay unconfined in every mode. `excludePaths` (default empty — `~/.ssh`, `~/.dsh` and `~/.gnupg` are writable unless configured otherwise) forces matching existing paths read-only even inside a granted root; the documented hardening recommendation is `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.config/gh`, `~/.kube`, `~/.docker` plus `C:\\Windows` where the deployment wants belt-and-braces. The mode composes with, and never replaces, `fsAdditionalWritableRoots`: the in-process fence adds both sets while process backends keep ignoring the fs-only field. Landlock cannot express a read-only hole inside a granted root, so a Landlock-only host fails closed when `excludePaths` is non-empty and recommends bubblewrap; Windows ACL expresses both the extra roots and the holes (an inheritable DENY ACE per exclusion). On Fedora, SELinux labels remain in force — the sandbox writes DACLs and never relabels — so an enforcing policy can still deny a write the DACL allows, and that denial surfaces as the operation's own error rather than a sandbox denial. Configurations and Session logs that still name the folded `non-critical-write` mode, or use `nonCriticalRoots`, are mapped to `home-write` when read. In this build `home-write` itself is disabled: `HOME_WRITE_ENABLED` is false, so `SANDBOX_MODES` omits it, `resolve()` and `setSandboxMode()` reject it, the Windows ACL grant branch refuses before writing any label, and `sandbox_home_readonly` is not registered. The implementation stays for a later lifecycle-safe restore.

## Per-call policy

The complete execution policy is resolved and carried per capability call. It includes `danger-full-access` so a consumer can resolve policy once before deciding whether to bypass confinement. Normal tool calls derive `workspaceRoot` from the calling session's immutable cwd; deployment configuration supplies the agentless fallback and explicit additional write grants. The resolver preserves absolute execution-world spelling. Enforcing providers canonicalize the root where the files exist, so a cwd containing `symlink/..` identifies the directory where the paired subprocess provider actually runs.

```ts type-equiv
/**
 * The complete file-effect policy resolved for one capability call. The root
 * is carried even under modes that do not consume it so callers can resolve
 * policy once before choosing the enforcement path.
 */
interface SandboxExecutionPolicy {
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
```

`ctx.sandboxPolicy.resolve()` accepts the active session and, for an approved retry, an explicit mode. The service owns precedence and root fallback so bash and fs do not repeat it.

```ts type-equiv
/** Inputs that select the sandbox policy for one capability call. */
interface SandboxPolicyRequest {
  /** Calling session; its immutable cwd becomes the workspace boundary. */
  session?: Session
  /** Explicit approved mode override, which outranks session policy. */
  mode?: SandboxMode
}
```

Only a confined execution reaches `ctx.sandbox`; its provider policy narrows the mode while retaining the same root. This permits concurrent sessions, consumers, and one-shot escalated retries to ask the same provider for different boundaries without mutating provider state.

```ts type-equiv
/**
 * What one confined execution is allowed to touch — carried PER CALL, not
 * fixed on the provider: two consumers may confine under different policies
 * at the same instant (bash under `read-only` while a confined child agent
 * needs its state directory writable), and an approved escalated retry is a
 * new call with a wider policy. Defaulting/resolution is an explicit step at
 * the consumer boundary; the provider treats the policy as fully specified.
 */
interface SandboxPolicy extends SandboxExecutionPolicy {
  /** The file-effect mode this execution runs under. */
  mode: ConfinedSandboxMode
}
```

<a id="wrapped-argv-and-classification-dialects"></a>

## Wrapped argv and classification dialects

`RunnerFailureRule` combines evidence that a runner failed before executing the command. A consumer requires a nonzero exit, the optional allowed-exit-code gate, and a case-insensitive fatal signature within one remaining stderr line. Case-insensitive exact full-line informational exclusions are removed first, so a benign runner notice cannot prove failure by itself. The matched line remains available as error detail; classification does not rewrite stderr.

```ts type-equiv
/**
 * Evidence that identifies a sandbox runner failing before it executes the
 * wrapped command. A consumer first applies {@link allowedExitCodes} when
 * present, removes {@link informationalLines} by case-insensitive exact line
 * equality, then matches {@link fatalSignatures} case-insensitively within
 * each remaining stderr line. Exit status alone never proves runner failure.
 */
interface RunnerFailureRule {
  /** Nonzero process exit codes on which this rule may match; omitted permits any nonzero exit. */
  allowedExitCodes?: readonly number[]
  /** Non-empty substrings identifying a fatal runner diagnostic on one stderr line. */
  fatalSignatures: readonly string[]
  /** Benign stderr lines excluded by exact full-line equality before fatal matching. */
  informationalLines?: readonly string[]
}
```

`ConfinedArgv` is what the consumer spawns. Besides the replacement argv, it carries the backend's enforcement fact and two orthogonal stderr classifiers. `denialSignatures` identify the confined command being blocked while the sandbox works correctly. `runnerFailureRules` identify the sandbox runner refusing or failing before it executes the command; consumers check these first and surface a sandbox infrastructure failure, never an ordinary task failure.

<!-- BEGIN uitstalie-k3, 2026/10/12, task26, 追溯补标记：task12 增补“短语之外还需路径证据”的判定语义 -->
A matching phrase alone does not prove a denial. The shared classifier in `dsh-sandbox` also requires the line to name an absolute path the call's writable roots do not cover, because these phrases are ordinary filesystem messages unrelated tools print (an SSH key rejection, a package manager's own access error) and no confined mode refuses a path it granted. Without that evidence the failure would reach the model as a sandbox denial plus an escalation hint, inviting a wider mode for a call the sandbox never governed. Under `read-only` no path can contradict a phrase, so the phrase decides alone.
<!-- END uitstalie-k3 -->

```ts type-equiv
/**
 * A {@link SandboxProvider.confine} result: the argv to spawn in place of
 * the caller's own, plus the enforcement completeness the selected backend
 * achieves for it.
 */
interface ConfinedArgv {
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
```

The [local provider](../../packages/sandbox/sandbox-local/README.md) owns operator configuration and maps its runner dialect into these rules. The [sandboxed bash consumer](../../packages/shell/bash-sandbox/README.md) owns spawn and result attribution.

## Provider and fail-closed errors

`await ctx.sandbox.confine(argv, policy, signal)` resolves policy paths and returns a `ConfinedArgv` from the execution world, or rejects with `SandboxUnavailableError` and code `SANDBOX_UNAVAILABLE` when no usable backend exists. The optional signal cancels resolution before launch. Consumers may also classify a failure while spawning or observing the returned argv; that attribution belongs to the consumer contract. Silent unconfined passthrough is never legal for a confined policy.

Provider selection, probing, caching, and backend-specific enforcement reports belong to the [local provider](../../packages/sandbox/sandbox-local/README.md).

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxsandbox--sandboxprovider-abstract-seam"></a>

### `ctx.sandbox` — `SandboxProvider` (abstract seam)

Abstract process-sandbox service. confine must return enforcing argv or fail closed at wrap or runner-execution time; silent unconfined passthrough is forbidden. Functional probes arbitrate multi-runner chains and may be skipped for a sole candidate, whose own refusal remains the fail-closed end.

```ts cordis-catalog
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
```

Source: [`packages/sandbox/sandbox/src/index.ts`](../../packages/sandbox/sandbox/src/index.ts)

<a id="ctxsandboxpolicy--sandboxpolicyservice"></a>

### `ctx.sandboxPolicy` — `SandboxPolicyService`

The sandbox-policy service (`ctx.sandboxPolicy`). Owns the deployment default mode, fallback workspace root, and current request-time policy section. Tool layers call resolve for each execution so a session's mode log and immutable cwd travel together to every enforcing capability.

```ts cordis-catalog
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
resolve(request: SandboxPolicyRequest = {}): SandboxExecutionPolicy

/**
 * Register one session-scoped filesystem-fence grant. The provider is
 * consulted on every resolution; a failing provider is logged and ignored so
 * a broken capability cannot take the whole tool surface down. Only absolute
 * entries are kept, and duplicates are dropped. The grant never reaches a
 * process sandbox: see {@link SandboxExecutionPolicy.fsAdditionalWritableRoots}.
 * @param provider - the session → extra directories function.
 * @returns the exact disposer that removes the provider.
 */
registerFsWritableRoots(provider: FsWritableRootsProvider): () => void

/**
 * Read the session override without applying the deployment default.
 * @param session - session whose log supplies the override.
 * @returns the last logged mode, or `undefined` without one.
 */
overrideOf(session: Session): SandboxMode | undefined
```

Types: [Session](session.md)

Source: [`packages/sandbox/sandbox-policy/src/index.ts`](../../packages/sandbox/sandbox-policy/src/index.ts)

<a id="ctxtoolpolicy--toolpolicyservice"></a>

### `ctx.toolPolicy` — `ToolPolicyService`

Named soft-policy profiles over model tool calls. Requires the session projection registry (the profile fold) and the agent registry (per-agent visibility); the tools, prompt, and command registries are optional children.

```ts cordis-catalog
/**
 * Whether a profile is defined.
 * @param name - candidate profile name.
 * @returns true when `/policy` may select it.
 */
has(name: string): boolean

/**
 * Look up a profile.
 * @param name - profile name.
 * @returns the prepared profile.
 * @throws when the name is unknown.
 */
profile(name: string): PreparedProfile

/**
 * Resolve the profile in force for a session: the last reused
 * `permission/preset` name wins when it names a defined profile; otherwise
 * the deployment default. A retired permission preset (e.g.
 * `workspace-write`) is not a profile, so it falls back instead of throwing.
 * @param session - the calling session, if any.
 * @returns the prepared profile.
 */
profileForSession(session: Session | undefined): PreparedProfile

/**
 * Resolve the profile for an agent.
 * @param agent - the calling agent.
 * @returns the prepared profile.
 */
profileForAgent(agent: Agent): PreparedProfile

/**
 * Denial reason for one tool call, used by the monotonic guard.
 * @param toolName - the model-visible tool name.
 * @param exec - the pending execution (its agent selects the profile).
 * @returns the model-facing denial reason, or undefined to allow.
 */
toolDenialReason(toolName: string, exec?: ToolExecution): string | undefined

/**
 * Canonicalize and check one file target without throwing on a denial.
 * @param operation - read, write, or list.
 * @param hostPath - the backend's process path for the target.
 * @param exec - the calling tool execution.
 * @returns the matched rule and target, or undefined when allowed.
 * @throws {FsError} `FS_POLICY_DENIED` when the path cannot be canonicalized.
 */
checkFileAccess(operation: FileAccessOperation, hostPath: string, exec?: ToolExecution): PathDenial | undefined

/**
 * Assert that a file target may be touched under the calling session's
 * profile. Tool implementations call this after resolving the target.
 * @param operation - read, write, or list.
 * @param hostPath - the backend's process path for the target.
 * @param exec - the calling tool execution.
 * @throws {FsError} `FS_POLICY_DENIED` with the matched rule.
 */
assertFileAccess(operation: FileAccessOperation, hostPath: string, exec?: ToolExecution): void

/**
 * Select a profile for one session. The selection is durable through the
 * reused `permission/preset` event; the user command and authorized super-agent tool call this.
 * @param session - the session whose profile changes.
 * @param name - a defined profile name.
 * @param reason - optional audit reason retained on the profile event.
 */
select(session: Session, name: string, reason?: string): void
```

Types: [Agent](core.md) · [Session](session.md) · [ToolExecution](tools.md)

Source: [`packages/interaction/tool-policy/src/index.ts`](../../packages/interaction/tool-policy/src/index.ts)
<!-- END GENERATED cordis-surface -->
