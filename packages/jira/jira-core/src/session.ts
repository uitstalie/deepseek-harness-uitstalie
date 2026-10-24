/**
 * core/session — the session record and the session-end scan (decisions 10/31/100/119).
 *
 * Two things the design asks for that share one idea: **a session is a fact worth recording**.
 *
 * `sessions/<session_id>.md` is written **once**, at the session's first write, and carries which
 * tool and model produced the work plus the raw **`tool_evidence`** that identified the host
 * (decision 10) — "which tool" must be reproducible, not guessed later from the shape of the data.
 *
 * The **close-out scan** (decision 100) walks the commits made during the session and appends one
 * comment per touched issue. It is idempotent twice over, because a session can end more than once
 * (a crash, a resume): a **watermark** under `$DSH_HOME/dsh-jira/` skips a scan that already
 * happened, and the comment itself carries the commit sha, so even a rescan cannot duplicate it.
 *
 * Reading never writes here (decision 38): `readSession`/`readWatermark` are pure reads, and the two
 * writers (`ensureSessionRecord`, `sessionScan`) are called from the session-end path only. The
 * scan's comments go through the ordinary write transaction (`transact` + `applyComment`), so they
 * take the issue's lock, advance nothing, and are committed like any other comment.
 */

import { join } from 'node:path'

import { type Timestamp } from './entity.ts'
import { type JiraError, invalidInput } from './errors.ts'
import { parseFrontmatter, renderFrontmatter, type Frontmatter } from './frontmatter.ts'
import { type GitRunner, runGit } from './git.ts'
import { listDir, readText, writeTextAtomic } from './io.ts'
import { system } from './system/index.ts'
import { keysIn } from './commitmsg.ts'
import { applyComment } from './mutate.ts'
import { type Result, err, ok } from './result.ts'
import { type Actor, type Store, commitStoreWrite, readComments, transact } from './store.ts'

export const SESSION_SCHEMA = 'session/v1'
export const SESSION_DOCUMENT_TYPE = 'session'

/**
 * Where a session record lives. The id comes from the host, but it is still **one path segment**
 * (decision 167): `../x` used to write outside `sessions/`, and that is exactly what `safeFileName`
 * is for. The file keeps a readable id (the raw id, when it is already safe).
 */
export const sessionPath = (sessionId: string): string =>
  `sessions/${system.safeFileName(sessionId)}.md`

export type SessionRecord = Readonly<{
  id: string
  /** The tool that ran the session (`dsh` for this plugin's host). */
  tool: string
  model?: string
  machineId: string
  startedAt: Timestamp
  /** The raw evidence that identified the tool — `CLAUDECODE=1`, `DSH_HOME=…`, whatever it was. */
  toolEvidence?: string
}>

const SESSION_FIELDS: readonly string[] = Object.freeze([
  'schema', 'type', 'session_id', 'tool', 'model', 'machine_id', 'started_at', 'tool_evidence',
])

export const encodeSession = (record: SessionRecord): string => {
  const frontmatter: Frontmatter = Object.freeze({
    schema: SESSION_SCHEMA,
    type: SESSION_DOCUMENT_TYPE,
    session_id: record.id,
    tool: record.tool,
    ...(record.model === undefined ? {} : { model: record.model }),
    machine_id: record.machineId,
    started_at: record.startedAt,
    ...(record.toolEvidence === undefined ? {} : { tool_evidence: record.toolEvidence }),
  })
  return renderFrontmatter(frontmatter, `Session ${record.id}.\n`)
}

const asText = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

