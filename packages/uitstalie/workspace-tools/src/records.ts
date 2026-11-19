/**
 * Durable record vocabulary of the workspace toolset.
 *
 * The toolset owns no second copy of a fact owned elsewhere: a session belongs
 * to the session store, a workspace to the workspace registry, and an artifact
 * file to the workspace directory. These records only carry what those owners
 * cannot express — a dispatch task and its receipts, a message and its delivery
 * receipts, and the immutable artifact reference sent with a message or task.
 * @module @deepseek-ai/dsh-workspace-tools/records
 */

/** Durable state of one dispatch task; the vocabulary the task tool enforces. */
export type TaskStatus = 'pending' | 'in_progress' | 'waiting_review' | 'done' | 'blocked' | 'cancelled'

/** Every accepted task state, in state-machine order. */
export const TASK_STATUSES: readonly TaskStatus[] = [
  'pending', 'in_progress', 'waiting_review', 'done', 'blocked', 'cancelled',
]

/** Which kind of work a task covers; the closed six-category taxonomy. */
export type TaskType =
  | 'analysis-diagnosis'
  | 'fix'
  | 'test-verification'
  | 'migration-deployment'
  | 'design-document'
  | 'other'

/** Every accepted task type. */
export const TASK_TYPES: readonly TaskType[] = [
  'analysis-diagnosis', 'fix', 'test-verification', 'migration-deployment', 'design-document', 'other',
]

/** Whether one alignment item met the card point it was checked against. */
export type AcceptanceAlignmentStatus = 'satisfied' | 'not_satisfied' | 'out_of_scope'

/** Whether one boundary was kept. */
export type BoundaryAlignmentStatus = 'respected' | 'violated'

/** Whether one output-form item was delivered. */
export type OutputFormAlignmentStatus = 'matched' | 'not_matched'

/** One checked card point with the evidence the checker reported. */
export interface AlignmentEntry<Status extends string> {
  /** Card point the entry checks, such as `acceptance[0]`. */
  readonly point: string
  /** Checked status. */
  readonly status: Status
  /** Evidence: the changed file, the test, the report line, or the missing item. */
  readonly evidence: string
}

/** Post-execution alignment of one task against the card version it referenced. */
export interface TaskAlignment {
  /** Card the task was dispatched against. */
  readonly intentId: string
  /** Card version the task was dispatched against. */
  readonly intentVersion: number
  /** One checked status per card acceptance point. */
  readonly acceptance: AlignmentEntry<AcceptanceAlignmentStatus>[]
  /** One checked status per card boundary. */
  readonly boundaries: AlignmentEntry<BoundaryAlignmentStatus>[]
  /** One checked status per card output-form item. */
  readonly outputForm: AlignmentEntry<OutputFormAlignmentStatus>[]
}

/** One reported task outcome. */
export interface TaskReceipt {
  /** Stable receipt id inside the task. */
  readonly receiptId: string
  /** ISO-8601 instant the executor appended the receipt. */
  readonly at: string
  /** Task state the receipt reported. */
  readonly status: TaskStatus
  /** Optional one-line note. */
  readonly note?: string | undefined
  /** Idempotency key of the receipt call; absent on receipts written before this field existed. */
  readonly requestId?: string | undefined
  /** Post-execution alignment checked against the task's card version. */
  readonly alignment?: TaskAlignment | undefined
}

/** One card point mapped to the task-brief item that covers it. */
export interface TaskCoverage {
  /** Card point, such as `acceptance[0]`. */
  readonly point: string
  /** Task-brief item text that covers the point. */
  readonly brief: string
  /** Optional note on how the brief item covers the point. */
  readonly note?: string | undefined
}

/** One card point the caller explicitly leaves uncovered. */
export interface TaskNonCoverage {
  /** Card point, such as `outputForm[0]`. */
  readonly point: string
  /** Why the task does not cover the point. */
  readonly reason: string
}

