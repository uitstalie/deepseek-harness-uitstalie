/**
 * The overlay's contribution to the session row's action strip, built from the
 * framework's layout unit. The strip's unit is what an overlay owns here: its
 * geometry comes from the plugin config and reaches CSS as component-local
 * custom properties, and the unit is where the next slice hangs child slots.
 * @module @deepseek-ai/dsh-client-common-view/ActionRow
 */
import { Row, type UnitAlign, type UnitJustify } from '../../units/Row.tsx'
import { MarkerButton } from './MarkerButton.tsx'
import type { CommonViewKey } from '../../locales.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Owner share of the session-row action cell. */
export interface ActionRowOwnerProps {
  /** Session the row shows. */
  sessionId: SessionId
  /** Row display title, used in the accessible name. */
  displayTitle: string
}

/** Injected share of the strip unit. */
export interface ActionRowInjected {
  /** Localized copy of the `common-view` namespace. */
  t: (key: CommonViewKey, params?: Record<string, string>) => string
  /** Accent the items paint with. */
  accent: string
  /** Gap between the unit's children. */
  gap: string
  /** Cross-axis placement inside the unit. */
  align: UnitAlign
  /** Along-axis distribution inside the unit. */
  justify: UnitJustify
}

/** Owner share of the session-row action cell plus the injected share. */
export type ActionRowProps = ActionRowOwnerProps & ActionRowInjected

/**
 * Render the strip unit with the overlay's items.
 * @param props - the row's owner share plus the overlay's copy, accent, and geometry.
 * @returns the row unit.
 */
export function ActionRow({ sessionId, displayTitle, t, accent, gap, align, justify }: ActionRowProps) {
  return (
    <Row gap={gap} align={align} justify={justify}>
      <MarkerButton sessionId={sessionId} displayTitle={displayTitle} t={t} accent={accent} />
    </Row>
  )
}
