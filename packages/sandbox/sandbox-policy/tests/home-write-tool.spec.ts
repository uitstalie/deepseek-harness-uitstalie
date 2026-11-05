/**
 * The approval-gated home-write force-read-only editor: persistence, audit and rollback.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { homeWriteTool } from '../src/home-write-tool.ts'

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-home-tool-'))
  const home = join(root, 'home')
  const protectedDir = join(home, 'protected')
  mkdirSync(protectedDir, { recursive: true })
  let config: Record<string, unknown> = { mode: 'home-write' }
  const edits: Record<string, unknown>[] = []
  const approvalCalls: { reason: string; displayReason?: { en: string } }[] = []
  const editor = {
    documentPath: join(root, 'cordis.patch.yml'),
    entries: () => [{ options: { id: 'sandbox-policy' } }],
    configuration: () => [],
    async edit(_entry: unknown, change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>) {
      config = change(structuredClone(config), {})
      edits.push(structuredClone(config))
    },
  }
  const approval = {
    async request(request: { reason: string; displayReason?: { en: string } }) {
      approvalCalls.push(request)
      return 'allowed-once' as const
    },
  }
  const ctx = {
    get: (key: string) => key === 'configEditor' ? editor : key === 'approval' ? approval : undefined,
  }
  const view = {
    homeWriteRoots: [home],
    homeWriteTempRoots: [] as readonly string[],
    excludePaths: [] as readonly string[],
    homeWriteAllowSymlinkedRoots: false,
  }
  const tool = homeWriteTool(ctx as never, view)
  const exec = { agent: { session: { id: 'sess-a' } }, callId: 'call-1', signal: new AbortController().signal } as never
  return { root, home, protectedDir, editor, approval, approvalCalls, tool, exec, getConfig: () => config, edits }
}

describe('sandbox home-write force-read-only tool', () => {
  it('adds through approval, persists the full list, audits the change, and rolls back', async () => {
    const h = setup()
    try {
      const added = await h.tool.execute({ action: 'add', path: h.protectedDir, justification: 'protect credentials' }, h.exec) as Record<string, unknown>
      expect(added.roots).toEqual([h.protectedDir])
      expect(h.approvalCalls).toHaveLength(1)
      expect(h.approvalCalls[0]?.reason).toContain('Exclude')
      expect(h.getConfig().excludePaths).toEqual([h.protectedDir])
      const auditPath = join(h.root, 'sandbox-home-readonly-audit.jsonl')
      const audit = readFileSync(auditPath, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
      expect(audit[0]).toMatchObject({
        actor: 'sess-a', action: 'add', path: h.protectedDir, before: [], after: [h.protectedDir],
      })

      const rolled = await h.tool.execute({ action: 'rollback', justification: 'revert the change' }, h.exec) as Record<string, unknown>
      expect(rolled.roots).toEqual([])
      expect(h.getConfig().excludePaths).toEqual([])
      expect(h.approvalCalls.at(-1)?.reason).toContain('Roll back')
    } finally {
      rmSync(h.root, { recursive: true, force: true })
    }
  })

  it('rejects a removal with the concrete writable consequence and changes nothing', async () => {
    const h = setup()
    try {
      await h.tool.execute({ action: 'add', path: h.protectedDir, justification: 'protect first' }, h.exec)
      const rejecting = {
        async request() { return 'rejected' as const },
      }
      const ctx = {
        get: (key: string) => key === 'configEditor' ? h.editor : key === 'approval' ? rejecting : undefined,
      }
      const view = {
        homeWriteRoots: [h.home],
        homeWriteTempRoots: [],
        excludePaths: [h.protectedDir],
        homeWriteAllowSymlinkedRoots: false,
      }
      const tool = homeWriteTool(ctx as never, view)
      await expect(tool.execute(
        { action: 'remove', path: h.protectedDir, justification: 'let the agent edit it' },
        h.exec,
      )).rejects.toThrow(/REMOVING protection.*becomes writable/u)
      expect(h.getConfig().excludePaths).toEqual([h.protectedDir])
    } finally {
      rmSync(h.root, { recursive: true, force: true })
    }
  })

  it('refuses to change a tool-owned field or escape the home; it can only edit the list', async () => {
    const h = setup()
    try {
      const outside = join(h.root, 'outside')
      mkdirSync(outside)
      await expect(h.tool.execute({ action: 'add', path: outside, justification: 'outside' }, h.exec))
        .rejects.toThrow(/must stay inside/u)
      expect(Object.keys(h.getConfig())).toEqual(['mode'])
    } finally {
      rmSync(h.root, { recursive: true, force: true })
    }
  })
})
