/**
 * core/lock — the two-level lock, built on the one primitive both platforms agree on.
 *
 * Decisions 58/59: `mkdir` is atomic on Windows and Linux and is not affected by an
 * antivirus or indexer holding a handle (which is what breaks `rename`-based tricks and
 * `flock`); the lock directory holds an owner file so a crash can be told from a slow
 * writer. Stale 60 s, acquire timeout 10 s, backoff 100 ms plus jitter — all injectable so
 * the tests do not have to wait for real time.
 *
 * `withLock` is the shape callers use: everything inside the body sees the lock held, and
 * the lock is released even when the body fails.
 */

import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { type Timestamp } from './entity.ts'
import { writeTextAtomic } from './io.ts'
import { type JiraError, ioFailed, jiraError } from './errors.ts'
import { type Result, err, ok } from './result.ts'

export const DEFAULT_LOCK_TIMEOUT_MS = 10_000
export const DEFAULT_LOCK_STALE_MS = 60_000
export const LOCK_BACKOFF_MS = 100

export type LockOwner = Readonly<{
  pid: number
  host: string
  machine_id: string
  at: Timestamp
}>

export type LockHandle = Readonly<{ path: string; owner: LockOwner }>

export type LockEnvironment = Readonly<{
  /** Milliseconds since the epoch — injected so tests can travel in time. */
  now: () => number
  sleep: (ms: number) => Promise<void>
  /** 0..1, for the backoff jitter. */
  random: () => number
}>

export const realLockEnvironment: LockEnvironment = Object.freeze({
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
  random: () => Math.random(),
})

export type LockOptions = Readonly<{
  timeoutMs?: number
  staleMs?: number
  /** How often a held lock proves it is alive; defaults to a third of `staleMs`. */
  heartbeatMs?: number
  env?: LockEnvironment
}>

const OWNER_FILE = 'owner.json'
/**
 * Decision 160: a held lock keeps saying it is still held.
 *
 * The critical sections here run several git subprocesses, and on a Windows box with an antivirus
 * leaning on the filesystem that can take longer than the 60 s staleness window. Judging staleness
 * from the acquisition time alone therefore called a *live* lock abandoned — which is a lost update,
 * not a nuisance.
 */
const HEARTBEAT_FILE = 'heartbeat'
const MIN_HEARTBEAT_MS = 50

const ownerPath = (path: string): string => join(path, OWNER_FILE)
const heartbeatPath = (path: string): string => join(path, HEARTBEAT_FILE)

/**
 * The sibling that **serialises reclaimers** (decision 160): only the process holding
 * `<lock>.reclaim` may delete a stale lock, so two writers that both notice a stale lock cannot both
 * delete (the old code judged from a `stat` and then `rm -rf`'d the path, so a lock that changed hands
 * in between was deleted together with its new owner).
 */
const reclaimPath = (path: string): string => `${path}.reclaim`

/** The owner file as text, so "did it change hands?" can be answered without parsing. */
const ownerSnapshot = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(ownerPath(path), 'utf8')
  } catch {
    return undefined
  }
}

/** A lock directory with no readable owner is treated as abandoned, not as held. */
export const readOwner = async (path: string): Promise<LockOwner | undefined> => {
  try {
    const parsed = JSON.parse(await readFile(ownerPath(path), 'utf8')) as Partial<LockOwner>
    if (typeof parsed.pid !== 'number' || typeof parsed.at !== 'string') return undefined
    return Object.freeze({
      pid: parsed.pid,
      host: String(parsed.host ?? 'unknown'),
      machine_id: String(parsed.machine_id ?? 'unknown'),
      at: parsed.at as Timestamp,
    })
  } catch {
    return undefined
  }
}

/**
 * Staleness is judged by the **lock directory's own mtime**, never by the timestamp inside
 * the owner file. The owner's `at` is the writer's clock, and a writer whose clock is behind
 * (or a test that fabricates a timestamp) would otherwise make a *live* lock look abandoned
 * — which was a real lost update: two writers inside the critical section at once.
 *
 * `undefined` means the directory vanished while we looked at it, i.e. somebody released it.
 */
const staleSince = async (path: string, nowMs: number, staleMs: number): Promise<boolean | undefined> => {
  let info
  try {
    info = await stat(path)
  } catch {
    return undefined
  }
  // A heartbeat is written *inside* the directory, which moves the file's mtime but not the
  // directory's, so both have to be considered: the directory says when it was taken, the heartbeat
  // says when the holder last proved it was alive (decision 160).
  const beat = await stat(heartbeatPath(path)).catch(() => undefined)
  const last = Math.max(info.mtimeMs, beat?.mtimeMs ?? 0)
  return nowMs - last > staleMs
}
/**
 * Whether an owner record *looks* old. Kept for diagnostics and for reading a lock from the
 * outside; the acquisition path deliberately does not use it (see {@link staleSince}).
 */
