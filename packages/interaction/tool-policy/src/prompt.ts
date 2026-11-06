/**
 * Model-facing prompt for the active soft tool policy.
 *
 * The text must never claim OS enforcement: the process is unconfined, and the
 * policy only denies model tool calls. It names the denied paths and tools so
 * the model can avoid wasted calls, and it states the bypass surface explicitly.
 *
 * @module @deepseek-ai/dsh-tool-policy/prompt
 */

import { FILE_ACCESS_OPERATIONS } from './types.ts'
import type { FileAccessOperation, PreparedProfile } from './types.ts'

function operationsOf(rule: PreparedProfile['paths'][number]): string {
  return FILE_ACCESS_OPERATIONS.filter((operation: FileAccessOperation) => rule.operations.has(operation)).join('/')
}

/**
 * Render the runtime-context line for one prepared profile.
 * @param profile - the profile in force for the calling session.
 * @returns the exact prompt text.
 */
export function renderToolPolicyPrompt(profile: PreparedProfile): string {
  const deniedPaths = profile.paths.map(rule => `${rule.displayPath} (${operationsOf(rule)}${rule.reason === undefined ? '' : `: ${rule.reason}`})`)
  const deniedTools = profile.tools.map(rule => `${rule.name}${rule.reason === undefined ? '' : ` (${rule.reason})`}`)
  const lines = [
    `Current DSH tool policy: ${profile.name} (soft policy; the process has full user permissions and is NOT OS-confined).`,
    profile.description,
  ]
  if (deniedPaths.length > 0) lines.push(`File-tool access is denied for: ${deniedPaths.join(', ')}.`)
  else lines.push('No file-tool path denials are configured.')
  if (deniedTools.length > 0) lines.push(`Tools denied: ${deniedTools.join(', ')}.`)
  lines.push(
    'This policy only checks model tool calls. Shell commands, scripts, PTC code, MCP tools, and direct native '
    + 'file access are not path-checked by it; do not use them to reach a denied path.',
  )
  return lines.join(' ')
}
