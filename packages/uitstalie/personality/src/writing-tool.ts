/**
 * The writing-rules actions behind `personality_apply`.
 *
 * This module is a thin layer over `writing-rules.ts`: validate the request,
 * read the global file, mutate the document, and write it back through the
 * store's version guard with one stale retry. Failures are canonical results
 * with a readable one-line message, never thrown stacks. `agent-tools.ts`
 * calls `runWritingRuleAction` from the root-only `personality_apply`; section
 * 695 is still injected for every agent, so child agents read the rules but
 * cannot change them.
 * @module @deepseek-ai/dsh-personality/writing-tool
 */

import type { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
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
export const WRITING_RULE_WRITE_ACTIONS: ReadonlySet<WritingRuleAction> = new Set(['add', 'update', 'remove', 'enable', 'disable'])

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
    if (!WRITING_RULE_WRITE_ACTIONS.has(input.action)) {
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

/**
 * Render one result as the model-facing report.
 * @param result - action result to report.
 * @returns the failure line, or the action summary with one line per rule, an omission note, and preview text when applicable.
 */
export function renderWritingRulesResult(result: WriteLikeHumanResult): string {
  if (!result.ok) return `personality_apply failed (${result.action}): ${String(result.error)}`
  const lines = [`personality_apply ${result.action}: ${String(result.rules.length)} rule(s) in ${result.path}`]
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
