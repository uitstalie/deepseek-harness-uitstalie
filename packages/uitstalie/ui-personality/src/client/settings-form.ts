/**
 * The personality row's editable fields, staged over the shared configuration form.
 *
 * The fields live in the `personality` profile row and are volatile, so a save applies to the
 * running provider on the next tool call, learning decision or history write (the provider
 * re-resolves its settings on `loader/volatile-update`). The controller seeds the draft from the
 * accepted snapshot and writes one revision-fenced mutation for the fields that changed.
 *
 * @module @deepseek-ai/dsh-client-ui-personality/settings-form
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'

/** The `personality` row fields this page edits. */
export interface PersonalityRowConfig {
  /** Whether the workspace overlay is read and written. */
  workspaceOverlay?: boolean
  /** Managed-block body budget in UTF-8 bytes. */
  maxBytes?: number
  /** Per-session automatic-learning budget. */
  autoLearn?: {
    /** Automatic writes allowed per session. */
    entries?: number
    /** Automatic-write bytes allowed per session. */
    bytes?: number
  }
  /** Number of history records kept per file. */
  historyLimit?: number
}

/** Every staged field, in render order. */
export const PERSONALITY_SETTINGS_FIELDS = [
  'workspaceOverlay',
  'maxBytes',
  'autoLearnEntries',
  'autoLearnBytes',
  'historyLimit',
] as const

/** One staged field. */
export type PersonalitySettingsField = (typeof PERSONALITY_SETTINGS_FIELDS)[number]

/** What the personality settings block renders. */
export interface PersonalitySettingsState {
  /** Whether the Host serves the row's volatile form to this client. */
  available: boolean
  /** Whether the Host accepts writes. */
  writable: boolean
  /** The staged values, as the reader typed them (booleans as `'on'`/`''`). */
  values: Readonly<Record<PersonalitySettingsField, string>>
  /** Fields whose staged text is not a positive integer. */
  invalid: readonly PersonalitySettingsField[]
  /** Whether any staged value differs from the accepted row. */
  dirty: boolean
  /** Whether a save is crossing the wire. */
  saving: boolean
  /** Whether the last save did not land as staged. */
  failed: boolean
}

/** A whole-row draft as text. */
type Draft = Record<PersonalitySettingsField, string>

/** The empty draft a row that has never written these fields shows. */
const EMPTY: Draft = {
  workspaceOverlay: '',
  maxBytes: '',
  autoLearnEntries: '',
  autoLearnBytes: '',
  historyLimit: '',
}

/** The snapshot a deployment without the settings service reports: no form, writes refused. */
const UNAVAILABLE: ConfigFormSnapshot<PersonalityRowConfig> = Object.freeze({
  status: 'unavailable',
  value: undefined,
  base: undefined,
  user: undefined,
  revision: undefined,
  writable: false,
})

/** Whether one staged field takes a positive integer. */
const NUMERIC: readonly PersonalitySettingsField[] = ['maxBytes', 'autoLearnEntries', 'autoLearnBytes', 'historyLimit']

/**
 * Read the accepted row as text.
 * @param snapshot - the accepted settings snapshot.
 * @returns every field's current text, or the empty draft.
 */
function draftOf(snapshot: ConfigFormSnapshot<PersonalityRowConfig>): Draft {
  const value = snapshot.value
  if (value === undefined) return { ...EMPTY }
  return {
    workspaceOverlay: value.workspaceOverlay === true ? 'on' : '',
    maxBytes: value.maxBytes === undefined ? '' : String(value.maxBytes),
    autoLearnEntries: value.autoLearn?.entries === undefined ? '' : String(value.autoLearn.entries),
    autoLearnBytes: value.autoLearn?.bytes === undefined ? '' : String(value.autoLearn.bytes),
    historyLimit: value.historyLimit === undefined ? '' : String(value.historyLimit),
  }
}

/** Whether one staged numeric field is empty or a positive safe integer. */
function validNumber(text: string): boolean {
  if (text === '') return true
  return /^\d+$/u.test(text) && Number.isSafeInteger(Number(text)) && Number(text) >= 1
}

/** The personality settings controller: staged fields and one revision-fenced save. */
export class PersonalitySettingsController {
  /** The snapshot source the block binds as its render state. */
  readonly store: SnapshotStore<PersonalitySettingsState>

  private draft: Draft = { ...EMPTY }
  private baseline: Draft = { ...EMPTY }
  private saving = false
  private failed = false
  private readonly unsubscribe: () => void

  /**
   * @param form - the shared configuration form of the `personality` row, when the settings
   *   service is composed; omitting it renders the block unavailable and refuses writes.
   */
  constructor(private readonly form: ConfigForm<PersonalityRowConfig> | undefined) {
    this.seed()
    this.store = createSnapshotStore(this.projection())
    this.unsubscribe = form?.subscribe(() => { this.reconcile() }) ?? (() => {})
  }

  /**
   * Stage one field as typed.
   * @param field - which field changed.
   * @param text - the text as typed (`'on'`/`''` for the overlay switch).
   */
  edit(field: PersonalitySettingsField, text: string): void {
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
    for (const field of PERSONALITY_SETTINGS_FIELDS) {
      if (this.draft[field] === this.baseline[field]) continue
      const text = this.draft[field].trim()
      if (field === 'workspaceOverlay') {
        operations.push({ op: 'set', path: ['workspaceOverlay'], value: text === 'on' })
        continue
      }
      if (text === '') {
        operations.push({ op: 'unset', path: this.pathOf(field) })
        continue
      }
      operations.push({ op: 'set', path: this.pathOf(field), value: Number(text) })
    }
    return operations
  }

  /** The settings path of one staged field. */
  private pathOf(field: PersonalitySettingsField): string[] {
    switch (field) {
      case 'workspaceOverlay': return ['workspaceOverlay']
      case 'maxBytes': return ['maxBytes']
      case 'autoLearnEntries': return ['autoLearn', 'entries']
      case 'autoLearnBytes': return ['autoLearn', 'bytes']
      case 'historyLimit': return ['historyLimit']
    }
  }

  /** Whether every staged numeric field parses. */
  private get valid(): boolean {
    return NUMERIC.every(field => validNumber(this.draft[field]))
  }

  /** The invalid staged fields, for the block's inline warnings. */
  private invalidFields(): readonly PersonalitySettingsField[] {
    return NUMERIC.filter(field => !validNumber(this.draft[field]))
  }

  /** Whether a save would write at least one field. */
  private get dirty(): boolean {
    return PERSONALITY_SETTINGS_FIELDS.some(field => this.draft[field] !== this.baseline[field])
  }

  /** The accepted row snapshot, or the unavailable one when no settings service is composed. */
  private accepted(): ConfigFormSnapshot<PersonalityRowConfig> {
    return this.form?.getSnapshot() ?? UNAVAILABLE
  }

  /** Build the block's render state from the accepted section and the staged draft. */
  private projection(): PersonalitySettingsState {
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
