/**
 * core/git — the audit layer: every write becomes a commit.
 *
 * Decision 2: the store is a git repository and git *is* the audit log, so there is no
 * second history to keep. Decision 5: the first file in the repository is
 * `.gitattributes` (`* text=auto eol=lf`, plus `merge=union` for comment files), because
 * without it Windows rewrites every line ending and the diffs stop meaning anything.
 *
 * The runner is injected so tests can drive a real repository without caring how git is
 * launched, and so a failure is a value (with the reason git printed) rather than an
 * exception. Nothing here pushes: that is the debounced queue's job (decision 60).
 */

import { spawn } from 'node:child_process'
import { system } from './system/index.ts'
import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { type JiraError, ioFailed } from './errors.ts'
import { type Result, err, ok } from './result.ts'
import { readText, writeTextAtomic } from './io.ts'

export type GitResult = Readonly<{ code: number; stdout: string; stderr: string }>

export type GitRunnerOptions = Readonly<{ timeoutMs?: number }>
export type GitRunner = (root: string, args: readonly string[], options?: GitRunnerOptions) => Promise<GitResult>

/** The `.gitattributes` that must exist before anything else is committed (decision 5). */
export const GITATTRIBUTES = [
  '# Written by dsh-jira: line endings and comment merging (DESIGN.md decisions 5/68).',
  '* text=auto eol=lf',
  '# Two machines appending comments offline must not conflict: union concatenates them,',
  '# and the comment ids carry the machine so the numbering cannot collide (decision 68).',
  'projects/*/comments/*.md merge=union',
  '',
].join('\n')

export const GITIGNORE = [
  '# Derived data is never versioned (decision 73): locks, temp files, caches, identity.',
  '.jira/',
  '# A machine identity must never travel inside a clone (decision 119): two machines',
  '# sharing one id would claim the same number block.',
  '.jira/machine-id',
  'var/',
  '# Atomic writes go through <file>.tmp-<pid>-<n> next to their target; a crash must not leave one',
  '# committed (decision 165). The adoption pathspec excludes them too, for stores whose .gitignore',
  '# predates this line.',
  '*.tmp-*',
  '',
].join('\n')

export const runGit: GitRunner = (root, args, options: GitRunnerOptions = {}) =>
  new Promise((resolve) => {
    const child = spawn('git', ['-C', root, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // Decision 151: `-C root` is the only authority on which repository this is. A stray
      // GIT_DIR/GIT_WORK_TREE (a git hook, a CI image, a user shell) would silently point the
      // store's writes at another repository; the adapter strips exactly those.
      env: system.gitEnv(process.env),
    })
    let stdout = ''
    let stderr = ''
    // Decision 84: a network operation must be bounded. Killing the child is the only honest way
    // to stop git, and the caller sees a timed-out result rather than a hung session.
    const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => {
      child.kill()
      // The partial stderr is often the only clue to *what* was hanging — keep it (decision 165).
      resolve(Object.freeze({
        code: -1,
        stdout: '',
        stderr: `${stderr}timed out after ${String(options.timeoutMs)} ms`.trim(),
      }))
    }, options.timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (cause) => {
      // `close` never fires for a failed spawn, so the timer has to be cleared here too.
      if (timer !== undefined) clearTimeout(timer)
      resolve(Object.freeze({ code: -1, stdout: '', stderr: String(cause) }))
    })
    child.on('close', (code) => {
      if (timer !== undefined) clearTimeout(timer)
      resolve(Object.freeze({ code: code ?? -1, stdout: stdout.trim(), stderr: stderr.trim() }))
    })
  })

export const isRepository = async (root: string): Promise<boolean> => {
  try {
    await access(join(root, '.git'))
    return true
  } catch {
    return false
  }
}

/**
 * Create the repository, with `.gitattributes` as its first content and the two settings
 * decision 81 owns (`core.fileMode=false`, `i18n.commitEncoding=utf-8`). Existing values
 * are never overwritten: the plugin only fills in what is missing.
 */

/** The patterns of a list, ignoring comments and blanks. */
const patternsOf = (text: string): string[] =>
  text.split('\n').map(line => line.trim()).filter(line => line !== '' && !line.startsWith('#'))

/**
 * Make sure an existing `.gitignore` carries every pattern this version writes (decision 175).
 *
 * `initializeRepository` only writes the file when it is **absent**, so a store created before a pattern
 * was added never learns it — that is how `.jira/network.lock/` ended up committable in a live store.
 * Newly missing patterns are appended under their own comment; nothing else is rewritten.
 */
