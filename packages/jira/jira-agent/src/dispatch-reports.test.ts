/**
 * The superagent-owned dispatch report journal.
 *
 * These tests pin the properties the report path relies on: the binding is durable before any
 * prompt is admitted, a claim is exclusive, a replayed turn end cannot post twice, and a pending
 * report is settled (not left pending) when its Session can no longer run.
 */

import assert from 'node:assert/strict'
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { DISPATCH_REPORT_DIR, DISPATCH_REPORT_FILE, DispatchReportStore, newDispatchReportId } from './dispatch-reports.ts'

const AT = '2026-11-08T00:00:00.000Z'
const LATER = '2026-11-08T00:06:00.000Z'

const roots: string[] = []

const scratch = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-dispatch-reports-'))
  roots.push(root)
  return root
}

after(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const binding = (overrides: Partial<Parameters<DispatchReportStore['record']>[0]> = {}): Parameters<DispatchReportStore['record']>[0] => ({
  workspace: { id: 'w1', title: 'workspace', path: '/workspace' },
  sessionId: 'child-1',
  superSession: 'super-1',
  requestId: 'req-1',
  task: 'do the thing',
  dispatchedAt: AT,
  ...overrides,
})

describe('dispatch reports: journal', () => {
  it('records a pending binding keyed by child Session and prompt identity', async () => {
    const root = await scratch()
    const store = new DispatchReportStore(root)
    const recorded = await store.record(binding({ id: 'task-1' }))

    assert.equal(recorded.status, 'pending')
    assert.equal(recorded.id, 'task-1')
    const [row] = await store.forSession('child-1')
    assert.equal(row?.requestId, 'req-1')
    assert.equal(row?.superSession, 'super-1')
    assert.deepEqual(await store.forSession('another-child'), [])
    // The journal is plain JSONL a person can read, under the superagent-owned directory.
    const text = await readFile(join(root, DISPATCH_REPORT_DIR, DISPATCH_REPORT_FILE), 'utf8')
    assert.match(text, /"id":"task-1"/u)
  })

  it('mints distinct readable task ids', () => {
    const first = newDispatchReportId()
    const second = newDispatchReportId()
    assert.match(first, /^task-[0-9a-z]+-[0-9a-f]{8}$/u)
    assert.notEqual(first, second)
  })

  it('claims once and settles delivered; a second claim sees no work', async () => {
    const root = await scratch()
    const store = new DispatchReportStore(root)
    await store.record(binding({ id: 'task-claim' }))

    const claimed = await store.claim('task-claim', AT)
    assert.equal(claimed?.record.status, 'delivering')
    assert.equal(claimed?.record.attempts, 1)
    assert.equal(claimed?.retried, false)
    assert.equal(await store.claim('task-claim', AT), undefined, 'an in-flight claim is not claimed twice')

    await store.settle('task-claim', 'delivered', AT)
    assert.equal(await store.claim('task-claim', AT), undefined, 'a delivered report is never claimed again')
    assert.equal((await store.forSession('child-1'))[0]?.status, 'delivered')
    assert.equal((await store.forSession('child-1'))[0]?.deliveredAt, AT)
  })

  it('retries a stale delivering claim after the lease and reports the retry', async () => {
    const root = await scratch()
    const store = new DispatchReportStore(root)
    await store.record(binding({ id: 'task-stale' }))
    assert.equal((await store.claim('task-stale', AT))?.record.status, 'delivering')
    assert.equal(await store.claim('task-stale', '2026-11-08T00:01:00.000Z'), undefined)

    const retried = await store.claim('task-stale', LATER)
    assert.equal(retried?.retried, true)
    assert.equal(retried?.record.status, 'delivering')
    assert.equal(retried?.record.attempts, 2)
  })

  it('keeps a failed report settled when a later turn arrives', async () => {
    const root = await scratch()
    const store = new DispatchReportStore(root)
    await store.record(binding({ id: 'task-failed' }))
    await store.claim('task-failed', AT)
    await store.settle('task-failed', 'failed', AT, 'queue closed')

    const failed = (await store.forSession('child-1'))[0]
    assert.equal(failed?.status, 'failed')
    assert.equal(failed?.error, 'queue closed')
    assert.equal(await store.claim('task-failed', LATER), undefined)
  })

  it('reads the latest line per id and tolerates a torn final line', async () => {
    const root = await scratch()
    const store = new DispatchReportStore(root)
    await store.record(binding({ id: 'task-latest' }))
    await store.claim('task-latest', AT)
    await appendFile(join(root, DISPATCH_REPORT_DIR, DISPATCH_REPORT_FILE), '{"id":"torn"\n', 'utf8')

    const [row] = await store.forSession('child-1')
    assert.equal(row?.id, 'task-latest')
    assert.equal(row?.status, 'delivering')
    assert.equal((await store.all()).size, 1)
  })

  it('fails pending reports when their Session is archived or stopped', async () => {
    const root = await scratch()
    const store = new DispatchReportStore(root)
    await store.record(binding({ id: 'task-pending', sessionId: 'child-stop' }))
    await store.record(binding({ id: 'task-other', sessionId: 'child-other' }))
    await store.record(binding({ id: 'task-done', sessionId: 'child-stop' }))
    await store.claim('task-done', AT)
    await store.settle('task-done', 'delivered', AT)

    const failed = await store.failPendingForSessions(['child-stop'], LATER, 'the Session was archived')
    assert.equal(failed, 1)
    const stopped = await store.forSession('child-stop')
    assert.equal(stopped.find(row => row.id === 'task-pending')?.status, 'failed')
    assert.equal(stopped.find(row => row.id === 'task-pending')?.error, 'the Session was archived')
    assert.equal(stopped.find(row => row.id === 'task-done')?.status, 'delivered', 'a settled report stays settled')
    assert.equal((await store.forSession('child-other'))[0]?.status, 'pending')
  })

  it('keeps one journal per super workspace root', async () => {
    const firstRoot = await scratch()
    const secondRoot = await scratch()
    await new DispatchReportStore(firstRoot).record(binding({ id: 'task-a' }))
    assert.equal((await new DispatchReportStore(secondRoot).forSession('child-1')).length, 0)
    assert.equal((await new DispatchReportStore(firstRoot).forSession('child-1'))[0]?.id, 'task-a')
  })
})
