/**
 * The spacer leaf: empty space inside a layout unit, either a fixed length or
 * the unit's free space. It paints nothing, carries no interaction, and stays
 * out of the accessibility tree.
 * @module @deepseek-ai/dsh-client-common-view/Spacer
 */
import { emitSpacer } from './leaf.ts'

/** Props the spacer accepts. */
export interface SpacerProps {
  /** Fixed space, as a CSS length; ignored when the spacer grows. */
  size?: string
  /** Whether the spacer takes the unit's free space instead of a fixed size. */
  grow?: boolean
  /** Extra class for the spacer's own box. */
  className?: string | undefined
}

/**
 * Render a spacer.
 * @param props - the fixed size or the grow flag, plus an optional class.
 * @returns the spacer element.
 */
export function Spacer({ size, grow, className }: SpacerProps) {
  const emitted = emitSpacer({ size, grow, className })
  return <span className={emitted.className} style={emitted.style} aria-hidden="true" />
}