const migrateGitignore = async (root: string, run: GitRunner): Promise<void> => {
  const path = `${root}/.gitignore`
  let existing: string
  try {
    existing = await readFile(path, 'utf8')
  } catch {
    return
  }
  const known = new Set(patternsOf(existing))
  const missing = patternsOf(GITIGNORE).filter(pattern => !known.has(pattern))
  if (missing.length === 0) return
  const appended = `${existing.endsWith('\n') ? existing : `${existing}\n`}# added by dsh-jira ${new Date().toISOString().slice(0, 10)}\n${missing.join('\n')}\n`
  try {
    await writeFile(path, appended, 'utf8')
  } catch {
    // A read-only working tree is not an error here: the commit path filters `.jira/` anyway.
  }
  await run(root, ['add', '--', '.gitignore'])
}
export const initializeRepository = async (
  root: string,
  run: GitRunner = runGit,
): Promise<Result<boolean, JiraError>> => {
  if (await isRepository(root)) {
    // Already a repository: still make sure its `.gitignore` carries the current patterns (decision 175).
    await migrateGitignore(root, run)
    return ok(false)
  }
  const init = await run(root, ['init', '--initial-branch=main'])
  if (init.code !== 0) return err(ioFailed('git init failed', { stderr: init.stderr.slice(0, 500) }))

  const attributes = await ensureFile(join(root, '.gitattributes'), GITATTRIBUTES)
  if (!attributes.ok) return attributes
  const ignore = await ensureFile(join(root, '.gitignore'), GITIGNORE)
  if (!ignore.ok) return ignore
  const ignores = await ensureFile(join(root, '.git', 'info', 'exclude'), '')
  if (!ignores.ok) return ignores

  // Idempotent, never overwriting: only write a key the repository does not already have.
  // Decision 151: the list lives in the adapter, so "which git keys this store needs" is a
  // single answer rather than a literal repeated at every init site.
  for (const [key, value] of system.facts.gitConfig) {
    const existing = await run(root, ['config', '--local', '--get', key])
    if (existing.code === 0 && existing.stdout !== '') continue
    const written = await run(root, ['config', '--local', key, value])
    if (written.code !== 0) return err(ioFailed(`git config ${key} failed`, { stderr: written.stderr.slice(0, 500) }))
  }
  return ok(true)
}

const ensureFile = async (path: string, content: string): Promise<Result<boolean, JiraError>> => {
  const existing = await readText(path)
  if (existing.ok) return ok(false)
  const written = await writeTextAtomic(path, content)
  return written.ok ? ok(true) : written
}

/** `git config user.name`, for the `human:<name>` identity of §4.9. */
export const gitUserName = async (root: string, run: GitRunner = runGit): Promise<string | undefined> => {
  const result = await run(root, ['config', '--get', 'user.name'])
  return result.code === 0 && result.stdout !== '' ? result.stdout : undefined
}

/** What changed, in the words the commit subject uses (decision 67 fills in the key). */
export type CommitFacts = Readonly<{ key: string; what: string; revision?: number }>

/**
 * The subject for a change that belongs to no issue.
 *
 * `[no-issue]` must be on the **first line** (decision 67), and machines/projects are metadata
 * rather than issue work, so their commits say so explicitly instead of borrowing a key.
 */
export const noIssueSubject = (what: string): string => `${what} [no-issue]`

export const commitSubject = (facts: CommitFacts): string =>
  `${facts.key}: ${facts.what}${facts.revision === undefined ? '' : ` (rev ${facts.revision})`}`

/** The identity a store commit falls back to when the machine has none (decision 146). */
export const FALLBACK_COMMIT_NAME = 'dsh-jira'
export const FALLBACK_COMMIT_EMAIL = 'jira@local'

/**
 * The `-c` arguments that give a git command an identity when the machine has none.
 *
 * A store commit must not depend on ambient git configuration. On a CI runner, a fresh machine or
 * a container, `git commit` fails with "Author identity unknown" — and because the **file write**
 * succeeded, everything looks fine while **nothing is versioned at all**: no audit trail, no
 * `git revert`, no cross-machine sync, and `log.md` never gains a commit. The plugin's own CI
 * caught this (2026-10-16) and it reproduces with `user.useConfigOnly=true`.
 *
 * The identity is supplied **per invocation**, never written into the repository's config:
 * `user.name` is also what `human:<name>` reads for §4.9, so a local bot identity would silently
 * replace the human's name with `dsh-jira`. A key the machine already has is left alone
 * (decision 81's rule), so a developer's own name still lands on their commits.
 *
 * **Not only commits need this** (found 2026-10-17): `git pull --rebase` *replays* commits, and
 * replaying creates one, so a rebase needs a committer identity too. Without it the rebase stops
 * with "Committer identity unknown" and leaves the store mid-rebase — the push then never happens at
 * all. `core/rebase.ts` passes the same arguments for exactly that reason (decisions 119/146/148).
 */
