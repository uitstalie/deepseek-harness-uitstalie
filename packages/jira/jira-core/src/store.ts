/**
 * core/store — the read-modify-write transaction, and the **assembly point** of the store layer.
 *
 * This is the only place where "the rules" and "the disk" meet, and it exists so that no
 * caller has to remember the order: **take the issue lock, read, apply a pure mutation,
 * write atomically, append the comments, release** (decisions 58/60). A failed mutation
 * writes nothing at all — the file on disk is only touched once the whole change succeeded.
 *
 * What lives here (decision 185): the configuration (`createStore`), the read model
 * (`loadVocab`/`loadTags`/`readIssueText`/`readComments`), the transaction engine
 * (`transact`) and creation (`createInStore`). Two neighbours were split out and are
 * re-exported below so existing callers keep working:
 *   - `commit.ts` — how a finished write becomes a commit (`commitStoreWrite`,
 *     `adoptHumanChanges`), including the in-flight-write exclusion of decision 165;
 *   - `counters.ts` — key allocation (`allocateKey`, `readAllCounters`,
 *     `highestExistingKey`), the I/O half of the block-claim arithmetic.
 * The lock pipeline helpers themselves live in `lock.ts` (decision 181), and the path
 * *rules* in `entity.ts` (decision 182).
 */

import { join } from 'node:path'

import { type Comment, type Identity, type Issue, type IssueKey, type Timestamp, assertProjectKey, projectOf } from './entity.ts'
import { appendComments, parseComments, withAppendedComments } from './comments.ts'
import { ISSUE_SCHEMA, decodeIssue, encodeIssue } from './codec.ts'
import { adoptHumanChanges, commitWrite } from './commit.ts'
import { allocateKey } from './counters.ts'
import { type JiraError, invalidInput, ioFailed, notFound, staleRevision, withContext } from './errors.ts'
import { assertProjectNameFree } from './project.ts'
import { type FileStore, commentsPath, fileStore, issuePath, listDir, readText, writeTextAtomic } from './io.ts'
import { type LockEnvironment, issueLockPath, lockOptionsOf, lockOwnerOf, realLockEnvironment, withLock } from './lock.ts'
import { type Change, type ChangeContext, type PendingComment, createIssue, renewAssigneeLease, validateNewIssue } from './mutate.ts'
import { type Result, err, ok } from './result.ts'
import { type TagDef } from './tags.ts'
import { type Vocab, parseVocab } from './vocab.ts'
import { validateIdentity } from './validate.ts'

export type StoreConfig = Readonly<{
  root: string
  /** The writing machine: it names the lock owner and the comment-id prefix. */
  machineId: string
  host?: string
  lock?: Readonly<{ timeoutMs?: number; staleMs?: number }>
  env?: LockEnvironment
}>

export type Store = Readonly<{
  files: FileStore
  machineId: string
  host: string
  lock: Readonly<{ timeoutMs: number; staleMs: number }>
  env: LockEnvironment
}>

export const createStore = (config: StoreConfig): Store =>
  Object.freeze({
    files: fileStore(config.root),
    machineId: config.machineId,
    host: config.host ?? 'unknown',
    lock: Object.freeze({
      timeoutMs: config.lock?.timeoutMs ?? 10_000,
      staleMs: config.lock?.staleMs ?? 60_000,
    }),
    env: config.env ?? realLockEnvironment,
  })

/** Re-exported so `import { projectOf } from './store.ts'` keeps working (decision 174). */
export { projectOf }

/**
 * Re-exported from their real homes (decision 185): callers keep one stable entry point while
 * the implementations live with their own kind — commit orchestration in `commit.ts`, key
 * allocation in `counters.ts`.
 */
export { adoptHumanChanges, commitStoreWrite } from './commit.ts'
export { allocateKey, highestExistingKey, readAllCounters } from './counters.ts'

export const storePaths = {
  config: (root: string): string => join(root, 'config.md'),
  // Decision 182: the path *rules* live in `entity.ts`; these are the absolute forms, via `io.ts`.
  issue: (root: string, project: string, key: IssueKey): string => issuePath(fileStore(root), project, key),
  comments: (root: string, project: string, key: IssueKey): string => commentsPath(fileStore(root), project, key),
  tags: (root: string): string => join(root, 'tags'),
  counters: (root: string, machineId: string): string => join(root, 'counters', `${machineId}.json`),
} as const

