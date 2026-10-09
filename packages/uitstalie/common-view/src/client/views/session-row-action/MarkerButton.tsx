/**
 * The common-view marker: our own item in a native list cell. It paints only
 * itself, through a component-local custom property the overlay sets inline —
 * the one channel a plugin may use to carry a value into component CSS.
 * @module @deepseek-ai/dsh-client-common-view/MarkerButton
 */
import type { CSSProperties } from 'react'
import { Button, IconFlatListOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: pulls the workspace's SlotMap entries into this program.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import css from './MarkerButton.module.css'
import type { CommonViewKey } from '../../locales.ts'

/** Owner share of the session-row action cell. */
export interface MarkerOwnerProps {
  /** Session the row shows. */
  sessionId: SessionId
  /** Row display title, used in the accessible name. */
  displayTitle: string
}

/** Injected share of the marker. */
export interface MarkerInjected {
  /** Localized copy of the `common-view` namespace. */
  t: (key: CommonViewKey, params?: Record<string, string>) => string
  /** Accent the marker paints with (a CSS color value, by default a theme token). */
  accent: string
}

/** Owner share of the session-row action cell plus the injected share. */
export type MarkerButtonProps = MarkerOwnerProps & MarkerInjected

/**
 * Render the marker button.
 * @param props - the row's owner share plus the overlay's copy and accent.
 * @returns the marker button.
 */
export function MarkerButton({ displayTitle, t, accent }: MarkerButtonProps) {
  return (
    <Tooltip label={t('marker.tooltip')} side="bottom" align="end" delayMs={500}>
      <Button
        size="sm"
        className={css.marker}
        aria-label={t('marker.aria', { name: displayTitle })}
        icon={<IconFlatListOutlineRegular />}
        style={{ '--dsh-common-view-accent': accent } as CSSProperties}
      />
    </Tooltip>
  )
}