/** One dispatch task in one workspace. */
export interface TaskRecord {
  /** Stable task id inside the workspace. */
  readonly taskId: string
  /** Workspace that owns the task. */
  readonly workspaceId: string
  /** Short human title. */
  readonly title: string
  /** What the task must achieve. */
  readonly goal: string
  /** Acceptance points the receipt is checked against. */
  readonly acceptance: string[]
  /** Boundaries the executor must respect. */
  readonly boundaries: string[]
  /** Expected deliverable items the card's output form requires. */
  readonly outputForm?: string[] | undefined
  /** Current state. */
  readonly status: TaskStatus
  /** Assignee identity when one was recorded. */
  readonly assignee?: string | undefined
  /** Session expected to execute the task. */
  readonly targetSessionId?: string | undefined
  /** Session that started the task; a task-bound cross-workspace return targets it. */
  readonly dispatcherSessionId?: string | undefined
  /** Intent card this task was dispatched against. */
  readonly intentId?: string | undefined
  /** Intent card version this task was dispatched against. */
  readonly intentVersion?: number | undefined
  /** Card points mapped to task-brief items at dispatch time. */
  readonly coverage?: TaskCoverage[] | undefined
  /** Card points the caller explicitly left uncovered. */
  readonly nonCoverage?: TaskNonCoverage[] | undefined
  /** Six-category task type. */
  readonly taskType?: TaskType | undefined
  /** ISO-8601 creation instant. */
  readonly createdAt: string
  /** ISO-8601 instant of the last mutation. */
  readonly updatedAt: string
  /** Idempotency key of the create call. */
  readonly requestId: string
  /** Idempotency key of the most recent `update` call, when one was recorded. */
  readonly lastRequestId?: string | undefined
  /** One-line note recorded by the most recent `update`, when one was given. */
  readonly note?: string | undefined
  /** Appended receipts in report order. */
  readonly receipts: TaskReceipt[]
  /** Artifact ids published for this task. */
  readonly artifactIds: string[]
}

/** How one intent item was sourced. */
export type IntentItemSource = 'user-verbatim' | 'user-anchor' | 'inference'

/** Every accepted intent item source. */
export const INTENT_ITEM_SOURCES: readonly IntentItemSource[] = ['user-verbatim', 'user-anchor', 'inference']

/** Which part of the card one item belongs to. */
export type IntentItemKind = 'goal' | 'acceptance' | 'boundaries' | 'outputForm'

/** Every card part, in report order. */
export const INTENT_ITEM_KINDS: readonly IntentItemKind[] = ['goal', 'acceptance', 'boundaries', 'outputForm']

/** Lifecycle of one card version. */
export type IntentStatus = 'proposed' | 'active' | 'superseded'

/** Every card version state. */
export const INTENT_STATUSES: readonly IntentStatus[] = ['proposed', 'active', 'superseded']

/** Workspace-relative document and heading a `user-anchor` item quotes. */
export interface IntentAnchor {
  /** Workspace-relative document path. */
  readonly path: string
  /** Heading inside that document, when the user named one. */
  readonly heading?: string | undefined
}

/** One source-annotated item of an intent card. */
export interface IntentItem {
  /** Item text; verbatim for `user-verbatim`, a quote for `user-anchor`. */
  readonly text: string
  /** How the item was sourced. */
  readonly source: IntentItemSource
  /** Quoted document and heading for a `user-anchor` item. */
  readonly anchor?: IntentAnchor | undefined
  /** Why the item was inferred, for an `inference` item. */
  readonly reason?: string | undefined
}

/** The goal, acceptance, boundary, and output-form items of one card version. */
export interface IntentItems {
  /** Outcomes the user wants. */
  readonly goal: IntentItem[]
  /** Checkable acceptance points. */
  readonly acceptance: IntentItem[]
  /** What must not be touched or changed. */
  readonly boundaries: IntentItem[]
  /** Expected deliverable shape. */
  readonly outputForm: IntentItem[]
}

/** One immutable card version as stored in `versions/<n>.json`. */
export interface IntentVersionRecord {
  /** Stable card id inside the workspace. */
  readonly intentId: string
  /** Workspace that owns the card. */
  readonly workspaceId: string
  /** Version number, starting at 1. */
  readonly version: number
  /** State the version was created with; later states live in the index. */
  readonly status: 'proposed' | 'active'
  /** The user's original words, verbatim. */
  readonly rawUserText: string
  /** Source-annotated card items. */
  readonly items: IntentItems
  /** Session where the user stated the request. */
  readonly sourceSessionId?: string | undefined
  /** Turn where the user stated the request. */
  readonly sourceTurn?: number | undefined
  /** ISO-8601 creation instant. */
  readonly createdAt: string
  /** Identity that created this version. */
  readonly author: string
  /** Version this one replaces, when it is a correction. */
  readonly supersedesVersion?: number | undefined
  /** Why the correction was made. */
  readonly reason?: string | undefined
  /** The user's correcting words, verbatim. */
  readonly correctionText?: string | undefined
  /** Card point texts that changed in this correction. */
  readonly changedPoints?: string[] | undefined
  /** Card point identities that changed in this correction, for recurrence metrics. */
  readonly changedPointRefs?: string[] | undefined
  /** Six-category task type this correction is attributed to. */
  readonly taskType?: TaskType | undefined
  /** Idempotency key of the `create` or `correct` call that wrote this version. */
  readonly requestId: string
}

