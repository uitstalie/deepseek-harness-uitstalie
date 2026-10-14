// @vitest-environment jsdom
/**
 * The queue dock counts the queued messages over a list that expands in place,
 * under the shell's own panel: a 36px header row and 36px message rows split by
 * a hairline.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueueDock } from '../src/client/views/scaffold/QueueDock.tsx'
import { cssRule, QUEUE_CSS } from './css-rule.client.ts'
import type { CommonViewKey } from '../src/client/locales.ts'

// This config does not enable vitest globals, so the DOM is torn down per case.
afterEach(cleanup)

/** Copy stub: assertions read keys instead of localized sentences. */
function t(key: CommonViewKey): string {
  return key
}

const QUEUED = ['first queued', 'second queued']

describe('composer queue dock', () => {
  it('renders nothing while the queue is empty', () => {
    const { container } = render(<QueueDock t={t} queued={[]} />)
    expect(container.querySelectorAll('[class*="dock"]')).toHaveLength(0)
  })

  it('counts the queue and expands its list in place', () => {
    render(<QueueDock t={t} queued={QUEUED} />)
    const header = screen.getByRole('button', { name: /scaffold\.queueCount/ })
    expect(header.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('first queued')).toBeDefined()
    expect(screen.getByText('second queued')).toBeDefined()
    // Collapsing keeps the header and hides the list.
    fireEvent.click(header)
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('first queued')).toBeNull()
    expect(screen.getByRole('button', { name: /scaffold\.queueCount/ })).toBeDefined()
  })

  it('keeps the shell\'s dock, panel, header, and row measurements', () => {
    // The dock's width subtracts both clearances and both dock insets.
    const dock = cssRule(QUEUE_CSS, '.dock')
    expect(dock).toContain('max-width: calc(')
    expect(dock).toContain('var(--dsh-composer-card-max-width)')
    expect(dock).toContain('margin: 0 auto calc(0px - var(--dsh-composer-stack-gap) - 3px)')
    expect(dock).toContain('padding: 0 var(--dsh-composer-dock-inset)')
    // The panel squares its bottom and paints the menu material plus its stroke.
    const panel = cssRule(QUEUE_CSS, '.panel')
    expect(panel).toContain('padding: 2px 0')
    expect(panel).toContain('border-radius: var(--dsw-radius-lg) var(--dsw-radius-lg) 0 0')
    expect(cssRule(QUEUE_CSS, '.panel::before')).toContain('background: var(--dsw-specific-menu)')
    expect(cssRule(QUEUE_CSS, '.panel::after')).toContain('border: 0.5px solid var(--dsw-alias-border-l1)')
    expect(cssRule(QUEUE_CSS, '.panel::after')).toContain('border-bottom: none')
    // Header and rows.
    const header = cssRule(QUEUE_CSS, '.header')
    expect(header).toContain('gap: 10px')
    expect(header).toContain('height: 36px')
    expect(header).toContain('padding: 4px 12px')
    expect(cssRule(QUEUE_CSS, '.count')).toContain('font-size: 13px')
    expect(cssRule(QUEUE_CSS, '.chevron')).toContain('width: 14px')
    expect(cssRule(QUEUE_CSS, '.list')).toContain('max-height: 180px')
    const row = cssRule(QUEUE_CSS, '.row')
    expect(row).toContain('min-height: 36px')
    expect(row).toContain('padding: 4px 5px 4px 12px')
    expect(cssRule(QUEUE_CSS, '.row + .row')).toContain('box-shadow: inset 0 1px 0 var(--dsw-alias-border-l1)')
  })
})
