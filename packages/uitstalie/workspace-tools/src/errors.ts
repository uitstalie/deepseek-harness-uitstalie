/**
 * Stable failure codes of the workspace toolset.
 *
 * Every code is routable by a caller and actionable by a person: the scope
 * codes name the registry step that fixes them, and the record codes name the
 * workspace and id that did not match.
 * @module @deepseek-ai/dsh-workspace-tools/errors
 */

import { HarnessError } from '@deepseek-ai/dsh-error'

/** Code of a scope refusal. */
export type WorkspaceScopeCode = 'WORKSPACE_UNKNOWN' | 'WORKSPACE_NOT_REGISTERED'

/** The calling session or the requested id does not name a registered workspace. */
export class WorkspaceScopeError extends HarnessError {
  /**
   * @param message - actionable explanation naming the registration step.
   * @param code - which scope rule refused the call.
   */
  constructor(message: string, code: WorkspaceScopeCode) {
    super(message, code)
    this.name = 'WorkspaceScopeError'
  }
}

/** Code of a record refusal. */
export type WorkspaceRecordCode =
  | 'WORKSPACE_RECORD_NOT_FOUND'
  | 'WORKSPACE_RECORD_CORRUPT'
  | 'WORKSPACE_CURSOR_INVALID'

/** A durable workspace record could not be read or does not exist. */
export class WorkspaceRecordError extends HarnessError {
  /**
   * @param message - the record, path, or cursor that failed.
   * @param code - which record rule refused the call.
   */
  constructor(message: string, code: WorkspaceRecordCode) {
    super(message, code)
    this.name = 'WorkspaceRecordError'
  }
}

/** Code of an artifact refusal that is not one of the resolution statuses. */
export type WorkspaceArtifactCode = 'ARTIFACT_TOO_LARGE' | 'ARTIFACT_PATH_OUTSIDE' | 'ARTIFACT_NOT_A_FILE' | 'ARTIFACT_INVALID'

/** The referenced file cannot be hashed inside the tool's resource bound. */
export class WorkspaceArtifactError extends HarnessError {
  /**
   * @param message - the artifact id and the bound that failed.
   * @param code - which artifact rule refused the call.
   */
  constructor(message: string, code: WorkspaceArtifactCode) {
    super(message, code)
    this.name = 'WorkspaceArtifactError'
  }
}

/** Code of an intent-card refusal. */
export type WorkspaceIntentCode =
  | 'INTENT_INCOMPLETE'
  | 'INTENT_UNCONFIRMED'
  | 'INTENT_STALE'
  | 'INTENT_SCOPE_MISMATCH'
  | 'INTENT_COVERAGE_MISSING'
  | 'INTENT_ALIGNMENT_MISSING'
  | 'INTENT_ALIGNMENT_INCOMPLETE'
  | 'INTENT_ALIGNMENT_UNSATISFIED'
  | 'INTENT_PERMISSION_DENIED'
  | 'INTENT_INVALID'

/** An intent card rule refused the call: a missing field, a stale version, or a failed check. */
export class WorkspaceIntentError extends HarnessError {
  /**
   * @param message - the card, version, or point that failed.
   * @param code - which intent rule refused the call.
   */
  constructor(message: string, code: WorkspaceIntentCode) {
    super(message, code)
    this.name = 'WorkspaceIntentError'
  }
}

/** Code of a message refusal that is not a missing record. */
export type WorkspaceMessageCode =
  | 'WORKSPACE_MESSAGE_FORBIDDEN'
  | 'WORKSPACE_MESSAGE_TARGET'
  | 'WORKSPACE_MESSAGE_INVALID'

/** A message send was refused by the scope, role, or target rule. */
export class WorkspaceMessageError extends HarnessError {
  /**
   * @param message - the target, role, or field that refused the send.
   * @param code - which message rule refused the call.
   */
  constructor(message: string, code: WorkspaceMessageCode) {
    super(message, code)
    this.name = 'WorkspaceMessageError'
  }
}

/** Code of a task-mutation refusal that is not a missing record. */
export type WorkspaceTaskCode = 'WORKSPACE_TASK_FORBIDDEN' | 'WORKSPACE_TASK_TRANSITION'

/** A task mutation was refused by the dispatcher rule or the state machine. */
export class WorkspaceTaskError extends HarnessError {
  /**
   * @param message - the task and transition or role that failed.
   * @param code - which task rule refused the call.
   */
  constructor(message: string, code: WorkspaceTaskCode) {
    super(message, code)
    this.name = 'WorkspaceTaskError'
  }
}
