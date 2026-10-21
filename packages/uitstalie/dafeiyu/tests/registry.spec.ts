/**
 * Registry tests: registration, status, the enable gate, contract rejection,
 * failure isolation, and disposal, on a plain Cordis context.
 */
import { afterEach, expect, test, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Dafeiyu from '../src/index.ts'
import type {
  CapabilityContribution,
  CapabilityProvider,
  CapabilityRuntime,
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
}

/** Build a provider whose declaration can deliberately violate the contract. */
function provider(options: ProviderOptions = {}): CapabilityProvider {
  return {
    id: options.id ?? 'memory',
    contractVersion: options.contractVersion ?? 1,
    config: {},
    create: options.create ?? (() => ({})),
  } as CapabilityProvider
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
  expect(() => ctx.dafeiyu.register(provider({ id: 'legacy-memory', contractVersion: 2, create })))
    .toThrow(/capability "legacy-memory" declares contractVersion 2; expected 1/)
  expect(create).not.toHaveBeenCalled()
  expect(ctx.dafeiyu.status()).toEqual([])
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
