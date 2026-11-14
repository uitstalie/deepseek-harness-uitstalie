/**
 * The root-only `write_like_human` tool.
 *
 * It is a thin tool over `writing-rules.ts`: validate the request, read the
 * global file, mutate the document, and write it back through the store's
 * version guard with one stale retry. Failures are canonical results with a
 * readable one-line message, never thrown stacks. The tool is registered only
 * for a root agent by the capability's `tools(agent)` filter; section 695 is
 * still injected for every agent, so child agents read the rules but cannot
 * change them.
 * @module @deepseek-ai/dsh-personality/writing-tool
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { agentRole } from './role.ts'
import type { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  mutateWritingRules,
  previewWritingRules,
  readWritingRules,
  writeWritingRules,
  writingRulesPath,
  WRITING_RULES_RESIDENT_MAX,
} from './writing-rules.ts'
import type {
  WritingRule,
  WritingRuleAction,
  WritingRuleInput,
  WritingRulesMutation,
  WritingRulesRead,
} from './writing-rules.ts'

/** Actions that write the file; every other action only reads it. */
const WRITE_ACTIONS: ReadonlySet<WritingRuleAction> = new Set(['add', 'update', 'remove', 'enable', 'disable'])

/** One tool call result. `ok: false` carries the readable reason in `error`. */
export interface WriteLikeHumanResult {
  /** Action the caller requested. */
  readonly action: WritingRuleAction
  /** Whether the action completed. */
  readonly ok: boolean
  /** Readable failure reason; present only when `ok` is false. */
  readonly error?: string
  /** Current rules after a successful action, or the last readable rules after a failure. */
  readonly rules: readonly WritingRule[]
  /** Injected text; present only for `preview`. */
  readonly promptSection?: string
  /** Absolute path of the global writing-rules file. */
  readonly path: string
  /** Opaque store version after the action, when the store reports one. */
  readonly version?: string
}

/** Build the root-only writing-rules tool. */
export function writingRulesTool(ctx: Context, refresh: (agent: Agent) => Promise<void>): ToolDefinition {
  return defineTool({
    name: 'write_like_human',
    description:
      'Maintain the global WRITING_RULES.yaml. The change affects every agent, not only this conversation. '
      + 'Use list/preview to inspect rules, and add/update/remove/enable/disable to write them; writes are '
      + 'global and version-guarded, with one internal retry on a stale conflict. If the retry still '
      + 'fails, call list for the latest state before retrying; do not blindly repeat the same call. '
      + 'Only a root agent can call this tool. Child agents only read the '
      + 'injected rules; they must return to the main conversation to request a change.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['list', 'add', 'update', 'remove', 'enable', 'disable', 'preview'],
        description: 'list/preview need no other field; add needs text; update needs id and accepts text/order/enabled; remove and enable/disable need id.',
      },
      id: { type: 'string', description: 'Required for update/remove/enable/disable; optional for add (generated when absent).' },
      text: { type: 'string', description: 'Required for add; optional for update. Trimmed and whitespace-collapsed.' },
      order: { type: 'integer', description: 'Optional safe-integer order; add appends, update preserves unless supplied.' },
      enabled: { type: 'boolean', description: 'Optional enabled state; add defaults true, update preserves unless supplied.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          ok: { type: 'boolean', required: true },
          error: { type: 'string' },
          rules: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                text: { type: 'string', required: true },
                enabled: { type: 'boolean', required: true },
                order: { type: 'integer', required: true },
              },
            },
          },
          promptSection: { type: 'string' },
          path: { type: 'string', required: true },
          version: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderWritingRulesResult(value as never) }],
    },
    async execute(args, exec) {
      const agent = requireAgent(exec.agent, 'write_like_human')
      if (agentRole(agent) === 'subagent') throw new Error('write_like_human is unavailable to subagents')
      const result = await runWritingRuleAction(ctx, args as WritingRuleInput, exec.signal)
      if (result.ok && WRITE_ACTIONS.has(result.action)) await refresh(agent)
      return result as never
    },
  })
}

