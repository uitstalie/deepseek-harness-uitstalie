/**
 * The store atom's real Loader composition: the row mounts over a filesystem and serves `ctx.dshStore`
 * on its own. No instruction provider, tool, or model surface is in the tree — which is the point
 * (DH-309): the atom owns `.dsh` storage, and the instructions loader is a consumer of its rules
 * scan rather than a dependency of storage.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as FsLocalPlugin from '@deepseek-ai/dsh-fs-local'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import * as StoreAtomPlugin from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  vi.unstubAllEnvs()
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Boot a composition holding the filesystem and this atom, and nothing else. */
const boot = async (project: string, home: string): Promise<Context> => {
  const configPath = join(root ?? project, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-fs-local'",
    '  config:',
    `    cwd: '${project.replaceAll('\\', '/')}'`,
    "- name: '@deepseek-ai/dsh-store-atom'",
    '',
  ].join('\n'), 'utf8')
  vi.stubEnv('DSH_HOME', home)
  const ctx = context = new Context()
  ctx.baseUrl = `${pathToFileURL(project).href}/`
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-fs-local', FsLocalPlugin],
    ['@deepseek-ai/dsh-store-atom', StoreAtomPlugin],
  ])
  ctx.loader.internal = {
    version: 'v2',
    loadCache: new Map(),
    async import(specifier: string) {
      const module = modules.get(specifier)
      if (module === undefined) throw new Error(`Unexpected Loader import: ${specifier}`)
      return module
    },
    register: () => {},
    getOrCreateModuleJob: () => Promise.reject(new Error('the composition never creates a module job')),
    resolveSync: () => { throw new Error('the composition never resolves synchronously') },
    load: () => Promise.reject(new Error('the composition never loads a module body')),
  }
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

describe('store atom: minimal composition (DH-309)', () => {
  it('provides workspace and global storage without an instruction provider mounted', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-store-compose-'))
    const project = join(root, 'project')
    const home = join(root, 'home')
    await mkdir(join(project, '.git'), { recursive: true })
    await mkdir(home, { recursive: true })
    const ctx = await boot(project, home)
    expect(ctx.dshStore).toBeDefined()

    const id = SessionId('store-composition')
    const session = Session.create(id, undefined, {
      version: SESSION_FORMAT_VERSION,
      id,
      createdAt: 0,
      isSeeded: false,
      cwd: project,
    })

    const written = await ctx.dshStore.writeFile(session, 'memory/sessions/MEMORY.md', 'workspace body')
    const read = await ctx.dshStore.readFile(session, 'memory/sessions/MEMORY.md')
    expect(read).toEqual({ path: 'memory/sessions/MEMORY.md', text: 'workspace body', version: written.version })
    expect(await readFile(join(project, '.dsh', 'memory', 'sessions', 'MEMORY.md'), 'utf8')).toBe('workspace body')

    // The rules authoring check is the atom's own scan: the second file duplicates the first.
    await ctx.dshStore.createFile(session, 'rules/a.md', 'shared rule text')
    await expect(ctx.dshStore.createFile(session, 'rules/b.md', '  shared rule text '))
      .rejects.toThrow(/duplicate rule/u)

    // Global storage resolves through $DSH_HOME and needs no session.
    await ctx.dshStore.writeFile(undefined, 'personality/PERSONALITY.md', 'global body', { scope: 'global' })
    expect(await readFile(join(home, 'personality', 'PERSONALITY.md'), 'utf8')).toBe('global body')
  }, 30_000)
})
