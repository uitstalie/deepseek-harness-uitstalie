/**
 * core/rebase — pulling with a rebase, and marking what both sides touched (decisions 4/71/84/119).
 *
 * Two machines writing the same ledger will diverge, so the design says: **pull with `--rebase`
 * before pushing** (decision 119), with a **15 s** bound on the network step (decision 84), and when
 * the same issue was changed on both sides, do not pretend it merged cleanly — mark it `conflicted`
 * (decision 71) so the next write has to acknowledge it.
 *
 * Three rules this module refuses to bend:
 *
 *   - **never force** (red line 1): a rebase that stops is *reported*, not resolved by throwing away
 *     somebody's work;
 *   - **a read path never writes** (decision 38): the marking happens here, on an explicit
 *     sync/push path, and reuses the normal write transaction (so it locks, commits and audits);
 *   - the failure of one issue to mark does not hide the others: each is reported in the outcome.
 */

import { type IssueKey, asIssueKey } from './entity.ts'
import { type JiraError } from './errors.ts'
import { type GitRunner, identityArgs, runGit } from './git.ts'
import { issueLockPath, lockOptionsOf, lockOwnerOf, networkLockPath, withLock } from './lock.ts'
import { keysIn } from './commitmsg.ts'
import { applyComment, applyConflictMark, combineChanges } from './mutate.ts'
import { type Result, ok } from './result.ts'
import { type Actor, type Store, transact } from './store.ts'

/** Decision 84: the network step is bounded, and this is the bound. */
export const REBASE_TIMEOUT_MS = 15_000

export type RebaseOutcome = Readonly<{
  /** A rebase ran and succeeded. */
  pulled: boolean
  /** The rebase stopped: git could not merge, and nothing was forced. */
  stopped: boolean
  reason?: string
  /** Issues touched by both sides, now carrying `conflicted: true`. */
  marked: readonly string[]
  /** Keys both sides touched that could not be marked (a lock timeout, an IO failure). */
  failed: readonly string[]
}>

const EMPTY: RebaseOutcome = Object.freeze({ pulled: false, stopped: false, marked: Object.freeze([]), failed: Object.freeze([]) })

/** The issue keys mentioned by commits in a range, newest first, deduplicated. */
export const keysTouchedIn = async (
  root: string,
  range: string,
  run: GitRunner = runGit,
): Promise<readonly IssueKey[]> => {
  const listed = await run(root, ['log', '--format=%s', range])
  if (listed.code !== 0) return Object.freeze([])
  const keys: IssueKey[] = []
  for (const subject of listed.stdout.split('\n')) {
    for (const key of keysIn(subject)) if (!keys.includes(key)) keys.push(key)
  }
  return Object.freeze(keys)
}

/**
 * `git pull --rebase`, bounded, then mark the issues both sides changed.
 *
 * Returns `ok` even when the rebase **stops**: a stopped rebase is a normal, reportable state (the
 * human has to look), not an error of this call.
 */
export const pullRebase = async (
  store: Store,
  actor: Actor,
  options: Readonly<{ run?: GitRunner; timeoutMs?: number }> = {},
): Promise<Result<RebaseOutcome, JiraError>> => {
  // Decision 171: one network step at a time per clone. Without this, two processes that both pull
  // race on the branch ref and git refuses the loser ("fetch updated the current branch ..."), which
  // the settle path turns into "do not push" — silently.
  return withLock(networkLockPath(store.files.root), lockOwnerOf(store, actor.at), lockOptionsOf(store), async () =>
    pullRebaseLocked(store, actor, options))
}

