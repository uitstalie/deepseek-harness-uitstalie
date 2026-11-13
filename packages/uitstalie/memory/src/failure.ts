/**
 * Shared failure classification for memory work.
 *
 * Summary passes and automatic cleanup report the same stable codes so a
 * failure that appears in a notice or a log cannot invent a second taxonomy.
 * @module @deepseek-ai/dsh-memory/failure
 */

import { FsError } from '@deepseek-ai/dsh-fs'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { errorMessage } from './text.ts'

/** Stable machine code for one failed memory operation. */
export type MemorySummaryFailureCode =
  | 'BUDGET_EXCEEDED'
  | 'FILE_IO'
  | 'NO_TARGET'
  | 'EMPTY_OUTPUT'
  | 'UPSTREAM_RATE_LIMIT'
  | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_FAILED'
  | 'UNKNOWN'

/** Classified failure of one memory operation. */
export interface MemorySummaryFailure {
  /** Stable code the notice and logs carry. */
  readonly code: MemorySummaryFailureCode
  /** One short cause phrase, bounded by the notice's character budget. */
  readonly detail: string
  /** Attempts this operation made. */
  readonly attempts: number
}

/**
 * Classify one memory failure into the shared code and a short cause phrase.
 * @param error - caught failure from a model call, repository write, or cleanup.
 * @param attempts - attempts made before giving up.
 * @returns the stable classification used by notices and logs.
 */
export function classifySummaryFailure(error: unknown, attempts: number): MemorySummaryFailure {
  const documentCode = error instanceof Error && error.name === 'MemoryDocumentError'
    ? (error as { readonly code?: unknown }).code
    : undefined
  if (documentCode !== undefined) {
    return documentCode === 'budget-exceeded'
      ? { code: 'BUDGET_EXCEEDED', detail: 'body over the byte budget', attempts }
      : { code: 'FILE_IO', detail: 'MEMORY.md could not be written', attempts }
  }
  if (error instanceof FsError) {
    return { code: 'FILE_IO', detail: `filesystem error ${error.code}`, attempts }
  }
  if (error instanceof LlmError) {
    switch (error.code) {
      case 'RATE_LIMIT':
      case 'QUOTA':
      case 'ACCOUNT_QUOTA':
        return { code: 'UPSTREAM_RATE_LIMIT', detail: 'provider rate-limited', attempts }
      case 'TIMEOUT':
        return { code: 'UPSTREAM_TIMEOUT', detail: 'provider request timed out', attempts }
      case 'NO_ADAPTER':
      case 'UNKNOWN_MODEL':
      case 'MISSING_CREDENTIAL':
      case 'AUTH':
      case 'INVALID_CREDENTIAL':
        return { code: 'UPSTREAM_FAILED', detail: `request rejected (${error.code})`, attempts }
      default:
        return { code: 'UPSTREAM_FAILED', detail: `provider stream failed (${error.code})`, attempts }
    }
  }
  const message = errorMessage(error)
  if (message.includes('no provider/model available')) {
    return { code: 'NO_TARGET', detail: 'no summary model route is available', attempts }
  }
  if (message.includes('produced no text')) {
    return { code: 'EMPTY_OUTPUT', detail: 'the model returned no text', attempts }
  }
  if (message.includes('hit the output token cap')) {
    return { code: 'UPSTREAM_FAILED', detail: 'the model hit its output token cap', attempts }
  }
  return { code: 'UNKNOWN', detail: 'see the debug log', attempts }
}
