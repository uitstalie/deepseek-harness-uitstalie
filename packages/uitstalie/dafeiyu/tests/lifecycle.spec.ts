/**
 * Lifecycle tests: per-agent wiring through a real AgentLoop, scope filtering,
 * completed-turn dispatch, per-session serialization, and service unload.
 */
import { afterEach, expect, test, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, TurnEndReason } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import {
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
} from '@deepseek-ai/dsh-agent-loop-testkit'
import type { AgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import Dafeiyu from '../src/index.ts'
import type {
  CapabilityContribution,
  CapabilityProvider,
  Config,
  TurnEndInput,
} from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** Build a provider whose contribution is fixed for the test. */
function provider(id: string, contribution: CapabilityContribution): CapabilityProvider {
  return { id, contractVersion: 1, config: {}, create: () => contribution }
}

interface Mounted {
  readonly ctx: Context
  readonly harness: AgentLoopTestHarness
  readonly serviceFiber: Fiber
}

/** Mount the organizer over the real agent-loop services with one provider. */
async function mount(config: Config, contribution: CapabilityContribution): Promise<Mounted> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const serviceFiber = await ctx.plugin(Dafeiyu, config)
  const harness = await mountAgentLoopTestHarness(ctx)
  ctx.dafeiyu.register(provider('memory', contribution))
  await settle()
  return { ctx, harness, serviceFiber }
}

/** Let pending activation and dispatch continuations run. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
}

/** Poll until a test-owned condition becomes true. */
async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return
    await new Promise<void>((resolve) => { setTimeout(resolve, 1) })
  }
  throw new Error('condition was not met')
}

/** Commit one turn boundary without running a model turn. */
function emitTurnEnd(session: Session, turn: number, reason: TurnEndReason): void {
  session.append('turn/end', { turn, reason })
}

/** Contribution that adds one tool and one prompt section. */
function surfaceContribution(scope?: 'root' | 'all'): CapabilityContribution {
  return {
    ...scope === undefined ? {} : { scope },
    tools: () => [defineContentToolFixture({
      name: 'memory_probe',
      description: 'Probe the memory capability.',
      parameters: {},
      execute: async () => [{ type: 'text', text: 'ok' }],
    })],
    promptSections: () => [{ name: 'memory:probe', order: 2350, text: 'Memory probe.' }],
  }
}

test('root scope registers tools and prompt sections on root agents only', async () => {
  const { ctx, harness } = await mount({}, surfaceContribution('root'))
  const root = await harness.create(SessionId('root'))
  const child = await ctx.agents.create({ sessionId: SessionId('child'), meta: { parentSession: root.id, origin: 'subagent', delegationDepth: 1 } })

  expect(ctx.tools.get('memory_probe', root)).toBeDefined()
  const rootAssembly = await ctx.systemPrompt.assemble(assembleContextFor(root))
  expect(rootAssembly.sections.map(section => section.name)).toContain('memory:probe')

  expect(ctx.tools.get('memory_probe', child.agent)).toBeUndefined()
  const childAssembly = await ctx.systemPrompt.assemble(assembleContextFor(child.agent))
  expect(childAssembly.sections.map(section => section.name)).not.toContain('memory:probe')
  await child.dispose()
})

test('all scope registers tools and prompt sections on child agents too', async () => {
  const { ctx, harness } = await mount({}, surfaceContribution('all'))
  const root = await harness.create(SessionId('root'))
  const child = await ctx.agents.create({ sessionId: SessionId('child'), meta: { parentSession: root.id, origin: 'subagent', delegationDepth: 1 } })

  expect(ctx.tools.get('memory_probe', child.agent)).toBeDefined()
  const childAssembly = await ctx.systemPrompt.assemble(assembleContextFor(child.agent))
  expect(childAssembly.sections.map(section => section.name)).toContain('memory:probe')
  await child.dispose()
})

test('dispatches every turn end, aborted ones included, with its reason', async () => {
  const calls: TurnEndInput[] = []
  const completed = Promise.withResolvers<undefined>()
  const contribution: CapabilityContribution = {
    onTurnEnd: (input) => {
      calls.push(input)
      if (input.event.data.reason.kind === 'completed') completed.resolve(undefined)
    },
  }
  const { ctx, harness } = await mount({}, contribution)
  const root = await harness.create(SessionId('root'))

  emitTurnEnd(root.session, 1, { kind: 'aborted', reason: { kind: 'user' } })
  emitTurnEnd(root.session, 2, { kind: 'completed' })
  await completed.promise
  emitTurnEnd(root.session, 3, { kind: 'aborted', reason: { kind: 'user' } })
  await settle()

  // A turn end is a fact, not a success signal: hooks see the aborted turns too, so a dispatch
  // report (or any failure accounting) is never silent about how the turn ended.
  expect(calls.map(call => call.turn)).toEqual([1, 2, 3])
  expect(calls[0]?.event.data.reason).toEqual({ kind: 'aborted', reason: { kind: 'user' } })
  expect(calls[1]?.agent).toBe(root)
  expect(calls[1]?.session).toBe(root.session)
  expect(ctx.dafeiyu.status()[0]?.lastTurnAt).toBe(calls[2]?.event.time)
})

