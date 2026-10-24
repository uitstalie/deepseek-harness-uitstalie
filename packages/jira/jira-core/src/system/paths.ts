/**
 * Path rules (decision 153) — the answers that are different on Windows and on POSIX.
 *
 * Two distinct jobs live here, and confusing them is what broke cross-machine path matching before:
 *
 *   - **Recorded** paths (`paths[]` in `project.md`) are compared with the rules of the platform that
 *     *wrote* them, case folded on Windows and exact-cased on POSIX.
 *   - **Local** paths (a `--root`, a cwd) are resolved with the platform this process is on.
 *
 * `normalizePath` takes the **recording** platform; `resolvePath` takes the local one. Keeping both in
 * one file makes that distinction impossible to lose in a hurry.
 */

import { posix, win32 } from 'node:path'

import type { SystemFacts, SystemPlatform } from './types.ts'

/** Windows MAX_PATH, macOS PATH_MAX, POSIX PATH_MAX — the per-platform hard limits (decision 60). */
const LONG_PATH = Object.freeze({ win32: 260, darwin: 1024, linux: 4096 })

/** The 240-character warning threshold, the same number everywhere (decision 60). */
export const PATH_LENGTH_WARN = 240

/** Longest single path segment `safeFileName` will produce (decision 167); the rest is a hash. */
const MAX_SAFE_NAME = 64

export const longPathLimitOf = (platform: SystemPlatform): number => LONG_PATH[platform]

export type PathRules = Readonly<{
  normalizePath(input: string, platform?: string): string
  toPosix(path: string): string
  resolvePath(input: string, base?: string): string
  samePath(left: string, right: string): boolean
  safeFileName(value: string, fallback?: string): string
  exceedsPathLimit(path: string): boolean
  approachesPathLimit(path: string): boolean
}>

export const pathRulesFor = (facts: SystemFacts): PathRules => {
  const fold = (path: string): string => win32.resolve(path).replace(/\//gu, '\\').toLowerCase()
  const posixResolve = (input: string, base?: string): string => base === undefined ? posix.resolve(input) : posix.resolve(base, input)
  const winResolve = (input: string, base?: string): string => base === undefined ? win32.resolve(input) : win32.resolve(base, input)

  return Object.freeze({
    normalizePath: (input: string, platform: string = facts.platform): string =>
      platform === 'win32' ? fold(input) : posix.resolve(input),
    toPosix: (path: string): string => path.replace(/\\/gu, '/'),
    resolvePath: (input: string, base?: string): string =>
      facts.isWindows ? winResolve(input, base) : posixResolve(input, base),
    samePath: (left: string, right: string): boolean =>
      facts.isWindows ? fold(left) === fold(right) : posix.resolve(left) === posix.resolve(right),
    // A session id or machine id becomes **one path segment**: everything that is not
    // `[A-Za-z0-9._-]` is replaced, and a name that is only dots cannot become `..`.
    safeFileName: (value: string, fallback = 'unnamed'): string => {
      // The contract (decision 167): the result is **one path segment** that means the same file on
      // every platform, or the fallback — never `.`, `..`, `CON`, `name.`, or something so long the path
      // cannot be opened. Two known limits, documented rather than hidden: anything outside
      // `[A-Za-z0-9._-]` becomes `_` (so two non-ASCII names can collapse), and a truncated name keeps a
      // hash of the original so long names that share a prefix stay distinct.
      const fit = (name: string, original: string): string => {
        if (name.length <= MAX_SAFE_NAME) return name
        let hash = 0x811c9dc5
        for (const char of original) hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 0x01000193) >>> 0
        const suffix = `-${hash.toString(16).padStart(8, '0')}`
        return name.slice(0, MAX_SAFE_NAME - suffix.length) + suffix
      }
      const sanitize = (input: string): string => {
        // NFC first: the same visual name written as two code points and as one must not be two files.
        const normalised = input.normalize('NFC')
        // A trailing dot or space is dropped by Windows itself, so `name.` / `name ` and `name` are one
        // file — strip them **before** the replacement below would turn the space into `_`.
        const kept = normalised.replace(/[. ]+$/u, '').replace(/[^A-Za-z0-9._-]/gu, '_')
        // `.hidden` and `hidden` are different files everywhere, so only a name of **nothing but dots**
        // is refused (that is the `.` / `..` case).
        if (kept === '' || /^\.+$/u.test(kept)) return ''
        // Reserved device names are refused by Windows, with or without an extension.
        const stem = kept.split('.')[0]?.toUpperCase() ?? ''
        return /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(stem) ? `_${kept}` : kept
      }
      const primary = sanitize(value)
      if (primary !== '') return fit(primary, value)
      const fromFallback = sanitize(fallback)
      return fromFallback === '' ? 'unnamed' : fit(fromFallback, fallback)
    },
    exceedsPathLimit: (path: string): boolean => path.length >= facts.longPathLimit,
    approachesPathLimit: (path: string): boolean => path.length >= facts.pathLengthWarn,
  })
}
