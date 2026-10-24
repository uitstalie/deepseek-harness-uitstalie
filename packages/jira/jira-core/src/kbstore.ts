/**
 * core/kbstore — the read/write path for knowledge entries (decision 75's storage half).
 *
 * Same shape as the issue path (decisions 58/60): take the key's lock, read, build a new value,
 * write atomically, commit — and a failed validation writes nothing.
 *
 * Two details are worth stating because they surprised the tests:
 *   - the **key is not in the path by construction**: the file is `knowledge/<domain>/<KEY>.md`, so
 *     reading by key means scanning the domains (the library is small by design, decision 85);
 *   - `knowledge/<domain>/index.md` is a **generated** file (decision 87), so it is never read as an
 *     entry — the same trap `tags/index.md` sprang once already (decision 120 ⑤).
 */

import { join } from 'node:path'

import { type Identity, type IssueKey, type Timestamp } from './entity.ts'
import {
  KB_SCHEMA,
  asKnowledgeKey,
  decodeKnowledge,
  encodeKnowledge,
  isDomainName,
  knowledgePath,
  machineIdOf,
  KNOWLEDGE_KEY_SPACE,
  validateKnowledgeDraft,
  type KnowledgeEntry,
  type KnowledgeKey,
} from './kb.ts'
import { type KbSearch, searchKnowledge } from './kbsearch.ts'
import { type JiraError, invalidInput, notFound, withContext } from './errors.ts'
import { applyUpdate } from './mutate.ts'
import { listDir, listDirEntries, readText, writeTextAtomic } from './io.ts'
import { commitSubject } from './git.ts'
import { issueLockPath, lockOptionsOf, lockOwnerOf, withLock } from './lock.ts'
import { type Result, err, ok } from './result.ts'
import { type Actor, type Store, allocateKey, commitStoreWrite, loadVocab, projectOf, readIssueText, transact } from './store.ts'
import { decodeIssue } from './codec.ts'
import { system } from './system/index.ts'

/** The generated file inside a domain directory; never an entry (decision 87/120). */
const GENERATED_IN_DOMAIN = Object.freeze(['index.md', 'log.md'])

export type KnowledgeListing = Readonly<{
  entries: readonly KnowledgeEntry[]
  /**
   * Every **valid** domain directory, sorted, including ones that hold no entry yet.
   *
   * Published so the root `index.md` can count a domain's entries from the very same scan that
   * reads them, instead of walking the directory a second time — the second walk counted the
   * generated `index.md`/`log.md` as knowledge and reported 3 entries for a domain that has 1
   * (found 2026-10-16; the same trap `tags/index.md` sprang in decision 120 ⑤).
   */
  domains: readonly string[]
  /** Files that could not be read as entries, with the reason — surfaced, never silent. */
  broken: readonly Readonly<{ path: string; reason: string }>[]
}>

const listingOf = async (store: Store): Promise<Result<KnowledgeListing, JiraError>> => {
  const root = join(store.files.root, 'knowledge')
  const listedRoot = await listDirEntries(root)
  if (!listedRoot.ok) {
    return ok(Object.freeze({ entries: Object.freeze([]), domains: Object.freeze([]), broken: Object.freeze([]) }))
  }
  const found = listedRoot.value
    .filter(entry => entry.isDirectory)
    .map(entry => entry.name)
    .sort()

  const entries: KnowledgeEntry[] = []
  const domains: string[] = []
  const broken: { path: string; reason: string }[] = []
  for (const domain of found) {
    if (!isDomainName(domain)) {
      broken.push({ path: `knowledge/${domain}`, reason: `domain directory "${domain}" is not lower-kebab` })
      continue
    }
    domains.push(domain)
    const listed = await listDir(join(root, domain))
    if (!listed.ok) continue
    const names = listed.value.filter(name => name.endsWith('.md')).sort()
    for (const name of names) {
      if (GENERATED_IN_DOMAIN.includes(name)) continue
      const path = knowledgePath(domain, name.slice(0, -3) as KnowledgeKey)
      const text = await readText(join(store.files.root, ...path.split('/')))
      if (!text.ok) continue
      const decoded = decodeKnowledge(text.value, name.slice(0, -3), domain)
      if (!decoded.ok) {
        broken.push({ path, reason: decoded.error.message })
        continue
      }
      entries.push(decoded.value.entry)
    }
  }
  return ok(Object.freeze({
    entries: Object.freeze(entries),
    domains: Object.freeze(domains),
    broken: Object.freeze(broken),
  }))
}

export const listKnowledge = async (store: Store): Promise<Result<KnowledgeListing, JiraError>> => listingOf(store)

