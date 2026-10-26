/**
 * The filesystem work behind `home-backup`: one snapshot of selected harness
 * home entries, the manifest that describes it, and retention of older
 * snapshots. The module owns no timer and no Cordis context, so the caller
 * decides when a snapshot runs.
 *
 * @module @deepseek-ai/dsh-home-backup/backup
 */

import { cp, lstat, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Prefix of every snapshot directory this package writes. */
export const SNAPSHOT_PREFIX = 'snapshot-'

/** Manifest file name inside a snapshot; it is not part of the copied home. */
export const MANIFEST_FILENAME = 'manifest.json'

/** Profile files copied when {@link BackupSelection.profileConfig} is set. */
export const PROFILE_CONFIG_FILES = Object.freeze(['package.json', 'pnpm-workspace.yaml', 'cordis.yml', 'cordis.patch.yml'])

/** The credentials file copied when {@link BackupSelection.credentials} is set. */
export const CREDENTIALS_FILENAME = '.credentials.yaml'

/** What a snapshot takes from the harness home. */
export interface BackupSelection {
  /** Home-relative paths copied whole, in the order recorded in the manifest. */
  readonly paths: readonly string[]
  /** Whether each `profiles/<name>` directory contributes {@link PROFILE_CONFIG_FILES}. */
  readonly profileConfig: boolean
  /** Whether {@link CREDENTIALS_FILENAME} is part of the snapshot. */
  readonly credentials: boolean
}

/** The inputs of one snapshot. */
export interface BackupRequest {
  /** Absolute harness home the snapshot reads. */
  readonly home: string
  /** Absolute directory that holds the snapshots. */
  readonly destination: string
  /** Snapshots kept after the run, including the new one. */
  readonly retain: number
  /** What to copy. */
  readonly selection: BackupSelection
  /** Clock for the snapshot name and the manifest timestamp. */
  readonly now: () => Date
}

/** One copied tree's accounting, recorded per manifest entry. */
export interface EntrySize {
  /** Home-relative path the entry was copied from. */
  readonly path: string
  /** Files below the copied entry. */
  readonly files: number
  /** Bytes below the copied entry. */
  readonly bytes: number
}

/** One completed snapshot. */
export interface BackupSnapshot {
  /** Directory name inside the destination. */
  readonly name: string
  /** Absolute snapshot directory. */
  readonly directory: string
  /** Files in the finished snapshot, including the manifest. */
  readonly files: number
  /** Bytes in the finished snapshot, including the manifest. */
  readonly bytes: number
}

/** One finished run: the new snapshot and the older snapshots it removed. */
export interface BackupResult {
  /** The snapshot this run wrote. */
  readonly snapshot: BackupSnapshot
  /** Snapshot directory names removed by retention, oldest first. */
  readonly pruned: readonly string[]
}

/** Running totals for one directory tree. */
interface TreeSize {
  files: number
  bytes: number
}

/** Whether a path exists; any failure other than absence propagates. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/**
 * Sum the entries and bytes below one directory.
 *
 * Sizes come from `lstat`, so a symbolic link counts as the link entry the
 * snapshot copied rather than the target it points at.
 */
async function measureTree(root: string): Promise<TreeSize> {
  const total: TreeSize = { files: 0, bytes: 0 }
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      const nested = await measureTree(path)
      total.files += nested.files
      total.bytes += nested.bytes
      continue
    }
    const info = await lstat(path)
    total.files += 1
    total.bytes += info.size
  }
  return total
}

/**
 * Snapshot directory name for one instant.
 * @param at - the instant the snapshot is named after.
 * @returns `snapshot-` followed by the UTC ISO timestamp with `:` and `.`
 *   replaced by `-`, so the name is a valid directory name on every platform
 *   and sorts chronologically.
 */
export function snapshotName(at: Date): string {
  return `${SNAPSHOT_PREFIX}${at.toISOString().replace(/[:.]/gu, '-')}`
}

