/** Seed and observe a Harness home so a disappearing entry is caught with the deleting time and processes. */

import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, watch, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDshHome } from '../../../packages/util/home-paths/src/index.ts'
import { parseArgs } from 'node:util'
import { assertScratchHome, createScratchHome, removeScratchHome } from './scratch-home.ts'

/** Home entries a real Harness home carried, with what each one holds in this canary. */
const REPRESENTATIVE_ENTRIES: ReadonlyArray<{ name: string; kind: 'dir' | 'file'; nested?: readonly string[] }> = [
  { name: '.anonymous-user-id', kind: 'file' },
  { name: '.credentials.yaml', kind: 'file' },
  { name: 'attachments', kind: 'dir', nested: ['canary.txt'] },
  { name: 'cache', kind: 'dir', nested: ['canary.txt'] },
  { name: 'dsh-runtimes', kind: 'dir', nested: ['canary.txt'] },
  { name: 'llm-deepseek', kind: 'dir', nested: ['canary.txt'] },
  { name: 'logs', kind: 'dir', nested: ['canary.txt'] },
  { name: 'memory', kind: 'dir', nested: ['canary.txt'] },
  { name: 'personality', kind: 'dir', nested: ['canary.txt'] },
  { name: 'profiles', kind: 'dir', nested: ['canary/profile.json', 'desktop/package.json'] },
  { name: 'sessions', kind: 'dir', nested: ['canary/canary.txt'] },
  { name: 'storages', kind: 'dir', nested: ['canary.txt'] },
  { name: 'workspaces', kind: 'dir', nested: ['canary/canary.txt'] },
]

/** One recorded top-level entry and its size. */
export interface InventoryEntry {
  /** Entry name directly below the home. */
  readonly name: string
  /** Whether the entry was a directory. */
  readonly directory: boolean
  /** Files below the entry; `1` for a file. */
  readonly files: number
  /** Bytes below the entry. */
  readonly bytes: number
}

/**
 * Measure one home entry.
 * @param path - absolute entry path.
 * @returns its file and byte totals.
 */
function measure(path: string): { files: number; bytes: number } {
  const info = statSync(path, { throwIfNoEntry: false })
  if (info === undefined) return { files: 0, bytes: 0 }
  if (!info.isDirectory()) return { files: 1, bytes: info.size }
  let files = 0
  let bytes = 0
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const nested = measure(join(path, entry.name))
    files += nested.files
    bytes += nested.bytes
  }
  return { files, bytes }
}

/**
 * Read the direct children of a home.
 * @param home - absolute harness home.
 * @returns one inventory entry per child, sorted by name.
 */
