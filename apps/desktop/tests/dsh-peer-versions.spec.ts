/** Packaged DSH peer requirements must name the running runtime version. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { dshPeerIssues, normalizeDshPeerVersions } from '../src/runtime-tree.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A packaged tree with one package per peer-skew shape. */
function fixture(peers: Record<string, Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-peer-versions-'))
  roots.push(root)
  for (const [name, peerDependencies] of Object.entries(peers)) {
    const directory = join(root, 'node_modules', '@deepseek-ai', name)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${name}`, version: '0.2.2-rc.4', peerDependencies }, undefined, 2))
  }
  return root
}

it('reports every packaged DSH peer that does not name the runtime version', () => {
  const root = fixture({
    'dsh-tool-fs': { '@deepseek-ai/dsh-tool-policy': '0.2.2-rc.2', '@deepseek-ai/cordis': '~4.1.0' },
    'dsh-llm-plus': { '@deepseek-ai/dsh-models-dev': '0.0.0' },
    'dsh-clean': { '@deepseek-ai/dsh-tools': '0.2.2-rc.4' },
  })
  expect(dshPeerIssues(root, '0.2.2-rc.4')).toEqual([
    { packageName: '@deepseek-ai/dsh-llm-plus', peer: '@deepseek-ai/dsh-models-dev', range: '0.0.0' },
    { packageName: '@deepseek-ai/dsh-tool-fs', peer: '@deepseek-ai/dsh-tool-policy', range: '0.2.2-rc.2' },
  ])
})

it('rewrites DSH peers to the runtime version and leaves other peers alone', () => {
  const root = fixture({
    'dsh-tool-fs': { '@deepseek-ai/dsh-tool-policy': '0.2.2-rc.2', '@deepseek-ai/cordis': '~4.1.0' },
    'dsh-llm-plus': { '@deepseek-ai/dsh-models-dev': '0.0.0' },
  })
  expect(normalizeDshPeerVersions(root, '0.2.2-rc.4').sort()).toEqual(['@deepseek-ai/dsh-llm-plus', '@deepseek-ai/dsh-tool-fs'])
  expect(dshPeerIssues(root, '0.2.2-rc.4')).toEqual([])
  const toolFs: unknown = JSON.parse(readFileSync(join(root, 'node_modules', '@deepseek-ai', 'dsh-tool-fs', 'package.json'), 'utf8'))
  const peers = (toolFs as { peerDependencies: Record<string, string> }).peerDependencies
  expect(peers['@deepseek-ai/dsh-tool-policy']).toBe('0.2.2-rc.4')
  expect(peers['@deepseek-ai/cordis']).toBe('~4.1.0')
  // Idempotent: a second pass changes nothing.
  expect(normalizeDshPeerVersions(root, '0.2.2-rc.4')).toEqual([])
})