export const decodeSession = (
  text: string,
  id: string,
): Result<Readonly<{ record: SessionRecord; unknownKeys: readonly string[] }>, JiraError> => {
  const parsed = parseFrontmatter(text)
  if (!parsed.ok) return parsed
  const frontmatter = parsed.value.frontmatter
  const unknownKeys = Object.keys(frontmatter).filter(key => !SESSION_FIELDS.includes(key))
  const model = asText(frontmatter.model)
  const evidence = asText(frontmatter.tool_evidence)
  return ok(Object.freeze({
    record: Object.freeze({
      id: asText(frontmatter.session_id) ?? id,
      tool: asText(frontmatter.tool) ?? 'unknown',
      ...(model === undefined ? {} : { model }),
      machineId: asText(frontmatter.machine_id) ?? '',
      startedAt: (asText(frontmatter.started_at) ?? '') as Timestamp,
      ...(evidence === undefined ? {} : { toolEvidence: evidence }),
    }),
    unknownKeys: Object.freeze(unknownKeys),
  }))
}

/** Read a session record; `undefined` when this session has never written anything. */
export const readSession = async (store: Store, id: string): Promise<Result<SessionRecord | undefined, JiraError>> => {
  const text = await readText(join(store.files.root, ...sessionPath(id).split('/')))
  if (!text.ok) return ok(undefined)
  const decoded = decodeSession(text.value, id)
  return decoded.ok ? ok(decoded.value.record) : ok(undefined)
}

/**
 * Write the session record **once**. Idempotent by construction: an existing file is left exactly as
 * it is, so a resumed session keeps its original "who and when" (decision 10).
 */
export const ensureSessionRecord = async (
  store: Store,
  actor: Actor,
  record: SessionRecord,
): Promise<Result<Readonly<{ written: boolean }>, JiraError>> => {
  if (record.id.trim() === '') return err(invalidInput('a session record needs an id'))
  const existing = await readSession(store, record.id)
  if (!existing.ok) return existing
  if (existing.value !== undefined) return ok(Object.freeze({ written: false }))

  const path = sessionPath(record.id)
  const written = await writeTextAtomic(join(store.files.root, ...path.split('/')), encodeSession(record))
  if (!written.ok) return written
  const commit = await commitStoreWrite(store, actor.at, [path], `session ${record.id} [no-issue]`)
  if (!commit.ok) return commit
  return ok(Object.freeze({ written: true }))
}

/* ── the close-out scan (decision 100) ───────────────────────────────────────── */

/** Where the scan's watermark lives: outside the store, like every machine-local fact (decision 73). */
export const scanWatermarkPath = (dshHome: string, sessionId: string): string =>
  join(dshHome, 'dsh-jira', 'session-scan', `${sessionId.replace(/[^A-Za-z0-9._-]/gu, '_')}.json`)

export type Watermark = Readonly<{ lastSha?: string; scans: number }>

export const readWatermark = async (path: string): Promise<Watermark> => {
  const text = await readText(path)
  if (!text.ok) return Object.freeze({ scans: 0 })
  try {
    const parsed = JSON.parse(text.value) as { lastSha?: unknown; scans?: unknown }
    return Object.freeze({
      ...(typeof parsed.lastSha === 'string' ? { lastSha: parsed.lastSha } : {}),
      scans: typeof parsed.scans === 'number' ? parsed.scans : 0,
    })
  } catch {
    // A corrupt watermark is not worth failing a session end over: treat it as absent.
    return Object.freeze({ scans: 0 })
  }
}

/**
 * Persist the watermark. Returns the io boundary's Result rather than throwing (decision 180):
 * the session end must survive a failed watermark write, and the BOM/CR refusal stays in one place.
 */
export const writeWatermark = async (path: string, watermark: Watermark): Promise<Result<void, JiraError>> =>
  writeTextAtomic(path, `${JSON.stringify(watermark, null, 2)}\n`)

export type CommitTouched = Readonly<{ sha: string; subject: string; keys: readonly string[] }>

/** The commits in a range that mention an issue key (decision 67's shape), newest first. */
/**
 * A commit whose only job was to record a comment (`store.ts` writes `<KEY>: comment (rev N)`).
 *
 * The scan must skip these, and the reason is a feedback loop the tests caught: the scan's own
 * comment is committed as one of them, so a scan that reported them would find **its own** commit
 * on the next run and comment again, forever. Nothing is lost: a comment is already recorded in
 * the ledger, and the scan exists to record the *work* a session did.
 */
