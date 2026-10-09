/**
 * The composition layer's leaf vocabulary, and the single place that turns a
 * leaf spec back into what DSH renders natively.
 *
 * Both leaves are display-only: they carry content, never interaction or state.
 * Their appearance reaches CSS as component-local custom properties (font role,
 * ink, fit) so an overlay sets it per instance, while anything the theme specs
 * must see textually — a radius class, the corner-shape pairing — stays in the
 * leaf's own stylesheet.
 * @module @deepseek-ai/dsh-client-common-view/units/leaf
 */
import type { CSSProperties } from 'react'
import textCss from './TextView.module.css'
import imageCss from './ImageView.module.css'

/** Ink roles a text leaf may use; every one is a semantic alias token. */
export type TextTone = 'primary' | 'secondary' | 'tertiary' | 'caption'

/** Type roles a text leaf may use; every one is a composite `font` token that already pairs size with line height. */
export type TextSize = 'large' | 'body' | 'small' | 'caption'

/** How an image leaf fits its box. */
export type ImageFit = 'contain' | 'cover' | 'fill' | 'none'

/** Corner treatment of an image leaf. */
export type ImageRadius = 'none' | 'sm' | 'md' | 'lg' | 'full'

/** A text leaf as composed. */
export interface TextSpec {
  /** What the leaf shows. */
  text: string
  /** Ink role; defaults to the primary label alias. */
  tone?: TextTone | undefined
  /** Type role; defaults to the body role. */
  size?: TextSize | undefined
  /** Extra class the composing caller owns. */
  className?: string | undefined
}

/** An image leaf as composed. */
export interface ImageSpec {
  /** Image source: any URL an `img` accepts, including a `data:` URI for artwork that ships inline. */
  src: string
  /** Accessible name; the caller supplies it, and an empty string marks the image decorative. */
  alt: string
  /** How the image fits its box; defaults to `contain`. */
  fit?: ImageFit | undefined
  /** Box width, as a CSS length. */
  width?: string | undefined
  /** Box height, as a CSS length. */
  height?: string | undefined
  /** Corner treatment; defaults to none. */
  radius?: ImageRadius | undefined
  /** Extra class the composing caller owns. */
  className?: string | undefined
}

/** Composite `font` token per type role, taken from the theme's typography ladder. */
export const TEXT_SIZE_TOKENS: Readonly<Record<TextSize, string>> = {
  large: 'var(--dsw-font-base-16)',
  body: 'var(--dsw-font-s-14)',
  small: 'var(--dsw-font-xs-13)',
  caption: 'var(--dsw-font-xxs-12)',
}

/** Semantic ink alias per tone. */
export const TEXT_TONE_TOKENS: Readonly<Record<TextTone, string>> = {
  primary: 'var(--dsw-alias-label-primary)',
  secondary: 'var(--dsw-alias-label-secondary)',
  tertiary: 'var(--dsw-alias-label-tertiary)',
  caption: 'var(--dsw-alias-label-caption)',
}

/** Radius class per corner treatment; `none` emits no class. */
const IMAGE_RADIUS_CLASSES: Readonly<Record<ImageRadius, string | undefined>> = {
  none: undefined,
  sm: imageCss.radiusSm,
  md: imageCss.radiusMd,
  lg: imageCss.radiusLg,
  full: imageCss.radiusFull,
}

/** Join the class names a leaf emits, dropping the absent ones. */
function classes(...parts: readonly (string | undefined)[]): string {
  return parts.filter((part): part is string => part !== undefined).join(' ')
}

/**
 * Emit the native box for a text leaf.
 * @param spec - the leaf as composed.
 * @returns the class name and inline style DSH renders.
 */
export function emitText(spec: TextSpec): { className: string; style: CSSProperties } {
  return {
    className: classes(textCss.text, spec.className),
    style: {
      '--dsh-common-view-text-font': TEXT_SIZE_TOKENS[spec.size ?? 'body'],
      '--dsh-common-view-text-ink': TEXT_TONE_TOKENS[spec.tone ?? 'primary'],
    } as CSSProperties,
  }
}

/**
 * Emit the native element attributes for an image leaf.
 * @param spec - the leaf as composed.
 * @returns the class name, inline style, and element attributes DSH renders.
 */
export function emitImage(spec: ImageSpec): {
  className: string
  style: CSSProperties
  attrs: { src: string; alt: string; draggable: false; decoding: 'async'; loading: 'lazy' }
} {
  return {
    className: classes(imageCss.image, IMAGE_RADIUS_CLASSES[spec.radius ?? 'none'], spec.className),
    style: {
      '--dsh-common-view-image-fit': spec.fit ?? 'contain',
      ...spec.width === undefined ? {} : { width: spec.width },
      ...spec.height === undefined ? {} : { height: spec.height },
    } as CSSProperties,
    attrs: { src: spec.src, alt: spec.alt, draggable: false, decoding: 'async', loading: 'lazy' },
  }
}
