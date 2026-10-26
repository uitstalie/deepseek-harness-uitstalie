/**
 * The settings section's identity, shared by the host entry that publishes it and the browser
 * half that registers it.
 *
 * `dafeiyu`'s Capabilities list links to this section by id (`settings.sectionId`), so the id
 * and order are a contract, not a preference.
 *
 * @module @deepseek-ai/dsh-client-ui-jira/section
 */

/** The settings section the jira capability owns; `dafeiyu` links to it by this id. */
export const JIRA_SETTINGS_SECTION = 'jira'

/** Where the section sorts in the settings list (the vision/board sections come earlier). */
export const JIRA_SETTINGS_ORDER = 200

/** The row keys the section shows: the ledger location, the audit host and the push switch. */
export const JIRA_SETTINGS_FIELDS = Object.freeze(['root', 'host', 'push.enabled'] as const)

/** One settings field the section shows. */
export type JiraSettingsField = (typeof JIRA_SETTINGS_FIELDS)[number]
