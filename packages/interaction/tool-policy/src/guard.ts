/**
 * The monotonic tool gate: `ctx.tools.guard()` denies a tool call by name
 * after the extensible pre-execute policy, so neither listener ordering nor a
 * stale visibility mask can turn a denial back into permission.
 *
 * @module @deepseek-ai/dsh-tool-policy/guard
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import type { ToolPolicyService } from './index.ts'

/**
 * Register the policy guard on the tools service.
 * @param tools - the scoped context that owns `ctx.tools` (an `ctx.inject` child).
 * @param service - the policy service resolving the calling session's profile.
 * @returns the guard disposer.
 */
export function installToolGuard(tools: Context, service: ToolPolicyService): () => void {
  return tools.tools.guard(exec => service.toolDenialReason(exec.name, exec))
}
