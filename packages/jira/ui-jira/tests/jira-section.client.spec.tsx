// @vitest-environment jsdom
/**
 * The jira settings page: the section it registers, and what it renders from `remote.jira` data.
 *
 * The registration case boots the real plugin against the slot registry and a scripted Remote
 * face; the rendering cases drive the component with a controller over the same scripted face, so
 * a board row, a detail panel and a knowledge hit are asserted as the reader sees them.
 */

import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel, type StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type {
  JiraBoardView,
  JiraChangeEvent,
  JiraIssueDetailView,
  JiraIssueRowView,
  JiraKbSearchView,
  JiraStatusView,
} from '@deepseek-ai/dsh-jira-service/types'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useMemo, useSyncExternalStore } from 'react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { JiraSection, type JiraSectionInjected } from '../src/client/JiraSection.tsx'
import { apply, inject } from '../src/client/index.ts'
import { JiraStore, type JiraWire } from '../src/client/store.ts'

afterEach(cleanup)

/** Copy stub: the cases assert dictionary keys, never localized sentences. */
const t = (key: string): string => key

/** Copy stub that keeps one template's placeholders, to assert the filled `file:line`. */
const locationCopy = (key: string): string => key === 'kbLocation' ? '{file}:{line}' : key

/**
 * The inject face a registration stored, read back through the slot's type-erased seat.
 *
 * The registry keeps the face as a plain record (`inject()` is typed against the slot's declared
 * params, not the registrant's), so the members this spec drives are checked before use instead of
 * being asserted.
 * @param entry - the settings section entry the plugin registered.
 * @returns the jira section's inject face.
 * @throws {Error} when the entry carries no face or an unexpected one.
 */
function isJiraSectionInjected(face: unknown): face is JiraSectionInjected {
  if (typeof face !== 'object' || face === null) return false
  const record = face as Record<string, unknown>
  const hooks = record['hooks']
  const controller = record['controller']
  return hooks !== null && typeof hooks === 'object'
    && controller !== null && typeof controller === 'object'
    && typeof record['t'] === 'function'
    && typeof record['activate'] === 'function'
}

function injectFaceOf(entry: StoredEntry | undefined): JiraSectionInjected {
  const face = entry?.inject?.()
  if (!isJiraSectionInjected(face)) {
    throw new Error('expected the jira settings section to inject its page face')
  }
  return face
}

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
  summary: 'wire proof',
  tags: [],
  updatedAt: '2026-10-15T12:00:00Z',
  revision: 1,
  blocked: false,
}

const BOARD: JiraBoardView = {
  items: [ROW],
  groups: [{ name: 'DH · todo', kind: 'status', project: 'DH', status: 'todo', items: [ROW] }],
  counts: { matched: 1, returned: 1, remaining: 0, byStatus: { todo: 1 }, blocked: 0 },
  truncated: false,
  limit: 20,
}

const ISSUE: JiraIssueDetailView = {
  key: 'DH-1',
  project: 'DH',
  issueType: 'task',
  status: 'todo',
  summary: 'wire proof',
  priority: 'S3',
  tags: [],
  links: [],
  revision: 1,
  createdAt: '2026-10-15T12:00:00Z',
  updatedAt: '2026-10-15T12:00:00Z',
  reporter: 'human:fixture',
  kbRefs: ['KB-1'],
  conflicted: false,
  body: 'The body a detail view renders.',
}

const KB: JiraKbSearchView = {
  hits: [{
    key: 'KB-1',
    title: 'Ledger boot notes',
    domain: 'notes',
    kbType: 'concept',
    file: 'knowledge/notes/KB-1.md',
    line: 5,
    snippet: 'The ledger opens when the host boots.',
    titleMatch: true,
    matches: 1,
    capturedAt: '2026-10-15T12:00:00Z',
  }],
  matched: 1,
  truncated: false,
  topK: 10,
}

/** A Remote face answering the fixtures, with per-case overrides. */
function wire(overrides: Partial<JiraWire> = {}): JiraWire {
  return {
    status: vi.fn(async () => ({ ok: true as const, value: STATUS })),
    board: vi.fn(async () => ({ ok: true as const, value: BOARD })),
    get: vi.fn(async () => ({ ok: true as const, value: ISSUE })),
    kbSearch: vi.fn(async () => ({ ok: true as const, value: KB })),
    ...overrides,
  }
}

/**
 * Render the page against a real controller.
 *
 * The render machinery normally binds `useSnapshot` from the inject `hooks` compartment; this
 * harness does the same with a render-time subscription, so a store update re-renders the page
 * exactly as the registered slot would.
 * @param remote - the scripted Remote face.
 * @param copy - the page's copy stub.
 * @returns the controller the page reads.
 */
function mountPage(remote: JiraWire, copy: (key: string) => string = t): JiraStore {
  const store = new JiraStore(remote)
  function Harness() {
    const subscribe = useMemo(() => (listener: () => void) => store.store.subscribe(listener), [])
    const useSnapshot = useMemo(
      () => <T,>(selector: (snapshot: ReturnType<typeof store.store.getSnapshot>) => T): T =>
        selector(useSyncExternalStore(subscribe, () => store.store.getSnapshot())),
      [subscribe],
    )
    return (
      <JiraSection
        controller={store}
        activate={() => { void store.load() }}
        useSnapshot={useSnapshot}
        t={copy}
      />
    )
  }
  render(<Harness />)
  return store
}

