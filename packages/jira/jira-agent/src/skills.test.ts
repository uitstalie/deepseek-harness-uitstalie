/**
 * Tests for the packaged skills (decision 88).
 *
 * The skills are files, so what matters is that they are actually there, that the host would
 * accept them (a bad name or an empty description throws in the real registry), and that a
 * missing file degrades to "skipped" instead of breaking the plugin.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, it } from 'node:test'

import { SKILL_CATALOGUE, packageRootFrom, readSkillBody, registerSkills, type SkillDefinition } from './skills.ts'

const root = packageRootFrom(import.meta.url)

/** The same rules the host's registry enforces, so a skill cannot be registered-and-thrown. */
const SKILL_NAME = /^[a-z][a-z0-9-]*$/u

describe('skills: the package ships three usable skills', () => {
  it('registers all three, with content the registry would accept', async () => {
    const registered: SkillDefinition[] = []
    const result = await registerSkills(
      { skills: { register: (definition) => { registered.push(definition); return () => undefined } } },
      root,
    )
    assert.deepEqual(result.skipped, [])
    assert.deepEqual(result.registered, ['jira-work', 'jira-board', 'jira-triage'])
    assert.equal(registered.length, 3)

    for (const skill of registered) {
      assert.match(skill.name, SKILL_NAME, `${skill.name} must be a legal skill name`)
      assert.ok(skill.description.length > 20, `${skill.name} needs a real description`)
      assert.equal(skill.source, 'runtime')
      assert.match(skill.content, /^# /u, `${skill.name} must start with a heading`)
      assert.ok(skill.content.length > 500, `${skill.name} must say something useful`)
    }
  })

  it('reads a body straight from the package, and reports a missing one', async () => {
    const body = await readSkillBody('jira-work', root)
    assert.equal(body.ok, true)
    if (body.ok) assert.match(body.value, /jira_issue/)

    const missing = await readSkillBody('no-such-skill', root)
    assert.equal(missing.ok, false)
    if (!missing.ok) assert.match(missing.error.message, /cannot read the no-such-skill skill/)
  })

  it('skips what it cannot read rather than failing to load', async () => {
    const result = await registerSkills({ skills: { register: () => () => undefined } }, '/nonexistent')
    assert.deepEqual(result.registered, [])
    assert.deepEqual(result.skipped, SKILL_CATALOGUE.map(entry => entry.name))
  })

  it('does nothing when the host has no skill registry', async () => {
    const result = await registerSkills({}, root)
    assert.deepEqual(result.registered, [])
    assert.deepEqual(result.skipped, [])
  })

  it('describes each skill in the catalogue it registers', async () => {
    for (const entry of SKILL_CATALOGUE) {
      const body = await readSkillBody(entry.name, root)
      assert.equal(body.ok, true, entry.name)
      assert.ok(entry.description.includes('dsh-jira'), `${entry.name} should name the system it belongs to`)
    }
  })

  it('resolves the package root through a non-ASCII path', async () => {
    // A package under a non-ASCII directory arrives as a percent-encoded module URL.
    // `URL.pathname` keeps that encoding, so the root resolved to a path that does not exist
    // and all three skills were skipped without a word — found on the Fedora side, where the
    // clone lives under `~/桌面/`; a Windows clone at `D:\dqc\` never showed it.
    const dir = await mkdtemp(join(tmpdir(), 'dsh-jira-桌面-'))
    try {
      const resolved = packageRootFrom(pathToFileURL(join(dir, 'src', 'skills.ts')).href)
      assert.ok(!resolved.includes('%'), `the root must be decoded, got ${resolved}`)
      assert.equal(resolved, dir)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
