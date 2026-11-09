/** A dispatch's business lifecycle, independent of report delivery. */
export type DispatchLedgerStatus = 'pending' | 'returned' | 'failed'

/** One dispatched task shared by the domain and an optional human projection. */
export interface DispatchLedgerTask {
  readonly id: string
  readonly workspaceId: string
  readonly workspaceTitle: string
  readonly workspacePath: string
  readonly task: string
  readonly dispatchedAt: string
  readonly status: DispatchLedgerStatus
  readonly updatedAt: string
  readonly sessionId?: string
  readonly requestId?: string
  readonly issue?: string
  readonly artifacts: readonly string[]
  readonly outcome?: string
  readonly decisions: readonly string[]
}

/** Mutable fields accepted when a result is recorded or corrected. */
export interface DispatchTaskPatch {
  readonly status: DispatchLedgerStatus
  readonly outcome?: string
  readonly artifacts?: readonly string[]
  readonly decisions?: readonly string[]
  readonly sessionId?: string
  readonly issue?: string
  readonly updatedAt: string
}

/** One task with its projection's location. */
export interface DispatchLedgerRow extends DispatchLedgerTask {
  readonly file: string
}

/** Filters accepted by domain listings. */
export interface DispatchLedgerQuery {
  readonly workspace?: string
  readonly status?: DispatchLedgerStatus
  readonly query?: string
  readonly limit?: number
}

/** A bounded page plus the complete match count. */
export interface DispatchLedgerList {
  readonly entries: readonly DispatchLedgerRow[]
  readonly counts: Readonly<{ matched: number; returned: number; remaining: number }>
  readonly truncated: boolean
  readonly limit: number
}

/** The identity a projection writer needs. */
export interface DispatchLedgerWorkspace {
  readonly id: string
  readonly title: string
  readonly path: string
}

/** Filesystem and legacy-record operations supplied by the projection owner. */
export interface DispatchProjection {
  /** Return the file a task's human projection uses. */
  fileFor(workspaceId: string): string
  /** Append the current task state to the projection. */
  append(workspace: DispatchLedgerWorkspace, task: DispatchLedgerTask): Promise<void>
  /** Read existing records for one-time import and projection reconciliation. */
  readAll(): Promise<readonly DispatchLedgerRow[]>
  /** Apply the existing list filters and bounds. */
  query(rows: readonly DispatchLedgerRow[], query: DispatchLedgerQuery): DispatchLedgerList
}

/** Create a pending task without selecting a projection. */
export const pendingTask = (input: {
  readonly id: string
  readonly workspaceId: string
  readonly workspaceTitle: string
  readonly workspacePath: string
  readonly task: string
  readonly dispatchedAt: string
  readonly sessionId?: string
  readonly requestId?: string
  readonly issue?: string
  readonly status?: DispatchLedgerStatus
}): DispatchLedgerTask => Object.freeze({
  ...input,
  status: input.status ?? 'pending',
  updatedAt: input.dispatchedAt,
  artifacts: Object.freeze([]),
  decisions: Object.freeze([]),
})
