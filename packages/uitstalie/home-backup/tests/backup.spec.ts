import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MANIFEST_FILENAME, runBackup, snapshotName, type BackupRequest, type BackupSelection } from '../src/backup.ts'

const roots: string[] = []

/** A fresh root that the suite removes afterwards. */
async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-home-backup-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

interface Fixture {
  home: string
  destination: string
}

/** A home with two selected entries, one profile with config plus node_modules, and credentials. */
async function makeFixture(): Promise<Fixture> {
  const root = await tempRoot()
  const home = join(root, 'home')
  const destination = join(root, 'backups')
  await mkdir(join(home, 'sessions', '--ws--', 'session-a'), { recursive: true })
  await writeFile(join(home, 'sessions', '--ws--', 'session-a', 'session.v4.jsonl.zstd'), 'session-bytes')
  await mkdir(join(home, 'storages'), { recursive: true })
  await writeFile(join(home, 'storages', 'workspace.json'), '{"workspaces":[]}')
  await mkdir(join(home, 'profiles', 'web', 'node_modules', 'dep'), { recursive: true })
  await writeFile(join(home, 'profiles', 'web', 'package.json'), '{"name":"profile"}')
  await writeFile(join(home, 'profiles', 'web', 'cordis.patch.yml'), '- id: ui\n')
  await writeFile(join(home, 'profiles', 'web', 'node_modules', 'dep', 'index.js'), 'ignored')
  await mkdir(join(home, 'profiles', '.staging-x'), { recursive: true })
  await mkdir(join(home, 'profiles', 'empty-profile'), { recursive: true })
  await writeFile(join(home, 'profiles', 'notes.txt'), '')
  await writeFile(join(home, '.credentials.yaml'), 'token: secret\n')
  return { home, destination }
}

/** One request over a fixture, with only the interesting fields overridden. */
function makeRequest(fx: Fixture, at: Date, selection: Partial<BackupSelection> = {}, retain = 24): BackupRequest {
  return {
    home: fx.home,
    destination: fx.destination,
    retain,
    selection: {
      paths: ['sessions', 'storages'],
      profileConfig: true,
      credentials: false,
      ...selection,
    },
    now: () => at,
  }
}

/** Snapshot directory names in a destination, oldest first. */
async function snapshotNamesIn(destination: string): Promise<string[]> {
  const entries = await readdir(destination, { withFileTypes: true })
  return entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
}

const AT = new Date('2026-10-26T08:16:37.123Z')

