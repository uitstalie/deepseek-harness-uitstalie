/**
 * core/counters — key allocation that cannot collide offline (decisions 6, 74).
 *
 * `max(existing file names) + 1` is what two machines do when they are both offline, and
 * they both land on the same number. So each machine **claims a block** of numbers in the
 * store's `counters/<machine_id>.json` and only goes back for more when the block runs
 * out. Counting is **per project** — `DH-1` and `DEMO-1` are different spaces — so the file
 * keeps one entry per project (decision 114).
 *
 * The arithmetic here is pure: it takes every machine's counters, returns the key to use
 * and the counters file to write back. The store adds the locks and the I/O.
 */

import { join } from 'node:path'

import { type IssueKey, type Timestamp, assertProjectKey } from './entity.ts'
import { type JiraError, invalidInput, keyExhausted } from './errors.ts'
import { listDir, readText, writeTextAtomic } from './io.ts'
import { lockOptionsOf, lockOwnerOf, storeLockPath, withLock } from './lock.ts'
import { type Result, err, ok } from './result.ts'
import { type Store } from './store.ts'

export const COUNTERS_SCHEMA = 'counters/v1'
export const BLOCK_SIZE = 100

/**
 * The largest number a project may reach (decision 158). Keys are read by humans and quoted in
 * commit subjects, so the space is deliberately finite: `DEMO-9999` is the last one, and past it
 * `claimKey` refuses (`KEY_EXHAUSTED`, decision 52) instead of minting a number nobody wants to
 * type. Ten thousand issues in one project is a project that should be split.
 */
export const MAX_KEY_NUMBER = 9999

export type Block = readonly [start: number, end: number]

export type ProjectCounter = Readonly<{ next: number; blocks: readonly Block[] }>

export type CountersFile = Readonly<{
  schema: typeof COUNTERS_SCHEMA
  machine_id: string
  /** One entry per project: numbers are per `PROJECT-N` space, not global. */
  projects: Readonly<Record<string, ProjectCounter>>
}>

export const emptyCounters = (machineId: string): CountersFile =>
  Object.freeze({ schema: COUNTERS_SCHEMA, machine_id: machineId, projects: Object.freeze({}) })

const isBlockList = (value: unknown): value is readonly Block[] =>
  Array.isArray(value)
  && value.every(entry => Array.isArray(entry)
    && entry.length === 2
    && Number.isSafeInteger(entry[0])
    && Number.isSafeInteger(entry[1])
    && entry[0] >= 1
    && entry[1] >= entry[0])

/** Parse one machine's counters file; a broken one is an error, not a fresh start. */
export const parseCounters = (text: string, machineId: string): Result<CountersFile, JiraError> => {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (cause) {
    return err(invalidInput('the counters file is not valid JSON', { machineId, cause: String(cause) }))
  }
  if (typeof raw !== 'object' || raw === null) {
    return err(invalidInput('the counters file must be a JSON object', { machineId }))
  }
  const record = raw as Record<string, unknown>
  if (record.schema !== COUNTERS_SCHEMA) {
    return err(invalidInput(`counters schema must be "${COUNTERS_SCHEMA}"`, { schema: String(record.schema) }))
  }
  if (record.machine_id !== machineId) {
    return err(invalidInput('the counters file belongs to another machine', {
      expected: machineId,
      found: String(record.machine_id),
    }))
  }
  const projects: Record<string, ProjectCounter> = {}
  const rawProjects = typeof record.projects === 'object' && record.projects !== null
    ? (record.projects as Record<string, unknown>)
    : {}
  for (const [project, value] of Object.entries(rawProjects)) {
    if (typeof value !== 'object' || value === null) {
      return err(invalidInput(`counters for project "${project}" must be an object`, { project }))
    }
    const entry = value as Record<string, unknown>
    if (!Number.isSafeInteger(entry.next) || (entry.next as number) < 1) {
      return err(invalidInput(`counters for project "${project}" need a positive integer \`next\``, { project }))
    }
    if (!isBlockList(entry.blocks)) {
      return err(invalidInput(`counters for project "${project}" need a \`blocks\` list of [start, end]`, { project }))
    }
    projects[project] = Object.freeze({ next: entry.next as number, blocks: Object.freeze(entry.blocks) })
  }
  return ok(Object.freeze({ schema: COUNTERS_SCHEMA, machine_id: machineId, projects: Object.freeze(projects) }))
}

