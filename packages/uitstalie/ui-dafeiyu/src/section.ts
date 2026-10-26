/**
 * The capability list's settings-section identity, shared by the host entry
 * that publishes it and the browser half that registers it.
 *
 * A v2 provider points at its own page by id through `settings.sectionId`;
 * this section is the list those links live in, so its id and order are a
 * contract, not a preference.
 *
 * @module @deepseek-ai/dsh-client-ui-dafeiyu/section
 */

/** The settings section the capability organizer owns. */
export const CAPABILITIES_SETTINGS_SECTION = 'capabilities'

/** Where the section sorts: after the product pages, before provider pages such as `jira`. */
export const CAPABILITIES_SETTINGS_ORDER = 150
