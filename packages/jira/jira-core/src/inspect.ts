/**
 * core/inspect — the IO half of the doctor: read the whole store into a snapshot.
 *
 * Deliberately tolerant: a file that cannot be read becomes an absent entry, and the
 * checks say what that means. A health check that throws on the first broken file would be
 * useless precisely when it is needed.
 */

import { join, relative } from 'node:path'

import { type CommentFile, type CountersEntry, type GeneratedFile, type GitState, type IssueFile, type Snapshot } from './doctor.ts'
import { GENERATED_PATHS, hashSourceTree } from './generate.ts'
import { decodeIssue } from './codec.ts'
import { type IssueKey, type Issue, type LinkType } from './entity.ts'
import { type Vocab } from './vocab.ts'
import { type GitRunner, isRepository, runGit } from './git.ts'
import { exists, listDir, listDirEntries, readText, sourceTreeEntries } from './io.ts'
import { listKnowledge } from './kbstore.ts'
import { type Store, loadVocab, storePaths } from './store.ts'
import { type JiraError } from './errors.ts'
import { type Result, ok } from './result.ts'

const relativeOf = (root: string, path: string): string => relative(root, path).replaceAll('\\', '/')

const listDirectories = async (path: string): Promise<string[]> => {
  const listed = await listDirEntries(path)
  if (!listed.ok) return []
  return listed.value.filter(entry => entry.isDirectory).map(entry => entry.name).sort()
}

const listFiles = async (path: string, suffix: string): Promise<string[]> => {
  const listed = await listDir(path)
  if (!listed.ok) return []
  return listed.value.filter(entry => entry.endsWith(suffix)).sort()
}

/** Everything the doctor looks at, in one pass. */
export const readSnapshot = async (
  root: string,
  run: GitRunner = runGit,
): Promise<Snapshot> => {
  const config = await readText(storePaths.config(root))

  const projects = await listDirectories(join(root, 'projects'))
  const issues: IssueFile[] = []
  const commentFiles: CommentFile[] = []
  for (const project of projects) {
    for (const name of await listFiles(join(root, 'projects', project, 'issues'), '.md')) {
      const path = join(root, 'projects', project, 'issues', name)
      const text = await readText(path)
      if (!text.ok) continue
      issues.push(Object.freeze({
        path: relativeOf(root, path),
        project,
        key: name.slice(0, -3),
        text: text.value,
      }))
    }
    for (const name of await listFiles(join(root, 'projects', project, 'comments'), '.md')) {
      const path = join(root, 'projects', project, 'comments', name)
      const text = await readText(path)
      if (!text.ok) continue
      commentFiles.push(Object.freeze({ path: relativeOf(root, path), key: name.slice(0, -3), text: text.value }))
    }
  }

  const counters: CountersEntry[] = []
  for (const name of await listFiles(join(root, 'counters'), '.json')) {
    const path = join(root, 'counters', name)
    const text = await readText(path)
    if (!text.ok) continue
    counters.push(Object.freeze({ machineId: name.slice(0, -5), path: relativeOf(root, path), raw: text.value }))
  }

  const locks: string[] = []
  for (const name of await listDirectories(join(root, '.jira', 'locks'))) locks.push(`.jira/locks/${name}`)
  if (await exists(storePaths.config(root).replace(/config\.md$/u, '.jira/lock'))) {
    locks.push('.jira/lock')
  }

  // The generated files and the hash their heads must carry (decision 39). Computing the hash
  // is a tree read, so it belongs here rather than in the pure checks.
  const generated: GeneratedFile[] = []
  for (const path of GENERATED_PATHS) {
    const text = await readText(join(root, ...path.split('/')))
    generated.push(Object.freeze({ path, ...(text.ok ? { text: text.value } : {}) }))
  }
  // If the tree cannot be read, the report says so instead of hashing a partial one (decision 169).
  const treeEntries = await sourceTreeEntries(root)
  const sourceTree = treeEntries.ok ? hashSourceTree(treeEntries.value) : undefined

  // Registered tags: every `tags/<name>.md` except the generated index (decision 138).
  const tagFiles = await listFiles(join(root, 'tags'), '.md')
  const tags = tagFiles.filter(name => name !== 'index.md').length

  return Object.freeze({
    root,
    ...(sourceTree === undefined ? {} : { sourceTree }),
    generated: Object.freeze(generated),
    tags,
    ...(config.ok ? { configText: config.value } : {}),
    issues: Object.freeze(issues),
    commentFiles: Object.freeze(commentFiles),
    counters: Object.freeze(counters),
    locks: Object.freeze(locks),
    git: await readGitState(root, run),
  })
}

