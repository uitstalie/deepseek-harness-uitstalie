/**
 * Pure window-planner tests: boundary ages, per-session scoping, multi-turn
 * sections, and idempotence for already-brief and already-forgotten turns.
 */
import { expect, test } from 'vitest'
import { createMemoryDocument, DEFAULT_MEMORY_WINDOW } from '../src/memory-file.ts'
import type { MemoryDocument, MemoryEntry, MemorySection, MemorySessionRecord, MemoryTier, MemoryTurnRecord } from '../src/memory-file.ts'
import { planTierMigrations } from '../src/window.ts'

/** One detail entry used by a section fixture. */
const DECISION: MemoryEntry = { kind: 'decision', text: 'keep the version guard' }

/** Build one turn record with a distinct seq range. */
function turn(turnNumber: number, tier: MemoryTier = 'detail', checkpointSeq?: number): MemoryTurnRecord {
  return {
    turn: turnNumber,
    seq: [turnNumber * 10, turnNumber * 10 + 5],
    tier,
    ...checkpointSeq === undefined ? {} : { checkpointSeq },
  }
}

/** Build one managed-block section with a single entry. */
function section(startTurn: number, endTurn = startTurn, tier: MemoryTier = 'detail'): MemorySection {
  return {
    sessionId: 'session-a',
    startTurn,
    endTurn,
    tier,
    entries: [DECISION],
  }
}

/** Build one session record with an explicit update time. */
function session(
  id: string,
  turns: readonly MemoryTurnRecord[],
  updatedAt = '2026-10-22T00:00:00.000Z',
  forgottenThrough?: number,
): MemorySessionRecord {
  return {
    id,
    cwd: '/work/project',
    updatedAt,
    turns,
    ...forgottenThrough === undefined ? {} : { forgottenThrough },
  }
}

/** Build a document around one or more session records. */
function document(
  sessions: readonly MemorySessionRecord[],
  sections: readonly MemorySection[],
): MemoryDocument {
  return {
    ...createMemoryDocument(DEFAULT_MEMORY_WINDOW),
    sessions,
    sections,
  }
}

/** Plan for the single-session fixture. */
function plan(currentTurn: number, turns = [turn(currentTurn - 16)], sections = [section(currentTurn - 16)]) {
  return planTierMigrations(
    document([session('session-a', turns)], sections),
    currentTurn,
    { ...DEFAULT_MEMORY_WINDOW, sessionId: 'session-a' },
  )
}

test('turn ages at 5 and 6 stay detail', () => {
  for (const age of [5, 6]) {
    const currentTurn = 30
    const result = plan(currentTurn, [turn(currentTurn - age)], [section(currentTurn - age)])
    expect(result.toBrief, `age ${String(age)}`).toEqual([])
    expect(result.toForget, `age ${String(age)}`).toEqual([])
    expect(result.window.turns[0]?.tier).toBe('detail')
  }
})

test('turn ages 15, 16, and 20 cross only the brief threshold', () => {
  for (const age of [15, 16, 20]) {
    const currentTurn = 30
    const turnNumber = currentTurn - age
    const result = plan(currentTurn, [turn(turnNumber)], [section(turnNumber)])
    if (age === 15) {
      expect(result.toBrief, 'age 15').toEqual([])
      expect(result.toForget, 'age 15').toEqual([])
      continue
    }
    expect(result.toBrief, `age ${String(age)}`).toEqual([{
      startTurn: turnNumber,
      endTurn: turnNumber,
      seq: [turnNumber * 10, turnNumber * 10 + 5],
      tier: 'detail',
    }])
    expect(result.toForget, `age ${String(age)}`).toEqual([])
    expect(result.window.turns[0]?.tier).toBe('brief')
  }
})

test('turn age 21 forgets a detail section and advances the pointer', () => {
  const turnNumber = 9
  const result = plan(30, [turn(turnNumber)], [section(turnNumber)])
  expect(result.toBrief).toEqual([])
  expect(result.toForget).toEqual([{
    startTurn: turnNumber,
    endTurn: turnNumber,
    seq: [90, 95],
    tier: 'detail',
  }])
  expect(result.window.forgottenThrough).toBe(turnNumber)
})

test('a multi-turn section waits until every turn reaches the action', () => {
  const turns = [turn(1), turn(2)]
  const sections = [section(1, 2)]
  const early = plan(17, turns, sections)
  expect(early.toBrief).toEqual([])
  const brief = plan(18, turns, sections)
  expect(brief.toBrief).toEqual([{
    startTurn: 1,
    endTurn: 2,
    seq: [10, 25],
    tier: 'detail',
  }])
  const forget = plan(23, turns, sections)
  expect(forget.toForget).toEqual([{
    startTurn: 1,
    endTurn: 2,
    seq: [10, 25],
    tier: 'detail',
  }])
})

