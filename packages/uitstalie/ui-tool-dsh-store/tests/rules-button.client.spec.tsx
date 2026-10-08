// @vitest-environment jsdom
/**
 * Rules button behavior: the trigger's accessible name, the listing it loads
 * when opened, reading one rule, and the empty, failed-listing, and
 * failed-read states.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { RulesButton } from '../src/client/RulesButton.tsx'
import type { RulesButtonProps } from '../src/client/RulesButton.tsx'

// This config does not enable vitest globals, so the DOM is torn down per case
// instead of by the testing library's implicit global hook.
afterEach(cleanup)

/** Copy stub: tests assert keys and parameters instead of localized sentences. */
function t(key: string, params?: Record<string, string>): string {
  return params === undefined ? key : `${key}:${params['name'] ?? params['message'] ?? ''}`
}

/** A successful listing result. */
function listing(paths: string[]) {
  return { ok: true as const, value: { root: '.dsh', entries: paths.map(path => ({ path, size: 12 })) } }
}

/**
 * A Remote failure result. It uses a protocol-owned code: the store's own codes
 * are declared in the Host package's `types` face, which this client-face test
 * program does not load, and the panel reads only the message.
 */
function failure(message: string) {
  return { ok: false as const, error: new RemoteError('gateway/internal', message, {}) }
}

/** One props set with working loaders unless a case replaces them. */
function props(overrides: Partial<RulesButtonProps> = {}): RulesButtonProps {
  return {
    workspaceId: 'ws-1',
    label: 'alpha',
    t,
    loadRules: vi.fn(async () => listing(['rules/api.md'])),
    loadRule: vi.fn(async () => ({ ok: true, value: { path: 'rules/api.md', text: 'Document public APIs.' } })),
    ...overrides,
  }
}

describe('RulesButton', () => {
  it('names the icon trigger after the workspace it belongs to', () => {
    render(<RulesButton {...props()} />)
    const trigger = screen.getByRole('button', { name: 'buttonAria:alpha' })
    expect(trigger.textContent).toBe('')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(trigger.querySelector('svg')).not.toBeNull()
  })

  it('loads the workspace rules on open and reads the selected rule', async () => {
    const loadRules = vi.fn(async () => listing(['rules/api.md']))
    const loadRule = vi.fn(async () => ({ ok: true as const, value: { path: 'rules/api.md', text: 'Document public APIs.' } }))
    render(<RulesButton {...props({ loadRules, loadRule })} />)

    fireEvent.click(screen.getByRole('button', { name: 'buttonAria:alpha' }))
    expect(loadRules).toHaveBeenCalledWith('ws-1')
    await waitFor(() => { expect(screen.getByText('rules/api.md')).toBeDefined() })

    fireEvent.click(screen.getByText('rules/api.md'))
    expect(loadRule).toHaveBeenCalledWith('ws-1', 'rules/api.md')
    await waitFor(() => { expect(screen.getByText('Document public APIs.')).toBeDefined() })
  })

  it('shows the empty copy when the workspace has no rules', async () => {
    render(<RulesButton {...props({ loadRules: vi.fn(async () => listing([])) })} />)
    fireEvent.click(screen.getByRole('button', { name: 'buttonAria:alpha' }))
    await waitFor(() => { expect(screen.getByText('empty emptyHint')).toBeDefined() })
  })

  it('reports a failed listing as an alert', async () => {
    render(<RulesButton {...props({ loadRules: vi.fn(async () => failure('host refused')) })} />)
    fireEvent.click(screen.getByRole('button', { name: 'buttonAria:alpha' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('loadFailed:host refused') })
  })

  it('reports a failed rule read inside the open panel', async () => {
    render(<RulesButton {...props({ loadRule: vi.fn(async () => failure('gone')) })} />)
    fireEvent.click(screen.getByRole('button', { name: 'buttonAria:alpha' }))
    await waitFor(() => { expect(screen.getByText('rules/api.md')).toBeDefined() })
    fireEvent.click(screen.getByText('rules/api.md'))
    await waitFor(() => { expect(screen.getByText('ruleFailed:gone')).toBeDefined() })
  })

  it('closes on Escape and on its close control', async () => {
    render(<RulesButton {...props()} />)
    const trigger = screen.getByRole('button', { name: 'buttonAria:alpha' })
    fireEvent.click(trigger)
    const surface = await screen.findByRole('dialog')
    fireEvent.keyDown(surface, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(trigger)
    const reopened = await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: 'close' }))
    expect(reopened.isConnected).toBe(false)
  })
})
