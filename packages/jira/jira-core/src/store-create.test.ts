/**
 * Tests for key allocation through the store — including the case a temp-directory test
 * misses and a real store hits immediately: **files that exist before any counter does**.
 * A store can be seeded by hand, by the CLI, or by an older version, and the first
 * allocation must still not walk onto a number that is already taken.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { encodeIssue } from './codec.ts'
import { type Identity, type Issue, type IssueKey, type Timestamp } from './entity.ts'
import { initializeRepository, runGit } from './git.ts'
import { writeTextAtomic } from './io.ts'
import { createIssue } from './mutate.ts'
import { allocateKey, createInStore, createStore, highestExistingKey, readIssueText, storePaths } from './store.ts'
import { type Vocab, parseVocab } from './vocab.ts'
import { MAX_KEY_NUMBER } from './counters.ts'

const AT = '2026-10-15T12:00:00Z' as Timestamp
const ACTOR = Object.freeze({ by: 'human:daiqc' as Identity, at: AT })

const fixture = await readFile(new URL('../fixtures/config.md', import.meta.url), 'utf8')

const vocab: Vocab = (() => {
  const parsed = parseVocab(fixture)
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error))
  return parsed.value
})()

const issueFor = (key: string): Issue => {
  const created = createIssue(
    { key, issueType: 'task', summary: key, tags: [], body: 'body\n' },
    { vocab, knownTags: [], at: AT, by: ACTOR.by },
  )
  if (!created.ok) throw new Error(JSON.stringify(created.error))
  return created.value.issue
}

const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  assert.equal(result.ok, true, `expected success, got ${JSON.stringify(result)}`)
  if (!result.ok) throw new Error('unreachable')
  return result.value
}

let root = ''

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-jira-create-'))
  await writeTextAtomic(storePaths.config(root), fixture)
  await mkdir(join(root, 'projects', 'DEMO', 'issues'), { recursive: true })
  // A store that already holds DEMO-1 and DEMO-7, with no counters file anywhere.
  for (const key of ['DEMO-1', 'DEMO-7'] as const) {
    const encoded = encodeIssue(issueFor(key))
    if (!encoded.ok) throw new Error('unreachable')
    await writeTextAtomic(storePaths.issue(root, 'DEMO', key as IssueKey), encoded.value)
  }
  // A deterministic committer, so the assertions do not depend on this machine's config.
  await initializeRepository(root)
  await runGit(root, ['config', '--local', 'user.name', 'test'])
  await runGit(root, ['config', '--local', 'user.email', 'test@example.invalid'])
})

after(async () => {
  if (root !== '') await rm(root, { recursive: true, force: true })
})

describe('key allocation: a store seeded before the counters existed', () => {
  it('sees the highest key already on disk', async () => {
    const store = createStore({ root, machineId: 'a1b2c3d4' })
    assert.equal(await highestExistingKey(store, 'DEMO'), 7)
    assert.equal(await highestExistingKey(store, 'NOPE'), 0, 'a project with no files starts at zero')
  })

  it('starts the first block after the existing files, not at one', async () => {
    const store = createStore({ root, machineId: 'a1b2c3d4' })
    const key = unwrap(await allocateKey(store, 'DEMO', AT))
    assert.equal(key, 'DEMO-8', 'DEMO-1..DEMO-7 are already taken')
    const next = unwrap(await allocateKey(store, 'DEMO', AT))
    assert.equal(next, 'DEMO-9')
  })

  it('keeps other projects in their own space', async () => {
    const store = createStore({ root, machineId: 'a1b2c3d4' })
    assert.equal(unwrap(await allocateKey(store, 'DH', AT)), 'DH-1', 'DH has no files yet')
  })

  it('records the claim so a second machine starts after the block', async () => {
    const other = createStore({ root, machineId: 'bbbb9999' })
    const key = unwrap(await allocateKey(other, 'DEMO', AT))
    assert.equal(key, 'DEMO-108', 'a1b2 claimed DEMO-8..DEMO-107, so the next block starts at 108')

    const mine = createStore({ root, machineId: 'a1b2c3d4' })
    assert.equal(unwrap(await allocateKey(mine, 'DEMO', AT)), 'DEMO-10', 'still inside the first machine\'s block')
  })

  it('writes one counters file per machine, with a project bucket in each', async () => {
    const mine = JSON.parse(await readFile(storePaths.counters(root, 'a1b2c3d4'), 'utf8'))
    assert.equal(mine.machine_id, 'a1b2c3d4')
    assert.deepEqual(Object.keys(mine.projects).sort(), ['DEMO', 'DH'])
    assert.deepEqual(mine.projects.DEMO.blocks, [[8, 107]])
    const other = JSON.parse(await readFile(storePaths.counters(root, 'bbbb9999'), 'utf8'))
    assert.deepEqual(other.projects.DEMO.blocks, [[108, 207]])
  })
})

describe('key allocation: the numbers land in real files, committed as they go', () => {
  it('creates the issue and commits it, so the audit trail starts with the attributes', async () => {
    const store = createStore({ root, machineId: 'a1b2c3d4' })
    const created = await store_create(store)
    assert.equal(created.key, 'DEMO-11')
    assert.equal(created.committed, true, 'the write also became a commit')

    // Decision 107: the key lives in the file name, never in the frontmatter.
    const text = unwrap(await readIssueText(store, 'DEMO-11' as IssueKey))
    assert.match(text, /^summary: made by the store$/m)
    assert.equal(text.includes('key:'), false)
    assert.equal(text.includes('\r'), false)

    const log = await runGit(root, ['log', '--pretty=%s'])
    if (log.code === 0) {
      assert.match(log.stdout, /DEMO-11: create/)
      const first = await runGit(root, ['show', '--name-only', '--pretty=format:', '--reverse', 'HEAD'])
      const files = first.stdout.split('\n').filter(line => line !== '')
      assert.ok(files.includes('.gitattributes'), 'the attributes file is in history')
    }
  })
})

/** Create one issue through the store's own path, without the plugin in the way. */
const store_create = async (store: ReturnType<typeof createStore>) => {
  const { createInStore } = await import('./store.ts')
  const result = await createInStore(store, 'DEMO', ACTOR, { issueType: 'task', summary: 'made by the store' })
  if (!result.ok) throw new Error(JSON.stringify(result.error))
  return result.value
}

