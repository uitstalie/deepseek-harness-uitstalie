/**
 * Public surface of the persona card package.
 * @module @deepseek-ai/dsh-persona
 */

import type { Context } from '@deepseek-ai/cordis'
import { apply as applyProvider } from './provider.ts'
import type { Config } from './provider.ts'

export { PERSONA_SCHEMA, DEFAULT_PERSONA_MAX_BYTES } from './types.ts'
export type {
  ParsePersonaOptions,
  PersonaCard,
  PersonaError,
  PersonaErrorCode,
  PersonaImport,
  PersonaMetadata,
  PersonaResult,
  PersonaStateSchema,
  RenderPersonaOptions,
} from './types.ts'
export { parsePersonaCard, renderPersonaText } from './card.ts'
export { importCharacterCard } from './import.ts'

export { PERSONA_CARDS_DIRECTORY, PERSONA_CARD_SECTION_NAME, PERSONA_CARD_SECTION_ORDER, Config, loadPersonaCards, name, parsePersonaFile } from './provider.ts'
export type { PersonaCards } from './provider.ts'

export {
  PERSONA_COMMAND_NAME,
  PERSONA_COMMAND_USAGE,
  personaCommand,
  registerPersonaCommands,
} from './commands.ts'
export type { PersonaCommandTarget } from './commands.ts'

/** The capability organizer that gates this row. */
export const inject = ['dafeiyu']

/**
 * Mount the persona-card capability provider on a Loader row.
 * @param ctx - plugin context.
 * @param config - the row configuration (`active`, `maxBytes`).
 */
export function apply(ctx: Context, config: Config): void {
  applyProvider(ctx, config)
}
