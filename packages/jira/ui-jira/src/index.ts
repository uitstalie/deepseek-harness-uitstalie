/**
 * Where the jira settings section sits, and the keys it writes.
 *
 * Only the placement is settled here: the section id and order are the contract `dafeiyu`'s
 * Capabilities list links to (`settings.sectionId`), so they must not drift. The client plugin that
 * renders the section and the read-only board is not written yet; when it lands it imports these
 * two values instead of repeating them.
 *
 * @module @deepseek-ai/dsh-client-ui-jira
 */

/** The settings section the jira capability owns; `dafeiyu` links to it by this id. */
export const JIRA_SETTINGS_SECTION = 'jira'

/** Where the section sorts in the settings list (the vision/board sections come earlier). */
export const JIRA_SETTINGS_ORDER = 200

/** The row keys the section edits: the ledger location, the audit host and the push switch. */
export const JIRA_SETTINGS_FIELDS = Object.freeze(['root', 'host', 'push.enabled'] as const)

/** One settings field the section edits. */
export type JiraSettingsField = (typeof JIRA_SETTINGS_FIELDS)[number]
