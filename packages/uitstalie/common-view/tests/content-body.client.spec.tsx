// @vitest-environment jsdom
/**
 * The middle region's body draws the shell's own frame: a scroll body holding
 * the view and a sticky composer seat, whose card carries the draft line, the
 * resting placeholder, and the control row.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ContentBody } from '../src/client/views/scaffold/ContentBody.tsx'
import { cssRule, CONTENT_BODY_CSS } from './css-rule.client.ts'
import type { CommonViewKey } from '../src/client/locales.ts'

// This config does not enable vitest globals, so the DOM is torn down per case.
afterEach(cleanup)

/** Copy stub: assertions read keys instead of localized sentences. */
function t(key: CommonViewKey): string {
  return key
}

describe('middle region body', () => {
  it('holds the view stand-in and the composer card with its placeholder', () => {
    const { container } = render(<ContentBody t={t} />)
    expect(screen.getByText('scaffold.content')).toBeDefined()
    expect(screen.getByText('scaffold.draft')).toBeDefined()
    // One scroll region, one composer seat: the shell's two structural boxes.
    expect(container.querySelectorAll('[class*="scrollBody"]')).toHaveLength(1)
    expect(container.querySelectorAll('[class*="composerSeat"]')).toHaveLength(1)
    expect(container.querySelectorAll('[class*="composerCard"]')).toHaveLength(1)
  })

  it('keeps the shell\'s scroll-body and composer-seat measurements', () => {
    const scrollBody = cssRule(CONTENT_BODY_CSS, '.scrollBody')
    expect(scrollBody).toContain('margin-right: 2px')
    expect(scrollBody).toContain('overflow-y: auto')
    expect(scrollBody).toContain('scrollbar-gutter: stable')
    const seat = cssRule(CONTENT_BODY_CSS, '.composerSeat')
    expect(seat).toContain('position: sticky')
    expect(seat).toContain('bottom: 0')
    expect(seat).toContain('--dsh-composer-text-max-height: 336px')
    // The shared width axis: card cap = content width + 32px, sides at 16px.
    const body = cssRule(CONTENT_BODY_CSS, '.body')
    expect(body).toContain('--dsh-composer-card-max-width: calc(var(--dsh-chat-content-width) + 32px)')
    expect(body).toContain('--dsh-composer-side-clearance: 16px')
    expect(body).toContain('clamp(680px, calc(var(--dsh-conversation-column-width, 0px) * 0.64), 920px)')
  })

  it('keeps the shell\'s composer card and input-line measurements', () => {    const card = cssRule(CONTENT_BODY_CSS, '.composerCard')
    expect(card).toContain('padding-top: 8px')
    expect(card).toContain('gap: 12px')
    expect(card).toContain('max-width: var(--dsh-composer-card-max-width)')
    expect(card).toContain('border-radius: var(--dsw-radius-panel)')
    expect(card).toContain('background: var(--dsw-specific-input-major)')
    expect(card).toContain('box-shadow: var(--dsw-elevation-soft)')
    expect(card).toContain('line-height: calc(24px + var(--dsh-content-font-delta, 0px))')
    const input = cssRule(CONTENT_BODY_CSS, '.composerInput')
    expect(input).toContain('min-height: 36px')
    expect(input).toContain('padding: 4px 8px 0 14px')
    expect(input).toContain('caret-color: var(--dsw-alias-state-business-primary)')
    const placeholder = cssRule(CONTENT_BODY_CSS, '.composerPlaceholder')
    expect(placeholder).toContain('inset: 4px 8px auto 14px')
    expect(placeholder).toContain('color: var(--dsw-alias-label-caption)')
    expect(placeholder).toContain('text-overflow: ellipsis')
    expect(cssRule(CONTENT_BODY_CSS, '.composerRow')).toContain('padding: 2px 8px 6px')
  })

  it('carries the attach control, the empty seats, and the send circle', () => {
    const { container } = render(<ContentBody t={t} />)
    expect(screen.getByRole('button', { name: 'scaffold.attach' })).toBeDefined()
    const send = screen.getByRole('button', { name: 'scaffold.send' })
    // The stand-in draft is empty, which is the state the shell disables it in.
    expect(send.hasAttribute('disabled')).toBe(true)
    // The mode, standard, and activity seats are present but unoccupied.
    for (const seat of ['composerModes', 'composerStandard', 'composerActivity']) {
      const found = container.querySelectorAll(`[class*="${seat}"]`)
      expect(found).toHaveLength(1)
      expect(found[0]?.textContent).toBe('')
    }
  })

  it('keeps the shell\'s control-row and button measurements', () => {
    const tools = cssRule(CONTENT_BODY_CSS, '.composerTools')
    expect(tools).toContain('gap: 12px')
    const trailing = cssRule(CONTENT_BODY_CSS, '.composerTrailing')
    expect(trailing).toContain('margin-left: auto')
    expect(trailing).toContain('gap: 12px')
    // Attach circle: 28px on the selector fill.
    const attach = cssRule(CONTENT_BODY_CSS, '.composerAttach')
    expect(attach).toContain('width: 28px')
    expect(attach).toContain('height: 28px')
    expect(attach).toContain('background: var(--dsw-specific-selector)')
    expect(attach).toContain('corner-shape: round')
    // Send circle: 34px, lifted 2px, dimmed while disabled.
    const primary = cssRule(CONTENT_BODY_CSS, '.composerPrimary')
    expect(primary).toContain('width: 34px')
    expect(primary).toContain('height: 34px')
    expect(primary).toContain('background: var(--dsw-alias-button-info-fill)')
    expect(primary).toContain('transform: translateY(-2px)')
    expect(cssRule(CONTENT_BODY_CSS, '.composerPrimary:disabled')).toContain('opacity: 0.4')
  })
})
