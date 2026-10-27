/**
 * The `jira-service` real-composition test: the Loader boots the service over a temporary ledger
 * and `ctx.jira` answers from it.
 *
 * Every other jira spec drives a hand-mounted tree. This one is the proof that the service row is
 * loadable on its own — its package declares no host dependency beyond Cordis, and a composition
 * that mounts nothing but this row must still open the store, read it and report the resolved
 * identity through the service.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as jiraServicePlugin from '@deepseek-ai/dsh-jira-service'
import { asIdentity, utcTimestamp } from '@deepseek-ai/dsh-jira-core/entity.ts'
import { createStore, createInStore, storePaths } from '@deepseek-ai/dsh-jira-core/store.ts'
import { writeTextAtomic } from '@deepseek-ai/dsh-jira-core/io.ts'

const MACHINE = 'a1b2c3d4'

// Booting the real Loader and opening a ledger costs seconds on a busy host (measured ~4.5 s in an
// aggregate run). This file carries the composition budget; the coverage lane in CI already gives
// every suite 90 s for the same reason, and the unit default is a budget artifact here (DH-307).
vi.setConfig({ testTimeout: 30_000 })

const FIXTURE_IDENTITY = (() => {
  const identity = asIdentity('human:fixture')
  if (identity === undefined) throw new Error('unreachable')
  return identity
})()

/** The vocabulary fixture `jira-core` ships; the ledger is only meaningful with one. */
const configFixture = async (): Promise<string> =>
  readFile(new URL('../../jira-core/fixtures/config.md', import.meta.url), 'utf8')

/** A ledger with one issue and one commit behind it. */
const createLedger = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-jira-service-'))
  await writeTextAtomic(storePaths.config(root), await configFixture())
  const store = createStore({ root, machineId: MACHINE })
  const created = await createInStore(store, 'DH', {
    by: FIXTURE_IDENTITY,
    at: utcTimestamp(new Date('2026-10-15T12:00:00Z')),
  }, { issueType: 'task', summary: 'boot proof' })
  if (!created.ok) throw new Error(JSON.stringify(created.error))
  return root
}

let context: Context | undefined
let ledger: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (ledger !== undefined) await rm(ledger, { recursive: true, force: true })
  ledger = undefined
})

describe('jira-service real Loader composition', () => {
  it('opens the temporary ledger and answers ctx.jira over it', async () => {
    ledger = await createLedger()
    const fixture = await readFile(new URL('./fixtures/cordis.yml', import.meta.url), 'utf8')
    const configPath = join(ledger, 'cordis.test.yml')
    await writeFile(configPath, fixture.replace('{{ledgerRoot}}', ledger.replaceAll('\\', '/')))

    const ctx = context = new Context()
    ctx.baseUrl = `${pathToFileURL(ledger).href}/`
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-jira-service', jiraServicePlugin],
    ])
    // The fixture lives in a temporary ledger, so its bare plugin name cannot resolve through
    // Node's own lookup there. Only `import` is replaced; the remaining members satisfy the
    // interface and throw if the Loader ever reaches them on this path.
    const internal: NonNullable<typeof ctx.loader.internal> = {
      version: 'v2',
      loadCache: new Map(),
      register: () => {},
      getOrCreateModuleJob: () => Promise.reject(new Error('the test composition never creates a module job')),
      resolveSync: () => { throw new Error('the test composition never resolves synchronously') },
      load: () => Promise.reject(new Error('the test composition never loads a module body')),
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`Unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    }
    ctx.loader.internal = internal
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()

    const status = ctx.jira.status()
    // The row names the root with forward slashes (the fixture is YAML), and the service reports
    // the resolved spelling rather than re-normalizing it.
    expect(status.root.replaceAll('\\', '/')).toBe(ledger.replaceAll('\\', '/'))
    expect(status.pushEnabled).toBe(false)
    expect(status.pending).toBe(false)

    const read = await ctx.jira.get('DH-1' as never)
    expect(read.ok).toBe(true)
    if (!read.ok) throw new Error(JSON.stringify(read.error))
    expect(read.value.summary).toBe('boot proof')
    expect(ctx.jira.status().machineId).toBe(MACHINE)

    const listed = await ctx.jira.list({})
    expect(listed.ok).toBe(true)
    if (!listed.ok) throw new Error(JSON.stringify(listed.error))
    expect(listed.value.items.map(item => item.key)).toEqual(['DH-1'])

    const board = await ctx.jira.board()
    expect(board.ok).toBe(true)
  })
})
