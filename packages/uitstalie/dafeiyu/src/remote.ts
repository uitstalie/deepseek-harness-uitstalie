/**
 * The read-only Remote face of the capability registry (`remote.dafeiyu`).
 *
 * The browser sees one status record per registered provider and per
 * configured id without a provider. It cannot register, enable, or disable
 * anything: the gate is the organizer's own profile configuration, written
 * through the settings namespace of the `dafeiyu` row. This face exists so a
 * capability list can show the effective state, failure summary, and the
 * provider's own settings link.
 *
 * @module @deepseek-ai/dsh-dafeiyu/remote
 */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { CapabilityStatus } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The wire-facing read-only projection of `ctx.dafeiyu`. */
    dafeiyuRemote: DafeiyuRemote
  }
}

/**
 * The `remote.dafeiyu` namespace: one read over the organizer's live snapshot.
 *
 * Mounted by the `Dafeiyu` constructor on its own fiber, so the organizer row
 * alone is a complete browser surface.
 */
export default class DafeiyuRemote extends TypertRemoteService {
  /** The organizer this face reads; another organizer may not stand in for it. */
  static inject = ['dafeiyu']

  /**
   * @param ctx - owning context carrying the organizer service.
   */
  constructor(ctx: Context) {
    // The Cordis key cannot be `dafeiyu` — the organizer owns it — while the
    // wire namespace is the one the UI addresses.
    super(ctx, 'dafeiyuRemote', { namespace: 'dafeiyu' })
  }

  /**
   * The live capability snapshot: registration, gate, state, failure, turn
   * clock, and the v2 list metadata. Never reads disk and never re-runs
   * `create()`.
   * @returns one status record per registered provider, then configured ids without a provider.
   */
  @Remote
  status(): readonly CapabilityStatus[] {
    return this.ctx.dafeiyu.status()
  }
}
