// @vitest-environment jsdom
/**
 * The chat transcript draws the shell's own frame: a centred column capped at
 * the shared content width, rows 6px apart with 12px around a response, and the
 * user's message on the trailing edge in the bubble.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ChatTranscript, type TranscriptMessage } from '../src/client/views/scaffold/ChatTranscript.tsx'
import { cssRule, CHAT_CSS } from './css-rule.client.ts'

// This config does not enable vitest globals, so the DOM is torn down per case.
afterEach(cleanup)

const MESSAGES: readonly TranscriptMessage[] = [
  { id: 'm-1', role: 'user', text: 'first question' },
  { id: 'm-2', role: 'assistant', text: 'the answer' },
  { id: 'm-3', role: 'user', text: 'follow up' },
]

describe('chat transcript', () => {
  it('draws every row, marking responses as their own flow part', () => {
    const { container } = render(<ChatTranscript messages={MESSAGES} />)
    for (const message of MESSAGES) expect(screen.getByText(message.text)).toBeDefined()
    const parts = [...container.querySelectorAll('[data-chat-group-part]')]
    expect(parts).toHaveLength(1)
    expect(parts[0]?.textContent).toContain('the answer')
    // The user's rows are the only ones that carry the bubble.
    expect(container.querySelectorAll('[class*="bubble"]')).toHaveLength(2)
    expect(container.querySelectorAll('[class*="userRow"]')).toHaveLength(2)
  })

  it('keeps the shell\'s transcript and bubble measurements', () => {
    const scroll = cssRule(CHAT_CSS, '.scroll')
    expect(scroll).toContain('overflow-y: auto')
    expect(scroll).toContain('padding: 16px calc(var(--dsh-composer-side-clearance) + 16px)')
    expect(scroll).toContain('container-type: inline-size')
    const column = cssRule(CHAT_CSS, '.column')
    expect(column).toContain('max-width: var(--dsh-chat-content-width)')
    expect(column).toContain('margin: 0 auto')
    // Rows sit 6px apart; a response raises the gap to 12px both ways.
    expect(cssRule(CHAT_CSS, '.column > .flowItem ~ .flowItem')).toContain('margin-top: var(--dsh-chat-flow-gap, 6px)')
    expect(cssRule(CHAT_CSS, '.flowItemResponse')).toContain('--dsh-chat-flow-gap: 12px')
    // The user's stack and bubble.
    const stack = cssRule(CHAT_CSS, '.userStack')
    expect(stack).toContain('gap: 8px')
    expect(stack).toContain('max-width: min(calc(var(--dsh-chat-content-width, 748px) * 0.702), 82%)')
    const bubble = cssRule(CHAT_CSS, '.bubble')
    expect(bubble).toContain('background: var(--dsw-specific-bubble)')
    expect(bubble).toContain('border-radius: var(--dsw-radius-xl)')
    expect(bubble).toContain('padding: 10px 16px')
    expect(bubble).toContain('line-height: calc(22px + var(--dsh-content-font-delta, 0px))')
    expect(bubble).toContain('word-break: break-word')
    expect(cssRule(CHAT_CSS, '.userRow')).toContain('align-items: flex-end')
  })
})
