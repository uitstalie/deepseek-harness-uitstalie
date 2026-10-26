/**
 * core/push — the debounced push queue (decision 60).
 *
 * A write must never wait on the network, so pushes are collected: 500 ms after the last
 * write the queue pushes once, and a session-end (or an explicit `sync`) flushes it
 * immediately. **A failed push is not an error** — the commit is already safe locally and
 * the next flush retries — but the failure is reported so a permanent one is visible.
 *
 * A flush is `pull --rebase` → **settle** → push (decisions 119/148). The settle step is what makes
 * the pushed tree self-consistent: it refreshes the derived files after the rebase and before the
 * push, so the store's own `generate --check` gate can never see a board that disagrees with the
 * sources in the same commit.
 *
 * Timers and git are injected, so the tests drive it without waiting and without a remote.
 */

import { ioFailed, type JiraError } from './errors.ts'
import { type GitRunner, hasRemote, push, runGit } from './git.ts'
import { type RebaseOutcome } from './rebase.ts'
import { type Result } from './result.ts'

export const DEFAULT_PUSH_DEBOUNCE_MS = 500

/** How one flush ended: pushed, nothing to push, or failed with the error that stopped it. */
export type PushOutcome =
  | Readonly<{ kind: 'pushed' }>
  | Readonly<{ kind: 'nothing-to-do'; reason: string }>
  | Readonly<{ kind: 'failed'; error: JiraError }>

/**
 * What a single flush is allowed to do beyond pushing (decision 148).
 *
 * `settle` is a **parameter of the flush, not a property of the queue**, because whether the store
 * may be written is a property of the **caller**, not of the store: one queue serves a main agent
 * that may write, and a read-only or delegated session that may not (decisions 89/93). Only the
 * call site knows which it is. See {@link PushQueueOptions.settle} for what it turns on.
 */
export type FlushOptions = Readonly<{ settle?: boolean }>

/** The debounced pusher one store owns: schedule a push, flush on demand, inspect the timer. */
export type PushQueue = Readonly<{
  /** Ask for a push soon; repeated calls inside the window collapse into one. */
  schedule: () => void
  /**
   * Push now, cancelling any pending timer (session end, explicit sync).
   *
   * `{ settle: true }` lets the flush refresh the derived files first — the debounced path always
   * does, because it is only ever armed by a write that already succeeded.
   */
  flushNow: (options?: FlushOptions) => Promise<PushOutcome>
  /** True while a timer is armed. */
  isPending: () => boolean
  /**
   * Stop the queue (decision 166): clear the armed timer and refuse to push.
   *
   * The plugin's `apply` hands this back as part of its dispose, because a live config reload
   * re-runs `apply` — without it every reload would leave another debounce timer holding a stale
   * closure, and they would all push when the session ends.
   */
  dispose: () => void
  /** How many pushes never succeeded since the last good one. */
  failures: () => number
}>

