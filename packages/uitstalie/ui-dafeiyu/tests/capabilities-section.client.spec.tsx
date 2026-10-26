// @vitest-environment jsdom
/**
 * The capability list: the settings section it registers, and what it renders
 * from `remote.dafeiyu` plus the organizer's settings namespace.
 *
 * The registration case boots the real plugin against the slot registry and a
 * scripted Remote face; the rendering cases drive the component with a
 * controller over the same scripted face, so a state badge, a gate switch and
 * a provider link are asserted as the reader sees them.
 */

import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel, type StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import type { CapabilityStatus } from '@deepseek-ai/dsh-dafeiyu/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useMemo, useSyncExternalStore } from 'react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import {
  CapabilitiesSection, type CapabilitiesSectionInjected,
} from '../src/client/CapabilitiesSection.tsx'
import { apply, inject } from '../src/client/index.ts'
import { CapabilityStore, type CapabilityGate, type CapabilityWire } from '../src/client/store.ts'

afterEach(cleanup)

/** Copy stub: the cases assert dictionary keys, never localized sentences. */
const t = (key: string): string => key

/** Entries the scripted organizer answers, covering every public state. */
const ENTRIES: CapabilityStatus[] = [
  {
    id: 'memory',
    present: true,
    enabled: true,
    state: 'active',
    label: 'Memory',
    description: 'Session summaries',
  },
  {
    id: 'jira',
    present: true,
    enabled: false,
    state: 'disabled',
    label: 'Jira',
    description: 'Workspace issue ledger',
    settings: { sectionId: 'jira', order: 200 },
  },
  {
    id: 'ghost',
    present: false,
    enabled: true,
    state: 'missing',
  },
]

/** A scripted Remote face whose entries the gate mutation may replace. */
function wire(initial: CapabilityStatus[] = ENTRIES): {
  readonly remote: CapabilityWire
  readonly set: (next: CapabilityStatus[]) => void
} {
  let entries = [...initial]
  return {
    remote: { status: async () => ({ ok: true as const, value: entries }) },
    set: (next) => { entries = next },
  }
}

/** The inject face a registration stored, read back through the slot's type-erased seat. */
function isCapabilitiesSectionInjected(face: unknown): face is CapabilitiesSectionInjected {
  if (typeof face !== 'object' || face === null) return false
  const record = face as Record<string, unknown>
  const hooks = record['hooks']
  const controller = record['controller']
  return hooks !== null && typeof hooks === 'object'
    && controller !== null && typeof controller === 'object'
    && typeof record['t'] === 'function'
    && typeof record['activate'] === 'function'
}

function injectFaceOf(entry: StoredEntry | undefined): CapabilitiesSectionInjected {
  const face = entry?.inject?.()
  if (!isCapabilitiesSectionInjected(face)) {
    throw new Error('expected the capability list section to inject its page face')
  }
  return face
}

/** A gate stub recording every mutation. */
function gate(answer: (ops: readonly { op: string; path: readonly string[]; value?: unknown }[]) => boolean = () => true): {
  readonly gate: CapabilityGate
  readonly calls: Array<readonly { op: string; path: readonly string[]; value?: unknown }[]>
} {
  const calls: Array<readonly { op: string; path: readonly string[]; value?: unknown }[]> = []
  return {
    calls,
    gate: {
      mutate: async (ops) => {
        calls.push(ops)
        return answer(ops)
      },
    },
  }
}

/**
 * Render the page over one controller.
 * @param controller - the page controller to drive.
 * @param copy - the page's copy stub.
 * @param openSection - the shell's section switch, when the case exercises it.
 */
function mountPage(
  controller: CapabilityStore,
  copy: (key: string) => string = t,
  openSection?: (id: string) => void,
): void {
  function Harness() {
    const subscribe = useMemo(() => (listener: () => void) => controller.store.subscribe(listener), [])
    const useSnapshot = useMemo(
      () => <T,>(selector: (snapshot: ReturnType<typeof controller.store.getSnapshot>) => T): T =>
        selector(useSyncExternalStore(subscribe, () => controller.store.getSnapshot())),
      [subscribe],
    )
    return (
      <CapabilitiesSection
        controller={controller}
        activate={() => { void controller.load() }}
        useSnapshot={useSnapshot}
        t={copy}
        openSection={openSection}
      />
    )
  }
  render(<Harness />)
}