export type FoundKnowledge = Readonly<{ entry: KnowledgeEntry; path: string; warnings: readonly string[] }>

/** Find one entry by key. It scans, because the domain is not part of the key (decision 75). */
export const findKnowledge = async (store: Store, key: KnowledgeKey): Promise<Result<FoundKnowledge, JiraError>> => {
  const listing = await listingOf(store)
  if (!listing.ok) return listing
  const found = listing.value.entries.find(entry => entry.key === key)
  if (found === undefined) return err(notFound(key, 'knowledge entry'))
  return ok(Object.freeze({ entry: found, path: knowledgePath(found.domain, found.key), warnings: Object.freeze([]) }))
}

export const searchKnowledgeIn = async (
  store: Store,
  query: string,
  topK?: number,
): Promise<Result<KbSearch, JiraError>> => {
  const listing = await listingOf(store)
  if (!listing.ok) return listing
  return ok(searchKnowledge(listing.value.entries, query, topK))
}

/**
 * Decision 194 (trial feedback P1-3): an `issues` citation must not be a **knowledge key**.
 *
 * Knowledge keys are `KB-<n>` and issue keys are `<PROJECT>-<n>`, so a project named `KB` makes the two
 * indistinguishable by shape. The ledger's CI went red three times over exactly that: KB-14 cited
 * `[KB-11, KB-12]` intending issues, but KB-12 is another *knowledge entry*, and `lint` only reported
 * `kb-issue-dangling` **after** the write had landed.
 *
 * The rule refuses only the **provable** mistake: a key that already exists as a knowledge entry cannot
 * also be an issue. A citation to an issue that does not exist *yet* stays allowed — that is how two
 * machines merge a reference before the issue arrives.
 */
const assertIssueReferences = async (
  store: Store,
  issues: readonly IssueKey[],
): Promise<Result<undefined, JiraError>> => {
  if (issues.length === 0) return ok(undefined)
  const listing = await listingOf(store)
  if (!listing.ok) return listing
  const knowledgeKeys = new Set(listing.value.entries.map(entry => String(entry.key)))
  const confused = issues.map(String).filter(key => knowledgeKeys.has(key))
  if (confused.length === 0) return ok(undefined)
  return err(invalidInput(
    `issues: ${confused.join(', ')} ${confused.length === 1 ? 'is a knowledge entry' : 'are knowledge entries'}, `
    + 'not an issue — cite the issue key (or link the entry from the knowledge side)',
    { confused: Object.freeze([...confused]) },
  ))
}

export type NewKnowledge = Readonly<{
  domain: string
  kbType: string
  title: string
  tags?: readonly string[]
  body?: string
  issues?: readonly IssueKey[]
  source?: string
  sourceSha256?: string
}>

export type WrittenKnowledge = Readonly<{
  entry: KnowledgeEntry
  committed: boolean
  commitError?: JiraError
  /**
   * Decision 198: what the mirror did to the cited issues' `kb_refs` (decision 75's other face).
   * Absent when the entry cites nothing.
   */
  mirror?: MirrorResult
}>

/** One pass of "the cited issues get this entry in their `kb_refs`" (decision 198). */
export type MirrorResult = Readonly<{
  updated: readonly IssueKey[]
  failed: readonly Readonly<{ key: IssueKey; error: JiraError }>[]
}>

/**
 * Decision 75 says `knowledge[].issues[]` and `issues[].kb_refs[]` are two faces of one fact, so an
 * entry that cites an issue must leave that issue pointing back (decision 198). Each issue is its own
 * transaction — git has no cross-file transaction — so a partial mirror is reported, never hidden.
 */
export const mirrorKnowledgeRefs = async (
  store: Store,
  entry: KnowledgeKey,
  issues: readonly IssueKey[],
  actor: Actor,
): Promise<MirrorResult> => {
  const updated: IssueKey[] = []
  const failed: { key: IssueKey; error: JiraError }[] = []
  for (const key of issues) {
    const text = await readIssueText(store, key)
    if (!text.ok) {
      failed.push({ key, error: text.error })
      continue
    }
    const decoded = decodeIssue(text.value, key)
    if (!decoded.ok) {
      failed.push({ key, error: decoded.error })
      continue
    }
    const current = decoded.value.issue
    if (current.kbRefs.includes(entry)) continue // already mirrored — a re-run writes nothing
    const nextRefs = Object.freeze([...current.kbRefs, entry])
    const done = await transact(
      store,
      key,
      actor,
      (issue, ctx) => applyUpdate(issue, { kbRefs: nextRefs }, ctx),
      'kb link',
    )
    if (!done.ok) failed.push({ key, error: done.error })
    else updated.push(key)
  }
  return Object.freeze({ updated: Object.freeze(updated), failed: Object.freeze(failed) })
}

