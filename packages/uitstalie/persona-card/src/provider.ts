/**
 * The persona-card capability provider: mount one role-play card on every agent.
 *
 * This is the first runtime slice: a global card directory, one configured active card and one
 * stable system-prompt section. Per-session selection and `/persona` commands are follow-ups;
 * the provider currently reads its selection from the row configuration.
 *
 * @module @deepseek-ai/dsh-persona-card/provider
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import type { CapabilityContribution } from '@deepseek-ai/dsh-dafeiyu'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt'
import z from '@deepseek-ai/schemastery'
import { parse } from 'yaml'
import { parsePersonaCard, renderPersonaText } from './card.ts'
import { DEFAULT_PERSONA_MAX_BYTES, type PersonaCard, type PersonaResult } from './types.ts'

/** Cordis plugin name. */
export const name = 'persona-card'
/** The organizer wires the contribution; no other service is required. */
export const inject = ['dafeiyu']

/** The directory under `$DSH_HOME` that holds `*.md` cards. */
export const PERSONA_CARDS_DIRECTORY = 'persona'

/** The system-prompt section name: after the deployment prefix, before `personality`. */
export const PERSONA_CARD_SECTION_NAME = 'persona'
/** The section order: after the deployment prefix, before `personality`. */
export const PERSONA_CARD_SECTION_ORDER = 50

/** Row configuration, accepting live references or plain test values. */
export interface Config {
  /** Card id (file name without `.md`); empty disables the section. */
  readonly active?: Volatile<string> | string | undefined
  /** Injection budget for one card, in UTF-8 bytes. */
  readonly maxBytes?: Volatile<number> | number | undefined
}

/** Row configuration schema. */
export const Config = z.object({
  /** Card id (file name without `.md`); empty disables the section. */
  active: z.string().default('').volatile(),
  /** Injection budget for one card, in UTF-8 bytes. */
  maxBytes: z.number().step(1).min(1).default(DEFAULT_PERSONA_MAX_BYTES).volatile(),
})

/** One mounted card and the files skipped while loading. */
export interface PersonaCards {
  readonly cards: ReadonlyMap<string, PersonaCard>
  readonly warnings: readonly string[]
}

/** Read one live row value. */
const current = <T>(value: Volatile<T> | T | undefined): T | undefined => {
  if (value === undefined) return undefined
  if (typeof value === 'object' && value !== null && typeof (value as { get?: unknown }).get === 'function') {
    return (value as Volatile<T>).get() as T
  }
  return value as T
}

/**
 * Parse one Markdown card file: YAML frontmatter plus optional body.
 * @param text - the file contents.
 * @param options - the injection budget.
 * @returns the parsed card, or the validation failure.
 */
export const parsePersonaFile = (text: string, options: { maxBytes?: number } = {}): PersonaResult<PersonaCard> => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u.exec(text)
  if (match === null) {
    return Object.freeze({ ok: false, error: Object.freeze({ code: 'invalid-card', message: 'a card file needs a YAML frontmatter block' }) })
  }
  let front: unknown
  try {
    front = parse(match[1] ?? '')
  } catch (error: unknown) {
    return Object.freeze({ ok: false, error: Object.freeze({ code: 'invalid-card', message: `invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}` }) })
  }
  if (typeof front !== 'object' || front === null || Array.isArray(front)) {
    return Object.freeze({ ok: false, error: Object.freeze({ code: 'invalid-card', message: 'frontmatter must be a YAML object' }) })
  }
  const body = (match[2] ?? '').trim()
  return parsePersonaCard({ ...(front as Record<string, unknown>), ...(body === '' ? {} : { body }) }, options)
}

/**
 * Read every `$DSH_HOME/persona/*.md` card.
 * @param options - the injection budget and an optional logger for skipped files.
 * @returns the cards by id and one warning per skipped file.
 */
export const loadPersonaCards = async (
  options: { maxBytes?: number; warn?: (message: string) => void } = {},
): Promise<PersonaCards> => {
  const cards = new Map<string, PersonaCard>()
  const warnings: string[] = []
  const directory = join(resolveDshHome(), PERSONA_CARDS_DIRECTORY)
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.freeze({ cards, warnings })
    throw error
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const id = entry.name.slice(0, -3)
    try {
      const parsed = parsePersonaFile(await readFile(join(directory, entry.name), 'utf8'), options)
      if (parsed.ok) cards.set(id, parsed.value)
      else {
        const message = `ignoring persona card ${entry.name}: ${parsed.error.message}`
        warnings.push(message)
        options.warn?.(message)
      }
    } catch (error: unknown) {
      const message = `could not read persona card ${entry.name}: ${error instanceof Error ? error.message : String(error)}`
      warnings.push(message)
      options.warn?.(message)
    }
  }
  return Object.freeze({ cards, warnings: Object.freeze(warnings) })
}

/**
 * Register the capability with the organizer.
 * @param ctx - the plugin context.
 * @param config - the row configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const active = () => current(config.active) ?? ''
  const maxBytes = () => current(config.maxBytes) ?? DEFAULT_PERSONA_MAX_BYTES
  const registration = ctx.dafeiyu.register({
    id: 'persona',
    contractVersion: 2,
    label: 'Persona',
    description: 'Role-play character card injected as one stable prompt section',
    config: { active: active(), maxBytes: maxBytes() },
    enabledByDefault: false,
    create: async (): Promise<CapabilityContribution> => {
      let text = ''
      try {
        const loaded = await loadPersonaCards({ maxBytes: maxBytes(), warn: message => ctx.logger.warn('persona: %s', message) })
        const card = loaded.cards.get(active())
        if (card !== undefined) text = renderPersonaText(card)
        else if (active() !== '') ctx.logger.warn('persona: active card %s was not found', active())
      } catch (error: unknown) {
        ctx.logger.warn('persona: could not load cards: %s', error instanceof Error ? error.message : String(error))
      }
      const section: PromptSection = {
        name: PERSONA_CARD_SECTION_NAME,
        order: PERSONA_CARD_SECTION_ORDER,
        text: () => text,
      }
      return { scope: 'all', promptSections: () => [section] }
    },
  })
  ctx.effect(() => registration, 'persona-card.register()')
}
