/** Disposable Harness homes for scripts that boot a real profile, with a refusal to touch a user's home. */

import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, isAbsolute, join, resolve, sep } from 'node:path'
import { resolveDshHome } from '../../../packages/util/home-paths/src/index.ts'

/** Name prefix every minted scratch home carries, so a later refusal can prove ownership. */
export const SCRATCH_HOME_PREFIX = 'dsh-scratch-home-'

/**
 * Canonicalize a path for comparison, resolving links through the deepest existing ancestor.
 * @param path - absolute path that may not exist yet.
 * @returns the canonical absolute path.
 */
function canonical(path: string): string {
  if (existsSync(path)) return realpathSync.native(path)
  const parent = resolve(path, '..')
  const name = basename(path)
  return existsSync(parent) ? join(realpathSync.native(parent), name) : join(parent, name)
}

/**
 * Compare two canonical paths under the platform's case rules.
 * @param left - first canonical path.
 * @param right - second canonical path.
 * @returns whether the paths name the same directory.
 */
function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

/**
 * Test whether a canonical path lies at or below a canonical root.
 * @param root - canonical root directory.
 * @param path - canonical candidate path.
 * @returns whether the candidate is the root or one of its descendants.
 */
function inside(root: string, path: string): boolean {
  const prefix = root.endsWith(sep) ? root : root + sep
  const normalize = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value
  return normalize(path) === normalize(root) || normalize(path).startsWith(normalize(prefix))
}

/**
 * Mint an owned scratch home under the temporary directory.
 * @returns absolute path of the new, empty home.
 */
export function createScratchHome(): string {
  return mkdtempSync(join(tmpdir(), SCRATCH_HOME_PREFIX))
}

/**
 * Prove a path is a minted scratch home before a script boots a profile against it or deletes it.
 *
 * A script that boots or removes a Harness home must never receive a user's home, the installation's default home,
 * or any directory the script cannot prove it minted. The prefix check runs on the canonical basename, so a link
 * pointing at a user's home cannot pass.
 * @param home - candidate Harness home.
 * @throws Error when the path is relative, outside the temporary directory, lacks the minted prefix, or names a user home.
 */
export function assertScratchHome(home: string): void {
  if (!isAbsolute(home)) throw new Error(`scratch home: ${JSON.stringify(home)} is not an absolute path`)
  const resolved = canonical(home)
  const root = canonical(tmpdir())
  if (!inside(root, resolved) || samePath(root, resolved)) {
    throw new Error(`scratch home: ${resolved} is not a minted directory under ${root}`)
  }
  if (!basename(resolved).startsWith(SCRATCH_HOME_PREFIX)) {
    throw new Error(`scratch home: ${resolved} does not carry the ${SCRATCH_HOME_PREFIX} prefix`)
  }
  for (const protectedHome of [homedir(), resolveDshHome()]) {
    if (samePath(canonical(protectedHome), resolved)) {
      throw new Error(`scratch home: ${resolved} is a user Harness home, not a scratch directory`)
    }
  }
}

/**
 * Build the environment a scratch home boots with: every user-data pointer pinned inside the home and the
 * ambient package-manager configuration replaced, so a boot cannot read or write a user's Harness state.
 * @param home - scratch home returned by {@link createScratchHome}.
 * @param base - ambient environment to derive from; defaults to the current process environment.
 * @returns a new environment mapping owned by the caller.
 */
export function scratchHomeEnvironment(home: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  assertScratchHome(home)
  const environment = Object.fromEntries(
    Object.entries(base).filter(([name]) => !/^(?:npm|pnpm|corepack)_/iu.test(name)),
  )
  return {
    ...environment,
    DSH_HOME: home,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: home,
    XDG_CACHE_HOME: home,
    XDG_STATE_HOME: home,
    APPDATA: home,
    LOCALAPPDATA: home,
    npm_config_userconfig: join(home, 'npmrc'),
    npm_config_globalconfig: join(home, 'npmrc'),
    npm_config_store_dir: join(home, 'store'),
    npm_config_enable_global_virtual_store: 'false',
  }
}

/**
 * Remove a scratch home this script minted.
 * @param home - path returned by {@link createScratchHome}.
 * @throws Error when the path is not a minted scratch home; nothing is removed in that case.
 */
export function removeScratchHome(home: string): void {
  assertScratchHome(home)
  rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
}
