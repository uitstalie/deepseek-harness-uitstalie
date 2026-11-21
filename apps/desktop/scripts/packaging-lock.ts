/** Single-flight guard and stale-output cleanup for one Desktop packaging target. */

import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Recorded owner of one packaging target. */
export interface PackagingLockState {
  /** Process that holds the target. */
  readonly pid: number
  /** ISO instant the holder acquired the target. */
  readonly startedAt: string
  /** Packaging target name, such as `win-x64`. */
  readonly target: string
  /** Packaging run directory the holder writes evidence to. */
  readonly run: string
}

/** One acquired target; the holder must call {@link PackagingLock.release}. */
export interface PackagingLock {
  /** State this holder wrote. */
  readonly state: PackagingLockState
  /** State replaced because its owner was gone, when the lock was stale. */
  readonly stale?: PackagingLockState
  /** Remove the lock file when it still records this holder. */
  release(): void
}

/** Output directories electron-builder recreates and a stale copy can keep a write handle on. */
export const STALE_OUTPUT_DIRECTORIES: readonly string[] = Object.freeze([
  'win-unpacked', 'linux-unpacked', 'mac', 'mac-arm64', '.nsis-directory-installer',
])

/**
 * Decide whether a recorded owner still runs.
 * @param pid - recorded process id.
 * @param isAlive - probe used by tests; defaults to signalling the process.
 * @returns whether the process exists.
 */
function processAlive(pid: number, isAlive: (pid: number) => boolean): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    return isAlive(pid)
  } catch (error) {
    // A permission failure still proves the process exists; only ESRCH means it is gone.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/**
 * Take the single-flight lock for one packaging target.
 *
 * Two builders writing the same output directory produce each other's file locks; the second one fails the fuse step
 * with an opaque open error. A lock file records the owner, and a lock whose owner is gone is taken over.
 * @param lockDirectory - directory that holds the lock files, under `.desktop-build`.
 * @param target - packaging target name.
 * @param run - packaging run directory this holder writes evidence to.
 * @param options - clock and liveness probe used by tests.
 * @returns the acquired lock; call `release` on every exit path.
 * @throws Error naming the running holder when the target is locked by a live process.
 */
export function acquirePackagingLock(
  lockDirectory: string,
  target: string,
  run: string,
  options: { now?: () => Date; isAlive?: (pid: number) => boolean } = {},
): PackagingLock {
  const now = options.now ?? (() => new Date())
  const isAlive = options.isAlive ?? ((pid: number) => process.kill(pid, 0))
  mkdirSync(lockDirectory, { recursive: true })
  const lockPath = join(lockDirectory, `${target}.lock.json`)
  let stale: PackagingLockState | undefined
  if (existsSync(lockPath)) {
    let recorded: PackagingLockState | undefined
    try {
      recorded = JSON.parse(readFileSync(lockPath, 'utf8')) as PackagingLockState
    } catch (error) {
      // An unreadable lock cannot name its owner, so it is stale by definition.
      recorded = undefined
    }
    if (recorded !== undefined && processAlive(recorded.pid, isAlive)) {
      throw new Error(`已有 run 在跑，pid=${String(recorded.pid)}（target=${recorded.target}，started ${recorded.startedAt}，run ${recorded.run}）；`
        + '请等它退出后再启动新的打包')
    }
    stale = recorded
  }
  const state: PackagingLockState = { pid: process.pid, startedAt: now().toISOString(), target, run }
  writeFileSync(lockPath, `${JSON.stringify(state, undefined, 2)}\n`)
  return {
    state,
    ...stale === undefined ? {} : { stale },
    release: () => {
      let current: PackagingLockState | undefined
      try {
        current = JSON.parse(readFileSync(lockPath, 'utf8')) as PackagingLockState
      } catch (error) {
        return
      }
      if (current.pid === state.pid && current.startedAt === state.startedAt) unlinkSync(lockPath)
    },
  }
}

/**
 * Remove the output directories a previous run may have left behind.
 * @param outputDirectory - electron-builder output directory for this target and mode.
 * @returns the entry names that were removed.
 */
export function clearStaleOutput(outputDirectory: string): string[] {
  const removed: string[] = []
  for (const entry of STALE_OUTPUT_DIRECTORIES) {
    const path = join(outputDirectory, entry)
    if (!existsSync(path)) continue
    rmSync(path, { recursive: true, force: true })
    removed.push(entry)
  }
  return removed
}
