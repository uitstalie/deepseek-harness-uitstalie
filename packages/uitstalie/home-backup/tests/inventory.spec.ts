import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { MANIFEST_FILENAME, readLatestSnapshotInventory, runBackup } from '../src/backup.ts'
import * as HomeBackup from '../src/api.ts'

const roots: string[] = []
const originalDshHome = process.env.DSH_HOME

afterEach(async () => {
  if (originalDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalDshHome
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** A fresh root removed with the suite. */
async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-home-backup-inventory-'))
  roots.push(root)
  return root
}

/** A home with two covered entries and two entries the selection never copies. */
async function seededHome(): Promise<{ home: string; destination: string }> {
  const root = await tempRoot()
  const home = join(root, 'home')
  const destination = join(root, 'backups')
  await mkdir(join(home, 'sessions'), { recursive: true })
  await writeFile(join(home, 'sessions', 'one'), '1')
  await mkdir(join(home, 'storages'), { recursive: true })
  await writeFile(join(home, 'storages', 'workspace.json'), '{}')
  await mkdir(join(home, 'memory'), { recursive: true })
  await writeFile(join(home, 'memory', 'GLOBAL.md'), 'remembered')
  await mkdir(join(home, 'attachments'), { recursive: true })
  return { home, destination }
}

describe('home inventory', () => {
  it('records every top-level entry and marks the uncovered ones', async () => {
    const { home, destination } = await seededHome()
    const result = await runBackup({
      home, destination, retain: 4,
      selection: { paths: ['sessions', 'storages'], profileConfig: true, credentials: false },
      now: () => new Date('2026-11-20T08:00:00.000Z'),
    })
    const manifest: unknown = JSON.parse(await readFile(join(result.snapshot.directory, MANIFEST_FILENAME), 'utf8'))
    const inventory = (manifest as { inventory: { name: string; covered: boolean }[] }).inventory
    expect(inventory).toEqual([
      { name: 'attachments', covered: false },
      { name: 'memory', covered: false },
      { name: 'sessions', covered: true },
      { name: 'storages', covered: true },
    ])
    await expect(readLatestSnapshotInventory(destination)).resolves.toEqual(inventory)
  })

  it('reads undefined for a destination without snapshots', async () => {
    const root = await tempRoot()
    await expect(readLatestSnapshotInventory(join(root, 'absent'))).resolves.toBeUndefined()
  })

  it('warns at mount when an entry recorded by the newest snapshot disappeared', async () => {
    const { home, destination } = await seededHome()
    await runBackup({
      home, destination, retain: 4,
      selection: { paths: ['sessions', 'storages'], profileConfig: true, credentials: false },
      now: () => new Date('2026-11-20T08:00:00.000Z'),
    })
    process.env.DSH_HOME = home
    await rm(join(home, 'memory'), { recursive: true, force: true })
    const ctx = new Context()
    const warn = vi.spyOn(ctx.logger, 'warn')
    const fiber = await ctx.plugin({ name: 'home-backup-inventory-test', apply: HomeBackup.apply }, {
      destination, initialDelayMs: 60_000, intervalMs: 60_000, paths: ['sessions'], retain: 1,
    })
    await vi.waitFor(() => { expect(warn.mock.calls.length).toBeGreaterThan(0) })
    const message = String(warn.mock.calls[0]?.[0])
    expect(message).toContain('entries disappeared since the newest snapshot: memory')
    expect(message).toContain('cannot be restored')
    await fiber.dispose()
  })
})
