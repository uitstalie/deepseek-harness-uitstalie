/**
 * Pure rules of intent cards: source annotations, point identities, coverage,
 * and post-execution alignment.
 *
 * The rules live outside the tool and the store so the task dispatcher and the
 * receipt gate apply the same point identities and the same normalization.
 * Nothing here reads or writes storage.
 * @module @deepseek-ai/dsh-workspace-tools/intent-rules
 */

import { isAbsolute } from 'node:path'
import { WorkspaceIntentError } from './errors.ts'
import type {
  IntentItem,
  IntentItemKind,
  IntentItems,
  TaskAlignment,
  TaskCoverage,
  TaskNonCoverage,
} from './records.ts'
import { INTENT_ITEM_KINDS } from './records.ts'

/** Largest card text kept, in characters. */
export const INTENT_RAW_TEXT_MAX_LENGTH = 8192

/** Largest item text kept, in characters. */
export const INTENT_ITEM_TEXT_MAX_LENGTH = 2000

/** Largest number of items accepted per card part. */
export const INTENT_ITEMS_PER_KIND_MAX = 20

/** One card item with its stable point identity. */
export interface CardPoint {
  /** Stable point identity, such as `acceptance[0]`. */
  readonly point: string
  /** Card part the item belongs to. */
  readonly kind: IntentItemKind
  /** Zero-based position inside the part. */
  readonly index: number
  /** The item itself. */
  readonly item: IntentItem
}

/** One item of the consolidated confirmation request. */
export interface ConfirmationItem {
  /** Stable point identity. */
  readonly point: string
  /** Item text. */
  readonly text: string
  /** Why the item was inferred. */
  readonly reason: string
}

/** The one consolidated confirmation request a proposed version carries. */
export interface ConfirmationRequest {
  /** Stable request id: `confirm-<intentId>-v<n>`. */
  readonly requestId: string
  /** Inferred items to confirm; never one request per item. */
  readonly items: ConfirmationItem[]
}

/** One card point with no effective coverage. */
export interface MissingCoverage {
  /** Card point left uncovered. */
  readonly point: string
  /** Concrete reason the point is not covered. */
  readonly reason: string
}

/** Coverage check outcome. */
export interface CoverageCheck {
  /** Card points with no coverage entry or no brief item that matches. */
  readonly missing: MissingCoverage[]
  /** Coverage or non-coverage entries that do not name an existing card point. */
  readonly unknown: string[]
}

/** Alignment check outcome. */
export interface AlignmentCheck {
  /** Card points with no alignment entry. */
  readonly missing: string[]
  /** Alignment entries that do not name an existing card point, or repeat one. */
  readonly unknown: string[]
  /** Acceptance points checked as `not_satisfied`. */
  readonly unsatisfied: string[]
  /** Boundaries checked as `violated`. */
  readonly violated: string[]
  /** Output-form points checked as `not_matched`. */
  readonly notMatched: string[]
}

/** Stable point identity of one card item. */
export function pointLabel(kind: IntentItemKind, index: number): string {
  return `${kind}[${String(index)}]`
}

/**
 * Flatten card items into their stable points, in report order.
 * @param items - card items.
 * @returns one entry per item.
 */
export function cardPoints(items: IntentItems): CardPoint[] {
  const points: CardPoint[] = []
  for (const kind of INTENT_ITEM_KINDS) {
    items[kind].forEach((item, index) => {
      points.push({ point: pointLabel(kind, index), kind, index, item })
    })
  }
  return points
}

/**
 * Compute the state a version is created with from its source annotations.
 * @param items - card items.
 * @returns `active` when every item is traceable, else `proposed`.
 */
export function initialIntentStatus(items: IntentItems): 'proposed' | 'active' {
  return cardPoints(items).some(({ item }) => item.source === 'inference') ? 'proposed' : 'active'
}

/**
 * Build the single confirmation request a proposed version carries.
 * @param intentId - card identity.
 * @param version - proposed version number.
 * @param items - card items.
 * @returns the request, or undefined when no item is inferred.
 */
export function confirmationRequest(
  intentId: string,
  version: number,
  items: IntentItems,
): ConfirmationRequest | undefined {
  const inferred = cardPoints(items).filter(({ item }) => item.source === 'inference')
  if (inferred.length === 0) return undefined
  return {
    requestId: `confirm-${intentId}-v${String(version)}`,
    items: inferred.map(({ point, item }) => ({
      point,
      text: item.text,
      reason: item.reason ?? 'inferred from the request rather than quoted from the user',
    })),
  }
}

/**
 * Validate and normalize card items before they are stored.
 *
 * A `user-verbatim` item must be copied from the user's words; a
 * `user-anchor` item must name a workspace-relative document; an `inference`
 * keeps an explicit reason so the confirmation request can explain it.
 * @param rawUserText - the user's original words, verbatim.
 * @param items - caller-supplied items.
 * @returns the normalized items.
 * @throws WorkspaceIntentError `INTENT_INVALID` for any malformed item.
 */