test('root-scoped turns skip child agents while all-scoped turns reach them', async () => {
  const rootCalls: number[] = []
  const allCalls: number[] = []
  const { ctx, harness } = await mount({}, {
    scope: 'root',
    onTurnEnd: (input) => { rootCalls.push(input.turn) },
  })
  ctx.dafeiyu.register(provider('personality', {
    scope: 'all',
    onTurnEnd: (input) => { allCalls.push(input.turn) },
  }))
  await settle()
  const root = await harness.create(SessionId('root'))
  const child = await ctx.agents.create({ sessionId: SessionId('child'), meta: { parentSession: root.id, origin: 'subagent', delegationDepth: 1 } })

  emitTurnEnd(child.agent.session, 1, { kind: 'completed' })
  await until(() => allCalls.length === 1)
  emitTurnEnd(root.session, 2, { kind: 'completed' })
  await until(() => rootCalls.length === 1 && allCalls.length === 2)

  expect(rootCalls).toEqual([2])
  expect(allCalls).toEqual([1, 2])
  await child.dispose()
})

test('serializes turn-end hooks within one session', async () => {
  const started: number[] = []
  let active = 0
  let maxActive = 0
  const gates: Array<() => void> = []
  const contribution: CapabilityContribution = {
    onTurnEnd: async (input) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      started.push(input.turn)
      await new Promise<void>((resolve) => { gates.push(resolve) })
      active -= 1
    },
  }
  const { harness } = await mount({}, contribution)
  const root = await harness.create(SessionId('root'))

  emitTurnEnd(root.session, 1, { kind: 'completed' })
  emitTurnEnd(root.session, 2, { kind: 'completed' })
  await until(() => gates.length === 1)
  expect(started).toEqual([1])
  expect(maxActive).toBe(1)

  gates.shift()?.()
  await until(() => gates.length === 1)
  expect(started).toEqual([1, 2])
  expect(maxActive).toBe(1)

  gates.shift()?.()
  await until(() => active === 0 && started.length === 2)
})

test('a profile config reload disposes and recreates every capability and re-wires live agents', async () => {
  const dispose = vi.fn()
  let created = 0
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Dafeiyu, {})
  const harness = await mountAgentLoopTestHarness(ctx)
  ctx.dafeiyu.register({
    id: 'memory',
    contractVersion: 1,
    config: {},
    create: () => {
      created += 1
      return { ...surfaceContribution(), dispose }
    },
  })
  await settle()
  const root = await harness.create(SessionId('reload-root'))
  expect(created).toBe(1)
  expect(ctx.tools.get('memory_probe', root)).toBeDefined()

  ctx.emit('app-boot/config-reload')
  await until(() => created === 2 && ctx.tools.get('memory_probe', root) !== undefined)

  expect(dispose).toHaveBeenCalledTimes(1)
  expect(ctx.tools.get('memory_probe', root)).toBeDefined()
  expect(ctx.dafeiyu.status()).toContainEqual(expect.objectContaining({ id: 'memory', state: 'active' }))
})

test('a reload waits for an asynchronous contribution dispose before creating again', async () => {
  const order: string[] = []
  const release = Promise.withResolvers<undefined>()
  let creates = 0
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Dafeiyu, {})
  const harness = await mountAgentLoopTestHarness(ctx)
  ctx.dafeiyu.register({
    id: 'async-dispose',
    contractVersion: 1,
    config: {},
    create: () => {
      creates += 1
      const generation = creates
      order.push(`create:${String(generation)}`)
      return {
        promptSections: () => [{ name: 'async-dispose:probe', order: 2400, text: `probe ${String(generation)}` }],
        dispose: async () => {
          order.push(`dispose:${String(generation)}:start`)
          await release.promise
          order.push(`dispose:${String(generation)}:end`)
        },
      }
    },
  })
  try {
    await settle()
    expect(order).toEqual(['create:1'])

    ctx.emit('app-boot/config-reload')
    await settle()
    // The first contribution has not released its prompt registration yet. Creating the next one
    // now would collide on the name and leave the capability with no registration at all.
    expect(order).toEqual(['create:1', 'dispose:1:start'])

    release.resolve(undefined)
    await until(() => creates === 2 && ctx.dafeiyu.status()[0]?.state === 'active')
    expect(order).toEqual(['create:1', 'dispose:1:start', 'dispose:1:end', 'create:2'])

    const root = await harness.create(SessionId('async-dispose-root'))
    const assembly = await ctx.systemPrompt.assemble(assembleContextFor(root))
    expect(assembly.sections
      .filter(section => section.name === 'async-dispose:probe')
      .map(section => section.text)).toEqual(['probe 2'])
  } finally {
    // A regression leaves the dispose pending; release it so teardown reports the assertion
    // failure instead of hanging in the afterEach hook.
    release.resolve(undefined)
  }
})

