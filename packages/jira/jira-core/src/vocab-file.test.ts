/**
 * The parser's hardest real-world test: the store's own `config.md`.
 *
 * `fixtures/config.md` is a verbatim copy of the vocabulary file the store ships (the
 * store remains the truth source; the copy exists so this test can run anywhere). It uses
 * the two shapes that forced the subset to grow one level of nesting — a block array of
 * flow maps (`- { name: todo, order: 10 }`) and a block array of scalar arrays
 * (`- [todo, in_progress]`) — plus per-entry trailing comments.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { type Frontmatter, parseFrontmatter, renderFrontmatter } from './frontmatter.ts'

const text = readFileSync(new URL('../fixtures/config.md', import.meta.url), 'utf8')

const parsed = parseFrontmatter(text)
if (!parsed.ok) {
  throw new Error(`the store vocabulary must parse, but got: ${JSON.stringify(parsed.error)}`)
}
const { frontmatter, body } = parsed.value

describe('the store vocabulary parses', () => {
  it('reads the document envelope', () => {
    assert.equal(frontmatter.type, 'config')
    assert.equal(frontmatter.schema, 'config/v1')
  })

  it('reads a block array of flow maps (statuses carry their order)', () => {
    assert.deepEqual(frontmatter.statuses, [
      { name: 'todo', order: 10 },
      { name: 'in_progress', order: 20 },
      { name: 'in_review', order: 30 },
      { name: 'closed', order: 90 },
      { name: 'cancelled', order: 95 },
    ])
  })

  it('reads a block array of scalar arrays (the transition table)', () => {
    const transitions = frontmatter.transitions as readonly (readonly string[])[]
    assert.equal(transitions.length, 10)
    assert.deepEqual(transitions[0], ['todo', 'in_progress'])
    assert.deepEqual(transitions[8], ['closed', 'in_progress'])
    assert.deepEqual(transitions[9], ['cancelled', 'todo'])
    // 2026-10-19 ruling: closing must go through in_progress — there is no direct todo→closed edge.
    assert.equal(transitions.some(([from, to]) => from === 'todo' && to === 'closed'), false)
  })

  it('ignores the per-entry comments that explain those transitions', () => {
    const transitions = frontmatter.transitions as readonly (readonly string[])[]
    for (const pair of transitions) {
      assert.equal(pair.length, 2)
      for (const name of pair) assert.equal(name.includes('#'), false)
    }
  })

  it('reads the plain lists', () => {
    assert.deepEqual(frontmatter.issue_types, ['task', 'bug'])
    assert.deepEqual(frontmatter.kb_types, ['runbook', 'pitfall', 'howto', 'concept'])
    assert.deepEqual(frontmatter.priorities, ['S1', 'S2', 'S3', 'S4', 'S5'])
    assert.deepEqual(frontmatter.closed, ['closed', 'cancelled'])
    assert.deepEqual(frontmatter.resolutions, ['fixed', 'invalid', 'limitation', 'abandoned'])
  })

  it('keeps the explanatory prose as the body', () => {
    assert.match(body, /^# 词表（config\.md）/)
  })
})

describe('the shapes that grew the subset round-trip', () => {
  const samples: readonly Frontmatter[] = [
    { statuses: [{ name: 'todo', order: 10 }, { name: 'closed', order: 90 }] },
    { transitions: [['todo', 'closed'], ['closed', 'todo']] },
    { mixed_ok: ['a', 'b'], maps: [{ k: 1 }], nested: [['x'], ['y', 'z']] },
  ]

  for (const [index, sample] of samples.entries()) {
    it(`round-trips sample ${index}`, () => {
      const rendered = renderFrontmatter(sample, 'body\n')
      const reparsed = parseFrontmatter(rendered)
      assert.equal(reparsed.ok, true)
      if (reparsed.ok) {
        assert.deepEqual(reparsed.value.frontmatter, sample)
        assert.equal(reparsed.value.body, 'body\n')
      }
    })
  }

  it('still refuses deeper nesting, mixing, and maps inside arrays of arrays', () => {
    const rejects = [
      '---\nnoval: [[[a]]]\n---\n',
      '---\nmix: [a, {k: 1}]\n---\n',
      '---\nbad: [[{k: 1}]]\n---\n',
      '---\ndeep: [{k: {n: 1}}]\n---\n',
    ]
    for (const source of rejects) {
      const result = parseFrontmatter(source)
      assert.equal(result.ok, false, `expected a loud rejection for ${JSON.stringify(source)}`)
      if (!result.ok) assert.equal(result.error.code, 'INVALID_INPUT')
    }
  })
})
