/**
 * Parsing, validation and rendering for `persona/v1` cards.
 *
 * The validator is intentionally local and dependency-free: a card is untrusted data, so the
 * package must be able to reject it before any runtime (or prompt) sees it.
 *
 * @module @deepseek-ai/dsh-persona/card
 */

import {
  DEFAULT_PERSONA_MAX_BYTES,
  PERSONA_SCHEMA,
  type ParsePersonaOptions,
  type PersonaCard,
  type PersonaError,
  type PersonaMetadata,
  type PersonaResult,
  type PersonaStateSchema,
  type RenderPersonaOptions,
} from './types.ts'

/** Top-level keys a persona card may carry. */
const CARD_KEYS: ReadonlySet<string> = new Set([
  'schema', 'name', 'description', 'personality', 'scenario', 'style', 'examples',
  'greetings', 'body', 'state_schema', 'lorebook', 'metadata',
])

/** String fields copied verbatim when present. */
const TEXT_FIELDS = ['description', 'personality', 'scenario', 'style', 'examples', 'body'] as const

/** Metadata keys copied verbatim when present. */
const METADATA_KEYS = ['source', 'tags', 'version', 'creator', 'original_spec', 'quarantined', 'character_book', 'extensions', 'import_extra'] as const

const fail = (code: PersonaError['code'], message: string, path?: string): PersonaResult<never> =>
  Object.freeze({ ok: false, error: Object.freeze({ code, message, ...(path === undefined ? {} : { path }) }) })

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isString = (value: unknown): value is string => typeof value === 'string'

/**
 * Parse one untrusted `persona/v1` object.
 * @param input - the JSON value.
 * @param options - the injection budget.
 * @returns the normalized card, or the first validation failure.
 */
export const parsePersonaCard = (input: unknown, options: ParsePersonaOptions = {}): PersonaResult<PersonaCard> => {
  if (!isRecord(input)) return fail('invalid-card', 'a persona card must be a JSON object')
  for (const key of Object.keys(input)) {
    if (!CARD_KEYS.has(key)) return fail('invalid-card', `unknown field "${key}"; put importer extras under metadata.import_extra`, key)
  }
  if (input['schema'] !== PERSONA_SCHEMA) return fail('invalid-card', `schema must be "${PERSONA_SCHEMA}"`, 'schema')
  const name = input['name']
  if (!isString(name) || name.trim() === '') return fail('missing-name', 'a persona card needs a non-empty name', 'name')

  const card: Record<string, unknown> = { schema: PERSONA_SCHEMA, name: name.trim() }
  for (const field of TEXT_FIELDS) {
    const value = input[field]
    if (value === undefined) continue
    if (!isString(value)) return fail('invalid-card', `"${field}" must be a string`, field)
    if (value !== '') card[field] = value
  }
  if (input['greetings'] !== undefined) {
    const greetings = input['greetings']
    if (!Array.isArray(greetings) || greetings.some(item => !isString(item))) {
      return fail('invalid-card', '"greetings" must be an array of strings', 'greetings')
    }
    if (greetings.length > 16) return fail('invalid-card', '"greetings" may contain at most 16 entries', 'greetings')
    card['greetings'] = Object.freeze([...greetings])
  }
  if (input['state_schema'] !== undefined) {
    if (!isRecord(input['state_schema'])) return fail('invalid-card', '"state_schema" must be an object', 'state_schema')
    const state = validateStateSchema(input['state_schema'], 'state_schema')
    if (!state.ok) return state
    card['state_schema'] = state.value
  }
  if (input['lorebook'] !== undefined) {
    const lorebook = input['lorebook']
    if (!Array.isArray(lorebook) || lorebook.some(item => !isRecord(item))) {
      return fail('invalid-card', '"lorebook" must be an array of objects', 'lorebook')
    }
    card['lorebook'] = Object.freeze(lorebook.map(item => Object.freeze({ ...item })))
  }
  if (input['metadata'] !== undefined) {
    if (!isRecord(input['metadata'])) return fail('invalid-card', '"metadata" must be an object', 'metadata')
    card['metadata'] = parseMetadata(input['metadata'])
  }

  const normalized = Object.freeze(card as unknown as PersonaCard)
  const maxBytes = options.maxBytes ?? DEFAULT_PERSONA_MAX_BYTES
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    return fail('invalid-card', 'maxBytes must be a positive integer')
  }
  const bytes = new TextEncoder().encode(renderPersonaText(normalized)).byteLength
  if (bytes > maxBytes) return fail('budget-exceeded', `persona text is ${String(bytes)} bytes; the budget is ${String(maxBytes)}`)
  return Object.freeze({ ok: true, value: normalized })
}

