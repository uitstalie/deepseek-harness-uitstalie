/**
 * Tests for the **packaging contract** (decisions 65, 99, 101, 108).
 *
 * These are the tests that answer "can this thing actually be installed as a bundle?":
 * they read the real `package.json` and the real `cordis.patch.yml` and check the wiring
 * the host will rely on. A typo in any of it would otherwise only show up when the plugin
 * silently fails to appear in `dsh web`.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

const root = new URL('../../', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as Record<string, unknown>
const patchUrl = new URL('cordis.patch.yml', root)

describe('packaging: the bundle contract (decision 99)', () => {
  it('declares a bundle patch, which is what makes `dsh plugin add` treat it as a bundle', () => {
    const dsh = manifest.dsh as { bundle?: { patch?: unknown } } | undefined
    const patches = dsh?.bundle?.patch
    assert.ok(Array.isArray(patches) && patches.length > 0, 'dsh.bundle.patch must list at least one patch')
    for (const entry of patches as readonly string[]) {
      assert.equal(typeof entry, 'string')
      assert.equal(existsSync(new URL(entry.replace(/^\.\//, ''), root)), true, `${entry} must exist`)
    }
  })

  it('declares no peers either: it imports nothing from the host (decision 109)', () => {
    // A peer we do not use is an install-time liability: pnpm's auto-install-peers would
    // reach for the host packages on a machine that cannot reach the registry.
    assert.equal(manifest.peerDependencies, undefined)
    assert.equal(manifest.peerDependenciesMeta, undefined)
  })
  it('ships the patch and the build output to the target machine (decision 65)', () => {
    const files = manifest.files as readonly string[]
    assert.ok(files.includes('dist'), 'the build output must be part of the package')
    assert.ok(files.includes('cordis.patch.yml'), 'the patch must travel with the package')
    assert.ok(files.includes('README.md'), 'the readme travels with it (it is in `files`)')
    // The skills are files, so a copied package without them would register nothing.
    assert.ok(files.includes('skills'), 'the skills must travel with the package')
    for (const skill of ['jira-work', 'jira-board', 'jira-triage']) {
      assert.ok(existsSync(new URL(`skills/${skill}.md`, root)), `${skill}.md must be present in the source package`)
    }
  })

  it('exposes exactly the two entries decision 64 chose', () => {
    const exports = manifest.exports as Record<string, Record<string, string>>
    assert.ok(exports['.'] !== undefined, 'the plugin entry (exports ".") must exist')
    assert.ok(exports['./cli'] !== undefined, 'the CLI entry (exports "./cli") must exist')
    assert.match(exports['.']?.default ?? '', /dist\/plugin\/index\.js$/)
    assert.match(exports['./cli']?.default ?? '', /dist\/cli\/index\.js$/)
    const bin = manifest.bin as Record<string, string>
    assert.match(bin.jira ?? '', /dist\/cli\/index\.js$/)
  })

  it('has no runtime dependencies at all (decisions 65, 108)', () => {
    const dependencies = manifest.dependencies as Record<string, string> | undefined
    assert.equal(dependencies, undefined, 'the package must have no `dependencies`')
  })

  it('follows the host engine floor (decision 63)', () => {
    const engines = manifest.engines as Record<string, string>
    assert.equal(engines.node, '^22.19.0 || >=24.0.0')
  })
})

describe('packaging: the patch content (decision 101)', () => {
  const patch = readFileSync(patchUrl, 'utf8')

  it('inserts one row whose name is this package', () => {
    const names = [...patch.matchAll(/name:\s*'([^']+)'/g)].map(match => match[1])
    assert.deepEqual(names, [manifest.name])
  })

  it('inserts a fresh row id (so the web bundle cannot have disabled it)', () => {
    const ids = [...patch.matchAll(/id:\s*([A-Za-z0-9_-]+)/g)].map(match => match[1])
    assert.deepEqual(ids, ['dsh-jira'])
  })

  it('uses `insert`, not an override of an existing row', () => {
    assert.match(patch, /^- insert:/m)
    assert.equal(/- id: [a-z-]+\n\s+disabled:/.test(patch), false, 'an inserted row must not be disabled')
  })
})

describe('packaging: the entry stays wiring-only (decision 186)', () => {
  const src = new URL('../', import.meta.url)

  it('keeps index.ts to apply + registration + re-exports — the pieces live in their own files', () => {
    const text = readFileSync(new URL('plugin/index.ts', src), 'utf8')
    const lines = text.split('\n').length
    assert.ok(lines <= 560, `plugin/index.ts is ${String(lines)} lines; decision 186 caps the wiring entry at 560`)
    for (const module of ['host.ts', 'envelope.ts', 'sessionRecord.ts', 'toolIssue.ts', 'toolList.ts', 'toolKb.ts']) {
      assert.ok(existsSync(new URL(`plugin/${module}`, src)), `plugin/${module} must exist (decision 186's split)`)
    }
  })

  it('defines no tool schema or runner in the entry — those belong to the tool files', () => {
    const text = readFileSync(new URL('plugin/index.ts', src), 'utf8')
    for (const name of ['runIssueTool', 'runListTool', 'runKbTool']) {
      assert.equal(new RegExp(`export const ${name} =`).test(text), false, `${name} is re-exported, not defined here`)
    }
    assert.equal(/const ISSUE_PARAMETERS =/.test(text), false, 'the issue schema lives in toolIssue.ts')
    assert.equal(/const KB_PARAMETERS =/.test(text), false, 'the kb schema lives in toolKb.ts')
    assert.equal(/const LIST_PARAMETERS =/.test(text), false, 'the list schema lives in toolList.ts')
  })
})
