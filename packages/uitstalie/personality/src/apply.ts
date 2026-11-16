/**
 * The confirmed `personality_apply` write: validate candidates, refuse identity,
 * and upsert each one into the global profile through the version guard.
 *
 * The tool is registered only for root agents by the capability contribution;
 * the function itself is independent of that registration so tests can call it
 * directly. There is no automatic call path.
 * @module @deepseek-ai/dsh-personality/apply
 */

import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-error'
import { globalPersonalityPath, upsertGlobalPersonalityEntry } from './global-store.ts'
import type { PersonalityEntryKind } from './global-store.ts'
import type { EvidenceRef } from './analyze.ts'

/** One candidate submitted for a confirmed write. */
export interface ApplyCandidate {
  /** Entry kind; identity is rejected. */
  readonly kind: PersonalityEntryKind
  /** Lower-kebab entry name. */
  readonly name: string
  /** Proposed text, at most 400 characters. */
  readonly text: string
  /** At least one evidence excerpt. */
  readonly evidence: readonly EvidenceRef[]
}

/** One apply request. */
export interface ApplyInput {
  /** Candidates to write, 1–20. */
  readonly candidates: readonly ApplyCandidate[]
  /** Required literal true; a missing or false value writes nothing. */
  readonly confirm: true
}

/** One apply result. */
export interface ApplyResult {
  /** Entry ids written. */
  readonly applied: readonly string[]
  /** Candidates refused before writing. */
  readonly rejected: readonly { readonly name: string; readonly reason: string }[]
  /** Global profile path. */
  readonly path: string
  /** Last successful revision, or 0 when nothing was written. */
  readonly revision: number
}

/** Typed invalid apply request. */
export class ApplyError extends HarnessError {
  /**
   * @param message - reason naming the invalid field.
   */
  constructor(message: string) {
    super(message, 'PERSONALITY_APPLY_INVALID')
  }
}

/**
 * Write confirmed candidates; identity and per-candidate failures are rejected individually.
 * @param ctx - plugin context carrying the global store.
 * @param input - candidate batch and the required literal `confirm: true`.
 * @param signal - cancellation for the reads and guarded writes.
 * @returns applied entry ids, per-candidate rejections, the profile path, and the last successful revision (0 when nothing was written).
 * @throws ApplyError when confirmation is not the literal true or the batch size is outside 1–20.
 */
export async function applyPersonalityCandidates(
  ctx: Context,
  input: ApplyInput,
  signal: AbortSignal,
): Promise<ApplyResult> {
  // Tool arguments arrive as untyped JSON; widen before the confirmation gate.
  const confirm: unknown = input.confirm
  if (confirm !== true) throw new ApplyError('confirm must be the literal true; the user must explicitly ask to apply')
  if (input.candidates.length < 1 || input.candidates.length > 20) {
    throw new ApplyError('candidates must contain 1 to 20 entries')
  }
  const applied: string[] = []
  const rejected: { name: string; reason: string }[] = []
  let revision = 0
  for (const candidate of input.candidates) {
    if (candidate.evidence.length === 0) {
      rejected.push({ name: candidate.name, reason: 'evidence must contain at least one excerpt' })
      continue
    }
    try {
      const written = await upsertGlobalPersonalityEntry(ctx, {
        kind: candidate.kind,
        name: candidate.name,
        text: candidate.text,
      }, signal)
      applied.push(written.entry.id)
      revision = written.revision
    } catch (error: unknown) {
      rejected.push({ name: candidate.name, reason: String(error) })
    }
  }
  return { applied, rejected, path: globalPersonalityPath(), revision }
}

/**
 * Render one apply result as a compact model-facing report.
 * @param result - apply result to report.
 * @returns a summary line with the path and revision, then one line per applied id and per rejection.
 */
export function renderApplyResult(result: ApplyResult): string {
  const lines = [`Applied ${String(result.applied.length)} personality entr${result.applied.length === 1 ? 'y' : 'ies'} to ${result.path} (revision ${String(result.revision)}).`]
  for (const id of result.applied) lines.push(`- ${id}`)
  for (const item of result.rejected) lines.push(`- rejected ${item.name}: ${item.reason}`)
  return lines.join('\n')
}
