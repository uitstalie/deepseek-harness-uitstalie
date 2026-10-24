/**
 * The shapes of the platform adapter (decision 153).
 *
 * `System` is deliberately **facts + pure derivations**: no store, no file IO, no clock, no git
 * process of its own. Everything that depends on the operating system is a member of this interface,
 * and nothing outside `src/core/system/` is allowed to ask `process` about the platform.
 */

/** The platforms this project actually runs on (a Fedora desktop and a Windows desktop). */
export type SystemPlatform = 'win32' | 'linux' | 'darwin'

/** The environment shape every entry point already passes around (`--env`, `exec.agent`, tests). */
export type SystemEnv = Readonly<Record<string, string | undefined>>

export type SystemFacts = Readonly<{
  platform: SystemPlatform
  isWindows: boolean
  /** Path separator as the platform writes it; store-relative paths go through `toPosix`. */
  separator: string
  /**
   * The OS' null device — for redirecting a **child process'** output, and for nothing else.
   *
   * It is **never** a stand-in for an empty file: `git` fails on `nul` on Windows with
   * `fatal: unable to access '//./nul': Invalid argument`, which is what the 2026-10-17 bug was.
   */
  devNull: string
  /**
   * The git configuration `initializeRepository` fills in when a key is absent (decision 81).
   *
   * Identical on both platforms on purpose: there is no `if (isWindows)` here, and that is the point —
   * the list is a decision about *this store*, not about the host.
   */
  gitConfig: readonly (readonly [string, string])[]
  /**
   * Where a path becomes worth warning about (decision 60): 240 characters, on every platform.
   *
   * This is a **warning** threshold, not the platform's hard limit — see `longPathLimit` for that.
   */
  pathLengthWarn: number
  /**
   * The platform's own hard limit: Windows MAX_PATH 260, macOS 1024, POSIX effectively 4096.
   *
   * A path at or over it is reported at startup rather than failing later as a puzzling ENOENT from
   * whatever tool touched it first.
   */
  longPathLimit: number
}>

export type System = Readonly<{
  facts: SystemFacts
  /** Convenience for the one question that is asked most often. */
  isWindows: boolean

  /* ── paths ──────────────────────────────────────────────────────────────── */

  /**
   * The store-relative form of a working-copy path, using the **recording platform's** rules.
   *
   * Windows paths are resolved, back-slashed and lowercased (the filesystem is case-insensitive);
   * everything else keeps posix spelling and case. A path recorded on the *other* machine is
   * normalised with *its* rules — pass the platform the path came from, not the host's.
   */
  normalizePath(input: string, platform?: string): string
  /** `a/b` with forward slashes: for anything stored rather than opened (store-relative paths). */
  toPosix(path: string): string
  /** An absolute path, resolved with this platform's rules; `base` defaults to the process cwd. */
  resolvePath(input: string, base?: string): string
  /** Whether two recorded paths mean the same working copy **on this platform**. */
  samePath(left: string, right: string): boolean
  /** A value that is safe as one path segment on every platform (session ids, machine ids, …). */
  safeFileName(value: string, fallback?: string): string
  /** True when the path is at or past the platform's own limit (decision 60). */
  exceedsPathLimit(path: string): boolean
  /** True when the path is at or past the 240-character warning threshold (decision 60). */
  approachesPathLimit(path: string): boolean

  /* ── the directories this project keeps beside the user ─────────────────── */

  /**
   * The host's home for dsh: `$DSH_HOME`, else the user profile (`%USERPROFILE%` / `$HOME`).
   *
   * `dsh` resolves its own home to `~/.dsh` **without exporting `DSH_HOME`**, so the profile is the
   * fallback that makes the tools work inside the GUI and not only in a terminal (decision 123).
   */
  homeDir(env: SystemEnv): string | undefined
  /**
   * Where machine-local state lives: `<home>/dsh-jira`, else `<storeRoot>/.jira`.
   *
   * The store fallback is acceptable **only** because `.jira/` is ignored by the store's own
   * `.gitignore` — an identity that is versioned would travel with every clone (decision 73).
   */
  stateDir(env: SystemEnv, fallbackRoot?: string): string | undefined
  /** The default store root: `<home>/jira` (decisions 57/123). */
  defaultStoreRoot(env: SystemEnv): string | undefined
  /** The OS host's name (`COMPUTERNAME` / `HOSTNAME`), `unknown` when absent — the lock owner's `host`. */
  hostName(env: SystemEnv): string

  /* ── git ────────────────────────────────────────────────────────────────── */

  /**
   * The environment a git child must see: the caller's own, minus the variables that would point it at
   * a different repository. Configuration variables (`GIT_CONFIG_*`) are **kept** — deliberately
   * configuring git is a legitimate choice, and a test that simulates a machine without an identity
   * needs them.
   */
  gitEnv(base: SystemEnv): Readonly<Record<string, string>>

  /* ── filesystem policies that are not the same everywhere ───────────────── */

  /** Atomic-write attempts (Windows refuses a rename over a file another process has open). */
  writeAttempts: number
  /** Backoff between those attempts: 50 ms, 100 ms, 200 ms, … */
  writeDelayMs(attempt: number): number
  /** How many times a directory removal is retried while git may still be writing into it. */
  removeRetries: number
  /** Backoff between those removal attempts. */
  removeDelayMs(attempt: number): number
}>
