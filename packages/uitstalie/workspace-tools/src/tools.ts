/**
 * The model-facing tools of the workspace toolset.
 *
 * Every tool is scoped to the calling session's workspace and is visible to
 * every agent in it, so an ordinary workspace session and the super agent use
 * the same read contract. Mutating actions check the caller's role inside the
 * tool: dispatching and card changes require the super agent, while the target
 * session may report on its own task.
 * @module @deepseek-ai/dsh-workspace-tools/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { workspaceArtifactsTool } from './artifacts.ts'
import { askUserQuestionPlusTool } from './ask.ts'
import { workspaceIntentsTool } from './intents.ts'
import { workspaceMessageTool } from './messages.ts'
import { workspaceSessionsTool } from './sessions.ts'
import { workspaceTasksTool } from './tasks.ts'

/**
 * Build the workspace toolset for one root agent.
 * @param ctx - context carrying the store, session-query, filesystem, and registry.
 * @returns the tools, in registration order.
 */
export function workspaceTools(ctx: Context): readonly ToolDefinition[] {
  return [
    { ...workspaceSessionsTool(ctx), minRole: 'subagent' },
    { ...workspaceTasksTool(ctx), minRole: 'subagent' },
    { ...workspaceMessageTool(ctx), minRole: 'subagent' },
    { ...workspaceArtifactsTool(ctx), minRole: 'subagent' },
    { ...workspaceIntentsTool(ctx), minRole: 'subagent' },
    { ...askUserQuestionPlusTool(ctx), minRole: 'subagent' },
  ]
}
