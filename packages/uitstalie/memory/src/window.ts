/**
 * Pure forgetting-window planning.
 *
 * The planner reads one MEMORY.md document and returns the tier migrations for
 * one session without touching the file, the model, or the session surface. A
 * turn's relative age is `currentTurn - turn`, so the current turn has age 0:
 * ages below `detail` stay verbatim, ages below `brief` stay detail, ages below
 * `forget` become brief, and older turns are forgotten.
 *
 * A stored section carries one heading and one entry list for a run of turns,
 * with no per-entry turn mapping. A section therefore migrates only when every
 * turn it covers reaches the same action; a partially crossed section waits for
 * the next pass. The returned window values are the frontmatter state after the
 * successful part of that plan.
 * @module @deepseek-ai/dsh-memory/window
 */

import type {
  MemoryDocument,
  MemorySection,
  MemorySessionRecord,
  MemoryTier,
  MemoryTurnRecord,
  MemoryWindow,
} from './memory-file.ts'

/** One consecutive turn run that migrates as a whole. */
export interface TurnRange {
  /** First turn covered by the run. */
  readonly startTurn: number
  /** Last turn covered by the run. */
  readonly endTurn: number
  /** Inclusive seq range from the first turn's start through the last turn's end. */
  readonly seq: readonly [number, number]
  /** Tier stored for the run before the migration. */
  readonly tier: MemoryTier
  /** Seq of the memory checkpoint already recorded for the run, when one exists. */
  readonly checkpointSeq?: number
}

/** One session's frontmatter state after the planned migration. */
export interface MemoryWindowSnapshot {
  /** Session these values belong to. */
  readonly sessionId: string
  /** Turn records with each successful brief migration applied. */
  readonly turns: readonly MemoryTurnRecord[]
  /** Highest turn whose summary body is forgotten after this plan. */
  readonly forgottenThrough?: number
}

/** Explicit migrations for one session; the caller applies them to the file. */
export interface TierMigrationPlan {
  /** Session the plan was computed for. */
  readonly sessionId: string
  /** Detail sections that become brief. */
  readonly toBrief: readonly TurnRange[]
  /** Detail or brief sections whose bodies leave the managed block. */
  readonly toForget: readonly TurnRange[]
  /** New frontmatter values to record after applying the plan. */
  readonly window: MemoryWindowSnapshot
}

/** Window thresholds plus the session whose turns the ages measure. */
export interface TierMigrationConfig extends MemoryWindow {
  /** Session to plan; absent uses the most recently updated session record. */
  readonly sessionId?: string
}

/** What a turn's age asks the window to do. */
type TurnAction = 'none' | 'brief' | 'forget'

/**
 * Plan one session's tier migrations.
 *
 * The current turn's record may already exist at age 0; it never migrates. A
 * section's turns are read from the frontmatter, so a section with a missing
 * turn record is skipped rather than guessed. Already-brief and already-forgotten
 * runs produce no instruction, which makes repeated calls idempotent.
 * @param document - parsed MEMORY.md.
 * @param currentTurn - latest completed turn of the session being summarized.
 * @param config - window thresholds plus the session to plan.
 * @returns explicit brief and forget instructions plus the next window values.
 */
export function planTierMigrations(
  document: MemoryDocument,
  currentTurn: number,
  config: TierMigrationConfig,
): TierMigrationPlan {
  const session = migrationSession(document, config.sessionId)
  if (session === undefined) return emptyPlan(config.sessionId ?? '')
  const turns = new Map(session.turns.map(turn => [turn.turn, turn]))
  const toBrief: TurnRange[] = []
  const toForget: TurnRange[] = []
  for (const section of sessionSections(document, session.id)) {
    const sectionTurns = completeSectionTurns(section, turns)
    if (sectionTurns === undefined) continue
    if (forgottenSection(section, session.forgottenThrough)) continue
    const action = sectionAction(section, sectionTurns, currentTurn, config, session.forgottenThrough)
    if (action === 'none') continue
    const range = turnRange(section, sectionTurns)
    if (action === 'brief') toBrief.push(range)
    else toForget.push(range)
  }
  toBrief.sort((left, right) => left.startTurn - right.startTurn)
  toForget.sort((left, right) => left.startTurn - right.startTurn)
  const forgottenThrough = nextForgottenThrough(session.forgottenThrough, toForget)
  return {
    sessionId: session.id,
    toBrief,
    toForget,
    window: {
      sessionId: session.id,
      turns: applyBriefTiers(session.turns, toBrief),
      ...forgottenThrough === undefined ? {} : { forgottenThrough },
    },
  }
}

