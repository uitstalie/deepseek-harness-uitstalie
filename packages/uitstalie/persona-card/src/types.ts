/**
 * The persona card contract: the stable assistant-side role for one conversation.
 *
 * This is deliberately separate from `personality`: that layer describes the user and their
 * reply preferences, while a persona describes who the assistant is playing. A card never
 * overrides system or developer instructions; it is lower-priority performance material.
 *
 * @module @deepseek-ai/dsh-persona/types
 */

/** The card format this package reads and writes. */
export const PERSONA_SCHEMA = 'persona/v1'

/** Default injection budget for one card, in UTF-8 bytes. */
export const DEFAULT_PERSONA_MAX_BYTES = 4096

/** A failed parse or import. */
export type PersonaErrorCode =
  | 'invalid-card'
  | 'missing-name'
  | 'budget-exceeded'
  | 'invalid-import'
  | 'unsupported-spec'

/** One structured failure; callers switch on `code`, not on the message. */
export interface PersonaError {
  readonly code: PersonaErrorCode
  readonly message: string
  /** Dotted path of the offending field, when the failure names one. */
  readonly path?: string
}

/** A parse result. */
export type PersonaResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: PersonaError }>

/** The JSON Schema subset a persona may declare for its session state. */
export type PersonaStateSchema = Readonly<Record<string, unknown>>

/** Free-form metadata kept across imports; unknown keys survive here. */
export interface PersonaMetadata {
  readonly source?: 'user' | 'import'
  readonly tags?: readonly string[]
  readonly version?: string
  readonly creator?: string
  readonly original_spec?: string
  /** Imported prompt overrides that must never reach the system/developer slots. */
  readonly quarantined?: Readonly<Record<string, string>>
  /** Raw Character Book or other importer-only payloads, kept but not activated. */
  readonly character_book?: unknown
  readonly extensions?: Readonly<Record<string, unknown>>
  readonly import_extra?: Readonly<Record<string, unknown>>
}

/** One persona card in the `persona/v1` shape. */
export interface PersonaCard {
  readonly schema: typeof PERSONA_SCHEMA
  readonly name: string
  readonly description?: string
  readonly personality?: string
  readonly scenario?: string
  readonly style?: string
  readonly examples?: string
  readonly greetings?: readonly string[]
  /** Optional Markdown body from a card file; appended to the rendered prompt. */
  readonly body?: string
  readonly state_schema?: PersonaStateSchema
  /** Reserved for a future role-specific lorebook; not activated by this package. */
  readonly lorebook?: readonly Readonly<Record<string, unknown>>[]
  readonly metadata?: PersonaMetadata
}

/** The parts of an imported card a caller should surface to the user. */
export interface PersonaImport {
  readonly card: PersonaCard
  /** Human-readable notes: stripped fields, dropped assets, truncations. */
  readonly warnings: readonly string[]
  /** Names of imported fields that were quarantined instead of injected. */
  readonly quarantined: readonly string[]
}

/** Options for {@link parsePersonaCard}. */
export interface ParsePersonaOptions {
  /** Injection budget in UTF-8 bytes; defaults to {@link DEFAULT_PERSONA_MAX_BYTES}. */
  readonly maxBytes?: number
}

/** Options for rendering a card into the system-prompt section. */
export interface RenderPersonaOptions {
  /** Replacement for `{{user}}`; left literal when omitted. */
  readonly userName?: string
}
