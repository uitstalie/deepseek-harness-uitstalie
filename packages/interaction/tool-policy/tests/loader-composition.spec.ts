/** Real Loader composition: the soft policy denies a registered tool through the real executor. */
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import * as sessionPlugin from '@deepseek-ai/dsh-session'
import * as systemPromptPlugin from '@deepseek-ai/dsh-system-prompt'
import * as toolsPlugin from '@deepseek-ai/dsh-tools'
import * as sessionProjectionPlugin from '@deepseek-ai/dsh-session-projection'
import * as toolPolicyPlugin from '@deepseek-ai/dsh-tool-policy'
import { ToolCallId } from '@deepseek-ai/dsh-llm'

let context: Context | undefined
let root: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('tool-policy real Loader composition', () => {
  it('denies bash through the executor while allowing read under guarded-no-shell', async () => {
    root = await mkdtemp(join(tmpdir(), 'tool-policy-loader-'))
    const fixture = await readFile(new URL('./fixtures/cordis.yml', import.meta.url), 'utf8')
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, fixture)
    const ctx = context = new Context()
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-session', sessionPlugin],
      ['@deepseek-ai/dsh-system-prompt', systemPromptPlugin],
      ['@deepseek-ai/dsh-tools', toolsPlugin],
      ['@deepseek-ai/dsh-tool-executor-native', NativeToolExecutor],
      ['@deepseek-ai/dsh-session-projection', sessionProjectionPlugin],
      ['@deepseek-ai/dsh-tool-policy', toolPolicyPlugin],
    ])
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error('Unexpected Loader import: ' + specifier)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()

    const tool = (name: string): ToolDefinition => ({
      name,
      description: `fixture tool ${name}`,
      parameters: { type: 'object', properties: {} },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value as string }],
      },
      execute: () => Promise.resolve(`ran:${name}`),
    })
    ctx.tools.register(tool('bash'))
    ctx.tools.register(tool('read'))

    const call = (name: string) => executeToolFixture(ctx, {
      name,
      arguments: {},
      callId: ToolCallId('policy-loader-call'),
      signal: new AbortController().signal,
    })

    await expect(call('bash')).resolves.toMatchObject({
      isError: true,
      error: { info: { name: 'ToolPolicyError', code: 'TOOL_POLICY_DENIED' } },
    })
    await expect(call('read')).resolves.toMatchObject({ isError: false, value: 'ran:read' })
  })
})
