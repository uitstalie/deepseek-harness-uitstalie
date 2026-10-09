/**
 * The takeover sample: the same cell's `archive` item, rendered by us at a
 * lower priority. The native registration stays live, so withdrawing ours
 * restores it — the overlay-disable semantics of a resource overlay.
 * @module @deepseek-ai/dsh-client-common-view/TintedArchiveButton
 */
import type { CSSProperties } from 'react'
import { Button, IconArchiveCheckOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: pulls the workspace's SlotMap entries into this program.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import css from './TintedArchiveButton.module.css'
import type { CommonViewKey } from '../../locales.ts'

/** Owner share of the session-row action cell. */
export interface TintedArchiveOwnerProps {
  /** Session the row shows. */
  sessionId: SessionId
  /** Row display title, used in the accessible name. */
  displayTitle: string
}

/** Injected share of the takeover. */
export interface TintedArchiveInjected {
  /** Localized copy of the `common-view` namespace. */
  t: (key: CommonViewKey, params?: Record<string, string>) => string
  /** Accent the takeover paints with. */
  accent: string
}

/** Owner share of the session-row action cell plus the injected share. */
export type TintedArchiveButtonProps = TintedArchiveOwnerProps & TintedArchiveInjected

/**
 * Render the takeover button.
 * @param props - the row's owner share plus the overlay's copy and accent.
 * @returns the takeover button.
 */
export function TintedArchiveButton({ displayTitle, t, accent }: TintedArchiveButtonProps) {
  return (
    <Tooltip label={t('takeover.tooltip')} side="bottom" align="end" delayMs={500}>
      <Button
        size="sm"
        className={css.takeover}
        aria-label={t('takeover.aria', { name: displayTitle })}
        icon={<IconArchiveCheckOutlineRegular />}
        style={{ '--dsh-common-view-accent': accent } as CSSProperties}
      />
    </Tooltip>
  )
}
