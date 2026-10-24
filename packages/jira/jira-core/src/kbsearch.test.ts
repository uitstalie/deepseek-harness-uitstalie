/**
 * Tests for core/kbsearch — the scan, its ranking, and the two rules decision 54 fixes:
 * every hit carries `file:line`, and a hit is a snippet rather than the body.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { type KnowledgeEntry, decodeKnowledge, sourceOf } from './kb.ts'
import { SNIPPET_MAX, TOP_K_DEFAULT, TOP_K_MAX, clampTopK, renderKbEntry, renderKbSearch, searchKnowledge, snippetAround } from './kbsearch.ts'

const entry = (over: Readonly<{
  key: string
  title: string
  body: string
  capturedAt?: string
  domain?: string
  /** Where the body starts in the file; decision 179 adds it to the body-relative match line. */
  bodyLine?: number
}>): KnowledgeEntry => Object.freeze({
  key: over.key as KnowledgeEntry['key'],
  domain: over.domain ?? 'KB',
  kbType: 'pitfall',
  title: over.title,
  tags: Object.freeze([]),
  source: sourceOf({
    machineId: 'm-1',
    os: 'linux',
    tool: 'dsh',
    capturedAt: (over.capturedAt ?? '2026-10-15T08:00:00Z') as never,
  }),
  issues: Object.freeze([]),
  body: over.body,
  bodyLine: over.bodyLine ?? 1,
})

const keys = (result: ReturnType<typeof searchKnowledge>): readonly string[] =>
  result.hits.map(hit => hit.key)

describe('kbsearch: ranking (decision 54)', () => {
  const library = [
    entry({ key: 'KB-1', title: 'unrelated', body: 'mkdir appears here twice: mkdir and mkdir.' }),
    entry({ key: 'KB-2', title: 'mkdir in the title', body: 'nothing else.' }),
    entry({ key: 'KB-3', title: 'unrelated too', body: 'mkdir once.' }),
    entry({ key: 'KB-4', title: 'no match', body: 'nothing to see.' }),
  ]

  it('puts a title hit first, then the busiest entry', () => {
    assert.deepEqual(keys(searchKnowledge(library, 'mkdir')), ['KB-2', 'KB-1', 'KB-3'])
  })

  it('breaks ties by capture time, newest first, and finally by key', () => {
    const same = [
      entry({ key: 'KB-9', title: 'a', body: 'needle', capturedAt: '2026-10-15T09:00:00Z' }),
      entry({ key: 'KB-8', title: 'a', body: 'needle', capturedAt: '2026-10-15T10:00:00Z' }),
      entry({ key: 'KB-7', title: 'a', body: 'needle', capturedAt: '2026-10-15T10:00:00Z' }),
    ]
    assert.deepEqual(keys(searchKnowledge(same, 'needle')), ['KB-7', 'KB-8', 'KB-9'])
  })

  it('is case-insensitive and says nothing for a blank query', () => {
    assert.deepEqual(keys(searchKnowledge(library, 'MKDIR')), ['KB-2', 'KB-1', 'KB-3'])
    const blank = searchKnowledge(library, '   ')
    assert.deepEqual(blank.hits, [])
    assert.equal(blank.matched, 0)
  })

  it('counts what matched even when top_k hides most of it', () => {
    const many = Array.from({ length: 12 }, (_, index) => entry({
      key: `KB-${String(index + 1)}`,
      title: 'hit',
      body: 'hit',
    }))
    const result = searchKnowledge(many, 'hit')
    assert.equal(result.hits.length, TOP_K_DEFAULT)
    assert.equal(result.matched, 12)
    assert.equal(result.truncated, true)
    assert.match(renderKbSearch(result), /2 more match/)
  })

  it('speaks Chinese only when the CLI asks for it (decision 55)', () => {
    // The English default is the model surface (`jira_kb search`'s rendering), so it must not move.
    const many = Array.from({ length: 12 }, (_, index) => entry({
      key: `KB-${String(index + 1)}`,
      title: 'hit',
      body: 'hit',
    }))
    const result = searchKnowledge(many, 'hit')
    assert.match(renderKbSearch(result, 'zh'), /还有 2 条匹配；请调大 `top_k`（上限 50）/)
    assert.match(renderKbSearch(result), /2 more match/)
    assert.equal(renderKbSearch(searchKnowledge([], 'nothing'), 'zh'), '没有匹配的知识条目')
  })
})

