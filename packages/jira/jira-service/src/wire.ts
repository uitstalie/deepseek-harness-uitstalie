/**
 * The `jira-core` domain values as the browser reads them.
 *
 * The service types carry branded ids, timestamps and identities, and the UI has no use for the
 * brands: every value below is a plain JSON structure with `string` fields, so a Remote result
 * survives serialization and a client can render it without importing the ledger's types. The
 * mapping is total and pure — one function per structure, no defaults, no dropped fields.
 *
 * @module @deepseek-ai/dsh-jira-service/wire
 */

import { entities, kbsearch, list } from '@deepseek-ai/dsh-jira-core'
import type {
  JiraBoardCountsView,
  JiraBoardGroupView,
  JiraBoardView,
  JiraIssueDetailView,
  JiraIssueLinkView,
  JiraIssueRowView,
  JiraKbHitView,
  JiraKbSearchView,
  JiraStatus,
  JiraStatusView,
  JiraSyncView,
  SyncRecord,
} from './types.ts'

/**
 * One push outcome as `remote.jira.status()` reports it.
 * @param record - the last attempt the service recorded.
 * @returns the attempt without its branded timestamp.
 */
export const syncViewOf = (record: SyncRecord): JiraSyncView => Object.freeze({
  at: record.at,
  outcome: record.outcome,
  ...(record.error === undefined ? {} : { error: record.error }),
})

/**
 * The ledger's state as `remote.jira.status()` reports it.
 * @param status - the service's synchronous snapshot.
 * @returns the snapshot with its last attempt projected.
 */
export const statusViewOf = (status: JiraStatus): JiraStatusView => Object.freeze({
  root: status.root,
  machineId: status.machineId,
  pushEnabled: status.pushEnabled,
  lastSync: status.lastSync === null ? null : syncViewOf(status.lastSync),
  pending: status.pending,
})

/**
 * One list row.
 * @param item - the row the list built.
 * @returns the row as plain JSON.
 */
export const rowViewOf = (item: list.ListItem): JiraIssueRowView => Object.freeze({
  key: item.key,
  project: item.project,
  issueType: item.issueType,
  status: item.status,
  priority: item.priority,
  summary: item.summary,
  tags: item.tags,
  ...(item.assignee === undefined ? {} : { assignee: item.assignee }),
  updatedAt: item.updatedAt,
  revision: item.revision,
  blocked: item.blocked,
})

/**
 * One board column.
 * @param group - the column the list built.
 * @returns the column with its rows projected.
 */
export const groupViewOf = (group: list.ListGroup): JiraBoardGroupView => Object.freeze({
  name: group.name,
  kind: group.kind,
  project: group.project,
  ...(group.status === undefined ? {} : { status: group.status }),
  items: Object.freeze(group.items.map(rowViewOf)),
})

/**
 * What `remote.jira.board()` and `remote.jira.list()` return.
 * @param result - the list the service built.
 * @returns the board with every row and count projected.
 */
export const boardViewOf = (result: list.ListResult): JiraBoardView => Object.freeze({
  items: Object.freeze(result.items.map(rowViewOf)),
  groups: Object.freeze(result.groups.map(groupViewOf)),
  counts: countsViewOf(result.counts),
  truncated: result.truncated,
  limit: result.limit,
})

/**
 * The counts over everything the filters matched.
 * @param counts - the list's counts.
 * @returns the counts as plain JSON.
 */
export const countsViewOf = (counts: list.ListCounts): JiraBoardCountsView => Object.freeze({
  matched: counts.matched,
  returned: counts.returned,
  remaining: counts.remaining,
  byStatus: Object.freeze({ ...counts.byStatus }),
  blocked: counts.blocked,
})

/**
 * One outgoing link.
 * @param link - the link the issue carries.
 * @returns the link as plain JSON.
 */
export const linkViewOf = (link: entities.Link): JiraIssueLinkView =>
  Object.freeze({ type: link.type, target: link.target })

/**
 * What `remote.jira.get()` returns.
 * @param issue - the decoded issue.
 * @returns the issue's frontmatter fields and body as plain JSON.
 */
export const detailViewOf = (issue: entities.Issue): JiraIssueDetailView => Object.freeze({
  key: issue.key,
  project: issue.project,
  issueType: issue.issueType,
  status: issue.status,
  summary: issue.summary,
  priority: issue.priority,
  tags: issue.tags,
  links: Object.freeze(issue.links.map(linkViewOf)),
  ...(issue.note === undefined ? {} : { note: issue.note }),
  ...(issue.resolution === undefined ? {} : { resolution: issue.resolution }),
  ...(issue.resolutionNote === undefined ? {} : { resolutionNote: issue.resolutionNote }),
  revision: issue.revision,
  createdAt: issue.createdAt,
  updatedAt: issue.updatedAt,
  reporter: issue.reporter,
  ...(issue.assignee === undefined ? {} : { assignee: issue.assignee }),
  ...(issue.claimedAt === undefined ? {} : { claimedAt: issue.claimedAt }),
  ...(issue.leaseExpiresAt === undefined ? {} : { leaseExpiresAt: issue.leaseExpiresAt }),
  kbRefs: issue.kbRefs,
  conflicted: issue.conflicted,
  body: issue.body,
})

/**
 * One knowledge hit.
 * @param hit - the hit the search ranked.
 * @returns the hit as plain JSON.
 */
export const kbHitViewOf = (hit: kbsearch.KbHit): JiraKbHitView => Object.freeze({
  key: hit.key,
  title: hit.title,
  domain: hit.domain,
  kbType: hit.kbType,
  file: hit.file,
  line: hit.line,
  snippet: hit.snippet,
  titleMatch: hit.titleMatch,
  matches: hit.matches,
  capturedAt: hit.capturedAt,
})

/**
 * What `remote.jira.kbSearch()` returns.
 * @param result - the search the service ran.
 * @returns the ranked hits with the search's counts.
 */
export const kbSearchViewOf = (result: kbsearch.KbSearch): JiraKbSearchView => Object.freeze({
  hits: Object.freeze(result.hits.map(kbHitViewOf)),
  matched: result.matched,
  truncated: result.truncated,
  topK: result.topK,
})
