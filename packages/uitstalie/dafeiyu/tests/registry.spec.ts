/**
 * Registry tests: registration, status, the enable gate, contract rejection,
 * failure isolation, and disposal, on a plain Cordis context.
 */
import { afterEach, expect, test, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Dafeiyu from '../src/index.ts'
import type {
  CapabilityContribution,
  CapabilityProvider,
  CapabilityRuntime,
  CapabilitySettings,
  Config,
} from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** Mount the organizer on a fresh context. */
async function mount(config: Config = {}): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Dafeiyu, config)
  return ctx
}

/** Let a started activation continuation run. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
}

interface ProviderOptions {
  readonly id?: string
  readonly contractVersion?: number
  readonly create?: (runtime: CapabilityRuntime) => CapabilityContribution | Promise<CapabilityContribution>
  readonly label?: string
  readonly description?: string
  readonly enabledByDefault?: boolean
  readonly settings?: CapabilitySettings
}

/** Build a provider whose declaration can deliberately violate the contract. */
function provider(options: ProviderOptions = {}): CapabilityProvider {
  const version = options.contractVersion ?? 1
  const base = {
    id: options.id ?? 'memory',
    config: {},
    create: options.create ?? (() => ({})),
  }
  if (version !== 2) return { ...base, contractVersion: version } as CapabilityProvider
  return {
    ...base,
    contractVersion: 2,
    label: options.label ?? 'Memory',
    description: options.description ?? 'Session memory',
    ...options.enabledByDefault === undefined ? {} : { enabledByDefault: options.enabledByDefault },
    ...options.settings === undefined ? {} : { settings: options.settings },
  }
}

test('register creates the contribution once and status lists it', async () => {
  const ctx = await mount()
  const create = vi.fn((_runtime: CapabilityRuntime) => ({}))
  const off = ctx.dafeiyu.register(provider({ create }))

  expect(create).toHaveBeenCalledTimes(1)
  await settle()
  expect(ctx.dafeiyu.status()).toEqual([{ id: 'memory', present: true, enabled: true, state: 'active' }])

  off()
  expect(ctx.dafeiyu.status()).toEqual([])
  expect(() => ctx.dafeiyu.register(provider({ id: 'memory' }))).not.toThrow()
})

test('rejects a duplicate capability id and names it', async () => {
  const ctx = await mount()
  ctx.dafeiyu.register(provider({ id: 'memory' }))
  expect(() => ctx.dafeiyu.register(provider({ id: 'memory' }))).toThrow(/capability "memory" is already registered/)
})

test('rejects an unsupported contract version and names the capability', async () => {
  const ctx = await mount()
  const create = vi.fn(() => ({}))
  expect(() => ctx.dafeiyu.register(provider({ id: 'legacy-memory', contractVersion: 3, create })))
    .toThrow(/capability "legacy-memory" declares contractVersion 3; expected 1 or 2/)
  expect(create).not.toHaveBeenCalled()
  expect(ctx.dafeiyu.status()).toEqual([])
})

test('v1 and v2 providers register side by side during an upgrade', async () => {
  const ctx = await mount()
  ctx.dafeiyu.register(provider({ id: 'memory', contractVersion: 1 }))
  ctx.dafeiyu.register(provider({
    id: 'jira',
    contractVersion: 2,
    label: 'Jira',
    description: 'Workspace issue ledger',
  }))
  await settle()
  const statuses = ctx.dafeiyu.status()
  expect(statuses).toHaveLength(2)
  expect(statuses[0]).toEqual({ id: 'memory', present: true, enabled: true, state: 'active' })
  expect(statuses[1]).toMatchObject({
    id: 'jira',
    present: true,
    enabled: true,
    state: 'active',
    label: 'Jira',
    description: 'Workspace issue ledger',
  })
})

test('a v2 descriptor contributes its list metadata to status', async () => {
  const ctx = await mount()
  ctx.dafeiyu.register(provider({
    id: 'jira',
    contractVersion: 2,
    label: 'Jira',
    description: 'Workspace issue ledger',
    settings: { sectionId: 'jira', order: 200 },
  }))
  await settle()
  expect(ctx.dafeiyu.status()).toEqual([{
    id: 'jira',
    present: true,
    enabled: true,
    state: 'active',
    label: 'Jira',
    description: 'Workspace issue ledger',
    settings: { sectionId: 'jira', order: 200 },
  }])
})

test('rejects a v2 descriptor without the list metadata', async () => {
  const ctx = await mount()
  expect(() => ctx.dafeiyu.register(provider({ id: 'jira', contractVersion: 2, label: ' ' })))
    .toThrow(/capability "jira" declares contractVersion 2 without a label/)
  expect(() => ctx.dafeiyu.register(provider({ id: 'jira', contractVersion: 2, description: '' })))
    .toThrow(/capability "jira" declares contractVersion 2 without a description/)
  expect(ctx.dafeiyu.status()).toEqual([])
})

test('enabledByDefault closes the gate only while configuration omits the capability', async () => {
  const closed = await mount()
  const createClosed = vi.fn(() => ({}))
  closed.dafeiyu.register(provider({ contractVersion: 2, enabledByDefault: false, create: createClosed }))
  expect(createClosed).not.toHaveBeenCalled()
  expect(closed.dafeiyu.status()[0]).toMatchObject({ enabled: false, state: 'disabled' })

  const opened = await mount({ capabilities: { memory: { enabled: true } } })
  const createOpened = vi.fn(() => ({}))
  opened.dafeiyu.register(provider({ contractVersion: 2, enabledByDefault: false, create: createOpened }))
  await settle()
  expect(createOpened).toHaveBeenCalledTimes(1)
  expect(opened.dafeiyu.status()[0]).toMatchObject({ enabled: true, state: 'active' })
})