export const identityArgs = async (root: string, run: GitRunner = runGit): Promise<readonly string[]> => {
  const args: string[] = []
  const name = await run(root, ['config', '--get', 'user.name'])
  if (name.code !== 0 || name.stdout.trim() === '') args.push('-c', `user.name=${FALLBACK_COMMIT_NAME}`)
  const email = await run(root, ['config', '--get', 'user.email'])
  if (email.code !== 0 || email.stdout.trim() === '') args.push('-c', `user.email=${FALLBACK_COMMIT_EMAIL}`)
  return Object.freeze(args)
}

/**
 * The human's identity as git knows it, as a `Name <email>` author string.
 *
 * §4.13 rule 1 keeps the human as the **author** of the commit that adopts their uncommitted work, so
 * the audit trail says a person wrote it even though the tool performed the commit. `undefined` when
 * the machine has no identity at all: there is then no human name to preserve, and decision 146's
 * fallback (supplied per invocation) is the honest answer.
 */
export const humanAuthorOf = async (root: string, run: GitRunner = runGit): Promise<string | undefined> => {
  const name = await run(root, ['config', '--get', 'user.name'])
  const email = await run(root, ['config', '--get', 'user.email'])
  const who = name.stdout.trim()
  const at = email.stdout.trim()
  if (name.code !== 0 || email.code !== 0 || who === '' || at === '') return undefined
  return `${who} <${at}>`
}

/** What `git diff --cached --name-only -z` printed, as a path list (NUL-separated, so odd paths survive). */
const stagedPaths = (stdout: string): readonly string[] =>
  Object.freeze(stdout.split('\u0000').map(line => line.trim()).filter(line => line !== ''))

/** Commit exactly the paths git already has staged, with an optional author. */
const commitStaged = async (
  root: string,
  files: readonly string[],
  subject: string,
  run: GitRunner,
  author?: string,
): Promise<Result<readonly string[], JiraError>> => {
  const identity = await identityArgs(root, run)
  const commit = await run(root, [
    ...identity,
    'commit', '--no-verify', '-m', subject,
    ...(author === undefined ? [] : [`--author=${author}`]),
    '--', ...files,
  ])
  if (commit.code !== 0) {
    return err(ioFailed('git commit failed', {
      stderr: commit.stderr.slice(0, 500),
      stdout: commit.stdout.slice(0, 500),
    }))
  }
  return ok(Object.freeze(files))
}

/**
 * `stageAllAndCommit`, minus pathspecs the caller knows are **not** the human's (decision 165).
 *
 * The adoption sweep must not pick up two things: a file another transaction has already written but
 * not committed yet (it holds an issue lock right now, and swallowing its write under the human's name
 * turns the agent's own commit into a silent `committed: false`), and an in-flight `<file>.tmp-<pid>-<n>`
 * from an atomic write. `:(exclude,literal)` and `:(exclude,glob)` rather than `git reset` afterwards:
 * nothing is ever staged, so a failure between the two steps cannot leave a half-staged index behind.
 */
export const stageAllExceptAndCommit = async (
  root: string,
  exclude: readonly string[],
  subject: string,
  run: GitRunner = runGit,
  author?: string,
): Promise<Result<readonly string[], JiraError>> => {
  const specs = exclude.map(path => `:(exclude,literal)${path.replace(/\\/gu, '/')}`)
  const added = await run(root, ['add', '-A', '--', '.', ':(exclude,glob)**/*.tmp-*', ...specs])
  if (added.code !== 0) {
    return err(ioFailed('git add -A (excluding in-flight paths) failed', { stderr: added.stderr.slice(0, 500) }))
  }

  const staged = await run(root, ['diff', '--cached', '--name-only', '-z'])
  if (staged.code !== 0) return err(ioFailed('git diff --cached failed', { stderr: staged.stderr.slice(0, 500) }))
  const files = stagedPaths(staged.stdout)
  if (files.length === 0) return ok(Object.freeze([]))
  return commitStaged(root, files, subject, run, author)
}

/**
 * Stage **everything** not ignored and commit it, returning the paths that went in.
 *
 * The difference from `stageAndCommit` is the point: that one stages a list the caller believes in
 * (this write's own paths), while this one has to take whatever anybody left behind — that is what
 * "the working tree has uncommitted changes" means. `git add -A` handles edits, deletions, renames
 * and untracked files uniformly, and still respects `.gitignore`, so `var/` and `.jira/` stay out.
 */
