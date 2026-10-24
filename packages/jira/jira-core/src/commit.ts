/**
 * core/commit — turning a finished write into a commit, and adopting what a human left
 * uncommitted (decisions 2, 58, 74, 120, 147, 148, 165, 175, 176).
 *
 * Split out of `store.ts` (decision 185): the transaction engine there decides **what** to
 * write; everything here decides **how a write becomes a commit**. The `Store` type is
 * imported type-only, so the dependency arrow stays one way at runtime
 * (`store → commit`, never the reverse).
 *
 * Two fixed rules live here:
 *   - lock order is always **issue → store** (decision 58): callers hold their issue lock and
 *     this module takes the store lock, never the other way round;
 *   - nothing alive under `.jira/` is ever committed (decision 175): that state is
 *     machine-local (locks, the machine id), so the staging list filters it explicitly.
 */

import { basename, join } from 'node:path'

import { type IssueKey, type Timestamp, commentRelPath, issueRelPath, projectOf } from './entity.ts'
import { type JiraError } from './errors.ts'
import { commitSubject, humanAuthorOf, initializeRepository, noIssueSubject, runGit, stageAllExceptAndCommit, stageAndCommit } from './git.ts'
import { exists, listDir } from './io.ts'
import { lockOptionsOf, lockOwnerOf, storeLockPath, withLock } from './lock.ts'
import { type Result, ok } from './result.ts'
import { type Store } from './store.ts'

/** Only the paths that exist: `git add` refuses a path that is not there. */
const existingPaths = async (root: string, relative: readonly string[]): Promise<readonly string[]> => {
  const found: string[] = []
  for (const path of relative) {
    if (await exists(join(root, path))) found.push(path)
  }
  return Object.freeze(found)
}

/**
 * Commit the given store-relative paths plus the store-level data every commit carries.
 *
 * Shared by the issue and knowledge write paths so neither can quietly stop versioning the
 * vocabulary, the counters or the generated inputs (decisions 2/74/120). Runs under the
 * **store lock** (decision 58 protects `git add/commit`), while the caller's issue lock is
 * still held — the fixed order is issue → store.
 *
 * A failed commit does not undo the write: the file is the truth source, so the caller
 * gets the data plus a loud reason (decision 80's shape, not a silent failure). The first
 * commit of a store also carries `.gitattributes`, so decision 5 holds in history too.
 */
export const commitStoreWrite = async (
  store: Store,
  at: Timestamp,
  extraPaths: readonly string[],
  subject: string,
  /**
   * Run **inside the store lock, immediately before the commit** (decision 165), and commit whatever
   * paths it returns. It exists for the one thing that cannot be prepared outside the lock: a caller
   * that rendered derived files from a tree snapshot has to re-check that snapshot here, because a
   * concurrent write may have moved the inputs in between.
   */
  beforeCommit?: () => Promise<Result<readonly string[], JiraError>>,
): Promise<Result<Readonly<{ committed: boolean; error?: JiraError }>, JiraError>> => {
  const root = store.files.root
  const relative = await existingPaths(root, [
    // The skeleton comes first in history (decision 5).
    '.gitattributes',
    '.gitignore',
    // Store-level data is versioned like everything else: the vocabulary *is* the rules, and the
    // counters must be shared or two machines would claim the same block (decisions 2/74/120).
    // `git add` on an unchanged path is a no-op.
    'config.md',
    'README.md',
    'tags',
    'counters',
    'knowledge',
    // …and then the files this write actually changed.
    ...extraPaths,
  ])
  return withLock(storeLockPath(root), lockOwnerOf(store, at), lockOptionsOf(store), async () => {
    // Decision 176: `git init` is itself a write to the store, so it belongs **inside** the lock — two
    // first-time writers used to race here and the loser's error was swallowed as a soft failure.
    const initialized = await initializeRepository(root, runGit)
    if (!initialized.ok) return ok(Object.freeze({ committed: false, error: initialized.error }))
    const prepared = beforeCommit === undefined ? ok(Object.freeze([] as readonly string[])) : await beforeCommit()
    if (!prepared.ok) return ok(Object.freeze({ committed: false, error: prepared.error }))
    // Decision 175: nothing alive under `.jira/` may ever be committed — it is machine-local state
    // (locks, the machine id, caches). `stageAndCommit` uses an exact pathspec, but a path that got into
    // `relative`/`prepared` by mistake would still be staged, so the guard is explicit here.
    const paths = [...new Set([...relative, ...prepared.value])].filter(path => !path.startsWith('.jira/'))
    const committed = await stageAndCommit(root, paths, subject, runGit)
    return committed.ok
      ? ok(Object.freeze({ committed: committed.value }))
      : ok(Object.freeze({ committed: false, error: committed.error }))
  })
}

