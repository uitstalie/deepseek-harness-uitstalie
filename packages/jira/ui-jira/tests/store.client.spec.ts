/**
 * The jira page controller: what a Host change does to what is on screen.
 *
 * The page never polls and never watches files; it re-reads the snapshots it shows when the Host
 * says the ledger changed. These cases drive that path without a browser: the scripted wire is the
 * same interface the generated `remote.jira` namespace satisfies.
 */

import { describe, expect, it, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  JiraBoardView,
  JiraChangeEvent,
  JiraIssueDetailView,
  JiraIssueRowView,
  JiraKbSearchView,
  JiraStatusView,
} from '@deepseek-ai/dsh-jira-service/types'
import { JiraStore, type JiraWire } from '../src/client/store.ts'

const STATUS: JiraStatusView = {
  root: '/srv/ledger',
  machineId: 'a1b2c3d4',
  host: 'fixture-host',
  pushEnabled: false,
  lastSync: null,
  pending: false,
}

const ROW: JiraIssueRowView = {
  key: 'DH-1',
  project: 'DH',
  issueType: 'task',
  status: 'todo',
  priority: 'S3',
  summary: 'at read time',
  tags: [],
  updatedAt: '2026-10-15T12:00:00Z',
  revision: 1,
  blocked: false,
}

const ISSUE: JiraIssueDetailView = {
  key: 'DH-1',
  project: 'DH',
  issueType: 'task',
  status: 'todo',
  summary: 'at read time',
  priority: 'S3',
  tags: [],
  links: [],
  revision: 1,
  createdAt: '2026-10-15T12:00:00Z',
  updatedAt: '2026-10-15T12:00:00Z',
  reporter: 'human:fixture',
  kbRefs: [],
  conflicted: false,
  body: 'body',
}

const KB: JiraKbSearchView = {
  hits: [],
  matched: 0,
  truncated: false,
  topK: 10,
}

/** A board whose one row carries the summary this case wants to observe. */
const boardWith = (summary: string): JiraBoardView => {
  const row = { ...ROW, summary }
  return {
    items: [row],
    groups: [{ name: 'DH · todo', kind: 'status', project: 'DH', status: 'todo', items: [row] }],
    counts: { matched: 1, returned: 1, remaining: 0, byStatus: { todo: 1 }, blocked: 0 },
    truncated: false,
    limit: 20,
  }
}

/** A detail whose summary this case wants to observe. */
const issueWith = (summary: string): JiraIssueDetailView => ({ ...ISSUE, summary })

const ok = <T>(value: T): RemoteResult<T> => ({ ok: true, value })

const notice = (version: number): JiraChangeEvent => ({
  version,
  kind: 'write',
  key: 'DH-1',
  at: '2026-10-15T12:00:00Z' as JiraChangeEvent['at'],
})

/** One promise a case resolves by hand, so a response can be made to arrive late. */
interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

/** A wire whose methods a case scripts with `mockResolvedValueOnce` or deferred promises. */
function scriptedWire(): JiraWire & {
  board: ReturnType<typeof vi.fn>
  status: ReturnType<typeof vi.fn>
  get: ReturnType<typeof vi.fn>
  kbSearch: ReturnType<typeof vi.fn>
} {
  return {
    status: vi.fn(async () => ok(STATUS)),
    board: vi.fn(async () => ok(boardWith('at read time'))),
    get: vi.fn(async () => ok(ISSUE)),
    kbSearch: vi.fn(async () => ok(KB)),
  }
}

