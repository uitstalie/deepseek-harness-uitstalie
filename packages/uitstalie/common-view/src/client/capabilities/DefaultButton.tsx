/**
 * The default button: the capability's common case, rendered by the shared
 * control. An injection that needs another look derives from it (see
 * `deriveButton`) or writes its own call site over the same capability.
 * @module @deepseek-ai/dsh-client-common-view/DefaultButton
 */
import { Button as SharedButton } from '@deepseek-ai/dsh-client-ui-primitives'
import { resolveButton, type ButtonBindings, type ButtonOverride, type ButtonSpec } from './button-capability.ts'

export type { ButtonBindings, ButtonOverride, ButtonSpec, ResolvedButton } from './button-capability.ts'

/** Props the default button accepts. */
export interface DefaultButtonProps {
  /** The button as the call site describes it. */
  spec: ButtonSpec
  /** The behavior the call site supplies. */
  bindings: ButtonBindings
  /** What an authority owning this button replaces, if any. */
  override?: ButtonOverride | undefined
}

/**
 * Render the default button.
 * @param props - the data half, the behavior half, and an optional override.
 * @returns the shared control, wired to the resolved behavior.
 */
export function DefaultButton({ spec, bindings, override }: DefaultButtonProps) {
  const resolved = resolveButton(spec, bindings, override)
  return (
    <SharedButton
      {...resolved.spec.variant === undefined ? {} : { variant: resolved.spec.variant }}
      {...resolved.spec.size === undefined ? {} : { size: resolved.spec.size }}
      {...resolved.spec.icon === undefined ? {} : { icon: resolved.spec.icon }}
      {...resolved.spec.disabled === undefined ? {} : { disabled: resolved.spec.disabled }}
      aria-label={resolved.spec.ariaLabel}
      onClick={resolved.bindings.onClick}
      onPointerEnter={resolved.bindings.onHoverStart}
      onPointerLeave={resolved.bindings.onHoverEnd}
      onFocus={resolved.bindings.onFocus}
      onBlur={resolved.bindings.onBlur}
    >
      {resolved.spec.label ?? null}
    </SharedButton>
  )
}
