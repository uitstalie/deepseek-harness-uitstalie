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

import type { Actor, Created, DoctorReport, ErrorCode, Identity, Issue, IssueKey, JiraError, KbSearch, KnowledgeKey, KnowledgePatch, ListQuery, ListResult, Mutation, NewIssueInput, NewKnowledge, PushOutcome, Result, Store, Timestamp, Transaction, TransactOptions, WrittenKnowledge } from '@deepseek-ai/dsh-jira-core'

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
  /** The `owner.host` audit value writes carry: the row's host, or this machine's hostname. */
  readonly host: string
  /** Whether a successful settle schedules a push. */
  readonly pushEnabled: boolean
  /** The most recent push attempt, or `null` before the first one. */
  readonly lastSync: SyncRecord | null
  /** Whether a push is armed and waiting for its debounce. */
  readonly pending: boolean
}

/** The ledger facade `ctx.jira` provides to the agent, the UI and the CLI. */
/** Project, knowledge and open-issue counts for the awareness line. */
export interface JiraCounts {
  /** Projects the ledger knows (a project.md or at least one issue). */
  readonly projects: number
  /** Knowledge entries across all domains. */
  readonly knowledge: number
  /** Issues in a non-closed status. */
  readonly openIssues: number
  /** Projects the ledger marks read-only. */
  readonly readOnlyProjects: number
}

export interface JiraServiceApi {
  /** The resolved ledger root. */
  readonly root: string
  /** This machine's identity. */
  readonly machineId: string
  /**
   * A synchronous view of the ledger's state.
   * @returns the root, identity, audit host, push switch and the last push outcome.
   */
  status(): JiraStatus