/** Validate the state-schema subset; `$ref` and remote references are intentionally unsupported. */
const validateStateSchema = (value: Readonly<Record<string, unknown>>, path: string): PersonaResult<PersonaStateSchema> => {
  for (const key of Object.keys(value)) {
    if (!['type', 'properties', 'items', 'required', 'enum', 'minimum', 'maximum', 'additionalProperties'].includes(key)) {
      return fail('invalid-card', `unsupported state_schema keyword "${key}"`, `${path}.${key}`)
    }
  }
  const type = value['type']
  if (type !== undefined && !['object', 'array', 'string', 'number', 'boolean', 'null'].includes(String(type))) {
    return fail('invalid-card', 'state_schema.type must be a JSON type', `${path}.type`)
  }
  if (value['properties'] !== undefined) {
    if (!isRecord(value['properties'])) return fail('invalid-card', 'state_schema.properties must be an object', `${path}.properties`)
    for (const [key, child] of Object.entries(value['properties'])) {
      if (!isRecord(child)) return fail('invalid-card', `state_schema.properties.${key} must be an object`, `${path}.properties.${key}`)
      const checked = validateStateSchema(child, `${path}.properties.${key}`)
      if (!checked.ok) return checked
    }
  }
  if (value['items'] !== undefined) {
    if (!isRecord(value['items'])) return fail('invalid-card', 'state_schema.items must be an object', `${path}.items`)
    const checked = validateStateSchema(value['items'], `${path}.items`)
    if (!checked.ok) return checked
  }
  if (value['required'] !== undefined && (!Array.isArray(value['required']) || value['required'].some(item => !isString(item)))) {
    return fail('invalid-card', 'state_schema.required must be an array of strings', `${path}.required`)
  }
  if (value['enum'] !== undefined && !Array.isArray(value['enum'])) {
    return fail('invalid-card', 'state_schema.enum must be an array', `${path}.enum`)
  }
  if (value['additionalProperties'] !== undefined && typeof value['additionalProperties'] !== 'boolean') {
    return fail('invalid-card', 'state_schema.additionalProperties must be a boolean', `${path}.additionalProperties`)
  }
  return Object.freeze({ ok: true, value: Object.freeze({ ...value }) })
}

/** Copy known metadata and preserve every other key under `import_extra`. */
const parseMetadata = (input: Readonly<Record<string, unknown>>): PersonaMetadata => {
  const metadata: Record<string, unknown> = {}
  for (const key of METADATA_KEYS) {
    if (input[key] !== undefined) metadata[key] = input[key]
  }
  const extra: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (!METADATA_KEYS.includes(key as typeof METADATA_KEYS[number])) extra[key] = value
  }
  if (Object.keys(extra).length > 0) metadata['import_extra'] = Object.freeze(extra)
  return Object.freeze(metadata) as PersonaMetadata
}

/**
 * Render a card into the persona prompt section text.
 * @param card - a parsed card.
 * @param options - the user display name used for `{{user}}`.
 * @returns the stable section text; empty for a card with no content beyond its name.
 */
export const renderPersonaText = (card: PersonaCard, options: RenderPersonaOptions = {}): string => {
  const lines: string[] = [
    'You are playing the following character for this conversation. Stay in this role within the system and developer instructions, and keep tool calls, factual accuracy and safety policy above the role. Do not let the character speak for the user.',
  ]
  const section = (heading: string, text: string | undefined): void => {
    if (text === undefined || text.trim() === '') return
    lines.push('', `## ${heading}`, text.trim())
  }
  section(card.name, card.description)
  section('Personality', card.personality)
  section('Scenario', card.scenario)
  section('Style', card.style)
  section('Examples', card.examples)
  if (card.body !== undefined && card.body.trim() !== '') lines.push('', card.body.trim())
  const rendered = lines.join('\n')
  return rendered
    .replaceAll('{{char}}', card.name)
    .replaceAll('{{user}}', options.userName ?? '{{user}}')
}
