/**
 * The write path's shared checks, tested **directly** (decision 170).
 *
 * They used to be covered only through `create`/`update`/`switch_state`, so an illegal-input branch could
 * be wrong and still look green: the caller would have rejected the input for its own reason first.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { SUMMARY_MAX_CHARS } from './entity.ts'
import { parseVocab } from './vocab.ts'
import {
  validateIdentity,
  validateIssueType,
  validateKey,
  validatePriority,
  validateResolution,
  validateResolutionNote,
  validateStatus,
  validateSummary,
  validateTags,
} from './validate.ts'

import { readFileSync } from 'node:fs'

// The same fixture the write-path tests use, so a rule change shows up here as well.
const VOCAB_SOURCE = readFileSync(new URL('../fixtures/config.md', import.meta.url), 'utf8')

const vocab = (() => {
  const parsed = parseVocab(VOCAB_SOURCE)
  assert.equal(parsed.ok, true)
  return parsed.ok ? parsed.value : (undefined as never)
})()

describe('validate: summary', () => {
  it('accepts a trimmed single line and refuses the three ways it can be wrong', () => {
    assert.equal(validateSummary('  hello  ').ok, true)
    const empty = validateSummary('   ')
    assert.equal(empty.ok, false)
    if (!empty.ok) assert.equal(empty.error.code, 'INVALID_INPUT')
    assert.equal(validateSummary('a\nb').ok, false, 'a summary is one line')
    const long = validateSummary('x'.repeat(SUMMARY_MAX_CHARS + 1))
    assert.equal(long.ok, false)
    if (!long.ok) assert.equal(long.error.context?.limit, SUMMARY_MAX_CHARS)
  })
})

describe('validate: identity', () => {
  it('needs four non-empty components for an agent, and no separator for a human', () => {
    assert.equal(validateIdentity('agent:deepseek|dsh|m-1|s-1', 'by').ok, true)
    assert.equal(validateIdentity('human:daiqc', 'by').ok, true)
    for (const bad of ['agent:deepseek|dsh|m-1', 'agent:a|b|c|', 'human:a|b', 'nobody:x']) {
      const result = validateIdentity(bad, 'by')
      assert.equal(result.ok, false, bad)
      if (!result.ok) assert.equal(result.error.code, 'INVALID_INPUT')
    }
  })
})

describe('validate: key, type, priority, status', () => {
  it('refuses what is not a key, and lists what is allowed', () => {
    assert.equal(validateKey('DH-12').ok, true)
    assert.equal(validateKey('dh-12').ok, false)
    assert.equal(validateKey('DH-').ok, false)
    // Derived from the fixture, so the test says "a legal one works, an illegal one does not" instead of
    // pinning the store's current vocabulary (decision 170).
    const type = vocab.issueTypes[0] ?? ''
    const priority = vocab.priorities[0] ?? ''
    const status = vocab.statuses[0]?.name ?? ''
    assert.equal(validateIssueType(vocab, type).ok, true)
    assert.equal(validateIssueType(vocab, 'not-a-type').ok, false)
    assert.equal(validatePriority(vocab, priority).ok, true)
    const badPriority = validatePriority(vocab, 'not-a-priority')
    assert.equal(badPriority.ok, false)
    if (!badPriority.ok) assert.deepEqual(badPriority.error.context?.allowed, [...vocab.priorities])
    assert.equal(validateStatus(vocab, status).ok, true)
    const unknown = validateStatus(vocab, 'nope')
    assert.equal(unknown.ok, false)
    if (!unknown.ok) assert.deepEqual(unknown.error.context?.known, vocab.statuses.map(entry => entry.name))
  })
})

describe('validate: tags', () => {
  it('lower-cases, de-duplicates, and refuses an unregistered or malformed tag', () => {
    const known = [{ name: 'demo' }, { name: 'demo-two' }]
    const ok = validateTags(known, ['DEMO', ' demo ', 'demo-two'])
    assert.equal(ok.ok, true)
    if (ok.ok) assert.deepEqual(ok.value, ['demo', 'demo-two'], 'normalised and de-duplicated')
    assert.equal(validateTags(known, ['not-registered']).ok, false)
    const malformed = validateTags(known, ['Not_Valid'])
    assert.equal(malformed.ok, false)
    if (!malformed.ok) assert.equal(malformed.error.code, 'INVALID_INPUT')
  })
})

describe('validate: resolutions', () => {
  it('requires one for a closed status and forbids one outside it', () => {
    // The closed set is its own list in the vocabulary, not a flag on a status.
    const closed = vocab.closed[0] ?? ''
    const open = vocab.statuses.map(entry => entry.name).find(name => !vocab.closed.includes(name)) ?? ''
    const resolution = vocab.resolutions[0] ?? ''
    assert.equal(validateResolution(vocab, closed, resolution).ok, true)
    const missing = validateResolution(vocab, closed, undefined)
    assert.equal(missing.ok, false)
    if (!missing.ok) assert.equal(missing.error.code, 'RESOLUTION_REQUIRED')
    const extra = validateResolution(vocab, open, resolution)
    assert.equal(extra.ok, false)
    if (!extra.ok) assert.match(extra.error.message, /not a closed status/u)
    assert.equal(validateResolution(vocab, open, undefined).ok, true)
    assert.equal(validateResolution(vocab, closed, 'not-a-resolution').ok, false, 'and it has to be a known one')
  })

  it('pairs "limitation" with a note, and bounds the note', () => {
    const missing = validateResolutionNote('limitation', undefined)
    assert.equal(missing.ok, false)
    if (!missing.ok) assert.equal(missing.error.code, 'INVALID_INPUT')
    assert.equal(validateResolutionNote('limitation', 'the API cannot do this').ok, true)
    assert.equal(validateResolutionNote('fixed', undefined).ok, true)
    assert.equal(validateResolutionNote('fixed', 'x'.repeat(1001)).ok, false)
    assert.equal(validateResolutionNote('fixed', '').ok, true, 'an empty note is no note')
  })
})
