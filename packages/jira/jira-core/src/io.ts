/**
 * core/io — the filesystem boundary.
 *
 * §3.1 ①: side effects live here and nowhere else. Everything in this file takes its
 * inputs as arguments, so `core`'s pure atoms stay pure; the CLI and the plugin adapter
 * are the only callers.
 *
 * Disk rules that come from the design:
 *  - UTF-8 **without BOM**, **LF only** (decision 5's eleven platform traps; §5 item 1/9);
 *  - atomic write = temp file + rename, retried 3× with 50 ms exponential backoff, and a
 *    loud `WRITE_FAILED` when it still cannot land (decision 60);
 *  - a path longer than 240 characters warns at startup (decision 60 / Windows' 260).
 */

import { createHash } from 'node:crypto'
import { access, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'

import { type Identity, type Issue, type IssueKey, type Timestamp, commentRelPath, issueRelPath, projectOf, projectRelPath } from './entity.ts'
import { type DecodedIssue, decodeIssue } from './codec.ts'
import { type JiraError, ioFailed, notFound } from './errors.ts'
import { type Result, err, ok } from './result.ts'
import { system } from './system/index.ts'
import { PATH_LENGTH_WARN } from './system/paths.ts'
import { type SourceTreeEntry } from './generate.ts'

// The threshold is owned by the System adapter (decision 60/167) — one definition, not two.
export { PATH_LENGTH_WARN } from './system/paths.ts'
const WRITE_ATTEMPTS = system.writeAttempts


/** The minimum a filesystem operation needs from a store: an absolute root directory. */
export type FileStore = Readonly<{ root: string }>

/**
 * Wrap a root directory as a store handle.
 * @param root - the absolute directory the store lives in.
 * @returns the frozen handle.
 */
export const fileStore = (root: string): FileStore => Object.freeze({ root })

/**
 * The absolute forms of the path rules in `entity.ts` (decision 182): the rule itself is
 * store-relative and posix; this is where — and the only place where — it meets a root.
 * @param store - the store whose root the path hangs from.
 * @param project - the project key, which is also the directory name.
 * @param key - the issue key naming the file.
 * @returns the absolute, platform-native path of the issue file.
 */
export const issuePath = (store: FileStore, project: string, key: IssueKey): string =>
  join(store.root, ...issueRelPath(project, key).split('/'))

/**
 * The absolute form of the comment-path rule, the only place that rule meets a root.
 * @param store - the store whose root the path hangs from.
 * @param project - the project key, which is also the directory name.
 * @param key - the issue key naming the file.
 * @returns the absolute, platform-native path of the comment file.
 */
export const commentsPath = (store: FileStore, project: string, key: IssueKey): string =>
  join(store.root, ...commentRelPath(project, key).split('/'))

/**
 * The absolute form of the project-path rule, the only place that rule meets a root.
 * @param store - the store whose root the path hangs from.
 * @param project - the project key.
 * @returns the absolute, platform-native path of `project.md`.
 */
export const projectPath = (store: FileStore, project: string): string =>
  join(store.root, ...projectRelPath(project).split('/'))

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** The old name for the entity rule (decision 174): one definition, in `entity.ts`. */
export const projectOfKey = projectOf

/**
 * A **file-level** failure. Deliberately not a `JiraError`: a generic reader must not
 * invent domain meaning ("this issue does not exist") out of "this path has no file" —
 * the domain layer does that translation, with the issue key in the context.
 */
export type FileFailure = Readonly<{
  kind: 'missing' | 'unreadable'
  path: string
  cause?: string
}>

const failureOf = (path: string, cause: unknown): FileFailure => {
  const code = (cause as { code?: string }).code
  const kind = code === 'ENOENT' || code === 'EISDIR' ? 'missing' : 'unreadable'
  return Object.freeze({ kind, path, ...(code === undefined ? {} : { cause: code }) })
}

/**
 * Read a file as UTF-8 text.
 * @param path - the absolute path to read.
 * @returns the text, or the file-level failure that says why it is unreadable.
 */
export const readText = async (path: string): Promise<Result<string, FileFailure>> => {
  try {
    return ok(await readFile(path, 'utf8'))
  } catch (cause) {
    return err(failureOf(path, cause))
  }
}

/* ── the directory primitives every other core module shares (decision 180) ───── */

/**
 * Probe: `true` when the path exists at all. Never throws and never distinguishes why not —
 * existence is a fact, not a failure, so this one returns a plain boolean.
 * @param path - the absolute path to probe.
 * @returns true when the path exists and is accessible.
 */
export const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * The **names** in a directory, in the order the filesystem returned them (callers that need a
 * stable order sort themselves). A missing directory is `err` with `kind: 'missing'` — most
 * callers treat that as "empty", but they say so themselves instead of being defaulted.
 * @param path - the absolute directory to list.
 * @returns the entry names, or the file-level failure that says why it cannot be listed.
 */
export const listDir = async (path: string): Promise<Result<readonly string[], FileFailure>> => {
  try {
    return ok(Object.freeze(await readdir(path)))
  } catch (cause) {
    return err(failureOf(path, cause))
  }
}

/** One directory entry: a frozen data point, not Node's `Dirent` (which would leak node:fs types). */
export type FsEntry = Readonly<{ name: string; isFile: boolean; isDirectory: boolean }>

/**
 * Like {@link listDir}, with type flags, for callers that descend or filter by kind.
 * @param path - the absolute directory to list.
 * @returns the entries with their file and directory flags, or the file-level failure.
 */
export const listDirEntries = async (path: string): Promise<Result<readonly FsEntry[], FileFailure>> => {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    return ok(Object.freeze(entries.map(entry =>
      Object.freeze({ name: entry.name, isFile: entry.isFile(), isDirectory: entry.isDirectory() }))))
  } catch (cause) {
    return err(failureOf(path, cause))
  }
}

