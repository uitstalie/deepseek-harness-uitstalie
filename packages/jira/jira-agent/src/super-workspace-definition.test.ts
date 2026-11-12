/**
 * Tests for the managed `AGENTS.md` section: versioned replacement, untouched user text, one-time
 * visible notices, and the zero-write steady state.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, it } from 'node:test'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { SUPERAGENT_SECTION } from './superagent.ts'
import {
  appendSuperWorkspaceDefinitionNotice,
  MANAGED_SECTION_VERSION,
  managedSectionBody,
  renderManagedSection,
  superWorkspaceDefinitionPath,
  superWorkspaceDefinitionStatePath,
  syncSuperWorkspaceDefinition,
  takeSuperWorkspaceDefinitionNotice,
  type SuperWorkspaceDefinitionIo,
} from './super-workspace-definition.ts'

/** Roots created by this file, removed once the run settles. */
const roots: string[] = []

after(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** One scratch workspace plus a counting read/write seam. */
interface Fixture {
  readonly root: string
  readonly writes: string[]
  readonly io: SuperWorkspaceDefinitionIo
}

/** Create a scratch super workspace with an IO seam that records every write path. */
const fixture = async (): Promise<Fixture> => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-agents-md-'))
  roots.push(root)
  const writes: string[] = []
  const io: SuperWorkspaceDefinitionIo = {
    async read(path: string): Promise<string | undefined> {
      try {
        return await readFile(path, 'utf8')
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      }
    },
    async write(path: string, text: string): Promise<void> {
      writes.push(path)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, text, 'utf8')
    },
  }
  return { root, writes, io }
}

/** The definition file path inside one fixture. */
const agentsPath = (f: Fixture): string => superWorkspaceDefinitionPath(f.root)

/** The state file path inside one fixture. */
const statePath = (f: Fixture): string => superWorkspaceDefinitionStatePath(f.root)

/** sha256 in the form the synchronizer stores. */
const hash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

/** The number of writes the fixture made to the definition file. */
const definitionWrites = (f: Fixture): number => f.writes.filter(path => path === agentsPath(f)).length