describe('kbsearch: a hit is a citation, not the body', () => {
  it('carries file:line pointing at the first body match, counted from the top of the file', () => {
    // Decision 179: the body starts on line 12 here, so a match on the body's 3rd line is line 14.
    const withLines = entry({
      key: 'KB-5',
      domain: 'windows',
      title: 'locks',
      body: 'first line\nsecond line\nmkdir is atomic here\nfourth\n',
      bodyLine: 12,
    })
    const [hit] = searchKnowledge([withLines], 'mkdir').hits
    assert.equal(hit?.file, 'knowledge/windows/KB-5.md')
    assert.equal(hit?.line, 14)
    assert.match(renderKbSearch(searchKnowledge([withLines], 'mkdir')), /knowledge\/windows\/KB-5\.md:14/)
  })

  it('cites the line a reader would actually find, frontmatter included (decision 179)', () => {
    const text = [
      '---',
      'schema: kb/v1',
      'type: pitfall',
      'title: locks',
      'tags: [windows]',
      'machine_id: m-1',
      'os: win32',
      'tool: dsh',
      'captured_at: 2026-10-15T08:00:00Z',
      'issues: []',
      '---',
      '',
      'first body line',
      'mkdir is atomic here',
      '',
    ].join('\n')
    const decoded = decodeKnowledge(text, 'KB-9', 'windows')
    assert.equal(decoded.ok, true)
    if (!decoded.ok) return
    const [hit] = searchKnowledge([decoded.value.entry], 'mkdir').hits
    assert.equal(hit?.line, 14)
    assert.equal(text.split('\n')[13], 'mkdir is atomic here', 'the citation must open the line it names')
  })

  it('points at line 1 when only the title matched', () => {
    const [hit] = searchKnowledge([entry({ key: 'KB-6', title: 'mkdir', body: 'unrelated body' })], 'mkdir').hits
    assert.equal(hit?.line, 1)
    assert.equal(hit?.titleMatch, true)
  })

  it('never returns the body, and caps the snippet', () => {
    const long = 'x'.repeat(400) + 'mkdir' + 'y'.repeat(400)
    const result = searchKnowledge([entry({ key: 'KB-7', title: 'long', body: long })], 'mkdir')
    const hit = result.hits[0]
    assert.ok(hit !== undefined)
    assert.equal(Object.hasOwn(hit, 'body'), false, 'the entry body must not ride along')
    assert.ok(hit.snippet.length <= SNIPPET_MAX + 2, `snippet was ${String(hit.snippet.length)} characters`)
    assert.match(hit.snippet, /mkdir/)
    assert.match(hit.snippet, /…/, 'a cut snippet says so')
  })

  it('flattens whitespace so a snippet is one readable line', () => {
    const snippet = snippetAround('a\n\n   b\tc\n', 1, 1)
    assert.equal(snippet, 'a b c')
  })
})

describe('kbsearch: renderKbEntry is the one-entry view (DPMJ-211)', () => {
  it('prints identity, lineage, cross-references and the body — one renderer, not inline lines', () => {
    const one = entry({ key: 'KB-5', domain: 'locking', title: 'locks', body: 'use mkdir\n' })
    const linked = Object.freeze({ ...one, issues: Object.freeze(['DH-1' as never]) })
    const text = renderKbEntry(linked)
    assert.match(text, /^KB-5 {2}\[pitfall\] {2}locks/)
    assert.match(text, /locking · captured 2026-10-15T08:00:00Z · m-1\/linux\/dsh/)
    assert.match(text, /issues: DH-1/, 'cross-references ride along when present')
    assert.match(text, /\nuse mkdir$/, 'the body closes the view')
    assert.equal(renderKbEntry(one).includes('issues:'), false, 'no empty issues line')
  })
})

describe('kbsearch: top_k', () => {
  it('defaults to 10 and caps at 50 (decision 54)', () => {
    assert.equal(TOP_K_DEFAULT, 10)
    assert.equal(TOP_K_MAX, 50)
    assert.equal(clampTopK(undefined), 10)
    assert.equal(clampTopK(0), 10)
    assert.equal(clampTopK(-3), 10)
    assert.equal(clampTopK(3), 3)
    assert.equal(clampTopK(500), 50)
    assert.equal(clampTopK(7.9), 7)
  })
})
