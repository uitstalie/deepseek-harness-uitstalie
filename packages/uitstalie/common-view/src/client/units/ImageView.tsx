/**
 * The image leaf: display-only artwork, composed as an {@link ImageSpec}. It
 * carries no interaction and no state; the caller supplies the accessible name,
 * so the leaf owns no fallback copy.
 * @module @deepseek-ai/dsh-client-common-view/ImageView
 */
import { emitImage, type ImageFit, type ImageRadius } from './leaf.ts'

export type { ImageFit, ImageRadius } from './leaf.ts'

/** Props the image leaf accepts. */
export interface ImageViewProps {
  /** Image source: any URL an `img` accepts, including a `data:` URI for inline artwork. */
  src: string
  /** Accessible name; the caller supplies it, and an empty string marks the image decorative. */
  alt: string
  /** How the image fits its box; defaults to `contain`. */
  fit?: ImageFit
  /** Box width, as a CSS length. */
  width?: string
  /** Box height, as a CSS length. */
  height?: string
  /** Corner treatment; defaults to none. */
  radius?: ImageRadius
  /** Extra class for the leaf's own box. */
  className?: string | undefined
}

/**
 * Render an image leaf.
 * @param props - the source, accessible name, fit, box sizes, and corners.
 * @returns the image element.
 */
export function ImageView({ src, alt, fit, width, height, radius, className }: ImageViewProps) {
  const emitted = emitImage({ src, alt, fit, width, height, radius, className })
  return <img className={emitted.className} style={emitted.style} {...emitted.attrs} />
}