describe('store: an exhausted project says so instead of minting a number (decision 158)', () => {
  it('reports KEY_EXHAUSTED when the last key of the space is already on disk', async () => {
    // The end-to-end wiring of the cap: `allocateKey` seeds from the files on disk, so a store whose
    // highest key is already the last one must refuse — not hand out `DEMO-10000`.
    const dir = await mkdtemp(join(tmpdir(), 'dsh-jira-exhausted-'))
    try {
      await writeTextAtomic(storePaths.config(dir), fixture)
      await mkdir(join(dir, 'projects', 'DEMO', 'issues'), { recursive: true })
      const encoded = encodeIssue(issueFor(`DEMO-${String(MAX_KEY_NUMBER)}`))
      if (!encoded.ok) throw new Error('unreachable')
      await writeTextAtomic(storePaths.issue(dir, 'DEMO', `DEMO-${String(MAX_KEY_NUMBER)}` as IssueKey), encoded.value)
      await initializeRepository(dir)

      const store = createStore({ root: dir, machineId: 'cafe1234' })
      const claimed = await allocateKey(store, 'DEMO', AT)
      assert.equal(claimed.ok, false)
      if (!claimed.ok) {
        assert.equal(claimed.error.code, 'KEY_EXHAUSTED')
        assert.equal(claimed.error.context?.project, 'DEMO')
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('store: a project key is a path segment, so it is validated (decision 162)', () => {
  it('refuses a traversal in the project and writes nothing outside the store', async () => {
    // `/jira new --project ../../tmp/x` used to reach `join(root, 'projects', project, 'issues')`.
    // The tool surface had a regex; the command surface and the CLI did not — so the check now lives in
    // the core, where no surface can forget it.
    const parent = await mkdtemp(join(tmpdir(), 'dsh-jira-traversal-'))
    const dir = join(parent, 'store')
    await mkdir(dir)
    try {
      await writeTextAtomic(storePaths.config(dir), fixture)
      await initializeRepository(dir)
      const store = createStore({ root: dir, machineId: 'cafe1234' })

      for (const project of ['../../tmp/x', '..', 'dh', 'A-B', 'ABCDEFG']) {
        const created = await createInStore(store, project, ACTOR, { issueType: 'task', summary: 'traversal' })
        assert.equal(created.ok, false, `"${project}" must be refused`)
        if (!created.ok) {
          assert.equal(created.error.code, 'INVALID_INPUT')
          assert.equal(created.error.message.includes('is not a project key'), true)
        }
        const allocated = await allocateKey(store, project, AT)
        assert.equal(allocated.ok, false, 'allocateKey is the other path builder')
      }

      // Nothing was created anywhere: not inside the store, and not in its parent.
      const entries = (await readdir(parent)).sort()
      assert.deepEqual(entries, ['store'], 'nothing escaped the store')
      assert.equal(await readdir(join(dir, 'projects')).catch(() => []).then(names => (names as string[]).length), 0)
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })
})

describe('store: a key is allocated against what is on disk, so a seed does not collide (decision 176)', () => {
  it('skips past an existing key that the counter did not know about', async () => {
    // The audit's worry: the counter is written first, so a key already on disk collides and the number
    // is burned. `claimKey` is given `highestExistingKey`, so the allocation must jump past it.
    const dir = await mkdtemp(join(tmpdir(), 'dsh-jira-seed-'))
    try {
      await mkdir(join(dir, 'projects', 'DH', 'issues'), { recursive: true })
      await writeTextAtomic(storePaths.config(dir), fixture)
      const store = createStore({ root: dir, machineId: 'beef1234' })
      const first = await createInStore(store, 'DH', ACTOR, { issueType: 'task', summary: 'first' })
      assert.equal(first.ok, true, JSON.stringify(first))
      if (!first.ok) return
      assert.equal(first.value.key, 'DH-1')
      // A file that arrived behind the counter's back (a seed, a hand copy, another machine).
      await writeTextAtomic(storePaths.issue(dir, 'DH', 'DH-7' as IssueKey), 'seeded\n')
      const second = await createInStore(store, 'DH', ACTOR, { issueType: 'task', summary: 'second' })
      assert.equal(second.ok, true, JSON.stringify(second))
      if (second.ok) assert.equal(second.value.key, 'DH-8', 'past the seed, not onto it')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('store: a refused create does not burn a number (decision 190)', () => {
  it('validates before allocating: the counter file is untouched and the next key has no gap', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-jira-noburn-'))
    try {
      await mkdir(join(dir, 'projects', 'DH', 'issues'), { recursive: true })
      await writeTextAtomic(storePaths.config(dir), fixture)
      const store = createStore({ root: dir, machineId: 'fade1234' })

      const refusals = [
        { issueType: 'not-a-type', summary: 'bad type' },
        { issueType: 'task', summary: '   ' },
        { issueType: 'task', summary: 'bad status', status: 'no-such-status' },
        { issueType: 'task', summary: 'bad tag', tags: ['NoSuchTag'] },
        { issueType: 'task', summary: 'bad priority', priority: 'P9' },
      ] as const
      for (const input of refusals) {
        const refused = await createInStore(store, 'DH', ACTOR, input)
        assert.equal(refused.ok, false, JSON.stringify(input))
        if (!refused.ok) {
          assert.equal(
            (refused.error.context as Record<string, unknown> | undefined)?.['keyAllocated'],
            false,
            `the refusal must say the number survives: ${JSON.stringify(input)}`,
          )
        }
      }
      assert.equal(await readdir(join(dir, 'counters')).catch(() => [] as string[]).then(names => names.length), 0,
        'no counter file was even created by the refused creates')

      const good = await createInStore(store, 'DH', ACTOR, { issueType: 'task', summary: 'the first real one' })
      assert.equal(good.ok, true, JSON.stringify(good))
      if (good.ok) assert.equal(good.value.key, 'DH-1', 'no number was burned: the first good create gets 1')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
