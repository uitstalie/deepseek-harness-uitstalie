/**
 * Tests for core/errors — including decision 52's own requirement: a test asserting that
 * the codes in DESIGN.md and the codes in code are the same set.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { ERROR_CODES, formatError, invalidInput, ioFailed, jiraError, notFound, readOnlySession, staleRevision } from './errors.ts'

const DESIGN = readFileSync(new URL('../../DESIGN.md', import.meta.url), 'utf8')

/** The decision-52 row of DESIGN.md lists the twelve codes in backticks. */
const codesFromDesign = (): readonly string[] => {
  const row = DESIGN.split('\n').find(line => line.startsWith('| 52 |'))
  assert.ok(row !== undefined, 'DESIGN.md must contain the decision 52 row')
  const found = [...row.matchAll(/`([A-Z][A-Z_]{3,})`/g)].map(match => match[1] ?? '')
  return [...new Set(found)]
}

describe('error codes', () => {
  it('has exactly twelve codes, all unique', () => {
    assert.equal(ERROR_CODES.length, 12)
    assert.equal(new Set(ERROR_CODES).size, 12)
  })

  it('matches DESIGN.md exactly (decision 52: one definition, guarded by a test)', () => {
    assert.deepEqual([...codesFromDesign()].sort(), [...ERROR_CODES].sort())
  })

  it('freezes the error value and keeps the optional context out when absent', () => {
    const plain = jiraError('NOT_FOUND', 'nope')
    assert.equal(Object.isFrozen(plain), true)
    assert.deepEqual(Object.keys(plain), ['code', 'message'])

    const withContext = jiraError('NOT_FOUND', 'nope', { key: 'DH-1' })
    assert.deepEqual(Object.keys(withContext), ['code', 'message', 'context'])
  })

  it('builds the codes this slice can produce', () => {
    assert.deepEqual(invalidInput('bad', { line: 3 }), {
      code: 'INVALID_INPUT',
      message: 'bad',
      context: { line: 3 },
    })
    assert.equal(notFound('DH-9').code, 'NOT_FOUND')
    assert.equal(notFound('DH-9').context?.key, 'DH-9')
    assert.equal(staleRevision(2, 3).code, 'STALE_REVISION')
    assert.equal(readOnlySession('subagent').code, 'READ_ONLY_SESSION')
    assert.equal(readOnlySession('subagent').context?.reason, 'subagent')
  })

  it('keeps the frozen wire code for I/O failures, whatever the helper is called (C4)', () => {
    const read = ioFailed('cannot read the issue file', { path: 'x' })
    assert.equal(read.code, 'WRITE_FAILED')
    assert.equal(read.message, 'cannot read the issue file')
  })

  it('renders the model-facing form (decision 55: English)', () => {
    assert.equal(formatError(jiraError('NOT_FOUND', 'issue DH-1 not found')), 'NOT_FOUND: issue DH-1 not found')
    assert.equal(formatError(staleRevision(1, 2)), 'STALE_REVISION: revision mismatch: expected 1, found 2 ({"expected":1,"actual":2})')
  })
})
