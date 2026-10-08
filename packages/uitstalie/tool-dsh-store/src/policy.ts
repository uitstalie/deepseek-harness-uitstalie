/**
 * Session policy gate for store mutations: resolve the calling session's policy
 * and refuse a mutating action under `read-only` with the shared sandbox denial
 * marker, so a blocked store call reads exactly like a blocked write or edit.
 * @module @deepseek-ai/dsh-tool-dsh-store/policy
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { sandboxDenialMarker } from '@deepseek-ai/dsh-sandbox'
import { FsError } from '@deepseek-ai/dsh-fs'

/** The policy governing one store call. */
export interface StorePolicy {
  /**
   * Policy stamped onto every filesystem mutation of this call, or undefined on
   * a bare backend with no confining provider mounted.
   */
  execution: SandboxExecutionPolicy | undefined
}

/**
 * Resolve the policy for one store call.
 *
 * A `read-only` session is refused here rather than at the filesystem, and the
 * refusal carries the shared denial marker. The marker alone is deliberate: this
 * tool advertises no escalation fields, so the wider-retry hint other tools add
 * would name an argument the model cannot use.
 * @param ctx - plugin context carrying the optional sandbox-policy service.
 * @param exec - the tool execution whose agent names the session.
 * @returns the resolved policy for this call.
 * @throws {FsError} `FS_SANDBOX_DENIED` when the session mode forbids writes.
 */
export function resolveStorePolicy(ctx: Context, exec: ToolExecution): StorePolicy {
  const policy = ctx.get('sandboxPolicy')?.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })
  if (policy?.mode === 'read-only') {
    throw new FsError(sandboxDenialMarker('read-only'), 'FS_SANDBOX_DENIED')
  }
  return { execution: policy }
}