test('already brief and already forgotten turns do not migrate again', () => {
  const brief = plan(18, [turn(2, 'brief', 77)], [section(2, 2, 'brief')])
  expect(brief.toBrief).toEqual([])
  expect(brief.toForget).toEqual([])

  const forgotten = planTierMigrations(
    document([session('session-a', [turn(2, 'brief', 77)], undefined, 2)], [section(2, 2, 'brief')]),
    22,
    { ...DEFAULT_MEMORY_WINDOW, sessionId: 'session-a' },
  )
  expect(forgotten.toBrief).toEqual([])
  expect(forgotten.toForget).toEqual([])
  expect(forgotten.window.forgottenThrough).toBe(2)
})

test('a brief section whose checkpoint was skipped is planned for a retry', () => {
  const currentTurn = 30
  const turnNumber = currentTurn - 16
  const result = plan(currentTurn, [turn(turnNumber, 'brief')], [section(turnNumber, turnNumber, 'brief')])
  expect(result.toBrief).toEqual([])
  expect(result.toForget).toEqual([])
  expect(result.retry).toEqual([{
    startTurn: turnNumber,
    endTurn: turnNumber,
    seq: [turnNumber * 10, turnNumber * 10 + 5],
    tier: 'brief',
    action: 'brief',
  }])
})

test('a forgotten run whose pointer was skipped is planned for a retry', () => {
  const currentTurn = 30
  const turnNumber = currentTurn - 22
  const result = planTierMigrations(
    document([session('session-a', [turn(turnNumber, 'brief')], undefined, turnNumber)], []),
    currentTurn,
    { ...DEFAULT_MEMORY_WINDOW, sessionId: 'session-a' },
  )
  expect(result.toBrief).toEqual([])
  expect(result.toForget).toEqual([])
  expect(result.retry).toEqual([{
    startTurn: turnNumber,
    endTurn: turnNumber,
    seq: [turnNumber * 10, turnNumber * 10 + 5],
    tier: 'brief',
    action: 'forget',
  }])
})

test('a multi-turn detail section splits by turn age', () => {
  const currentTurn = 18
  const result = planTierMigrations(
    document(
      [session('session-a', [turn(1), turn(2), turn(3)])],
      [{
        sessionId: 'session-a',
        startTurn: 1,
        endTurn: 3,
        tier: 'detail',
        entries: [
          { kind: 'decision', text: 'one', turn: 1 },
          { kind: 'decision', text: 'two', turn: 2 },
          { kind: 'decision', text: 'three', turn: 3 },
        ],
      }],
    ),
    currentTurn,
    { ...DEFAULT_MEMORY_WINDOW, sessionId: 'session-a' },
  )
  expect(result.toBrief).toEqual([{ startTurn: 1, endTurn: 2, seq: [10, 25], tier: 'detail' }])
  expect(result.toForget).toEqual([])
})

test('a section without per-turn entries keeps the section-granular rule', () => {
  const result = planTierMigrations(
    document(
      [session('session-a', [turn(1), turn(2), turn(3)])],
      [{
        sessionId: 'session-a',
        startTurn: 1,
        endTurn: 3,
        tier: 'detail',
        entries: [{ kind: 'decision', text: 'one' }, { kind: 'decision', text: 'two' }],
      }],
    ),
    19,
    { ...DEFAULT_MEMORY_WINDOW, sessionId: 'session-a' },
  )
  expect(result.toBrief).toEqual([{ startTurn: 1, endTurn: 3, seq: [10, 35], tier: 'detail' }])
})

test('a plan scopes ages to the named session', () => {
  const turnsA = [turn(1)]
  const turnsB = [turn(1)]
  const result = planTierMigrations(
    document(
      [session('session-a', turnsA), session('session-b', turnsB, '2026-10-23T00:00:00.000Z')],
      [section(1), { ...section(1), sessionId: 'session-b' }],
    ),
    22,
    { ...DEFAULT_MEMORY_WINDOW, sessionId: 'session-a' },
  )
  expect(result.sessionId).toBe('session-a')
  expect(result.toForget).toHaveLength(1)
  expect(result.window.turns.every(turnRecord => turnRecord.tier === 'detail')).toBe(true)
})

test('a checkpoint seq carried by the turns survives into the migration range', () => {
  const result = plan(22, [turn(1, 'brief', 99)], [section(1, 1, 'brief')])
  expect(result.toForget).toEqual([{
    startTurn: 1,
    endTurn: 1,
    seq: [10, 15],
    tier: 'brief',
    checkpointSeq: 99,
  }])
})