describe('jira page: following the Host ledger', () => {
  it('re-reads the board, the status and the open detail after one change', async () => {
    const wire = scriptedWire()
    const controller = new JiraStore(wire)
    await controller.load()
    await controller.select('DH-1')
    expect(wire.board).toHaveBeenCalledTimes(1)
    expect(wire.get).toHaveBeenCalledTimes(1)

    wire.board.mockResolvedValueOnce(ok(boardWith('after the write')))
    controller.changed(notice(1))

    await vi.waitFor(() => { expect(wire.board).toHaveBeenCalledTimes(2) })
    await vi.waitFor(() => { expect(wire.get).toHaveBeenCalledTimes(2) })
    await vi.waitFor(() => {
      expect(controller.store.getSnapshot().board.view?.items[0]?.summary).toBe('after the write')
    })
    expect(wire.status).toHaveBeenCalledTimes(2)
  })

  it('does not touch the Host for a page that was never opened', () => {
    const wire = scriptedWire()
    const controller = new JiraStore(wire)
    controller.changed(notice(1))
    controller.changed(notice(2))
    expect(wire.board).not.toHaveBeenCalled()
    expect(wire.status).not.toHaveBeenCalled()
    expect(wire.get).not.toHaveBeenCalled()
  })

  it('drops a board answer that a newer change superseded', async () => {
    const wire = scriptedWire()
    const first = deferred<RemoteResult<JiraBoardView>>()
    const second = deferred<RemoteResult<JiraBoardView>>()
    wire.board.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const controller = new JiraStore(wire)

    const initial = controller.load()
    controller.changed(notice(1))
    second.resolve(ok(boardWith('newer')))
    await vi.waitFor(() => { expect(controller.store.getSnapshot().board.view?.items[0]?.summary).toBe('newer') })
    first.resolve(ok(boardWith('older')))
    await initial
    expect(controller.store.getSnapshot().board.view?.items[0]?.summary).toBe('newer')
  })

  it('drops a detail answer for an issue the reader left', async () => {
    const wire = scriptedWire()
    const first = deferred<RemoteResult<JiraIssueDetailView>>()
    const second = deferred<RemoteResult<JiraIssueDetailView>>()
    wire.get.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const controller = new JiraStore(wire)

    const firstRead = controller.select('DH-1')
    const secondRead = controller.select('DH-2')
    second.resolve(ok(issueWith('second issue')))
    await secondRead
    first.resolve(ok(issueWith('first issue')))
    await firstRead
    expect(controller.store.getSnapshot().detail?.view?.summary).toBe('second issue')
  })

  it('marks knowledge hits stale after a change and clears the mark on the next search', async () => {
    const wire = scriptedWire()
    const controller = new JiraStore(wire)
    await controller.load()
    controller.setQuery('lock')
    await controller.search()
    expect(controller.store.getSnapshot().knowledge.stale).toBe(false)

    controller.changed(notice(1))
    expect(controller.store.getSnapshot().knowledge.stale).toBe(true)
    expect(controller.store.getSnapshot().knowledge.view).not.toBeNull()

    await controller.search()
    expect(controller.store.getSnapshot().knowledge.stale).toBe(false)
  })

  it('marks a search that straddled a change stale when it settles', async () => {
    const wire = scriptedWire()
    const pending = deferred<RemoteResult<JiraKbSearchView>>()
    wire.kbSearch.mockReturnValueOnce(pending.promise)
    const controller = new JiraStore(wire)
    await controller.load()
    controller.setQuery('lock')

    const searched = controller.search()
    controller.changed(notice(1))
    pending.resolve(ok(KB))
    await searched
    expect(controller.store.getSnapshot().knowledge.stale).toBe(true)
  })

  it('ignores a notice that is not newer than the last one applied', async () => {
    const wire = scriptedWire()
    const controller = new JiraStore(wire)
    await controller.load()
    controller.changed(notice(2))
    await vi.waitFor(() => { expect(wire.board).toHaveBeenCalledTimes(2) })
    controller.changed(notice(1))
    controller.changed(notice(2))
    expect(wire.board).toHaveBeenCalledTimes(2)
    controller.changed(notice(3))
    await vi.waitFor(() => { expect(wire.board).toHaveBeenCalledTimes(3) })
  })

  it('re-reads after a reconnect and compares versions from the new Host generation', async () => {
    const wire = scriptedWire()
    const controller = new JiraStore(wire)
    await controller.load()
    controller.changed(notice(5))
    await vi.waitFor(() => { expect(wire.board).toHaveBeenCalledTimes(2) })

    controller.reconnected()
    await vi.waitFor(() => { expect(wire.board).toHaveBeenCalledTimes(3) })
    // A remounted Host restarts at 1; the client must not treat it as an old notice.
    controller.changed(notice(1))
    await vi.waitFor(() => { expect(wire.board).toHaveBeenCalledTimes(4) })
  })

  it('reports a failed read and keeps the previous view out of a stale response', async () => {
    const wire = scriptedWire()
    const controller = new JiraStore(wire)
    await controller.load()
    wire.board.mockResolvedValueOnce({ ok: false, error: new RemoteError('jira/write-failed', 'read failed', { jiraCode: 'WRITE_FAILED' }) })
    controller.changed(notice(1))
    await vi.waitFor(() => { expect(controller.store.getSnapshot().board.status).toBe('error') })
    expect(controller.store.getSnapshot().board.error).toBe('read failed')
  })
})
