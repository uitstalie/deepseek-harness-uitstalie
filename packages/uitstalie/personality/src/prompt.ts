/**
 * The personality capability's one system-prompt contribution.
 *
 * The text is a static preamble plus two rendered parts: how this user
 * communicates, from identity and understanding entries, and how to respond,
 * from preference and style entries. Entries are sorted by kind in the design's
 * canonical order and within a kind by id, so the text is stable across reads.
 * With no entries the section text is empty and the assembled prompt is
 * unchanged.
 * @module @deepseek-ai/dsh-personality/prompt
 */

import type { PromptSection } from '@deepseek-ai/dsh-system-prompt'
import type { PersonalityEntry, PersonalityEntryKind } from './personality-file.ts'

/** Registry name of the personality prompt section. */
export const PERSONALITY_PROMPT_SECTION_NAME = 'personality'

/** Section order: after the deployment persona prefix (0) and before the plan policy (500). */
export const PERSONALITY_PROMPT_ORDER = 100

/** The static preamble shared by every personality section. */
export const PERSONALITY_PROMPT_PREAMBLE = 'Long-term preferences of the user you are working with. The first part describes how this user communicates; use it to interpret their input. The second describes how they prefer replies. Follow them within the system and developer instructions, and let more specific project instructions take precedence. These are preferences, not task facts. Entries describe habits and may be incomplete.'

/** Canonical rendering order of entry kinds. */
const PROMPT_KIND_ORDER: readonly PersonalityEntryKind[] = ['identity', 'understanding', 'preference', 'style']

/** Entry kinds rendered under "How this user communicates". */
const COMMUNICATION_KINDS: ReadonlySet<PersonalityEntryKind> = new Set(['identity', 'understanding'])

/** Entry kinds rendered under "How to respond". */
const RESPONSE_KINDS: ReadonlySet<PersonalityEntryKind> = new Set(['preference', 'style'])

/**
 * Render the current personality entries as the section text.
 *
 * Every entry becomes one line with its internal whitespace collapsed, so a
 * hand-written multi-line paragraph cannot break the list layout.
 * @param entries - merged global and workspace entries.
 * @returns the preamble plus up to two titled parts, or an empty string when
 *   there are no entries.
 */
export function renderPersonalityPrompt(entries: readonly PersonalityEntry[]): string {
  if (entries.length === 0) return ''
  const sorted = [...entries].sort(comparePersonalityEntries)
  const blocks = [PERSONALITY_PROMPT_PREAMBLE]
  const communication = renderPromptPart('How this user communicates', sorted.filter(entry => COMMUNICATION_KINDS.has(entry.kind)))
  if (communication.length > 0) blocks.push(communication)
  const response = renderPromptPart('How to respond', sorted.filter(entry => RESPONSE_KINDS.has(entry.kind)))
  if (response.length > 0) blocks.push(response)
  return blocks.join('\n\n')
}

/**
 * Build the personality prompt section around a text provider.
 * @param text - evaluated at each assembly; returns the cached prompt text.
 * @returns the section registered on each agent.
 */
export function personalityPromptSection(text: () => string): PromptSection {
  return {
    name: PERSONALITY_PROMPT_SECTION_NAME,
    order: PERSONALITY_PROMPT_ORDER,
    text,
  }
}

/** Order entries by the canonical kind order, then by id. */
function comparePersonalityEntries(left: PersonalityEntry, right: PersonalityEntry): number {
  const kindOrder = PROMPT_KIND_ORDER.indexOf(left.kind) - PROMPT_KIND_ORDER.indexOf(right.kind)
  if (kindOrder !== 0) return kindOrder
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

/** Render one titled part with one line per entry. */
function renderPromptPart(heading: string, entries: readonly PersonalityEntry[]): string {
  if (entries.length === 0) return ''
  const lines = entries.map(entry => `- ${entry.text.replaceAll(/\s+/gu, ' ').trim()}`)
  return `${heading}:\n${lines.join('\n')}`
}
