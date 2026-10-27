/**
 * Wire types shared by the identity proposal Remote face and the settings
 * section that consumes it.
 *
 * They live in their own public subpath because a Remote boundary type must be
 * exported from a non-root module for the Typert generator.
 * @module @deepseek-ai/dsh-personality/types
 */

/** Latest status of one identity proposal. */
export type PersonalityProposalStatus = 'pending' | 'accepted' | 'rejected'

/** The replayable state one settings-page read returns. */
export interface PersonalityProposalWire {
  /** Stable proposal id. */
  readonly id: string
  /** Always identity. */
  readonly kind: 'identity'
  /** Entry name an accepted proposal would use. */
  readonly name: string
  /** Entry text. */
  readonly text: string
  /** Why the proposal exists. */
  readonly evidence: string
  /** When it was queued. */
  readonly proposedAt: string
  /** Latest status. */
  readonly status: PersonalityProposalStatus
}
