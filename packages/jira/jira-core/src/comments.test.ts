/**
 * Tests for core/comments — the anchor format and the id scheme (decisions 42/68).
 *
 * The interesting properties are the ones that make `merge=union` safe: ids carry the
 * machine, numbering is per machine, and content that is not a comment is never lost.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { type Identity, type Timestamp } from './entity.ts'
import { appendComments, commentId, machineShortCode, nextSequence, parseComments } from './comments.ts'

const pending = (body: string, at = '2026-10-15T12:00:00Z') =>
  Object.freeze({ body, author: 'human:daiqc' as Identity, createdAt: at as Timestamp })

const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  assert.equal(result.ok, true, `expected success, got ${JSON.stringify(result)}`)
  if (!result.ok) throw new Error('unreachable')
  return result.value
}

describe('comments: ids carry the machine', () => {
  it('takes four alphanumeric characters of the machine id', () => {
    assert.equal(machineShortCode('a1b2c3d4e5f6'), 'a1b2')
    assert.equal(machineShortCode('A1B2-C3D4'), 'a1b2')
    assert.equal(machineShortCode(''), 'anon')
    assert.equal(machineShortCode('ab'), 'ab00')
  })

  it('never mints an id another machine would mint', () => {
    assert.equal(commentId('aaaa1111', 1), 'c-aaaa-1')
    assert.equal(commentId('bbbb2222', 1), 'c-bbbb-1')
    assert.notEqual(commentId('aaaa1111', 1), commentId('bbbb2222', 1))
  })
})

describe('comments: parsing', () => {
  it('reads anchors and bodies', () => {
    const text = [
      '<!-- c-a1b2-1 | author=human:daiqc | created_at=2026-10-15T12:00:00Z | revision=1 -->',
      'first comment',
      '',
      // An agent identity contains `|`, so it is quoted inside the anchor (decision 112).
      '<!-- c-b3c4-1 | author="agent:x|dsh|m|s" | created_at=2026-10-15T13:00:00Z | revision=2 -->',
      'second comment',
      'spanning two lines',
      '',
    ].join('\n')
    const parsed = unwrap(parseComments(text))
    assert.equal(parsed.comments.length, 2)
    assert.equal(parsed.comments[0]?.id, 'c-a1b2-1')
    assert.equal(parsed.comments[0]?.body, 'first comment')
    assert.equal(parsed.comments[0]?.revision, 1)
    assert.equal(parsed.comments[1]?.author, 'agent:x|dsh|m|s', 'an author may contain a pipe')
    assert.equal(parsed.comments[1]?.body, 'second comment\nspanning two lines')
    assert.equal(parsed.preamble, '')
  })

  it('keeps prose that is not a comment, instead of dropping it', () => {
    const parsed = unwrap(parseComments('# a hand-written heading\n\n<!-- c-a1b2-1 | author=human:x | created_at=2026-10-15T12:00:00Z | revision=1 -->\nbody\n'))
    assert.equal(parsed.comments.length, 1)
    assert.match(parsed.preamble, /hand-written heading/)
  })

  it('refuses an unquoted author that contains the field separator', () => {
    // `|` separates the anchor's fields and also separates an agent identity's parts, so
    // the two cannot both be unquoted — the reader says so instead of truncating.
    const parsed = parseComments('<!-- c-a1b2-1 | author=agent:x|dsh|m|s | created_at=2026-10-15T12:00:00Z | revision=1 -->\nbody\n')
    assert.equal(parsed.ok, false)
    if (!parsed.ok) assert.match(parsed.error.message, /quote the author/)
  })
  it('refuses an anchor-shaped line it cannot read', () => {
    const parsed = parseComments('<!-- c-a1b2-1 author=no-pipes revision=1 -->\nbody\n')
    assert.equal(parsed.ok, false)
    if (!parsed.ok) {
      assert.equal(parsed.error.code, 'INVALID_INPUT')
      assert.match(parsed.error.message, /anchor on line 1/)
    }
  })

  it('reads an empty file as no comments', () => {
    const parsed = unwrap(parseComments(''))
    assert.deepEqual(parsed.comments, [])
    assert.equal(parsed.preamble, '')
  })
})

describe('comments: appending', () => {
  it('numbers per machine, continuing from what is already there', () => {
    const first = unwrap(appendComments('', [pending('a'), pending('b')], 'a1b2c3d4'))
    assert.deepEqual(first.map(entry => entry.comment.id), ['c-a1b2-1', 'c-a1b2-2'])

    const existing = first.map(entry => entry.rendered).join('\n')
    const second = unwrap(appendComments(existing, [pending('c')], 'a1b2c3d4'))
    assert.deepEqual(second.map(entry => entry.comment.id), ['c-a1b2-3'])
  })

  it('does not disturb another machine\'s numbering', () => {
    const fromA = unwrap(appendComments('', [pending('a')], 'a1b2c3d4')).map(e => e.rendered).join('\n')
    assert.equal(nextSequence(unwrap(parseComments(fromA)).comments, 'bbbb9999'), 1)
    const fromB = unwrap(appendComments(fromA, [pending('b')], 'bbbb9999'))
    assert.deepEqual(fromB.map(entry => entry.comment.id), ['c-bbbb-1'])
  })

  it('renders an anchor without a pipe in the author breaking it', () => {
    const rendered = unwrap(appendComments('', [pending('x')], 'a1b2c3d4'))[0]?.rendered ?? ''
    const parsed = unwrap(parseComments(rendered))
    assert.equal(parsed.comments[0]?.body, 'x')
    assert.equal(parsed.comments[0]?.author, 'human:daiqc')
  })

  it('appending nothing is a no-op, and the file ends with one newline', () => {
    assert.deepEqual(unwrap(appendComments('anything', [], 'a1b2c3d4')), [])
    const rendered = unwrap(appendComments('', [pending('only')], 'a1b2c3d4'))[0]?.rendered ?? ''
    assert.equal(rendered.endsWith('\n'), true)
    assert.equal(rendered.includes('\r'), false)
  })
})
