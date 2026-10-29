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
  DIRECTOR_COMMAND_NAME,
  DIRECTOR_COMMAND_USAGE,
  directorCommand,
  PERSONA_COMMAND_NAME,
  PERSONA_COMMAND_USAGE,
  personaCommand,
  registerDirectorCommand,
  registerPersonaCommands,
} from './commands.ts'
export type { DirectorCommandTarget, PersonaCommandTarget } from './commands.ts'

export {
  DIRECTOR_NOTE_CLEARED,
  DIRECTOR_NOTE_MAX_BYTES,
  DIRECTOR_NOTE_SECTION_NAME,
  DIRECTOR_NOTE_TITLE,
  directorNoteMessage,
  isDirectorNoteSource,
  normalizeDirectorNote,
  renderDirectorNote,
  syncDirectorNote,
} from './director.ts'
export type { DirectorNoteSource } from './director.ts'

export {
  PERSONA_STATE_HISTORY_LIMIT,
  PERSONA_STATE_MAX_BYTES,
  PERSONA_STATE_SECTION_NAME,
  PERSONA_STATE_TITLE,
  PersonaStateStore,
  isPersonaStateSource,
  personaStateMessage,
  personaStateTool,
  renderPersonaStateText,
  syncPersonaStateMessage,
  validatePersonaStateValue,
} from './state.ts'
export type {
  PersonaStateMutation,
  PersonaStateRecord,
  PersonaStateRevision,
  PersonaStateSource,
  PersonaStateTarget,
  PersonaStateValues,
} from './state.ts'

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
