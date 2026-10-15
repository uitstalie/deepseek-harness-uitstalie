/**
 * The models.dev settings page follows the settings house pattern: a 720px
 * column led by the 16/24 primary title and the 14/22 tertiary intro, radius and
 * type tokens instead of literals, and no scroller of its own (the settings
 * panel's content column already scrolls).
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const CSS = 'packages/uitstalie/ui-models-dev/src/client/ModelsDevSection.module.css'

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

describe('models.dev section house pattern', () => {
  it('leads with the settings title and intro at the sibling section width', () => {
    const section = cssRule('.section')
    expect(section).toContain('max-width: 720px')
    expect(section).toContain('gap: 12px')
    const title = cssRule('.title')
    expect(title).toContain('font-size: 16px')
    expect(title).toContain('line-height: 24px')
    expect(title).toContain('font-weight: 500')
    expect(title).toContain('color: var(--dsw-alias-label-primary)')
    const intro = cssRule('.intro')
    expect(intro).toContain('font-size: 14px')
    expect(intro).toContain('line-height: 22px')
    expect(intro).toContain('color: var(--dsw-alias-label-tertiary)')
  })

  it('scrolls in the panel, not inside the page', () => {
    const list = cssRule('.list')
    expect(list).not.toContain('overflow-y')
    expect(list).not.toContain('max-height')
    // A bounded list inside a card keeps its own 320px cap, as the sibling does.
    expect(cssRule('.modelList')).toContain('max-height: 320px')
  })

  it('uses radius, type, and state tokens instead of literals', () => {
    expect(cssRule('.rowCard')).toContain('border-radius: var(--dsw-radius-md)')
    expect(cssRule('.oauthPanel')).toContain('border-radius: var(--dsw-radius-md)')
    for (const selector of ['.input', '.textarea', '.modelList']) {
      expect(cssRule(selector)).toContain('border-radius: var(--dsw-radius-sm)')
    }
    expect(cssRule('.rowMeta')).toContain('font: var(--dsw-font-xxs-12)')
    expect(cssRule('.fieldLabel')).toContain('font: var(--dsw-font-xxs-12)')
    expect(cssRule('.textarea')).toContain('font-family: var(--ds-font-family-code)')
    expect(cssRule('.deviceCode')).toContain('font-weight: 500')
    // The three state inks must be tokens that exist, with no literal fallback.
    expect(cssRule('.errorText')).toBe('color: var(--dsw-alias-state-error-primary);')
    expect(cssRule('.okText')).toBe('color: var(--dsw-alias-state-success-primary);')
    expect(cssRule('.noticeLink')).toBe('color: var(--dsw-alias-state-business-primary); word-break: break-all;')
    const sheet = readFileSync(CSS, 'utf8')
    expect(/#[0-9a-fA-F]{3,6}/u.test(sheet)).toBe(false)
    expect(sheet).not.toContain('monospace')
  })

  it('draws its actions with the shared button, not a local one', () => {
    const section = readFileSync('packages/uitstalie/ui-models-dev/src/client/ModelsDevSection.tsx', 'utf8')
    const panel = readFileSync('packages/uitstalie/ui-models-dev/src/client/OAuthPanel.tsx', 'utf8')
    const routes = readFileSync('packages/uitstalie/ui-models-dev/src/client/MyRoutes.tsx', 'utf8')
    for (const source of [section, panel, routes]) {
      expect(source).toContain("from '@deepseek-ai/dsh-client-ui-primitives'")
      expect(source).not.toContain('<button')
      expect(source).not.toContain('styles.submitButton')
    }
    // The page's own bar for its primary action stays; the button atom does not.
    expect(cssRule('.submitBar')).toContain('justify-content: flex-end')
    expect(readFileSync(CSS, 'utf8')).not.toContain('.submitButton')
  })
})
