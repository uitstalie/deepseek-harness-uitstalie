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

// BEGIN uitstalie-deepseek-flash, 2026/11/06, DH-902, home-write disabled (Low-integrity whole-tree relabel; no auto-rollback)
/**
 * Whether `home-write` may be selected or enforced in this build.
 *
 * `false` is deliberate. On Windows the ACL backend grants a home-write root by
 * writing an inheritable Low mandatory-label ACE and letting
 * `SetNamedSecurityInfoW` relabel the WHOLE existing subtree: the user home and
 * every non-system drive root get low integrity, and switching back to
 * `workspace-write` never removes those labels. Windows then treats low-integrity
 * shortcuts and scripts as Internet-sourced files. Re-enable only together with
 * a lifecycle fix that records and restores the prior label, or an explicit,
 * disclosed opt-in.
 */
export const HOME_WRITE_ENABLED: boolean = false

/** The single refusal text every disabled `home-write` entry point reports. */
export const HOME_WRITE_DISABLED_MESSAGE = 'home-write is disabled in this build: on Windows its ACL grant relabels the whole existing home/drive '
  + 'subtree Low integrity and never rolls that back, which makes shortcuts and applications under the home '
  + 'behave as Internet-sourced files. Use workspace-write instead. Restore an already-relabelled tree with: '
  + 'icacls "<root>" /setintegritylevel (OI)(CI)M'

/**
 * Refuse the disabled mode at every effective-mode boundary (deployment
 * default, session override, approved escalation, resolved policy).
 * @param mode - the effective mode about to be selected or enforced.
 */
export function assertSandboxModeEnabled(mode: SandboxMode): void {
  if (mode === 'home-write' && !HOME_WRITE_ENABLED) throw new Error(HOME_WRITE_DISABLED_MESSAGE)
}
// END uitstalie-deepseek-flash

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
