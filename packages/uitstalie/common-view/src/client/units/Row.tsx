/**
 * The horizontal layout unit: a thin renderer over the composition layer's unit
 * spec, so every geometry decision lives in `spec.ts` and this file stays a
 * native box.
 * @module @deepseek-ai/dsh-client-common-view/Row
 */
import type { ReactNode } from 'react'
import { emitUnit, type UnitAlign, type UnitJustify } from './spec.ts'

export type { UnitAlign, UnitJustify } from './spec.ts'

/** Props the row unit accepts. */
export interface UnitProps {
  /** Gap between children, as a CSS length. */
  gap?: string
  /** Cross-axis placement. */
  align?: UnitAlign
  /** Along-axis distribution. */
  justify?: UnitJustify
  /** Extra class for the unit's own box. */
  className?: string | undefined
  /** The unit's children. */
  children?: ReactNode
}

/**
 * Render a horizontal layout unit.
 * @param props - gap, alignments, an optional class, and the children.
 * @returns the row element.
 */
export function Row({ gap, align = 'center', justify = 'start', className, children }: UnitProps) {
  const emitted = emitUnit({ kind: 'row', gap, align, justify }, className)
  return <span className={emitted.className} style={emitted.style}>{children}</span>
}
