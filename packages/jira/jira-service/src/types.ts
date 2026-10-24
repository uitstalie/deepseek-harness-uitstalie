/**
 * The `ctx.jira` service contract: what the agent, the UI and the CLI may ask of the ledger.
 *
 * Every method returns a `Result` instead of throwing; the error is a `JiraError` from
 * `jira-core`, so a caller switches on `error.code` (one of the twelve) rather than on a message.
 * Permission is not decided here: the guard in `jira-agent` refuses a write before it ever
 * reaches this service, and the service only records which `Actor` performed the write.
 *
 * @module @deepseek-ai/dsh-jira-service/types
 */

import type { Actor, Created, DoctorReport, Identity, Issue, IssueKey, JiraError, KbSearch, KnowledgeKey, KnowledgePatch, ListQuery, ListResult, Mutation, NewIssueInput, NewKnowledge, PushOutcome, Result, Store, Timestamp, Transaction, TransactOptions, WrittenKnowledge } from '@deepseek-ai/dsh-jira-core'

export type {
  Actor,
  Created,
  DoctorReport,
  Identity,
  Issue,
  IssueKey,
  JiraError,
  KbSearch,
  KnowledgeKey,
  KnowledgePatch,
  ListQuery,
  Mutation,
  NewIssueInput,
  NewKnowledge,
  PushOutcome,
  Store,
  Timestamp,
  Transaction,
  TransactOptions,
  WrittenKnowledge,
}

/** A ledger operation's outcome: a value, or the failure to produce one. */
export type JiraResult<T> = Result<T, JiraError>

/** Issues grouped by status, with the counts the renderers print. */
export type IssueList = ListResult

/** The board is the list's grouping, named for the surface that shows it. */
export type Board = ListResult

/** One ledger change, emitted after the commit that made it. */
export interface ChangeNotice {
  /** Why the notice fired. `write` is a transaction, `settle` the derived refresh, `sync` a flush. */
  readonly kind: 'write' | 'settle' | 'sync'
  /** The affected key, when the change is about one issue or one knowledge entry. */
  readonly key?: string
  /** When the commit landed. */
  readonly at: Timestamp
}

/** The last push attempt, successful or not. */
export interface SyncRecord {
  /** When the flush started. */
  readonly at: Timestamp
  /** Whether the ledger left this machine. */
  readonly outcome: 'ok' | 'failed'
  /** The failure report, when there is one. */
  readonly error?: string
}

/** A synchronous snapshot of the service, safe to read while a write is in flight. */
export interface JiraStatus {
  /** The resolved ledger root, or the empty string when it could not be resolved. */
  readonly root: string
  /** This machine's identity in the ledger's counter blocks. */
  readonly machineId: string
  /** Whether a successful settle schedules a push. */
  readonly pushEnabled: boolean
  /** The most recent push attempt, or `null` before the first one. */
  readonly lastSync: SyncRecord | null
  /** Whether a push is armed and waiting for its debounce. */
  readonly pending: boolean
}

/** The ledger facade `ctx.jira` provides to the agent, the UI and the CLI. */
export interface JiraServiceApi {
  /** The resolved ledger root. */
  readonly root: string
  /** This machine's identity. */
  readonly machineId: string
  /**
   * A synchronous view of the ledger's state.
   * @returns the root, identity, push switch and the last push outcome.
   */
  status(): JiraStatus

  /**
   * Read the ledger's issues with a filter.
   * @param query - the filter; every field is optional.
   * @returns the grouped list, or the error that prevented reading it.
   */
  list(query: ListQuery): Promise<JiraResult<IssueList>>
  /**
   * Read one issue.
   * @param key - the issue key.
   * @returns the decoded issue, or `not-found`.
   */
  get(key: IssueKey): Promise<JiraResult<Issue>>
  /**
   * Group the open issues by status for the board.
   * @returns the board, or the error that prevented reading it.
   */
  board(): Promise<JiraResult<Board>>
  /**
   * Check the store for the inconsistencies the doctor knows about.
   * @param now - the timestamp the report is dated with.
   * @returns the report, or the error that prevented reading the store.
   */
  doctor(now?: Timestamp): Promise<JiraResult<DoctorReport>>
  /**
   * Search the knowledge base.
   * @param query - the search text.
   * @param topK - how many hits to return; the core clamps it.
   * @returns the hits with their `file:line`, or the error that prevented searching.
   */
  searchKnowledge(query: string, topK?: number): Promise<JiraResult<KbSearch>>

  /**
   * Create an issue in a project.
   * @param project - the project key, `DH`.
   * @param input - the draft.
   * @param actor - who is writing, for the audit fields.
   * @returns the created issue and its commit.
   */
  create(project: string, input: NewIssueInput, actor: Actor): Promise<JiraResult<Created>>
  /**
   * Apply one mutation under the issue lock.
   * @param key - the issue key.
   * @param mutate - the mutation to apply.
   * @param what - what the commit message says was done.
   * @param actor - who is writing.
   * @param options - compare-and-set and identity options.
   * @returns the transaction, or a `conflict` carrying the current revision.
   */
  transact(
    key: IssueKey,
    mutate: Mutation,
    what: string,
    actor: Actor,
    options?: TransactOptions,
  ): Promise<JiraResult<Transaction>>
  /**
   * Create a knowledge entry.
   * @param input - the draft.
   * @param actor - who is writing.
   * @returns the written entry and its commit.
   */
  kbCreate(input: NewKnowledge, actor: Actor): Promise<JiraResult<WrittenKnowledge>>
  /**
   * Update a knowledge entry in place.
   * @param key - the knowledge key.
   * @param patch - the fields to change.
   * @param actor - who is writing.
   * @returns the written entry and its commit.
   */
  kbUpdate(key: KnowledgeKey, patch: KnowledgePatch, actor: Actor): Promise<JiraResult<WrittenKnowledge>>

  /**
   * Flush the push queue now: pull --rebase, refresh the derived files, push.
   * @returns what the flush did, or the error that stopped it.
   */
  sync(): Promise<JiraResult<PushOutcome>>
  /**
   * Refresh the derived files and commit them. Does not push.
   * @returns the ledger root-relative paths it rewrote, or the error that stopped it.
   */
  settle(): Promise<JiraResult<readonly string[]>>

  /**
   * Subscribe to ledger changes.
   * @param event - the only event, `changed`.
   * @param listener - called after each commit.
   * @returns the unsubscribe function.
   */
  on(event: 'changed', listener: (change: ChangeNotice) => void): () => void

  /**
   * Open the store this service holds, for the tool runners that still work on the raw store.
   * This is the phase-1 bridge between the service and `jira-agent`; the tools move onto the
   * methods above in phase 2.
   * @returns the store, or the error that prevented resolving its root.
   */
  store(): Promise<JiraResult<Store>>
  /**
   * Record that a write happened outside this service's own methods (the tool runners' writes),
   * so the `changed` event still fires and the push queue still arms.
   * @param key - the affected key, when the write concerned one.
   */
  notifyWrite(key?: string): void
}
