/**
 * The jira bundle is a composition patch, not a runtime plugin: installing it inserts the ledger
 * rows into the target profile's `cordis.yml`. This module exists so the package has a typed entry
 * and so the row ids have one home that the patch and a test can read.
 *
 * @module @deepseek-ai/dsh-jira-app
 */

/** The rows this bundle inserts, in patch order. */
export const JIRA_BUNDLE_ROWS = Object.freeze([
  Object.freeze({ id: 'jira-service', name: '@deepseek-ai/dsh-jira-service', enabled: true }),
  Object.freeze({ id: 'jira-agent', name: '@deepseek-ai/dsh-jira-agent', enabled: true }),
  Object.freeze({ id: 'jira-ui', name: '@deepseek-ai/dsh-client-ui-jira', enabled: true }),
] as const)

/** One row this bundle inserts. */
export type JiraBundleRow = (typeof JIRA_BUNDLE_ROWS)[number]