/** Resolve the session to plan, defaulting to the most recently updated record. */
function migrationSession(document: MemoryDocument, sessionId: string | undefined): MemorySessionRecord | undefined {
  if (sessionId !== undefined) return document.sessions.find(session => session.id === sessionId)
  let latest: MemorySessionRecord | undefined
  for (const session of document.sessions) {
    if (latest === undefined || session.updatedAt >= latest.updatedAt) latest = session
  }
  return latest
}

/** Return an empty plan for a document without the requested session. */
function emptyPlan(sessionId: string): TierMigrationPlan {
  return {
    sessionId,
    toBrief: [],
    toForget: [],
    window: { sessionId, turns: [] },
  }
}

/** Sections belonging to one session, in file order. */
function sessionSections(document: MemoryDocument, sessionId: string): readonly MemorySection[] {
  return document.sections.filter(section => section.sessionId === sessionId)
}

/** Resolve every turn a section heading promises, or undefined when one is absent. */
function completeSectionTurns(
  section: MemorySection,
  turns: ReadonlyMap<number, MemoryTurnRecord>,
): readonly MemoryTurnRecord[] | undefined {
  const resolved: MemoryTurnRecord[] = []
  for (let turn = section.startTurn; turn <= section.endTurn; turn += 1) {
    const record = turns.get(turn)
    if (record === undefined) return undefined
    resolved.push(record)
  }
  return resolved
}

/** Whether the section body was already removed by an earlier forget pass. */
function forgottenSection(section: MemorySection, forgottenThrough: number | undefined): boolean {
  return forgottenThrough !== undefined && section.startTurn <= forgottenThrough
}

/** Whether the action for a section can cover every one of its turns. */
function sectionAction(
  section: MemorySection,
  turns: readonly MemoryTurnRecord[],
  currentTurn: number,
  config: TierMigrationConfig,
  forgottenThrough: number | undefined,
): TurnAction {
  const actions = turns.map(turn => turnAction(turn, currentTurn, config, forgottenThrough))
  if (actions.every(action => action === 'forget')) return 'forget'
  if (section.tier === 'detail'
    && actions.every(action => action === 'brief' || action === 'forget')) {
    return 'brief'
  }
  return 'none'
}

/** The window action for one stored turn. */
function turnAction(
  turn: MemoryTurnRecord,
  currentTurn: number,
  config: TierMigrationConfig,
  forgottenThrough: number | undefined,
): TurnAction {
  if (forgottenThrough !== undefined && turn.turn <= forgottenThrough) return 'none'
  const age = currentTurn - turn.turn
  if (age < config.detail) return 'none'
  if (age < config.brief) return 'none'
  if (age < config.forget) return turn.tier === 'detail' ? 'brief' : 'none'
  return 'forget'
}

/** Build the migration range from a section's first and last turn records. */
function turnRange(section: MemorySection, turns: readonly MemoryTurnRecord[]): TurnRange {
  const first = turns[0]
  const last = turns.at(-1)
  if (first === undefined || last === undefined) {
    throw new Error(`memory: section ${String(section.startTurn)}–${String(section.endTurn)} has no turn records`)
  }
  const checkpointSeq = turns.find(turn => turn.checkpointSeq !== undefined)?.checkpointSeq
  return {
    startTurn: section.startTurn,
    endTurn: section.endTurn,
    seq: [first.seq[0], last.seq[1]],
    tier: section.tier,
    ...checkpointSeq === undefined ? {} : { checkpointSeq },
  }
}

/** Advance the forgotten pointer to the highest forgotten turn. */
function nextForgottenThrough(
  current: number | undefined,
  toForget: readonly TurnRange[],
): number | undefined {
  const forgotten = toForget.map(range => range.endTurn)
  if (forgotten.length === 0) return current
  const highest = Math.max(...forgotten)
  return current === undefined ? highest : Math.max(current, highest)
}

/** Mark every turn covered by a brief range as brief in the snapshot values. */
function applyBriefTiers(
  turns: readonly MemoryTurnRecord[],
  toBrief: readonly TurnRange[],
): readonly MemoryTurnRecord[] {
  if (toBrief.length === 0) return turns
  return turns.map((turn) => {
    const range = toBrief.find(candidate =>
      turn.turn >= candidate.startTurn && turn.turn <= candidate.endTurn)
    return range === undefined ? turn : { ...turn, tier: 'brief' }
  })
}