export function readInventory(home: string): InventoryEntry[] {
  const entries: InventoryEntry[] = []
  for (const entry of readdirSync(home, { withFileTypes: true })) {
    const path = join(home, entry.name)
    entries.push({ name: entry.name, directory: entry.isDirectory(), ...measure(path) })
  }
  return entries.sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * Seed a scratch home with the top-level entries a real Harness home carries.
 * @param home - scratch home returned by `createScratchHome`.
 * @returns the seeded inventory.
 * @throws Error when the path is not a minted scratch home.
 */
export function seedCanaryHome(home: string): InventoryEntry[] {
  assertScratchHome(home)
  for (const entry of REPRESENTATIVE_ENTRIES) {
    const path = join(home, entry.name)
    if (entry.kind === 'file') {
      writeFileSync(path, `canary ${entry.name}\n`)
      continue
    }
    mkdirSync(path, { recursive: true })
    for (const nested of entry.nested ?? []) {
      const target = join(path, nested)
      mkdirSync(join(target, '..'), { recursive: true })
      writeFileSync(target, `canary ${entry.name}/${nested}\n`)
    }
  }
  const inventory = readInventory(home)
  writeFileSync(inventoryPath(home), `${JSON.stringify(inventory, undefined, 2)}\n`)
  return inventory
}

/**
 * Inventory file recorded beside a canary home, outside the tree the workflow can delete.
 * @param home - scratch home.
 * @returns absolute inventory path.
 */
export function inventoryPath(home: string): string {
  return `${home}.inventory.json`
}

/**
 * Compare a home with a recorded inventory.
 * @param home - absolute harness home.
 * @param recorded - inventory captured when the home was seeded.
 * @returns entries that disappeared and entries that appeared.
 */
export function diffInventory(
  home: string, recorded: readonly InventoryEntry[],
): { removed: string[]; added: string[]; changed: string[] } {
  const present = new Map(readInventory(home).map(entry => [entry.name, entry]))
  const known = new Set(recorded.map(entry => entry.name))
  const removed = recorded.filter(entry => !present.has(entry.name)).map(entry => entry.name)
  const added = [...present.keys()].filter(name => !known.has(name))
  const changed = recorded
    .filter(entry => present.has(entry.name))
    .filter((entry) => {
      const now = present.get(entry.name) as InventoryEntry
      return now.files !== entry.files || now.bytes !== entry.bytes
    })
    .map(entry => entry.name)
  return { removed, added, changed }
}

/** Processes running while an entry disappeared, as far as the host can report them. */
interface ProcessSnapshot {
  readonly pid: number
  readonly name: string
  readonly startedAt?: string
  readonly commandLine?: string
}

/**
 * Capture the processes alive at an event, so a later report can name a suspect.
 * @returns process entries, or an empty list when the snapshot itself fails.
 */
function processSnapshot(): ProcessSnapshot[] {
  try {
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CreationDate,CommandLine | ConvertTo-Json -Compress'],
    { encoding: 'utf8', timeout: 20_000, windowsHide: true })
    const parsed: unknown = JSON.parse(output)
    const rows = Array.isArray(parsed) ? parsed : [parsed]
    return rows.flatMap((row: unknown) => {
      if (typeof row !== 'object' || row === null) return []
      const record = row as { ProcessId?: unknown; Name?: unknown; CreationDate?: unknown; CommandLine?: unknown }
      if (typeof record.ProcessId !== 'number' || typeof record.Name !== 'string') return []
      return [{
        pid: record.ProcessId,
        name: record.Name,
        ...typeof record.CreationDate === 'string' ? { startedAt: record.CreationDate } : {},
        ...typeof record.CommandLine === 'string' ? { commandLine: record.CommandLine } : {},
      }]
    })
  } catch (error) {
    return []
  }
}

/**
 * Watch a home and record each disappearance with its time and the processes alive then.
 *
 * Windows reports a removed subdirectory as a watcher error on the recursive handle, so an error restarts the watch
 * instead of ending the observation: the run must survive the very deletion it exists to record.
 * @param home - absolute harness home to observe.
 * @param logPath - append-only JSONL destination outside the observed tree.
 * @param signal - stops the watcher; the caller owns process lifetime otherwise.
 * @returns resolves once the watcher closes.
 */
export async function watchHome(home: string, logPath: string, signal: AbortSignal): Promise<void> {
  let pending: NodeJS.Timeout | undefined
  let current: ReturnType<typeof watch> | undefined
  let closed = false
  const events: Array<{ time: string; path: string; kind: 'removed' | 'created' | 'changed' }> = []
  const flush = (): void => {
    pending = undefined
    if (events.length === 0) return
    const batch = events.splice(0, events.length)
    appendFileSync(logPath, `${JSON.stringify({
      time: new Date().toISOString(), type: 'events', home, pid: process.pid, events: batch, processes: processSnapshot(),
    })}\n`)
  }
  const start = (): void => {
    if (closed) return
    try {
      current = watch(home, { recursive: true }, (eventType, filename) => {
        if (typeof filename !== 'string') return
        const path = join(home, filename)
        const exists = existsSync(path)
        events.push({
          time: new Date().toISOString(),
          path,
          kind: exists ? (eventType === 'rename' ? 'created' : 'changed') : 'removed',
        })
        // A deletion is the event this tool exists for: flush at once so the process snapshot still sees the deleter.
        if (!exists) {
          if (pending !== undefined) clearTimeout(pending)
          flush()
          return
        }
        pending ??= setTimeout(flush, 2_000)
      })
      current.on('error', () => {
        if (closed) return
        try { current?.close() } catch (error) { /* the handle is already gone; restart below */ }
        setTimeout(start, 1_000)
      })
    } catch (error) {
      setTimeout(start, 5_000)
    }
  }
  appendFileSync(logPath, `${JSON.stringify({ time: new Date().toISOString(), type: 'started', home, pid: process.pid })}\n`)
  start()
  const heartbeat = setInterval(() => {
    appendFileSync(logPath, `${JSON.stringify({ time: new Date().toISOString(), type: 'heartbeat', home, pid: process.pid })}\n`)
  }, 60_000)
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      closed = true
      clearInterval(heartbeat)
      if (pending !== undefined) clearTimeout(pending)
      flush()
      try { current?.close() } catch (error) { /* closing an already failed handle is the restart path's job */ }
      appendFileSync(logPath, `${JSON.stringify({ time: new Date().toISOString(), type: 'stopped', home, pid: process.pid })}\n`)
      resolve()
    }
    signal.addEventListener('abort', stop, { once: true })
  })
}

