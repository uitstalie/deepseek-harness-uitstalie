// @vitest-environment jsdom
/**
 * The generic tool card draws the shell's summary line — leading glyph, title,
// the 2px dot, and the truncating summary — over a disclosure that reveals the
 * call's output through the shared code block.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ToolCard, type ToolCardModel } from '../src/client/views/scaffold/ToolCard.tsx'
import { cssRule, TOOL_CSS } from './css-rule.client.ts'
import type { CommonViewKey } from '../src/client/locales.ts'

// This config does not enable vitest globals, so the DOM is torn down per case.
afterEach(cleanup)

/** Copy stub: assertions read keys instead of localized sentences. */
function t(key: CommonViewKey): string {
  return key
}

const TOOL: ToolCardModel = {
  id: 't-1',
  name: 'grep',
  summary: 'uitstalie- · packages/uitstalie',
  output: 'packages/uitstalie/common-view/src/client/index.ts:12\n',
  lang: 'text',
}

describe('generic tool card', () => {
  it('shows the name and its summary, then reveals the output when expanded', () => {
    render(<ToolCard t={t} tool={TOOL} />)
    const title = screen.getByText('grep')
    expect(screen.getByText(TOOL.summary)).toBeDefined()
    expect(document.querySelector('pre')).toBeNull()
    fireEvent.click(title.closest('button') ?? title)
    expect(document.querySelector('pre')).not.toBeNull()
    // The summary stays with the open row, as the shell keeps it.
    expect(screen.getByText(TOOL.summary)).toBeDefined()
  })

  it('keeps the shell\'s summary-row measurements', () => {
    expect(cssRule(TOOL_CSS, '.root')).toContain('flex-direction: column')
    expect(cssRule(TOOL_CSS, '.leading')).toContain('flex-shrink: 0')
    expect(cssRule(TOOL_CSS, '.title')).toContain('font-weight: 400')
    // The 2px dot between title and summary.
    const sep = cssRule(TOOL_CSS, '.sep')
    expect(sep).toContain('width: 2px')
    expect(sep).toContain('height: 2px')
    expect(sep).toContain('border-radius: 1px')
    expect(sep).toContain('margin: 0 8px')
    expect(sep).toContain('background: var(--dsw-alias-label-caption)')
    // The summary fills the row and truncates on one line at the secondary tier.
    const summary = cssRule(TOOL_CSS, '.summary')
    expect(summary).toContain('flex: 1 1 auto')
    expect(summary).toContain('text-overflow: ellipsis')
    expect(summary).toContain('white-space: nowrap')
    expect(summary).toContain('font-size: var(--dsh-content-font-size-secondary, 13px)')
    expect(summary).toContain('line-height: calc(24px + var(--dsh-content-font-delta, 0px))')
  })
})