export const isStale = (owner: LockOwner | undefined, nowMs: number, staleMs: number): boolean => {
  if (owner === undefined) return true
  const held = Date.parse(owner.at)
  return Number.isNaN(held) ? true : nowMs - held > staleMs
}

const timeoutError = (path: string, owner: LockOwner | undefined, waitedMs: number): JiraError =>
  jiraError('LOCK_TIMEOUT', `could not acquire ${path} within ${waitedMs} ms`, {
    path,
    ...(owner === undefined ? {} : { heldBy: owner }),
  })

/** `'taken'` when the directory already exists; the error itself for anything else. */
const tryCreate = async (path: string): Promise<'ours' | 'taken' | JiraError> => {
  try {
    // Two steps on purpose: the parent is created idempotently (`recursive: true` never reports
    // EEXIST), while the lock directory itself must be a plain `mkdir`, because only that form is
    // atomic *and* fails when the directory already exists — exactly the mutual exclusion we buy.
    await mkdir(dirname(path), { recursive: true })
    await mkdir(path)
    return 'ours'
  } catch (cause) {
    const code = (cause as { code?: string }).code
    if (code === 'EEXIST') return 'taken'
    return ioFailed(`cannot take the lock at ${path}`, { path, cause: String(code ?? cause) })
  }
}

/**
 * Delete a stale lock, **safely** (decision 160).
 *
 * Two steps, both needed. First the reclaimer takes `<lock>.reclaim`, so two writers that both find
 * the lock stale cannot both delete. Then it re-reads the owner record and deletes only if it is the
 * **same** record it judged stale — a lock that changed hands in between belongs to somebody else now.
 * `false` means "not for me to reclaim", and the caller goes back to waiting.
 */
