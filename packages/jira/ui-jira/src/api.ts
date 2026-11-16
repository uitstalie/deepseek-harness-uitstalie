/**
 * Host half of the jira browser surface.
 *
 * Every behavior is in the browser half; the node half is an empty plugin body, so the `jira-ui`
 * row loads through the same package whose client bundle the Web host serves.
 *
 * @module @deepseek-ai/dsh-client-ui-jira
 */

export { JIRA_SETTINGS_FIELDS, JIRA_SETTINGS_ORDER, JIRA_SETTINGS_SECTION } from './section.ts'
export type { JiraSettingsField } from './section.ts'

/** Host plugin body — all behavior lives in the browser half. */
export function apply(): void {}
