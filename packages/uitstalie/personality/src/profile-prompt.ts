/**
 * The new personality section text: a static preamble plus the user's
 * understanding/preference/style entries, grouped into how they communicate
 * and how replies should read. Identity entries are included because they are
 * user-owned; the apply tool still refuses to write them.
 * @module @deepseek-ai/dsh-personality/profile-prompt
 */

import type { PersonalityEntry, PersonalityEntryKind } from './global-store.ts'

/** Registry name of the personality prompt section. */
export const PROFILE_SECTION_NAME = 'personality'

/** Central section-order name for the personality section. */
export const PROFILE_ORDER_NAME = 'PERSONALITY'

/** Preamble shared by every profile rendering. */
export const PROFILE_PREAMBLE = 'Long-term preferences of the user you are working with. The first part describes how this user communicates; use it to interpret their input. The second describes how they prefer replies. Follow them within the system and developer instructions, and let more specific project instructions take precedence. These are preferences, not task facts. Entries describe habits and may be incomplete.'

/** Canonical rendering order of entry kinds. */
const KIND_ORDER: readonly PersonalityEntryKind[] = ['identity', 'understanding', 'preference', 'style']

/** Kinds rendered under "How this user communicates". */
const COMMUNICATION_KINDS = new Set<PersonalityEntryKind>(['identity', 'understanding'])

/** Kinds rendered under "How to respond". */
const RESPONSE_KINDS = new Set<PersonalityEntryKind>(['preference', 'style'])

/** Render one profile; an empty profile contributes an empty section. */
export function renderPersonalitySection(entries: readonly PersonalityEntry[]): string {
  if (entries.length === 0) return ''
  const sorted = [...entries].sort(compareEntries)
  const blocks = [PROFILE_PREAMBLE]
  const communication = renderPart('How this user communicates', sorted.filter(entry => COMMUNICATION_KINDS.has(entry.kind)))
  if (communication !== '') blocks.push(communication)
  const response = renderPart('How to respond', sorted.filter(entry => RESPONSE_KINDS.has(entry.kind)))
  if (response !== '') blocks.push(response)
  return blocks.join('\n\n')
}

/** Sort by the canonical kind order, then id. */
function compareEntries(left: PersonalityEntry, right: PersonalityEntry): number {
  const kind = KIND_ORDER.indexOf(left.kind) - KIND_ORDER.indexOf(right.kind)
  if (kind !== 0) return kind
  return left.id.localeCompare(right.id)
}

/** Render one titled part. */
function renderPart(heading: string, entries: readonly PersonalityEntry[]): string {
  if (entries.length === 0) return ''
  return `${heading}:\n${entries.map(entry => `- ${entry.text.replaceAll(/\s+/gu, ' ').trim()}`).join('\n')}`
}