/** Stable, human-diffable JSON: sorted keys, two spaces, LF, one trailing newline. */
export const renderCounters = (file: CountersFile): string => {
  const projects: Record<string, unknown> = {}
  for (const project of Object.keys(file.projects).sort()) {
    const entry = file.projects[project]
    if (entry === undefined) continue
    projects[project] = {
      next: entry.next,
      blocks: entry.blocks.map(([start, end]) => [start, end]),
    }
  }
  return `${JSON.stringify({ schema: COUNTERS_SCHEMA, machine_id: file.machine_id, projects }, null, 2)}\n`
}

/** The highest number any machine has already claimed for this project (0 when none). */
export const highestClaim = (files: readonly CountersFile[], project: string): number => {
  let highest = 0
  for (const file of files) {
    const entry = file.projects[project]
    if (entry === undefined) continue
    for (const [, end] of entry.blocks) highest = Math.max(highest, end)
    highest = Math.max(highest, entry.next - 1)
  }
  return highest
}

export type Claim = Readonly<{ key: string; counters: CountersFile; claimedNewBlock: boolean }>

/**
 * Produce the next key for `project` from this machine's counters, claiming a fresh block
 * when the current one is used up. `files` must include **every** machine's counters, or
 * two machines could claim the same block.
 */
export const claimKey = (
  files: readonly CountersFile[],
  machineId: string,
  project: string,
  /** The highest number already used on disk, when this store predates the counters. */
  seed = 0,
): Result<Claim, JiraError> => {
  const mine = [...files].reverse().find(file => file.machine_id === machineId) ?? emptyCounters(machineId)
  const entry = mine.projects[project]
  const blockEnd = entry?.blocks.at(-1)?.[1] ?? 0
  const next = entry?.next ?? 1

  if (entry === undefined || next > blockEnd) {
    const start = Math.max(highestClaim(files, project), seed) + 1
    // Decision 158: the block is claimed *ahead* of use, so the check is on the number that would be
    // handed out — never on the block's end, or one block could silently straddle the cap.
    if (start > MAX_KEY_NUMBER) return err(keyExhausted(project, MAX_KEY_NUMBER, start))
    const end = start + BLOCK_SIZE - 1
    const claimed: ProjectCounter = Object.freeze({
      next: start + 1,
      blocks: Object.freeze([...(entry?.blocks ?? []), Object.freeze([start, end]) as Block]),
    })
    const counters = Object.freeze({
      ...mine,
      projects: Object.freeze({ ...mine.projects, [project]: claimed }),
    })
    return ok(Object.freeze({ key: `${project}-${start}`, counters, claimedNewBlock: true }))
  }

  // Decision 176: the seed is not only for the "first block" case. A key that appeared **inside** the
  // current block (a hand copy, a seed, another machine that was reset) would otherwise be handed out
  // again and the create would fail on an existing file. Skip past whatever is on disk.
  const firstFree = Math.max(next, seed + 1)
  if (firstFree > MAX_KEY_NUMBER) return err(keyExhausted(project, MAX_KEY_NUMBER, firstFree))
  if (firstFree > blockEnd) {
    // The seed pushed us past our own block: claim the next one from that point instead of straddling.
    const start = Math.max(highestClaim(files, project), seed) + 1
    if (start > MAX_KEY_NUMBER) return err(keyExhausted(project, MAX_KEY_NUMBER, start))
    const claimed: ProjectCounter = Object.freeze({
      next: start + 1,
      blocks: Object.freeze([...entry.blocks, Object.freeze([start, start + BLOCK_SIZE - 1]) as Block]),
    })
    return ok(Object.freeze({
      key: `${project}-${start}`,
      counters: Object.freeze({ ...mine, projects: Object.freeze({ ...mine.projects, [project]: claimed }) }),
      claimedNewBlock: true,
    }))
  }
  const advanced: ProjectCounter = Object.freeze({ next: firstFree + 1, blocks: entry.blocks })
  const counters = Object.freeze({
    ...mine,
    projects: Object.freeze({ ...mine.projects, [project]: advanced }),
  })
  return ok(Object.freeze({ key: `${project}-${firstFree}`, counters, claimedNewBlock: false }))
}