it('registers the jira settings section and withdraws it with the fiber', async () => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  // The scripted namespace is already mounted, so the plugin leaves the carrier alone.
  new TestRemote(ctx, { jira: wire() })
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({ name: 'root', children: { 'settings.section': { kind: 'list', scope: 'root' } } } as never, () => null)

  const fiber = await ctx.plugin({ inject: [...inject], apply }).await()

  const entries = slots.entries('settings.section')
  // Exactly one: a second registration of the same section id would render twice in settings.
  expect(entries).toHaveLength(1)
  const [entry] = entries
  expect(entry?.options.id).toBe('jira')
  expect(entry?.options.order).toBe(200)
  expect(entry?.component).toBe(JiraSection)
  expect(resolveSlotLabel(entry?.options.label)).toBe('Jira')
  const injected = injectFaceOf(entry)
  expect(injected.t('title')).toBe('Jira 台账')
  expect(injected.hooks.snapshot.getSnapshot().board.status).toBe('idle')

  await fiber.dispose()
  expect(slots.entries('settings.section')).toEqual([])
})

it('follows the Host change stream while open, and stops when the page goes away (DH-307)', async () => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)

  // The scripted change stream: the spec pushes a notice and the plugin's subscription sees it.
  const queue: JiraChangeEvent[] = []
  let wake: (() => void) | undefined
  const watch = (signal: AbortSignal): AsyncIterable<JiraChangeEvent> => ({
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (signal.aborted) return
        const next = queue.shift()
        if (next !== undefined) {
          yield next
          continue
        }
        await new Promise<void>((resolve) => {
          wake = resolve
          signal.addEventListener('abort', () => { resolve() }, { once: true })
        })
      }
    },
  })
  const push = (version: number): void => {
    queue.push({ version, kind: 'write', key: 'DH-1', at: '2026-10-15T12:00:00Z' as JiraChangeEvent['at'] })
    wake?.()
    wake = undefined
  }

  const scripted = wire()
  // The scripted namespace is mounted, so the plugin never reaches the carrier's `$mount`.
  new TestRemote(ctx, { jira: { ...scripted, watch } })
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({ name: 'root', children: { 'settings.section': { kind: 'list', scope: 'root' } } } as never, () => null)
  const fiber = await ctx.plugin({ inject: [...inject], apply }).await()
  const injected = injectFaceOf(slots.entries('settings.section')[0])

  // A page that was never opened holds no snapshot: the live stream alone reads nothing.
  push(1)
  await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
  expect(scripted.board).not.toHaveBeenCalled()

  injected.activate()
  await waitFor(() => { expect(scripted.board).toHaveBeenCalledTimes(1) })
  push(2)
  await waitFor(() => { expect(scripted.board).toHaveBeenCalledTimes(2) })
  ctx.emit('connection/reset')
  await waitFor(() => { expect(scripted.board).toHaveBeenCalledTimes(3) })

  // The subscription belongs to the plugin fiber; after disposal a late notice reads nothing.
  await fiber.dispose()
  push(3)
  await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
  expect(scripted.board).toHaveBeenCalledTimes(3)
})

it('renders the ledger status and the board the host answered', async () => {
  mountPage(wire())

  await waitFor(() => { expect(screen.getByText('DH-1')).toBeDefined() })
  // The row, its column and the metadata line a reader scans for.
  expect(screen.getByText('wire proof')).toBeDefined()
  expect(screen.getByText('DH · todo')).toBeDefined()
  expect(screen.getByText('S3 · unassigned')).toBeDefined()
  // The status block reports the effective row configuration.
  expect(screen.getByText('fieldRoot')).toBeDefined()
  expect(screen.getByText('/srv/ledger')).toBeDefined()
  expect(screen.getByText('fixture-host')).toBeDefined()
  expect(screen.getByText('lastSyncNever')).toBeDefined()
})

it('opens one issue detail from the board and closes it', async () => {
  const get = vi.fn(async () => ({ ok: true as const, value: ISSUE }))
  mountPage(wire({ get }))

  fireEvent.click(await screen.findByRole('button', { name: /DH-1/u }))
  expect(get).toHaveBeenCalledWith('DH-1')
  await waitFor(() => { expect(screen.getByText('The body a detail view renders.')).toBeDefined() })
  expect(screen.getByText('detailStatus')).toBeDefined()
  expect(screen.getByText('human:fixture')).toBeDefined()
  expect(screen.getByText('KB-1')).toBeDefined()

  fireEvent.click(screen.getByRole('button', { name: 'detailClose' }))
  await waitFor(() => { expect(screen.queryByText('The body a detail view renders.')).toBeNull() })
})

it('searches the knowledge base and shows each hit with its file:line', async () => {
  const kbSearch = vi.fn(async () => ({ ok: true as const, value: KB }))
  mountPage(wire({ kbSearch }), locationCopy)

  const input = await screen.findByRole('textbox', { name: 'kbPlaceholder' })
  fireEvent.change(input, { target: { value: 'ledger' } })
  fireEvent.click(screen.getByRole('button', { name: 'kbAction' }))

  await waitFor(() => { expect(kbSearch).toHaveBeenCalledWith('ledger') })
  await waitFor(() => { expect(screen.getByText('knowledge/notes/KB-1.md:5')).toBeDefined() })
  expect(screen.getByText('Ledger boot notes')).toBeDefined()
  expect(screen.getByText('The ledger opens when the host boots.')).toBeDefined()
  expect(screen.getByText('kbMatched')).toBeDefined()
})

it('reports a failed board read and retries it', async () => {
  const failed = vi.fn(async () => ({
    ok: false as const,
    error: new RemoteError('jira/write-failed', 'the ledger could not be read', { jiraCode: 'WRITE_FAILED' }),
  }))
  const remote = wire({ board: failed })
  mountPage(remote)

  await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('boardFailed') })

  remote.board = vi.fn(async () => ({ ok: true as const, value: BOARD }))
  fireEvent.click(screen.getByRole('button', { name: 'retry' }))
  await waitFor(() => { expect(screen.getByText('DH-1')).toBeDefined() })
})
