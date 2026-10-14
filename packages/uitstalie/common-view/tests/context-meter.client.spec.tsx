// @vitest-environment jsdom
/**
 * The context meter shows the occupancy as a ring and a percentage, and opens a
 * panel that splits the same occupancy into system prompt, tool definitions, and
 * messages.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ContextMeter, type ContextOccupancy } from '../src/client/views/scaffold/ContextMeter.tsx'
import { cssRule, METER_CSS } from './css-rule.client.ts'
import type { CommonViewKey } from '../src/client/locales.ts'

// This config does not enable vitest globals, so the DOM is torn down per case.
afterEach(cleanup)

/** Copy stub: assertions read keys instead of localized sentences. */
function t(key: CommonViewKey): string {
  return key
}

const OCCUPANCY: ContextOccupancy = {
  percent: 45,
  usedTokens: 132_000,
  contextWindow: 256_000,
  breakdown: { systemTokens: 9_400, toolsTokens: 38_600, messageTokens: 84_000 },
}

describe('context meter', () => {
  it('shows the occupancy as a reading and names itself with the sentence', () => {
    const { container } = render(<ContextMeter t={t} occupancy={OCCUPANCY} />)
    const trigger = screen.getByRole('button', { name: 'scaffold.contextAria' })
    expect(trigger.textContent).toContain('45%')
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog')
    // The ring: a track circle plus the fill arc over the same geometry.
    expect(container.querySelectorAll('circle')).toHaveLength(2)
  })

  it('opens the breakdown panel with its three rows', () => {
    render(<ContextMeter t={t} occupancy={OCCUPANCY} />)
    fireEvent.click(screen.getByRole('button', { name: 'scaffold.contextAria' }))
    expect(screen.getByRole('dialog', { name: 'scaffold.contextUsed' })).toBeDefined()
    for (const label of ['scaffold.contextSystem', 'scaffold.contextTools', 'scaffold.contextMessages']) {
      expect(screen.getByText(label)).toBeDefined()
    }
    // One bar segment per breakdown row, and the panel's used/window figures.
    // The panel portals to the body, so it sits outside the render container.
    expect(document.querySelectorAll('[class*="segment"]')).toHaveLength(3)
    expect(screen.getByText(/^~.* \/ /)).toBeDefined()
  })

  it('keeps the shell\'s meter and panel measurements', () => {
    const trigger = cssRule(METER_CSS, '.trigger')
    expect(trigger).toContain('gap: 6px')
    expect(trigger).toContain('padding: 1px 8px')
    expect(trigger).toContain('border-radius: var(--dsw-radius-sm)')
    expect(trigger).toContain('font-size: var(--dsh-content-font-size-secondary, 13px)')
    expect(trigger).toContain('font-variant-numeric: tabular-nums')
    // Ring: 2px strokes, the track on the border tier and the fill on the label tier.
    expect(cssRule(METER_CSS, '.track')).toContain('stroke: var(--dsw-alias-border-l3)')
    expect(cssRule(METER_CSS, '.fill')).toContain('stroke-linecap: round')
    // Panel: the menu surface on the prominent elevation tier.
    const panel = cssRule(METER_CSS, '.panel')
    expect(panel).toContain('width: min(264px, calc(100vw - 24px))')
    expect(panel).toContain('padding: 12px')
    expect(panel).toContain('border-radius: var(--dsw-radius-lg)')
    expect(panel).toContain('background: var(--dsw-specific-menu)')
    expect(panel).toContain('box-shadow: var(--dsw-elevation-prominent)')
    // Bar and swatches.
    const bar = cssRule(METER_CSS, '.bar')
    expect(bar).toContain('gap: 1px')
    expect(bar).toContain('margin: 10px 0 12px')
    expect(bar).toContain('height: 4px')
    expect(bar).toContain('corner-shape: round')
    expect(cssRule(METER_CSS, '.segment')).toContain('min-width: 2px')
    expect(cssRule(METER_CSS, '.swatch')).toContain('margin-right: 6px')
    expect(cssRule(METER_CSS, '.swatch')).toContain('width: 8px')
    // Tints: two static tokens and the violet the design platform does not ship.
    expect(cssRule(METER_CSS, '.colorSystem')).toContain('--dsw-static-neutral-bluish-400')
    expect(cssRule(METER_CSS, '.colorTools')).toContain('rgb(167, 139, 250)')
    expect(cssRule(METER_CSS, '.colorMessages')).toContain('--dsw-static-blue-450')
  })
})