/**
 * `mkdir -p`: recursive, and an already-existing directory is success.
 * @param path - the directory to create.
 * @returns nothing on success, or the `WRITE_FAILED` error naming the path.
 */
export const mkdirp = async (path: string): Promise<Result<void, JiraError>> => {
  try {
    await mkdir(path, { recursive: true })
    return ok(undefined)
  } catch (cause) {
    return err(ioFailed(`cannot create ${path}`, { path, cause: String(cause) }))
  }
}

/**
 * Write text atomically. Rejects CR and BOM outright: a file that would violate the
 * store's encoding rules is a bug in the caller, not something to normalize silently.
 * @param path - the file to write.
 * @param text - the exact text to write; a BOM or a CR is refused, never normalized.
 * @returns nothing on success, or the error that kept the write from landing.
 */
export const writeTextAtomic = async (path: string, text: string): Promise<Result<void, JiraError>> => {
  if (text.startsWith('\uFEFF')) return err(ioFailed('refusing to write a BOM', { path }))
  if (text.includes('\r')) return err(ioFailed('refusing to write CR; the store is LF-only', { path }))
  if (path.length > PATH_LENGTH_WARN) {
    // A warning, not a failure: Windows allows up to 260 in the common case. This goes straight to
    // the process because `writeTextAtomic` is deep in core and carries no injected io; the visible
    // gate is the startup check in `core/config` (decision 156), so this is only the last-resort
    // tripwire, not the messaging path (DPMJ-211: deliberately not an injected option — threading a
    // warn callback through every write call costs more than the tripwire is worth).
    process.emitWarning(`long path (${path.length} chars): ${path}`)
  }

  const directory = dirname(path)
  try {
    await mkdir(directory, { recursive: true })
  } catch (cause) {
    return err(ioFailed(`cannot create ${directory}`, { path, cause: String(cause) }))
  }

  let lastFailure = 'unknown'
  for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt += 1) {
    const temporary = `${path}.tmp-${process.pid}-${attempt}`
    try {
      await writeFile(temporary, text, { encoding: 'utf8', flag: 'w' })
      await rename(temporary, path)
      return ok(undefined)
    } catch (cause) {
      lastFailure = String((cause as { code?: string }).code ?? cause)
      await rm(temporary, { force: true }).catch(() => undefined)
      if (attempt < WRITE_ATTEMPTS) {
        await sleep(system.writeDelayMs(attempt))
      }
    }
  }
  return err(ioFailed(`atomic write failed after ${WRITE_ATTEMPTS} attempts`, { path, lastFailure }))
}

/**
 * Read one issue: the file name carries the key, so the caller supplies it. The
 * file-level failure is translated here, which is why a missing issue reports the **key**
 * (not a path) and an unreadable one reports the path it could not read.
 * @param store - the store to read from.
 * @param key - the issue key, which is also the file name.
 * @returns the decoded issue, or the domain error a caller can act on.
 */
export const readIssue = async (
  store: FileStore,
  key: IssueKey,
): Promise<Result<DecodedIssue, JiraError>> => {
  const project = projectOfKey(key)
  const text = await readText(issuePath(store, project, key))
  if (!text.ok) {
    return text.error.kind === 'missing'
      ? err(notFound(key))
      : err(ioFailed('cannot read the issue file', { key, path: text.error.path, cause: text.error.cause }))
  }
  return decodeIssue(text.value, key)
}

/**
 * Write one issue's file, creating its directory when it does not exist yet.
 * @param store - the store to write into.
 * @param text - the encoded file text.
 * @param key - the issue key, which is also the file name.
 * @returns nothing on success, or the error that kept the write from landing.
 */