/** Mutable bookkeeping of one card version, held in `index.json`. */
export interface IntentVersionSummary {
  /** Version number. */
  readonly version: number
  /** Current state. */
  readonly status: IntentStatus
  /** ISO-8601 creation instant. */
  readonly createdAt: string
  /** Identity that created this version. */
  readonly author: string
  /** ISO-8601 instant the user confirmed the inferred items. */
  readonly confirmedAt?: string | undefined
  /** Identity that recorded the confirmation. */
  readonly confirmedBy?: string | undefined
  /** Inferred card points confirmed for this version. */
  readonly confirmedPoints?: string[] | undefined
  /** ISO-8601 instant the user rejected the proposed version. */
  readonly rejectedAt?: string | undefined
  /** Identity that recorded the rejection. */
  readonly rejectedBy?: string | undefined
  /** Version this one replaces, when it is a correction. */
  readonly supersedesVersion?: number | undefined
  /** Why the correction was made. */
  readonly reason?: string | undefined
  /** Whether this version was appended by a user correction. */
  readonly correction?: boolean | undefined
  /** Card point texts that changed in this correction. */
  readonly changedPoints?: string[] | undefined
  /** Card point identities that changed in this correction, for recurrence metrics. */
  readonly changedPointRefs?: string[] | undefined
  /** Six-category task type this correction is attributed to. */
  readonly taskType?: TaskType | undefined
  /** Idempotency key of the call that wrote this version. */
  readonly requestId: string
}

/** Mutable index of one card; the version files it points at are append-only. */
export interface IntentIndex {
  /** Stable card id inside the workspace. */
  readonly intentId: string
  /** Workspace that owns the card. */
  readonly workspaceId: string
  /** ISO-8601 creation instant. */
  readonly createdAt: string
  /** Latest version number. */
  readonly latestVersion: number
  /** Latest version a task may reference; absent while no version is active. */
  readonly latestActiveVersion?: number | undefined
  /** Every version, oldest first. */
  readonly versions: IntentVersionSummary[]
}

/** Whether a message is an ordinary message or a follow-up to earlier work. */
export type MessageKind = 'message' | 'followup'

/** Delivery state of one message. */
export type MessageDeliveryStatus = 'queued' | 'delivered' | 'interrupted' | 'target_archived' | 'failed'

/** Every accepted delivery state, in state-machine order. */
export const MESSAGE_DELIVERY_STATUSES: readonly MessageDeliveryStatus[] = [
  'queued', 'delivered', 'interrupted', 'target_archived', 'failed',
]

/** Priority of one message; `urgent` is limited to the three validated cases. */
export type MessagePriority = 'normal' | 'urgent'

/** The three cases that justify an urgent message. */
export type UrgentReason = 'wrong-conclusion' | 'stop-order' | 'instruction-change'

/** Every accepted urgent reason, in design order. */
export const URGENT_REASONS: readonly UrgentReason[] = ['wrong-conclusion', 'stop-order', 'instruction-change']

/** One artifact reference captured when a message or task referenced it. */
export interface ArtifactCitation {
  /** Stable artifact id. */
  readonly artifactId: string
  /** Version captured at send time. */
  readonly version: number
  /** Content hash captured at send time. */
  readonly sha256: string
}

/** One delivery observation for a message. */
export interface MessageReceipt {
  /** ISO-8601 instant the delivery state was observed. */
  readonly at: string
  /** Observed state. */
  readonly status: MessageDeliveryStatus
}

