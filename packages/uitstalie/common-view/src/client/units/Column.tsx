/**
 * The vertical layout unit: the same contract as {@link Row} along the block
 * axis, kept symmetric on purpose — an overlay that knows one unit knows both.
 * @module @deepseek-ai/dsh-client-common-view/Column
 */
import type { ReactNode } from 'react'
import { emitUnit, type UnitAlign, type UnitJustify } from './spec.ts'

/** Props the column unit accepts; the vocabulary matches the row unit. */
export interface ColumnProps {
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
 * Render a vertical layout unit.
 * @param props - gap, alignments, an optional class, and the children.
 * @returns the column element.
 */
export function Column({ gap, align = 'stretch', justify = 'start', className, children }: ColumnProps) {
  const emitted = emitUnit({ kind: 'column', gap, align, justify }, className)
  return <span className={emitted.className} style={emitted.style}>{children}</span>
}