export const writeIssue = async (store: FileStore, text: string, key: IssueKey): Promise<Result<void, JiraError>> =>
  writeTextAtomic(issuePath(store, projectOfKey(key), key), text)

/** Derived, never stored: these are computed at render time (decision 42). */
export type IssueFacts = Readonly<{
  open: boolean
  blocked: boolean
  ageSeconds: number
}>

/**
 * The derived facts a board or a list needs, computed without touching the store.
 * @param issue - the issue to measure.
 * @param closedStatuses - the statuses the vocabulary treats as closed.
 * @param now - the instant the age is measured against.
 * @param hasOpenBlocker - whether an unclosed blocker exists, which the link walk decides.
 * @returns whether the issue is open, whether it is blocked, and how old its last update is.
 */
export const issueFacts = (
  issue: Issue,
  closedStatuses: readonly string[],
  now: Timestamp,
  hasOpenBlocker: boolean,
): IssueFacts => {
  const updated = Date.parse(issue.updatedAt)
  const current = Date.parse(now)
  return Object.freeze({
    open: !closedStatuses.includes(issue.status),
    blocked: hasOpenBlocker,
    ageSeconds: Number.isNaN(updated) || Number.isNaN(current) ? 0 : Math.max(0, Math.round((current - updated) / 1000)),
  })
}

/** Re-exported so callers do not need two imports for the identity type. */
export type { Identity }

/* ── the source tree the generated heads hash (decision 79) ───────────────────── */

const PRUNED_DIRS = new Set(['.git', '.jira', 'var', 'node_modules'])

/**
 * Is this store file one of the **inputs** the generated files are computed from?
 *
 * An allow-list, deliberately: `source_tree` is asserted against a regeneration, so anything that
 * does not change the output must stay out of it or every unrelated write would mark the board
 * stale. Appending a comment, claiming a key (a counter file), recording a session or editing the
 * README all leave the generated files byte-identical, so none of them may enter the hash.
 *
 * `log.md` is the one output whose input is not a file — it lists commits. Its head therefore
 * cannot prove freshness on its own; CI proves it by regenerating and diffing.
 */
const isGeneratedInput = (path: string): boolean =>
  (path === 'config.md'
    || /^projects\/[^/]+\/project\.md$/u.test(path)
    || /^projects\/[^/]+\/issues\/[^/]+\.md$/u.test(path)
    || /^knowledge\/.+\.md$/u.test(path)
    || /^tags\/[^/]+\.md$/u.test(path))
  // Decision 79: a bundle's own generated files are **outputs**. Counting one as an input would make
  // the source hash depend on the very files it exists to prove fresh — and `tags/index.md` (decision
  // 87) was already being counted that way before this.
  && !/(^|\/)(index|log)\.md$/u.test(path)

/**
 * The store's generated-input files, each with the sha256 of its bytes, sorted by path.
 *
 * Reads the tree, so it lives here and not in `core/generate` (§3.1). Paths come back
 * store-relative and posix-shaped, so the hash is the same on Fedora and on Windows.
 * @param root - the store's absolute root directory.
 * @returns the entries sorted by path, or the error that stopped the walk.
 */
export const sourceTreeEntries = async (root: string): Promise<Result<readonly SourceTreeEntry[], JiraError>> => {
  const found: SourceTreeEntry[] = []

  // Decision 169: this walk feeds the `source_tree` hash every derived file carries, so it must not
  // **skip** what it cannot read — a hash over a partial tree would declare stale files fresh. A missing
  // subtree is fine (a store may not have one yet); anything else is reported, and a file that vanishes
  // mid-walk is an error rather than an exception escaping a `Result`-returning API.
  const walk = async (dir: string): Promise<Result<undefined, JiraError>> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (cause) {
      if ((cause as { code?: string }).code === 'ENOENT') return ok(undefined)
      return err(ioFailed('cannot read the store tree', { path: dir, code: (cause as { code?: string }).code ?? '' }))
    }
    for (const entry of entries) {
      const absolute = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (PRUNED_DIRS.has(entry.name)) continue
        const descended = await walk(absolute)
        if (!descended.ok) return descended
        continue
      }
      if (!entry.isFile()) continue
      const path = relative(root, absolute).split(/[\\/]/u).join('/')
      if (!isGeneratedInput(path) || path === 'tags/index.md') continue
      let bytes: Buffer
      try {
        bytes = await readFile(absolute)
      } catch (cause) {
        return err(ioFailed('cannot read a file while hashing the store tree', {
          path,
          code: (cause as { code?: string }).code ?? '',
        }))
      }
      found.push(Object.freeze({ path, sha256: createHash('sha256').update(bytes).digest('hex') }))
    }
    return ok(undefined)
  }

  const walked = await walk(root)
  if (!walked.ok) return walked
  return ok(Object.freeze(found))
}