/* ── the I/O half (decision 185: moved out of `store.ts`, where it sat next to the transaction
   engine it has nothing to do with). The `Store` type is imported type-only, so the runtime
   dependency arrow stays `store → counters`, never the reverse. ───────────────────────────── */

/** Every machine's counters file. A missing `counters/` means nobody has claimed yet. */
export const readAllCounters = async (store: Store): Promise<Result<readonly CountersFile[], JiraError>> => {
  const directory = join(store.files.root, 'counters')
  const listed = await listDir(directory)
  if (!listed.ok) return ok(Object.freeze([]))
  const names = listed.value
  const files: CountersFile[] = []
  for (const name of names.slice().sort()) {
    if (!name.endsWith('.json')) continue
    const text = await readText(join(directory, name))
    if (!text.ok) continue
    const parsed = parseCounters(text.value, name.slice(0, -5))
    // A machine's broken counters file must not stop this machine; it does mean we cannot
    // count on its block, so it is surfaced rather than skipped silently.
    if (!parsed.ok) return parsed
    files.push(parsed.value)
  }
  return ok(Object.freeze(files))
}

/**
 * The highest `<PROJECT>-<n>` already on disk. A store that predates the counters (or was
 * seeded by hand) has no counter entry, so the first claim must start after what exists —
 * otherwise the very first allocation collides with a file that is already there.
 */
export const highestExistingKey = async (store: Store, project: string): Promise<number> => {
  const directory = join(store.files.root, 'projects', project, 'issues')
  const listed = await listDir(directory)
  if (!listed.ok) return 0
  const names = listed.value
  const pattern = new RegExp(`^${project}-(\\d+)\\.md$`)
  let highest = 0
  for (const name of names) {
    const match = pattern.exec(name)
    if (match !== null) highest = Math.max(highest, Number.parseInt(match[1] ?? '0', 10))
  }
  return highest
}

/**
 * Claim the next key for a project. Runs under the **store lock**, because it reads every
 * machine's counters and writes ours: two machines allocating at once must not claim the
 * same block (decision 58's fixed order: this path takes only the store lock).
 *
 * The project key is validated before anything builds a path or a counter entry out of it
 * (decision 162, via `entity.ts`'s `assertProjectKey`).
 */
export const allocateKey = async (
  store: Store,
  project: string,
  at: Timestamp,
): Promise<Result<IssueKey, JiraError>> => {
  const validated = assertProjectKey(project)
  if (!validated.ok) return validated
  return allocateKeyLocked(store, project, at)
}

const allocateKeyLocked = async (
  store: Store,
  project: string,
  at: Timestamp,
): Promise<Result<IssueKey, JiraError>> =>
  withLock(storeLockPath(store.files.root), lockOwnerOf(store, at), lockOptionsOf(store), async () => {
    const files = await readAllCounters(store)
    if (!files.ok) return files
    const claim = claimKey(files.value, store.machineId, project, await highestExistingKey(store, project))
    if (!claim.ok) return claim
    const written = await writeTextAtomic(
      join(store.files.root, 'counters', `${store.machineId}.json`),
      renderCounters(claim.value.counters),
    )
    if (!written.ok) return written
    return ok(claim.value.key as IssueKey)
  })
