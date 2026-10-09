// @vitest-environment jsdom
/**
 * The button capability and its default button: the data half decides what the
 * shared control looks like, the behavior half decides what it calls, and an
 * override or a derivation replaces whichever keys it states.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DefaultButton } from '../src/client/capabilities/DefaultButton.tsx'
import { deriveButton, indexButtonOverrides, resolveButton } from '../src/client/capabilities/button-capability.ts'
import type { ButtonSpec } from '../src/client/capabilities/button-capability.ts'

// This config does not enable vitest globals, so the DOM is torn down per case.
afterEach(cleanup)

/** The data half a case starts from. */
const SPEC: ButtonSpec = { id: 'demo', ariaLabel: 'alpha', label: 'Alpha' }

describe('default button', () => {
  it('renders the shared control from the data half alone', () => {
    render(<DefaultButton spec={{ ...SPEC, disabled: true }} bindings={{}} />)
    const control = screen.getByRole('button', { name: 'alpha' }) as HTMLButtonElement
    expect(control.textContent).toBe('Alpha')
    expect(control.disabled).toBe(true)
  })

  it('calls the behavior half: activation, hover, focus', () => {
    const onClick = vi.fn()
    const onHoverStart = vi.fn()
    const onHoverEnd = vi.fn()
    const onFocus = vi.fn()
    const onBlur = vi.fn()
    render(<DefaultButton spec={SPEC} bindings={{ onClick, onHoverStart, onHoverEnd, onFocus, onBlur }} />)
    const control = screen.getByRole('button', { name: 'alpha' })
    fireEvent.click(control)
    fireEvent.pointerOver(control)
    fireEvent.pointerOut(control)
    fireEvent.focus(control)
    fireEvent.blur(control)
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(onHoverStart).toHaveBeenCalledTimes(1)
    expect(onHoverEnd).toHaveBeenCalledTimes(1)
    expect(onFocus).toHaveBeenCalledTimes(1)
    expect(onBlur).toHaveBeenCalledTimes(1)
  })

  it('keeps an icon-only button named for assistive technology', () => {
    render(<DefaultButton spec={{ id: 'icon', ariaLabel: 'beta', icon: <span>•</span> }} bindings={{}} />)
    expect(screen.getByRole('button', { name: 'beta' })).toBeDefined()
  })
})

describe('button override', () => {
  it('replaces the keys an override states and keeps every other key', () => {
    const onBlur = vi.fn()
    const resolved = resolveButton(
      SPEC,
      { onClick: () => {}, onBlur },
      { spec: { label: 'Beta' }, bindings: { onClick: undefined } },
    )
    expect(resolved.spec).toEqual({ id: 'demo', ariaLabel: 'alpha', label: 'Beta' })
    expect(resolved.bindings.onBlur).toBe(onBlur)
    expect(resolved.bindings.onClick).toBeUndefined()
  })

  it('keeps the identity the override was addressed to', () => {
    const resolved = resolveButton(SPEC, {}, { spec: { ariaLabel: 'gamma' } })
    expect(resolved.spec.id).toBe('demo')
    expect(resolved.spec.ariaLabel).toBe('gamma')
  })

  it('renders the overriding behavior instead of the call site one', () => {
    const callSite = vi.fn()
    const authority = vi.fn()
    render(<DefaultButton spec={SPEC} bindings={{ onClick: callSite }} override={{ bindings: { onClick: authority } }} />)
    fireEvent.click(screen.getByRole('button', { name: 'alpha' }))
    expect(authority).toHaveBeenCalledTimes(1)
    expect(callSite).not.toHaveBeenCalled()
  })

  it('indexes overrides by the identity each one addresses', () => {
    const index = indexButtonOverrides([['demo', { spec: { label: 'Beta' } }]])
    expect(index.get('demo')?.spec?.label).toBe('Beta')
    expect(index.get('absent')).toBeUndefined()
  })
})

describe('button derivation', () => {
  it('derives a variant without touching the base', () => {
    const outlined = deriveButton(SPEC, { variant: 'outline' })
    expect(outlined.spec).toEqual({ ...SPEC, variant: 'outline' })
    expect(outlined.bindings).toEqual({})
    expect(SPEC.variant).toBeUndefined()
  })

  it('lets a derivation restate behavior and keep the identity', () => {
    const onClick = vi.fn()
    const derived = deriveButton(SPEC, { label: 'Gamma' }, { onClick })
    expect(derived.spec.id).toBe('demo')
    expect(derived.spec.label).toBe('Gamma')
    expect(derived.bindings.onClick).toBe(onClick)
  })
})