/** What every write records about where it came from (decision 75's quadruple). */
export type Origin = Readonly<{ machineId: string; os: string; tool: string }>

const originSource = (origin: Origin, at: Timestamp, extra: Readonly<{ source?: string; sourceSha256?: string }>) =>
  Object.freeze({
    machineId: origin.machineId,
    os: origin.os,
    tool: origin.tool,
    capturedAt: at,
    ...(extra.source === undefined ? {} : { source: extra.source }),
    ...(extra.sourceSha256 === undefined ? {} : { sourceSha256: extra.sourceSha256 }),
  })

/**
 * Create one entry: allocate a `KB-<n>` key, validate, write under that key's lock, commit.
 * The source quadruple is filled from the caller's own context rather than trusting the model to
 * type it (the audit that produced decision 75 found lineage nobody could trust).
 */
export const createKnowledge = async (
  store: Store,
  actor: Actor,
  origin: Origin,
  input: NewKnowledge,
): Promise<Result<WrittenKnowledge, JiraError>> => {
  const vocab = await loadVocab(store)
  if (!vocab.ok) return vocab
  // Decision 190: everything that can refuse the draft runs **before** a number exists —
  // a refused create must not burn a `KB-<n>` (the marker lets the caller say so).
  const draft = validateKnowledgeDraft(input, { kbTypes: vocab.value.kbTypes })
  if (!draft.ok) return err(withContext(draft.error, { keyAllocated: false }))
  // Decision 194: check the citations before a number is spent, so a refusal never burns a key (190).
  const cited = await assertIssueReferences(store, input.issues ?? [])
  if (!cited.ok) return err(withContext(cited.error, { keyAllocated: false }))

  const allocated = await allocateKey(store, KB_KEY_SPACE, actor.at)
  if (!allocated.ok) return allocated
  // `allocateKey` speaks the issue-key brand; the knowledge key has the same shape but its own
  // brand, and re-reading it through the guard keeps the brands honest instead of casting.
  const key = asKnowledgeKey(allocated.value)
  if (key === undefined) return err(invalidInput(`allocated key "${allocated.value}" is not a knowledge key`))

  const entry: KnowledgeEntry = Object.freeze({
    key,
    domain: input.domain,
    kbType: input.kbType,
    title: input.title,
    tags: Object.freeze([...(input.tags ?? [])]),
    source: originSource(origin, actor.at, {
      ...(input.source === undefined ? {} : { source: input.source }),
      ...(input.sourceSha256 === undefined ? {} : { sourceSha256: input.sourceSha256 }),
    }),
    issues: Object.freeze([...(input.issues ?? [])]),
    body: input.body ?? '',
    // Replaced below by the round-trip decode: the real value depends on how many frontmatter
    // lines this entry happens to encode to (decision 179).
    bodyLine: 1,
  })
  const encoded = encodeKnowledge(entry, { kbTypes: vocab.value.kbTypes })
  if (!encoded.ok) return encoded
  // Encode→decode is exact by design, so the written entry is also what a later read yields —
  // including `bodyLine`, which the caller would otherwise have to recompute (decision 179).
  const decodedBack = decodeKnowledge(encoded.value, key, input.domain)
  if (!decodedBack.ok) return decodedBack
  const writtenEntry = decodedBack.value.entry

  const path = knowledgePath(entry.domain, entry.key)
  const lockPath = issueLockPath(store.files.root, entry.key)
  const lockOwner = lockOwnerOf(store, actor.at)
  const written = await withLock(lockPath, lockOwner, lockOptionsOf(store), async () => {
    const write = await writeTextAtomic(join(store.files.root, ...path.split('/')), encoded.value)
    if (!write.ok) return write
    const commit = await commitStoreWrite(store, actor.at, [path], commitSubject({ key: entry.key, what: 'kb create' }))
    if (!commit.ok) return commit
    return ok(Object.freeze({
      entry: writtenEntry,
      committed: commit.value.committed,
      ...(commit.value.error === undefined ? {} : { commitError: commit.value.error }),
    }))
  })
  if (!written.ok) return written
  // Decision 198: the other face of decision 75 — mirror the citation after the entry exists.
  const mirror = entry.issues.length === 0
    ? undefined
    : await mirrorKnowledgeRefs(store, entry.key, entry.issues, actor)
  return ok(Object.freeze({ ...written.value, ...(mirror === undefined ? {} : { mirror }) }))
}

