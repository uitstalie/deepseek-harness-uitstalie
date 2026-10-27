/**
 * The memory row's editable fields, staged over the shared configuration form.
 *
 * The fields live in the `memory` profile row and are volatile, so a save applies to the running
 * provider on the next write or summary pass (the provider re-resolves its settings on
 * `loader/volatile-update`). The controller never mirrors the form's state: it seeds the draft from
 * the accepted snapshot and writes one revision-fenced mutation for the fields that changed.
 *
 * @module @deepseek-ai/dsh-client-ui-memory/settings
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'

/** The `memory` row fields this page edits. */
export interface MemoryRowConfig {
  /** Turn age at which a detail summary replaces the verbatim turn. */
  detail?: number
  /** Turn age at which a brief summary replaces the detail summary. */
  brief?: number
  /** Turn age at which the summary body leaves the context. */
  forget?: number
  /** Number of sessions kept with summaries in MEMORY.md. */
  sessions?: number
  /** Provider for the summary job; empty follows the routed model. */
  summarizationProvider?: string
  /** Model for the summary job; empty follows the routed model. */
  summarizationModel?: string
  /** Managed-block body budget in UTF-8 bytes. */
  maxBytes?: number
}

/** Every editable field, in render order. */
export const MEMORY_SETTINGS_FIELDS = [
  'detail',
  'brief',
  'forget',
  'sessions',
  'maxBytes',
  'summarizationProvider',
  'summarizationModel',
] as const

/** One editable field. */
export type MemorySettingsField = (typeof MEMORY_SETTINGS_FIELDS)[number]

/** The fields whose value is a number. */
const NUMERIC_FIELDS: readonly MemorySettingsField[] = ['detail', 'brief', 'forget', 'sessions', 'maxBytes']

/** What the memory settings block renders. */
export interface MemorySettingsState {
  /** Whether the Host serves the row's volatile form to this client. */
  available: boolean
  /** Whether the Host accepts writes. */
  writable: boolean
  /** The staged values, as the reader typed them. */
  values: Readonly<Record<MemorySettingsField, string>>
  /** Fields whose staged text is not a positive integer (numeric fields only). */
  invalid: readonly MemorySettingsField[]
  /** Whether any staged value differs from the accepted row. */
  dirty: boolean
  /** Whether a save is crossing the wire. */
  saving: boolean
  /** Whether the last save did not land as staged. */
  failed: boolean
}

/** A whole-row draft as text. */
type Draft = Record<MemorySettingsField, string>

/** The empty draft a row that has never written these fields shows. */
const EMPTY: Draft = {
  detail: '',
  brief: '',
  forget: '',
  sessions: '',
  maxBytes: '',
  summarizationProvider: '',
  summarizationModel: '',
}

/** The snapshot a deployment without the settings service reports: no form, writes refused. */
const UNAVAILABLE: ConfigFormSnapshot<MemoryRowConfig> = Object.freeze({
  status: 'unavailable',
  value: undefined,
  base: undefined,
  user: undefined,
  revision: undefined,
  writable: false,
})

/**
 * Read the accepted row as text.
 * @param snapshot - the accepted settings snapshot.
 * @returns every field's current text, or the empty draft.
 */
function draftOf(snapshot: ConfigFormSnapshot<MemoryRowConfig>): Draft {
  const value = snapshot.value
  if (value === undefined) return { ...EMPTY }
  return {
    detail: value.detail === undefined ? '' : String(value.detail),
    brief: value.brief === undefined ? '' : String(value.brief),
    forget: value.forget === undefined ? '' : String(value.forget),
    sessions: value.sessions === undefined ? '' : String(value.sessions),
    maxBytes: value.maxBytes === undefined ? '' : String(value.maxBytes),
    summarizationProvider: value.summarizationProvider ?? '',
    summarizationModel: value.summarizationModel ?? '',
  }
}

/** Whether one staged numeric field is empty or a positive safe integer. */
function validNumber(text: string): boolean {
  if (text === '') return true
  return /^\d+$/u.test(text) && Number.isSafeInteger(Number(text)) && Number(text) >= 1
}

/** The memory settings controller: staged fields and one revision-fenced save. */
export class MemorySettingsController {
  /** The snapshot source the block binds as its render state. */
  readonly store: SnapshotStore<MemorySettingsState>

  private draft: Draft = { ...EMPTY }
  private baseline: Draft = { ...EMPTY }
  private saving = false
  private failed = false
  private readonly unsubscribe: () => void

  /**
   * @param form - the shared configuration form of the `memory` row, when the settings service is
   *   composed; omitting it renders the block unavailable and refuses writes.
   */
  constructor(private readonly form: ConfigForm<MemoryRowConfig> | undefined) {
    this.seed()
    this.store = createSnapshotStore(this.projection())
    this.unsubscribe = form?.subscribe(() => { this.reconcile() }) ?? (() => {})
  }

  /**
   * Stage one field as typed.
   * @param field - which field changed.
   * @param text - the text as typed.
   */
  edit(field: MemorySettingsField, text: string): void {
    this.draft = { ...this.draft, [field]: text }
    this.publish()
  }

  /** Throw the staged values away and show the accepted row again. */
  discard(): void {
    this.seed()
    this.failed = false
    this.publish()
  }

  /** Write every changed field in one revision-fenced mutation. */
  async save(): Promise<void> {
    if (this.form === undefined || this.saving || !this.dirty || !this.valid) return
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

  /** Release the accepted-section subscription. */
  dispose(): void {
    this.unsubscribe()
  }

  /** Re-read the accepted row into the draft when nothing is staged. */
  private reconcile(): void {
    if (!this.dirty) this.seed()
    this.publish()
  }

  /** Seed the draft and baseline from the accepted section. */
  private seed(): void {
    this.baseline = draftOf(this.accepted())
    this.draft = { ...this.baseline }
  }

  /** Build the write plan for the changed fields: empty text clears the override. */
  private operations(): readonly SettingsPathOpView[] {
    const operations: SettingsPathOpView[] = []
    for (const field of MEMORY_SETTINGS_FIELDS) {
      if (this.draft[field] === this.baseline[field]) continue
      const text = this.draft[field].trim()
      if (text === '') {
        operations.push({ op: 'unset', path: [field] })
        continue
      }
      const value: string | number = NUMERIC_FIELDS.includes(field) ? Number(text) : text
      operations.push({ op: 'set', path: [field], value })
    }
    return operations
  }

  /** Whether every staged numeric field parses. */
  private get valid(): boolean {
    return NUMERIC_FIELDS.every(field => validNumber(this.draft[field]))
  }

  /** The invalid staged fields, for the block's inline warnings. */
  private invalidFields(): readonly MemorySettingsField[] {
    return NUMERIC_FIELDS.filter(field => !validNumber(this.draft[field]))
  }

  /** Whether a save would write at least one field. */
  private get dirty(): boolean {
    return MEMORY_SETTINGS_FIELDS.some(field => this.draft[field] !== this.baseline[field])
  }

  /** The accepted row snapshot, or the unavailable one when no settings service is composed. */
  private accepted(): ConfigFormSnapshot<MemoryRowConfig> {
    return this.form?.getSnapshot() ?? UNAVAILABLE
  }

  /** Build the block's render state from the accepted section and the staged draft. */
  private projection(): MemorySettingsState {
    const snapshot = this.accepted()
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      values: Object.freeze({ ...this.draft }),
      invalid: Object.freeze(this.invalidFields()),
      dirty: this.dirty,
      saving: this.saving,
      failed: this.failed,
    }
  }

  private publish(): void {
    this.store.set(this.projection())
  }
}
