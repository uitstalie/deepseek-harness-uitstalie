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

void describe('dispatch reports: journal', () => {
  const journalRows = async (root: string): Promise<Record<string, unknown>[]> => {
    const text = await readFile(join(root, DISPATCH_REPORT_DIR, DISPATCH_REPORT_FILE), 'utf8')
    return text.trim().split(/\r?\n/u).map(line => JSON.parse(line) as Record<string, unknown>)
  }

  void it('records a pending binding keyed by child Session and prompt identity', async () => {
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

  void it('mints distinct readable task ids', () => {
    const first = newDispatchReportId()
    const second = newDispatchReportId()
    assert.match(first, /^task-[0-9a-z]+-[0-9a-f]{8}$/u)
    assert.notEqual(first, second)
  })

  void it('claims once and settles delivered; a second claim sees no work', async () => {
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

  void it('prepares a report only while its claim is delivering', async () => {
    const root = await scratch()
    const store = new DispatchReportStore(root)
    await store.record(binding({ id: 'task-prepare' }))
    assert.equal(await store.prepare('task-prepare', AT, 'too early', 'work done', 'returned'), undefined)
    assert.equal((await journalRows(root)).length, 1, 'a rejected prepare does not append JSONL')

    await store.claim('task-prepare', AT)
    const prepared = await store.prepare('task-prepare', LATER, '# Completed\n\nThe work is done.', 'work done', 'returned')
    assert.equal(prepared?.status, 'delivering')
    assert.equal(prepared?.reportText, '# Completed\n\nThe work is done.')
    assert.equal(prepared?.outcome, 'work done')
    assert.equal(prepared?.result, 'returned')
    assert.equal(prepared?.updatedAt, LATER)
    assert.equal(prepared?.attempts, 1)

    // Read the durable rows rather than trusting the returned record.
    const rows = await journalRows(root)
    assert.equal(rows.length, 3)
    assert.equal(rows[2]?.id, 'task-prepare')
    assert.equal(rows[2]?.status, 'delivering')
    assert.equal(rows[2]?.reportText, '# Completed\n\nThe work is done.')
    assert.equal(rows[2]?.outcome, 'work done')
    assert.equal(rows[2]?.result, 'returned')
    assert.equal((await new DispatchReportStore(root).all()).get('task-prepare')?.reportText, '# Completed\n\nThe work is done.')

    await store.settle('task-prepare', 'delivered', LATER)
    assert.equal(await store.prepare('task-prepare', LATER, 'late edit', 'changed', 'failed'), undefined)
    assert.equal((await journalRows(root)).length, 4, 'prepare after delivery does not append JSONL')
  })

  void it('lists failures oldest first and retries only failed reports with saved text', async () => {
    const root = await scratch()
    const store = new DispatchReportStore(root)
    await store.record(binding({ id: 'task-retry', dispatchedAt: AT }))
    await store.claim('task-retry', AT)
    await store.prepare('task-retry', '2026-11-08T00:02:00.000Z', 'saved report', 'completed', 'returned')
    await store.settle('task-retry', 'failed', '2026-11-08T00:03:00.000Z', 'queue closed')
    await store.record(binding({ id: 'task-no-text', dispatchedAt: '2026-11-08T00:01:00.000Z' }))
    await store.settle('task-no-text', 'failed', '2026-11-08T00:01:30.000Z', 'missing result')
    await store.record(binding({ id: 'task-delivered', dispatchedAt: '2026-11-08T00:02:00.000Z' }))
    await store.claim('task-delivered', AT)
    await store.prepare('task-delivered', AT, 'delivered report', 'completed', 'returned')
    await store.settle('task-delivered', 'delivered', AT)

    const failures = await store.failures()
    assert.deepEqual(failures.map(row => row.id), ['task-no-text', 'task-retry'])
    assert.equal(failures[1]?.reportText, 'saved report')
    await store.record(binding({ id: 'task-unsettled' }))
    await store.claim('task-unsettled', LATER)
    assert.equal((await store.failures()).some(row => row.id === 'task-unsettled' && row.status === 'delivering'), true)
    assert.equal(failures[1]?.error, 'queue closed')

    assert.equal(await store.retry('task-no-text', LATER), undefined, 'a failure without saved text cannot retry')
    assert.equal(await store.retry('task-delivered', LATER), undefined, 'a delivered report never reopens')
    assert.equal(await store.retry('missing', LATER), undefined)
    const beforeRetry = await journalRows(root)
    const retried = await store.retry('task-retry', LATER)
    assert.equal(retried?.status, 'pending')
    assert.equal(retried?.updatedAt, LATER)
    assert.equal(retried?.reportText, 'saved report')
    assert.equal(retried?.outcome, 'completed')
    assert.equal(retried?.result, 'returned')
    assert.equal(retried?.error, 'queue closed', 'retry retains the previous error for audit')
    assert.equal(retried?.attempts, 1)

    const afterRetry = await journalRows(root)
    assert.equal(afterRetry.length, beforeRetry.length + 1)
    assert.equal(afterRetry.at(-1)?.id, 'task-retry')
    assert.equal(afterRetry.at(-1)?.status, 'pending')
    assert.equal(afterRetry.at(-1)?.reportText, 'saved report')
    const reloaded = await new DispatchReportStore(root).all()
    assert.equal(reloaded.get('task-retry')?.status, 'pending')
    assert.equal(reloaded.get('task-delivered')?.status, 'delivered')
    assert.equal(reloaded.get('task-no-text')?.status, 'failed')
  })

  void it('retries a stale delivering claim after the lease and reports the retry', async () => {
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

  void it('keeps a failed report settled when a later turn arrives', async () => {
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

  void it('reads the latest line per id and tolerates a torn final line', async () => {
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

  void it('fails pending reports when their Session is archived or stopped', async () => {
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

  void it('keeps one journal per super workspace root', async () => {
    const firstRoot = await scratch()
    const secondRoot = await scratch()
    await new DispatchReportStore(firstRoot).record(binding({ id: 'task-a' }))
    assert.equal((await new DispatchReportStore(secondRoot).forSession('child-1')).length, 0)
    assert.equal((await new DispatchReportStore(firstRoot).forSession('child-1'))[0]?.id, 'task-a')
  })
})
