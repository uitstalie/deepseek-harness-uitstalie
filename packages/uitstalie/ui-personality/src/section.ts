/**
 * The identity proposal queue's settings-section identity, shared by the host
 * entry that publishes it and the browser half that registers it.
 *
 * A v2 provider points at its own page by id through `settings.sectionId`; the
 * personality provider publishes this id, so the capability list's link and the
 * registered section cannot drift apart.
 *
 * @module @deepseek-ai/dsh-client-ui-personality/section
 */

/** The settings section the personality provider owns. */
export const PERSONALITY_SETTINGS_SECTION = 'personality'

/** Where the section sorts: after the capability list (`150`) and the Jira page (`200`). */
export const PERSONALITY_SETTINGS_ORDER = 210
