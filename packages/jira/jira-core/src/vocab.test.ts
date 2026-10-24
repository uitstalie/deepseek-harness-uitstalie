/**
 * Tests for core/vocab — the store's vocabulary and its self-consistency checks.
 *
 * The real file is the input (fixtures/config.md), because the point of the vocabulary is
 * that a *data* edit changes behaviour; the interesting tests are the ones that catch a
 * data edit that would quietly disable part of the machine.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { formatError } from './errors.ts'

import {
  DEFAULT_PRIORITY,
  isClosedStatus,
  isKnownStatus,
  isLegalTransition,
  legalTargets,
  parseVocab,
  statusOrder,
} from './vocab.ts'

const text = readFileSync(new URL('../fixtures/config.md', import.meta.url), 'utf8')

const vocab = (() => {
  const parsed = parseVocab(text)
  if (!parsed.ok) throw new Error(`the store vocabulary must be valid: ${JSON.stringify(parsed.error)}`)
  return parsed.value
})()

const configWith = (frontmatter: readonly string[]): string =>
  `---\ntype: config\nschema: config/v1\n${frontmatter.join('\n')}\n---\n`

const base = [
  'issue_types: [task, bug]',
  'kb_types: [runbook, pitfall, howto, concept]',
  'priorities: [S1, S2, S3, S4, S5]',
  'statuses:',
  '  - { name: todo, order: 10 }',
  '  - { name: closed, order: 90 }',
  'closed: [closed]',
  'resolutions: [fixed]',
  'transitions:',
  '  - [todo, closed]',
]

describe('vocab: reading the store vocabulary', () => {
  it('orders the statuses', () => {
    assert.deepEqual(
      vocab.statuses.map(status => `${status.name}(${status.order})`),
      ['todo(10)', 'in_progress(20)', 'in_review(30)', 'closed(90)', 'cancelled(95)'],
    )
  })

  it('keeps the plain lists', () => {
    assert.deepEqual(vocab.issueTypes, ['task', 'bug'])
    assert.deepEqual(vocab.priorities, ['S1', 'S2', 'S3', 'S4', 'S5'])
    assert.deepEqual(vocab.closed, ['closed', 'cancelled'])
    assert.deepEqual(vocab.resolutions, ['fixed', 'invalid', 'limitation', 'abandoned'])
  })

  it('keeps the default priority inside the declared priorities', () => {
    assert.ok(vocab.priorities.includes(DEFAULT_PRIORITY), 'the default must be a real priority')
  })
})

describe('vocab: the queries the write path uses', () => {
  it('knows which statuses are closed', () => {
    assert.equal(isClosedStatus(vocab, 'closed'), true)
    assert.equal(isClosedStatus(vocab, 'cancelled'), true)
    assert.equal(isClosedStatus(vocab, 'in_progress'), false)
  })

  it('knows which transitions are legal, and lists the targets of one status', () => {
    assert.deepEqual(legalTargets(vocab, 'todo'), ['in_progress', 'cancelled'])
    assert.deepEqual(legalTargets(vocab, 'in_review'), ['in_progress', 'closed', 'cancelled'])
    assert.equal(isLegalTransition(vocab, 'todo', 'in_progress'), true)
    assert.equal(isLegalTransition(vocab, 'todo', 'in_review'), false)
    // 2026-10-19 ruling: closing must go through in_progress — todo→closed is not an edge.
    assert.equal(isLegalTransition(vocab, 'todo', 'closed'), false)
    assert.equal(isLegalTransition(vocab, 'closed', 'in_progress'), true, 'reopening is a declared edge')
  })

  it('orders statuses for the board, and sends unknown ones last', () => {
    assert.equal(statusOrder(vocab, 'in_review'), 30)
    assert.equal(statusOrder(vocab, 'nope') > 1000, true)
    assert.equal(isKnownStatus(vocab, 'in_review'), true)
    assert.equal(isKnownStatus(vocab, 'nope'), false)
  })
})

describe('vocab: a bad data edit is caught, not absorbed', () => {
  const bad: readonly (readonly [string, readonly string[], string])[] = [
    ['a transition to an unknown status', base.map(line => line.replace('[todo, closed]', '[todo, nope]')), 'unknown status "nope"'],
    ['a transition from an unknown status', base.map(line => line.replace('[todo, closed]', '[nope, closed]')), 'unknown status "nope"'],
    ['two statuses with the same order', base.map(line => line.replace('{ name: closed, order: 90 }', '{ name: closed, order: 10 }')), 'share an `order`'],
    ['a closed status that is not declared', base.map(line => line.replace('closed: [closed]', 'closed: [gone]')), 'unknown status "gone"'],
    ['a status without an order', base.map(line => line.replace('{ name: closed, order: 90 }', '{ name: closed }')), 'numeric `order`'],
    ['a transition that is not a pair', base.map(line => line.replace('[todo, closed]', '[todo]')), 'must be a `[from, to]` pair'],
    ['an empty closed set', base.map(line => line.replace('closed: [closed]', 'closed: []')), 'missing a non-empty `closed`'],
  ]

  for (const [name, lines, needle] of bad) {
    it(`rejects ${name}`, () => {
      const result = parseVocab(configWith(lines))
      assert.equal(result.ok, false, `expected a rejection for: ${name}`)
      if (!result.ok) {
        assert.equal(result.error.code, 'INVALID_INPUT')
        // Some problems are reported directly (a missing key, a malformed pair), others
        // are aggregated into `context.problems`; either way the reader sees the detail.
        const problems = (result.error.context?.problems as readonly string[] | undefined) ?? []
        const detail = [result.error.message, ...problems].join(' | ')
        assert.match(detail, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
        assert.equal(
          formatError(result.error).startsWith(`INVALID_INPUT: ${result.error.message}`),
          true,
        )
      }
    })
  }

  it('rejects the wrong document envelope', () => {
    const wrongType = parseVocab(text.replace('type: config', 'type: config2'))
    assert.equal(wrongType.ok, false)
    const wrongSchema = parseVocab(text.replace('schema: config/v1', 'schema: config/v2'))
    assert.equal(wrongSchema.ok, false)
  })
})