const pullRebaseLocked = async (
  store: Store,
  actor: Actor,
  options: Readonly<{ run?: GitRunner; timeoutMs?: number }> = {},
): Promise<Result<RebaseOutcome, JiraError>> => {
  const run = options.run ?? runGit
  const root = store.files.root
  const timeoutMs = options.timeoutMs ?? REBASE_TIMEOUT_MS

  const remotes = await run(root, ['remote'])
  if (remotes.code !== 0 || remotes.stdout.trim() === '') return ok(EMPTY)

  const local = await run(root, ['rev-parse', 'HEAD'])
  // `@{u}` is only as fresh as the last fetch, so ask the remote first — bounded like everything else
  // on this path (decision 84). A fetch that fails is not fatal: the pull below will say so.
  await run(root, ['fetch', '--quiet'], { timeoutMs })
  const upstream = await run(root, ['rev-parse', '@{u}'])
  if (local.code !== 0 || upstream.code !== 0) return ok(EMPTY)
  const localHead = local.stdout.trim()
  const remoteHead = upstream.stdout.trim()
  if (localHead === '' || remoteHead === '' || localHead === remoteHead) return ok(EMPTY)

  const base = await run(root, ['merge-base', localHead, remoteHead])
  const mergeBase = base.code === 0 ? base.stdout.trim() : ''

  // Decision 146 applies to the rebase too — found by the plugin's own CI on 2026-10-17, after the
  // push-path settle (decision 148) made the rebase load-bearing for *every* write. A rebase
  // **replays** commits, and replaying creates one, so it needs a committer identity exactly like
  // `git commit` does; on a runner or container where git cannot guess one, `pull --rebase` stops
  // with "Committer identity unknown", leaves the store mid-rebase (HEAD detached, the replayed file
  // staged) and the push never happens. The same per-invocation identity fixes it, and it is never
  // written into the repository's config (decision 81's rule).
  const identity = await identityArgs(root, run)
  let pulled = await run(root, [...identity, 'pull', '--rebase'], { timeoutMs })
  // Decision 171: "fetch updated the current branch" is **retryable**, not a real conflict — another
  // process on this clone fetched between our fetch and our rebase. Retry once (the network lock makes
  // it rare; a person's `git fetch` in a terminal can still do it), and only report it if it recurs.
  if (pulled.code !== 0 && /更新了当前的分支|updated the current branch|快进|fast-forward/iu.test(pulled.stderr)) {
    pulled = await run(root, [...identity, 'pull', '--rebase'], { timeoutMs })
  }
  if (pulled.code !== 0) {
    const first = pulled.stderr.trim().split('\n').find(line => line.trim() !== '') ?? 'the rebase stopped'
    // Reported, never forced: a stopped rebase means a human has to look (red line 1).
    return ok(Object.freeze({
      pulled: false,
      stopped: true,
      reason: first,
      marked: Object.freeze([]),
      failed: Object.freeze([]),
    }))
  }

  if (mergeBase === '') return ok(Object.freeze({ pulled: true, stopped: false, marked: Object.freeze([]), failed: Object.freeze([]) }))

  const ours = await keysTouchedIn(root, `${mergeBase}..${localHead}`, run)
  const theirs = new Set((await keysTouchedIn(root, `${mergeBase}..${remoteHead}`, run)).map(String))
  const both = ours.filter(key => theirs.has(String(key)))

  const marked: string[] = []
  const failed: string[] = []
  for (const key of both) {
    const result = await transact(store, key, actor, (issue, ctx) => {
      const marked = applyConflictMark(issue, ctx)
      if (!marked.ok) return marked
      // The comment must be computed on the *marked* issue: combineChanges keeps the second's
      // issue, so passing the original here would quietly undo the flag.
      const commented = applyComment(
        marked.value.issue,
        `Both sides changed ${String(key)}; git merged what it could. Read the result and acknowledge the conflict.`,
        ctx,
      )
      if (!commented.ok) return commented
      return ok(combineChanges(marked.value, commented.value))
    }, 'conflict')
    if (result.ok) marked.push(String(key))
    else failed.push(String(key))
  }

  return ok(Object.freeze({
    pulled: true,
    stopped: false,
    marked: Object.freeze(marked),
    failed: Object.freeze(failed),
  }))
}

/** A one-line summary for a CLI or a log. */
export const renderRebase = (outcome: RebaseOutcome): string => {
  if (outcome.stopped) return `pull --rebase stopped: ${outcome.reason ?? 'unknown reason'} (resolve it by hand; nothing was forced)`
  if (!outcome.pulled) return 'nothing to pull'
  const parts = ['pulled and rebased']
  if (outcome.marked.length > 0) parts.push(`marked conflicted: ${outcome.marked.join(', ')}`)
  if (outcome.failed.length > 0) parts.push(`could not mark: ${outcome.failed.join(', ')}`)
  return parts.join('; ')
}

/** The lock path an issue's own transaction uses — exported for tests that assert on it. */
export const rebaseLockPathOf = (store: Store, key: string): string => issueLockPath(store.files.root, asIssueKey(key) ?? (key as IssueKey))