export function normalizeIntentItems(rawUserText: string, items: IntentItems): IntentItems {
  if (rawUserText.length === 0) {
    throw new WorkspaceIntentError('rawUserText must be the user\'s original words and cannot be empty', 'INTENT_INVALID')
  }
  if (rawUserText.length > INTENT_RAW_TEXT_MAX_LENGTH) {
    throw new WorkspaceIntentError(
      `rawUserText is ${String(rawUserText.length)} characters; the bound is ${String(INTENT_RAW_TEXT_MAX_LENGTH)}`,
      'INTENT_INVALID',
    )
  }
  const normalized: Record<IntentItemKind, IntentItem[]> = {
    goal: [],
    acceptance: [],
    boundaries: [],
    outputForm: [],
  }
  for (const kind of INTENT_ITEM_KINDS) {
    const bucket = items[kind]
    if (bucket.length > INTENT_ITEMS_PER_KIND_MAX) {
      throw new WorkspaceIntentError(
        `${kind} holds ${String(bucket.length)} items; the bound is ${String(INTENT_ITEMS_PER_KIND_MAX)}`,
        'INTENT_INVALID',
      )
    }
    bucket.forEach((item, index) => {
      normalized[kind].push(normalizeIntentItem(rawUserText, kind, index, item))
    })
  }
  if (INTENT_ITEM_KINDS.every(kind => normalized[kind].length === 0)) {
    throw new WorkspaceIntentError('a card needs at least one goal, acceptance, boundary, or output-form item', 'INTENT_INVALID')
  }
  return normalized
}

/**
 * Validate one item and fill its defaults.
 * @param rawUserText - the user's original words.
 * @param kind - card part.
 * @param index - position inside the part.
 * @param item - caller-supplied item.
 * @returns the normalized item.
 */
function normalizeIntentItem(
  rawUserText: string,
  kind: IntentItemKind,
  index: number,
  item: IntentItem,
): IntentItem {
  const point = pointLabel(kind, index)
  const text = item.text.trim()
  if (text.length === 0) {
    throw new WorkspaceIntentError(`${point} has empty text`, 'INTENT_INVALID')
  }
  if (text.length > INTENT_ITEM_TEXT_MAX_LENGTH) {
    throw new WorkspaceIntentError(
      `${point} is ${String(text.length)} characters; the bound is ${String(INTENT_ITEM_TEXT_MAX_LENGTH)}`,
      'INTENT_INVALID',
    )
  }
  if (item.source === 'user-verbatim') {
    if (!rawUserText.includes(item.text)) {
      throw new WorkspaceIntentError(
        `${point} is marked user-verbatim but its text is not copied from rawUserText; quote the user's words exactly or use an inference`,
        'INTENT_INVALID',
      )
    }
    return { text: item.text, source: 'user-verbatim' }
  }
  if (item.source === 'user-anchor') {
    if (item.anchor === undefined || !isWorkspaceRelative(item.anchor.path)) {
      throw new WorkspaceIntentError(
        `${point} is marked user-anchor but has no workspace-relative anchor path`,
        'INTENT_INVALID',
      )
    }
    return {
      text: item.text,
      source: 'user-anchor',
      anchor: {
        path: item.anchor.path,
        ...item.anchor.heading === undefined ? {} : { heading: item.anchor.heading },
      },
    }
  }
  return {
    text: item.text,
    source: 'inference',
    reason: item.reason === undefined || item.reason.trim().length === 0
      ? 'inferred from the request rather than quoted from the user'
      : item.reason.trim(),
  }
}

/**
 * Whether a path is workspace-relative and stays inside the workspace lexically.
 * @param path - anchor path.
 * @returns whether the path names a document below the workspace root.
 */
export function isWorkspaceRelative(path: string): boolean {
  if (path.length === 0 || path.startsWith('/') || isAbsolute(path)) return false
  return !path.split(/[\\/]/u).some(segment => segment === '..')
}

/**
 * Text of the card points whose text changed between two item sets.
 * @param previous - previous items, when the correction has one.
 * @param next - corrected items.
 * @returns the new or changed item texts.
 */
export function changedPointTexts(previous: IntentItems | undefined, next: IntentItems): string[] {
  if (previous === undefined) return cardPoints(next).map(({ item }) => item.text)
  const before = new Map(cardPoints(previous).map(({ point, item }) => [point, item.text]))
  return cardPoints(next)
    .filter(({ point, item }) => before.get(point) !== item.text)
    .map(({ item }) => item.text)
}

/**
 * Point identities whose text changed between two item sets.
 * @param previous - previous items, when the correction has one.
 * @param next - corrected items.
 * @returns the changed point identities, in report order.
 */
export function changedPointRefs(previous: IntentItems | undefined, next: IntentItems): string[] {
  if (previous === undefined) return cardPoints(next).map(({ point }) => point)
  const before = new Map(cardPoints(previous).map(({ point, item }) => [point, item.text]))
  return cardPoints(next)
    .filter(({ point, item }) => before.get(point) !== item.text)
    .map(({ point }) => point)
}

