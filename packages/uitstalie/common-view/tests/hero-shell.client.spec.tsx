// @vitest-environment jsdom
/**
 * The blank Session's hero draws the shell's own chrome: a centred mark and
 * headline with their preview badge, and the workspace chip, which shows a
 * placeholder state without a workspace.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { HeroShell, WorkspaceChip } from '../src/client/views/scaffold/HeroShell.tsx'
import { cssRule, HERO_CSS } from './css-rule.client.ts'
import type { CommonViewKey } from '../src/client/locales.ts'

// This config does not enable vitest globals, so the DOM is torn down per case.
afterEach(cleanup)

/** Copy stub: assertions read keys instead of localized sentences. */
function t(key: CommonViewKey): string {
  return key
}

describe('blank session hero', () => {
  it('renders the headline with its preview badge', () => {
    render(<HeroShell t={t} />)
    expect(screen.getByText('scaffold.heroHeadline')).toBeDefined()
    expect(screen.getByText('scaffold.heroPreview')).toBeDefined()
  })

  it('labels the workspace chip with the workspace, or asks for one', () => {
    const { unmount } = render(<WorkspaceChip t={t} label="deepseek-harness-uitstalie-dev" />)
    expect(screen.getByRole('button', { name: 'scaffold.chooseWorkspace' })).toBeDefined()
    expect(screen.getByText('deepseek-harness-uitstalie-dev')).toBeDefined()
    unmount()
    // Without a label the chip carries the shell's call to action as its text.
    render(<WorkspaceChip t={t} />)
    expect(screen.getByText('scaffold.chooseWorkspace')).toBeDefined()
  })

  it('keeps the shell\'s hero measurements', () => {
    const root = cssRule(HERO_CSS, '.root')
    expect(root).toContain('padding: 0 24px')
    expect(root).toContain('height: 100%')
    const stack = cssRule(HERO_CSS, '.stack')
    expect(stack).toContain('gap: 12px')
    expect(stack).toContain('max-width: var(--dsh-composer-card-max-width)')
    // Headline: 26/32 at weight 500, wrapping with a 10px column gap.
    const headline = cssRule(HERO_CSS, '.headline')
    expect(headline).toContain('font-size: 26px')
    expect(headline).toContain('line-height: 32px')
    expect(headline).toContain('font-weight: 500')
    expect(headline).toContain('column-gap: 10px')
    expect(headline).toContain('row-gap: 12px')
    // Badge: a 999px mono pill, one radius step past the ink hairline.
    const badge = cssRule(HERO_CSS, '.previewBadge')
    expect(badge).toContain('padding: 1px 7px 0')
    expect(badge).toContain('corner-shape: round')
    expect(badge).toContain('font-family: var(--ds-font-family-code)')
    expect(badge).toContain('font-size: 12px')
    // Chip: 28px floor, 8px sides, small radius, 13/20 at weight 500.
    const chip = cssRule(HERO_CSS, '.workspace')
    expect(chip).toContain('gap: 4px')
    expect(chip).toContain('max-width: min(100%, 360px)')
    expect(chip).toContain('min-height: 28px')
    expect(chip).toContain('padding: 0 8px')
    expect(chip).toContain('border-radius: var(--dsw-radius-sm)')
    expect(chip).toContain('font-size: 13px')
    expect(chip).toContain('font-weight: 500')
    expect(cssRule(HERO_CSS, '.chevron')).toContain('color: var(--dsw-alias-label-caption)')
  })
})
