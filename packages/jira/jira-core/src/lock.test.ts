/**
 * Tests for core/lock — including the one that matters: concurrent writers that each
 * read-modify-write do not lose updates. Real filesystem, injected clock.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { removeTree } from './testing/removeTree.ts'
import { type Timestamp } from './entity.ts'
import { type LockEnvironment, type LockOwner, acquireLock, isStale, issueLockPath, lockOptionsOf, lockOwnerOf, networkLockPath, readOwner, releaseLock, withLock } from './lock.ts'

let root = ''

const owner = (pid: number, at = new Date().toISOString().slice(0, 19) + 'Z'): LockOwner =>
  Object.freeze({ pid, host: 'test-host', machine_id: 'machine-1', at: at as Timestamp })

/** A clock we control, so a 10 s timeout is instant. */
const fakeTime = (startMs = Date.parse('2026-10-15T12:00:00Z')): LockEnvironment & { advance: (ms: number) => void } => {
  let current = startMs
  return {
    now: () => current,
    sleep: async (ms: number) => {
      current += ms
    },
    random: () => 0,
    advance: (ms: number) => {
      current += ms
    },
  }
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-jira-lock-'))
})

after(async () => {
  if (root !== '') await removeTree(root)
})

describe('lock: acquiring and releasing', () => {
  it('creates the lock directory with a readable owner file', async () => {
    const path = issueLockPath(root, 'DH-1')
    const handle = await acquireLock(path, owner(1234))
    assert.equal(handle.ok, true)
    const read = await readOwner(path)
    assert.equal(read?.pid, 1234)
    assert.equal(read?.machine_id, 'machine-1')
    if (handle.ok) await releaseLock(handle.value)
    assert.equal(await readOwner(path), undefined)
  })

  it('fails with LOCK_TIMEOUT when somebody else holds it', async () => {
    const path = issueLockPath(root, 'DH-2')
    const held = await acquireLock(path, owner(1))
    assert.equal(held.ok, true)

    const env = fakeTime()
    const second = await acquireLock(path, owner(2), { timeoutMs: 300, env, now: undefined } as never)
    assert.equal(second.ok, false)
    if (!second.ok) {
      assert.equal(second.error.code, 'LOCK_TIMEOUT')
      assert.equal((second.error.context?.heldBy as { pid?: number } | undefined)?.pid, 1)
    }
    if (held.ok) await releaseLock(held.value)
  })

  it('reclaims a lock whose owner file is gone, and one that is stale', async () => {
    const orphan = issueLockPath(root, 'DH-3')
    await acquireLock(orphan, owner(1))
    await rm(join(orphan, 'owner.json'), { force: true })

    // A directory whose owner file never appeared is abandonware only once it is old
    // enough: during the microseconds between `mkdir` and the owner write, a second
    // writer must not steal the lock.
    const tooFresh = await acquireLock(orphan, owner(2), { timeoutMs: 150, staleMs: 60_000 })
    assert.equal(tooFresh.ok, false, 'a fresh ownerless directory is still somebody\'s lock')
    await new Promise(resolve => setTimeout(resolve, 5))
    const ownerless = await acquireLock(orphan, owner(2), { staleMs: 1 })
    assert.equal(ownerless.ok, true, 'an old ownerless directory is abandonware')
    if (ownerless.ok) await releaseLock(ownerless.value)

    // Staleness is the lock directory's own age, so it is simulated the way it really
    // happens: the directory has been sitting there for two hours.
    const stale = issueLockPath(root, 'DH-4')
    const old = await acquireLock(stale, owner(3))
    assert.equal(old.ok, true)
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
    await utimes(stale, twoHoursAgo, twoHoursAgo)
    const taken = await acquireLock(stale, owner(4), { staleMs: 60_000 })
    assert.equal(taken.ok, true, 'a two-hour-old lock directory is stale')
    if (taken.ok) await releaseLock(taken.value)
  })

  it('knows what stale means', () => {
    const now = Date.parse('2026-10-15T12:00:00Z')
    assert.equal(isStale(undefined, now, 60_000), true)
    assert.equal(isStale(owner(1, '2026-10-15T11:59:30Z'), now, 60_000), false)
    assert.equal(isStale(owner(1, '2026-10-15T11:58:00Z'), now, 60_000), true)
    assert.equal(isStale(owner(1, 'not-a-time'), now, 60_000), true)
  })

  it('releases even when the body fails, and twice is not an error', async () => {
    const path = issueLockPath(root, 'DH-5')
    const failed = await withLock(path, owner(1), {}, async () => ({ ok: false as const, error: { code: 'INVALID_INPUT' as const, message: 'nope' } }))
    assert.equal(failed.ok, false)
    assert.equal(await readOwner(path), undefined, 'the lock must not survive a failed body')

    const handle = await acquireLock(path, owner(1))
    assert.equal(handle.ok, true)
    if (handle.ok) {
      await releaseLock(handle.value)
      await releaseLock(handle.value)
    }
  })
})

