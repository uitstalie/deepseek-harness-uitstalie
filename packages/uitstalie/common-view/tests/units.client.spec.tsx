// @vitest-environment jsdom
/**
 * The layout units: both lay their children out in order, and both carry their
 * geometry as component-local custom properties plus the two discrete axes, so
 * an overlay sets them without a stylesheet rule.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { Column } from '../src/client/units/Column.tsx'
import { Row } from '../src/client/units/Row.tsx'

// This config does not enable vitest globals, so the DOM is torn down per case.
afterEach(cleanup)

describe('layout units', () => {
  it('lays a row out in order with the configured gap and axes', () => {
    render(
      <Row gap="6px" align="end" justify="between">
        <span>first</span>
        <span>second</span>
      </Row>,
    )
    const unit = screen.getByText('first').parentElement as HTMLElement
    expect(unit.textContent).toBe('firstsecond')
    expect(unit.style.getPropertyValue('--dsh-common-view-unit-gap')).toBe('6px')
    expect(unit.style.alignItems).toBe('flex-end')
    expect(unit.style.justifyContent).toBe('space-between')
  })

  it('keeps the column unit symmetric with the row unit', () => {
    render(<Column gap="2px" align="start"><span>only</span></Column>)
    const unit = screen.getByText('only').parentElement as HTMLElement
    expect(unit.style.getPropertyValue('--dsh-common-view-unit-gap')).toBe('2px')
    expect(unit.style.alignItems).toBe('flex-start')
    expect(unit.style.justifyContent).toBe('flex-start')
  })

  it('falls back to the unit default gap when the overlay sets none', () => {
    render(<Row><span>bare</span></Row>)
    const unit = screen.getByText('bare').parentElement as HTMLElement
    expect(unit.style.getPropertyValue('--dsh-common-view-unit-gap')).toBe('4px')
  })
})