/** Snapshot directory names already present, oldest first. */
async function snapshotNames(destination: string): Promise<string[]> {
  const names: string[] = []
  for (const entry of await readdir(destination, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith(SNAPSHOT_PREFIX)) names.push(entry.name)
  }
  return names.sort()
}

/**
 * Remove every snapshot beyond the retained count.
 * @param destination - the directory holding snapshots.
 * @param retain - how many newest snapshots to keep.
 * @returns the removed snapshot directory names, oldest first.
 */
async function pruneSnapshots(destination: string, retain: number): Promise<string[]> {
  const names = await snapshotNames(destination)
  const excess = names.slice(0, Math.max(0, names.length - retain))
  for (const name of excess) await rm(join(destination, name), { recursive: true, force: true })
  return excess
}

/**
 * Copy the profile configuration files of every profile directory.
 *
 * A missing `profiles` directory means the home never booted a profile, which
 * is a legitimate empty result; a profile directory without one of the known
 * files simply contributes the files it has.
 */
async function copyProfileConfig(home: string, staging: string): Promise<void> {
  const profiles = join(home, 'profiles')
  if (!await exists(profiles)) return
  for (const entry of await readdir(profiles, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    for (const file of PROFILE_CONFIG_FILES) {
      const source = join(profiles, entry.name, file)
      if (!await exists(source)) continue
      const target = join(staging, 'profiles', entry.name, file)
      await mkdir(dirname(target), { recursive: true })
      await cp(source, target, { force: false, errorOnExist: true, preserveTimestamps: true })
    }
  }
}

/** Copy the credentials file when the caller opted in and the home has one. */
async function copyCredentials(home: string, staging: string): Promise<void> {
  const source = join(home, CREDENTIALS_FILENAME)
  if (!await exists(source)) return
  await cp(source, join(staging, CREDENTIALS_FILENAME), { force: false, errorOnExist: true, preserveTimestamps: true })
}

/**
 * Write one snapshot of the selected home entries and apply retention.
 *
 * The snapshot is assembled in a sibling staging directory and renamed into
 * place, so a destination never exposes a partly written snapshot; a failed
 * run removes its staging directory and leaves earlier snapshots untouched.
 *
 * @param request - the home, destination, selection, retention, and clock.
 * @returns the new snapshot and the names retention removed.
 * @throws when the selection names a missing home entry, a copy fails, or
 *   `retain` is not a positive integer; the staging directory is removed first.
 */
export async function runBackup(request: BackupRequest): Promise<BackupResult> {
  if (!Number.isInteger(request.retain) || request.retain < 1) {
    throw new Error(`home-backup: retain must be a positive integer, received ${String(request.retain)}`)
  }
  const at = request.now()
  const name = snapshotName(at)
  const directory = join(request.destination, name)
  const staging = join(request.destination, `.${name}.staging`)
  await mkdir(request.destination, { recursive: true })
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  try {
    const entries: EntrySize[] = []
    for (const relative of request.selection.paths) {
      const source = join(request.home, relative)
      if (!await exists(source)) {
        throw new Error(`home-backup: source ${JSON.stringify(relative)} does not exist under the harness home; fix the paths configuration or create the directory`)
      }
      await cp(source, join(staging, relative), { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true })
      entries.push({ path: relative, ...await measureTree(join(staging, relative)) })
    }
    if (request.selection.profileConfig) await copyProfileConfig(request.home, staging)
    if (request.selection.credentials) await copyCredentials(request.home, staging)
    const manifest = {
      format: 1,
      name,
      createdAt: at.toISOString(),
      home: request.home,
      credentials: request.selection.credentials,
      entries,
    }
    await writeFile(join(staging, MANIFEST_FILENAME), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    const size = await measureTree(staging)
    await rename(staging, directory)
    const pruned = await pruneSnapshots(request.destination, request.retain)
    return { snapshot: { name, directory, ...size }, pruned }
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
}
