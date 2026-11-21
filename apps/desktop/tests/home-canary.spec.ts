import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  diffInventory, inventoryPath, readInventory, sampleHome, seedCanaryHome,
} from '../scripts/home-canary.ts'
import { createScratchHome, removeScratchHome } from '../scripts/scratch-home.ts'

const roots: string[] = []
function canary(): string {
  const home = createScratchHome()
  roots.push(home)
  return home
}

afterEach(() => {
  for (const home of roots.splice(0)) {
    if (existsSync(home)) removeScratchHome(home)
    rmSync(inventoryPath(home), { force: true })
  }
})

it('seeds the representative entries and reports a clean inventory', () => {
  const home = canary()
  const inventory = seedCanaryHome(home)
  expect(inventory.map(entry => entry.name)).toEqual([
    '.anonymous-user-id', '.credentials.yaml', 'attachments', 'cache', 'dsh-runtimes', 'llm-deepseek', 'logs',
    'memory', 'personality', 'profiles', 'sessions', 'storages', 'workspaces',
  ])
  expect(diffInventory(home, inventory)).toEqual({ removed: [], added: [], changed: [] })
  expect(existsSync(inventoryPath(home))).toBe(true)
})

it('reports a removed entry, a grown entry, and a new entry separately', () => {
  const home = canary()
  const inventory = seedCanaryHome(home)
  rmSync(join(home, 'memory'), { recursive: true })
  writeFileSync(join(home, 'cache', 'extra.json'), '{}')
  mkdirSync(join(home, 'new-entry'))
  const diff = diffInventory(home, inventory)
  expect(diff.removed).toEqual(['memory'])
  expect(diff.changed).toEqual(['cache'])
  expect(diff.added).toEqual(['new-entry'])
})

it('samples once, then reports the entries that disappeared since the previous sample', () => {
  const home = canary()
  seedCanaryHome(home)
  const log = join(tmpdir(), `home-canary-spec-${String(process.pid)}.jsonl`)
  try {
    expect(sampleHome(home, log)).toEqual([])
    rmSync(join(home, 'attachments'), { recursive: true })
    expect(sampleHome(home, log)).toEqual(['attachments'])
    const records = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { type: string })
    expect(records.map(record => record.type)).toEqual(['sample', 'loss'])
  } finally {
    rmSync(log, { force: true })
    rmSync(`${log}.last.json`, { force: true })
  }
})

it('keeps the recorded inventory outside the observed home', () => {
  const home = canary()
  seedCanaryHome(home)
  expect(inventoryPath(home).startsWith(home + sep)).toBe(false)
  expect(readInventory(home).length).toBe(13)
})
