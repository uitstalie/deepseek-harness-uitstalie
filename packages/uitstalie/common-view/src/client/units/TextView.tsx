/**
 * The text leaf: display-only text, composed as a {@link TextSpec}. It carries
 * no interaction and no state — nothing here reads or writes anything.
 * @module @deepseek-ai/dsh-client-common-view/TextView
 */
import { emitText, type TextSize, type TextTone } from './leaf.ts'

export type { TextSize, TextTone } from './leaf.ts'

/** Props the text leaf accepts. */
export interface TextViewProps {
  /** What the leaf shows. */
  text: string
  /** Ink role; defaults to the primary label alias. */
  tone?: TextTone
  /** Type role; defaults to the body role. */
  size?: TextSize
  /** Extra class for the leaf's own box. */
  className?: string | undefined
}

/**
 * Render a text leaf.
 * @param props - the text plus its optional ink and type roles.
 * @returns the text element.
 */
export function TextView({ text, tone, size, className }: TextViewProps) {
  const emitted = emitText({ text, tone, size, className })
  return <span className={emitted.className} style={emitted.style}>{text}</span>
}
