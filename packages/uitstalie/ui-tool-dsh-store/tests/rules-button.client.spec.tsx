// @vitest-environment jsdom
/**
 * Rules button behavior: the mark trigger, the rule menu the shared Menu
 * renders, reading one rule in the shared Modal, and the empty and failed paths
 * that answer in the same dialog.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { RulesButton } from '../src/client/RulesButton.tsx'
import type { RulesButtonProps } from '../src/client/RulesButton.tsx'

// This config does not enable vitest globals, so the DOM is torn down per case
// instead of by the testing library's implicit global hook.
afterEach(cleanup)

const CSS = 'packages/uitstalie/ui-tool-dsh-store/src/client/RulesButton.module.css'

/**
 * Declarations of every rule naming a selector, whitespace-normalized.
 * @param selector - exact selector of the rule.
 * @returns each matching rule's declarations, space-separated.
 */
function cssRule(selector: string): string {
  const sheet = readFileSync(CSS, 'utf8')
  const item = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const pattern = new RegExp(`(?:^|,)\\s*${item}\\s*(?:,[^{}]*)?\\{([^}]*)\\}`, 'gmu')
  const bodies = [...sheet.matchAll(pattern)].map(match => (match[1] ?? '').replace(/\s+/gu, ' ').trim())
  if (bodies.length === 0) throw new Error(`${CSS}: no ${selector} rule`)
  return bodies.join(' ')
}

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

/** The mark trigger, addressed by its accessible name. */
function trigger(): HTMLElement {
  return screen.getByRole('button', { name: 'buttonAria:alpha' })
}

describe('RulesButton', () => {
  it('renders a decorative mark named after the workspace it belongs to', () => {
    render(<RulesButton {...props()} />)
    // The copy stub returns keys, so the mark reads as its own key here.
    expect(trigger().textContent).toBe('glyph')
    expect(trigger().querySelector('[aria-hidden="true"]')?.textContent).toBe('glyph')
  })

  it('lists the workspace rules in the shared menu and reads one in the dialog', async () => {
    const loadRules = vi.fn(async () => listing(['rules/api.md', 'rules/style.md']))
    const loadRule = vi.fn(async () => ({ ok: true as const, value: { path: 'rules/api.md', text: 'Document public APIs.' } }))
    render(<RulesButton {...props({ loadRules, loadRule })} />)

    fireEvent.click(trigger())
    expect(loadRules).toHaveBeenCalledWith('ws-1')
    const row = await screen.findByRole('menuitem', { name: 'rules/api.md' })
    expect(screen.getByRole('menuitem', { name: 'rules/style.md' })).toBeDefined()

    fireEvent.click(row)
    expect(loadRule).toHaveBeenCalledWith('ws-1', 'rules/api.md')
    await waitFor(() => { expect(screen.getByText('Document public APIs.')).toBeDefined() })
  })

  it('answers an empty workspace in the dialog instead of an empty menu', async () => {
    render(<RulesButton {...props({ loadRules: vi.fn(async () => listing([])) })} />)
    fireEvent.click(trigger())
    await waitFor(() => { expect(screen.getByText('empty emptyHint')).toBeDefined() })
    expect(screen.queryByRole('menuitem')).toBeNull()
  })

  it('reports a failed listing as an alert in the dialog', async () => {
    render(<RulesButton {...props({ loadRules: vi.fn(async () => failure('host refused')) })} />)
    fireEvent.click(trigger())
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('loadFailed:host refused') })
  })

  it('reports a failed rule read as an alert in the dialog', async () => {
    render(<RulesButton {...props({ loadRule: vi.fn(async () => failure('gone')) })} />)
    fireEvent.click(trigger())
    fireEvent.click(await screen.findByRole('menuitem', { name: 'rules/api.md' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('ruleFailed:gone') })
  })

  it('closes the dialog from its close control', async () => {
    render(<RulesButton {...props()} />)
    fireEvent.click(trigger())
    fireEvent.click(await screen.findByRole('menuitem', { name: 'rules/api.md' }))
    await waitFor(() => { expect(screen.getByText('Document public APIs.')).toBeDefined() })

    // The dialog carries two close affordances (its own chrome and the footer
    // button); the footer one is the one with visible copy.
    fireEvent.click(screen.getByText('close'))
    await waitFor(() => { expect(screen.queryByText('Document public APIs.')).toBeNull() })
  })

  it('reads rule text through the shared code block, notices as plain copy', async () => {
    const { unmount } = render(<RulesButton {...props()} />)
    fireEvent.click(trigger())
    fireEvent.click(await screen.findByRole('menuitem', { name: 'rules/api.md' }))
    await waitFor(() => { expect(document.querySelector('pre')).not.toBeNull() })
    unmount()

    // The empty listing answers as copy, not as a code block.
    render(<RulesButton {...props({ loadRules: vi.fn(async () => listing([])) })} />)
    fireEvent.click(trigger())
    await waitFor(() => { expect(screen.getByText('empty emptyHint')).toBeDefined() })
    expect(document.querySelector('pre')).toBeNull()
  })

  it('takes the row icon-button box and the caption mark step', () => {
    expect(cssRule('.trigger.trigger')).toContain('width: 16px')
    expect(cssRule('.trigger.trigger')).toContain('height: 16px')
    expect(cssRule('.trigger.trigger')).toContain('border-radius: var(--dsw-radius-xs)')
    expect(cssRule('.trigger.trigger')).toContain('color: var(--dsw-alias-label-tertiary)')
    expect(cssRule('.trigger.trigger:hover')).toContain('color: var(--dsw-alias-label-primary)')
    expect(cssRule('.mark')).toContain('font: var(--dsw-font-xxs-12)')
    expect(cssRule('.mark')).toContain('font-weight: 500')
    // The dialog's copy keeps its own tokens; the rule body is not styled here.
    expect(cssRule('.noticeAlert')).toContain('color: var(--dsw-alias-state-error-primary)')
    expect(readFileSync(CSS, 'utf8')).not.toContain('.ruleText')
  })
})
