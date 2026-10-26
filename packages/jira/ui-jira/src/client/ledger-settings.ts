/**
 * The ledger row's writable fields: the root path, the audit host and the push switch.
 *
 * The values live in the `jira-service` profile row; a volatile schema field is what lets the
 * settings service write it without remounting the row. This controller stages the two text
 * fields (a save is one revision-fenced mutation) and writes the switch immediately, because a
 * switch that needed a second save click would report a state the row does not have yet.
 *
 * @module @deepseek-ai/dsh-client-ui-jira/ledger-settings
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'

/** The `jira-service` row fields this page edits. */
export interface JiraLedgerSettings {
  /** Ledger root; absent resolves through the environment and the profile. */
  root?: string
  /** The `owner.host` audit value; absent uses this machine's hostname. */
  host?: string
  /** Push switch and debounce owned by the service row. */
  push?: {
    /** Whether a settle schedules a push. */
    enabled?: boolean
    /** Debounce window in milliseconds. */
    debounce_ms?: number
  }
}

/** What the ledger settings block renders. */
export interface JiraLedgerSettingsState {
  /** Whether the Host serves the row's volatile form to this client. */
  available: boolean
  /** Whether the Host accepts writes. */
  writable: boolean
  /** The staged root text. */
  root: string
  /** The staged audit-host text. */
  host: string
  /** Whether the staged text differs from the accepted row. */
  dirty: boolean
  /** Whether a save is crossing the wire. */
  saving: boolean
  /** Whether the last save did not land as staged. */
  failed: boolean
  /** The accepted push switch. */
  pushEnabled: boolean
  /** Whether the push switch write is crossing the wire. */
  pushSaving: boolean
  /** Whether the last push switch write did not land. */
  pushFailed: boolean
}

/** One staged text field, before it becomes a settings path operation. */
interface Drafts {
  root: string
  host: string
}

/**
 * Read one row value from the accepted section, tolerating a row that has never written it.
 * @param snapshot - the accepted settings snapshot.
 * @param read - projection from the row value to the text the field shows.
 * @returns the text, or the empty string when the field carries no value.
 */
function textOf(snapshot: ConfigFormSnapshot<JiraLedgerSettings>, read: (value: JiraLedgerSettings) => string | undefined): string {
  return read(snapshot.value ?? {}) ?? ''
}

/** The snapshot a deployment without the settings service reports: no form, writes refused. */
const UNAVAILABLE: ConfigFormSnapshot<JiraLedgerSettings> = Object.freeze({
  status: 'unavailable',
  value: undefined,
  base: undefined,
  user: undefined,
  revision: undefined,
  writable: false,
})

/** The ledger settings controller: staged text fields plus the immediate push switch. */
export class JiraLedgerSettingsController {
  /** The snapshot source the block binds as its render state. */
  readonly store: SnapshotStore<JiraLedgerSettingsState>

  private draft: Drafts = { root: '', host: '' }
  private baseline: Drafts = { root: '', host: '' }
  private saving = false
  private failed = false
  private pushSaving = false
  private pushFailed = false
  private readonly unsubscribe: () => void

  /**
   * @param form - the shared configuration form of the `jira-service` row, when the settings
   * service is composed; omitting it renders the block unavailable and refuses writes.
   */
  constructor(private readonly form: ConfigForm<JiraLedgerSettings> | undefined) {
    this.seed()
    this.store = createSnapshotStore(this.projection())
    this.unsubscribe = form?.subscribe(() => { this.reconcile() }) ?? (() => {})
  }

  /**
   * Stage one text field.
   * @param field - which staged field changed.
   * @param text - the text as typed.
   */
  edit(field: keyof Drafts, text: string): void {
    this.draft = { ...this.draft, [field]: text }
    this.publish()
  }

  /** Throw the staged text away and show the accepted row again. */
  discard(): void {
    this.seed()
    this.failed = false
    this.publish()
  }

  /** Write both staged text fields in one revision-fenced mutation. */
  async save(): Promise<void> {
    if (this.form === undefined || this.saving || !this.dirty || !this.writable) return
    this.saving = true
    this.failed = false
    this.publish()
    try {
      const accepted = await this.form.mutate(this.operations(), this.accepted().revision)
      this.failed = !accepted
      if (accepted) this.seed()
    } catch {
      this.failed = true
    } finally {
      this.saving = false
      this.publish()
    }
  }

  /**
   * Write the push switch immediately.
   * @param enabled - the state the switch asks for.
   */
  async setPush(enabled: boolean): Promise<void> {
    if (this.form === undefined || this.pushSaving || !this.writable) return
    this.pushSaving = true
    this.pushFailed = false
    this.publish()
    try {
      const accepted = await this.form.mutate(
        [{ op: 'set', path: ['push', 'enabled'], value: enabled }],
        this.accepted().revision,
      )
      this.pushFailed = !accepted
    } catch {
      this.pushFailed = true
    } finally {
      this.pushSaving = false
      this.publish()
    }
  }

  /** Release the accepted-section subscription. */
  dispose(): void {
    this.unsubscribe()
  }

  /** Re-read the accepted row into both the baseline and the draft when nothing is staged. */
  private reconcile(): void {
    if (!this.dirty) this.seed()
    this.publish()
  }

  /** Seed the draft and baseline from the accepted section. */
  private seed(): void {
    const snapshot = this.accepted()
    this.baseline = {
      root: textOf(snapshot, value => value.root),
      host: textOf(snapshot, value => value.host),
    }
    this.draft = { ...this.baseline }
  }

  /** Build the write plan for the staged text: empty text clears the override. */
  private operations(): readonly SettingsPathOpView[] {
    const operations: SettingsPathOpView[] = []
    if (this.draft.root !== this.baseline.root) {
      operations.push(this.draft.root === ''
        ? { op: 'unset', path: ['root'] }
        : { op: 'set', path: ['root'], value: this.draft.root })
    }
    if (this.draft.host !== this.baseline.host) {
      operations.push(this.draft.host === ''
        ? { op: 'unset', path: ['host'] }
        : { op: 'set', path: ['host'], value: this.draft.host })
    }
    return operations
  }

  /** Whether a save would write at least one field. */
  private get dirty(): boolean {
    return this.draft.root !== this.baseline.root || this.draft.host !== this.baseline.host
  }

  /** Whether the Host accepts writes right now. */
  private get writable(): boolean {
    return this.accepted().writable
  }

  /** Build the block's render state from the accepted section and the staged draft. */
  private projection(): JiraLedgerSettingsState {
    const snapshot = this.accepted()
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      root: this.draft.root,
      host: this.draft.host,
      dirty: this.dirty,
      saving: this.saving,
      failed: this.failed,
      pushEnabled: snapshot.value?.push?.enabled === true,
      pushSaving: this.pushSaving,
      pushFailed: this.pushFailed,
    }
  }

  /** Publish the current projection. */
  /** The accepted row snapshot, or the unavailable one when no settings service is composed. */
  private accepted(): ConfigFormSnapshot<JiraLedgerSettings> {
    return this.form?.getSnapshot() ?? UNAVAILABLE
  }

  private publish(): void {
    this.store.set(this.projection())
  }
}
