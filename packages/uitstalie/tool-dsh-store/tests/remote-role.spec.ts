/** The rules Remote must not collide with the base `dshStore` data service. */
import { expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import StoreRulesRemote from '../src/remote.ts'

test('binds dshStoreRules as the service key and dshStore as the wire namespace', async () => {
  const ctx = new Context()
  ctx.provide('fs', {} as never)
  ctx.provide('workspaceRegistry', {} as never)
  ctx.provide('dshStore', {} as never)
  await ctx.plugin(StoreRulesRemote)

  const base = (ctx.dshStore as { typertRemote?: unknown })
  const remote = (ctx as unknown as {
    dshStoreRules?: { typertRemote?: { serviceKey?: string; namespace?: string } }
  }).dshStoreRules
  expect(base.typertRemote).toBeUndefined()
  expect(remote?.typertRemote).toMatchObject({
    serviceKey: 'dshStoreRules',
    namespace: 'dshStore',
  })
})