test('a volatile gate write tears the capability down and rebuilds it without a remount', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Loader)
  const name = 'dafeiyu-live'
  ctx.loader.builtins[name] = Dafeiyu
  const id = await ctx.loader.create({
    name: `cordis:${name}`,
    config: { capabilities: { memory: { enabled: true } } },
  })
  const entry = ctx.loader.resolve(id)
  const fiberUid = entry.fiber?.uid
  await entry.fiber?.await()
  const dispose = vi.fn()
  const create = vi.fn(() => ({ dispose }))
  ctx.dafeiyu.register(provider({ create }))
  await settle()
  expect(create).toHaveBeenCalledTimes(1)

  await entry.update({ config: { capabilities: { memory: { enabled: false } } } })
  await entry.fiber?.await()
  expect(entry.fiber?.uid).toBe(fiberUid)
  expect(dispose).toHaveBeenCalledTimes(1)
  expect(ctx.dafeiyu.status()).toEqual([{ id: 'memory', present: true, enabled: false, state: 'disabled' }])

  await entry.update({ config: { capabilities: { memory: { enabled: true } } } })
  await entry.fiber?.await()
  await settle()
  expect(create).toHaveBeenCalledTimes(2)
  expect(ctx.dafeiyu.status()).toEqual([{ id: 'memory', present: true, enabled: true, state: 'active' }])
})

test('closed gate skips create and reports disabled', async () => {
  const ctx = await mount({ capabilities: { memory: { enabled: false } } })
  const create = vi.fn(() => ({}))
  const off = ctx.dafeiyu.register(provider({ create }))

  expect(create).not.toHaveBeenCalled()
  expect(ctx.dafeiyu.status()).toEqual([{ id: 'memory', present: true, enabled: false, state: 'disabled' }])

  off()
  expect(ctx.dafeiyu.status()).toEqual([{ id: 'memory', present: false, enabled: false, state: 'missing' }])
})

test('absent configuration leaves the gate open', async () => {
  const ctx = await mount()
  const create = vi.fn(() => ({}))
  ctx.dafeiyu.register(provider({ create }))
  await settle()
  expect(create).toHaveBeenCalledTimes(1)
  expect(ctx.dafeiyu.status()[0]).toMatchObject({ id: 'memory', enabled: true, state: 'active' })
})

test('one create failure does not stop another capability', async () => {
  const ctx = await mount()
  const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
  ctx.dafeiyu.register(provider({
    id: 'memory',
    create: () => { throw new Error('memory preload failed\nwith details') },
  }))
  ctx.dafeiyu.register(provider({ id: 'personality' }))
  await settle()

  const statuses = ctx.dafeiyu.status()
  expect(statuses.find(status => status.id === 'memory')).toMatchObject({
    present: true,
    enabled: true,
    state: 'failed',
    failure: 'memory preload failed with details',
  })
  expect(statuses.find(status => status.id === 'personality')).toMatchObject({
    present: true,
    enabled: true,
    state: 'active',
  })
  expect(warn).toHaveBeenCalledTimes(1)
})

test('waits for an asynchronous create, then reports active', async () => {
  const ctx = await mount()
  const runtime: CapabilityRuntime[] = []
  const gate = Promise.withResolvers<undefined>()
  ctx.dafeiyu.register(provider({
    id: 'memory',
    create: async (input) => {
      runtime.push(input)
      await gate.promise
      return {}
    },
  }))

  expect(ctx.dafeiyu.status()[0]).toMatchObject({ enabled: true, state: 'disabled' })
  gate.resolve(undefined)
  await settle()
  expect(ctx.dafeiyu.status()[0]).toMatchObject({ enabled: true, state: 'active' })
  expect(runtime[0]?.signal.aborted).toBe(false)
})

test('removing a registration aborts it and disposes its contribution', async () => {
  const ctx = await mount()
  const dispose = vi.fn()
  const runtime: CapabilityRuntime[] = []
  const gate = Promise.withResolvers<undefined>()
  const off = ctx.dafeiyu.register(provider({
    id: 'memory',
    create: async (input) => {
      runtime.push(input)
      await gate.promise
      return { dispose }
    },
  }))
  await settle()

  off()
  expect(runtime[0]?.signal.aborted).toBe(true)
  gate.resolve(undefined)
  await settle()
  expect(dispose).toHaveBeenCalledTimes(1)
  expect(ctx.dafeiyu.status()).toEqual([])
})

test('unloading the service disposes registered contributions', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  const fiber = await ctx.plugin(Dafeiyu)
  const dispose = vi.fn()
  const off = ctx.dafeiyu.register(provider({ create: () => ({ dispose }) }))
  await settle()

  await fiber.dispose()
  expect(dispose).toHaveBeenCalledTimes(1)
  expect(() => ctx.dafeiyu.register(provider({ id: 'memory' }))).toThrow()
  off()
})

test('configured ids without a provider report missing', async () => {
  const ctx = await mount({ capabilities: { ghost: { enabled: true }, off: { enabled: false } } })
  expect(ctx.dafeiyu.status()).toEqual([
    { id: 'ghost', present: false, enabled: true, state: 'missing' },
    { id: 'off', present: false, enabled: false, state: 'missing' },
  ])
})
