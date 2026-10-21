/**
 * Store service tests: the version-guarded `writeFile` primitive against a real
 * filesystem-backed workspace, plus its policy and path refusals.
 */
import { afterEach, beforeEach, expect, test } from 'vitest'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionPlugin from '@deepseek-ai/dsh-session-projection'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { createDshStore, type DshStore, type StoreWriteResult } from '../src/service.ts'

let project: string
let ctx: Context
let store: DshStore
let session: Session

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'dsh-store-service-'))
  // A `.git` marker makes the fixture look like a checkout, so project-root
  // discovery resolves to the fixture rather than to the temp directory above it.
  await mkdir(join(project, '.git'), { recursive: true })
  ctx = new Context()
  await ctx.plugin(LocalFileSystem, { cwd: project })
  store = createDshStore(ctx, false)
  const id = SessionId('store-service')
  session = Session.create(id, undefined, {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 0,
    isSeeded: false,
    cwd: project,
  })
})

afterEach(async () => {
  await ctx.fiber.dispose()
  await rm(project, { recursive: true, force: true })
})

/** Absolute path of one store-relative target. */
function absolute(relativePath: string): string {
  return join(project, '.dsh', ...relativePath.split('/'))
}

/** The version a write reported, which a guarded follow-up must carry. */
function versionOf(written: StoreWriteResult): string {
  if (written.version === undefined) throw new Error('writeFile did not report a version')
  return written.version
}

test('writeFile writes content and returns the store-relative path', async () => {
  const signal = new AbortController().signal
  const written = await store.writeFile(session, 'memory/sessions/MEMORY.md', 'first', { signal })
  expect(written.path).toBe('memory/sessions/MEMORY.md')
  expect(versionOf(written)).toEqual(expect.any(String))
  expect(await readFile(absolute('memory/sessions/MEMORY.md'), 'utf8')).toBe('first')
})

test('readFile returns the text and version a guarded write can expect', async () => {
  const written = await store.writeFile(session, 'memory/sessions/MEMORY.md', 'hello')
  const read = await store.readFile(session, 'memory/sessions/MEMORY.md')
  expect(read).toEqual({
    path: 'memory/sessions/MEMORY.md',
    text: 'hello',
    version: versionOf(written),
  })
})

test('readFile reports an absent or non-file target without text', async () => {
  expect(await store.readFile(session, 'memory/sessions/MEMORY.md')).toEqual({
    path: 'memory/sessions/MEMORY.md',
  })
  await store.createFolder(session, 'memory')
  expect(await store.readFile(session, 'memory')).toEqual({ path: 'memory' })
})

test('a read-only session can still read the store', async () => {
  await store.writeFile(session, 'memory/sessions/MEMORY.md', 'readable')
  await ctx.plugin(SessionProjectionPlugin)
  await ctx.plugin(SandboxPolicyService, { mode: 'read-only', workspaceRoot: project })
  const read = await store.readFile(session, 'memory/sessions/MEMORY.md')
  expect(read.text).toBe('readable')
})

test('a guarded write accepts the observed version and rejects a stale one', async () => {  const first = await store.writeFile(session, 'memory/MEMORY.md', 'first')
  const guarded = await store.writeFile(session, 'memory/MEMORY.md', 'second', { expected: versionOf(first) })
  expect(guarded.path).toBe('memory/MEMORY.md')
  expect(await readFile(absolute('memory/MEMORY.md'), 'utf8')).toBe('second')

  await expect(
    store.writeFile(session, 'memory/MEMORY.md', 'third', { expected: versionOf(first) }),
  ).rejects.toThrow()
  expect(await readFile(absolute('memory/MEMORY.md'), 'utf8')).toBe('second')
})

test('a read-only session refuses the write with the shared denial marker', async () => {
  await ctx.plugin(SessionProjectionPlugin)
  await ctx.plugin(SandboxPolicyService, { mode: 'read-only', workspaceRoot: project })
  await expect(store.writeFile(session, 'memory/MEMORY.md', 'text')).rejects.toThrow(/\[sandbox:/)
  await expect(readFile(absolute('memory/MEMORY.md'))).rejects.toThrow()
})

test('writeFile rejects the store root and a path that leaves it', async () => {
  await expect(store.writeFile(session, '', 'text')).rejects.toThrow(/refusing to write/)
  await expect(store.writeFile(session, '../outside.md', 'text')).rejects.toThrow(/path rejected/)
  await expect(readFile(join(project, 'outside.md'))).rejects.toThrow()
})
