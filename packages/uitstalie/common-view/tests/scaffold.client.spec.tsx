// @vitest-environment jsdom
/**
 * The frame scaffold renders the parent view's big layout as our own
 * composition: three named regions, both measurements carried inline from the
 * config, and the separators drawn by the divider atom.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { AppScaffold } from '../src/client/views/scaffold/AppScaffold.tsx'
import type { CommonViewKey } from '../src/client/locales.ts'

// This config does not enable vitest globals, so the DOM is torn down per case.
afterEach(cleanup)

/** Copy stub: assertions read keys instead of localized sentences. */
function t(key: CommonViewKey): string {
  return key
}

describe('frame scaffold', () => {
  it('names all three regions of the parent layout', () => {
    render(<AppScaffold t={t} sidebarWidth="320px" topHeight="52px" />)
    expect(screen.getByText('scaffold.sidebar')).toBeDefined()
    expect(screen.getByText('scaffold.top')).toBeDefined()
    expect(screen.getByText('scaffold.content')).toBeDefined()
  })

  it('carries both measurements as component-local custom properties', () => {
    render(<AppScaffold t={t} sidebarWidth="320px" topHeight="52px" />)
    const sidebar = screen.getByText('scaffold.sidebar').closest('div') as HTMLElement
    const top = screen.getByText('scaffold.top').closest('div') as HTMLElement
    expect(sidebar?.style.getPropertyValue('--dsh-common-view-scaffold-sidebar')).toBe('320px')
    expect(top?.style.getPropertyValue('--dsh-common-view-scaffold-top')).toBe('52px')
  })

  it('separates the regions with the divider atom', () => {
    render(<AppScaffold t={t} sidebarWidth="320px" topHeight="52px" />)
    const separators = screen.getAllByRole('separator')
    expect(separators.map(leaf => leaf.getAttribute('aria-orientation'))).toEqual(['vertical', 'horizontal'])
  })
})
