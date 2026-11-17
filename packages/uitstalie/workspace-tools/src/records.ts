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
  /** Current state. */
  readonly status: TaskStatus
  /** Assignee identity when one was recorded. */
  readonly assignee?: string | undefined
  /** Session expected to execute the task. */
  readonly targetSessionId?: string | undefined
  /** Intent card this task was dispatched against. */
  readonly intentId?: string | undefined
  /** Intent card version this task was dispatched against. */
  readonly intentVersion?: number | undefined
  /** Six-category task type. */
  readonly taskType?: TaskType | undefined
  /** ISO-8601 creation instant. */
  readonly createdAt: string
  /** ISO-8601 instant of the last mutation. */
  readonly updatedAt: string
  /** Idempotency key of the create call. */
  readonly requestId: string
  /** Appended receipts in report order. */
  readonly receipts: TaskReceipt[]
  /** Artifact ids published for this task. */
  readonly artifactIds: string[]
}

/** Whether a message is an ordinary message or a follow-up to earlier work. */
export type MessageKind = 'message' | 'followup'

/** Delivery state of one message. */
export type MessageDeliveryStatus = 'queued' | 'delivered' | 'interrupted' | 'target_archived'

/** Priority of one message; `urgent` is limited to the three validated cases. */
export type MessagePriority = 'normal' | 'urgent'

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
  /** Bounded message body. */
  readonly text: string
  /** Whether this is a message or a follow-up. */
  readonly kind: MessageKind
  /** Effective priority. */
  readonly priority: MessagePriority
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
  /** Delivery observations in report order. */
  readonly receipts: MessageReceipt[]
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