/** Mount the plugin on a context whose Remote and config forms are scripted. */
async function mountPlugin(remote: CapabilityWire, form: CapabilityGate) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  ctx.provide('configForms', { get: () => form } as never)
  new TestRemote(ctx, { dafeiyu: remote })
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({ name: 'root', children: { 'settings.section': { kind: 'list', scope: 'root' } } } as never, () => null)
  return { ctx, slots }
}

it('registers the capability list section and withdraws it with the fiber', async () => {
  const { ctx, slots } = await mountPlugin(wire().remote, gate().gate)

  const fiber = await ctx.plugin({ inject: [...inject], apply }).await()

  const [entry] = slots.entries('settings.section')
  expect(entry?.options.id).toBe('capabilities')
  expect(entry?.options.order).toBe(150)
  expect(entry?.component).toBe(CapabilitiesSection)
  expect(resolveSlotLabel(entry?.options.label)).toBe('能力')
  const injected = injectFaceOf(entry)
  expect(injected.t('title')).toBe('能力总代')
  expect(injected.hooks.snapshot.getSnapshot().status).toBe('idle')

  await fiber.dispose()
  expect(slots.entries('settings.section')).toEqual([])
})

it('lists every capability with its state and description', async () => {
  mountPage(new CapabilityStore(wire().remote, gate().gate))

  await waitFor(() => { expect(screen.getByText('Memory')).toBeDefined() })
  expect(screen.getByText('Session summaries')).toBeDefined()
  expect(screen.getByText('Jira')).toBeDefined()
  expect(screen.getByText('Workspace issue ledger')).toBeDefined()
  // A provider without a label falls back to its id; a missing one shows the note.
  expect(screen.getByText('ghost')).toBeDefined()
  expect(screen.getByText('missingNote')).toBeDefined()
  // Three switches: two present capabilities, one missing (disabled).
  const switches = screen.getAllByRole('switch')
  expect(switches).toHaveLength(3)
  expect(switches[0]?.getAttribute('aria-checked')).toBe('true')
  expect(switches[1]?.getAttribute('aria-checked')).toBe('false')
  expect(switches[2]?.hasAttribute('disabled')).toBe(true)
})

it('writes the organizer gate and shows the state the host reconciled to', async () => {
  const scripted = wire()
  const scriptedGate = gate((ops) => {
    const value = ops[0]?.value === true
    scripted.set(ENTRIES.map(entry => entry.id === 'jira'
      ? { ...entry, enabled: value, state: value ? 'active' : 'disabled' }
      : entry))
    return true
  })
  mountPage(new CapabilityStore(scripted.remote, scriptedGate.gate))

  const switches = await screen.findAllByRole('switch')
  fireEvent.click(switches[1]!)

  await waitFor(() => {
    expect(scriptedGate.calls).toEqual([[{
      op: 'set',
      path: ['capabilities', 'jira', 'enabled'],
      value: true,
    }]])
  })
  await waitFor(() => { expect(screen.getAllByRole('switch')[1]?.getAttribute('aria-checked')).toBe('true') })
})

it('opens the provider\'s own settings page through the shell', async () => {
  const openSection = vi.fn()
  mountPage(new CapabilityStore(wire().remote, gate().gate), t, openSection)

  fireEvent.click(await screen.findByRole('button', { name: 'openSettings' }))
  expect(openSection).toHaveBeenCalledWith('jira')
})

it('reports a refused switch and leaves the gate untouched', async () => {
  mountPage(new CapabilityStore(wire().remote, gate(() => false).gate))

  const switches = await screen.findAllByRole('switch')
  fireEvent.click(switches[1]!)

  await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('updateRefused') })
  expect(screen.getAllByRole('switch')[1]?.getAttribute('aria-checked')).toBe('false')
})

it('reports a failed list read and retries it', async () => {
  let failing = true
  const remote: CapabilityWire = {
    status: async () => failing
      ? {
        ok: false as const,
        error: new RemoteError('gateway/internal', 'the organizer is not mounted', {}),
      }
      : { ok: true as const, value: ENTRIES },
  }
  mountPage(new CapabilityStore(remote, gate().gate), key => key === 'failed' ? 'failed: {message}' : key)

  await waitFor(() => {
    expect(screen.getByRole('alert').textContent).toContain('the organizer is not mounted')
  })

  failing = false
  fireEvent.click(screen.getByRole('button', { name: 'retry' }))
  await waitFor(() => { expect(screen.getByText('Memory')).toBeDefined() })
})
