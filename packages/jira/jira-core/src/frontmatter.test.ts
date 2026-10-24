/**
 * Tests for core/frontmatter — the restricted codec (decision 105).
 *
 * Two things matter here: the subset we support round-trips exactly, and everything
 * outside the subset fails loudly instead of being guessed at.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { type Frontmatter, parseFrontmatter, renderFrontmatter } from './frontmatter.ts'

const doc = (frontmatter: string, body = ''): string => `---\n${frontmatter}\n---\n${body}`

const parseOk = (text: string) => {
  const parsed = parseFrontmatter(text)
  assert.equal(parsed.ok, true, `expected a successful parse, got ${JSON.stringify(parsed)}`)
  if (!parsed.ok) throw new Error('unreachable')
  return parsed.value
}

const parseError = (text: string) => {
  const parsed = parseFrontmatter(text)
  assert.equal(parsed.ok, false, `expected a loud rejection, got ${JSON.stringify(parsed)}`)
  if (parsed.ok) throw new Error('unreachable')
  return parsed.error
}

describe('frontmatter: the supported subset', () => {
  it('reads plain scalars and types the ones YAML types', () => {
    const { frontmatter } = parseOk(
      doc(['schema: issue/v1', 'type: issue', 'revision: 3', 'conflicted: false', 'resolution: null'].join('\n')),
    )
    assert.deepEqual(frontmatter, {
      schema: 'issue/v1',
      type: 'issue',
      revision: 3,
      conflicted: false,
      resolution: null,
    })
  })

  it('keeps quoted strings literal, including colons and hashes', () => {
    const { frontmatter } = parseOk(doc(['summary: "fix: the thing #1"', "note: 'it''s fine'"].join('\n')))
    assert.equal(frontmatter.summary, 'fix: the thing #1')
    assert.equal(frontmatter.note, "it's fine")
  })

  it('unescapes the three escapes it documents, and refuses any other', () => {
    assert.equal(parseOk(doc('summary: "a\\nb"')).frontmatter.summary, 'a\nb')
    assert.equal(parseOk(doc('summary: "a\\\\b"')).frontmatter.summary, 'a\\b')
    assert.equal(parseOk(doc('summary: "a\\"b"')).frontmatter.summary, 'a"b')
    assert.equal(parseError(doc('summary: "a\\tb"')).code, 'INVALID_INPUT')
  })

  it('reads inline arrays (empty, bare, quoted)', () => {
    assert.deepEqual(parseOk(doc('tags: []')).frontmatter.tags, [])
    assert.deepEqual(parseOk(doc('tags: [a, b]')).frontmatter.tags, ['a', 'b'])
    assert.deepEqual(parseOk(doc('tags: ["a b", c]')).frontmatter.tags, ['a b', 'c'])
  })

  it('reads one-level flow maps inside an inline array (decision 70 links)', () => {
    const { frontmatter } = parseOk(
      doc('links: [{ type: is_blocked_by, target: DH-5 }, { type: parent, target: DH-1 }]'),
    )
    assert.deepEqual(frontmatter.links, [
      { type: 'is_blocked_by', target: 'DH-5' },
      { type: 'parent', target: 'DH-1' },
    ])
    assert.deepEqual(parseOk(doc('links: []')).frontmatter.links, [])
    assert.deepEqual(parseOk(doc('links: [{}]')).frontmatter.links, [{}])
  })

  it('refuses anything deeper than one level of flow map', () => {
    assert.equal(parseError(doc('links: [{ type: parent, target: [DH-1] }]')).code, 'INVALID_INPUT')
    // One level of nesting is allowed now (`transitions: - [a, b]` in the store config),
    // so a nested array parses; two levels, a map inside a map, and a mixed array do not.
    assert.deepEqual(parseOk(doc('links: [[DH-1]]')).frontmatter.links, [['DH-1']])
    assert.equal(parseError(doc('links: [[[DH-1]]]')).code, 'INVALID_INPUT')
    assert.equal(parseError(doc('links: [[{a: 1}]]')).code, 'INVALID_INPUT')
    assert.equal(parseError(doc('links: {type: parent}')).code, 'INVALID_INPUT')
    assert.equal(parseError(doc('links: [{ Type: parent }]')).code, 'INVALID_INPUT')
    assert.equal(parseError(doc('links: [{ type: parent, type: parent }]')).code, 'INVALID_INPUT')
  })

  it('reads block arrays (and treats a bare key with no items as null)', () => {
    assert.deepEqual(parseOk(doc('tags:\n  - a\n  - b')).frontmatter.tags, ['a', 'b'])
    assert.equal(parseOk(doc('tags:')).frontmatter.tags, null)
  })

  it('ignores comments and blank lines, and strips trailing comments', () => {
    const { frontmatter } = parseOk(doc(['# a whole-line comment', '', 'schema: issue/v1 # trailing', 'type: issue'].join('\n')))
    assert.deepEqual(frontmatter, { schema: 'issue/v1', type: 'issue' })
  })

  it('accepts CRLF input and keeps the body verbatim', () => {
    const { frontmatter, body } = parseOk('---\r\nschema: issue/v1\r\n---\r\nline one\r\nline two\r\n')
    assert.deepEqual(frontmatter, { schema: 'issue/v1' })
    assert.equal(body, 'line one\nline two\n')
  })
})

describe('frontmatter: everything else is rejected, never guessed', () => {
  const cases: readonly (readonly [string, string, string])[] = [
    ['no fence', 'schema: issue/v1\n', 'frontmatter fence'],
    ['unclosed fence', '---\nschema: issue/v1\n', 'never closed'],
    ['BOM', '\uFEFF---\nschema: issue/v1\n---\n', 'BOM'],
    ['duplicate key', doc('schema: issue/v1\nschema: issue/v1'), 'duplicate key'],
    ['uppercase key', doc('Schema: issue/v1'), 'not lower_snake_case'],
    ['nested map', doc('links:\n  type: parent'), 'unsupported indentation'],
    ['flow map', doc('links: {type: parent}'), 'unsupported'],
    ['block scalar', doc('summary: |'), 'unsupported'],
    ['anchor', doc('summary: &anchor text'), 'unsupported'],
    ['tab indentation', doc('tags:\n\t- a'), 'tab'],
    ['unquoted colon', doc('summary: fix: the thing'), 'unquoted colon'],
    ['unterminated double quote', doc('summary: "oops'), 'unterminated double quote'],
    ['unterminated single quote', doc("summary: 'oops"), 'unterminated single quote'],
    ['line without a colon', doc('just some text'), 'expected a "key: value" line'],
  ]

  for (const [name, text, needle] of cases) {
    it(`rejects ${name}`, () => {
      const error = parseError(text)
      assert.equal(error.code, 'INVALID_INPUT')
      assert.match(error.message, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))
    })
  }

  it('reports the offending line number, so a human can fix it', () => {
    const error = parseError(doc('schema: issue/v1\nSchema: issue/v1'))
    assert.equal(error.context?.line, 3)
  })
})

describe('frontmatter: render is the exact inverse of parse', () => {
  const samples: readonly Frontmatter[] = [
    { schema: 'issue/v1', type: 'issue', revision: 1 },
    { summary: 'fix: the thing #1', tags: ['a', 'b'] },
    { summary: '', empty: [], blank: null, yes: true, no: false, count: -4 },
    { summary: 'needs "quotes"', note: "it's fine" },
    { links: [{ type: 'parent', target: 'DH-1' }, { type: 'is_blocked_by', target: 'DH-5' }] },
  ]

  for (const [index, sample] of samples.entries()) {
    it(`round-trips sample ${index}`, () => {
      const body = 'A paragraph.\n\n- and a list.\n'
      const rendered = renderFrontmatter(sample, body)
      assert.equal(rendered.includes('\r'), false)
      assert.equal(rendered.startsWith('\uFEFF'), false)
      const reparsed = parseOk(rendered)
      assert.deepEqual(reparsed.frontmatter, sample)
      assert.equal(reparsed.body, body)
    })
  }

  it('emits LF only and keeps one blank line before the body', () => {
    const rendered = renderFrontmatter({ schema: 'issue/v1' }, 'body\n')
    assert.equal(rendered, '---\nschema: issue/v1\n---\n\nbody\n')
  })
})
