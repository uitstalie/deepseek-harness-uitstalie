/**
 * Tests for core/tagstore — the tag registry's write path (decision 26).
 *
 * The interesting assertion is not "the file exists": it is that the file this module writes is
 * exactly what the **existing reader** (`store.loadTags`) and the generator expect — the registry had
 * a read half and a linter long before it had a way to create anything.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { type Identity, type Timestamp } from './entity.ts'
import { runGit } from './git.ts'
import { scaffoldStore } from './scaffold.ts'
import { createStore, loadTags, type Store } from './store.ts'
import { createTag, decodeTag, encodeTag, readTag } from './tagstore.ts'
import { lintTags } from './tagsLint.ts'

const AT = '2026-10-15T12:00:00Z' as Timestamp
const ACTOR = Object.freeze({ by: 'human:daiqc' as Identity, at: AT })

const work: string[] = []
const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: { message: string; code: string } }): T => {
  assert.equal(result.ok, true, `expected success, got ${JSON.stringify(result)}`)
  if (!result.ok) throw new Error('unreachable')
  return result.value
}

let root = ''
let store: Store

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-jira-tag-'))
  work.push(root)
  unwrap(await scaffoldStore(root))
  await runGit(root, ['config', '--local', 'user.name', 'tester'])
  await runGit(root, ['config', '--local', 'user.email', 'tester@example.invalid'])
  store = createStore({ root, machineId: 'dddddddd' })
})

after(async () => {
  for (const directory of work) await rm(directory, { recursive: true, force: true })
})

describe('tagstore: registering a tag (decision 26)', () => {
  it('writes tags/<name>.md in the shape the reader already expects', async () => {
    const created = unwrap(await createTag(store, ACTOR, {
      name: 'windows',
      description: 'work that only happens on Windows',
      aliases: ['win'],
    }))
    assert.equal(created.tag.name, 'windows')
    assert.equal(created.committed, true)

    const text = await readFile(join(root, 'tags', 'windows.md'), 'utf8')
    assert.match(text, /^schema: tag\/v1$/m)
    assert.match(text, /^type: tag$/m)
    assert.match(text, /^name: windows$/m)
    assert.match(text, /^description: work that only happens on Windows$/m)
    assert.match(text, /^created_by: human:daiqc$/m)
    assert.match(text, /^created_at: 2026-10-15T12:00:00Z$/m)

    // The registry's read half sees exactly this tag, description and alias included.
    const loaded = unwrap(await loadTags(store))
    assert.deepEqual(loaded, [{ name: 'windows', description: 'work that only happens on Windows', aliases: ['win'] }])

    // ...and the linter, whose "missing description" section is the reason this path exists, is quiet.
    const report = lintTags(loaded, [])
    assert.deepEqual(report.missingDescription, [])
  })

  it('normalises the name it is given, and keeps the aliases folded', async () => {
    const created = unwrap(await createTag(store, ACTOR, { name: '  Windows-CI ', description: 'the CI runners', aliases: ['CI ', ''] }))
    assert.equal(created.tag.name, 'windows-ci')
    assert.deepEqual(created.tag.aliases, ['ci'])
  })

  it('refuses a duplicate, quoting the description already there', async () => {
    const again = await createTag(store, ACTOR, { name: 'windows', description: 'something else' })
    assert.equal(again.ok, false)
    if (!again.ok) {
      assert.equal(again.error.code, 'INVALID_INPUT')
      assert.match(again.error.message, /already registered \(work that only happens on Windows\)/)
    }
  })

  it('refuses a missing description, because that is the whole point of the registry', async () => {
    const blank = await createTag(store, ACTOR, { name: 'undocumented', description: '   ' })
    assert.equal(blank.ok, false)
    if (!blank.ok) assert.match(blank.error.message, /needs a description/)
    assert.equal(unwrap(await readTag(store, 'undocumented')), undefined, 'and nothing was written')
  })

  it('refuses a name that is not a tag (decision 76)', async () => {
    // `Windows` and `UPPER` are legal after lowercasing; these shapes cannot be rescued.
    for (const bad of ['has space', '-leading', '', 'a_b', 'x'.repeat(33)]) {
      const refused = await createTag(store, ACTOR, { name: bad, description: 'x' })
      assert.equal(refused.ok, false, `"${bad}" must be refused`)
      if (!refused.ok) assert.match(refused.error.message, /not a legal tag name/)
    }
  })

  it('round-trips through its own codec, and flags an unknown key', () => {
    const text = encodeTag({ name: 'demo', description: 'a demo tag', createdBy: 'human:daiqc', createdAt: AT })
    const decoded = unwrap(decodeTag(text, 'demo'))
    assert.equal(decoded.record.description, 'a demo tag')
    assert.deepEqual(decoded.unknownKeys, [])
    const odd = unwrap(decodeTag(`${text.replace('type: tag', 'type: tag\nsurprise: 1')}`, 'demo'))
    assert.deepEqual(odd.unknownKeys, ['surprise'])
  })
})
