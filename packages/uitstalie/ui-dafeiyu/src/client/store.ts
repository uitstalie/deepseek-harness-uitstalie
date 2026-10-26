/**
 * The capability list's view state: one status snapshot over `remote.dafeiyu`
 * and one gate write over the `dafeiyu` settings namespace.
 *
 * The page holds no capability truth of its own. Reads come from the
 * organizer's live snapshot, so a state the agent plane sees and the state the
 * page shows cannot disagree; writes go through the settings namespace the
 * organizer's volatile gate reads, so the switch and a profile edit share one
 * path. The controller publishes plain data and structured failures; the
 * component maps failures to copy.
 *
 * @module @deepseek-ai/dsh-client-ui-dafeiyu/store
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { CapabilityStatus } from '@deepseek-ai/dsh-dafeiyu/types'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'

/** The `dafeiyu` settings namespace's form value: the volatile capability switches. */
export interface CapabilityGateValue {
  /** Per-capability switches keyed by capability id. */
  capabilities?: Record<string, { enabled?: boolean }>
}

/** The Remote method this page calls; the generated `remote.dafeiyu` namespace satisfies it. */
export interface CapabilityWire {
  /** The organizer's live capability snapshot. */
  status(): Promise<RemoteResult<readonly CapabilityStatus[]>>
}

/** The gate writer; the shared config form for the `dafeiyu` namespace satisfies it. */
export interface CapabilityGate {
  /**
   * Queue path-addressed edits to the namespace's user section.
   * @param ops - ordered field operations.
   * @param expectedRevision - optional revision fence.
   * @returns whether the host accepted the write.
   */
  mutate(ops: readonly SettingsPathOpView[], expectedRevision?: number): Promise<boolean>
}

/** The list's snapshot. The fields are mutable because this type is also the store draft. */
export interface CapabilitiesState {
  /** Whether the list has been read, is being read, or failed. */
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** Why the list could not be read. */
  error: string | null
  /** The status records the host answered, in organizer order. */
  entries: readonly CapabilityStatus[]
  /** Capability id whose switch is in flight. */
  pending: string | null
  /** Whether the last switch write was refused by the host. */
  refused: boolean
  /** Why the last switch write failed, when it threw. */
  actionError: string | null
}

/** One Remote read folded into the page's failure shape. */
type Read<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string }

/** The snapshot the page starts from. */
const initialState = (): CapabilitiesState => ({
  status: 'idle',
  error: null,
  entries: [],
  pending: null,
  refused: false,
  actionError: null,
})

/** Read one Remote answer, folding its failure branch and an assembly rejection into one shape. */
async function read<T>(call: () => Promise<RemoteResult<T>>): Promise<Read<T>> {
  try {
    const answer = await call()
    return answer.ok ? { ok: true, value: answer.value } : { ok: false, error: answer.error.message }
  } catch (error) {
    // Only assembly faults reject (a namespace that is not mounted, a closed connection); the
    // page reports them like any other read failure.
    return { ok: false, error: messageOf(error) }
  }
}

/** One thrown value as a one-line message. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** How many status reads one switch may take to observe the host's reconciliation. */
const SETTLE_ATTEMPTS = 10

/** Delay between those reads, in milliseconds. */
const SETTLE_DELAY_MS = 100

/** Resolve after a delay. */
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, milliseconds) })
}

/** The capability list's controller: loads the snapshot and flips one gate at a time. */
export class CapabilityStore {
  /** The snapshot source the renderer binds as `useSnapshot`. */
  readonly store: SnapshotStore<CapabilitiesState> = createSnapshotStore(initialState())

  /**
   * @param wire - the Remote method this page reads.
   * @param gate - the shared config form for the organizer's own settings namespace.
   */
  constructor(
    private readonly wire: CapabilityWire,
    private readonly gate: CapabilityGate,
  ) {}

  /** Read the organizer's live snapshot. */
  async load(): Promise<void> {
    this.store.update((draft) => {
      draft.status = draft.entries.length === 0 ? 'loading' : draft.status
      draft.error = null
    })
    const answer = await read(() => this.wire.status())
    this.store.update((draft) => {
      if (answer.ok) {
        draft.status = 'ready'
        draft.entries = answer.value
        draft.error = null
      } else {
        draft.status = 'error'
        draft.error = answer.error
      }
    })
  }

  /**
   * Flip one capability's organizer gate.
   *
   * The write targets the exact field the volatile gate reads, then re-reads
   * the snapshot until the host's reconciliation shows the requested value (a
   * closed gate disposes synchronously; an opened one awaits `create()`).
   * @param id - capability id.
   * @param enabled - the gate value to store.
   */
  async setEnabled(id: string, enabled: boolean): Promise<void> {
    this.store.update((draft) => {
      draft.pending = id
      draft.refused = false
      draft.actionError = null
    })
    try {
      const accepted = await this.gate.mutate([{
        op: 'set',
        path: ['capabilities', id, 'enabled'],
        value: enabled,
      }])
      this.store.update((draft) => { draft.refused = !accepted })
      if (accepted) await this.settle(id, enabled)
    } catch (error) {
      this.store.update((draft) => { draft.actionError = messageOf(error) })
    } finally {
      this.store.update((draft) => { draft.pending = null })
    }
  }

  /** Re-read until the asked capability reports the requested gate, or the attempts run out. */
  private async settle(id: string, enabled: boolean): Promise<void> {
    for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await delay(SETTLE_DELAY_MS)
      const answer = await read(() => this.wire.status())
      if (!answer.ok) return
      this.store.update((draft) => {
        draft.status = 'ready'
        draft.entries = answer.value
      })
      const entry = answer.value.find(candidate => candidate.id === id)
      if (entry !== undefined && entry.enabled === enabled) return
    }
  }
}
