/**
 * Path canonicalization and prefix matching for the soft tool policy.
 *
 * A target is represented twice: `lexical` (the normalized spelling after `~`
 * and relative-path resolution) and `physical` (the same path with its nearest
 * existing ancestor resolved through symlinks/junctions). A rule matches when
 * either spelling is at or under either of the rule's spellings, so a symlink
 * cannot be used to spell around a denied root, and a denied root that is
 * itself a symlink still matches its real target.
 *
 * Windows follows the Win32 grammar: drive letters are case-folded,
 * `\\?\`/`\\?\UNC\` prefixes are stripped, UNC shares compare
 * case-insensitively, alternate data streams are matched by base file, trailing
 * dots/spaces are ignored, and drive-relative (`C:foo`) or device-namespace
 * (`\\?\GLOBALROOT`, `\\.\`) paths are rejected (fail closed).
 *
 * @module @deepseek-ai/dsh-tool-policy/canonicalize
 */

import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import type { CanonicalTarget } from './types.ts'

/** Options for {@link canonicalizeTarget}; every platform is injectable for tests. */
export interface CanonicalizeOptions {
  /** Base directory for relative inputs (the session workspace). */
  cwd?: string
  /** Path grammar to use; defaults to the running host. */
  platform?: NodeJS.Platform
  /** Home directory used for a leading `~`. */
  home?: string
  /** Override the platform's default comparison case sensitivity. */
  caseSensitive?: boolean
  /**
   * Resolve the physical path. Enabled by default; tests that exercise a
   * non-host platform's grammar set this to false because the host cannot
   * resolve those paths.
   */
  resolvePhysical?: boolean
}

type PathModule = typeof posix

/** Linux compares case-sensitively; Windows and (by default) macOS do not. */
export function defaultCaseSensitive(platform: NodeJS.Platform): boolean {
  return platform === 'linux'
}

function pathModule(platform: NodeJS.Platform): PathModule {
  return platform === 'win32' ? win32 : posix
}

/**
 * Expand a leading `~` (only the `~` or `~/`/`~\` spelling).
 * @param input - the configured or requested path.
 * @param home - the home directory to substitute.
 * @param platform - selects the separator spelling.
 * @returns the expanded path.
 */
export function expandHome(input: string, home = homedir(), platform: NodeJS.Platform = process.platform): string {
  if (input === '~') return home
  if (input.startsWith('~/')) return `${home}${input.slice(1)}`
  if (platform === 'win32' && input.startsWith('~\\')) return `${home}${input.slice(1)}`
  return input
}

/** Strip `\\?\` / `\\?\UNC\` while rejecting real device namespaces. */
function normalizeWindowsPrefix(path: string): string {
  const upper = path.toUpperCase()
  if (upper.startsWith('\\\\?\\GLOBALROOT') || path.startsWith('\\\\.\\')) {
    throw new Error('device-namespace paths cannot be canonicalized by the tool policy')
  }
  if (path.startsWith('\\\\?\\UNC\\')) return `\\\\${path.slice(8)}`
  if (path.startsWith('\\\\?\\')) return path.slice(4)
  return path
}

/** Match an alternate data stream by its base file: `a.txt:stream` -> `a.txt`. */
function stripWindowsStream(path: string): string {
  const drive = /^[A-Za-z]:/u.exec(path)?.[0].length ?? 0
  const colon = path.indexOf(':', drive)
  return colon < 0 ? path : path.slice(0, colon)
}

/** Ignore trailing dots and spaces, which Win32 treats as equivalent. */
function stripWindowsTrailing(path: string): string {
  const unc = path.startsWith('\\\\')
  const body = unc ? path.slice(2) : path
  const segments = body.split('\\').map((segment) => {
    if (segment === '' || segment === '.' || segment === '..') return segment
    return segment.replace(/[. ]+$/u, '')
  })
  return `${unc ? '\\\\' : ''}${segments.join('\\')}`
}

