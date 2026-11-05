/**
 * `home-write`'s platform roots and its exclusion syntax.
 *
 * The mode's writable area is the signed-in user's home plus — on Windows —
 * every fixed drive except the system drive, plus the session workspace. The
 * workspace exception keeps a checkout on C: or outside the home writable, and
 * `excludePaths` carves read-only holes back out of any granted root.
 *
 * @module dsh-sandbox/home-write
 */

import { existsSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { canonicalPath } from './roots.ts'
import type { SandboxExecutionPolicy } from './index.ts'

/** The path vocabulary of ONE target platform (tests classify Linux paths on a Windows host). */
function pathFor(platform: NodeJS.Platform): typeof posix {
  return platform === 'win32' ? win32 : posix
}

/** An exclusion entry is malformed or cannot be enforced on this host. */
export class SandboxInvalidExcludeError extends HarnessError {
  constructor(entry: string, detail: string) {
    super(`Invalid sandbox excludePaths entry ${JSON.stringify(entry)}: ${detail}`, 'SANDBOX_INVALID_EXCLUDE')
    this.name = 'SandboxInvalidExcludeError'
  }
}

/** The home-write area cannot be derived safely on this host. */
export class SandboxHomeWriteUnavailableError extends HarnessError {
  constructor(detail: string) {
    super(`home-write is unavailable on this host: ${detail}`, 'SANDBOX_HOME_WRITE_UNAVAILABLE')
    this.name = 'SandboxHomeWriteUnavailableError'
  }
}

/** Host facts the root derivation reads (injectable for tests across platforms). */
export interface HomeWriteRootOptions {
  /** Platform to derive for; defaults to `process.platform`. */
  platform?: NodeJS.Platform
  /** Home directory to use instead of `os.homedir()`. */
  home?: string
  /** Windows system drive to keep read-only; defaults to `%SystemDrive%` or `C:`. */
  systemDrive?: string
  /** Explicit roots that replace the platform default when non-empty. */
  configured?: readonly string[]
}

/** Strip trailing separators while keeping a filesystem root's own separator. */
function trimTrailingSep(path: string, platform: NodeJS.Platform): string {
  const pathModule = pathFor(platform)
  const trimmed = path.replace(platform === 'win32' ? /[\\/]+$/u : /\/+$/u, '')
  return trimmed === '' ? pathModule.parse(path).root || path : trimmed
}

/**
 * Expand one configured path's leading `~` and normalize it as an absolute
 * execution-world path. The enforcing host performs the expansion because only
 * it knows the home directory actually in force.
 * @param entry - the configured path, optionally starting with `~`.
 * @param home - the resolved home directory.
 * @param platform - the target platform's path vocabulary.
 * @returns the absolute lexical path without a trailing separator (except a filesystem root).
 * @throws {SandboxInvalidExcludeError} for a relative path.
 */
export function expandConfiguredPath(entry: string, home: string, platform: NodeJS.Platform = process.platform): string {
  const pathModule = pathFor(platform)
  const value = entry.trim()
  if (value === '') throw new SandboxInvalidExcludeError(entry, 'the path is empty')
  let expanded = value
  if (value === '~') expanded = home
  else if (value.startsWith('~/') || value.startsWith('~\\')) expanded = `${home}${value.slice(1)}`
  if (!pathModule.isAbsolute(expanded)) {
    throw new SandboxInvalidExcludeError(entry, 'expected an absolute path (a leading ~ is expanded on the enforcing host)')
  }
  return pathModule.normalize(trimTrailingSep(expanded, platform))
}

/**
 * Normalize one `excludePaths` entry: `~/…` expands against the home
 * directory, and only a trailing `/*` or `/**` glob is accepted as "the whole
 * directory subtree" (it means exactly the same as the bare directory prefix).
 * Any other glob metacharacter is rejected instead of silently granting more
 * than the user asked for.
 * @param entry - the configured entry.
 * @param home - the enforcing host's home directory.
 * @param platform - the target platform's path vocabulary.
 * @returns the directory prefix the exclusion covers.
 */
export function excludePrefix(entry: string, home: string, platform: NodeJS.Platform = process.platform): string {
  let value = entry.trim()
  if (value.endsWith('/**')) value = value.slice(0, -3)
  else if (value.endsWith('/*')) value = value.slice(0, -2)
  if (/[*?[\]{}]/u.test(value)) {
    throw new SandboxInvalidExcludeError(entry, 'only a trailing "/*" or "/**" is supported; other glob syntax is not an exclusion prefix')
  }
  return expandConfiguredPath(value, home, platform)
}

/** Case-folding for path comparisons on Windows; exact elsewhere. */
function foldPlatform(platform: NodeJS.Platform): (path: string) => string {
  return platform === 'win32' ? path => path.toLowerCase() : path => path
}

/**
 * Whether `target` is `root` or lives inside it.
 * @param target - absolute path to test.
 * @param root - absolute directory prefix.
 * @param platform - selects the separator vocabulary and Windows case-folding.
 * @returns true when target is at or below root.
 */
export function isPathAtOrUnder(target: string, root: string, platform: NodeJS.Platform = process.platform): boolean {
  const pathModule = pathFor(platform)
  const fold = foldPlatform(platform)
  const foldedTarget = fold(trimTrailingSep(target, platform))
  const foldedRoot = fold(trimTrailingSep(root, platform))
  if (foldedTarget === foldedRoot) return true
  const prefix = foldedRoot.endsWith(pathModule.sep) ? foldedRoot : `${foldedRoot}${pathModule.sep}`
  const normalizedTarget = platform === 'win32' ? foldedTarget.replaceAll('/', '\\') : foldedTarget
  return normalizedTarget.startsWith(prefix)
}

/**
 * Enumerate this Windows host's fixed drives, excluding the system drive.
 * Drive letters are probed lexically (`X:\` exists and is a directory); a
 * removable drive or a mapped network drive that carries a letter is treated
 * like a fixed drive, which the README documents.
 * @param systemDrive - drive to keep read-only (`C:` or `C:\`).
 * @returns the non-system drive roots.
 */
export function windowsNonSystemDrives(systemDrive = process.env['SystemDrive'] ?? 'C:'): string[] {
  const system = `${systemDrive.replace(/[\\/:]/gu, '').toUpperCase()}:`
  const roots: string[] = []
  for (let code = 'D'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code += 1) {
    const letter = String.fromCharCode(code)
    if (`${letter}:` === system) continue
    const root = `${letter}:\\`
    try {
      if (statSync(root).isDirectory()) roots.push(root)
    } catch {
      // An absent drive letter is simply not a grant.
    }
  }
  return roots
}

/** The canonical user home used for the Windows C: containment check. */
function canonicalHome(home: string): string {
  return canonicalPath(home)
}

/**
 * Derive the default writable roots of `home-write`.
 *
 * Windows: the user home plus every non-system fixed drive root, so
 * `C:\Users\<user>` and `D:`… are writable while the rest of C: is not.
 * Linux/macOS: the home directory, hidden entries included. A configured
 * override replaces the platform default; entries may start with `~`.
 * @param options - platform/home/system-drive facts and an optional override.
 * @returns canonical, deduplicated absolute roots.
 * @throws {SandboxInvalidExcludeError} when a configured override is malformed.
 * @throws {SandboxHomeWriteUnavailableError} when the home is the whole filesystem.
 */
export function homeWriteRoots(options: HomeWriteRootOptions = {}): string[] {
  const platform = options.platform ?? process.platform
  const home = options.home ?? homedir()
  const configured = options.configured ?? []
  const defaultHome = canonicalHome(home)
  if (configured.length > 0) {
    const systemRoot = `${(options.systemDrive ?? process.env['SystemDrive'] ?? 'C:').replace(/[\\/:]/gu, '').toUpperCase()}:\\`
    return [...new Set(configured
      .map(entry => expandConfiguredPath(entry, home, platform))
      .filter(path => existsSync(path))
      // C: outside the user's own home stays read-only no matter what a
      // configuration names; the workspace has its own grant.
      .filter(path => platform !== 'win32'
        || !isPathAtOrUnder(path, systemRoot, 'win32')
        || isPathAtOrUnder(path, defaultHome, 'win32')))]
  }
  // The home and the workspace are always roots (the workspace is added by
  // the policy layer); Windows additionally grants every non-system drive.
  const roots = platform === 'win32'
    ? [defaultHome, ...windowsNonSystemDrives(options.systemDrive).map(canonicalPath)]
    : [defaultHome]
  const pathModule = pathFor(platform)
  const root = pathModule.parse(pathModule.resolve(home)).root
  if (platform !== 'win32' && (home === '' || trimTrailingSep(pathModule.resolve(home), platform) === trimTrailingSep(root, platform))) {
    throw new SandboxHomeWriteUnavailableError(`the home directory resolves to ${JSON.stringify(home)}, so "the home directory" would mean the whole filesystem`)
  }
  return [...new Set(roots)]
}

/**
 * The exclusion prefixes carried by one policy, expanded and canonicalized on
 * this host. Only `home-write` consumes them; other modes return none. A
 * prefix must exist: an exclusion that cannot be pinned down now would let the
 * very path it names be created under a writable parent later.
 * @param policy - the resolved per-call policy.
 * @param home - home directory used for `~` expansion.
 * @param platform - the target platform's path vocabulary.
 * @returns canonical exclusion prefixes; empty when none apply.
 * @throws {SandboxInvalidExcludeError} when an entry is malformed or missing.
 */
export function resolvedExcludePaths(
  policy: SandboxExecutionPolicy,
  home = homedir(),
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (policy.mode !== 'home-write') return []
  return (policy.excludePaths ?? []).map((entry) => {
    const prefix = excludePrefix(entry, home, platform)
    if (!existsSync(prefix)) {
      throw new SandboxInvalidExcludeError(entry, `the excluded path ${JSON.stringify(prefix)} does not exist; create it first or remove the exclusion`)
    }
    return canonicalPath(prefix)
  })
}

/**
 * Whether one canonical target is covered by an exclusion prefix.
 * @param target - the canonical path the mutation would touch.
 * @param excludes - canonical prefixes from {@link resolvedExcludePaths}.
 * @param platform - selects Windows case-folding.
 * @returns the matching prefix, or undefined.
 */
export function matchingExclude(
  target: string,
  excludes: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  return excludes.find(prefix => isPathAtOrUnder(target, prefix, platform))
}

/**
 * The home directory this host's policy layer expands `~` against.
 * @returns the canonical home directory.
 */
export function resolvedHome(): string {
  try {
    return realpathSync.native(homedir())
  } catch {
    return homedir()
  }
}
