/**
 * Tests for core/counters — the block allocation that keeps two offline machines from
 * minting the same key (decisions 6, 74).
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { BLOCK_SIZE, type CountersFile, MAX_KEY_NUMBER, claimKey, emptyCounters, highestClaim, parseCounters, renderCounters } from './counters.ts'

const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  assert.equal(result.ok, true, `expected success, got ${JSON.stringify(result)}`)
  if (!result.ok) throw new Error('unreachable')
  return result.value
}

/** Claim a key and fold the written-back counters into the "all machines" view. */
const claim = (files: readonly CountersFile[], machineId: string, project: string) => {
  const result = unwrap(claimKey(files, machineId, project))
  const others = files.filter(file => file.machine_id !== machineId)
  return { key: result.key, newBlock: result.claimedNewBlock, files: [...others, result.counters] }
}

describe('counters: the file', () => {
  it('starts empty and renders sorted, stable JSON', () => {
    const file = emptyCounters('a1b2')
    assert.equal(file.schema, 'counters/v1')
    const text = renderCounters(file)
    assert.equal(text.endsWith('\n'), true)
    assert.equal(text.includes('\r'), false)
    assert.deepEqual(JSON.parse(text), { schema: 'counters/v1', machine_id: 'a1b2', projects: {} })
  })

  it('round-trips, with projects sorted for a readable diff', () => {
    const claimed = unwrap(claimKey([emptyCounters('a1b2')], 'a1b2', 'DH'))
    const claimed2 = unwrap(claimKey([claimed.counters], 'a1b2', 'DEMO'))
    const text = renderCounters(claimed2.counters)
    const order = [...text.matchAll(/"(DH|DEMO)":/g)].map(match => match[1])
    assert.deepEqual(order, ['DEMO', 'DH'])
    const back = unwrap(parseCounters(text, 'a1b2'))
    assert.deepEqual(back, claimed2.counters)
  })

  it('refuses a file that belongs to another machine or is malformed', () => {
    const broken = [
      ['not json', 'not valid JSON'],
      ['{"schema":"counters/v0","machine_id":"a1b2","projects":{}}', 'schema must be'],
      ['{"schema":"counters/v1","machine_id":"zzzz","projects":{}}', 'belongs to another machine'],
      ['{"schema":"counters/v1","machine_id":"a1b2","projects":{"DH":{"next":0,"blocks":[]}}}', 'positive integer'],
      ['{"schema":"counters/v1","machine_id":"a1b2","projects":{"DH":{"next":1,"blocks":[[5,3]]}}}', 'blocks'],
    ] as const
    for (const [text, needle] of broken) {
      const result = parseCounters(text, 'a1b2')
      assert.equal(result.ok, false, `expected a rejection for ${text}`)
      if (!result.ok) assert.match(result.error.message, new RegExp(needle))
    }
  })
})

describe('counters: claiming keys', () => {
  it('hands out consecutive keys from the claimed block', () => {
    let files: readonly CountersFile[] = [emptyCounters('a1b2')]
    const first = claim(files, 'a1b2', 'DH')
    assert.equal(first.key, 'DH-1')
    assert.equal(first.newBlock, true, 'the first key claims a block')
    const second = claim(first.files, 'a1b2', 'DH')
    assert.equal(second.key, 'DH-2')
    assert.equal(second.newBlock, false, 'the second key reuses the block')
    const third = claim(second.files, 'a1b2', 'DH')
    assert.equal(third.key, 'DH-3')
    files = third.files
    assert.equal(highestClaim(files, 'DH'), BLOCK_SIZE)
  })

  it('keeps projects in separate number spaces', () => {
    const dh = claim([emptyCounters('a1b2')], 'a1b2', 'DH')
    const demo = claim(dh.files, 'a1b2', 'DEMO')
    assert.equal(demo.key, 'DEMO-1')
    const dhAgain = claim(demo.files, 'a1b2', 'DH')
    assert.equal(dhAgain.key, 'DH-2')
  })

  it('never hands a second machine a key inside the first machine\'s block', () => {
    // This is the whole point: two machines that never talk must not mint the same key.
    const a = claim([emptyCounters('aaaa')], 'aaaa', 'DH')
    assert.equal(a.key, 'DH-1')
    const b = claim(a.files, 'bbbb', 'DH')
    assert.equal(b.key, `DH-${BLOCK_SIZE + 1}`, 'machine B starts after A\'s block')
    const aAgain = claim(b.files, 'aaaa', 'DH')
    assert.equal(aAgain.key, 'DH-2', 'machine A keeps using its own block')
    const c = claim(aAgain.files, 'cccc', 'DH')
    assert.equal(c.key, `DH-${2 * BLOCK_SIZE + 1}`)
  })

  it('claims a fresh block once the current one is exhausted', () => {
    let files: readonly CountersFile[] = [emptyCounters('a1b2')]
    let last = ''
    for (let index = 0; index < BLOCK_SIZE + 1; index += 1) {
      const step = claim(files, 'a1b2', 'DH')
      last = step.key
      files = step.files
    }
    assert.equal(last, `DH-${BLOCK_SIZE + 1}`, 'the 101st key opens the next block')
    assert.equal(highestClaim(files, 'DH'), 2 * BLOCK_SIZE)
  })
})

describe('counters: the number space is finite (decision 158)', () => {
  it('refuses the key past the cap, and names the project, the limit and the number', () => {
    // Reached through `seed` — the highest number already on disk — which is exactly how a real store
    // arrives here (`highestExistingKey`). The cap exists so that a corrupt counters file cannot mint
    // `DEMO-999999999`, and so `KEY_EXHAUSTED` (decision 52) is a code that can actually happen.
    const exhausted = claimKey([emptyCounters('a1b2')], 'a1b2', 'DEMO', MAX_KEY_NUMBER)
    assert.equal(exhausted.ok, false)
    if (!exhausted.ok) {
      assert.equal(exhausted.error.code, 'KEY_EXHAUSTED')
      assert.match(exhausted.error.message, /DEMO has no keys left/u)
      assert.equal(exhausted.error.context?.limit, MAX_KEY_NUMBER)
      assert.equal(exhausted.error.context?.next, MAX_KEY_NUMBER + 1)
    }
  })

  it('still hands out the last key of the space', () => {
    const last = unwrap(claimKey([emptyCounters('a1b2')], 'a1b2', 'DEMO', MAX_KEY_NUMBER - 1))
    assert.equal(last.key, `DEMO-${String(MAX_KEY_NUMBER)}`)
  })
})
