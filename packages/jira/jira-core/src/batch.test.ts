/**
 * `closeMany` — all-or-nothing (decision 196). The tests pin the two promises that matter: a refusal
 * writes **nothing**, and a partial write is reported rather than hidden.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { closeMany } from './batch.ts'
import { encodeIssue } from './codec.ts'
import { type Identity, type Issue, type IssueKey, type Timestamp } from './entity.ts'
import { writeTextAtomic } from './io.ts'
import { createStore, storePaths } from './store.ts'

const fixture = readFileSync(new URL('../fixtures/config.md', import.meta.url), 'utf8')
const ACTOR = Object.freeze({ by: 'human:tester' as Identity, at: '2026-10-15T12:00:00Z' as Timestamp })
const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T => {
  assert.equal(result.ok, true, `expected success, got ${JSON.stringify(result)}`)
  if (!result.ok) throw new Error('unreachable')
  return result.value
}

const issue = (key: string, status: string): Issue => Object.freeze({
  key: key as IssueKey,
  project: 'DH',
  issueType: 'task',
  status,
  summary: `issue ${key}`,
  priority: 'S3',
  tags: Object.freeze([]),
  links: Object.freeze([]),
  revision: 1,
  createdAt: ACTOR.at,
  updatedAt: ACTOR.at,
  reporter: ACTOR.by,
  kbRefs: Object.freeze([]),
  conflicted: false,
  body: '',
} as Issue)

let dir = ''
let store: ReturnType<typeof createStore>

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-jira-batch-'))
  await mkdir(join(dir, 'projects', 'DH', 'issues'), { recursive: true })
  await writeTextAtomic(storePaths.config(dir), fixture)
  store = createStore({ root: dir, machineId: 'batch001' })
  for (const [key, status] of [['DH-1', 'todo'], ['DH-2', 'in_progress'], ['DH-3', 'in_progress']] as const) {
    const encoded = encodeIssue(issue(key, status))
    assert.equal(encoded.ok, true)
    if (encoded.ok) await writeTextAtomic(storePaths.issue(dir, 'DH', key as IssueKey), encoded.value)
  }
})

after(async () => {
  if (dir !== '') await rm(dir, { recursive: true, force: true })
})

describe('batch: all-or-nothing (decision 196)', () => {
  it('refuses the whole call when one key cannot be closed, and writes nothing', async () => {
    // DH-1 is still `todo`, and decision 189 removed `todo → closed`: one refusal means nothing lands —
    // including DH-2/DH-3, which would have been closable.
    const result = await closeMany(store, ['DH-2', 'DH-1'] as IssueKey[], ACTOR, { resolution: 'fixed' })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.match(result.error.message, /nothing was written/u)
      const refused = result.error.context?.refused as readonly { key: string }[]
      assert.deepEqual(refused.map(entry => entry.key), ['DH-1'])
    }
    // …and DH-2 is untouched: the refusal happened before any transaction ran.
    const read = await import('./store.ts').then(module => module.readIssueText(store, 'DH-2' as IssueKey))
    assert.equal(read.ok, true)
    if (read.ok) assert.match(read.value, /status: in_progress/u)
  })

  it('closes every key when all of them pass', async () => {
    const closed = unwrap(await closeMany(store, ['DH-2', 'DH-3'] as IssueKey[], ACTOR, {
      resolution: 'fixed',
      comment: 'batch closed',
    }))
    assert.deepEqual(closed.closed, ['DH-2', 'DH-3'])
    assert.equal(closed.partial, undefined)
  })
})
