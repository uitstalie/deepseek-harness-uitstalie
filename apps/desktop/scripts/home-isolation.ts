/** Refuse a Harness home that would write into the user's own profile. */

import { existsSync, realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, isAbsolute, join, resolve, sep } from 'node:path'
import { resolveDshHome } from '../../../packages/util/home-paths/src/index.ts'
import { SCRATCH_HOME_PREFIX } from './scratch-home.ts'

/** Environment variable a caller sets to allow the user's own Harness home explicitly. */
export const ALLOW_USER_HOME_ENV = 'DSH_ALLOW_USER_HOME'

/**
 * Canonicalize a path for comparison, resolving links through the deepest existing ancestor.
 * @param path - absolute path that may not exist yet.
 * @returns the canonical absolute path.
 */
function canonical(path: string): string {
  if (existsSync(path)) return realpathSync.native(path)
  const parent = resolve(path, '..')
  return join(existsSync(parent) ? realpathSync.native(parent) : parent, basename(path))
}

/**
 * Compare two canonical paths under the platform's case rules.
 * @param left - first canonical path.
 * @param right - second canonical path.
 * @returns whether both name the same directory.
 */
function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

/**
 * Test whether a canonical path lies strictly below a canonical root.
 * @param root - canonical root directory.
 * @param path - canonical candidate path.
 * @returns whether the candidate is a descendant of the root.
 */
function below(root: string, path: string): boolean {
  const prefix = root.endsWith(sep) ? root : root + sep
  const normalize = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value
  return normalize(path).startsWith(normalize(prefix))
}

/**
 * Prove a resolved Harness home is not the user's own profile.
 *
 * A script that lets the ambient environment decide its home can otherwise write Sessions, credentials, and profiles
 * into `%USERPROFILE%` or `~/.dsh`, which is how unattended probes damage real user state. A minted scratch home stays
 * allowed even though the temporary directory sits below the user's profile.
 * @param home - resolved Harness home a script is about to boot.
 * @param options - `allowUserHome` permits the user's own home explicitly; defaults to the environment opt-in.
 * @throws Error when the home is the user's profile, the default Harness home, or a non-scratch directory inside it.
 */
export function assertIsolatedHarnessHome(
  home: string,
  options: { allowUserHome?: boolean; environment?: NodeJS.ProcessEnv } = {},
): void {
  if (!isAbsolute(home)) throw new Error(`home isolation: ${JSON.stringify(home)} is not an absolute path`)
  const environment = options.environment ?? process.env
  if (options.allowUserHome === true || environment[ALLOW_USER_HOME_ENV] === '1') return
  const resolved = canonical(home)
  const user = canonical(homedir())
  const dsh = canonical(resolveDshHome())
  if (samePath(resolved, user)) {
    throw new Error(`home isolation: ${resolved} is the user profile itself; set a scratch home or ${ALLOW_USER_HOME_ENV}=1 `
      + 'only when the user asked for that exact home')
  }
  if (samePath(resolved, dsh) || below(dsh, resolved)) {
    throw new Error(`home isolation: ${resolved} is inside the user's Harness home ${dsh}; scripts boot scratch homes, `
      + `and ${ALLOW_USER_HOME_ENV}=1 is required to target the user's own home`)
  }
  if (below(user, resolved) && !below(canonical(tmpdir()), resolved)) {
    throw new Error(`home isolation: ${resolved} is inside the user profile but is not a minted ${SCRATCH_HOME_PREFIX}* `
      + `directory; ${ALLOW_USER_HOME_ENV}=1 is required to accept it`)
  }
  if (samePath(resolved, canonical(tmpdir()))) {
    throw new Error(`home isolation: ${resolved} is the temporary directory itself, not a minted home`)
  }
}
