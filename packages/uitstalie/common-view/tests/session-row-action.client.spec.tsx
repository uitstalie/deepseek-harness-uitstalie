// @vitest-environment jsdom
/**
 * The adopted view's two contributions render as ordinary session-row action
 * items: an accessible name from the row's owner share and the overlay's accent
 * carried inline as a component-local custom property.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { MarkerButton } from '../src/client/views/session-row-action/MarkerButton.tsx'
import { TintedArchiveButton } from '../src/client/views/session-row-action/TintedArchiveButton.tsx'
import type { CommonViewKey } from '../src/client/locales.ts'

// This config does not enable vitest globals, so the DOM is torn down per case.
afterEach(cleanup)

/** A row's Session identity. */
const sid = (id: string) => id as SessionId

/** Copy stub: assertions read keys and parameters instead of localized sentences. */
function t(key: CommonViewKey, params?: Record<string, string>): string {
  return params === undefined ? key : `${key}:${params['name'] ?? ''}`
}

/** The accent the overlay paints with in these cases. */
const ACCENT = 'var(--dsw-alias-state-error-primary)'

describe('common-view session-row-action items', () => {
  it('names the marker after the row it belongs to and carries the accent inline', () => {
    render(<MarkerButton sessionId={sid('session-1')} displayTitle="alpha" t={t} accent={ACCENT} />)
    const marker = screen.getByRole('button', { name: 'marker.aria:alpha' })
    expect(marker.style.getPropertyValue('--dsh-common-view-accent')).toBe(ACCENT)
  })

  it('lets the takeover item name itself for the row it replaces archive on', () => {
    render(<TintedArchiveButton sessionId={sid('session-1')} displayTitle="beta" t={t} accent={ACCENT} />)
    const takeover = screen.getByRole('button', { name: 'takeover.aria:beta' })
    expect(takeover.style.getPropertyValue('--dsh-common-view-accent')).toBe(ACCENT)
  })
})
