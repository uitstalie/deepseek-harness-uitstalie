/**
 * Bridge from model-facing filesystem tools to the soft `ctx.toolPolicy`
 * service.
 *
 * This check lives in the tool layer, not in `ctx.fs`: `ctx.fs` also serves the
 * Web file preview, workspace-files, attachments, skills, and agent
 * instructions, and a global read policy there would break those internal
 * consumers. Tools call this after resolving a target, so the service sees the
 * canonical process path for the exact file the tool is about to touch.
 *
 * With no `toolPolicy` mounted the function is a no-op: the existing tool
 * behavior is unchanged.
 *
 * @module @deepseek-ai/dsh-tool-fs/policy
 */

import type { Context } from '@deepseek-ai/cordis'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tool-policy'
import type { FileAccessOperation } from '@deepseek-ai/dsh-tool-policy'

/**
 * Enforce the active soft tool policy for one file-tool target.
 * @param ctx - plugin context that may carry `ctx.toolPolicy`.
 * @param exec - the calling tool execution (its agent selects the profile).
 * @param operation - read, write, or list.
 * @param target - the resolved filesystem target.
 * @throws {FsError} `FS_POLICY_DENIED` when the profile denies the target.
 */
export function assertFilePolicy(
  ctx: Context,
  exec: ToolExecution,
  operation: FileAccessOperation,
  target: FsTarget,
): void {
  const policy = ctx.get('toolPolicy')
  if (policy === undefined) return
  policy.assertFileAccess(operation, ctx.fs.processPath(target), exec)
}