export const loadVocab = async (store: Store): Promise<Result<Vocab, JiraError>> => {
  const text = await readText(storePaths.config(store.files.root))
  if (!text.ok) {
    return err(invalidInput('the store has no readable config.md vocabulary', {
      root: store.files.root,
      reason: text.error.kind,
    }))
  }
  return parseVocab(text.value)
}

/** A tag's one-line description, required by the vocabulary but tolerated when absent. */
const descriptionOf = (text: string): string | undefined => {
  const match = /^description:\s*(.+)$/mu.exec(text)
  const value = match?.[1]?.trim().replace(/^["']|["']$/gu, '')
  return value === undefined || value === '' ? undefined : value
}

/** Pull the `aliases: [a, b]` list out of a tag file without parsing the whole document. */
const aliasesOf = (text: string): readonly string[] => {
  const match = /^aliases:\s*\[(.*)\]$/m.exec(text)
  if (match === null) return Object.freeze([])
  return Object.freeze(
    (match[1] ?? '')
      .split(',')
      .map(entry => entry.trim().replace(/^["']|["']$/g, ''))
      .filter(entry => entry !== ''),
  )
}

/**
 * The tag registry: one file per tag, the file name being the tag (decision 26). A store
 * with no `tags/` directory is a store with no tags yet — not an error.
 */
export const loadTags = async (store: Store): Promise<Result<readonly TagDef[], JiraError>> => {
  const directory = storePaths.tags(store.files.root)
  const listed = await listDir(directory)
  if (!listed.ok) return ok(Object.freeze([]))
  const names = listed.value
  const tags: TagDef[] = []
  for (const name of names.slice().sort()) {
    if (!name.endsWith('.md')) continue
    // `tags/index.md` is a **generated** file (decision 87/120), not a registration: reading it
    // here would invent a tag called `index` whose description changes on every regeneration,
    // which in turn made the generated set look permanently stale.
    if (name === 'index.md') continue
    const text = await readText(join(directory, name))
    const aliases = text.ok ? aliasesOf(text.value) : Object.freeze([])
    const description = text.ok ? descriptionOf(text.value) : undefined
    tags.push(Object.freeze({
      name: name.slice(0, -3),
      ...(description === undefined ? {} : { description }),
      ...(aliases.length === 0 ? {} : { aliases }),
    }))
  }
  return ok(Object.freeze(tags))
}

export const readIssueText = async (store: Store, key: IssueKey): Promise<Result<string, JiraError>> => {
  const text = await readText(storePaths.issue(store.files.root, projectOf(key), key))
  if (!text.ok) return err(notFound(key))
  return text
}

/** No comment file yet is simply no comments; a malformed one is a loud error. */
export const readComments = async (store: Store, key: IssueKey): Promise<Result<readonly Comment[], JiraError>> => {
  const text = await readText(storePaths.comments(store.files.root, projectOf(key), key))
  if (!text.ok) return text.error.kind === 'missing' ? ok(Object.freeze([])) : err(notFound(key))
  const parsed = parseComments(text.value)
  if (!parsed.ok) return parsed
  return ok(parsed.value.comments)
}

export type Mutation = (issue: Issue, ctx: ChangeContext) => Result<Change, JiraError>

export type Transaction = Readonly<{
  change: Change
  /** The comments this transaction appended, ids included. */
  appended: readonly Comment[]
  /** False for a comment-only change (the issue file was not rewritten). */
  issueWritten: boolean
  /** Whether the write also became a commit (decision 2: git is the audit log). */
  committed: boolean
  /** Present when the data was written but the commit was not: never silent (decision 80). */
  commitError?: JiraError
}>

export type Actor = Readonly<{ by: Identity; at: Timestamp }>

const appendPendingComments = async (
  store: Store,
  key: IssueKey,
  pending: readonly PendingComment[],
): Promise<Result<readonly Comment[], JiraError>> => {
  if (pending.length === 0) return ok(Object.freeze([]))
  const path = storePaths.comments(store.files.root, projectOf(key), key)
  const existing = await readText(path)
  if (!existing.ok && existing.error.kind === 'unreadable') {
    return err(ioFailed('cannot read the comment file', { key, path: existing.error.path }))
  }
  const text = existing.ok ? existing.value : ''
  const appended = appendComments(text, pending, store.machineId)
  if (!appended.ok) return appended
  const written = await writeTextAtomic(path, withAppendedComments(text, appended.value))
  if (!written.ok) return written
  return ok(Object.freeze(appended.value.map(entry => entry.comment)))
}

/** Options a write transaction can be given; `expectedRevision` is decision 44's compare-and-swap. */
export type TransactOptions = Readonly<{
  /** Decision 44's compare-and-swap. */
  expectedRevision?: number
  /** Decision 24: the still-open issues blocking this one; the caller has the issue map. */
  blockers?: readonly string[]
  /** Decision 24: a human stepping over the block rule (recorded as a comment). */
  override?: boolean
}>

/**
 * Run one mutation against one issue, under that issue's lock.
 *
 * The vocabulary and the tag registry are read *inside* the lock, so the rules a mutation
 * applied are the rules that were on disk when the change was made.
 */
export const transact = async (
  store: Store,
  key: IssueKey,
  actor: Actor,
  mutate: Mutation,
  /** The action's own name, so the audit subject says what really happened (decision 67). */
  what: string = 'update',
  options: TransactOptions = {},
): Promise<Result<Transaction, JiraError>> => {
  const path = issueLockPath(store.files.root, key)

  return withLock(path, lockOwnerOf(store, actor.at), lockOptionsOf(store), async () => {
    // §4.13 rule 1 — a red line, and load-bearing for decision 79's freshness assertion: the
    // generated heads hash the **working tree** (deliberately: a board that ignored an uncommitted
    // edit would describe a store nobody has), so a commit carrying generated files but not the edit
    // they were computed from would assert a `source_tree` its own commit does not contain, and the
    // store's `generate --check` would reject it on the next push. Adopting first — before anything
    // is written — is what keeps the two in step.
    const adopted = await adoptHumanChanges(store, actor.at, path)
    if (!adopted.ok) return adopted

    const vocab = await loadVocab(store)
    if (!vocab.ok) return vocab
    const tags = await loadTags(store)
    if (!tags.ok) return tags

    // The acting identity is part of every audit trail; a name containing the separator would make
    // the tuple ambiguous, so it is refused here rather than discovered later (decisions 48/69).
    const identity = validateIdentity(String(actor.by), 'the acting identity')
    if (!identity.ok) return identity

    const text = await readIssueText(store, key)
    if (!text.ok) return text
    const decoded = decodeIssue(text.value, key)
    if (!decoded.ok) return decoded

    // Decisions 49/46, the write half: reading tolerates a key we do not know or a version we do not
    // write, but re-encoding the file would **drop** the key or downgrade the version silently. So the
    // write is refused and the reader is told what to do about it.
    if (decoded.value.unknownKeys.length > 0) {
      return err(invalidInput(
        `refusing to write ${String(key)}: unknown frontmatter key(s) ${decoded.value.unknownKeys.map(name => `"${name}"`).join(', ')} would be dropped by this version`,
        { key: String(key), unknownKeys: decoded.value.unknownKeys },
      ))
    }
    if (decoded.value.schema !== ISSUE_SCHEMA) {
      return err(invalidInput(
        `refusing to write ${String(key)}: the file is ${decoded.value.schema}, and this version writes ${ISSUE_SCHEMA}`,
        { key: String(key), schema: decoded.value.schema, expected: ISSUE_SCHEMA },
      ))
    }

    // Compare-and-swap inside the lock: a caller that read revision N must not overwrite revision
    // N+1 (decision 44/52 — the typed error carries the value actually found).
    if (options.expectedRevision !== undefined && decoded.value.issue.revision !== options.expectedRevision) {
      return err(staleRevision(options.expectedRevision, decoded.value.issue.revision))
    }

    const ctx: ChangeContext = Object.freeze({
      vocab: vocab.value,
      knownTags: tags.value,
      at: actor.at,
      by: actor.by,
      ...(options.blockers === undefined ? {} : { blockers: options.blockers }),
      ...(options.override === undefined ? {} : { override: options.override }),
    })
    const change = mutate(decoded.value.issue, ctx)
    if (!change.ok) return change

    const issueChanged = change.value.issue !== decoded.value.issue
    // Decision 61: a write that changes the issue also renews the claim's lease. It rides along
    // with the write that is happening anyway (zero extra write amplification) and does not bump
    // the revision — a lease is metadata, not body (decision 44).
    const finalIssue = issueChanged ? renewAssigneeLease(change.value.issue, actor.at) : change.value.issue
    if (issueChanged) {
      const encoded = encodeIssue(finalIssue)
      if (!encoded.ok) return encoded
      const written = await writeTextAtomic(
        storePaths.issue(store.files.root, projectOf(key), key),
        encoded.value,
      )
      if (!written.ok) return written
    }

    const appended = await appendPendingComments(store, key, change.value.comments)
    if (!appended.ok) return appended

    const commit = await commitWrite(store, key, actor.at, {
      what: issueChanged ? what : 'comment',
      revision: finalIssue.revision,
    })
    if (!commit.ok) return commit
    return ok(Object.freeze({
      change: Object.freeze({ ...change.value, issue: finalIssue }),
      appended: appended.value,
      issueWritten: issueChanged,
      committed: commit.value.committed,
      ...(commit.value.error === undefined ? {} : { commitError: commit.value.error }),
    }))
  })
}

/* ── creation (decisions 6, 58, 74, 114) ─────────────────────────────────────────────── */

export type Created = Readonly<{ key: IssueKey; change: Change; committed: boolean; commitError?: JiraError }>

/**
 * Create one issue: allocate a key, then write under that key's own lock. Creation is the
 * only transaction whose file must **not** exist yet, so it cannot go through `transact`.
 *
 * Decision 190: validation runs **before** allocation — a refused input must not burn a number.
 * (The reads feeding validation need no lock; allocation still takes the store lock on its own,
 * and the write still takes the issue lock — the order from decision 58 is unchanged.)
 */
export const createInStore = async (
  store: Store,
  project: string,
  actor: Actor,
  input: Omit<Parameters<typeof createIssue>[0], 'key'>,
): Promise<Result<Created, JiraError>> => {
  // Before anything builds a path or a counter entry out of it (decision 162).
  const validated = assertProjectKey(project)
  if (!validated.ok) return validated
  const vocab = await loadVocab(store)
  if (!vocab.ok) return vocab
  const tags = await loadTags(store)
  if (!tags.ok) return tags

  const ctx: ChangeContext = Object.freeze({
    vocab: vocab.value,
    knownTags: tags.value,
    at: actor.at,
    by: actor.by,
  })
  // Decision 190: everything that can refuse the input runs here, before a number exists.
  const checked = validateNewIssue(input, ctx)
  if (!checked.ok) return err(withContext(checked.error, { keyAllocated: false }))

  // Decision 194: `create --project KB` used to register the project implicitly by creating its
  // directory. Checked before the number is spent, like every other pre-allocation refusal (190).
  const free = await assertProjectNameFree(store, project)
  if (!free.ok) return free
  const key = await allocateKey(store, project, actor.at)
  if (!key.ok) return key

  const path = issueLockPath(store.files.root, key.value)
  return withLock(path, lockOwnerOf(store, actor.at), lockOptionsOf(store), async () => {
    const existing = await readText(storePaths.issue(store.files.root, project, key.value))
    if (existing.ok) return err(invalidInput(`${key.value} already exists`, { key: key.value }))

    const change = createIssue({ ...input, key: key.value }, ctx)
    if (!change.ok) return change
    const encoded = encodeIssue(change.value.issue)
    if (!encoded.ok) return encoded
    const written = await writeTextAtomic(storePaths.issue(store.files.root, project, key.value), encoded.value)
    if (!written.ok) return written
    const appended = await appendPendingComments(store, key.value, change.value.comments)
    if (!appended.ok) return appended
    const committed = await commitWrite(store, key.value, actor.at, { what: 'create', revision: 1 })
    if (!committed.ok) return committed
    return ok(Object.freeze({
      key: key.value,
      change: change.value,
      committed: committed.value.committed,
      ...(committed.value.error === undefined ? {} : { commitError: committed.value.error }),
    }))
  })
}
