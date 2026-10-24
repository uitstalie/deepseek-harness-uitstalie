/**
 * Tests for core/tagsLint — decision 86's three fixed sections.
 *
 * The rule that matters most is the one about **not acting**: this report never renames or merges
 * anything, because a tag is a human's vocabulary and the commit log is history.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { type Issue, type IssueKey, type Timestamp } from './entity.ts'
import { SIMILARITY_THRESHOLD, lintTags, renderTagsLint } from './tagsLint.ts'
import { type TagDef } from './tags.ts'

const tag = (name: string, description?: string, aliases: readonly string[] = []): TagDef => Object.freeze({
  name,
  ...(description === undefined ? {} : { description }),
  aliases: Object.freeze([...aliases]),
})

const issue = (key: string, tags: readonly string[]): Issue => Object.freeze({
  key: key as IssueKey,
  project: key.slice(0, key.lastIndexOf('-')),
  issueType: 'task',
  status: 'todo',
  summary: `summary ${key}`,
  priority: 'S3',
  tags: Object.freeze([...tags]),
  links: Object.freeze([]),
  kbRefs: Object.freeze([]),
  reporter: 'human:me' as never,
  revision: 1,
  createdAt: '2026-10-15T12:00:00Z' as Timestamp,
  updatedAt: '2026-10-15T12:00:00Z' as Timestamp,
  conflicted: false,
  body: '',
})

describe('tagsLint: the three sections', () => {
  const tags = [tag('windows', 'Windows 平台'), tag('win', 'Windows 的简写'), tag('unused', '没人用'), tag('nodesc')]
  const issues = [issue('DH-1', ['windows']), issue('DH-2', ['windows'])]

  it('lists tags used at most once, including never', () => {
    const report = lintTags(tags, issues)
    // Sorted by count, then by name: nodesc and unused both have zero uses.
    assert.deepEqual(report.barelyUsed.map(entry => entry.name), ['nodesc', 'unused', 'win'])
    assert.equal(report.barelyUsed.find(entry => entry.name === 'unused')?.count, 0)
    assert.equal(report.barelyUsed.some(entry => entry.name === 'windows'), false)
  })

  it('lists tags with no description', () => {
    assert.deepEqual(lintTags(tags, issues).missingDescription, ['nodesc'])
  })

  it('uses the lint threshold (0.7), stricter than the suggestion threshold (0.5)', () => {
    // windows ~ window is 0.91, so it belongs in the report.
    const near = lintTags([tag('windows', 'x'), tag('window', 'y', ['windows'])], [])
    assert.deepEqual(near.similar.map(pair => [pair.left, pair.right, pair.shared]), [['window', 'windows', true]])
    assert.ok((near.similar[0]?.score ?? 0) >= SIMILARITY_THRESHOLD)

    // win ~ windows is 0.5: good enough to suggest a tag but not to call the vocabulary duplicated.
    const far = lintTags([tag('windows', 'x'), tag('win', 'y')], [])
    assert.deepEqual(far.similar, [])
  })

  it('keeps unrelated names out of the similar section', () => {
    const report = lintTags([tag('windows'), tag('database'), tag('sandbox')], [])
    assert.deepEqual(report.similar, [])
  })
})

describe('tagsLint: the report always shows all three sections', () => {
  it('says (none) rather than hiding an empty section', () => {
    const text = renderTagsLint(lintTags([], []))
    assert.match(text, /只用过一次（0）：\n {2}（无）/)
    assert.match(text, /缺少 description（0）：\n {2}（无）/)
    assert.match(text, new RegExp(`相似对，Dice ≥ ${String(SIMILARITY_THRESHOLD)}（0）：\\n {2}（无）`))
    assert.match(text, /只报告，绝不改写/)
  })

  it('shows counts and the similarity score', () => {
    const text = renderTagsLint(lintTags([tag('windows'), tag('window')], [issue('DH-1', ['windows'])]))
    assert.match(text, /window ~ windows\s+（0\.9\d*）/)
    assert.match(text, /已检查：2 个标签 \/ 1 条 issue/)
  })
})
