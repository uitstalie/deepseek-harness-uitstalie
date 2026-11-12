/**
 * Tests for cross-workspace conventions injection: marker extraction, deterministic rendering,
 * sorting, workspace-owned changes, and the caps that keep the runtime context bounded.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import type { WorkspaceRegistryLike } from './superagent.ts'
import {
  clearWorkspaceConventionsCache,
  CONVENTIONS_MAX_WORKSPACES,
  CONVENTIONS_PER_WORKSPACE_MAX,
  workspaceConventionsText,
  WORKSPACE_CONVENTIONS_BEGIN,
  WORKSPACE_CONVENTIONS_END,
} from './workspace-conventions.ts'

/** Roots created by this file, removed once the run settles. */
const roots: string[] = []

after(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** A workspace row with only the facts the renderer reads. */
interface Row {
  readonly id: string
  readonly path: string
  readonly title: string
}

/** A registry stand-in; the renderer only calls `list()`. */
const registryOf = (rows: readonly Row[]): WorkspaceRegistryLike => ({
  list: () => rows.map(row => ({ ...row, sessionIds: [], status: () => Promise.resolve('ok') })),
  create: () => Promise.reject(new Error('unused')),
})

/** One scratch root with its super home. */
const fixture = async (): Promise<{ root: string; home: string }> => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-conventions-'))
  roots.push(root)
  const home = join(root, 'super-agent')
  await mkdir(home, { recursive: true })
  return { root, home }
}

/** Write one workspace AGENTS.md with an optional conventions section. */
const writeConventions = async (workspace: string, title: string, body?: string): Promise<void> => {
  await mkdir(workspace, { recursive: true })
  const section = body === undefined
    ? ''
    : `\n${WORKSPACE_CONVENTIONS_BEGIN}\n${body}\n${WORKSPACE_CONVENTIONS_END}\n`
  await writeFile(join(workspace, 'AGENTS.md'), `# ${title}\n${section}unrelated tail\n`, 'utf8')
}

void describe('superagent: workspace conventions context', () => {
  void it('renders sorted, deterministic sections and skips the super home', async () => {
    clearWorkspaceConventionsCache()
    const { root, home } = await fixture()
    const first = join(root, 'system-img')
    const second = join(root, 'analyze')
    await writeConventions(first, 'system_img', 'Deliver reports as XLSX.\nVerify totals against the raw CSV.')
    await writeConventions(second, 'analyze', 'Keep the raw input beside the report.')
    await writeConventions(home, 'Super agent', 'this must not appear')
    const registry = registryOf([
      { id: 'w-2', path: second, title: 'analyze' },
      { id: 'w-1', path: first, title: 'system_img' },
      { id: 'w-0', path: home, title: 'Super agent' },
    ])

    const text = workspaceConventionsText(registry, home)
    assert.equal(workspaceConventionsText(registry, home), text, 'the same files render byte for byte')
    assert.equal(text, '[superagent workspace conventions] read-only; cite the file and section when used\n'
      + `  w-1 · system_img — ${join(first, 'AGENTS.md')}#superagent:conventions\n`
      + '    Deliver reports as XLSX.\n'
      + '    Verify totals against the raw CSV.\n'
      + `  w-2 · analyze — ${join(second, 'AGENTS.md')}#superagent:conventions\n`
      + '    Keep the raw input beside the report.')
    assert.equal(text.includes('this must not appear'), false, 'the super workspace policy is not repeated here')
    assert.equal(text.includes('unrelated tail'), false, 'only the marked section is injected')
  })

  void it('contributes nothing when no workspace declares a section', async () => {
    clearWorkspaceConventionsCache()
    const { root, home } = await fixture()
    const quiet = join(root, 'quiet')
    await writeConventions(quiet, 'quiet')
    const registry = registryOf([{ id: 'w-1', path: quiet, title: 'quiet' }])
    assert.equal(workspaceConventionsText(registry, home), '')
    assert.equal(workspaceConventionsText(undefined, home), '')
    assert.equal(workspaceConventionsText(registry, undefined), '')
  })

  void it('picks up a workspace edit and keeps the old text until the file changes', async () => {
    clearWorkspaceConventionsCache()
    const { root, home } = await fixture()
    const workspace = join(root, 'analyze')
    await writeConventions(workspace, 'analyze', 'Deliver CSV.')
    const registry = registryOf([{ id: 'w-1', path: workspace, title: 'analyze' }])
    const before = workspaceConventionsText(registry, home)
    assert.match(before, /Deliver CSV\./u)
    assert.equal(workspaceConventionsText(registry, home), before, 'a stat hit reuses the extraction')

    await writeConventions(workspace, 'analyze', 'Deliver the report as CSV; cite the query.')
    const later = new Date(Date.now() + 5_000)
    await utimes(join(workspace, 'AGENTS.md'), later, later)
    const afterEdit = workspaceConventionsText(registry, home)
    assert.match(afterEdit, /Deliver the report as CSV/u)
    assert.equal(afterEdit.includes('Deliver CSV.'), false)
    assert.notEqual(afterEdit, before)
  })

  void it('caps one section and the number of rendered workspaces', async () => {
    clearWorkspaceConventionsCache()
    const { root, home } = await fixture()
    const rows: Row[] = []
    for (let index = 0; index < CONVENTIONS_MAX_WORKSPACES + 1; index += 1) {
      const workspace = join(root, `w-${String(index)}`)
      await writeConventions(workspace, `w${String(index)}`, 'x'.repeat(CONVENTIONS_PER_WORKSPACE_MAX + 50))
      rows.push({ id: `w-${String(index).padStart(2, '0')}`, path: workspace, title: `w${String(index)}` })
    }
    const text = workspaceConventionsText(registryOf(rows), home)
    assert.equal(text.match(/superagent:conventions\n/gu)?.length, CONVENTIONS_MAX_WORKSPACES, 'only the cap renders')
    assert.match(text, /… 1 more workspace\(s\) with conventions omitted/u)
    assert.match(text, /x{999}…/u)
  })
})