const readGitState = async (root: string, run: GitRunner): Promise<GitState> => {
  if (!(await isRepository(root))) return Object.freeze({ repository: false })
  const status = await run(root, ['status', '--porcelain'])
  const branch = await run(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const ahead = await run(root, ['rev-list', '--count', '@{upstream}..HEAD'])
  const attributes = await exists(join(root, '.gitattributes'))
  return Object.freeze({
    repository: true,
    ...(status.code === 0 ? { clean: status.stdout === '' } : {}),
    ...(branch.code === 0 ? { branch: branch.stdout } : {}),
    ...(ahead.code === 0 ? { ahead: Number.parseInt(ahead.stdout, 10) || 0 } : {}),
    attributes,
  })
}

/** A file that did not decode, with the halves a caller needs to act on it (decision 80). */
export type BrokenFile = Readonly<{ path: string; reason: string }>

/** Every issue that decodes, for `list`/`board`. Files that do not decode are reported. */
export const listIssues = async (
  root: string,
  run: GitRunner = runGit,
): Promise<Readonly<{ issues: readonly Issue[]; broken: readonly BrokenFile[] }>> => {
  const snapshot = await readSnapshot(root, run)
  const issues: Issue[] = []
  const broken: { path: string; reason: string }[] = []
  for (const file of snapshot.issues) {
    const decoded = decodeIssue(file.text, file.key as never)
    if (decoded.ok) issues.push(decoded.value.issue)
    // Structured from birth (DPMJ-211): callers used to split a "<path>: <reason>" string back apart.
    else broken.push({ path: file.path, reason: decoded.error.message })
  }
  return Object.freeze({ issues: Object.freeze(issues), broken: Object.freeze(broken) })
}

/**
 * Every key the ledger knows — issues **and** knowledge entries, because `KB-1: kb create` is
 * exactly the commit a KB write makes (decision 187: this set used to be built inline by the
 * CLI's `verify-commit-msg`; the commit hook and any future surface must agree on "exists").
 * An unreadable library contributes nothing rather than failing the check.
 */
export const collectKnownKeys = async (store: Store): Promise<ReadonlySet<string>> => {
  const issues = await listIssues(store.files.root)
  const knowledge = await listKnowledge(store)
  return new Set([
    ...issues.issues.map(issue => String(issue.key)),
    ...(knowledge.ok ? knowledge.value.entries.map(entry => String(entry.key)) : []),
  ])
}
export type IssueQuery = Readonly<{
  project?: string
  status?: string
  /** One tag (the CLI's `--tag`). */
  tag?: string
  /** Every tag must be present — narrowing, which is what a filter is for. */
  tags?: readonly string[]
  /** An exact identity, e.g. `agent:…` / `human:…`. */
  assignee?: string
  link?: Readonly<{ type: LinkType; target: string }>
  /** Closed issues are hidden unless this is set (the board's default view). */
  includeClosed?: boolean
}>

/** One query used by both the CLI and the `/jira` command, so their views cannot drift. */
export const queryIssues = (
  issues: readonly Issue[],
  query: IssueQuery,
  vocab: Vocab | undefined,
): readonly Issue[] =>
  Object.freeze(issues.filter((issue) => {
    if (query.project !== undefined && issue.project !== query.project.toUpperCase()) return false
    if (query.status !== undefined && issue.status !== query.status) return false
    if (query.tag !== undefined && !issue.tags.includes(query.tag)) return false
    if (query.tags !== undefined && !query.tags.every(tag => issue.tags.includes(tag))) return false
    if (query.assignee !== undefined && issue.assignee !== query.assignee) return false
    if (
      query.link !== undefined
      && !issue.links.some(link => link.type === query.link?.type && link.target === query.link?.target)
    ) return false
    if (query.includeClosed !== true && vocab !== undefined && vocab.closed.includes(issue.status)) return false
    return true
  }))
/**
 * Decision 24: the issues that still **block** this one — i.e. its `is_blocked_by` targets that are
 * not in a closed status. It lives here rather than in the write path because answering it needs the
 * whole issue map, and the write transaction deliberately does not read one.
 * @param store - the ledger store whose issues are scanned.
 * @param key - the issue whose open blockers are wanted.
 * @returns the blocking keys in document order, or the vocabulary read failure.
 */
export const blockersOf = async (
  store: Store,
  key: IssueKey,
): Promise<Result<readonly string[], JiraError>> => {
  const vocab = await loadVocab(store)
  if (!vocab.ok) return vocab
  const listed = await listIssues(store.files.root)
  const byKey = new Map(listed.issues.map(issue => [String(issue.key), issue]))
  const target = byKey.get(String(key))
  if (target === undefined) return ok(Object.freeze([]))
  const blockers: string[] = []
  for (const link of target.links) {
    if (link.type !== 'is_blocked_by') continue
    const other = byKey.get(String(link.target))
    if (other !== undefined && !vocab.value.closed.includes(other.status) && !blockers.includes(String(other.key))) {
      blockers.push(String(other.key))
    }
  }
  return ok(Object.freeze(blockers))
}
