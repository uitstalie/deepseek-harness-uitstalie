/**
 * core/injection — the one line a session is told about the store (decisions 78, §6.4).
 *
 * The design is emphatic about what this is **not**: it is not an agenda. A session is usually
 * opened for a reason, so a list of open issues is noise; what an agent needs is the **awareness**
 * that a ledger exists, how big it is, and whether it may write — it will look things up itself when
 * the conversation calls for it.
 *
 * Three details are load-bearing:
 *
 *   - it is a `PromptContext`, **not** a prompt section. The counts change, and a dynamic section
 *     would invalidate the KV cache every time they do (the reason is recorded in §6.4 and comes
 *     from the host's own documentation);
 *   - a scan costs about 1.5 ms, so the text is **reused for five seconds** rather than measured on
 *     every model step;
 *   - **an empty store injects nothing at all** — a session with no ledger pays nothing for this.
 *
 * Counting rules are §6.4's, verbatim: `projects/* /project.md` files, `knowledge/ * /KB-*.md`
 * files, and issues whose status is not in the vocabulary's `closed` set. The read-only count is
 * §4.11's rule: a project with **no remote** is anchored to this machine and refuses writes, so the
 * agent is told before it tries (and is told where to look when it does).
 */

import { join } from 'node:path'

import { type Issue } from './entity.ts'
import { type JiraError } from './errors.ts'
import { listDir, listDirEntries, readText } from './io.ts'
import { type Result, ok } from './result.ts'
import { listIssues } from './inspect.ts'
import { readProjectFile } from './project.ts'
import { type Store, loadVocab } from './store.ts'

export const STORE_CONTEXT_NAME = 'jira:store'
/** §6.4: five seconds, because a scan is cheap but not free and the counts move slowly. */
export const INJECTION_TTL_MS = 5_000
/** Before the tool listings; it is orientation, not instruction. */
export const INJECTION_ORDER = 40

export type StoreCounts = Readonly<{
  /** `projects/<KEY>/project.md` files. */
  projects: number
  /** `knowledge/<domain>/KB-*.md` files. */
  knowledge: number
  /** Issues whose status is not in the vocabulary's `closed` set. */
  openIssues: number
  /** Projects with no remote: §4.11 makes them read-only for every machine. */
  readOnlyProjects: number
}>

const countFiles = async (directory: string, matches: (name: string) => boolean): Promise<number> => {
  const listed = await listDirEntries(directory)
  if (!listed.ok) return 0
  return listed.value.filter(entry => entry.isFile && matches(entry.name)).length
}

export const countStore = async (store: Store): Promise<Result<StoreCounts, JiraError>> => {
  const projectsDirectory = join(store.files.root, 'projects')
  const projectDirs = await listDirEntries(projectsDirectory)
  const projectKeys = projectDirs.ok
    ? projectDirs.value.filter(entry => entry.isDirectory).map(entry => entry.name)
    : []

  let projects = 0
  let readOnlyProjects = 0
  for (const key of projectKeys) {
    const text = await readText(join(projectsDirectory, key, 'project.md'))
    // A project is a directory that has an identity file **or** at least one issue. Counting only
    // `project.md` was the literal reading of §6.4 and it reported "0 projects" for a store whose
    // issues were created without ever binding a checkout — a line that contradicts what the reader
    // can see is worse than no line (decision 130 ①).
    const issuesListed = await listDir(join(projectsDirectory, key, 'issues'))
    const hasIssues = (issuesListed.ok ? issuesListed.value : [])
      .some(name => name.endsWith('.md'))
    if (!text.ok && !hasIssues) continue
    projects += 1
    const decoded = text.ok ? readProjectFile(text.value, key) : undefined
    // §4.11: no remote means the project is anchored to a machine and refuses writes. A project
    // with no identity file at all is judged the same way, because it has no remote either.
    if (decoded === undefined || !decoded.ok || decoded.value.remotes.length === 0) readOnlyProjects += 1
  }

  const knowledgeRoot = join(store.files.root, 'knowledge')
  let knowledge = 0
  const domainDirs = await listDirEntries(knowledgeRoot)
  if (domainDirs.ok) {
    for (const domain of domainDirs.value.filter(entry => entry.isDirectory)) {
      knowledge += await countFiles(join(knowledgeRoot, domain.name), name => /^KB-.*\.md$/u.test(name))
    }
  }

  const vocab = await loadVocab(store)
  const closed = new Set(vocab.ok ? vocab.value.closed : ['closed'])
  const listed = await listIssues(store.files.root)
  const openIssues = listed.issues.filter((issue: Issue) => !closed.has(issue.status)).length

  return ok(Object.freeze({ projects, knowledge, openIssues, readOnlyProjects }))
}