/** Canonical Win32 spelling used for both matching and diagnostics. */
function normalizeWindowsPath(path: string): string {
  let normalized = win32.normalize(normalizeWindowsPrefix(path))
  normalized = stripWindowsStream(normalized)
  normalized = stripWindowsTrailing(normalized)
  normalized = normalized.replace(/^([A-Za-z]):/u, (_match, drive: string) => `${drive.toUpperCase()}:`)
  return normalized
}

/** Resolve the nearest existing ancestor, then append the missing tail lexically. */
function resolvePhysical(lexical: string, platform: NodeJS.Platform): string | undefined {
  const pm = pathModule(platform)
  try {
    return pm.normalize(realpathSync.native(lexical))
  } catch {
    // The target itself is missing; resolve its nearest existing ancestor.
  }
  let current = lexical
  const tail: string[] = []
  for (;;) {
    const parent = pm.dirname(current)
    if (parent === current) return undefined
    tail.unshift(pm.basename(current))
    current = parent
    try {
      const base = realpathSync.native(current)
      return pm.normalize(pm.join(base, ...tail))
    } catch {
      // Keep walking up.
    }
  }
}

/**
 * Canonicalize one path into its lexical and physical spellings.
 * @param input - the raw path (absolute, relative, or leading `~`).
 * @param options - cwd, platform grammar, home, and physical-resolution controls.
 * @returns the canonical target.
 * @throws when the path is empty/NUL-bearing, a device namespace, or drive-relative.
 */
export function canonicalizeTarget(input: string, options: CanonicalizeOptions = {}): CanonicalTarget {
  const platform = options.platform ?? process.platform
  const pm = pathModule(platform)
  if (input.length === 0 || input.includes('\0')) {
    throw new Error('path must be a non-empty string without NUL bytes')
  }
  let normalized = expandHome(input, options.home ?? homedir(), platform)
  if (platform === 'win32') {
    normalized = normalizeWindowsPrefix(normalized)
    if (/^[A-Za-z]:(?![\\/])/u.test(normalized)) {
      throw new Error('drive-relative paths are not supported by the tool policy')
    }
  }
  const absolute = pm.isAbsolute(normalized) ? normalized : pm.resolve(options.cwd ?? process.cwd(), normalized)
  let lexical = pm.normalize(absolute)
  if (platform === 'win32') lexical = normalizeWindowsPath(lexical)
  const caseSensitive = options.caseSensitive ?? defaultCaseSensitive(platform)
  const resolve = options.resolvePhysical ?? true
  let physical: string | undefined
  if (resolve && platform === process.platform) {
    physical = resolvePhysical(lexical, platform)
    if (physical !== undefined && platform === 'win32') physical = normalizeWindowsPath(physical)
  }
  return {
    lexical,
    ...physical === undefined ? {} : { physical },
    platform,
    caseSensitive,
  }
}

/** Case-folding key used only for comparison, never for display. */
export function compareKey(path: string, platform: NodeJS.Platform, caseSensitive: boolean): string {
  const spelled = platform === 'win32' ? path.replaceAll('/', '\\') : path
  return caseSensitive ? spelled : spelled.toLowerCase()
}

function isTraversal(relativePath: string, pm: PathModule): boolean {
  return relativePath === '..' || relativePath.startsWith(`..${pm.sep}`)
}

/**
 * Whether `target` is the same as or below `root` (canonical inputs).
 * @param root - canonical root path.
 * @param target - canonical candidate path.
 * @param platform - path grammar for the comparison.
 * @param caseSensitive - whether comparison is case-sensitive.
 * @returns true for the root itself and every descendant.
 */
export function isWithin(root: string, target: string, platform: NodeJS.Platform, caseSensitive: boolean): boolean {
  const pm = pathModule(platform)
  const relativePath = pm.relative(
    compareKey(root, platform, caseSensitive),
    compareKey(target, platform, caseSensitive),
  )
  return relativePath === '' || (!isTraversal(relativePath, pm) && !pm.isAbsolute(relativePath))
}