describe('runBackup', () => {
  it('copies the selected entries and profile config without credentials or node_modules', async () => {
    const fx = await makeFixture()
    const result = await runBackup(makeRequest(fx, AT))

    expect(result.snapshot.name).toBe('snapshot-2026-10-26T08-16-37-123Z')
    expect(result.pruned).toEqual([])
    const session = join(result.snapshot.directory, 'sessions', '--ws--', 'session-a', 'session.v4.jsonl.zstd')
    expect(await readFile(session, 'utf8')).toBe('session-bytes')
    expect(await readFile(join(result.snapshot.directory, 'storages', 'workspace.json'), 'utf8')).toBe('{"workspaces":[]}')
    expect(await readFile(join(result.snapshot.directory, 'profiles', 'web', 'package.json'), 'utf8')).toBe('{"name":"profile"}')
    await expect(stat(join(result.snapshot.directory, 'profiles', 'web', 'node_modules'))).rejects.toThrow()
    await expect(stat(join(result.snapshot.directory, 'profiles', '.staging-x'))).rejects.toThrow()
    await expect(stat(join(result.snapshot.directory, '.credentials.yaml'))).rejects.toThrow()

    const manifest = JSON.parse(await readFile(join(result.snapshot.directory, MANIFEST_FILENAME), 'utf8')) as {
      format: number
      name: string
      createdAt: string
      home: string
      credentials: boolean
      entries: { path: string; files: number; bytes: number }[]
    }
    expect(manifest.format).toBe(1)
    expect(manifest.name).toBe(result.snapshot.name)
    expect(manifest.createdAt).toBe(AT.toISOString())
    expect(manifest.home).toBe(fx.home)
    expect(manifest.credentials).toBe(false)
    expect(manifest.entries.map(entry => entry.path)).toEqual(['sessions', 'storages'])
    expect(manifest.entries[0]?.files).toBe(1)
    expect(manifest.entries[0]?.bytes).toBe('session-bytes'.length)

    // Two profile files plus the manifest join the two selected files.
    expect(result.snapshot.files).toBe(5)
  })

  it('includes the credentials file when the selection opts in', async () => {
    const fx = await makeFixture()
    const result = await runBackup(makeRequest(fx, AT, { credentials: true }))
    expect(await readFile(join(result.snapshot.directory, '.credentials.yaml'), 'utf8')).toBe('token: secret\n')
  })

  it('omits credentials when the selection opts in but the home has none', async () => {
    const fx = await makeFixture()
    await rm(join(fx.home, '.credentials.yaml'))
    const result = await runBackup(makeRequest(fx, AT, { credentials: true }))
    await expect(stat(join(result.snapshot.directory, '.credentials.yaml'))).rejects.toThrow()
    expect(result.snapshot.files).toBe(5)
  })

  it('tolerates a home without a profiles directory', async () => {
    const root = await tempRoot()
    const home = join(root, 'home')
    const destination = join(root, 'backups')
    await mkdir(join(home, 'sessions'), { recursive: true })
    await writeFile(join(home, 'sessions', 'stale'), '')
    const result = await runBackup({
      home,
      destination,
      retain: 1,
      selection: { paths: ['sessions'], profileConfig: true, credentials: false },
      now: () => AT,
    })
    await expect(stat(join(result.snapshot.directory, 'profiles'))).rejects.toThrow()
    expect(result.snapshot.files).toBe(2)
  })

  it('skips profile configuration when the selection excludes it', async () => {
    const fx = await makeFixture()
    const result = await runBackup(makeRequest(fx, AT, { profileConfig: false }))
    await expect(stat(join(result.snapshot.directory, 'profiles'))).rejects.toThrow()
    expect(await readFile(join(result.snapshot.directory, 'sessions', '--ws--', 'session-a', 'session.v4.jsonl.zstd'), 'utf8')).toBe('session-bytes')
    expect(result.snapshot.files).toBe(3)
  })

  it('leaves destination entries that are not snapshots alone', async () => {
    const fx = await makeFixture()
    await mkdir(join(fx.destination, 'other'), { recursive: true })
    await writeFile(join(fx.destination, 'note.txt'), '')
    const result = await runBackup(makeRequest(fx, AT))
    expect(result.pruned).toEqual([])
    expect((await readdir(fx.destination)).sort()).toEqual(['note.txt', 'other', result.snapshot.name])
  })

  it('keeps the newest snapshots and reports the removed ones', async () => {
    const fx = await makeFixture()
    const first = new Date('2026-10-26T08:00:00.000Z')
    const second = new Date('2026-10-26T08:10:00.000Z')
    const third = new Date('2026-10-26T08:20:00.000Z')
    await runBackup(makeRequest(fx, first, {}, 2))
    await runBackup(makeRequest(fx, second, {}, 2))
    const result = await runBackup(makeRequest(fx, third, {}, 2))

    expect(result.pruned).toEqual([snapshotName(first)])
    expect(await snapshotNamesIn(fx.destination)).toEqual([snapshotName(second), snapshotName(third)])
  })

  it('rejects a configured entry that does not exist and leaves no staging directory', async () => {
    const fx = await makeFixture()
    await expect(runBackup(makeRequest(fx, AT, { paths: ['sessions', 'absent'] })))
      .rejects.toThrow(/source "absent" does not exist/)
    expect(await readdir(fx.destination)).toEqual([])
  })

  it('propagates a filesystem failure that is not absence', async () => {
    const fx = await makeFixture()
    // An embedded NUL makes the path argument invalid, which `stat` rejects
    // with a code other than ENOENT; the probe must not read that as absence.
    await expect(runBackup(makeRequest(fx, AT, { paths: ['bad\u0000name'] }))).rejects.toThrow()
  })

  it('rejects a retain value that would delete the snapshot it just wrote', async () => {
    const fx = await makeFixture()
    await expect(runBackup(makeRequest(fx, AT, {}, 0))).rejects.toThrow(/retain must be a positive integer/)
    await expect(runBackup(makeRequest(fx, AT, {}, 2.5))).rejects.toThrow(/retain must be a positive integer/)
  })

  it('cleans its staging directory when the destination already holds the same snapshot', async () => {
    const fx = await makeFixture()
    await mkdir(join(fx.destination, snapshotName(AT)), { recursive: true })
    await expect(runBackup(makeRequest(fx, AT))).rejects.toThrow()
    expect(await snapshotNamesIn(fx.destination)).toEqual([snapshotName(AT)])
  })
})
