/**
 * The read-only `personality_analyze` analysis: scan readable session logs,
 * extract evidence-backed candidates, and return them without touching a file.
 *
 * Other sessions must share the caller's exact cwd, the same authorization
 * rule the memory reader uses. A specified session outside that scope is a
 * warning, not a read. Evidence is one user-message excerpt plus its seq; a
 * candidate without evidence is never returned.
 * @module @deepseek-ai/dsh-personality/analyze
 */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionResultFilter } from '@deepseek-ai/dsh-session-query'
import type { PersonalityEntryKind } from './global-store.ts'

/** How much of the session corpus one analysis scans. */
export type AnalysisScope =
  | { readonly kind: 'current' }
  | { readonly kind: 'session'; readonly sessionId: string }
  | { readonly kind: 'recent'; readonly limit: number }

/** One analysis request. */
export interface AnalyzeInput {
  /** Required scan scope. */
  readonly scope: AnalysisScope
  /** Optional kinds; identity is rejected. */
  readonly kinds?: readonly PersonalityEntryKind[]
  /** Candidate cap, 1–20; defaults to 10. */
  readonly maxCandidates?: number
}

/** One exact excerpt that supports a candidate. */
export interface EvidenceRef {
  /** Session that contains the excerpt. */
  readonly sessionId: string
  /** Positive event seq of the user message. */
  readonly seq: number
  /** Exact excerpt, at most 400 characters. */
  readonly quote: string
  /** Turn containing the excerpt, when known. */
  readonly turn?: number
}

/** One proposed entry. */
export interface PersonalityCandidate {
  /** Stable hash of kind + name + text. */
  readonly candidateId: string
  /** Non-identity entry kind. */
  readonly kind: Exclude<PersonalityEntryKind, 'identity'>
  /** Lower-kebab proposed name. */
  readonly name: string
  /** Proposed entry text, at most 400 characters. */
  readonly text: string
  /** At least one concrete evidence excerpt. */
  readonly evidence: readonly EvidenceRef[]
  /** Number of matching user messages across scanned sessions. */
  readonly occurrences: number
  /** Confidence based on repetition. */
  readonly confidence: 'high' | 'medium'
}

/** One analysis result. */
export interface AnalyzeResult {
  /** Candidates in deterministic order. */
  readonly candidates: readonly PersonalityCandidate[]
  /** Sessions successfully observed. */
  readonly sessionsScanned: number
  /** Whether a session or candidate bound truncated the result. */
  readonly truncated: boolean
  /** Unreadable or out-of-scope sessions. */
  readonly warnings: readonly string[]
}

/** Typed invalid analysis request. */
export class AnalyzeError extends Error {
  /**
   * @param message - reason naming the invalid field.
   * @param code - stable failure kind.
   */
  constructor(message: string, readonly code: 'invalid-request') {
    super(message)
    this.name = 'AnalyzeError'
  }
}

/** One heuristic that turns a user sentence into a candidate. */
interface CandidateRule {
  /** Kind the rule maps to. */
  readonly kind: Exclude<PersonalityEntryKind, 'identity'>
  /** Stable name prefix. */
  readonly name: string
  /** Narrow explicit-correction pattern. */
  readonly pattern: RegExp
}

/** Explicit-correction rules; order gives style precedence over preference. */
const CANDIDATE_RULES: readonly CandidateRule[] = [
  {
    kind: 'understanding',
    name: 'explicit-correction',
    pattern: /^(?:其实[，,\s]?|不是这个意思|不是这样|我说的是|我的意思是|我指的是|i meant\b|not what i meant|actually[,\s])/iu,
  },
  {
    kind: 'style',
    name: 'reply-style',
    pattern: new RegExp(
      '^(?:以后|下次|from now on\\b|going forward\\b).*'
      + '(?:回复|回答|说话|写|语气|格式|风格|语言|中文|英文|reply|respond|write|format|tone|style|language|english|chinese)',
      'iu',
    ),
  },
  {
    kind: 'preference',
    name: 'durable-preference',
    pattern: /^(?:以后|下次|from now on\b|going forward\b)/iu,
  },
]

/** Candidate cap default. */
export const ANALYZE_DEFAULT_MAX_CANDIDATES = 10

/** Analyze readable sessions and return candidates without writing. */
export async function analyzePersonality(
  ctx: Context,
  caller: Session,
  input: AnalyzeInput,
  signal: AbortSignal,
): Promise<AnalyzeResult> {
  const kinds = normalizeKinds(input.kinds)
  const maxCandidates = normalizeMaxCandidates(input.maxCandidates)
  const { ids, warnings, truncated: sessionTruncated } = await readableSessions(ctx, caller, input.scope, signal)
  const candidates = new Map<string, PersonalityCandidate>()
  let sessionsScanned = 0
  for (const id of ids) {
    try {
      using observation = await ctx.sessionQuery.observeSession(id, { signal, projectionMode: 'none' })
      sessionsScanned += 1
      collectCandidates(candidates, observation.events, String(id), kinds)
    } catch (error: unknown) {
      warnings.push(`session ${String(id)} could not be read: ${String(error)}`)
    }
  }
  const ordered = [...candidates.values()]
    .map(candidate => ({
      ...candidate,
      confidence: candidate.occurrences >= 2 ? 'high' as const : 'medium' as const,
    }))
    .sort((left, right) => confidenceRank(right) - confidenceRank(left)
      || right.occurrences - left.occurrences
      || left.candidateId.localeCompare(right.candidateId))
  const truncated = sessionTruncated || ordered.length > maxCandidates
  return {
    candidates: ordered.slice(0, maxCandidates),
    sessionsScanned,
    truncated,
    warnings,
  }
}

