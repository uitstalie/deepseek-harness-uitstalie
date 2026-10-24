/**
 * Tests for core/session — the session record (decision 10/119) and the close-out scan
 * (decisions 31/100).
 *
 * The two properties worth proving are the ones a session end depends on: the record is written
 * **once** (a resumed session keeps its original who-and-when), and the scan is **idempotent** (a
 * crash, or a second end, must not duplicate a comment).
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { removeTree } from './testing/removeTree.ts'
import { type Identity, type Timestamp } from './entity.ts'
import { runGit } from './git.ts'
import { writeTextAtomic } from './io.ts'
import { scaffoldStore } from './scaffold.ts'
import { createInStore, createStore, readComments, type Store } from './store.ts'
import {
  commitsTouching,
  decodeSession,
  encodeSession,
  ensureSessionRecord,
  listSessions,
  readSession,
  readWatermark,
  scanWatermarkPath,
  sessionScan,
  sessionPath,
  writeWatermark,
} from './session.ts'

const AT = '2026-10-15T12:00:00Z' as Timestamp
const ACTOR = Object.freeze({ by: 'human:daiqc' as Identity, at: AT })
const SESSION = 'sess-a1b2c3'

const work: string[] = []
const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T => {
  assert.equal(result.ok, true, `expected success, got ${JSON.stringify(result)}`)
  if (!result.ok) throw new Error('unreachable')
  return result.value
}

let root = ''
let store: Store

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-jira-session-'))
  work.push(root)
  unwrap(await scaffoldStore(root))
  await runGit(root, ['config', '--local', 'user.name', 'tester'])
  await runGit(root, ['config', '--local', 'user.email', 'tester@example.invalid'])
  store = createStore({ root, machineId: 'cccccccc' })
})

after(async () => {
  for (const directory of work) await removeTree(directory)
})

describe('session: the record is always inside sessions/ (decision 167)', () => {
  it('sanitises the id into one path segment', () => {
    assert.match(sessionPath('s-1'), /^sessions\/s-1\.md$/u)
    // The id comes from the host, but a hostile one must not write outside `sessions/`.
    // The property is "one segment under sessions/", not a particular spelling: dots inside a file name
    // are legal everywhere, a separator is not.
    const hostile = sessionPath('../../etc/passwd')
    assert.match(hostile, /^sessions\/[^/]+\.md$/u)
    assert.equal(hostile.split('/').length, 2, 'exactly one segment below sessions/')
    const segment = hostile.slice('sessions/'.length)
    assert.notEqual(segment, '..')
    assert.notEqual(segment, '.')
  })
})

describe('session: the record is written once (decision 10)', () => {
  const record = {
    id: SESSION,
    tool: 'dsh',
    model: 'deepseek-flash',
    machineId: 'cccccccc',
    startedAt: AT,
    toolEvidence: 'DSH_HOME=1',
  } as const

  it('writes sessions/<id>.md, and leaves it alone the second time', async () => {
    const first = unwrap(await ensureSessionRecord(store, ACTOR, record))
    assert.equal(first.written, true, 'the first write lands')

    const path = join(root, 'sessions', `${SESSION}.md`)
    const text = await readFile(path, 'utf8')
    assert.match(text, /^schema: session\/v1$/m)
    assert.match(text, /^tool: dsh$/m)
    assert.match(text, /^tool_evidence: DSH_HOME=1$/m, 'the raw evidence is recorded, not guessed')

    const read = unwrap(await readSession(store, SESSION))
    assert.equal(read?.model, 'deepseek-flash')
    assert.equal(read?.machineId, 'cccccccc')

    const second = unwrap(await ensureSessionRecord(store, { by: ACTOR.by, at: '2026-10-15T18:00:00Z' as Timestamp }, record))
    assert.equal(second.written, false, 'a resumed session keeps its original record')
    assert.equal(await readFile(path, 'utf8'), text)
  })

  it('says nothing about a session that never wrote', async () => {
    assert.equal(unwrap(await readSession(store, 'never-wrote')), undefined)
  })

  it('round-trips, and flags keys it does not know', () => {
    const decoded = unwrap(decodeSession(`${encodeSession({ id: 'x', tool: 'dsh', machineId: 'm', startedAt: AT })}\nunknown_key: 1\n`, 'x'))
    assert.equal(decoded.record.tool, 'dsh')
    assert.deepEqual(decoded.unknownKeys, [])
    const fenced = `---
schema: session/v1
type: session
session_id: y
tool: dsh
machine_id: m
started_at: 2026-10-15T12:00:00Z
nope: 1
---

body
`
    const withUnknown = unwrap(decodeSession(fenced, 'y'))
    assert.deepEqual(withUnknown.unknownKeys, ['nope'])
  })

  it('lists what is on disk, newest first', async () => {
    unwrap(await ensureSessionRecord(store, ACTOR, { id: 'sess-older', tool: 'dsh', machineId: 'cccccccc', startedAt: '2026-10-01T00:00:00Z' as Timestamp }))
    const listed = unwrap(await listSessions(store))
    assert.deepEqual(listed.map(session => session.id), [SESSION, 'sess-older'])
  })
})

describe('session: the close-out scan (decisions 31/100)', () => {
  let key = ''

  it('records the commits that mention an issue, once', async () => {
    const created = unwrap(await createInStore(store, 'DH', ACTOR, { issueType: 'task', summary: 'scanned work' }))
    key = String(created.key)
    const from = (await runGit(root, ['rev-parse', 'HEAD'])).stdout.trim()

    // Two commits, the first naming the issue, the second naming nothing.
    await runGit(root, ['commit', '--allow-empty', '-m', `${key}: do the thing`])
    await runGit(root, ['commit', '--allow-empty', '-m', 'a commit that names no issue'])

    const touched = await commitsTouching(store, from)
    assert.deepEqual(touched.map(commit => commit.keys), [[key]], 'only the naming commit counts')

    const scanned = unwrap(await sessionScan(store, ACTOR, { sessionId: SESSION, from }))
    assert.equal(scanned.commits, 1, 'the comment-only commit is not counted either')
    assert.deepEqual(scanned.commented, [key])
    assert.deepEqual(scanned.alreadyRecorded, [])

    const comments = unwrap(await readComments(store, key as never))
    assert.equal(comments.length, 1)
    assert.match(comments[0]?.body ?? '', new RegExp(`Session ${SESSION} touched ${key} in 1 commit\\(s\\):`))
    assert.match(comments[0]?.body ?? '', new RegExp(`- ${touched[0]?.sha.slice(0, 8) ?? ''} ${key}: do the thing`))

    // A second scan of the same range — a crash, or a session that ends twice — changes nothing.
    const again = unwrap(await sessionScan(store, ACTOR, { sessionId: SESSION, from }))
    assert.deepEqual(again.commented, [])
    assert.deepEqual(again.alreadyRecorded, [key])
    assert.equal(unwrap(await readComments(store, key as never)).length, 1, 'no duplicate comment')
  })

  it('reports a new commit even after an earlier scan', async () => {
    const head = (await runGit(root, ['rev-parse', 'HEAD'])).stdout.trim()
    await runGit(root, ['commit', '--allow-empty', '-m', `${key}: more work`])
    const scanned = unwrap(await sessionScan(store, ACTOR, { sessionId: SESSION, from: head }))
    assert.deepEqual(scanned.commented, [key])
    assert.equal(unwrap(await readComments(store, key as never)).length, 2)
  })
})

describe('session: the watermark', () => {
  it('lives outside the store, and survives being corrupt', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'dsh-jira-state-'))
    work.push(stateDir)
    const path = scanWatermarkPath(stateDir, 'sess/with:odd chars')
    assert.equal(path.startsWith(stateDir), true)
    assert.match(path, /sess_with_odd_chars\.json$/, 'a session id is made safe for a file name')

    assert.deepEqual(await readWatermark(path), { scans: 0 }, 'absent reads as never scanned')
    await writeWatermark(path, { lastSha: 'abc123', scans: 1 })
    assert.deepEqual(await readWatermark(path), { lastSha: 'abc123', scans: 1 })

    const { writeFile } = await import('node:fs/promises')
    await writeFile(path, '{ not json', 'utf8')
    assert.deepEqual(await readWatermark(path), { scans: 0 }, 'a corrupt watermark is not fatal')
  })

  it('writes through the io boundary: a failed write is a Result, not an exception (decision 180)', async () => {
    // Before decision 180 this was a raw `mkdir` + `writeFile` that **threw** past the caller;
    // it also bypassed the BOM/CR refusal. The blocked parent makes the write fail on cue.
    const stateDir = await mkdtemp(join(tmpdir(), 'dsh-jira-wm-'))
    work.push(stateDir)
    const blocker = join(stateDir, 'a-file')
    assert.equal((await writeTextAtomic(blocker, 'x\n')).ok, true)
    const written = await writeWatermark(join(blocker, 'wm.json'), { scans: 1 })
    assert.equal(written.ok, false, 'a Result now — the old raw writeFile threw here')
    if (!written.ok) assert.equal(written.error.code, 'WRITE_FAILED')

    const path = scanWatermarkPath(stateDir, 'sess-ok')
    assert.equal((await writeWatermark(path, { lastSha: 'abc123', scans: 2 })).ok, true)
    assert.deepEqual(await readWatermark(path), { lastSha: 'abc123', scans: 2 }, 'the parent directory is created for it')
  })
})
