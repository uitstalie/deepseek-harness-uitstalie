/**
 * Tests for core/codec — the disk↔code seam (decisions 41/43/44/45/46/47/49/80).
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { type Issue, asIssueKey } from './entity.ts'
import { ISSUE_SCHEMA, decodeIssue, encodeIssue } from './codec.ts'

const DH12 = asIssueKey('DH-12')
const DH5 = asIssueKey('DH-5')
assert.ok(DH12 !== undefined)
assert.ok(DH5 !== undefined)

const sample: Issue = Object.freeze({
  key: DH12,
  project: 'DH',
  issueType: 'task',
  status: 'in_progress',
  summary: 'fix: the thing #1',
  priority: 'S3',
  tags: Object.freeze(['build', 'windows']),
  links: Object.freeze([{ type: 'is_blocked_by' as const, target: DH5 }]),
  note: 'watch the lock file',
  revision: 3,
  createdAt: '2026-10-15T08:30:00Z' as Issue['createdAt'],
  updatedAt: '2026-10-15T09:00:00Z' as Issue['updatedAt'],
  reporter: 'agent:deepseek-flash|dsh|a1b2c3d4|s-1' as Issue['reporter'],
  kbRefs: Object.freeze(['KB-7']),
  conflicted: false,
  body: 'Why it happened.\n\n- detail one\n- detail two\n',
})

const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  assert.equal(result.ok, true, `expected success, got ${JSON.stringify(result)}`)
  if (!result.ok) throw new Error('unreachable')
  return result.value
}

describe('codec: encode then decode is lossless', () => {
  it('round-trips every field, including the optional ones', () => {
    const text = unwrap(encodeIssue(sample))
    const decoded = unwrap(decodeIssue(text, DH12))
    assert.deepEqual(decoded.warnings, [])
    assert.deepEqual(decoded.issue, sample)
  })

  it('round-trips an issue without the optional fields', () => {
    const { note, ...withoutNote } = sample
    assert.equal(note, 'watch the lock file')
    const minimal: Issue = Object.freeze({ ...withoutNote })
    const decoded = unwrap(decodeIssue(unwrap(encodeIssue(minimal)), DH12))
    assert.deepEqual(decoded.issue, minimal)
    assert.equal('note' in decoded.issue, false)
    assert.equal('assignee' in decoded.issue, false)
    assert.equal('resolution' in decoded.issue, false)
  })

  it('writes the disk spelling, not the code spelling (decision 41)', () => {
    const text = unwrap(encodeIssue(sample))
    assert.match(text, /^issue_type: task$/m)
    assert.match(text, /^created_at: 2026-10-15T08:30:00Z$/m)
    assert.match(text, /^kb_refs: \[KB-7\]$/m)
    assert.match(text, /^schema: issue\/v1$/m)
    assert.match(text, /^type: issue$/m)
    assert.equal(/issueType|createdAt|kbRefs/.test(text), false)
  })

  it('starts with the fence and keeps LF endings', () => {
    const text = unwrap(encodeIssue(sample))
    assert.equal(text.startsWith('---\n'), true)
    assert.equal(text.includes('\r'), false)
    assert.equal(ISSUE_SCHEMA, 'issue/v1')
  })
})

describe('codec: reads are tolerant, and say what they tolerated', () => {
  const text = (fields: readonly string[]): string => `---\n${fields.join('\n')}\n---\n\nbody\n`

  const base = [
    'schema: issue/v1',
    'type: issue',
    'project: DH',
    'issue_type: task',
    'status: todo',
    'summary: short',
    'priority: S3',
    'created_at: 2026-10-15T08:30:00Z',
    'updated_at: 2026-10-15T08:30:00Z',
    'reporter: human:daiqc',
  ]

  it('reports unknown keys instead of failing', () => {
    const decoded = unwrap(decodeIssue(text([...base, 'weird_extra: 1']), DH12))
    assert.equal(decoded.warnings.length, 1)
    assert.match(decoded.warnings[0] ?? '', /unknown frontmatter key "weird_extra"/)
  })

  it('defaults a missing revision to 1 (decision 44)', () => {
    assert.equal(unwrap(decodeIssue(text(base), DH12)).issue.revision, 1)
  })

  it('writes links as one-level flow maps, exactly as decision 70 specifies', () => {
    const text = unwrap(encodeIssue(sample))
    assert.match(text, /^links: \[\{ type: is_blocked_by, target: DH-5 \}\]$/m)
    assert.deepEqual(unwrap(decodeIssue(text, DH12)).issue.links, [
      { type: 'is_blocked_by', target: 'DH-5' },
    ])
  })

  it('rejects a stored `key`: the file name is the identity (C3)', () => {
    const result = decodeIssue(text([...base, 'key: DH-99']), DH12)
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.error.message, /must not carry `key`/)
  })

  it('never writes a `key` field', () => {
    assert.equal(/^key:/m.test(unwrap(encodeIssue(sample))), false)
  })

  it('warns on an unexpected schema version but still reads the record', () => {
    const decoded = unwrap(decodeIssue(text(base.map(l => l.replace('issue/v1', 'issue/v2'))), DH12))
    assert.match(decoded.warnings.join('\n'), /unexpected schema "issue\/v2"/)
  })

  it('fails loudly when a required field is missing', () => {
    const withoutSummary = base.filter(line => !line.startsWith('summary:'))
    const result = decodeIssue(text(withoutSummary), DH12)
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.error.code, 'INVALID_INPUT')
      assert.match(result.error.message, /missing `summary`/)
    }
  })

  it('fails loudly on a wrong document type', () => {
    const result = decodeIssue(text(base.map(l => l.replace('type: issue', 'type: Issue'))), DH12)
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.error.message, /`type` must be "issue"/)
  })
})

describe('codec: link shapes outside the vocabulary stay loud', () => {
  const text = (fields: readonly string[]): string => `---\n${fields.join('\n')}\n---\n\nbody\n`
  const base = [
    'schema: issue/v1',
    'type: issue',
    'project: DH',
    'issue_type: task',
    'status: todo',
    'summary: short',
    'priority: S3',
    'created_at: 2026-10-15T08:30:00Z',
    'updated_at: 2026-10-15T08:30:00Z',
    'reporter: human:daiqc',
  ]

  it('rejects an unknown link type', () => {
    const result = decodeIssue(text([...base, 'links: [{ type: blocks, target: DH-1 }]']), DH12)
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.error.message, /unknown link type "blocks"/)
  })

  it('rejects a link target that is not an issue key', () => {
    const result = decodeIssue(text([...base, 'links: [{ type: parent, target: nope }]']), DH12)
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.error.message, /is not an issue key/)
  })

  it('rejects a nested collection inside links, rather than guessing (decision 105)', () => {
    const result = decodeIssue(text([...base, 'links: [{ type: parent, target: [DH-1] }]']), DH12)
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.error.message, /unsupported/)
  })
})
