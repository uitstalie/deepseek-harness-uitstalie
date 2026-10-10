// @vitest-environment jsdom
/**
 * The frame scaffold renders the parent view's big layout as our own
 * composition: three named regions, both measurements carried inline from the
 * config, and the separators drawn by the divider atom.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AppScaffold } from '../src/client/views/scaffold/AppScaffold.tsx'
import type { CommonViewKey } from '../src/client/locales.ts'

// This config does not enable vitest globals, so the DOM is torn down per case.
afterEach(cleanup)

/** Copy stub: assertions read keys instead of localized sentences. */
function t(key: CommonViewKey): string {
  return key
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
