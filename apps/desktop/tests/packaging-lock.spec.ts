import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { acquirePackagingLock, clearStaleOutput, STALE_OUTPUT_DIRECTORIES } from '../scripts/packaging-lock.ts'

const roots: string[] = []
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'desktop-packaging-lock-'))
  roots.push(root)
  return root
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('records the holder and removes the lock on release', () => {
  const directory = fixture()
  const lock = acquirePackagingLock(directory, 'win-x64', 'run-1', { now: () => new Date('2026-01-01T00:00:00Z') })
  const path = join(directory, 'win-x64.lock.json')
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
    pid: process.pid, startedAt: '2026-01-01T00:00:00.000Z', target: 'win-x64', run: 'run-1',
  })
  lock.release()
  expect(existsSync(path)).toBe(false)
})

it('refuses a target held by a live process and names that pid', () => {
  const directory = fixture()
  const first = acquirePackagingLock(directory, 'win-x64', 'run-1', { isAlive: () => true })
  expect(() => acquirePackagingLock(directory, 'win-x64', 'run-2', { isAlive: () => true }))
    .toThrow(/已有 run 在跑，pid=\d+/u)
  first.release()
})

it('takes over a lock whose owner is gone and reports the stale owner', () => {
  const directory = fixture()
  const path = join(directory, 'win-x64.lock.json')
  writeFileSync(path, JSON.stringify({ pid: 424242, startedAt: '2026-01-01T00:00:00.000Z', target: 'win-x64', run: 'dead-run' }))
  const lock = acquirePackagingLock(directory, 'win-x64', 'run-2', { isAlive: () => false })
  expect(lock.stale?.pid).toBe(424242)
  expect(lock.state.run).toBe('run-2')
  lock.release()
})

it('treats an unreadable lock as stale', () => {
  const directory = fixture()
  writeFileSync(join(directory, 'win-x64.lock.json'), 'not json')
  const lock = acquirePackagingLock(directory, 'win-x64', 'run-3', { isAlive: () => true })
  expect(lock.stale).toBeUndefined()
  expect(JSON.parse(readFileSync(join(directory, 'win-x64.lock.json'), 'utf8'))).toMatchObject({ run: 'run-3' })
  lock.release()
})

it('does not release a lock another process has since taken', () => {
  const directory = fixture()
  const path = join(directory, 'win-x64.lock.json')
  const lock = acquirePackagingLock(directory, 'win-x64', 'run-1', { isAlive: () => true })
  writeFileSync(path, JSON.stringify({ pid: 999999, startedAt: '2026-01-01T00:00:00.000Z', target: 'win-x64', run: 'run-9' }))
  lock.release()
  expect(existsSync(path)).toBe(true)
})

it('removes only the known stale output directories', () => {
  const output = fixture()
  for (const entry of STALE_OUTPUT_DIRECTORIES) mkdirSync(join(output, entry))
  writeFileSync(join(output, 'deepseek-harness-0.0.0-win-x64-unsigned.exe'), 'artifact')
  const removed = clearStaleOutput(output)
  expect(removed).toEqual([...STALE_OUTPUT_DIRECTORIES])
  for (const entry of STALE_OUTPUT_DIRECTORIES) expect(existsSync(join(output, entry))).toBe(false)
  expect(existsSync(join(output, 'deepseek-harness-0.0.0-win-x64-unsigned.exe'))).toBe(true)
})

it('removes nothing when the output is clean', () => {
  expect(clearStaleOutput(fixture())).toEqual([])
})
