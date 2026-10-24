/**
 * core/generateStore — the effects around `core/generate` (decisions 39 / 79 / 87).
 *
 * `core/generate` renders text from data; this module reads the store into that data, decides
 * whether the files on disk are already correct, and writes them. It is the layer the CLI, the
 * plugin and the freshness check in `jira doctor` all call, so the three cannot disagree.
 *
 * **Idempotence is the contract** (and the reason `generated_at` is preserved): regenerating
 * unchanged inputs must leave the files **byte-identical**, otherwise CI's "re-run and assert an
 * empty diff" would fail on every run and the freshness check would be worthless. So the
 * timestamp moves only when the content does.
 *
 * `log.md` lists commits, not files, so its head cannot prove its own freshness (see
 * `isGeneratedInput` in `core/io`). For it — and for everything else — the honest test is
 * "recompute with the timestamp already on disk and compare", which is exactly what
 * {@link checkGenerated} does.
 */

import { join } from 'node:path'

import {
  type CommitRow,
  type DomainRow,
  type GeneratedMeta,
  type GenerateInput,
  type ProjectRow,
  type BundleGenerated,
  generateAll,
  hashSourceTree,
  readGeneratedHead,
  tagRows,
} from './generate.ts'
import { type Tag, type Timestamp } from './entity.ts'
import { type JiraError, ioFailed } from './errors.ts'
import { type GitRunner, noIssueSubject, runGit } from './git.ts'
import { listDirEntries, readText, sourceTreeEntries, writeTextAtomic } from './io.ts'
import { listIssues } from './inspect.ts'
import { type Result, err, ok } from './result.ts'
import { type Store, adoptHumanChanges, commitStoreWrite, loadTags, loadVocab } from './store.ts'
import { isClosedStatus } from './vocab.ts'
import { type KnowledgeListing, listKnowledge } from './kbstore.ts'

/** How many commits `log.md` lists; enough to see the recent shape, not a full history. */
export const LOG_COMMIT_LIMIT = 100

/** A commit is "keyed" when its subject starts with an issue key (decision 67's convention). */
const KEYED_SUBJECT = /^[A-Z][A-Z0-9]{1,5}-\d+\b/u

const pathIn = (store: Store, ...parts: readonly string[]): string => join(store.files.root, ...parts)