export type KnowledgePatch = Readonly<{
  title?: string
  kbType?: string
  tags?: readonly string[]
  body?: string
  issues?: readonly IssueKey[]
  source?: string | null
  sourceSha256?: string | null
}>

/** Update one entry in place: read under the lock, merge, re-validate, write, commit. */
export const updateKnowledge = async (
  store: Store,
  key: KnowledgeKey,
  actor: Actor,
  _origin: Origin,
  patch: KnowledgePatch,
): Promise<Result<WrittenKnowledge, JiraError>> => {
  const vocab = await loadVocab(store)
  if (!vocab.ok) return vocab

  const result = await withLock(issueLockPath(store.files.root, key), lockOwnerOf(store, actor.at), lockOptionsOf(store), async () => {
    const found = await findKnowledge(store, key)
    if (!found.ok) return found

    // Decisions 49/46, the write half — identical to the issue path: reading tolerates an unknown key
    // or a future version, but re-encoding would drop the key or downgrade the version silently.
    const current = await readText(join(store.files.root, ...knowledgePath(found.value.entry.domain, key).split('/')))
    if (current.ok) {
      const onDisk = decodeKnowledge(current.value, key, found.value.entry.domain)
      if (onDisk.ok) {
        if (onDisk.value.unknownKeys.length > 0) {
          return err(invalidInput(
            `refusing to write ${String(key)}: unknown frontmatter key(s) ${onDisk.value.unknownKeys.map(name => `"${name}"`).join(', ')} would be dropped`,
            { key: String(key), unknownKeys: onDisk.value.unknownKeys },
          ))
        }
        if (onDisk.value.schema !== KB_SCHEMA) {
          return err(invalidInput(
            `refusing to write ${String(key)}: the file is ${onDisk.value.schema}, and this version writes ${KB_SCHEMA}`,
            { key: String(key), schema: onDisk.value.schema, expected: KB_SCHEMA },
          ))
        }
      }
    }

    const previous = found.value.entry
    const source = Object.freeze({
      ...previous.source,
      ...(patch.source === undefined || patch.source === null ? {} : { source: patch.source }),
      ...(patch.sourceSha256 === undefined || patch.sourceSha256 === null ? {} : { sourceSha256: patch.sourceSha256 }),
    })
    const next: KnowledgeEntry = Object.freeze({
      ...previous,
      ...(patch.title === undefined ? {} : { title: patch.title }),
      ...(patch.kbType === undefined ? {} : { kbType: patch.kbType }),
      ...(patch.tags === undefined ? {} : { tags: Object.freeze([...patch.tags]) }),
      ...(patch.body === undefined ? {} : { body: patch.body }),
      ...(patch.issues === undefined ? {} : { issues: Object.freeze([...patch.issues]) }),
      source,
    })
    const encoded = encodeKnowledge(next, { kbTypes: vocab.value.kbTypes })
    if (!encoded.ok) return encoded

    const path = knowledgePath(next.domain, next.key)
    const written = await writeTextAtomic(join(store.files.root, ...path.split('/')), encoded.value)
    if (!written.ok) return written
    const commit = await commitStoreWrite(store, actor.at, [path], commitSubject({ key: next.key, what: 'kb update' }))
    if (!commit.ok) return commit
    return ok(Object.freeze({
      entry: next,
      committed: commit.value.committed,
      ...(commit.value.error === undefined ? {} : { commitError: commit.value.error }),
    }))
  })
  if (!result.ok) return result
  // Decision 198: `issues` may have changed, so the mirror runs again — it is idempotent per issue.
  const mirror = result.value.entry.issues.length === 0
    ? undefined
    : await mirrorKnowledgeRefs(store, key, result.value.entry.issues, actor)
  return ok(Object.freeze({ ...result.value, ...(mirror === undefined ? {} : { mirror }) }))
}

/* The lock's owner and options come from `lock.ts` (decision 181) — one source for every path. */

/** The `KB` project the keys are allocated in; exported so the tool can explain itself. */
export const KB_KEY_SPACE = KNOWLEDGE_KEY_SPACE

export const knowledgeKeySpace = (): string => KB_KEY_SPACE

/** A convenience for callers that have an identity rather than a machine id (decision 48). */
export const originFromIdentity = (
  identity: Identity | undefined,
  machineId: string,
  tool = 'dsh',
  os: string = system.facts.platform,
): Origin => Object.freeze({
  machineId: (identity === undefined ? undefined : machineIdOf(identity)) ?? machineId,
  os,
  tool,
})

export { projectOf }