const reclaimLock = async (path: string, env: LockEnvironment, staleMs: number): Promise<boolean> => {
  const marker = reclaimPath(path)
  const claimMarker = async (): Promise<boolean> => {
    try {
      await mkdir(marker)
      return true
    } catch (cause) {
      if ((cause as { code?: string }).code !== 'EEXIST') return false
      return false
    }
  }

  let mine = await claimMarker()
  if (!mine) {
    // A reclaimer that died mid-way must not block the lock forever: a stale marker is cleared and the
    // claim retried **once, in this same call** — retrying only on the next call would make every
    // writer in the meantime time out.
    if (await staleSince(marker, env.now(), staleMs) !== true) return false
    await rm(marker, { recursive: true, force: true }).catch(() => undefined)
    mine = await claimMarker()
    if (!mine) return false
  }

  try {
    const before = await ownerSnapshot(path)
    if (await staleSince(path, env.now(), staleMs) !== true) return false
    if (await ownerSnapshot(path) !== before) return false
    await rm(path, { recursive: true, force: true }).catch(() => undefined)
    return true
  } finally {
    await rm(marker, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * Take the lock, or fail after `timeoutMs`. A stale holder (older than `staleMs`, or a
 * directory whose owner file is gone) is reclaimed once and retried immediately.
 */
export const acquireLock = async (
  path: string,
  owner: LockOwner,
  options: LockOptions = {},
): Promise<Result<LockHandle, JiraError>> => {
  const env = options.env ?? realLockEnvironment
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS
  const staleMs = options.staleMs ?? DEFAULT_LOCK_STALE_MS
  const startedAt = env.now()

  let reclaimed = false
  for (;;) {
    const created = await tryCreate(path)
    if (created !== 'ours' && created !== 'taken') return err(created)
    if (created === 'ours') {
      // We own the directory now. A failed owner write must not leave a **fresh, ownerless** lock
      // behind (decision 160): its mtime is new, so nobody would ever reclaim it and every writer
      // would just time out. Undo the mkdir we made and report the real cause.
      try {
        await writeFile(ownerPath(path), `${JSON.stringify(owner)}\n`, 'utf8')
      } catch (cause) {
        await rm(path, { recursive: true, force: true }).catch(() => undefined)
        return err(ioFailed(`cannot record the lock owner at ${path}`, { path, cause: String(cause) }))
      }
      return ok(Object.freeze({ path, owner }))
    }

    const holder = await readOwner(path)
    const stale = await staleSince(path, env.now(), staleMs)
    if (stale === undefined) continue // it vanished between the mkdir and the read: try now
    if (!reclaimed && stale) {
      // One reclaim attempt per call: two writers that both find it stale must not both delete each
      // other's fresh directory in a loop. `reclaimLock` is the part that makes it safe.
      reclaimed = true
      if (await reclaimLock(path, env, staleMs)) continue
      // Somebody else holds the reclaim marker, or the lock changed hands while we looked: wait.
    }

    const waited = env.now() - startedAt
    if (waited >= timeoutMs) return err(timeoutError(path, holder, waited))
    const backoff = LOCK_BACKOFF_MS + Math.floor(env.random() * LOCK_BACKOFF_MS)
    await env.sleep(backoff)
  }
}

/** Release is best-effort and idempotent: a lock already gone is not an error. */
export const releaseLock = async (handle: LockHandle): Promise<void> => {
  await rm(handle.path, { recursive: true, force: true }).catch(() => undefined)
}

/**
 * Run `body` with the lock held. The handle is handed in so the body can compare owners,
 * and release happens on every path — success, failure, or a thrown exception.
 */
export const withLock = async <T>(
  path: string,
  owner: LockOwner,
  options: LockOptions,
  body: (handle: LockHandle) => Promise<Result<T, JiraError>>,
): Promise<Result<T, JiraError>> => {
  const env = options.env ?? realLockEnvironment
  const staleMs = options.staleMs ?? DEFAULT_LOCK_STALE_MS
  const heartbeatMs = options.heartbeatMs ?? Math.max(MIN_HEARTBEAT_MS, Math.floor(staleMs / 3))
  const handle = await acquireLock(path, owner, options)
  if (!handle.ok) return handle

  // Decision 160: prove we are alive while we work, so a slow critical section is not reclaimed.
  // Only beat while the lock is still **ours** — a process that lost its lock must not keep it alive
  // from underneath its new owner.
  const beat = async (): Promise<void> => {
    const current = await readOwner(handle.value.path)
    if (current === undefined || current.pid !== owner.pid || current.at !== owner.at) return
    // Atomic, because another process may look at this file at any moment: a truncate-then-write
    // leaves a window where the heartbeat is **empty** (a Windows runner hit it, 2026-10-17 — the
    // reader only needs the mtime, but a debugger or a test reading the file deserves a whole value).
    await writeTextAtomic(heartbeatPath(handle.value.path), `${String(env.now())}\n`).catch(() => undefined)
  }
  const timer = setInterval(() => {
    void beat()
  }, heartbeatMs)
  // A held lock must never be the reason a process stays alive (a CLI that exits, a test runner).
  ;(timer as unknown as { unref?: () => void }).unref?.()

  try {
    return await body(handle.value)
  } finally {
    clearInterval(timer)
    await releaseLock(handle.value)
  }
}

/** The two lock paths a store uses (decision 58): one issue, or the store itself. */
export const issueLockPath = (root: string, key: string): string =>
  join(root, '.jira', 'locks', `${key}.lock`)

export const storeLockPath = (root: string): string => join(root, '.jira', 'lock')

/**
 * The **network** lock (decision 171): one `pull --rebase`/`push` at a time on a clone.
 *
 * The store lock serialises *commits*; it cannot cover the network step too, because the settle
 * takes the store lock itself and `withLock` is not reentrant. And the step has to be covered:
 * two processes on one clone — the live plugin's push queue and a `jira sync` a person runs in a
 * terminal — used to fetch and rebase on top of each other, and git answers the loser with "fetch
 * updated the current branch".
 */
export const networkLockPath = (root: string): string => join(root, '.jira', 'network.lock')

/**
 * What an owner record needs from the store: which host holds the lock, and which machine.
 *
 * Structural on purpose (decision 181): `lock.ts` must not import `store.ts` — `store.ts` imports
 * this file — so anything carrying `host` and `machineId` fits, `Store` included.
 */
export type LockOwnerSource = Readonly<{ host: string; machineId: string }>

/**
 * The owner every lock in the store writes — the **one** place this record is built.
 *
 * It used to be built five times (issue path, knowledge path, machines, projects, network lock)
 * with three different meanings for `host` — the store's, the calling tool's, and a hardcoded
 * `'dsh'`. An audit field with three sources is a field nobody can trust (decision 181).
 */
export const lockOwnerOf = (source: LockOwnerSource, at: Timestamp): LockOwner =>
  Object.freeze({ pid: process.pid, host: source.host, machine_id: source.machineId, at })

/** What lock options need from the store — structural for the same reason as {@link LockOwnerSource}. */
export type LockOptionsSource = Readonly<{
  lock: Readonly<{ timeoutMs: number; staleMs: number }>
  env: LockEnvironment
}>

/** The options every store lock runs with — the one place this triple is assembled (decision 181). */
export const lockOptionsOf = (source: LockOptionsSource): LockOptions =>
  Object.freeze({ timeoutMs: source.lock.timeoutMs, staleMs: source.lock.staleMs, env: source.env })