test('a reload during a running turn keeps the step\'s tools and re-wires once it goes idle', async () => {
  let created = 0
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Dafeiyu, {})
  const harness = await mountAgentLoopTestHarness(ctx)
  ctx.dafeiyu.register({
    id: 'memory',
    contractVersion: 1,
    config: {},
    create: () => {
      created += 1
      return surfaceContribution()
    },
  })
  await settle()
  const root = await harness.create(SessionId('busy-root'))
  expect(created).toBe(1)
  expect(ctx.tools.get('memory_probe', root)).toBeDefined()

  // The Agent is mid-turn: its model step already admitted these exact definitions.
  const idle = Promise.withResolvers<undefined>()
  Object.defineProperty(root, 'status', { value: 'running', configurable: true })
  Object.defineProperty(root, 'whenIdle', { value: () => idle.promise, configurable: true })
  const step = await ctx.tools.resolve({
    agent: root,
    modelSelection: { provider: 'probe', model: 'probe' },
    signal: new AbortController().signal,
  })

  try {
    ctx.emit('app-boot/config-reload')
    await until(() => created === 2)
    // The running step keeps the old registration, so its next call is still executable — this is
    // the regression: replacing the definitions mid-step made every call `UNKNOWN_TOOL`.
    expect(step.view(root).get('memory_probe')).toBeDefined()
    expect(ctx.tools.get('memory_probe', root)).toBeDefined()

    // ...and the reload's own definitions replace them only after the turn settles.
    idle.resolve(undefined)
    await until(() => ctx.tools.get('memory_probe', root) !== undefined)
    expect(ctx.dafeiyu.status()).toContainEqual(expect.objectContaining({ id: 'memory', state: 'active' }))
  } finally {
    step.dispose()
  }
})

test('disposing the service revokes agent-level contributions', async () => {
  const { ctx, harness, serviceFiber } = await mount({}, surfaceContribution())
  const root = await harness.create(SessionId('root'))
  expect(ctx.tools.get('memory_probe', root)).toBeDefined()

  await serviceFiber.dispose()

  expect(ctx.tools.get('memory_probe', root)).toBeUndefined()
  const assembly = await ctx.systemPrompt.assemble(assembleContextFor(root))
  expect(assembly.sections.map(section => section.name)).not.toContain('memory:probe')
})

test('warns once for a configured capability with no provider', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
  await ctx.plugin(Dafeiyu, { capabilities: { ghost: {} } })
  const harness = await mountAgentLoopTestHarness(ctx)

  await harness.create(SessionId('root-a'))
  await harness.create(SessionId('root-b'))

  expect(ctx.dafeiyu.status()).toContainEqual({
    id: 'ghost',
    present: false,
    enabled: true,
    state: 'missing',
  })
  expect(warn).toHaveBeenCalledTimes(1)
})

/** Mount a provider whose turn hook blocks until the test releases it. */
async function mountBlockingHook(): Promise<{
  readonly ctx: Context
  readonly harness: AgentLoopTestHarness
  readonly serviceFiber: Fiber
  readonly order: string[]
  readonly release: () => void
  readonly off: () => void
}> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const serviceFiber = await ctx.plugin(Dafeiyu, {})
  const harness = await mountAgentLoopTestHarness(ctx)
  const order: string[] = []
  let release: () => void = () => {}
  const off = ctx.dafeiyu.register({
    id: 'memory',
    contractVersion: 1,
    config: {},
    create: () => ({
      scope: 'all',
      onTurnEnd: async () => {
        order.push('enter')
        await new Promise<void>((resolve) => { release = resolve })
        order.push('finish')
      },
      dispose: () => { order.push('dispose') },
    }),
  })
  await settle()
  return { ctx, harness, serviceFiber, order, release: () => { release() }, off }
}

test('retiring a capability waits for an admitted turn hook (DH-304)', async () => {
  const { ctx, harness, order, release, off } = await mountBlockingHook()
  const root = await harness.create(SessionId('root-retire-hook'))
  emitTurnEnd(root.session, 1, { kind: 'completed' })
  await until(() => order.includes('enter'))

  off()
  await settle()
  expect(order).toEqual(['enter'])
  expect(ctx.dafeiyu.status()).toEqual([])

  release()
  await until(() => order.includes('finish') && order.includes('dispose'))
  expect(order).toEqual(['enter', 'finish', 'dispose'])
})

test('unloading the organizer waits for an admitted turn hook (DH-304)', async () => {
  const { harness, serviceFiber, order, release } = await mountBlockingHook()
  const root = await harness.create(SessionId('root-unload-hook'))
  emitTurnEnd(root.session, 1, { kind: 'completed' })
  await until(() => order.includes('enter'))

  let finished = false
  const disposal = serviceFiber.dispose().then(() => { finished = true })
  await settle()
  expect(finished).toBe(false)
  expect(order).toEqual(['enter'])

  release()
  await disposal
  expect(order).toEqual(['enter', 'finish', 'dispose'])
})
