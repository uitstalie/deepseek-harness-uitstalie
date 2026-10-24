/**
 * Tests for core/kb — the knowledge entity's codec (decision 75).
 *
 * The interesting cases are the two sides of decision 49: a write refuses a typo, a field it
 * cannot use, or a missing part of the source quadruple; a read degrades with a warning instead.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { type KnowledgeEntry, asKnowledgeKey, decodeKnowledge, encodeKnowledge, isDomainName, knowledgePath, machineIdOf, sourceOf } from './kb.ts'

const KB_TYPES = Object.freeze(['runbook', 'pitfall', 'howto', 'concept'])

const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  assert.equal(result.ok, true, `expected success, got ${JSON.stringify(result)}`)
  if (!result.ok) throw new Error('unreachable')
  return result.value
}

const entry = (over: Partial<KnowledgeEntry> = {}): KnowledgeEntry => Object.freeze({
  key: 'KB-7' as KnowledgeEntry['key'],
  domain: 'locking',
  kbType: 'pitfall',
  title: 'Windows 上的锁必须用 mkdir',
  tags: Object.freeze(['windows']),
  source: sourceOf({
    machineId: 'm-357504ff',
    os: 'windows',
    tool: 'dsh',
    capturedAt: '2026-10-15T08:30:00Z' as never,
  }),
  issues: Object.freeze(['DH-12' as never]),
  body: '用 mkdir 而不是 flock，因为 Windows 上 flock 不是原子的。\n',
  bodyLine: 1,
  ...over,
})

const text = (over: Partial<KnowledgeEntry> = {}): string => unwrap(encodeKnowledge(entry(over), { kbTypes: KB_TYPES }))

describe('kb: the key and the domain', () => {
  it('accepts a knowledge key and refuses the neighbours', () => {
    assert.equal(asKnowledgeKey('KB-7'), 'KB-7')
    assert.equal(asKnowledgeKey('DH-12'), undefined, 'the same shape but another key space is not a knowledge key')
    assert.equal(asKnowledgeKey('kb-7'), undefined)
    assert.equal(asKnowledgeKey('KB'), undefined)
    assert.equal(asKnowledgeKey(' KB-7 '), 'KB-7', 'surrounding space is tolerated')
  })

  it('uses the tag rule for domain directory names (decision 76)', () => {
    assert.equal(isDomainName('windows'), true)
    assert.equal(isDomainName('wake-lock'), true)
    assert.equal(isDomainName('Windows'), false)
    assert.equal(isDomainName('未知域'), false)
  })

  it('keeps the key and the domain independent (decision 75)', () => {
    // The key is a global `KB-<n>` number; the domain is the directory. `KB-7` may live under
    // `windows`, and it still round-trips.
    const decoded = unwrap(decodeKnowledge(text({ domain: 'windows' }), 'KB-7', 'windows'))
    assert.equal(decoded.entry.domain, 'windows')
    assert.equal(decoded.entry.key, 'KB-7')
  })

  it('puts the file where the key says (decision 107: the file name is the key)', () => {
    assert.equal(knowledgePath('windows', 'KB-7' as never), 'knowledge/windows/KB-7.md')
  })
})

describe('kb: writing is strict (decision 49)', () => {
  it('round-trips a complete entry', () => {
    const decoded = unwrap(decodeKnowledge(text(), 'KB-7', 'locking'))
    assert.deepEqual(decoded.warnings, [])
    // Nine frontmatter keys, two fences and the blank separator put the body on line 13 (decision 179).
    assert.equal(decoded.entry.bodyLine, 13)
    assert.deepEqual(decoded.entry, entry({ bodyLine: 13 }))
    assert.match(text(), /^schema: kb\/v1$/m)
    assert.equal(text().includes('key:'), false, 'the key lives in the file name only')
  })

  it('refuses a type outside the store vocabulary', () => {
    const bad = encodeKnowledge(entry({ kbType: 'note' }), { kbTypes: KB_TYPES })
    assert.equal(bad.ok, false)
    if (!bad.ok) assert.match(bad.error.message, /type "note" is not one of: runbook, pitfall, howto, concept/)
  })

  it('refuses a title it cannot render or a domain that breaks the rule', () => {
    assert.match((encodeKnowledge(entry({ title: '  ' }), { kbTypes: KB_TYPES }) as { error: { message: string } }).error.message, /title must not be empty/)
    assert.match((encodeKnowledge(entry({ title: 'two\nlines' }), { kbTypes: KB_TYPES }) as { error: { message: string } }).error.message, /single line/)
    assert.match((encodeKnowledge(entry({ domain: 'Bad' }), { kbTypes: KB_TYPES }) as { error: { message: string } }).error.message, /must be lower-kebab/)
  })

  it('insists on the whole source quadruple, and on a hash for a file source', () => {
    for (const field of ['machineId', 'os', 'tool', 'capturedAt'] as const) {
      const broken = entry({
        source: sourceOf({
          machineId: 'm-1',
          os: 'windows',
          tool: 'dsh',
          capturedAt: '2026-10-15T08:30:00Z' as never,
          [field]: '',
        }),
      })
      const result = encodeKnowledge(broken, { kbTypes: KB_TYPES })
      assert.equal(result.ok, false, `${field} must be required`)
      if (!result.ok) assert.match(result.error.message, new RegExp(`"${field}" is required`))
    }

    const fileSource = entry({
      source: sourceOf({
        machineId: 'm-1',
        os: 'linux',
        tool: 'dsh',
        capturedAt: '2026-10-15T08:30:00Z' as never,
        source: 'raw/log.txt',
      }),
    })
    const missingHash = encodeKnowledge(fileSource, { kbTypes: KB_TYPES })
    assert.equal(missingHash.ok, false)
    if (!missingHash.ok) assert.match(missingHash.error.message, /source_sha256 is required/)

    const withHash = encodeKnowledge(entry({
      source: sourceOf({
        machineId: 'm-1',
        os: 'linux',
        tool: 'dsh',
        capturedAt: '2026-10-15T08:30:00Z' as never,
        source: 'raw/log.txt',
        sourceSha256: 'a'.repeat(64),
      }),
    }), { kbTypes: KB_TYPES })
    assert.equal(withHash.ok, true)

    const urlSource = encodeKnowledge(entry({
      source: sourceOf({
        machineId: 'm-1',
        os: 'linux',
        tool: 'dsh',
        capturedAt: '2026-10-15T08:30:00Z' as never,
        source: 'https://example.invalid/doc',
      }),
    }), { kbTypes: KB_TYPES })
    assert.equal(urlSource.ok, true, 'a URL needs no hash')
  })

  it('refuses a tag that is not lower-kebab', () => {
    const bad = encodeKnowledge(entry({ tags: Object.freeze(['Not A Tag']) }), { kbTypes: KB_TYPES })
    assert.equal(bad.ok, false)
    if (!bad.ok) assert.match(bad.error.message, /must be lower-kebab/)
  })
})

describe('kb: reading is tolerant (decision 49)', () => {
  it('warns about a missing source field instead of failing the read', () => {
    const broken = text().replace(/^machine_id:.*$/m, '')
    const decoded = unwrap(decodeKnowledge(broken, 'KB-7', 'locking'))
    assert.deepEqual(decoded.warnings, ['missing required field "machine_id"'])
    assert.equal(decoded.entry.source.machineId, '')
    assert.equal(decoded.entry.title, 'Windows 上的锁必须用 mkdir', 'the rest still reads')
  })

  it('warns about an unknown key, a wrong schema and a bad cross reference', () => {
    const noisy = `${text().replace('schema: kb/v1', 'schema: kb/v0')}`
      .replace('issues: [DH-12]', 'issues: [DH-12, nope]')
      .replace('tags:', 'future_field: 1\ntags:')
    const decoded = unwrap(decodeKnowledge(noisy, 'KB-7', 'locking'))
    assert.deepEqual(decoded.warnings, [
      'unknown frontmatter key "future_field"',
      'schema is "kb/v0", expected "kb/v1"',
      '"nope" is not an issue key',
    ])
    assert.deepEqual(decoded.entry.issues, ['DH-12'])
  })

  it('refuses a file whose frontmatter is outside the restricted subset', () => {
    // Decision 112 allows one level of nesting (a block array of inline arrays, a flow map), and
    // still refuses a map inside a map.
    const nested = decodeKnowledge('---\ntitle: x\nmeta:\n  nested:\n    deep: 1\n---\n', 'KB-1', 'locking')
    assert.equal(nested.ok, false, 'two levels of map is outside the subset')

    const oneLevel = decodeKnowledge('---\ntitle: x\ntags:\n  - [a, b]\n---\n', 'KB-1', 'locking')
    assert.equal(oneLevel.ok, true, 'one level of nesting is legal (decision 112)')
  })

  it('refuses a key that is not a knowledge key', () => {
    const decoded = decodeKnowledge(text(), 'nope', 'locking')
    assert.equal(decoded.ok, false)
    if (!decoded.ok) assert.match(decoded.error.message, /is not a knowledge key/)
  })
})

describe('kb: the source identity', () => {
  it('pulls the machine out of the identity tuple (decision 48)', () => {
    assert.equal(machineIdOf('agent:deepseek|dsh|m-357504ff|session-1'), 'm-357504ff')
    assert.equal(machineIdOf('human:daiqc'), undefined, 'a human identity has no machine')
    assert.equal(machineIdOf('agent:x|dsh||s-1'), undefined, 'an empty machine slot is not a machine')
    assert.equal(machineIdOf('nonsense'), undefined)
  })
})
