/** Stable persona card format and default budget; runtime values live outside `types.ts`. */

/** The card format this package reads and writes. */
export const PERSONA_SCHEMA = 'persona/v1'

/** Default injection budget for one card, in UTF-8 bytes. */
export const DEFAULT_PERSONA_MAX_BYTES = 4096
