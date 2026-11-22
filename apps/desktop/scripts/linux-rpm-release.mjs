/** Allocate the RPM release that distinguishes repeated local Linux builds. */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Read and advance the per-target RPM release counter.
 *
 * Local rebuilds use `1.<n>`: release 1 is the baseline installed package, and
 * an official integer release such as `-2` still sorts above every `1.<n>`.
 * Failed runs may skip a number; skipping keeps every build unique.
 * @param statePath - JSON file holding the last sequence allocated for this target.
 * @param override - Explicit release, which leaves the state file untouched.
 * @returns The release to pass to fpm as `--iteration`.
 */
export async function nextLinuxRpmRelease(statePath, override) {
  if (override !== undefined) {
    if (!/^[1-9]\d*(?:\.\d+)*$/u.test(override)) {
      throw new Error('desktop package: DSH_DESKTOP_RPM_RELEASE must be a positive decimal release')
    }
    return override
  }
  let previous = 0
  try {
    const parsed = JSON.parse(await readFile(statePath, 'utf8'))
    if (Number.isSafeInteger(parsed.sequence) && parsed.sequence > 0) previous = parsed.sequence
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const sequence = previous + 1
  const release = `1.${sequence}`
  await mkdir(dirname(statePath), { recursive: true })
  const temporary = `${statePath}.tmp`
  await writeFile(temporary, `${JSON.stringify({ sequence })}\n`)
  await rename(temporary, statePath)
  return release
}