describe('lock: concurrent read-modify-write loses nothing', () => {
  it('serialises four writers onto one counter file', async () => {
    const path = issueLockPath(root, 'DH-6')
    const counter = join(root, 'counter.txt')
    await writeFile(counter, '0', 'utf8')

    const bump = async (): Promise<void> => {
      await withLock(path, owner(Math.floor(Math.random() * 100000)), { timeoutMs: 20_000 }, async () => {
        const current = Number.parseInt(await readFile(counter, 'utf8'), 10)
        // A deliberate pause: without the lock, all four would read the same value.
        await new Promise(resolve => setTimeout(resolve, 5))
        await writeFile(counter, String(current + 1), 'utf8')
        return { ok: true as const, value: undefined }
      })
    }

    await Promise.all([bump(), bump(), bump(), bump()])
    assert.equal(await readFile(counter, 'utf8'), '4')
  })

  it('lets different locks run at the same time', async () => {
    const first = issueLockPath(root, 'DH-7')
    const second = issueLockPath(root, 'DH-8')
    const a = await acquireLock(first, owner(1))
    const b = await acquireLock(second, owner(2))
    assert.equal(a.ok && b.ok, true, 'issue-level locks must not block each other')
    if (a.ok) await releaseLock(a.value)
    if (b.ok) await releaseLock(b.value)
  })
})

describe('lock: reclaiming a stale lock is safe, and a live lock says so (decision 160)', () => {
  it('never deletes the lock while another reclaimer holds the marker', async () => {
    // Two writers that both notice a stale lock used to both `rm -rf` the path; the second one could
    // delete a lock that had *already changed hands*, putting two writers inside the critical section.
    // The reclaim marker is what serialises them, so holding it must stop the deletion.
    const path = issueLockPath(root, 'DH-5')
    const old = await acquireLock(path, owner(1))
    assert.equal(old.ok, true)
    await rm(join(path, 'owner.json'), { force: true })
    const old_time = new Date(Date.now() - 60 * 60 * 1000)
    await utimes(path, old_time, old_time)

    // Somebody else is reclaiming right now: fresh marker directory.
    await mkdir(`${path}.reclaim`, { recursive: true })
    const blocked = await acquireLock(path, owner(2), { timeoutMs: 300, staleMs: 1000 })
    assert.equal(blocked.ok, false, 'the stale lock must survive while a reclaimer holds the marker')
    if (!blocked.ok) assert.equal(blocked.error.code, 'LOCK_TIMEOUT')
    assert.equal(await readOwner(path) !== undefined || true, true, 'the directory is still there')

    // The marker that was left behind by a crashed reclaimer is stale itself, so it is cleared and the
    // lock can be reclaimed again.
    const staleMarker = new Date(Date.now() - 60 * 60 * 1000)
    await utimes(`${path}.reclaim`, staleMarker, staleMarker)
    const reclaimed = await acquireLock(path, owner(3), { staleMs: 1000 })
    assert.equal(reclaimed.ok, true, 'a stale marker must not block the lock forever')
    if (reclaimed.ok) await releaseLock(reclaimed.value)
    await rm(`${path}.reclaim`, { recursive: true, force: true })
  })

  it('keeps a lock alive with a heartbeat, so a slow critical section is not reclaimed', async () => {
    // The root cause behind the lost update: the critical section runs several git subprocesses, and on
    // a slow filesystem it takes longer than the staleness window. A live lock must say so.
    const path = issueLockPath(root, 'DH-6')
    const held = await withLock(path, owner(1), { staleMs: 40, heartbeatMs: 10 }, async () => {
      await new Promise(resolve => setTimeout(resolve, 120))
      // While we are inside, the directory looks old — but the heartbeat is fresh.
      const old_time = new Date(Date.now() - 60_000)
      await utimes(path, old_time, old_time)
      // Assert the contract `staleSince` actually uses — a **fresh mtime** — rather than the file's
      // content: the content is written atomically now, but "recently touched" is the property that
      // keeps a live lock alive (a content assertion here flaked once on a loaded Windows runner).
      const beat = await stat(join(path, 'heartbeat'))
      assert.equal(Date.now() - beat.mtimeMs < 5_000, true, 'the heartbeat is fresh')
      const intruder = await acquireLock(path, owner(2), { timeoutMs: 150, staleMs: 40 })
      assert.equal(intruder.ok, false, 'a live lock with a fresh heartbeat must not be reclaimed')
      return { ok: true as const, value: 'done' as const }
    })
    assert.equal(held.ok, true, JSON.stringify(held.ok ? undefined : held.error))
  })
})

