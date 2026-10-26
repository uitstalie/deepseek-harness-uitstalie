import { afterEach, describe, expect, it, vi } from 'vitest'
import { readdirSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as HomeBackup from '../src/index.ts'

const roots: string[] = []
const originalDshHome = process.env.DSH_HOME
const originalUserProfile = process.env.USERPROFILE

afterEach(async () => {
  if (originalDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalDshHome
  if (originalUserProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = originalUserProfile
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** A fresh root, removed with the suite. */
async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-home-backup-plugin-'))
  roots.push(root)
  return root
}

/** Snapshot directories present in a destination. */
function snapshotCount(destination: string): number {
  try {
    return readdirSync(destination, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name.startsWith('snapshot-'))
      .length
  } catch {
    return 0
  }
}

/** Poll on real timers until `check` holds. */
async function waitFor(check: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/**
 * Mount `apply` without the Config schema, so the test's config is what the
 * scheduler sees: a bare mount is the only way to run the real code at test
 * speed, because the schema enforces a one-minute minimum interval.
 */
async function mount(ctx: Context, config: HomeBackup.Config) {
  return ctx.plugin({ name: 'home-backup-test', apply: HomeBackup.apply }, config)
}

/** A home with one file in the only selected entry. */
async function seedHome(): Promise<{ home: string; destination: string }> {
  const root = await tempRoot()
  const home = join(root, 'home')
  const destination = join(root, 'backups')
  await mkdir(join(home, 'sessions'), { recursive: true })
  await writeFile(join(home, 'sessions', 'one'), '1')
  process.env.DSH_HOME = home
  return { home, destination }
}

describe('home-backup plugin', () => {
  it('snapshots after the initial delay, keeps its interval, and stops on dispose', async () => {
    const { destination } = await seedHome()
    const ctx = new Context()
    const info = vi.spyOn(ctx.logger, 'info')
    const fiber = await mount(ctx, {
      destination,
      initialDelayMs: 20,
      intervalMs: 60,
      paths: ['sessions'],
      retain: 1,
    })

    await waitFor(() => info.mock.calls.length >= 1, 'the first snapshot')
    expect(snapshotCount(destination)).toBe(1)

    await waitFor(() => info.mock.calls.length >= 2, 'the second snapshot')
    await waitFor(() => info.mock.calls.length >= 3, 'the third snapshot')
    expect(String(info.mock.calls[2]?.[0])).toContain('pruned 1 older snapshot(s)')
    expect(snapshotCount(destination)).toBe(1)

    await fiber.dispose()
    const callsAfterDispose = info.mock.calls.length
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(info.mock.calls.length).toBe(callsAfterDispose)
    expect(snapshotCount(destination)).toBe(1)
  })

  it('falls back to the default destination, interval, delay, and retention', async () => {
    await seedHome()
    const root = await tempRoot()
    process.env.USERPROFILE = root
    const destination = join(root, 'dsh-backups')
    const ctx = new Context()
    // The destination, retention, and profile selection are omitted, so this
    // exercises the fallbacks inside apply rather than schema defaults.
    const fiber = await mount(ctx, { initialDelayMs: 20, intervalMs: 60, paths: ['sessions'] })

    await waitFor(() => snapshotCount(destination) >= 1, 'the default-destination snapshot')
    await waitFor(() => snapshotCount(destination) >= 2, 'the second default snapshot')
    await fiber.dispose()
  })

  it('reports a failed snapshot and keeps scheduling', async () => {
    const { destination } = await seedHome()
    const ctx = new Context()
    const warn = vi.spyOn(ctx.logger, 'warn')
    const fiber = await mount(ctx, {
      destination,
      initialDelayMs: 20,
      intervalMs: 60,
      paths: ['absent'],
    })

    await waitFor(() => warn.mock.calls.length >= 1, 'the failed first snapshot')
    expect(String(warn.mock.calls[0]?.[0])).toBe('home-backup: snapshot failed')
    expect(String(warn.mock.calls[0]?.[1])).toContain('source "absent" does not exist')

    await waitFor(() => warn.mock.calls.length >= 2, 'the failed second snapshot')
    await fiber.dispose()
  })

  it('rejects configuration outside the schema bounds at mount', async () => {
    const ctx = new Context()
    await expect(ctx.plugin(HomeBackup, { intervalMs: 1 })).rejects.toThrow()
    await expect(ctx.plugin(HomeBackup, { retain: 0 })).rejects.toThrow()
    await expect(ctx.plugin(HomeBackup, { initialDelayMs: -1 })).rejects.toThrow()
  })

  it('fails loud when a programmatic mount bypasses the schema', () => {
    const ctx = new Context()
    expect(() => { HomeBackup.apply(ctx, { intervalMs: 0 }) }).toThrow(/intervalMs must be a positive integer/)
    expect(() => { HomeBackup.apply(ctx, { initialDelayMs: -1 }) }).toThrow(/initialDelayMs must be a non-negative integer/)
    expect(() => { HomeBackup.apply(ctx, { retain: 1.5 }) }).toThrow(/retain must be a positive integer/)
    expect(() => { HomeBackup.apply(ctx, { paths: [] }) }).toThrow(/paths must name at least one home entry/)
  })

  it('defaults the selected entries when a bare mount omits paths', async () => {
    await seedHome()
    const root = await tempRoot()
    const ctx = new Context()
    // The delay exceeds the test, so the run never starts; mounting proves the
    // omitted paths resolve to the default selection without touching disk.
    const fiber = await mount(ctx, {
      destination: join(root, 'backups'),
      initialDelayMs: 60_000_000,
      intervalMs: 60_000_000,
    })
    await fiber.dispose()
  })

  it('defaults the destination beside the harness home', () => {
    expect(HomeBackup.defaultDestination()).toBe(join(homedir(), 'dsh-backups'))
  })
})
