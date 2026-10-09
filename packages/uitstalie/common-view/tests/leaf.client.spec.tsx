// @vitest-environment jsdom
/**
 * The display-only leaves: text shows its content under a type role and an ink
 * role, an image carries its source, accessible name, fit, and corners. Neither
 * leaf takes interaction props, and every appearance value is a theme token.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { Divider } from '../src/client/units/Divider.tsx'
import { ImageView } from '../src/client/units/ImageView.tsx'
import { Spacer } from '../src/client/units/Spacer.tsx'
import { TextView } from '../src/client/units/TextView.tsx'
import { emitDivider, emitImage, emitSpacer, TEXT_SIZE_TOKENS, TEXT_TONE_TOKENS, type TextSize, type TextTone } from '../src/client/units/leaf.ts'

// This config does not enable vitest globals, so the DOM is torn down per case.
afterEach(cleanup)

/** A one-pixel PNG, so the case needs no fixture file. */
const PIXEL = 'data:image/png;base64,iVBORw0KGgo='

describe('text leaf', () => {
  it('shows its content under the body role and the primary ink by default', () => {
    render(<TextView text="alpha" />)
    const leaf = screen.getByText('alpha')
    expect(leaf.style.getPropertyValue('--dsh-common-view-text-font')).toBe(TEXT_SIZE_TOKENS.body)
    expect(leaf.style.getPropertyValue('--dsh-common-view-text-ink')).toBe(TEXT_TONE_TOKENS.primary)
  })

  it('takes the ink and type roles the composition asks for', () => {
    render(<TextView text="beta" size="caption" tone="tertiary" />)
    const leaf = screen.getByText('beta')
    expect(leaf.style.getPropertyValue('--dsh-common-view-text-font')).toBe(TEXT_SIZE_TOKENS.caption)
    expect(leaf.style.getPropertyValue('--dsh-common-view-text-ink')).toBe(TEXT_TONE_TOKENS.tertiary)
  })

  it('maps every role to a semantic alias token', () => {
    const sizes = Object.values(TEXT_SIZE_TOKENS)
    const tones = Object.values(TEXT_TONE_TOKENS)
    expect(sizes.every(token => token.startsWith('var(--dsw-font-'))).toBe(true)
    expect(tones.every(token => token.startsWith('var(--dsw-alias-label-'))).toBe(true)
    for (const size of Object.keys(TEXT_SIZE_TOKENS) as TextSize[]) {
      render(<TextView text="x" size={size} />)
      expect(screen.getByText('x').style.getPropertyValue('--dsh-common-view-text-font')).toBe(TEXT_SIZE_TOKENS[size])
      cleanup()
    }
    for (const tone of Object.keys(TEXT_TONE_TOKENS) as TextTone[]) {
      render(<TextView text="x" tone={tone} />)
      expect(screen.getByText('x').style.getPropertyValue('--dsh-common-view-text-ink')).toBe(TEXT_TONE_TOKENS[tone])
      cleanup()
    }
  })
})

describe('image leaf', () => {
  it('renders an image with its source, accessible name, and display-only attributes', () => {
    render(<ImageView src={PIXEL} alt="alpha artwork" />)
    const leaf = screen.getByAltText('alpha artwork') as HTMLImageElement
    expect(leaf.getAttribute('src')).toBe(PIXEL)
    expect(leaf.getAttribute('draggable')).toBe('false')
    expect(leaf.getAttribute('loading')).toBe('lazy')
    expect(leaf.getAttribute('decoding')).toBe('async')
  })

  it('carries fit and box sizes as inline values, defaulting to contain', () => {
    render(<ImageView src={PIXEL} alt="" width="32px" height="18px" />)
    const leaf = screen.getByAltText('') as HTMLImageElement
    expect(leaf.style.getPropertyValue('--dsh-common-view-image-fit')).toBe('contain')
    expect(leaf.style.width).toBe('32px')
    expect(leaf.style.height).toBe('18px')

    cleanup()
    render(<ImageView src={PIXEL} alt="" fit="cover" />)
    expect(screen.getByAltText('').style.getPropertyValue('--dsh-common-view-image-fit')).toBe('cover')
  })

  it('emits a corner class only when the composition asks for corners', () => {
    expect(emitImage({ src: PIXEL, alt: '' }).className).toBe(emitImage({ src: PIXEL, alt: '', radius: 'none' }).className)
    expect(emitImage({ src: PIXEL, alt: '', radius: 'full' }).className)
      .not.toBe(emitImage({ src: PIXEL, alt: '', radius: 'none' }).className)
  })
})

describe('spacer leaf', () => {
  it('takes a fixed size and stays out of the accessibility tree', () => {
    const { container } = render(<div><Spacer size="8px" /></div>)
    const leaf = container.firstElementChild?.firstElementChild as HTMLElement
    expect(leaf.getAttribute('aria-hidden')).toBe('true')
    expect(leaf.textContent).toBe('')
    expect(leaf.style.flexBasis).toBe('8px')
    expect(leaf.style.flexGrow).toBe('0')
  })

  it('takes the unit free space when it grows', () => {
    const { container } = render(<div><Spacer grow /></div>)
    const leaf = container.firstElementChild?.firstElementChild as HTMLElement
    expect(leaf.style.flexGrow).toBe('1')
    expect(leaf.style.flexBasis).toBe('0%')
    expect(emitSpacer({}).style.flexBasis).toBe('0px')
  })
})

describe('divider leaf', () => {
  it('is a separator that runs horizontally unless told otherwise', () => {
    render(<Divider />)
    const leaf = screen.getByRole('separator')
    expect(leaf.getAttribute('aria-orientation')).toBe('horizontal')
    cleanup()
    render(<Divider orientation="vertical" />)
    expect(screen.getByRole('separator').getAttribute('aria-orientation')).toBe('vertical')
  })

  it('carries the orientation in its class, so the hairline stays in the stylesheet', () => {
    const vertical = emitDivider({ orientation: 'vertical' }).className
    expect(vertical).not.toBe(emitDivider({}).className)
    expect(vertical).not.toBe(emitDivider({ orientation: 'horizontal' }).className)
  })
})
