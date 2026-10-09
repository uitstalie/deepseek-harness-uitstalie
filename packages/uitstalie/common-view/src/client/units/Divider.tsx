/**
 * The divider leaf: one 0.5px neutral hairline between siblings, running across
 * a column or down a row. It carries no interaction and no state.
 * @module @deepseek-ai/dsh-client-common-view/Divider
 */
import { emitDivider, type DividerOrientation } from './leaf.ts'

export type { DividerOrientation } from './leaf.ts'

/** Props the divider accepts. */
export interface DividerProps {
  /** Which way the line runs; defaults to horizontal. */
  orientation?: DividerOrientation
  /** Extra class for the divider's own box. */
  className?: string | undefined
}

/**
 * Render a divider.
 * @param props - the orientation and an optional class.
 * @returns the separator element.
 */
export function Divider({ orientation, className }: DividerProps) {
  const emitted = emitDivider({ orientation, className })
  return <span className={emitted.className} {...emitted.attrs} />
}