void describe('superagent: managed AGENTS.md section', () => {
  void it('creates the title and managed block once, then stops writing', async () => {
    const f = await fixture()
    const created = await syncSuperWorkspaceDefinition(f.root, f.io)
    assert.equal(created.kind, 'created')
    assert.equal(
      await readFile(agentsPath(f), 'utf8'),
      `# Super agent workspace\n\n${renderManagedSection()}\n`,
    )
    assert.equal(definitionWrites(f), 1)
    assert.equal(await takeSuperWorkspaceDefinitionNotice(f.root, f.io), undefined, 'creation needs no notice')

    f.writes.length = 0
    const again = await syncSuperWorkspaceDefinition(f.root, f.io)
    assert.equal(again.kind, 'unchanged')
    assert.deepEqual(f.writes, [], 'an unchanged definition performs no write at all')
  })

  void it('appends a managed block to a pre-marker file, keeps its text, and notices once', async () => {
    const f = await fixture()
    const original = '# My notes\n\nhand-written rules\n'
    await writeFile(agentsPath(f), original, 'utf8')

    const result = await syncSuperWorkspaceDefinition(f.root, f.io)
    assert.equal(result.kind, 'appended')
    assert.match(result.notice, /hand-written content was preserved/u)
    const text = await readFile(agentsPath(f), 'utf8')
    assert.equal(text.startsWith(original), true, 'the person\'s text is preserved byte for byte')
    assert.match(text, /<!-- superagent:managed begin v=1 -->/u)

    const notice = await takeSuperWorkspaceDefinitionNotice(f.root, f.io)
    assert.equal(notice, result.notice, 'the append notice is kept until a Session takes it')
    assert.equal(await takeSuperWorkspaceDefinitionNotice(f.root, f.io), undefined, 'the notice is shown once')

    f.writes.length = 0
    const again = await syncSuperWorkspaceDefinition(f.root, f.io)
    assert.equal(again.kind, 'unchanged')
    assert.deepEqual(f.writes, [], 'the appended file is stable')
  })

  void it('upgrades only the managed block and leaves everything outside it alone', async () => {
    const f = await fixture()
    const prefix = '# Notes\n\nkeep this\n\n'
    const suffix = '\n\nTRAILER stays here\n'
    const oldBody = 'old v0 rules'
    const oldBlock = renderManagedSection(0, oldBody)
    await writeFile(agentsPath(f), `${prefix}${oldBlock}${suffix}`, 'utf8')
    await mkdir(dirname(statePath(f)), { recursive: true })
    await writeFile(statePath(f), JSON.stringify({ writtenVersion: 0, writtenHash: hash(oldBody) }), 'utf8')

    const result = await syncSuperWorkspaceDefinition(f.root, f.io)
    assert.equal(result.kind, 'upgraded')
    assert.deepEqual([result.from, result.to], [0, MANAGED_SECTION_VERSION])
    const text = await readFile(agentsPath(f), 'utf8')
    assert.equal(text, `${prefix}${renderManagedSection()}${suffix}`, 'outside text and both separators survive')
    assert.match(managedSectionBody(), /Registry discipline/u)
  })

  void it('refuses to overwrite a locally edited block and notices exactly once', async () => {
    const f = await fixture()
    await syncSuperWorkspaceDefinition(f.root, f.io)
    const created = await readFile(agentsPath(f), 'utf8')
    const edited = created.replace(managedSectionBody(), `${managedSectionBody()}\nLOCAL EDIT`)
    assert.notEqual(edited, created)
    await writeFile(agentsPath(f), edited, 'utf8')

    f.writes.length = 0
    const first = await syncSuperWorkspaceDefinition(f.root, f.io)
    assert.equal(first.kind, 'conflict')
    assert.match(first.notice ?? '', /local edits/u)
    assert.equal(await readFile(agentsPath(f), 'utf8'), edited, 'the edited block is not overwritten')
    assert.equal(definitionWrites(f), 0, 'only the state file may change')
    assert.equal(await takeSuperWorkspaceDefinitionNotice(f.root, f.io), first.notice)

    f.writes.length = 0
    const second = await syncSuperWorkspaceDefinition(f.root, f.io)
    assert.equal(second.kind, 'conflict')
    assert.equal(second.notice, undefined, 'the same edit is not reported again')
    assert.deepEqual(f.writes, [], 'an already-notified conflict writes nothing')
  })

  void it('reports damaged markers instead of appending a second block', async () => {
    const f = await fixture()
    const damaged = '# Notes\n<!-- superagent:managed begin v=1 -->\nno end marker\n'
    await writeFile(agentsPath(f), damaged, 'utf8')
    const result = await syncSuperWorkspaceDefinition(f.root, f.io)
    assert.equal(result.kind, 'conflict')
    assert.match(result.notice ?? '', /damaged/u)
    assert.equal(await readFile(agentsPath(f), 'utf8'), damaged)
  })

  void it('serializes concurrent triggers into one creation', async () => {
    const f = await fixture()
    const results = await Promise.all([
      syncSuperWorkspaceDefinition(f.root, f.io),
      syncSuperWorkspaceDefinition(f.root, f.io),
    ])
    assert.deepEqual(results.map(result => result.kind).sort(), ['created', 'unchanged'])
    const text = await readFile(agentsPath(f), 'utf8')
    assert.equal(text.match(/<!-- superagent:managed begin/gu)?.length, 1, 'one managed block')
  })

  void it('appends the notice as a visible synthetic user message', () => {
    const appended: { type: string; message: UserMessage; options: { surfaceOp: string } }[] = []
    const session = {
      append(type: string, message: UserMessage, options: { surfaceOp: string }) {
        appended.push({ type, message, options })
        return { seq: 1 }
      },
    }
    assert.equal(appendSuperWorkspaceDefinitionNotice(session, 'the full notice text'), true)
    const [record] = appended
    assert.ok(record !== undefined)
    assert.equal(record.type, 'user/message')
    assert.equal(record.options.surfaceOp, 'append')
    assert.equal(record.message.role, 'user')
    assert.equal(record.message.source.kind, 'jira-agent')
    assert.equal(record.message.source.form, 'notice')
    const [block] = record.message.content
    assert.ok(block !== undefined)
    assert.equal(block.type, 'text')
    assert.equal(block.text, 'the full notice text')
    assert.equal(appendSuperWorkspaceDefinitionNotice({}, 'no surface'), false)
  })
})

void describe('superagent: the registry-discipline prompt rule', () => {
  void it('keeps the write-order rule in the static section', () => {
    const text = String(SUPERAGENT_SECTION.text)
    assert.match(text, /`ensure`, `rename_workspace` and `remove_workspace` are writes/u)
    assert.match(text, /`roster` first/u)
    assert.match(text, /person already made in the UI wins/u)
    assert.match(text, /not harmless because it is idempotent/u)
  })
})