  /**
   * Count the ledger's projects, knowledge entries and open issues.
   * @returns the counts, or the error that prevented reading the store.
   */
  counts(): Promise<Result<JiraCounts, JiraError>>
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

/*
 * The Remote face (`remote.jira`). Everything below is what crosses to the browser, so the types
 * are plain JSON: branded ids, timestamps and identities become `string`, and every structure is
 * read-only. The mapping lives in `wire.ts`; the service types above never leave the host.
 */

/** The last push attempt as the browser reads it. */
export interface JiraSyncView {
  /** When the flush started. */
  readonly at: string
  /** Whether the ledger left this machine. */
  readonly outcome: 'ok' | 'failed'
  /** The failure report, when there is one. */
  readonly error?: string
}

/** `remote.jira.status()`: the ledger's root, identity and push state. */
export interface JiraStatusView {
  /** The resolved ledger root, or the empty string when it could not be resolved. */
  readonly root: string
  /** This machine's identity in the ledger's counter blocks. */
  readonly machineId: string
  /** The `owner.host` audit value writes carry. */
  readonly host: string
  /** Whether a successful settle schedules a push. */
  readonly pushEnabled: boolean
  /** The most recent push attempt, or `null` before the first one. */
  readonly lastSync: JiraSyncView | null
  /** Whether a push is armed and waiting for its debounce. */
  readonly pending: boolean
}

/** The list filter the board and the list would accept from a browser. */
export interface JiraListQuery {
  /** Restrict to one project key. */
  readonly project?: string
  /** Restrict to one status name. */
  readonly status?: string
  /** Restrict to one tag. */
  readonly tag?: string
  /** Require every listed tag. */
  readonly tags?: readonly string[]
  /** Restrict to one identity, `agent:…` or `human:…`. */
  readonly assignee?: string
  /** Include issues in a status the vocabulary marks closed. */
  readonly includeClosed?: boolean
  /** How many rows to return; the core clamps it. */
  readonly limit?: number
}

/** One issue as the board and the list render it. */
export interface JiraIssueRowView {
  /** `DH-12`. */
  readonly key: string
  /** The project directory the issue lives under. */
  readonly project: string
  /** The issue type from the vocabulary. */
  readonly issueType: string
  /** The status from the vocabulary. */
  readonly status: string
  /** The priority from the vocabulary. */
  readonly priority: string
  /** One line, at most 120 characters. */
  readonly summary: string
  /** Every tag on the issue, in stored order. */
  readonly tags: readonly string[]
  /** The claiming identity; absent means unassigned. */
  readonly assignee?: string
  /** When the issue last changed, UTC seconds. */
  readonly updatedAt: string
  /** The issue's own revision counter. */
  readonly revision: number
  /** Whether an `is_blocked_by` target is still open or missing. */
  readonly blocked: boolean
}

/** One board column: a status, or the trailing group of blocked issues. */
export interface JiraBoardGroupView {
  /** The rendered name, for example `DH · in_progress`. */
  readonly name: string
  /** Whether the group is one status or the cross-project blocked group. */
  readonly kind: 'status' | 'blocked'
  /** The project the group belongs to, `*` for the blocked group. */
  readonly project: string
  /** The status name; absent on the blocked group. */
  readonly status?: string
  /** The issues in this group, ordered. */
  readonly items: readonly JiraIssueRowView[]
}

/** What the result matched before the limit; the counts describe everything that matched. */
export interface JiraBoardCountsView {
  /** Everything that matched the filters, before the limit. */
  readonly matched: number
  /** What the limit kept. */
  readonly returned: number
  /** What the limit hid. */
  readonly remaining: number
  /** Matched issues per status name. */
  readonly byStatus: Readonly<Record<string, number>>
  /** How many matched issues are blocked. */
  readonly blocked: number
}

/** `remote.jira.board()` and `remote.jira.list()`: issues grouped for the board. */
export interface JiraBoardView {
  /** Every returned issue in board order. */
  readonly items: readonly JiraIssueRowView[]
  /** The same issues grouped by status, blocked last. */
  readonly groups: readonly JiraBoardGroupView[]
  /** Counts over everything that matched, not just what was returned. */
  readonly counts: JiraBoardCountsView
  /** Whether the limit hid matches. */
  readonly truncated: boolean
  /** The limit that was applied. */
  readonly limit: number
}

/** One link on an issue's frontmatter. */
export interface JiraIssueLinkView {
  /** A link type from the closed vocabulary. */
  readonly type: string
  /** The target issue key. */
  readonly target: string
}

/** `remote.jira.get()`: one issue's frontmatter fields and body. */
export interface JiraIssueDetailView {
  /** `DH-12`. */
  readonly key: string
  /** The project directory the issue lives under. */
  readonly project: string
  /** The issue type from the vocabulary. */
  readonly issueType: string
  /** The status from the vocabulary. */
  readonly status: string
  /** One line, at most 120 characters. */
  readonly summary: string
  /** The priority from the vocabulary. */
  readonly priority: string
  /** Every tag on the issue, in stored order. */
  readonly tags: readonly string[]
  /** Outgoing links. */
  readonly links: readonly JiraIssueLinkView[]
  /** Free text the `update` verb may rewrite. */
  readonly note?: string
  /** Required for any status the vocabulary marks closed. */
  readonly resolution?: string
  /** Why the issue was closed that way. */
  readonly resolutionNote?: string
  /** The issue's own revision counter. */
  readonly revision: number
  /** When the issue was created, UTC seconds. */
  readonly createdAt: string
  /** When the issue last changed, UTC seconds. */
  readonly updatedAt: string
  /** Who created it. */
  readonly reporter: string
  /** The claiming identity; absent means unassigned. */
  readonly assignee?: string
  /** When the claim was taken, when it is leased. */
  readonly claimedAt?: string
  /** When the claim's lease expires, when it is leased. */
  readonly leaseExpiresAt?: string
  /** Knowledge entries this issue references. */
  readonly kbRefs: readonly string[]
  /** Whether the conflict pass marked it; an acknowledged write clears it. */
  readonly conflicted: boolean
  /** The Markdown description. */
  readonly body: string
}

/** One knowledge hit with the `file:line` a reader can open. */
export interface JiraKbHitView {
  /** The knowledge key, `KB-7`. */
  readonly key: string
  /** The entry's title. */
  readonly title: string
  /** The entry's domain directory. */
  readonly domain: string
  /** The entry's type from the vocabulary. */
  readonly kbType: string
  /** Store-relative path of the entry, so `file:line` can be opened. */
  readonly file: string
  /** 1-based line of the first match. */
  readonly line: number
  /** The match window, at most 200 characters. */
  readonly snippet: string
  /** Whether the title matched, which outranks body matches. */
  readonly titleMatch: boolean
  /** How many times the query matched in this entry. */
  readonly matches: number
  /** When the entry was captured. */
  readonly capturedAt: string
}

/** `remote.jira.kbSearch()`: ranked hits, never whole bodies. */
export interface JiraKbSearchView {
  /** The hits the limit kept, ranked. */
  readonly hits: readonly JiraKbHitView[]
  /** Entries with at least one match, before the limit. */
  readonly matched: number
  /** Whether the limit hid matches. */
  readonly truncated: boolean
  /** The limit that was applied. */
  readonly topK: number
}

/** What every `jira/*` Remote failure carries: the ledger's own error code, verbatim. */
export interface JiraRemoteFailureDetails {
  /** One of `jira-core`'s twelve codes, for example `NOT_FOUND`. */
  readonly jiraCode: ErrorCode
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The issue or knowledge key does not exist. */
    'jira/not-found': JiraRemoteFailureDetails
    /** The request is invalid: a malformed key, an unknown status, a bad filter. */
    'jira/invalid-input': JiraRemoteFailureDetails
    /** The write's `expectedRevision` is stale; re-read and retry. */
    'jira/stale-revision': JiraRemoteFailureDetails
    /** The vocabulary does not allow the requested transition. */
    'jira/invalid-transition': JiraRemoteFailureDetails
    /** Entering the target status needs a resolution. */
    'jira/resolution-required': JiraRemoteFailureDetails
    /** The tag is not registered in the ledger. */
    'jira/unknown-tag': JiraRemoteFailureDetails
    /** An `is_blocked_by` target is still open. */
    'jira/blocked-by-open': JiraRemoteFailureDetails
    /** The project is anchored to another machine; agents here may not write it. */
    'jira/foreign-machine-read-only': JiraRemoteFailureDetails
    /** The store's file lock was held past the timeout. */
    'jira/lock-timeout': JiraRemoteFailureDetails
    /** A file operation did not happen; the message names it. */
    'jira/write-failed': JiraRemoteFailureDetails
    /** The project's key space is exhausted. */
    'jira/key-exhausted': JiraRemoteFailureDetails
    /** The session is read-only and the write was refused. */
    'jira/read-only-session': JiraRemoteFailureDetails
  }
}
