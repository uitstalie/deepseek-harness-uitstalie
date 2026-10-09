/**
 * The button capability: the abstract, configurable interactive unit.
 *
 * It splits in two the halves every call site used to hand-write together:
 * {@link ButtonSpec} is the button's data (what it looks like and whether it is
 * available), and {@link ButtonBindings} is its behavior (the functions it
 * calls). {@link resolveButton} layers them so a call site states its own
 * behavior while an authority that owns the button can override either half —
 * the resolution is an explicit step, never a hidden fallback.
 *
 * Appearance is not restyled here: a resolved button is rendered by the shared
 * control, so the theme and the overlay keep their usual leverage.
 * @module @deepseek-ai/dsh-client-common-view/button-capability
 */
import type { ReactNode } from 'react'
import type { ButtonVariant } from '@deepseek-ai/dsh-client-ui-primitives'

/** How a button looks, as data. */
export interface ButtonSpec {
  /** Stable identity of this button; overrides address it by this value. */
  id: string
  /** Accessible name. The caller supplies it, so the capability owns no copy. */
  ariaLabel: string
  /** Visible label; omitted for an icon-only button. */
  label?: string | undefined
  /** Leading icon. */
  icon?: ReactNode
  /** Visual weight, as the shared control defines it. */
  variant?: ButtonVariant | undefined
  /** Control size. */
  size?: 'md' | 'sm' | undefined
  /** Whether the button refuses activation. */
  disabled?: boolean | undefined
}

/** What a button does, as plain callbacks. */
export interface ButtonBindings {
  /** Called on activation. */
  onClick?: (() => void) | undefined
  /** Called when the pointer enters the button. */
  onHoverStart?: (() => void) | undefined
  /** Called when the pointer leaves the button. */
  onHoverEnd?: (() => void) | undefined
  /** Called when the button takes focus. */
  onFocus?: (() => void) | undefined
  /** Called when the button loses focus. */
  onBlur?: (() => void) | undefined
}

/** What an override may replace: either half, key by key. */
export interface ButtonOverride {
  /** Replaces the listed data keys. */
  spec?: Partial<Omit<ButtonSpec, 'id'>> | undefined
  /** Replaces the listed behavior keys. */
  bindings?: Partial<ButtonBindings> | undefined
}

/** A button after resolution: one complete data half and one complete behavior half. */
export interface ResolvedButton {
  /** The data the shared control renders from. */
  spec: ButtonSpec
  /** The behavior the shared control calls. */
  bindings: ButtonBindings
}

/**
 * Resolve a button from its call site and an optional override.
 *
 * The override wins for every key it states, and the call site keeps the rest;
 * identity is never overridable, so an override cannot retarget a button.
 * @param spec - the button as the call site describes it.
 * @param bindings - the behavior the call site supplies.
 * @param override - what an authority owning this button replaces, if any.
 * @returns the complete data and behavior halves.
 */
export function resolveButton(spec: ButtonSpec, bindings: ButtonBindings, override?: ButtonOverride): ResolvedButton {
  return {
    spec: { ...spec, ...override?.spec, id: spec.id },
    bindings: { ...bindings, ...override?.bindings },
  }
}

/**
 * Derive a button from a base one: the derived data and behavior win for the
 * keys they state, which is how a preset (outlined, icon-only, composed) or a
 * feature's own variant is expressed without a second capability.
 * @param base - the button the derivation starts from.
 * @param derived - the data keys the derivation restates.
 * @param bindings - the behavior keys the derivation restates, if any.
 * @returns a new button; the base is left untouched.
 */
export function deriveButton(base: ButtonSpec, derived: Partial<Omit<ButtonSpec, 'id'>>, bindings?: ButtonBindings): {
  spec: ButtonSpec
  bindings: ButtonBindings
} {
  return { spec: { ...base, ...derived, id: base.id }, bindings: bindings ?? {} }
}

/**
 * Index a set of overrides by the button identity each one addresses.
 * @param overrides - pairs of button id and the override for it.
 * @returns a lookup by id.
 */
export function indexButtonOverrides(overrides: readonly (readonly [string, ButtonOverride])[]): ReadonlyMap<string, ButtonOverride> {
  return new Map(overrides)
}