const COMMENT_ONLY_COMMIT = /^\S+: comment \(rev \d+\)$/u

export const commitsTouching = async (
  store: Store,
  from: string,
  run: GitRunner = runGit,
): Promise<readonly CommitTouched[]> => {
  const range = from === '' ? ['-n', '100'] : [`${from}..HEAD`]
  const listed = await run(store.files.root, ['log', '--format=%H%x1f%s', ...range])
  if (listed.code !== 0) return Object.freeze([])
  const commits: CommitTouched[] = []
  for (const line of listed.stdout.split('\n')) {
    if (line.trim() === '') continue
    const [sha, subject] = line.split('\u001f')
    if (sha === undefined || subject === undefined) continue
    if (COMMENT_ONLY_COMMIT.test(subject)) continue
    const keys = keysIn(subject).map(String)
    if (keys.length === 0) continue
    commits.push(Object.freeze({ sha: sha.trim(), subject, keys: Object.freeze(keys) }))
  }
  return Object.freeze(commits)
}

export type ScanOutcome = Readonly<{
  /** Commits examined (those whose subject names an issue). */
  commits: number
  /** Issues that received a new comment. */
  commented: readonly string[]
  /** Issues skipped because a comment already carried that sha (idempotence). */
  alreadyRecorded: readonly string[]
}>

/**
 * Append one comment per issue touched since `from`, skipping anything already recorded.
 *
 * A comment carries the commit sha, and that is what makes a second scan — after a crash, or a
 * session that ends twice — a no-op for the issues it already covered.
 */
export const sessionScan = async (
  store: Store,
  actor: Actor,
  options: Readonly<{ sessionId: string; from: string; run?: GitRunner }>,
): Promise<Result<ScanOutcome, JiraError>> => {
  const commits = await commitsTouching(store, options.from, options.run ?? runGit)
  const byKey = new Map<string, CommitTouched[]>()
  for (const commit of commits) {
    for (const key of commit.keys) {
      const list = byKey.get(key) ?? []
      list.push(commit)
      byKey.set(key, list)
    }
  }

  const commented: string[] = []
  const alreadyRecorded: string[] = []
  for (const [key, touched] of [...byKey.entries()].sort()) {
    const existing = await readComments(store, key as never)
    const bodies = existing.ok ? existing.value.map(comment => comment.body).join('\n') : ''
    // The comment shows the short sha, so both forms count as already recorded.
    const fresh = touched.filter(commit => !bodies.includes(commit.sha) && !bodies.includes(commit.sha.slice(0, 8)))
    if (fresh.length === 0) {
      alreadyRecorded.push(key)
      continue
    }
    const body = [
      `Session ${options.sessionId} touched ${key} in ${String(fresh.length)} commit(s):`,
      ...fresh.map(commit => `- ${commit.sha.slice(0, 8)} ${commit.subject}`),
    ].join('\n')
    // The ordinary write transaction: the issue's lock, the normal commit, no revision bump (a
    // comment is not a body change — decision 44).
    const appended = await transact(store, key as never, actor, (issue, ctx) => applyComment(issue, body, ctx), 'scan')
    if (!appended.ok) return appended
    commented.push(key)
  }

  return ok(Object.freeze({
    commits: commits.length,
    commented: Object.freeze(commented),
    alreadyRecorded: Object.freeze(alreadyRecorded),
  }))
}

/** Every session record on disk, newest first — used by the doctor and by tests. */
export const listSessions = async (store: Store): Promise<Result<readonly SessionRecord[], JiraError>> => {
  const directory = join(store.files.root, 'sessions')
  const listed = await listDir(directory)
  if (!listed.ok) return ok(Object.freeze([]))
  const names = listed.value.filter(name => name.endsWith('.md')).sort()
  const records: SessionRecord[] = []
  for (const name of names) {
    const record = await readSession(store, name.slice(0, -3))
    if (record.ok && record.value !== undefined) records.push(record.value)
  }
  return ok(Object.freeze(records.sort((left, right) => right.startedAt.localeCompare(left.startedAt))))
}