/**
 * Normalize one task-brief item for exact comparison with a coverage mapping.
 * @param text - brief item text.
 * @returns whitespace-collapsed text.
 */
export function normalizeBriefItem(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

/**
 * Check that every card point maps to an item of the task brief.
 *
 * There is no default pass: a point with no coverage entry, or with a coverage
 * entry that names no brief item, stays missing. `nonCoverage` waives a point
 * only with an explicit reason, and the same point cannot be both.
 * @param items - card items of the referenced version.
 * @param brief - task-brief items: goal, acceptance, boundaries, and output form.
 * @param coverage - caller-supplied mappings.
 * @param nonCoverage - caller-supplied waivers.
 * @returns the missing and unknown points.
 */
export function checkCoverage(
  items: IntentItems,
  brief: readonly string[],
  coverage: readonly TaskCoverage[] | undefined,
  nonCoverage: readonly TaskNonCoverage[] | undefined,
): CoverageCheck {
  const points = new Set(cardPoints(items).map(({ point }) => point))
  const briefItems = new Set(brief.map(normalizeBriefItem).filter(text => text.length > 0))
  const covered = new Map<string, TaskCoverage>()
  const waived = new Map<string, TaskNonCoverage>()
  const unknown: string[] = []
  for (const entry of coverage ?? []) {
    if (!points.has(entry.point)) unknown.push(entry.point)
    else covered.set(entry.point, entry)
  }
  for (const entry of nonCoverage ?? []) {
    if (!points.has(entry.point)) unknown.push(entry.point)
    else waived.set(entry.point, entry)
  }
  const missing: MissingCoverage[] = []
  for (const { point } of cardPoints(items)) {
    const mapping = covered.get(point)
    const waiver = waived.get(point)
    if (mapping !== undefined && waiver !== undefined) {
      missing.push({ point, reason: 'the point is both mapped and waived; choose one' })
    } else if (mapping !== undefined) {
      if (!briefItems.has(normalizeBriefItem(mapping.brief))) {
        missing.push({ point, reason: `coverage names no item of the task brief: ${JSON.stringify(mapping.brief)}` })
      }
    } else if (waiver !== undefined) {
      if (waiver.reason.trim().length === 0) {
        missing.push({ point, reason: 'the non-coverage waiver has no reason' })
      }
    } else {
      missing.push({ point, reason: 'no coverage entry and no non-coverage reason' })
    }
  }
  return { missing, unknown }
}

/**
 * Check one post-execution alignment against the card version it references.
 *
 * Every card point is expected once. A missing point is reported separately so
 * a `done` gate can refuse an incomplete checklist instead of assuming it
 * passed.
 * @param items - card items of the task's version.
 * @param alignment - caller-supplied alignment.
 * @param intentId - card identity the task references.
 * @param intentVersion - card version the task references.
 * @returns the alignment check.
 */
export function checkAlignment(
  items: IntentItems,
  alignment: TaskAlignment,
  intentId: string,
  intentVersion: number,
): AlignmentCheck {
  if (alignment.intentId !== intentId || alignment.intentVersion !== intentVersion) {
    throw new WorkspaceIntentError(
      `alignment checks ${alignment.intentId} v${String(alignment.intentVersion)}, but the task references ${intentId} v${String(intentVersion)}`,
      'INTENT_INVALID',
    )
  }
  const points = cardPoints(items).filter(({ kind }) => kind !== 'goal')
  const expected = new Map<string, IntentItemKind>(points.map(({ point, kind }) => [point, kind]))
  const seen = new Set<string>()
  const unknown: string[] = []
  const unsatisfied: string[] = []
  const violated: string[] = []
  const notMatched: string[] = []
  const check = (
    kind: IntentItemKind,
    entries: readonly { readonly point: string; readonly status: string; readonly evidence: string }[],
  ): void => {
    for (const entry of entries) {
      if (expected.get(entry.point) !== kind) unknown.push(entry.point)
      else if (seen.has(entry.point)) unknown.push(entry.point)
      else seen.add(entry.point)
      if (entry.evidence.trim().length === 0) {
        unknown.push(`${entry.point} (no evidence)`)
      }
    }
  }
  check('acceptance', alignment.acceptance)
  check('boundaries', alignment.boundaries)
  check('outputForm', alignment.outputForm)
  const missing = points.filter(({ point }) => !seen.has(point)).map(({ point }) => point)
  for (const entry of alignment.acceptance) {
    if (entry.status === 'not_satisfied') unsatisfied.push(entry.point)
  }
  for (const entry of alignment.boundaries) {
    if (entry.status === 'violated') violated.push(entry.point)
  }
  for (const entry of alignment.outputForm) {
    if (entry.status === 'not_matched') notMatched.push(entry.point)
  }
  return { missing, unknown, unsatisfied, violated, notMatched }
}