export type PushTimer = Readonly<{
  set: (run: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
}>

export const realPushTimer: PushTimer = Object.freeze({
  set: (run: () => void, ms: number) => setTimeout(run, ms),
  clear: (handle: unknown) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
})

export type PushQueueOptions = Readonly<{
  root: string
  /** `push.enabled` (decision 57): false keeps everything local. */
  enabled?: boolean
  debounceMs?: number
  run?: GitRunner
  timer?: PushTimer
  /** Called with every outcome; the caller decides whether to log it. */
  onOutcome?: (outcome: PushOutcome) => void
  /**
   * Run before pushing (decision 119: pull --rebase first). A stopped rebase is never forced,
   * and the push is skipped rather than stacked on an unresolved history.
   */
  pull?: () => Promise<Result<RebaseOutcome, JiraError>>
  /**
   * Refresh the derived files **after the pull and before the push** (decision 148).
   *
   * This is the last moment at which "what leaves the machine" can be made to agree with its own
   * sources, and it is the only one that covers **every** state change: a write invalidates the
   * board, an imported commit invalidates the logs, and the store's own CI re-checks freshness on
   * the pushed tree (`jira generate --check`, exit 1 when stale). Running this at the session end
   * alone left every mid-session push stale — measured on 2026-10-17: the push really does happen
   * a debounce (~500 ms) after a write, long before any session ends.
   *
   * After the pull, on purpose: a rebase imports commits, and `log.md` lists commits, so refreshing
   * before it would be refreshing against a history that is about to change.
   *
   * The hook is optional and injected (this module knows nothing about stores or generators), and a
   * failure **blocks the push** rather than pushing a state the gate would reject.
   */
  settle?: () => Promise<Result<unknown, JiraError>>
}>

/** How many times a failed settle/push is retried before the queue gives up (decision 191). */
export const MAX_PUSH_RETRIES = 3
/** The retry delays: 1×, 2× and 4× the debounce — long enough for the other machine to finish. */
const retryDelayMs = (attempt: number, debounceMs: number): number => debounceMs * 2 ** attempt

export const createPushQueue = (options: PushQueueOptions): PushQueue => {
  const enabled = options.enabled ?? true
  const debounceMs = options.debounceMs ?? DEFAULT_PUSH_DEBOUNCE_MS
  const run = options.run ?? runGit
  const timer = options.timer ?? realPushTimer

  let armed: unknown
  let failures = 0
  /** Retries spent since the last success (decision 191). */
  let retries = 0
  let disposed = false

  const pushNow = async (settle: boolean): Promise<PushOutcome> => {
    if (disposed) return Object.freeze({ kind: 'nothing-to-do', reason: 'the queue was disposed' })
    if (!enabled) return Object.freeze({ kind: 'nothing-to-do', reason: 'push disabled by configuration' })
    if (!(await hasRemote(options.root, run))) {
      return Object.freeze({ kind: 'nothing-to-do', reason: 'the store has no remote' })
    }
    // Decision 119: pull --rebase before pushing, or two machines tangle their history.
    if (options.pull !== undefined) {
      const rebased = await options.pull()
      if (!rebased.ok) {
        failures += 1
        return Object.freeze({ kind: 'failed', error: rebased.error })
      }
      if (rebased.value.stopped) {
        // Red line 1: nothing is forced. The push waits for a human.
        failures += 1
        return Object.freeze({ kind: 'failed', error: ioFailed('pull --rebase stopped: ' + (rebased.value.reason ?? 'git could not merge'), {}) })
      }
    }
    // Decision 148: only now — after the rebase has imported whatever it was going to import — is
    // the derived data rendered against the history that is actually about to be pushed.
    if (settle && options.settle !== undefined) {
      const settled = await options.settle()
      if (!settled.ok) {
        failures += 1
        return Object.freeze({ kind: 'failed', error: settled.error })
      }
    }
    const result = await push(options.root, run)
    if (result.ok) {
      failures = 0
      return Object.freeze({ kind: 'pushed' })
    }
    failures += 1
    return Object.freeze({ kind: 'failed', error: result.error })
  }

  const report = (outcome: PushOutcome): PushOutcome => {
    options.onOutcome?.(outcome)
    if (outcome.kind === 'pushed') retries = 0
    return outcome
  }

  /**
   * Re-arm after a failure (decision 191).
   *
   * A flush that fails used to be the end of it: the caller was `void flushNow(...)`, so a rejected
   * push or a settle that could not commit left the commits local and the derived files stale with
   * **nothing** saying so — the store's own CI then went red on an innocent commit, twice
   * (DPMJ-103, and again on 2026-10-19 with two writes after a settle).
   *
   * Retried only for failures that can heal by waiting (a rejected push, a lock timeout, a pull that
   * could not run). A **stopped rebase** is not retried: red line 1 says a human resolves it.
   */
  const scheduleRetry = (outcome: PushOutcome): void => {
    if (disposed || !enabled || outcome.kind !== 'failed') return
    if (outcome.error.message.startsWith('pull --rebase stopped')) return
    if (retries >= MAX_PUSH_RETRIES) return
    retries += 1
    armed = timer.set(() => {
      armed = undefined
      void flushNow({ settle: true }).then(scheduleRetry)
    }, retryDelayMs(retries, debounceMs))
  }

  const flushNow = async (flush: FlushOptions = {}): Promise<PushOutcome> => {
    if (armed !== undefined) {
      timer.clear(armed)
      armed = undefined
    }
    return report(await pushNow(flush.settle === true))
  }

  return Object.freeze({
    dispose: () => {
      disposed = true
      if (armed !== undefined) {
        timer.clear(armed)
        armed = undefined
      }
    },
    schedule: () => {
      if (!enabled || disposed || armed !== undefined) return
      armed = timer.set(() => {
        armed = undefined
        // A write armed this timer, so the caller may write: settling here is always allowed.
        void flushNow({ settle: true }).then(scheduleRetry)
      }, debounceMs)
    },
    flushNow,
    isPending: () => armed !== undefined,
    failures: () => failures,
  })
}

/** A queue per store root, so a plugin registration and a CLI run share one debounce. */
const queues = new Map<string, PushQueue>()

export const sharedPushQueue = (options: PushQueueOptions): PushQueue => {
  const existing = queues.get(options.root)
  if (existing !== undefined) return existing
  const created = createPushQueue(options)
  queues.set(options.root, created)
  return created
}

export const forgetPushQueue = (root: string): void => {
  queues.delete(root)
}

/** The error a caller reports when a flush was asked for and could not happen. */
export const pushFailure = (outcome: PushOutcome): JiraError | undefined =>
  outcome.kind === 'failed' ? outcome.error : undefined
