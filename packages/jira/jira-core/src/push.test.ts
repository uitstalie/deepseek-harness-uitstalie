/**
 * Tests for core/push — the debounce, the flush, and the "a failure is not an error" rule
 * (decision 60). Timers and git are injected, so nothing waits and nothing needs a remote.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ioFailed } from './errors.ts'
import { type GitRunner } from './git.ts'
import { createPushQueue, type PushTimer, MAX_PUSH_RETRIES } from './push.ts'
import { err, ok } from './result.ts'

/** A timer we fire by hand, so the debounce window is not real time. */
const fakeTimer = () => {
  const armed = new Map<number, () => void>()
  let next = 1
  const timer: PushTimer = {
    set: (run) => {
      const handle = next
      next += 1
      armed.set(handle, run)
      return handle
    },
    clear: (handle) => {
      armed.delete(handle as number)
    },
  }
  return {
    timer,
    pending: () => armed.size,
    fire: () => {
      const entries = [...armed.entries()]
      armed.clear()
      for (const [, run] of entries) run()
    },
  }
}

/** A git we control: which remotes exist, and whether push succeeds. */
const fakeGit = (options: { remotes: string; pushFails?: boolean }) => {
  const calls: string[][] = []
  const run: GitRunner = async (_root, args) => {
    calls.push([...args])
    if (args[0] === 'remote') return { code: 0, stdout: options.remotes, stderr: '' }
    if (args[0] === 'push') {
      return options.pushFails === true
        ? { code: 128, stdout: '', stderr: 'fatal: could not read from remote' }
        : { code: 0, stdout: '', stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  return { run, calls, pushes: () => calls.filter(args => args[0] === 'push').length }
}

/** "Nothing to rebase": the pull hook's common answer, measured in the tests without a remote. */
const noRebase = Object.freeze({
  pulled: false,
  stopped: false,
  marked: Object.freeze([] as string[]),
  failed: Object.freeze([] as string[]),
})

/** Wait for a condition the queue reaches asynchronously (the debounced flush is a real timer). */
const until = async (predicate: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
}

describe('push: debouncing', () => {
  it('collapses a burst of writes into one push', async () => {
    const clock = fakeTimer()
    const git = fakeGit({ remotes: 'origin' })
    const queue = createPushQueue({ root: '/store', run: git.run, timer: clock.timer })

    queue.schedule()
    queue.schedule()
    queue.schedule()
    assert.equal(clock.pending(), 1, 'one timer, not three')
    assert.equal(queue.isPending(), true)

    clock.fire()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(git.pushes(), 1)
    assert.equal(queue.isPending(), false)
  })

  it('flushing cancels the pending timer and pushes once', async () => {
    const clock = fakeTimer()
    const git = fakeGit({ remotes: 'origin' })
    const queue = createPushQueue({ root: '/store', run: git.run, timer: clock.timer })

    queue.schedule()
    const outcome = await queue.flushNow()
    assert.equal(outcome.kind, 'pushed')
    assert.equal(clock.pending(), 0)
    assert.equal(git.pushes(), 1)
  })
})

describe('push: nothing to do is not a failure', () => {
  it('stays quiet when the store has no remote', async () => {
    const git = fakeGit({ remotes: '' })
    const queue = createPushQueue({ root: '/store', run: git.run, timer: fakeTimer().timer })
    const outcome = await queue.flushNow()
    assert.equal(outcome.kind, 'nothing-to-do')
    if (outcome.kind === 'nothing-to-do') assert.match(outcome.reason, /no remote/)
    assert.equal(git.pushes(), 0)
  })

  it('stays quiet when pushing is turned off', async () => {
    const git = fakeGit({ remotes: 'origin' })
    const queue = createPushQueue({ root: '/store', run: git.run, timer: fakeTimer().timer, enabled: false })
    const outcome = await queue.flushNow()
    assert.equal(outcome.kind, 'nothing-to-do')
    assert.equal(git.pushes(), 0)
  })
})

describe('push: the settle step runs after the pull and before the push (decision 148)', () => {
  it('refreshes the derived files between the rebase and the push', async () => {
    // The order is the design: a rebase imports commits and `log.md` lists commits, so refreshing
    // before it would render the logs against a history that is about to change — and pushing
    // without refreshing is what turned the store's `generate --check` gate red mid-session.
    const order: string[] = []
    const git = fakeGit({ remotes: 'origin' })
    const queue = createPushQueue({
      root: '/store',
      run: async (root, args) => {
        if (args[0] === 'push') order.push('push')
        return git.run(root, args)
      },
      timer: fakeTimer().timer,
      pull: async () => {
        order.push('pull')
        return ok(noRebase)
      },
      settle: async () => {
        order.push('settle')
        return ok([])
      },
    })

    const outcome = await queue.flushNow({ settle: true })
    assert.equal(outcome.kind, 'pushed')
    assert.deepEqual(order, ['pull', 'settle', 'push'])
  })

  it('does not push a state it could not settle', async () => {
    const git = fakeGit({ remotes: 'origin' })
    const queue = createPushQueue({
      root: '/store',
      run: git.run,
      timer: fakeTimer().timer,
      settle: async () => err(ioFailed('the derived files could not be written', {})),
    })

    const outcome = await queue.flushNow({ settle: true })
    assert.equal(outcome.kind, 'failed')
    assert.equal(git.pushes(), 0, 'pushing it would only hand the gate a red commit')
    assert.equal(queue.failures(), 1, 'and the failure is counted, so the retry is honest')
  })

  it('settles on the debounced path, and elsewhere only when the caller asks', async () => {
    // Whether the store may be written is a property of the **caller** (decisions 89/93): one queue
    // serves a main agent that may write and a read-only or delegated session that may not. The
    // debounce is only ever armed by a write that already succeeded, so it always settles; an
    // explicit flush says so itself.
    let settled = 0
    const clock = fakeTimer()
    const git = fakeGit({ remotes: 'origin' })
    const queue = createPushQueue({
      root: '/store',
      run: git.run,
      timer: clock.timer,
      settle: async () => {
        settled += 1
        return ok([])
      },
    })

    await queue.flushNow({ settle: true })
    assert.equal(settled, 1)

    await queue.flushNow()
    await queue.flushNow({ settle: false })
    assert.equal(settled, 1, 'an unasked flush does not write to the store')

    queue.schedule()
    clock.fire()
    await until(() => git.pushes() === 4)
    assert.equal(settled, 2, 'the debounced flush a write armed always settles')
    assert.equal(git.pushes(), 4, 'the three explicit flushes plus the debounced one')
  })

  it('does not settle when there is nothing to push to', async () => {
    // A local-only store has no gate to satisfy, and the session end still regenerates for the human
    // reading the working tree. Doing it here as well would commit on every debounce of a store that
    // never pushes anywhere.
    let settled = 0
    const git = fakeGit({ remotes: '' })
    const queue = createPushQueue({
      root: '/store',
      run: git.run,
      timer: fakeTimer().timer,
      settle: async () => {
        settled += 1
        return ok([])
      },
    })

    const outcome = await queue.flushNow({ settle: true })
    assert.equal(outcome.kind, 'nothing-to-do')
    assert.equal(settled, 0)
  })
})

describe('push: dispose stops the queue for good (decision 166)', () => {
  it('disarms the pending timer, and neither fire nor flush pushes afterwards', async () => {
    // A live config reload re-runs the plugin's `apply`; without dispose every reload would leave
    // another debounce timer holding a stale closure, and they would all push at session end.
    const clock = fakeTimer()
    const git = fakeGit({ remotes: 'origin' })
    const queue = createPushQueue({ root: '/store', run: git.run, timer: clock.timer })

    queue.schedule()
    assert.equal(queue.isPending(), true)
    assert.equal(clock.pending(), 1)

    queue.dispose()
    assert.equal(queue.isPending(), false, 'dispose disarms the debounce timer')
    assert.equal(clock.pending(), 0, 'the timer itself is cleared, not just the flag')

    clock.fire()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(git.pushes(), 0, 'a fired-after-dispose timer (if any survived) must not push')

    const outcome = await queue.flushNow({ settle: true })
    assert.equal(outcome.kind, 'nothing-to-do')
    if (outcome.kind === 'nothing-to-do') assert.match(outcome.reason, /disposed/)
    assert.equal(git.pushes(), 0, 'an explicit flush is refused too')
    assert.equal(queue.failures(), 0, 'a refused flush is not counted as a failure')

    queue.schedule()
    assert.equal(queue.isPending(), false, 'a disposed queue does not arm again')
    assert.equal(clock.pending(), 0)
  })
})

describe('push: a failed push is reported, counted, and retried next time', () => {
  it('counts the failure and keeps going', async () => {
    const clock = fakeTimer()
    const git = fakeGit({ remotes: 'origin', pushFails: true })
    const outcomes: string[] = []
    const queue = createPushQueue({
      root: '/store',
      run: git.run,
      timer: clock.timer,
      onOutcome: outcome => outcomes.push(outcome.kind),
    })

    assert.equal((await queue.flushNow()).kind, 'failed')
    assert.equal(queue.failures(), 1)
    assert.equal((await queue.flushNow()).kind, 'failed')
    assert.equal(queue.failures(), 2)
    assert.deepEqual(outcomes, ['failed', 'failed'])
    assert.equal(git.pushes(), 2, 'every flush really tried')
  })

  it('a later success clears the count', async () => {
    let failing = true
    const run: GitRunner = async (_root, args) => {
      if (args[0] === 'remote') return { code: 0, stdout: 'origin', stderr: '' }
      if (args[0] === 'push') return failing ? { code: 128, stdout: '', stderr: 'offline' } : { code: 0, stdout: '', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }
    const queue = createPushQueue({ root: '/store', run, timer: fakeTimer().timer })
    await queue.flushNow()
    assert.equal(queue.failures(), 1)
    failing = false
    await queue.flushNow()
    assert.equal(queue.failures(), 0)
  })
})

describe('push: a failed flush retries with backoff, then gives up (decision 191)', () => {
  const makeTimer = (): { timer: PushTimer; fire: () => Promise<void>; delays: number[] } => {
    const pending: (() => void)[] = []
    const delays: number[] = []
    return {
      timer: {
        set: (run, ms) => {
          delays.push(ms)
          pending.push(run)
          return pending.length
        },
        clear: () => undefined,
      },
      fire: async () => {
        const next = pending.shift()
        if (next !== undefined) next()
        await new Promise(resolve => setImmediate(resolve))
      },
      delays,
    }
  }

  it('re-arms after a rejected push, up to the cap, and succeeds on the retry', async () => {
    const { timer, fire, delays } = makeTimer()
    let attempts = 0
    const queue = createPushQueue({
      root: '/store',
      debounceMs: 10,
      timer,
      run: async (_root, args) => {
        if (args[0] === 'remote') return { code: 0, stdout: 'origin\n', stderr: '' }
        attempts += 1
        return attempts === 1
          ? { code: 1, stdout: '', stderr: 'rejected: non-fast-forward' }
          : { code: 0, stdout: '', stderr: '' }
      },
    })
    queue.schedule()
    await fire() // the debounce fires: the first push is rejected, a retry is armed
    assert.equal(attempts, 1)
    assert.equal(delays.length, 2, 'a retry timer was armed')
    await fire() // the retry succeeds
    assert.equal(attempts, 2)
    assert.equal(queue.failures(), 0, 'the success reset the failure count')
  })

  it('stops after the cap instead of retrying forever', async () => {
    const { timer, fire, delays } = makeTimer()
    let attempts = 0
    createPushQueue({
      root: '/store',
      debounceMs: 10,
      timer,
      run: async (_root, args) => {
        if (args[0] === 'remote') return { code: 0, stdout: 'origin\n', stderr: '' }
        attempts += 1
        return { code: 1, stdout: '', stderr: 'rejected: non-fast-forward' }
      },
    }).schedule()
    for (let step = 0; step < 10; step += 1) await fire()
    assert.equal(attempts, 1 + MAX_PUSH_RETRIES, 'the debounce plus three retries')
    assert.equal(delays.length, 1 + MAX_PUSH_RETRIES)
  })

  it('does not retry a stopped rebase — a human has to look', async () => {
    const { timer, fire, delays } = makeTimer()
    createPushQueue({
      root: '/store',
      debounceMs: 10,
      timer,
      pull: async () => ok(Object.freeze({ pulled: false, stopped: true, reason: 'conflict in DH-1', marked: [], failed: [] })),
      run: async (_root, args) => (args[0] === 'remote' ? { code: 0, stdout: 'origin\n', stderr: '' } : { code: 0, stdout: '', stderr: '' }),
    }).schedule()
    await fire()
    assert.equal(delays.length, 1, 'no retry was armed')
  })
})