/**
 * Record one inventory sample and report any entry that disappeared since the previous sample.
 *
 * This mode is built for a repeating scheduled run: each invocation samples the home, appends one record, and exits,
 * so no long-lived console process has to survive a build or an application restart.
 * @param home - absolute harness home to sample.
 * @param logPath - append-only JSONL destination outside the observed tree.
 * @returns the entries that disappeared since the previous sample.
 */
export function sampleHome(home: string, logPath: string): string[] {
  const inventory = readInventory(home)
  const statePath = `${logPath}.last.json`
  let previous: InventoryEntry[] = []
  if (existsSync(statePath)) {
    try { previous = JSON.parse(readFileSync(statePath, 'utf8')) as InventoryEntry[] } catch (error) { previous = [] }
  }
  writeFileSync(statePath, `${JSON.stringify(inventory, undefined, 2)}\n`)
  const removed = previous.map(entry => entry.name).filter(name => !inventory.some(entry => entry.name === name))
  const record = {
    time: new Date().toISOString(),
    type: removed.length > 0 ? 'loss' : 'sample',
    home,
    entries: inventory.map(entry => entry.name),
    files: inventory.reduce((total, entry) => total + entry.files, 0),
    bytes: inventory.reduce((total, entry) => total + entry.bytes, 0),
    ...removed.length === 0 ? {} : { removed, processes: processSnapshot() },
  }
  appendFileSync(logPath, `${JSON.stringify(record)}\n`)
  return removed
}
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    home: { type: 'string' },
    log: { type: 'string' },
    'keep-home': { type: 'boolean', default: false },
  },
})
const mode = positionals[0]

if (mode === 'seed') {
  const home = values.home ?? createScratchHome()
  const inventory = seedCanaryHome(home)
  console.log(JSON.stringify({ home, inventory: inventory.map(entry => entry.name), inventoryFile: inventoryPath(home) }, undefined, 2))
} else if (mode === 'check') {
  const home = values.home
  if (home === undefined) throw new Error('usage: home-canary.ts check --home <path>')
  const recorded = JSON.parse(readFileSync(inventoryPath(home), 'utf8')) as InventoryEntry[]
  const diff = diffInventory(home, recorded)
  console.log(JSON.stringify(diff, undefined, 2))
  if (diff.removed.length > 0) process.exitCode = 1
} else if (mode === 'watch') {
  // The observer only reads the Harness home and writes its log outside it; it never boots a profile, so it is the
  // one script that targets the user's real home instead of a scratch home.
  const home = values.home ?? resolveDshHome()
  const log = values.log ?? join(process.cwd(), 'home-canary-events.jsonl')
  const controller = new AbortController()
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => controller.abort())
  console.log(JSON.stringify({ watching: home, log, pid: process.pid }))
  await watchHome(home, log, controller.signal)
} else if (mode === 'sample') {
  // The observer only reads the Harness home and writes its log outside it; it never boots a profile, so it is the
  // one script that targets the user's real home instead of a scratch home.
  const home = values.home ?? resolveDshHome()
  const log = values.log ?? join(process.cwd(), 'home-canary-events.jsonl')
  const removed = sampleHome(home, log)
  console.log(JSON.stringify({ sampled: home, removed }))
} else if (mode === 'cleanup') {
  const home = values.home
  if (home === undefined) throw new Error('usage: home-canary.ts cleanup --home <path>')
  if (values['keep-home'] !== true) removeScratchHome(home)
  rmSync(inventoryPath(home), { force: true })
} else {
  console.error('usage: home-canary.ts seed [--home <scratch-home>] | check --home <path> '
    + '| watch [--home <path>] [--log <file>] | sample [--home <path>] [--log <file>] | cleanup --home <path> [--keep-home]')
  process.exitCode = 2
}
