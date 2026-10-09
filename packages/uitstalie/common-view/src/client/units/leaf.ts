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
import spacerCss from './Spacer.module.css'
import dividerCss from './Divider.module.css'

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

/** Which way a divider runs: across a column, or down a row. */
export type DividerOrientation = 'horizontal' | 'vertical'

/** A spacer as composed: empty space inside a layout unit. */
export interface SpacerSpec {
  /** Fixed space, as a CSS length; ignored when the spacer grows. */
  size?: string | undefined
  /** Whether the spacer takes the unit's free space instead of a fixed size. */
  grow?: boolean | undefined
  /** Extra class the composing caller owns. */
  className?: string | undefined
}

/** A divider as composed: a hairline between siblings. */
export interface DividerSpec {
  /** Which way the line runs; defaults to horizontal. */
  orientation?: DividerOrientation | undefined
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
 * Emit the native box for a spacer: the unit's own class plus the inline flex
 * value that either fixes its size or takes the free space.
 * @param spec - the spacer as composed.
 * @returns the class name and inline style DSH renders.
 */
export function emitSpacer(spec: SpacerSpec): { className: string; style: CSSProperties } {
  return {
    className: classes(spacerCss.spacer, spec.className),
    style: spec.grow === true
      ? { flexGrow: '1', flexShrink: '1', flexBasis: '0%' }
      : { flexGrow: '0', flexShrink: '0', flexBasis: spec.size ?? '0px' },
  }
}

/**
 * Emit the native box for a divider: the orientation class carries the hairline,
 * so the theme specs can see the 0.5px neutral stroke in the stylesheet.
 * @param spec - the divider as composed.
 * @returns the class name and separator attributes DSH renders.
 */
export function emitDivider(spec: DividerSpec): {
  className: string
  attrs: { role: 'separator'; 'aria-orientation': DividerOrientation }
} {
  const orientation = spec.orientation ?? 'horizontal'
  return {
    className: classes(
      dividerCss.divider,
      orientation === 'vertical' ? dividerCss.vertical : dividerCss.horizontal,
      spec.className,
    ),
    attrs: { role: 'separator', 'aria-orientation': orientation },
  }
}

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
