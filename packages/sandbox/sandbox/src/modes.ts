/**
 * Sandbox-mode normalization and compatibility aliases.
 *
 * The released `non-critical-write` mode was folded into `home-write`; old
 * configurations and persisted Session events may still carry the removed
 * name. Every read path maps it here, so a replay or a stored config keeps
 * working without keeping a second mode in the vocabulary.
 *
 * @module dsh-sandbox/modes
 */

import type { SandboxMode } from './index.ts'

/**
 * Mode spellings that map onto a current mode. Only the folded mode needs an
 * entry; the map stays a closed object so an unknown string is a type error at
 * the call site.
 */
export const SANDBOX_MODE_ALIASES: Readonly<Record<string, SandboxMode>> = Object.freeze({
  'non-critical-write': 'home-write',
})

/**
 * Normalize one mode string from configuration or a persisted event.
 * @param value - the mode as stored or configured.
 * @returns the current mode name; unknown values are returned unchanged so the
 *   caller's validation reports them.
 */
export function normalizeSandboxMode(value: string): SandboxMode {
  return SANDBOX_MODE_ALIASES[value] ?? value as SandboxMode
}