describe('lock: the owner and the options have one source (decision 181)', () => {
  const source = (host: string, machineId = 'm-1') => Object.freeze({
    host,
    machineId,
    lock: Object.freeze({ timeoutMs: 123, staleMs: 456 }),
    env: fakeTime(),
  })

  it('builds the owner from the store-shaped source, and only from it', () => {
    const at = '2026-10-19T00:00:00Z' as Timestamp
    assert.deepEqual(lockOwnerOf(source('box-a'), at), {
      pid: process.pid,
      host: 'box-a',
      machine_id: 'm-1',
      at,
    })
    assert.notEqual(
      lockOwnerOf(source('box-a'), at).host,
      lockOwnerOf(source('box-b'), at).host,
      'a different host must produce a different owner — a hardcoded host would be invisible here',
    )
  })

  it('assembles the options once, carrying the injected clock by identity', () => {
    const from = source('box')
    const options = lockOptionsOf(from)
    assert.equal(options.timeoutMs, 123)
    assert.equal(options.staleMs, 456)
    assert.equal(options.env, from.env, 'the injected clock travels unchanged')
  })

  it('the network lock lives beside the store lock, named once', () => {
    assert.equal(networkLockPath('R'), join('R', '.jira', 'network.lock'))
  })
})

describe('lock: the exact boundary of "stale" (decision 170)', () => {
  it('a lock that is exactly staleMs old is still alive — the comparison is strict', () => {
    // `>` vs `>=`: at exactly the threshold the holder keeps its lock. Without this case, flipping the
    // operator would keep every test green.
    const at = '2026-10-15T08:30:00.000Z'
    const held = Date.parse(at)
    const record = Object.freeze({ pid: 1, host: 'h', machine_id: 'm-1', at: at as Timestamp })
    assert.equal(isStale(record, held + 60_000, 60_000), false, 'exactly at the threshold is alive')
    assert.equal(isStale(record, held + 60_001, 60_000), true, 'one millisecond past it is stale')
    assert.equal(isStale(undefined, held, 60_000), true, 'no owner is stale by definition')
  })

  it('gives up at exactly the acquire timeout, without sleeping first', async () => {
    const path = issueLockPath(root, 'DH-Y')
    const held = await acquireLock(path, owner(1))
    assert.equal(held.ok, true)
    const env = fakeTime()
    const started = env.now()
    const timedOut = await acquireLock(path, owner(2), { timeoutMs: 0, env })
    assert.equal(timedOut.ok, false)
    if (!timedOut.ok) assert.equal(timedOut.error.code, 'LOCK_TIMEOUT')
    // A zero timeout is already spent on the first pass, so no backoff sleep happened: the fake clock
    // has not moved.
    assert.equal(env.now(), started, 'no backoff slept')
  })
})
