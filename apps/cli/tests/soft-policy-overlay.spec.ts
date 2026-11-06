/**
 * The soft-policy composition overlays: `soft-policy.yml` must turn the base
 * composition into an unconfined process plus a named tool policy, and
 * `os-sandbox.yml` must restore the base rows when applied after it.
 *
 * The composition half reads the real patch files. The boot half mounts the
 * composed rows for the services the acceptance names, with source builtins so
 * a clean checkout needs no built `lib/`; rows outside that set are not part of
 * this test's claim.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { evaluate } from '@deepseek-ai/cordis-plugin-loader'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { boot, composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import LocalBashExecutor from '@deepseek-ai/dsh-bash-local'
import LocalPwshExecutor from '@deepseek-ai/dsh-pwsh-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import ToolPolicyService from '@deepseek-ai/dsh-tool-policy'

const root = resolve(import.meta.dirname, '../../..')
const overlays = resolve(root, 'apps/cli/config/overlays')
const basePatch = resolve(root, 'packages/bundle/base/cordis.patch.yml')

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const release of cleanup.splice(0).reverse()) await release()
})

function load(name: 'soft-policy' | 'os-sandbox'): PatchOptions[] {
  return loadOverlayPatches('soft-policy-test', resolve(overlays, `${name}.yml`))
}

function byId(entries: readonly EntryOptions[]): Map<string, EntryOptions> {
  return new Map(entries.flatMap(entry => entry.id === undefined ? [] : [[entry.id, entry] as const]))
}

/** Whether a composed row is disabled on this host, evaluating its `!!js` gate. */
function disabled(entry: EntryOptions | undefined): boolean {
  if (entry === undefined) throw new Error('expected a composed row')
  const value: unknown = entry.disabled
  if (value === undefined) return false
  if (typeof value === 'boolean') return value
  return Boolean(evaluate({ process: { platform: process.platform } }, jsExpression(value)))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function configOf(entry: EntryOptions | undefined): Record<string, unknown> {
  if (entry === undefined) throw new Error('expected a composed row')
  const config: unknown = entry.config
  if (!isRecord(config)) throw new Error(`row ${entry.id} has no config`)
  return config
}

function jsExpression(value: unknown): string {
  if (!isRecord(value) || typeof value['__jsExpr'] !== 'string') throw new Error('expected a !!js expression')
  return value['__jsExpr']
}

describe('soft-policy overlay composition', () => {
  it('unmounts every sandbox row and mounts the local backends plus the tool policy', () => {
    const entries = byId(composeEntries([loadOverlayPatches('soft-policy-test', basePatch), load('soft-policy')]))

    for (const id of ['sandbox', 'sandbox-policy', 'bash-sandbox', 'pwsh-sandbox', 'fs-sandbox', 'permission']) {
      expect(disabled(entries.get(id)), id).toBe(true)
    }
    expect(entries.get('tool-policy')?.name).toBe('@deepseek-ai/dsh-tool-policy')
    expect(configOf(entries.get('tool-policy'))['defaultProfile']).toBe('guarded')
    expect(entries.get('fs-local')?.name).toBe('@deepseek-ai/dsh-fs-local')
    expect(jsExpression(configOf(entries.get('approval'))['policy'])).toContain('DSH_APPROVAL_POLICY')
    // Exactly one unconfined shell mounts per host, mirroring the base gating.
    expect(disabled(entries.get('bash-local'))).toBe(process.platform === 'win32')
    expect(disabled(entries.get('pwsh-local'))).toBe(process.platform !== 'win32')
  })

  it('restores the base rows when os-sandbox is applied after soft-policy', () => {
    const entries = byId(composeEntries([
      loadOverlayPatches('soft-policy-test', basePatch),
      load('soft-policy'),
      load('os-sandbox'),
    ]))

    for (const id of ['sandbox', 'sandbox-policy', 'fs-sandbox', 'permission']) {
      expect(entries.get(id)?.disabled, id).toBe(false)
    }
    expect(disabled(entries.get('bash-sandbox'))).toBe(process.platform === 'win32')
    expect(disabled(entries.get('pwsh-sandbox'))).toBe(process.platform !== 'win32')
    for (const id of ['fs-local', 'bash-local', 'pwsh-local', 'tool-policy']) {
      expect(entries.get(id)?.disabled, id).toBe(true)
    }
    expect(jsExpression(configOf(entries.get('approval'))['policy'])).toContain('DSH_PERMISSION_MODE')
  })
})

/** The composed rows this boot mounts, with their real source-plane plugins. */
const BOOT_ROWS = new Map<string, unknown>([
  ['session-projection', SessionProjectionRegistry],
  ['tools', ToolRuntime],
  ['tool-executor-native', NativeToolExecutor],
  ['system-prompt', SystemPrompt],
  ['working-directory', WorkingDirectory],
  ['subprocess', LocalSubprocessRuntime],
  ['fs-local', LocalFileSystem],
  ['bash-local', LocalBashExecutor],
  ['pwsh-local', LocalPwshExecutor],
  ['tool-policy', ToolPolicyService],
  ['tool-fs', ToolFs],
])

/**
 * Build the boot config from the real composed rows, keeping only the rows this
 * test owns and mapping each plugin name to its source builtin.
 * @param entries - the composed base + soft-policy entry list.
 * @returns the fixture rows and the builtin table naming each plugin.
 */
function bootFixture(entries: readonly EntryOptions[]): { rows: object[]; builtins: Map<string, unknown> } {
  const composed = byId(entries)
  const builtins = new Map<string, unknown>()
  const rows = [...BOOT_ROWS.keys()].flatMap((id) => {
    const entry = composed.get(id)
    if (entry === undefined || disabled(entry)) return []
    const plugin = BOOT_ROWS.get(id)
    if (plugin === undefined || typeof entry.name !== 'string') throw new Error(`unexpected row ${id}`)
    builtins.set(id, plugin)
    const config: unknown = entry.config
    return [{
      id,
      name: `cordis:${id}`,
      ...config === undefined ? {} : { config },
    }]
  })
  return { rows, builtins }
}

describe('soft-policy runtime shape', () => {
  it('has no sandbox services or escalation fields, and mounts the tool policy', async () => {
    const composed = composeEntries([loadOverlayPatches('soft-policy-test', basePatch), load('soft-policy')])
    const { rows, builtins } = bootFixture(composed)
    const dir = mkdtempSync(join(tmpdir(), 'dsh-soft-policy-'))
    writeFileSync(join(dir, 'cordis.yml'), JSON.stringify(rows, undefined, 2))
    const live: { current?: Context } = {}
    cleanup.push(async () => {
      try { await live.current?.fiber.dispose() } finally { rmSync(dir, { recursive: true, force: true }) }
    })
    live.current = await boot('soft-policy-test', join(dir, 'cordis.yml'), [], (host) => {
      for (const [id, plugin] of builtins) host.loader.builtins[id] = plugin
    })
    const ctx = live.current
    await ctx.loader.await()

    expect(ctx.get('sandbox')).toBeUndefined()
    expect(ctx.get('sandboxPolicy')).toBeUndefined()
    expect(ctx.get('permissionPresets')).toBeUndefined()
    expect(ctx.get('toolPolicy')).toBeDefined()
    expect(ctx.toolPolicy.defaultProfile).toBe('guarded')
    expect(ctx.get('fs')).toBeDefined()
    expect(ctx.fs.sandboxMode).toBeUndefined()
    expect(ctx.get('shell')).toBeDefined()
    expect(ctx.shell.sandboxMode).toBeUndefined()

    const schemas = ctx.tools.schemas()
    expect(schemas.some(schema => schema.name === 'sandbox_home_readonly')).toBe(false)
    expect(schemas.some(schema => schema.name === 'read')).toBe(true)
    const write = schemas.find(schema => schema.name === 'write')
    expect(write).toBeDefined()
    expect(JSON.stringify(write?.parameters)).not.toContain('sandbox_permissions')
  })
})
