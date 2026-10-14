// @vitest-environment jsdom
/**
 * The middle region's header draws the shell's own chrome: the Session lineage
 * as breadcrumbs whose current crumb is plain text, the view tabs with the
 * selected one marked, and the seats the shell leaves empty.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ContentHeader } from '../src/client/views/scaffold/ContentHeader.tsx'
import { cssRule, CONTENT_HEADER_CSS } from './css-rule.client.ts'
import type { CommonViewKey } from '../src/client/locales.ts'

// This config does not enable vitest globals, so the DOM is torn down per case.
afterEach(cleanup)

/** Copy stub: assertions read keys instead of localized sentences. */
function t(key: CommonViewKey): string {
  return key
}

const BREADCRUMBS = ['parent session', 'subagent session']
const TABS = [{ id: 'chat', label: 'scaffold.tabChat' }, { id: 'trajectory', label: 'scaffold.tabTrajectory' }]

describe('middle region header', () => {
  it('renders the lineage with only its ancestors navigable', () => {
    render(<ContentHeader t={t} breadcrumbs={BREADCRUMBS} tabs={TABS} activeTab="chat" onSelectTab={() => {}} />)
    expect(screen.getByRole('navigation', { name: 'scaffold.sessionHierarchy' })).toBeDefined()
    // The parent is a crumb button; the current Session is plain text.
    expect(screen.getByRole('button', { name: 'parent session' })).toBeDefined()
    expect(screen.queryByRole('button', { name: 'subagent session' })).toBeNull()
    expect(screen.getByText('subagent session')).toBeDefined()
    // One separator: the shell puts a slash before every crumb after the first.
    expect(screen.getAllByText('/')).toHaveLength(1)
  })

  it('marks the selected view tab and reports a selection', () => {
    const onSelectTab = vi.fn()
    render(<ContentHeader t={t} breadcrumbs={BREADCRUMBS} tabs={TABS} activeTab="chat" onSelectTab={onSelectTab} />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map(tab => tab.textContent)).toEqual(['scaffold.tabChat', 'scaffold.tabTrajectory'])
    expect(tabs.map(tab => tab.getAttribute('aria-selected'))).toEqual(['true', 'false'])
    fireEvent.click(tabs[1] as HTMLElement)
    expect(onSelectTab).toHaveBeenCalledWith('trajectory')
  })

  it('hides the tab strip while a single view is registered', () => {
    render(<ContentHeader t={t} breadcrumbs={BREADCRUMBS} tabs={TABS.slice(0, 1)} activeTab="chat" onSelectTab={() => {}} />)
    // The shell shows the strip only from two views up.
    expect(screen.queryByRole('tablist')).toBeNull()
  })

  it('keeps the shell\'s header measurements', () => {
    // ui-conversation `.header`: a 76px grid band with a 10/28/0/20px pad.
    const header = cssRule(CONTENT_HEADER_CSS, '.header')
    expect(header).toContain('min-height: 76px')
    expect(header).toContain('padding: 10px 28px 0 20px')
    expect(header).toContain('border-bottom: 0.5px solid var(--dsw-alias-border-l3)')
    expect(cssRule(CONTENT_HEADER_CSS, '.titleRow')).toContain('min-height: 30px')
    // `.crumb`: 4/8px pad, md radius, tertiary ink, a 220px cap.
    const crumb = cssRule(CONTENT_HEADER_CSS, '.crumb')
    expect(crumb).toContain('padding: 4px 8px')
    expect(crumb).toContain('border-radius: var(--dsw-radius-md)')
    expect(crumb).toContain('max-width: 220px')
    expect(cssRule(CONTENT_HEADER_CSS, '.crumbCurrent')).toContain('font-weight: 500')
    // `.tabs`/`.tab`: a 36px-gap strip of 13/16 labels with a 2px active bar.
    expect(cssRule(CONTENT_HEADER_CSS, '.tabs')).toContain('gap: 36px')
    expect(cssRule(CONTENT_HEADER_CSS, '.tab')).toContain('font-size: 13px')
    expect(cssRule(CONTENT_HEADER_CSS, '.tab::after')).toContain('height: 2px')
    expect(cssRule(CONTENT_HEADER_CSS, '.tabActive::after')).toContain('var(--dsw-alias-state-business-primary)')
  })
})
