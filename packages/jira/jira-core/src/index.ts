/**
 * The jira ledger's public module surface.
 *
 * Every entry is a namespace re-export of one atom module, so a consumer imports
 * `{ store, entities } from '@deepseek-ai/dsh-jira-core'` instead of reaching into `src/`.
 * Inside the package, modules keep importing each other by relative path; the `./*` export map
 * and the matching tsconfig alias exist only for `jira-cli`, which deliberately drives the same
 * atoms the service does.
 *
 * @module @deepseek-ai/dsh-jira-core
 */

export * as codec from './codec.ts'
export * as config from './config.ts'
export * as doctor from './doctor.ts'
export * as entities from './entity.ts'
export * as errors from './errors.ts'
export * as generate from './generate.ts'
export * as generateStore from './generateStore.ts'
export * as git from './git.ts'
export * as inspect from './inspect.ts'
export * as io from './io.ts'
export * as kb from './kb.ts'
export * as kbsearch from './kbsearch.ts'
export * as kbstore from './kbstore.ts'
export * as list from './list.ts'
export * as lock from './lock.ts'
export * as machine from './machine.ts'
export * as mutate from './mutate.ts'
export * as messages from './messages.ts'
export * as provision from './provision.ts'
export * as push from './push.ts'
export * as rebase from './rebase.ts'
export * as result from './result.ts'
export * as store from './store.ts'
export * as system from './system/index.ts'
export * as tagsLint from './tagsLint.ts'
export * as vocab from './vocab.ts'

// The named types a consumer states in its own signatures. They are re-exported by name, not only
// reachable through the namespaces above, because the type-graph generator resolves a package
// reference by looking for that name among the package root's exports.
export type { DoctorReport } from './doctor.ts'
export type { Identity, Issue, IssueKey, LinkType, Timestamp } from './entity.ts'
export type { ErrorCode, JiraError } from './errors.ts'
export type { KnowledgeEntry, KnowledgeKey } from './kb.ts'
export type { KbSearch } from './kbsearch.ts'
export type { KnowledgePatch, NewKnowledge, WrittenKnowledge } from './kbstore.ts'
export type { ListQuery, ListResult } from './list.ts'
export type { NewIssueInput } from './mutate.ts'
export type { PushOutcome, PushQueue } from './push.ts'
export type { Result } from './result.ts'
export type { Actor, Created, Mutation, Store, Transaction, TransactOptions } from './store.ts'
export type { TagsLintReport } from './tagsLint.ts'
export type { Vocab } from './vocab.ts'
