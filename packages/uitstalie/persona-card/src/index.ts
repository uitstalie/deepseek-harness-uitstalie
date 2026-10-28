/**
 * Public surface of the persona card package.
 * @module @deepseek-ai/dsh-persona
 */

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