export const stageAllAndCommit = async (
  root: string,
  subject: string,
  run: GitRunner = runGit,
  author?: string,
): Promise<Result<readonly string[], JiraError>> => {
  const added = await run(root, ['add', '-A'])
  if (added.code !== 0) return err(ioFailed('git add -A failed', { stderr: added.stderr.slice(0, 500) }))

  const staged = await run(root, ['diff', '--cached', '--name-only', '-z'])
  if (staged.code !== 0) return err(ioFailed('git diff --cached failed', { stderr: staged.stderr.slice(0, 500) }))
  const files = staged.stdout.split('\u0000').map(line => line.trim()).filter(line => line !== '')
  if (files.length === 0) return ok(Object.freeze([]))

  const identity = await identityArgs(root, run)
  const commit = await run(root, [
    ...identity,
    'commit', '--no-verify', '-m', subject,
    ...(author === undefined ? [] : [`--author=${author}`]),
    '--', ...files,
  ])
  if (commit.code !== 0) {
    return err(ioFailed('git commit failed', {
      stderr: commit.stderr.slice(0, 500),
      stdout: commit.stdout.slice(0, 500),
    }))
  }
  return ok(Object.freeze(files))
}

/**
 * Stage exactly the given paths and commit them. Returns `false` when there was nothing to
 * commit (a no-op update must not create an empty commit), and an error carrying git's own
 * words when the commit failed — the caller keeps the written file either way, and says so.
 */
export const stageAndCommit = async (
  root: string,
  paths: readonly string[],
  subject: string,
  run: GitRunner = runGit,
): Promise<Result<boolean, JiraError>> => {
  if (paths.length === 0) return ok(false)
  const add = await run(root, ['add', '--', ...paths])
  if (add.code !== 0) return err(ioFailed('git add failed', { stderr: add.stderr.slice(0, 500) }))

  // Ask git what it actually staged rather than reusing our own path list: a directory
  // that exists but is empty passes an existence check, yet `git commit -- <dir>` refuses
  // it ("pathspec did not match any file(s) known to git") and the commit is lost.
  const staged = await run(root, ['diff', '--cached', '--name-only', '--', ...paths])
  if (staged.code !== 0) return err(ioFailed('git diff --cached failed', { stderr: staged.stderr.slice(0, 500) }))
  const files = staged.stdout.split('\n').map(line => line.trim()).filter(line => line !== '')
  if (files.length === 0) return ok(false)

  const identity = await identityArgs(root, run)
  const commit = await run(root, [...identity, 'commit', '--no-verify', '-m', subject, '--', ...files])
  if (commit.code !== 0) {
    return err(ioFailed('git commit failed', {
      stderr: commit.stderr.slice(0, 500),
      stdout: commit.stdout.slice(0, 500),
    }))
  }
  return ok(true)
}

/** Whether a push would go anywhere at all: no remote means the store is local-only. */
export const hasRemote = async (root: string, run: GitRunner = runGit): Promise<boolean> => {
  const remotes = await run(root, ['remote'])
  return remotes.code === 0 && remotes.stdout !== ''
}

export type AheadBehind = Readonly<{ ahead: number; behind: number }>

/**
 * How far this checkout has drifted from its upstream (decision 171's drift report).
 * A failed `rev-list` (no upstream, for one) reads as zero — drift reporting must never
 * break the command that carries it. Decision 187: this used to be two inline `rev-list`
 * calls in the CLI's sync handler.
 */
export const aheadBehind = async (root: string, run: GitRunner = runGit): Promise<AheadBehind> => {
  const ahead = await run(root, ['rev-list', '--count', '@{u}..HEAD'])
  const behind = await run(root, ['rev-list', '--count', 'HEAD..@{u}'])
  return Object.freeze({
    ahead: ahead.code === 0 ? Number(ahead.stdout.trim()) : 0,
    behind: behind.code === 0 ? Number(behind.stdout.trim()) : 0,
  })
}

export const push = async (
  root: string,
  run: GitRunner = runGit,
  timeoutMs?: number,
): Promise<Result<boolean, JiraError>> => {
  if (!(await hasRemote(root, run))) return ok(false)
  // Decision 165: a hung network must not wedge the push queue forever — the same bound the pull
  // already has (decision 84).
  const result = await run(root, ['push'], timeoutMs === undefined ? {} : { timeoutMs })
  // A failed push is not an error to the caller: the commit is safe locally and the next
  // sync retries (decision 60). It *is* reported, so a permanent failure is visible.
  return result.code === 0 ? ok(true) : err(ioFailed('git push failed', { stderr: result.stderr.slice(0, 500) }))
}
