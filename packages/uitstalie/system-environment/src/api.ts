/**
 * The host environment atom (`ctx.systemEnvironment`): the one place a plugin asks about the
 * platform, path spelling and comparison, environment variables, and the user and Harness home
 * directories.
 *
 * Reading process facts is not business logic, and two plugins that answer the same question
 * differently are a bug waiting to happen — a case-insensitive path on Windows, a `~` expanded
 * against one home but not another, an environment variable looked up with the wrong case. A
 * branch plugin therefore depends on this service instead of importing `node:path` / `node:os`
 * and re-deciding.
 *
 * Both rule sets are available on one host (`platform: 'win32' | 'posix'`), so the Windows rules
 * are testable on Linux and vice versa; the default is the running platform.
 *
 * @module @deepseek-ai/dsh-system-environment
 */

import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'

export const name = 'system-environment'

/** The two path dialects this service speaks. */
export type SystemPlatform = 'win32' | 'posix'

/** Row configuration: the test seam for platform and environment. */
export interface Config {
  /** Pin the platform rules; defaults to the running host. */
  platform?: SystemPlatform
  /** Read environment values from this map instead of `process.env`. */
  env?: Record<string, string>
}

/** Schemastery configuration for the row. */
export const Config: z<Config> = z.object({
  platform: z.union([z.const('win32'), z.const('posix')]),
  env: z.dict(z.string()),
})

/**
 * One host's environment facts and the comparisons built on them.
 *
 * Every method answers the same question the same way: `normalizePath` produces the comparison
 * spelling (separators normalized, trailing separator dropped, case folded on Windows), and
 * `samePath`/`isUnder` are defined on top of it.
 */
export interface SystemEnvironment {
  /** The platform whose path rules apply. */
  readonly platform: SystemPlatform
  /** Node's path dialect for that platform (`posix` or `win32`). */
  readonly path: typeof posix
  /** Whether two spellings that differ only in case name the same target. */
  readonly caseInsensitive: boolean
  /** The platform's path separator. */
  readonly separator: '/' | '\\'
  /** The platform's `PATH`-list delimiter. */
  readonly delimiter: ':' | ';'
  /**
   * One environment value. A Windows lookup is case-insensitive, because the OS is.
   * @param name - variable name.
   * @returns the value, or undefined when unset.
   */
  env(name: string): string | undefined
  /**
   * The user's home directory (`HOME`, or `USERPROFILE` on Windows).
   * @returns the home directory path.
   */
  homeDir(): string
  /**
   * The resolved Harness home: `$DSH_HOME`, or `<home>/.dsh`.
   * @returns the Harness home path.
   */
  dshHome(): string
  /**
   * The spelling used for comparison on this platform.
   * @param value - any path spelling.
   * @returns absolute normalization with the comparison case.
   */
  normalizePath(value: string): string
  /**
   * Whether two paths name the same target under this platform's rules.
   * @param left - first path.
   * @param right - second path.
   * @returns true when the comparison spellings are equal.
   */
  samePath(left: string, right: string): boolean
  /**
   * Whether `child` is `parent` or lies below it.
   * @param parent - the enclosing directory.
   * @param child - the candidate path.
   * @returns true for the directory itself and every descendant; false for a sibling prefix such
   *   as `/a/bc` against `/a/b`.
   */
  isUnder(parent: string, child: string): boolean
  /**
   * Join path segments with this platform's dialect.
   * @param segments - path segments.
   * @returns the joined path.
   */
  join(...segments: string[]): string
}

/**
 * Build the environment value for one configuration.
 * @param config - platform and environment overrides.
 * @returns the service registered as `ctx.systemEnvironment`.
 */
export function createSystemEnvironment(config: Config = {}): SystemEnvironment {
  const platform = config.platform ?? (process.platform === 'win32' ? 'win32' : 'posix')
  const environment = config.env ?? process.env
  const path = platform === 'win32' ? win32 : posix

  const lookup = (name: string): string | undefined => {
    if (platform !== 'win32') return environment[name]
    // Windows names are case-insensitive; a caller may spell `ProgramFiles` either way.
    const key = Object.keys(environment).find(candidate => candidate.toLowerCase() === name.toLowerCase())
    return key === undefined ? undefined : environment[key]
  }

  const homeDir = (): string => {
    const configured = platform === 'win32'
      ? lookup('USERPROFILE') ?? lookup('HOME')
      : lookup('HOME')
    return configured === undefined || configured === '' ? homedir() : configured
  }

  const normalizePath = (value: string): string => {
    const normalized = path.normalize(value)
    const trimmed = normalized.length > 1 && normalized.endsWith(path.sep)
      ? normalized.slice(0, -1)
      : normalized
    return platform === 'win32' ? trimmed.toLowerCase() : trimmed
  }

  const samePath = (left: string, right: string): boolean => normalizePath(left) === normalizePath(right)

  const isUnder = (parent: string, child: string): boolean => {
    const normalizedParent = normalizePath(parent)
    const normalizedChild = normalizePath(child)
    if (normalizedChild === normalizedParent) return true
    const prefix = normalizedParent.endsWith(path.sep) ? normalizedParent : `${normalizedParent}${path.sep}`
    return normalizedChild.startsWith(prefix)
  }

  return Object.freeze({
    platform,
    path,
    caseInsensitive: platform === 'win32',
    separator: platform === 'win32' ? '\\' : '/',
    delimiter: platform === 'win32' ? ';' : ':',
    env: lookup,
    homeDir,
    dshHome: () => resolveDshHome(undefined, environment),
    normalizePath,
    samePath,
    isUnder,
    join: (...segments: string[]) => path.join(...segments),
  })
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The host environment atom every branch plugin reads platform facts through. */
    systemEnvironment: SystemEnvironment
  }
}

/**
 * Register the environment service.
 * @param ctx - plugin context.
 * @param config - platform and environment overrides.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.provide('systemEnvironment', createSystemEnvironment(config))
}