/**
 * The line itself. English and stable so a test can assert it (decisions 55/78/131).
 *
 * It answers three questions, in the order a reader asks them: **which ledger** is this, **what is
 * this workspace to it**, and how big is it. A store with nothing in it still says nothing at all.
 */
export const injectionLine = (
  counts: StoreCounts,
  context: Readonly<{ storeLabel?: string; binding?: string }> = {},
): string => {
  if (counts.projects === 0 && counts.knowledge === 0 && counts.openIssues === 0) return ''
  const label = context.storeLabel === undefined || context.storeLabel === '' ? '' : `${context.storeLabel} · `
  const binding = context.binding === undefined || context.binding === '' ? '' : `${context.binding} · `
  const base = `[store] ${label}${binding}${String(counts.projects)} projects · ${String(counts.knowledge)} knowledge · ${String(counts.openIssues)} open issues`
  return counts.readOnlyProjects > 0 ? `${base} | read-only: ${String(counts.readOnlyProjects)}` : base
}

export type InjectionRead = Readonly<{
  counts: StoreCounts
  /** How to name this ledger in one word (the store directory's name). */
  storeLabel?: string
  /** The workspace→project phrase, when the caller could resolve one (§4.10). */
  binding?: string
}>

export type StoreInjection = Readonly<{
  name: string
  order: number
  /** What the host asks for on every assembly. The scope is the agent, which carries the session's cwd. */
  text: (context?: { scope?: unknown }) => string
  /** Refresh the cache for one checkout; skipped when that checkout was scanned inside the TTL. */
  refresh: (cwd?: string) => Promise<void>
  /** Test seam: the number of scans actually performed. */
  scans: () => number
}>

/**
 * Cache the line per checkout. The host's provider is synchronous, so a stale entry is refreshed in
 * the background and the current step sees the previous text — one step of lag, five seconds of
 * reuse, and no IO in the model loop. The cache is keyed by `cwd` because two sessions in two
 * checkouts must be told two different things.
 */
export const createStoreInjection = (options: Readonly<{
  read: (cwd: string | undefined) => Promise<InjectionRead>
  /** The session's checkout, read duck-typed from the assembly scope (which is the agent). */
  cwdOf?: (scope: unknown) => string | undefined
  now: () => number
  ttlMs?: number
  order?: number
}>): StoreInjection => {
  const ttl = options.ttlMs ?? INJECTION_TTL_MS
  const entries = new Map<string, { text: string; at: number }>()
  const inFlight = new Map<string, Promise<void>>()
  let scans = 0

  const refresh = async (cwd?: string): Promise<void> => {
    const key = cwd ?? ''
    const running = inFlight.get(key)
    if (running !== undefined) return running
    const cached = entries.get(key)
    if (cached !== undefined && options.now() - cached.at < ttl) return

    const started = (async () => {
      try {
        const read = await options.read(cwd)
        scans += 1
        entries.set(key, {
          text: injectionLine(read.counts, {
            ...(read.storeLabel === undefined ? {} : { storeLabel: read.storeLabel }),
            ...(read.binding === undefined ? {} : { binding: read.binding }),
          }),
          at: options.now(),
        })
      } catch {
        // A store that cannot be read injects nothing rather than a wrong number.
        entries.set(key, { text: '', at: options.now() })
      } finally {
        inFlight.delete(key)
      }
    })()
    inFlight.set(key, started)
    return started
  }

  return Object.freeze({
    name: STORE_CONTEXT_NAME,
    order: options.order ?? INJECTION_ORDER,
    text: (context?: { scope?: unknown }) => {
      const cwd = options.cwdOf?.(context?.scope)
      const key = cwd ?? ''
      const cached = entries.get(key)
      // Fire-and-forget: the host asked synchronously, so the next assembly gets any new text.
      if (cached === undefined || options.now() - cached.at >= ttl) void refresh(cwd)
      return cached?.text ?? ''
    },
    refresh,
    scans: () => scans,
  })
}