/**
 * Run one action against the global file.
 *
 * A stale guarded write is retried once after a fresh read; the mutation is
 * re-applied to that fresh document so a concurrent edit is not overwritten by
 * a stale derivation. A second stale failure is reported, not thrown.
 * @param ctx - context with the global store.
 * @param input - validated action and its optional fields.
 * @param signal - cancellation for the reads and the write.
 * @returns the current rules, preview text, path, and store version.
 */
export async function runWritingRuleAction(
  ctx: Context,
  input: WritingRuleInput,
  signal: AbortSignal,
): Promise<WriteLikeHumanResult> {
  for (let attempt = 0; ; attempt += 1) {
    let current: WritingRulesRead
    try {
      current = await readWritingRules(ctx, signal)
    } catch (error: unknown) {
      return failure(input.action, error, [], undefined)
    }
    let mutation: WritingRulesMutation
    try {
      mutation = mutateWritingRules(current.document, input)
    } catch (error: unknown) {
      return failure(input.action, error, current.document.rules, current.version)
    }
    if (!WRITE_ACTIONS.has(input.action)) {
      return {
        action: input.action,
        ok: true,
        rules: mutation.document.rules,
        ...input.action === 'preview' ? { promptSection: previewWritingRules(mutation.document) } : {},
        path: writingRulesPath(),
        ...current.version === undefined ? {} : { version: current.version },
      }
    }
    try {
      const written = await writeWritingRules(ctx, mutation.document, current.version, signal)
      return {
        action: input.action,
        ok: true,
        rules: mutation.document.rules,
        path: written.path,
        ...written.version === undefined ? {} : { version: written.version },
      }
    } catch (error: unknown) {
      if (attempt === 0 && isStaleWrite(error)) continue
      return failure(input.action, error, current.document.rules, current.version)
    }
  }
}

/** Render one result as the model-facing report. */
export function renderWritingRulesResult(result: WriteLikeHumanResult): string {
  if (!result.ok) return `write_like_human failed (${result.action}): ${String(result.error)}`
  const lines = [`write_like_human ${result.action}: ${String(result.rules.length)} rule(s) in ${result.path}`]
  for (const rule of result.rules) {
    lines.push(`- ${rule.id} [${rule.enabled ? 'on' : 'off'}, order ${String(rule.order)}] ${rule.text}`)
  }
  const enabled = result.rules.filter(rule => rule.enabled).length
  if (enabled > WRITING_RULES_RESIDENT_MAX) {
    lines.push('', `${String(enabled - WRITING_RULES_RESIDENT_MAX)} rule(s) not injected: resident limit is ${String(WRITING_RULES_RESIDENT_MAX)}.`)
  }
  if (result.action === 'preview') lines.push('', 'Injected text:', result.promptSection === undefined || result.promptSection === '' ? '(empty)' : result.promptSection)
  return lines.join('\n')
}

/** One failed result with the rules that could still be read. */
function failure(
  action: WritingRuleAction,
  error: unknown,
  rules: readonly WritingRule[],
  version: string | undefined,
): WriteLikeHumanResult {
  return {
    action,
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    rules,
    path: writingRulesPath(),
    ...version === undefined ? {} : { version },
  }
}

/** Whether a store write failed because the observed version moved. */
function isStaleWrite(error: unknown): boolean {
  return error instanceof FsError && (error.code === 'FS_STALE_VERSION' || error.code === 'FS_NOT_OBSERVED')
}

/** Require the owning agent a tool needs. */
function requireAgent(agent: Agent | undefined, tool: string): Agent {
  /* v8 ignore next -- the tool runtime always passes the owning agent. */
  if (agent === undefined) throw new Error(`${tool} requires an owning agent`)
  return agent
}
