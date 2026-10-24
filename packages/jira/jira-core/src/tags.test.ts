/**
 * Tests for core/tags — the naming rule and the "did you mean" search (decision 86).
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { isTagName, similarity, suggestTags } from './tags.ts'

const registry = [
  { name: 'windows' },
  { name: 'linux' },
  { name: 'build' },
  { name: 'wake-lock', aliases: ['wakelock', 'suspend-lock'] },
]

describe('tags: the naming rule', () => {
  it('accepts lower-kebab with digits, up to 32 characters', () => {
    assert.equal(isTagName('windows'), true)
    assert.equal(isTagName('wake-lock'), true)
    assert.equal(isTagName('s3-bucket'), true)
    assert.equal(isTagName('a'.repeat(32)), true)
  })

  it('refuses the shapes that make two names look the same on disk', () => {
    // The frozen rule (decision 76) is `^[a-z0-9][a-z0-9-]{0,31}$`: it forbids a leading
    // separator, spaces, underscores and uppercase, but a trailing dash is legal today.
    for (const bad of ['Windows', 'wake lock', 'wake_lock', '-leading', 'a'.repeat(33), '中文']) {
      assert.equal(isTagName(bad), false, `${bad} must be refused`)
    }
  })
})

describe('tags: similarity', () => {
  it('is 1 for the same name, ignoring case and separators', () => {
    assert.equal(similarity('wake-lock', 'wakelock'), 1)
    assert.equal(similarity('WINDOWS', 'windows'), 1)
  })

  it('is high for a typo and low for an unrelated word', () => {
    assert.ok(similarity('windows', 'wndows') >= 0.5)
    assert.ok(similarity('windows', 'linux') < 0.5)
  })

  it('does not invent a score out of single characters', () => {
    assert.equal(similarity('a', 'b'), 0)
    assert.equal(similarity('a', 'a'), 1)
  })
})

describe('tags: suggestions', () => {
  it('resolves an alias to its canonical name, immediately', () => {
    assert.deepEqual(suggestTags(registry, 'wakelock'), ['wake-lock'])
    assert.deepEqual(suggestTags(registry, 'Suspend_Lock'), ['wake-lock'])
  })

  it('suggests the nearest registered names for a typo', () => {
    assert.equal(suggestTags(registry, 'wndows')[0], 'windows')
    assert.equal(suggestTags(registry, 'wake-lokc')[0], 'wake-lock')
  })

  it('treats a prefix relationship as strong evidence', () => {
    assert.equal(suggestTags(registry, 'win')[0], 'windows')
  })

  it('says nothing when nothing is close', () => {
    assert.deepEqual(suggestTags(registry, 'database'), [])
  })

  it('never returns more than the limit, and is stable', () => {
    assert.ok(suggestTags(registry, 'windows', 1).length <= 1)
    assert.deepEqual(suggestTags(registry, 'windows'), suggestTags(registry, 'windows'))
  })
})