/** `projects/<P>/project.md`'s `name:` when it has one; otherwise the project key. */
const projectNameOf = async (store: Store, project: string): Promise<string> => {
  const text = await readText(pathIn(store, 'projects', project, 'project.md'))
  if (!text.ok) return project
  const name = /^name:\s*(.+)$/mu.exec(text.value)?.[1]?.trim()
  return name === undefined || name === '' ? project : name.replace(/^["']|["']$/gu, '')
}

async function projectRows(store: Store): Promise<readonly ProjectRow[]> {
  const projectDirs = await listDirEntries(pathIn(store, 'projects'))
  if (!projectDirs.ok) return Object.freeze([])
  const names = projectDirs.value.filter(entry => entry.isDirectory).map(entry => entry.name).sort()
  const listed = await listIssues(store.files.root)
  const vocab = await loadVocab(store)
  const rows: ProjectRow[] = []
  for (const project of names) {
    const open = listed.issues.filter(issue =>
      issue.project === project && !(vocab.ok && isClosedStatus(vocab.value, issue.status))).length
    rows.push(Object.freeze({ key: project, name: await projectNameOf(store, project), open }))
  }
  return Object.freeze(rows)
}

/**
 * `knowledge/<domain>/…` — one row per domain, counting the Markdown **entries** inside.
 *
 * Derived from the listing the bundles are built from, on purpose. An earlier version walked the
 * domain directories itself and counted every `.md` file, so the generated `index.md`/`log.md`
 * were counted as knowledge: the root index said 3 entries for a domain holding 1, and because
 * that number only appeared *after* the first generation, no single `jira generate` was a fixed
 * point (found 2026-10-16). One scan, one answer.
 */
const domainRows = (listing: KnowledgeListing): readonly DomainRow[] =>
  Object.freeze(listing.domains.map(name => Object.freeze({
    name,
    entries: listing.entries.filter(entry => entry.domain === name).length,
  })))

/** What to fall back to when the knowledge library cannot be listed at all. */
const NO_LISTING: KnowledgeListing = Object.freeze({
  entries: Object.freeze([]),
  domains: Object.freeze([]),
  broken: Object.freeze([]),
})

/** The commits `log.md` shows: keyed subjects only, newest first. */
export const readCommitRows = async (
  root: string,
  run: GitRunner = runGit,
  limit: number = LOG_COMMIT_LIMIT,
): Promise<readonly CommitRow[]> => {
  // `%x1f` (unit separator) cannot appear in a subject, so a subject with a date-like prefix
  // still parses into exactly three fields.
  // Filter **before** limiting (decision 168): `-n` counts commits, so an unkeyed commit used to take a
  // slot in the window and push the oldest keyed line out. The settle commit is unkeyed — but it touches
  // `projects/<p>/log.md`, so it appears in the log *and* shifted the window, which made the freshly
  // written `log.md` stale the moment it was committed (the store's own CI caught it).
  const log = await run(root, [
    'log',
    '--pretty=format:%h%x1f%ad%x1f%s',
    '--date=short',
    '--extended-regexp',
    '--grep=^[A-Z][A-Z0-9]{1,5}-[0-9]',
    '-n', String(limit),
  ])
  if (log.code !== 0) return Object.freeze([])
  const rows: CommitRow[] = []
  for (const line of log.stdout.split('\n')) {
    const [hash, date, subject] = line.split('\u001f')
    if (hash === undefined || date === undefined || subject === undefined) continue
    if (!KEYED_SUBJECT.test(subject)) continue
    rows.push(Object.freeze({ hash, date, subject }))
  }
  return Object.freeze(rows)
}

/** Everything `generateAll` needs except the head, which depends on the write it is part of. */
export type GenerateSources = Omit<GenerateInput, 'meta'>

export const readGenerateSources = async (store: Store): Promise<Result<GenerateSources, JiraError>> => {
  const vocab = await loadVocab(store)
  if (!vocab.ok) return vocab
  const listed = await listIssues(store.files.root)
  const tags = await loadTags(store)
  if (!tags.ok) return tags

  const entities: Tag[] = tags.value.map(tag => Object.freeze({
    name: tag.name,
    description: tag.description ?? '',
    aliases: tag.aliases ?? Object.freeze([]),
  }))
  const projectList = await projectRows(store)
  const commitList = await readCommitRows(store.files.root)
  // Listed once: the domain counts and the bundle members both come out of this scan.
  const knowledge = await listKnowledge(store)
  const listing = knowledge.ok ? knowledge.value : NO_LISTING
  const domainList = domainRows(listing)
  const entries = listing.entries

  // Decision 79's second half: every project and every knowledge domain also gets an `index.md` and
  // a `log.md`. Members come from the issue/entry lists; the log is the keyed commits whose subject
  // mentions one of those members' keys — the same rule the root log uses.
  const bundles: BundleGenerated[] = []
  for (const project of projectList) {
    const mine = listed.issues.filter(issue => issue.project === project.key)
    const keys = mine.map(issue => String(issue.key))
    bundles.push(Object.freeze({
      directory: `projects/${project.key}`,
      title: `${project.key} — ${project.name}`,
      members: Object.freeze(mine.map(issue => `\`${String(issue.key)}\` ${issue.status} — ${issue.summary}`)),
      commits: Object.freeze(commitList.filter(commit => keys.some(key => commit.subject.includes(key)))),
    }))
  }
  for (const domain of domainList) {
    const mine = entries.filter(entry => entry.domain === domain.name)
    const keys = mine.map(entry => String(entry.key))
    bundles.push(Object.freeze({
      directory: `knowledge/${domain.name}`,
      title: `knowledge/${domain.name}`,
      members: Object.freeze(mine.map(entry => `\`${String(entry.key)}\` ${entry.title}`)),
      commits: Object.freeze(commitList.filter(commit => keys.some(key => commit.subject.includes(key)))),
    }))
  }

  return ok(Object.freeze({
    vocab: vocab.value,
    issues: listed.issues,
    projects: projectList,
    domains: domainList,
    tags: tagRows(entities, listed.issues),
    commits: commitList,
    bundles: Object.freeze(bundles),
  }))
}

/** The hash of the inputs as they are right now — what every generated head must carry. */
export const currentSourceTree = async (store: Store): Promise<Result<string, JiraError>> => {
  const entries = await sourceTreeEntries(store.files.root)
  return entries.ok ? ok(hashSourceTree(entries.value)) : entries
}

const metaFor = (sourceTree: string, generatedAt: string): GeneratedMeta =>
  Object.freeze({ generatedAt, sourceTree })

/** Render everything with a given head. The head is the only thing the caller varies. */
const renderWith = (sources: GenerateSources, meta: GeneratedMeta): Readonly<Record<string, string>> =>
  generateAll({ ...sources, meta })

export type GeneratedPlanEntry = Readonly<{
  path: string
  text: string
  /** What is on disk now, when there is something. */
  existing?: string
  action: 'write' | 'unchanged'
}>

export type GeneratedPlan = Readonly<{
  entries: readonly GeneratedPlanEntry[]
  sourceTree: string
  /** True when at least one file would change — what `generate --check` exits non-zero on. */
  stale: boolean
}>

/**
 * Decide what would happen without writing anything.
 *
 * The comparison re-renders with **the timestamp already on disk**, so a file whose content is
 * current compares equal no matter how long ago it was generated: only a real input change makes
 * `stale` true.
 */
export const planGenerated = async (
  store: Store,
  generatedAt: string,
): Promise<Result<GeneratedPlan, JiraError>> => {
  const sources = await readGenerateSources(store)
  if (!sources.ok) return sources
  // A tree that cannot be read completely is an error, not a hash of what happened to be readable
  // (decision 169) — a partial hash would mark stale files fresh.
  const treeEntries = await sourceTreeEntries(store.files.root)
  if (!treeEntries.ok) return treeEntries
  const sourceTree = hashSourceTree(treeEntries.value)

  // Decision 79: the generated set is **dynamic** now (each project and knowledge domain has its own
  // index and log), so the paths come from a render rather than from a fixed list.
  const paths = Object.keys(renderWith(sources.value, metaFor(sourceTree, generatedAt))).sort()
  const entries: GeneratedPlanEntry[] = []
  let stale = false
  for (const path of paths) {
    const existing = await readText(pathIn(store, ...path.split('/')))
    const current = existing.ok ? existing.value : undefined
    const head = current === undefined ? undefined : readGeneratedHead(current)
    // A path that came out of the render always has text; the fallbacks are for the type system.
    const text = renderWith(sources.value, metaFor(sourceTree, head?.generatedAt ?? generatedAt))[path] ?? current ?? ''
    const action = current === text ? 'unchanged' : 'write'
    if (action === 'write') stale = true
    entries.push(Object.freeze({
      path,
      // A real change gets the fresh timestamp; an unchanged file keeps its own, which is what
      // makes regeneration byte-identical when nothing changed.
      text: action === 'write' ? renderWith(sources.value, metaFor(sourceTree, generatedAt))[path] ?? '' : text,
      ...(current === undefined ? {} : { existing: current }),
      action,
    }))
  }
  return ok(Object.freeze({ entries: Object.freeze(entries), sourceTree, stale }))
}

export type WriteReport = Readonly<{ written: readonly string[]; unchanged: readonly string[] }>

export const writeGenerated = async (store: Store, plan: GeneratedPlan): Promise<Result<WriteReport, JiraError>> => {
  const written: string[] = []
  const unchanged: string[] = []
  for (const entry of plan.entries) {
    if (entry.action === 'unchanged') {
      unchanged.push(entry.path)
      continue
    }
    const result = await writeTextAtomic(pathIn(store, ...entry.path.split('/')), entry.text)
    if (!result.ok) return result
    written.push(entry.path)
  }
  return ok(Object.freeze({ written: Object.freeze(written), unchanged: Object.freeze(unchanged) }))
}

/**
 * Regenerate the derived files **and commit them**, in one step.
 *
 * The store's CI only *checks* freshness — nothing outside this process generates (decision 15/34,
 * corrected 2026-10-17: an out-of-process timer is a failed change). So the process that writes the
 * ledger is also the one that refreshes its derived files, and it has to happen **before the session
 * flush pushes**: a pushed store whose board disagrees with its sources is exactly what turns the
 * freshness gate red.
 *
 * Only the paths that actually moved are committed, so a session that changed nothing produces no
 * commit at all — the plan re-renders with the timestamps already on disk, which is what makes a
 * fresh store byte-identical rather than merely equivalent.
 */
export const regenerateAndCommit = async (
  store: Store,
  at: Timestamp,
  subject: string = noIssueSubject('chore: 重生成派生工件'),
): Promise<Result<readonly string[], JiraError>> => {
  // §4.13 rule 1 first: the heads hash the working tree, so regenerating over an uncommitted edit
  // would write a `source_tree` that the commit it lands in does not contain — and the store's own
  // `generate --check` would reject it on the next push (found by experiment, 2026-10-17).
  const adopted = await adoptHumanChanges(store, at)
  if (!adopted.ok) return adopted

  const plan = await planGenerated(store, at)
  if (!plan.ok) return plan
  const written = await writeGenerated(store, plan.value)
  if (!written.ok) return written
  if (written.value.written.length === 0) return ok(Object.freeze([]))

  // Decision 165: `plan`→`write` above happens outside the store lock, so a concurrent write can move
  // the inputs in between — and then the heads would carry a `source_tree` the commit does not contain,
  // which is precisely the §4.13 red line (the store's own `generate --check` would go red on the next
  // push). Re-check the hash **inside** the lock and re-render if it moved.
  const committed = await commitStoreWrite(store, at, written.value.written, subject, async () => {
    const now = await currentSourceTree(store)
    if (!now.ok) return now
    if (now.value === plan.value.sourceTree) return ok(Object.freeze([]))
    const again = await planGenerated(store, at)
    if (!again.ok) return again
    const refreshed = await writeGenerated(store, again.value)
    if (!refreshed.ok) return refreshed
    return ok(Object.freeze([...refreshed.value.written]))
  })
  if (!committed.ok) return committed
  // Decision 148: the commit is not optional here. `commitStoreWrite` reports "could not commit"
  // as a **soft** failure — the file is the truth source, right for an ordinary write. For
  // regeneration it is not: what gets pushed has to agree with its sources, so a store whose
  // commit did not land must say so instead of returning a cheerful list of files.
  if (committed.ok && !committed.value.committed) {
    return err(committed.value.error ?? ioFailed('the regenerated files were written but not committed', { root: store.files.root }))
  }
  return ok(Object.freeze([...written.value.written]))
}

export type StaleFile = Readonly<{ path: string; reason: 'missing' | 'stale' }>

/** The freshness assertion: the same comparison as the plan, without writing (decision 39). */
export const checkGenerated = async (store: Store): Promise<Result<readonly StaleFile[], JiraError>> => {
  const plan = await planGenerated(store, new Date(0).toISOString().replace(/\.\d{3}Z$/u, 'Z'))
  if (!plan.ok) return plan
  const stale: StaleFile[] = plan.value.entries
    .filter(entry => entry.action === 'write')
    .map(entry => Object.freeze({
      path: entry.path,
      reason: entry.existing === undefined ? 'missing' as const : 'stale' as const,
    }))
  return ok(Object.freeze(stale))
}