/**
 * Commit one issue's two files (the issue and its comments) with the action's own audit subject
 * (decision 67). Used by the transaction engine and by creation in `store.ts`.
 */
export const commitWrite = async (
  store: Store,
  key: IssueKey,
  at: Timestamp,
  facts: Readonly<{ what: string; revision: number }>,
): Promise<Result<Readonly<{ committed: boolean; error?: JiraError }>, JiraError>> => {
  const project = projectOf(key)
  // Decision 182: pathspecs for `git add --` are the posix, store-relative form from `entity.ts`
  // (the old `join()` spelling produced backslashes on Windows and repeated the rule by hand).
  return commitStoreWrite(store, at, [
    issueRelPath(project, key),
    commentRelPath(project, key),
  ], commitSubject({ key, what: facts.what, revision: facts.revision }))
}

/**
 * §4.13 rule 1, a red line: whatever a human left uncommitted becomes its own commit first, with the
 * human kept as the **author**.
 *
 * This is the one place that stages paths **nobody listed** — that is the whole point, since the
 * changes belong to another hand. It is called before a write transaction and before the session-end
 * regeneration, because both build on the working tree and would otherwise leave a commit that
 * disagrees with the tree it was computed from (see the note inside `transact`).
 *
 * An empty result is the common case and costs one `git add -A` plus one `git diff`. A failure is
 * returned rather than swallowed: the caller refuses to write on top of a tree it could not settle,
 * and the human's changes are untouched either way (`git add` is not destructive).
 */
export const adoptHumanChanges = async (
  store: Store,
  at: Timestamp,
  /**
   * The caller's **own** lock, when it already holds one (decision 165). `transact` takes the issue
   * lock before it adopts, so its own lock is in the directory too — and the file behind it is the one
   * this adoption must still pick up (that is the human's edit it is protecting). Excluding one's own
   * lock is what tells "somebody else is mid-write" apart from "I am about to write".
   */
  ownLock?: string,
): Promise<Result<readonly string[], JiraError>> => {
  const root = store.files.root
  const initialized = await initializeRepository(root, runGit)
  if (!initialized.ok) return ok(Object.freeze([]))

  const author = await humanAuthorOf(root)
  return withLock(storeLockPath(root), lockOwnerOf(store, at), lockOptionsOf(store), async () =>
    stageAllExceptAndCommit(
      root,
      await inFlightPaths(root, ownLock),
      noIssueSubject('chore: 收编工作区里未提交的人工改动'),
      runGit,
      author,
    ))
}

/**
 * The issue and comment files of transactions that hold an issue lock **right now** (decision 165).
 *
 * Such a transaction has written its file and not yet committed; adopting it under "the human's
 * uncommitted work" would put another agent's words on the human's head, and the agent's own commit
 * would then find nothing to stage (`committed: false`, no error). The lock directory name is the issue
 * key, so the paths are derivable — a transaction that is merely *waiting* holds nothing and is still
 * adopted, which is right: its files really are just uncommitted work.
 *
 * The adoption runs under the store lock and always **after** the caller's own issue lock, so a lock
 * seen here belongs to somebody else: the fixed order is issue → store (decision 58).
 */
const inFlightPaths = async (root: string, ownLock?: string): Promise<readonly string[]> => {
  const listed = await listDir(join(root, '.jira', 'locks'))
  if (!listed.ok) return Object.freeze([])
  const names = listed.value
  const paths: string[] = []
  const own = ownLock === undefined ? undefined : basename(ownLock)
  for (const name of names) {
    if (!name.endsWith('.lock')) continue
    if (name === own) continue // that one is ours: its file is what we are here to adopt
    const key = name.slice(0, -'.lock'.length)
    const project = projectOf(key as IssueKey)
    if (project === '') continue
    paths.push(issueRelPath(project, key as IssueKey))
    paths.push(commentRelPath(project, key as IssueKey))
  }
  return Object.freeze(paths)
}
