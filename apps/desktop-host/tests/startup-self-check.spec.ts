import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runStartupSelfCheck } from '../src/startup-self-check.ts'

const roots: string[] = []

function home(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-self-check-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('desktop host startup self-check', () => {
  it('reports healthy checks and appends one log line', async () => {
    const root = home()
    const result = await runStartupSelfCheck({
      home: root, platform: 'linux', execPath: '/runtime/node', expectedNode: '/runtime/node',
      loadModule: name => name === 'koffi' ? { load: () => undefined } : {}, now: new Date('2026-01-01T00:00:00Z'),
      decodeSharp: async () => {},
    })
    expect(result.status).toBe('ok')
    expect(result.items).toEqual([
      { name: 'bundled-node', status: 'ok' }, { name: 'koffi', status: 'ok' }, { name: 'sharp', status: 'ok' },
    ])
    const log = readFileSync(join(root, 'logs', 'desktop-self-check.log'), 'utf8')
    expect(log).toContain('"status":"ok"')
    expect(log).toContain('2026-01-01T00:00:00.000Z')
  })

  it('degrades without throwing when native checks fail', async () => {
    const result = await runStartupSelfCheck({
      home: home(), platform: 'linux', execPath: '/usr/bin/node', expectedNode: '/runtime/node',
      loadModule: (name) => { if (name === 'koffi') throw new Error('koffi unavailable'); return {} },
      decodeSharp: async () => { throw new Error('sharp unavailable') },
    })
    expect(result.status).toBe('degraded')
    expect(result.items).toEqual([
      { name: 'bundled-node', status: 'failed', detail: 'Host runs /usr/bin/node instead of the bundled /runtime/node' },
      { name: 'koffi', status: 'failed', detail: 'koffi unavailable' },
      { name: 'sharp', status: 'failed', detail: 'sharp unavailable' },
    ])
  })

  it('skips the bundled Node check on Electron-Node platforms', async () => {
    const result = await runStartupSelfCheck({
      home: home(), platform: 'darwin', execPath: '/Applications/DeepSeek Harness',
      loadModule: name => name === 'koffi' ? { load: () => undefined } : {},
      decodeSharp: async () => {},
    })
    expect(result.items[0]).toEqual({ name: 'bundled-node', status: 'skipped', detail: 'Host uses Electron Node on this platform' })
    expect(result.status).toBe('ok')
  })
})