/** One message delivered to a workspace session. */
export interface MessageRecord {
  /** Stable message id. */
  readonly messageId: string
  /** Workspace that owns the message. */
  readonly workspaceId: string
  /** Session the message addresses. */
  readonly targetSessionId: string
  /** Session that sent the message. */
  readonly sourceSessionId: string
  /** Role the sender held when it sent; absent on records written before this field existed. */
  readonly sourceRole?: 'subagent' | 'agent' | 'super' | undefined
  /** Bounded message body. */
  readonly text: string
  /** Whether this is a message or a follow-up. */
  readonly kind: MessageKind
  /** Effective priority. */
  readonly priority: MessagePriority
  /** Which of the three cases made the message urgent; absent for a normal message. */
  readonly urgentReason?: UrgentReason | undefined
  /** Message this one answers, when it is a reply. */
  readonly replyTo?: string | undefined
  /** Artifact references attached at send time. */
  readonly references: ArtifactCitation[]
  /** Task this message reports on, when linked. */
  readonly taskId?: string | undefined
  /** Idempotency key of the send call. */
  readonly requestId: string
  /** Current delivery state. */
  readonly status: MessageDeliveryStatus
  /** ISO-8601 creation instant. */
  readonly createdAt: string
  /** ISO-8601 instant the message reached its target. */
  readonly deliveredAt?: string | undefined
  /** Readable reason the last delivery attempt failed; absent while no attempt failed. */
  readonly error?: string | undefined
  /** Delivery attempts made: the initial send counts as one, each retry adds one. Absent on records written before this field existed. */
  readonly attempts?: number | undefined
  /** Delivery observations in report order. */
  readonly receipts: MessageReceipt[]
}

/** One session's roster entry: who created it, who archived it, and when. */
export interface SessionRosterEntry {
  /** Session identity. */
  readonly sessionId: string
  /** Workspace that accounts for the session. */
  readonly workspaceId: string
  /** Identity that created the session: `user` or `agent:<sessionId>`. */
  readonly createdBy?: string | undefined
  /** ISO-8601 instant the session was created, when known. */
  readonly createdAt?: string | undefined
  /** Session this one was forked from, when it was branched. */
  readonly forkedFrom?: string | undefined
  /** Identity that archived the session: `user` or `agent:<sessionId>`. */
  readonly archivedBy?: string | undefined
  /** ISO-8601 instant the session was archived. */
  readonly archivedAt?: string | undefined
  /** ISO-8601 instant the roster last reconciled this entry with the registry. */
  readonly observedAt: string
}

/** One immutable artifact reference. */
export interface ArtifactReference {
  /** Stable id: `artifact-` plus the first 16 hex digits of the workspace/path/kind digest. */
  readonly artifactId: string
  /** Workspace that owns the referenced file. */
  readonly workspaceId: string
  /** Workspace-relative path of the referenced file. */
  readonly path: string
  /** SHA-256 of the published content, lowercase hex. */
  readonly sha256: string
  /** Published content size in bytes. */
  readonly size: number
  /** Publish version at this path, starting at 1. */
  readonly version: number
  /** Artifact kind recorded by the publisher. */
  readonly kind: string
  /** Session that published the reference. */
  readonly sessionId: string
  /** Task the reference belongs to, when one was recorded. */
  readonly taskId?: string | undefined
  /** ISO-8601 publish instant. */
  readonly createdAt: string
  /** Optional one-line summary. */
  readonly summary?: string | undefined
}

/** All published versions of one logical artifact. */
export interface ArtifactRecord {
  /** Stable artifact id. */
  readonly artifactId: string
  /** Workspace that owns the artifact. */
  readonly workspaceId: string
  /** Every published version, oldest first; the last one is current. */
  readonly versions: ArtifactReference[]
}

/** How one artifact reference resolves against the current file. */
export type ArtifactResolutionStatus = 'ok' | 'changed' | 'missing' | 'denied' | 'pending' | 'expired'

/** One holder decision on a version-scoped artifact request. */
export interface ArtifactGrant {
  /** Workspace that owns the artifact. */
  readonly workspaceId: string
  /** Artifact the grant covers. */
  readonly artifactId: string
  /** Version the grant is scoped to; a new version needs a new grant. */
  readonly version: number
  /** Hash of the version at decision time. */
  readonly sha256: string
  /** Holder's decision. */
  readonly status: 'granted' | 'denied'
  /** Session that recorded the decision. */
  readonly decidedBy: string
  /** ISO-8601 decision instant. */
  readonly decidedAt: string
  /** ISO-8601 instant the grant stops being valid; absent for a denial. */
  readonly expiresAt?: string | undefined
}

/** Result of one artifact resolution. */
export interface ArtifactResolution {
  /** Resolved artifact id. */
  readonly artifactId: string
  /** Version the resolution checked. */
  readonly version: number
  /** Checked status. */
  readonly status: ArtifactResolutionStatus
  /** Workspace-relative path of the referenced file. */
  readonly path: string
  /** Hash of the referenced version at publish time. */
  readonly sha256: string
}
