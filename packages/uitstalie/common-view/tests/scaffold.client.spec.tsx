// @vitest-environment jsdom
/**
 * The frame scaffold renders the parent view's big layout as our own
 * composition: three named regions, both measurements carried inline from the
 * config, and the separators drawn by the divider atom.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AppScaffold } from '../src/client/views/scaffold/AppScaffold.tsx'
import type { CommonViewKey } from '../src/client/locales.ts'

// This config does not enable vitest globals, so the DOM is torn down per case.
afterEach(cleanup)

/** Copy stub: assertions read keys instead of localized sentences. */
function t(key: CommonViewKey): string {
  return key
}

// jsdom serves modules over http, so the stylesheet is read from the workspace root.
const SCAFFOLD_CSS = readFileSync(
  'packages/uitstalie/common-view/src/client/views/scaffold/AppScaffold.module.css',
  'utf8',
)

/** Declarations of one rule, so the shell's own measurements stay pinned. */
function cssRule(selector: string): string {
  const pattern = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\s*\\{([^}]*)\\}`)
  const body = pattern.exec(SCAFFOLD_CSS)?.[1]
  if (body === undefined) throw new Error(`scaffold stylesheet: ${selector} rule missing`)
  return body.replace(/\s+/gu, ' ')
}

describe('frame scaffold', () => {
  it('names the top and content regions and carries the sidebar chrome', () => {
    const { container } = render(<AppScaffold t={t} sidebarWidth="320px" topHeight="52px" />)
    expect(screen.getByText('scaffold.top')).toBeDefined()
    expect(screen.getByText('scaffold.content')).toBeDefined()
    // The sidebar identifies itself through its chrome rather than a label.
    expect(screen.getByText('scaffold.settings')).toBeDefined()
    expect(screen.getAllByRole('button', { name: 'scaffold.newSession' }).length).toBeGreaterThan(0)
    expect(container.querySelector('[style*="--dsh-common-view-scaffold-sidebar"]')).not.toBeNull()
  })

  it('carries both measurements as component-local custom properties', () => {
    const { container } = render(<AppScaffold t={t} sidebarWidth="320px" topHeight="52px" />)
    const sidebar = container.querySelector('[style*="--dsh-common-view-scaffold-sidebar"]') as HTMLElement
    const top = screen.getByText('scaffold.top').closest('div') as HTMLElement
    expect(sidebar.style.getPropertyValue('--dsh-common-view-scaffold-sidebar')).toBe('320px')
    expect(top.style.getPropertyValue('--dsh-common-view-scaffold-top')).toBe('52px')
  })

  it('separates the regions with the divider atom', () => {
    render(<AppScaffold t={t} sidebarWidth="320px" topHeight="52px" />)
    // The frame draws one vertical and one horizontal divider; the sidebar
    // replica adds one horizontal divider between its groups.
    const separators = screen.getAllByRole('separator')
    expect(separators.map(leaf => leaf.getAttribute('aria-orientation'))).toEqual(['horizontal', 'vertical', 'horizontal'])
  })

  it('carries the button capability in its top strip', () => {
    render(<AppScaffold t={t} sidebarWidth="320px" topHeight="52px" />)
    expect(screen.getByRole('button', { name: 'scaffold.buttonSidebar' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'scaffold.buttonTop' })).toBeDefined()
  })

  it('re-lays the left column out when the default button is activated', () => {
    const { container } = render(<AppScaffold t={t} sidebarWidth="320px" topHeight="52px" />)
    const sidebar = container.querySelector('[style*="--dsh-common-view-scaffold-sidebar"]') as HTMLElement
    expect(sidebar.style.getPropertyValue('--dsh-common-view-scaffold-sidebar')).toBe('320px')
    fireEvent.click(screen.getByRole('button', { name: 'scaffold.buttonSidebar' }))
    expect(sidebar.style.getPropertyValue('--dsh-common-view-scaffold-sidebar')).toBe('160px')
    fireEvent.click(screen.getByRole('button', { name: 'scaffold.buttonSidebar' }))
    expect(sidebar.style.getPropertyValue('--dsh-common-view-scaffold-sidebar')).toBe('320px')
  })

  it('re-lays the top strip out when the derived button is activated', () => {
    render(<AppScaffold t={t} sidebarWidth="320px" topHeight="52px" />)
    const top = screen.getByText('scaffold.top').closest('div') as HTMLElement
    fireEvent.click(screen.getByRole('button', { name: 'scaffold.buttonTop' }))
    expect(top.style.getPropertyValue('--dsh-common-view-scaffold-top')).toBe('28px')
  })
})

describe('scaffold sidebar chrome metrics', () => {
  it('keeps the shell\'s logo-row measurements', () => {
    // ui-sidebar `.logoRow`: a 60px row with an 8/4px pad, an 8px gap, and a 4px foot margin.
    const logoRow = cssRule('.brandRow')
    expect(logoRow).toContain('height: 60px')
    expect(logoRow).toContain('gap: 8px')
    expect(logoRow).toContain('padding: 8px 0 8px 4px')
    expect(logoRow).toContain('margin-bottom: 4px')
    // The shell's local-build name is the 17px, 600-weight variant of the wordmark.
    expect(cssRule('.brandName')).toContain('font-size: 17px')
    expect(cssRule('.brandName')).toContain('font-weight: 600')
    // Its rail control is the shared 28px icon-button box.
    expect(cssRule('.glyph')).toContain('width: 28px')
    expect(cssRule('.glyph')).toContain('height: 28px')
  })

  it('keeps the shell\'s settings-trigger measurements', () => {
    // ui-settings-general `.trigger`: 42px tall, 10/8px pad, md radius, hover fill.
    const trigger = cssRule('.settingsRow')
    expect(trigger).toContain('height: 42px')
    expect(trigger).toContain('padding: 0 10px 0 8px')
    expect(trigger).toContain('border-radius: var(--dsw-radius-md)')
    expect(cssRule('.settingsRow:hover')).toContain('var(--dsw-alias-interactive-bg-hover)')
    expect(cssRule('.settingsLabel')).toContain('line-height: 22px')
  })
})

describe('scaffold session row actions', () => {
  it('carries the shell\'s hover actions, state-flipped and archive-exclusive per row', () => {
    render(<AppScaffold t={t} sidebarWidth="320px" topHeight="52px" />)
    const named = (name: RegExp): number => screen.queryAllByRole('button', { name }).length
    // Four session rows render: one pinned (s-2) and one archived (s-4).
    expect(named(/scaffold\.rowMenu/)).toBe(4)
    // The archive button flips its glyph and label on the archived row.
    expect(named(/scaffold\.menuArchive/)).toBe(3)
    expect(named(/scaffold\.menuUnarchive/)).toBe(1)
    // Pin stays off the archived row, and the pinned row offers unpin.
    expect(named(/scaffold\.menuPin/)).toBe(2)
    expect(named(/scaffold\.menuUnpin/)).toBe(1)
  })

  it('opens the shell\'s session menu with pin, rename, fork, and archive', () => {
    render(<AppScaffold t={t} sidebarWidth="320px" topHeight="52px" />)
    fireEvent.click(screen.getAllByRole('button', { name: /scaffold\.rowMenu/ })[0] as HTMLElement)
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([
      'scaffold.menuPin', 'scaffold.menuRename', 'scaffold.menuFork', 'scaffold.menuArchive',
    ])
  })
})