/** Render one analysis result as a compact model-facing report. */
export function renderAnalyzeResult(result: AnalyzeResult): string {
  const lines = [
    `Scanned ${String(result.sessionsScanned)} session(s); ${String(result.candidates.length)} candidate(s)${result.truncated ? ' (truncated)' : ''}.`,
  ]
  for (const candidate of result.candidates) {
    const evidence = candidate.evidence
      .map(ref => `${ref.sessionId}#${String(ref.seq)}${ref.turn === undefined ? '' : ` (turn ${String(ref.turn)})`}`)
      .join(', ')
    lines.push(`- ${candidate.kind}.${candidate.name} [${candidate.confidence}, ${String(candidate.occurrences)}x] ${candidate.text} — ${evidence}`)
  }
  for (const warning of result.warnings) lines.push(`warning: ${warning}`)
  return lines.join('\n')
}

/** Validate and expand the kind filter. */
function normalizeKinds(kinds: readonly PersonalityEntryKind[] | undefined): ReadonlySet<Exclude<PersonalityEntryKind, 'identity'>> {
  const selected = kinds ?? ['understanding', 'preference', 'style']
  if (selected.includes('identity')) throw new AnalyzeError('identity is manual-only and cannot be analyzed as a candidate kind', 'invalid-request')
  return new Set(selected.filter((kind): kind is Exclude<PersonalityEntryKind, 'identity'> => kind !== 'identity'))
}

/** Validate the candidate cap. */
function normalizeMaxCandidates(value: number | undefined): number {
  const max = value ?? ANALYZE_DEFAULT_MAX_CANDIDATES
  if (!Number.isSafeInteger(max) || max < 1 || max > 20) throw new AnalyzeError('maxCandidates must be an integer from 1 to 20', 'invalid-request')
  return max
}

/** Resolve the sessions one scope may read. */
async function readableSessions(
  ctx: Context,
  caller: Session,
  scope: AnalysisScope,
  signal: AbortSignal,
): Promise<{ readonly ids: readonly SessionId[]; readonly warnings: string[]; readonly truncated: boolean }> {
  const warnings: string[] = []
  const cwd = caller.header.cwd
  if (scope.kind === 'current') return { ids: [caller.id], warnings, truncated: false }
  if (scope.kind === 'session') {
    const target = SessionId(scope.sessionId)
    if (target === caller.id) return { ids: [target], warnings, truncated: false }
    if (cwd === undefined) {
      warnings.push(`session ${String(target)} is outside this caller's workspace (the caller has no cwd)`)
      return { ids: [], warnings, truncated: false }
    }
    const filters: readonly SessionResultFilter[] = [
      { kind: 'id', values: [target] },
      { kind: 'cwd', values: [cwd] },
    ]
    const records = await ctx.sessionQuery.filterSessions(filters, signal)
    if (records.length !== 1) {
      warnings.push(`session ${String(target)} is not readable in this workspace`)
      return { ids: [], warnings, truncated: false }
    }
    return { ids: [target], warnings, truncated: false }
  }
  const limit = scope.limit
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
    throw new AnalyzeError('recent.limit must be an integer from 1 to 20', 'invalid-request')
  }
  if (cwd === undefined) {
    warnings.push('the caller has no cwd; only the current session was analyzed')
    return { ids: [caller.id], warnings, truncated: false }
  }
  const records = await ctx.sessionQuery.filterSessions([{ kind: 'cwd', values: [cwd] }], signal)
  return {
    ids: records.slice(0, limit).map(record => record.header.id),
    warnings,
    truncated: records.length > limit,
  }
}

/** Fold one session's user messages into the candidate map. */
function collectCandidates(
  candidates: Map<string, PersonalityCandidate>,
  events: readonly SessionEvent[],
  sessionId: string,
  kinds: ReadonlySet<Exclude<PersonalityEntryKind, 'identity'>>,
): void {
  let turn: number | undefined
  for (const event of events) {
    if (event.type === 'turn/start') {
      turn = event.data.turn
      continue
    }
    if (event.type !== 'user/message' || event.data.source.kind !== 'user') continue
    /* v8 ignore start -- non-text user blocks carry no excerpt for a candidate. */
    const text = event.data.content
      .flatMap(block => block.type === 'text' ? [block.text] : [])
      .join('\n')
      .trim()
    /* v8 ignore stop */
    if (text.length === 0 || Array.from(text).length > 400) continue
    const rule = CANDIDATE_RULES.find(candidate => candidate.pattern.test(text))
    if (rule === undefined || !kinds.has(rule.kind)) continue
    const name = `${rule.name}-${hash(text).slice(0, 8)}`
    const candidateId = hash(`${rule.kind}\u0000${name}\u0000${text}`)
    const evidence: EvidenceRef = {
      sessionId,
      seq: event.seq,
      quote: Array.from(text).slice(0, 400).join(''),
      ...turn === undefined ? {} : { turn },
    }
    const existing = candidates.get(candidateId)
    if (existing === undefined) {
      candidates.set(candidateId, {
        candidateId,
        kind: rule.kind,
        name,
        text,
        evidence: [evidence],
        occurrences: 1,
        confidence: 'medium',
      })
      continue
    }
    candidates.set(candidateId, {
      ...existing,
      evidence: existing.evidence.length < 3 ? [...existing.evidence, evidence] : existing.evidence,
      occurrences: existing.occurrences + 1,
    })
  }
}

/** Rank high confidence above medium. */
function confidenceRank(candidate: PersonalityCandidate): number {
  return candidate.confidence === 'high' ? 1 : 0
}

/** Stable short hash used for ids. */
function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}
