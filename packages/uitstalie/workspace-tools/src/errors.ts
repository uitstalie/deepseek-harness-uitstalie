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

/** Code of an artifact resolution refusal that is not one of the statuses. */
export type WorkspaceArtifactCode = 'ARTIFACT_TOO_LARGE'

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
