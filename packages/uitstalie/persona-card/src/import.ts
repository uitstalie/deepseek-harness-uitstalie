/**
 * Safe Character Card V2/V3 JSON import.
 *
 * Cards are third-party prompt material. Prompt overrides (`system_prompt`,
 * `post_history_instructions`) are quarantined instead of injected; assets, group greetings and
 * unknown fields are preserved under metadata rather than discarded.
 *
 * @module @deepseek-ai/dsh-persona/import
 */

import { parsePersonaCard } from './card.ts'
import {
  PERSONA_SCHEMA,
  type ParsePersonaOptions,
  type PersonaImport,
  type PersonaResult,
} from './types.ts'

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asString = (value: unknown): string | undefined => typeof value === 'string' && value !== '' ? value : undefined

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

/** Remove ` <START>` separators that only make sense to SillyTavern's example renderer. */
const stripStart = (text: string): string => text.replaceAll(/^<START>\s*$/gmu, '').replaceAll(/\n{3,}/gu, '\n\n').trim()

/** Fields this importer consumes; everything else is kept as importer extra metadata. */
const MAPPED_KEYS = new Set([
  'name', 'nickname', 'description', 'personality', 'scenario', 'mes_example', 'first_mes',
  'alternate_greetings', 'system_prompt', 'post_history_instructions', 'character_book',
  'tags', 'creator', 'character_version', 'extensions', 'assets', 'group_only_greetings',
])

/**
 * Import a Character Card V2 or V3 JSON value.
 * @param input - the parsed card JSON (`{ spec, data }`).
 * @param options - the persona injection budget.
 * @returns the mapped persona card, warnings and quarantined field names.
 */
export const importCharacterCard = (
  input: unknown,
  options: ParsePersonaOptions = {},
): PersonaResult<PersonaImport> => {
  if (!isRecord(input)) return Object.freeze({ ok: false, error: Object.freeze({ code: 'invalid-import', message: 'a character card must be a JSON object' }) })
  const spec = asString(input['spec'])
  if (spec !== 'chara_card_v2' && spec !== 'chara_card_v3') {
    return Object.freeze({ ok: false, error: Object.freeze({ code: 'unsupported-spec', message: 'only Character Card V2/V3 JSON is supported; expected spec "chara_card_v2" or "chara_card_v3"' }) })
  }
  const data = input['data']
  if (!isRecord(data)) return Object.freeze({ ok: false, error: Object.freeze({ code: 'invalid-import', message: 'the card needs a "data" object' }) })

  const warnings: string[] = []
  const name = asString(data['nickname']) ?? asString(data['name'])
  if (name === undefined) return Object.freeze({ ok: false, error: Object.freeze({ code: 'invalid-import', message: 'the card has no name or nickname', path: 'data.name' }) })

  const first = asString(data['first_mes'])
  const alternates = asStringArray(data['alternate_greetings'])
  const greetings = [first, ...alternates].filter((item): item is string => item !== undefined && item.trim() !== '')
  if (greetings.length > 16) warnings.push(`kept the first 16 of ${String(greetings.length)} greetings`)

  const quarantined: Record<string, string> = {}
  for (const field of ['system_prompt', 'post_history_instructions'] as const) {
    const value = asString(data[field])
    if (value === undefined) continue
    quarantined[field] = value
    warnings.push(`${field} was quarantined: it never overrides system or developer instructions`)
  }
  if (asStringArray(data['assets']).length > 0) warnings.push('assets were preserved in metadata but are not used')
  if (asStringArray(data['group_only_greetings']).length > 0) warnings.push('group-only greetings were preserved in metadata but are not used')

  const extra: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    if (!MAPPED_KEYS.has(key)) extra[key] = value
  }

  const card: Record<string, unknown> = {
    schema: PERSONA_SCHEMA,
    name,
    ...(asString(data['description']) === undefined ? {} : { description: asString(data['description']) }),
    ...(asString(data['personality']) === undefined ? {} : { personality: asString(data['personality']) }),
    ...(asString(data['scenario']) === undefined ? {} : { scenario: asString(data['scenario']) }),
    ...(asString(data['mes_example']) === undefined ? {} : { examples: stripStart(asString(data['mes_example']) as string) }),
    ...(greetings.length === 0 ? {} : { greetings: greetings.slice(0, 16) }),
    metadata: {
      source: 'import',
      original_spec: spec,
      ...(Object.keys(quarantined).length === 0 ? {} : { quarantined }),
      ...(data['character_book'] === undefined ? {} : { character_book: data['character_book'] }),
      ...(data['extensions'] === undefined ? {} : { extensions: data['extensions'] }),
      ...(asStringArray(data['tags']).length === 0 ? {} : { tags: asStringArray(data['tags']) }),
      ...(asString(data['creator']) === undefined ? {} : { creator: asString(data['creator']) }),
      ...(asString(data['character_version']) === undefined ? {} : { version: asString(data['character_version']) }),
      ...(Object.keys(extra).length === 0 ? {} : { import_extra: extra }),
    },
  }

  const parsed = parsePersonaCard(card, options)
  if (!parsed.ok) return parsed
  return Object.freeze({
    ok: true,
    value: Object.freeze({
      card: parsed.value,
      warnings: Object.freeze(warnings),
      quarantined: Object.freeze(Object.keys(quarantined)),
    }),
  })
}
