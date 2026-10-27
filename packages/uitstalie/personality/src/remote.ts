/**
 * The Remote face of the identity proposal queue (`remote.personality`).
 *
 * The settings section lists proposals and accepts or rejects one. Reads are the
 * queue as the command shows it; the two decisions call the same host functions
 * the `/personality` command calls, so the browser and the command cannot
 * disagree. Identity acceptance is the only write this face can perform, and it
 * still goes through the version-guarded profile write.
 *
 * @module @deepseek-ai/dsh-personality/remote
 */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Session } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { PersonalitySettings } from './config.ts'
import { decideProposal, readProposals } from './proposals.ts'
import type { PersonalityProposal } from './proposals.ts'
import type { PersonalityProposalWire } from './types.ts'

export type { PersonalityProposalStatus, PersonalityProposalWire } from './types.ts'

/** Session id recorded for a decision made from the settings page. */
const SETTINGS_SESSION = SessionId('settings-ui')

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The identity proposal queue's host operations, read by `remote.personality`. */
    personalityProposals: PersonalityProposalOperations
    /** The wire-facing projection of the identity proposal queue. */
    personalityRemote: PersonalityRemote
  }
}

/** The remote namespace's host-side implementation, shared with `apply`. */
export interface PersonalityProposalOperations {
  /**
   * List the queue, pending first.
   * @returns every proposal with its latest status.
   */
  list(): Promise<readonly PersonalityProposal[]>
  /**
   * Accept or reject one pending proposal.
   * @param id - the proposal id.
   * @param decision - accept or reject.
   * @returns the proposal with its new status.
   */
  decide(id: string, decision: 'accept' | 'reject'): Promise<PersonalityProposal>
}

/**
 * Build the proposal operations the Remote face delegates to.
 * @param ctx - plugin context carrying `fs` and `dshStore`.
 * @param settings - resolved provider settings.
 * @returns the operations bound to this provider load.
 */
export function createPersonalityProposalOperations(
  ctx: Context,
  settings: PersonalitySettings,
): PersonalityProposalOperations {
  // Only `session.id` is read on the identity path: the profile target is the
  // global file, so no workspace store operation ever receives this handle.
  const settingsSession = { id: SETTINGS_SESSION } as Session
  return {
    async list() {
      return (await readProposals(ctx, settings)).proposals
    },
    async decide(id, decision) {
      return await decideProposal(ctx, settingsSession, settings, id, decision)
    },
  }
}

/**
 * The `remote.personality` namespace: the proposal queue and its two decisions.
 *
 * Mounted by the personality provider on the profile context, so the settings
 * section needs no host services of its own.
 */
export default class PersonalityRemote extends TypertRemoteService {
  /** The proposal operations this face delegates to. */
  static inject = ['personalityProposals']

  /**
   * @param ctx - owning context carrying the proposal operations.
   */
  constructor(ctx: Context) {
    super(ctx, 'personalityRemote', { namespace: 'personality' })
  }

  /**
   * List the identity proposal queue.
   * @returns every proposal, pending first.
   */
  @Remote
  async list(): Promise<readonly PersonalityProposalWire[]> {
    return await this.ctx.personalityProposals.list()
  }

  /**
   * Accept one pending identity proposal.
   * @param id - the proposal id.
   * @returns the accepted proposal.
   */
  @Remote
  async accept(id: string): Promise<PersonalityProposalWire> {
    return await this.ctx.personalityProposals.decide(id, 'accept')
  }

  /**
   * Reject one pending identity proposal.
   * @param id - the proposal id.
   * @returns the rejected proposal.
   */
  @Remote
  async reject(id: string): Promise<PersonalityProposalWire> {
    return await this.ctx.personalityProposals.decide(id, 'reject')
  }
}
