/**
 * State-channel tests: the `persona_state` tool over the real tool runtime and the depth-0
 * `persona-state` message on the live session surface.
 */
import { afterEach, beforeEach, expect, test } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import {
  callTool,
  createAgent,
  mountPersona,
  personaStateMessages,
  runCommand,
  textOf,
  writeCard,
} from './harness.ts'
import type { PersonaTestHarness } from './harness.ts'

const STATE_SCHEMA = {
  type: 'object',
  properties: {
    affinity: { type: 'number', minimum: 0, maximum: 100 },
    mood: { type: 'string' },
  },
  required: ['affinity'],
  additionalProperties: false,
}

let home: string
let previousHome: string | undefined
let contexts: Context[]
let mounted: PersonaTestHarness | undefined

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-persona-state-'))
  previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  await mkdir(join(home, 'persona'), { recursive: true })
  await writeCard(home, 'alice', 'Alice', { stateSchema: STATE_SCHEMA })
  await writeCard(home, 'bob', 'Bob')
  contexts = []
})

afterEach(async () => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  await rm(home, { recursive: true, force: true })
})

/** Mount the composition with the stateful card active. */
async function mount(): Promise<PersonaTestHarness> {
  const ctx = new Context()
  contexts.push(ctx)
  mounted = await mountPersona(ctx, { active: 'alice' })
  return mounted
}

/** Latest state message text on the log. */
function latestStateText(harness: PersonaTestHarness, agent: Parameters<typeof personaStateMessages>[0]): string {
  void harness
  const messages = personaStateMessages(agent)
  expect(messages.length).toBeGreaterThan(0)
  return messages.at(-1)?.text ?? ''
}

test('a patch records state and appends one depth-0 message', async () => {
  const harness = await mount()
  const agent = await createAgent(harness, 'state-patch')
  const before = agent.session.surface.nodes.length

  const result = await callTool(harness, agent, 'persona_state', { action: 'patch', values: { affinity: 10 } })
  const text = textOf(result)
  expect(text).toContain('"affinity":10')
  expect(agent.session.surface.nodes.length).toBe(before + 1)
  expect(latestStateText(harness, agent)).toContain('"affinity":10')
})

test('a second patch merges and replaces the state message instead of appending one', async () => {
  const harness = await mount()
  const agent = await createAgent(harness, 'state-merge')
  await callTool(harness, agent, 'persona_state', { action: 'patch', values: { affinity: 10 } })
  const withMessage = agent.session.surface.nodes.length

  const result = await callTool(harness, agent, 'persona_state', { action: 'patch', values: { mood: 'curious' } })
  expect(textOf(result)).toContain('"mood":"curious"')
  expect(textOf(result)).toContain('"affinity":10')
  expect(agent.session.surface.nodes.length).toBe(withMessage)
  expect(latestStateText(harness, agent)).toContain('"mood":"curious"')
})

test('an invalid patch is refused with the failing field', async () => {
  const harness = await mount()
  const agent = await createAgent(harness, 'state-invalid')

  const result = await callTool(harness, agent, 'persona_state', { action: 'patch', values: { affinity: 200 } })
  expect(textOf(result)).toContain('must be <= 100')
  expect(personaStateMessages(agent)).toHaveLength(0)

  const missing = await callTool(harness, agent, 'persona_state', { action: 'patch', values: { mood: 'calm' } })
  expect(textOf(missing)).toContain('affinity is required')

  const extra = await callTool(harness, agent, 'persona_state', { action: 'patch', values: { affinity: 1, color: 'red' } })
  expect(textOf(extra)).toContain('color is not declared by the card')
})

test('show reads the state and revert restores a recorded revision', async () => {
  const harness = await mount()
  const agent = await createAgent(harness, 'state-revert')
  await callTool(harness, agent, 'persona_state', { action: 'patch', values: { affinity: 10 } })
  await callTool(harness, agent, 'persona_state', { action: 'patch', values: { mood: 'curious' } })

  const shown = await callTool(harness, agent, 'persona_state', { action: 'show' })
  expect(textOf(shown)).toContain('"affinity":10')
  expect(textOf(shown)).toContain('"mood":"curious"')

  const reverted = await callTool(harness, agent, 'persona_state', { action: 'revert', version: 1 })
  expect(textOf(reverted)).toContain('"affinity":10')
  expect(textOf(reverted)).not.toContain('"mood"')
  expect(latestStateText(harness, agent)).toContain('"affinity":10')

  const unknown = await callTool(harness, agent, 'persona_state', { action: 'revert', version: 99 })
  expect(textOf(unknown)).toContain('no revision 99')
})

test('clear drops the state and leaves a cleared depth-0 message', async () => {
  const harness = await mount()
  const agent = await createAgent(harness, 'state-clear')
  await callTool(harness, agent, 'persona_state', { action: 'patch', values: { affinity: 10 } })

  const cleared = await callTool(harness, agent, 'persona_state', { action: 'clear' })
  expect(textOf(cleared)).toContain('No state is recorded')
  expect(latestStateText(harness, agent)).toContain('No state is recorded')
})

test('a card without state_schema refuses the tool', async () => {
  const harness = await mount()
  const agent = await createAgent(harness, 'state-no-schema')
  await runCommand(harness, agent, '/persona use bob')

  const result = await callTool(harness, agent, 'persona_state', { action: 'patch', values: { x: 1 } })
  expect(textOf(result)).toContain('declares no state_schema')
})

test('switching to a card without state hides the previous state message', async () => {
  const harness = await mount()
  const agent = await createAgent(harness, 'state-switch')
  await callTool(harness, agent, 'persona_state', { action: 'patch', values: { affinity: 10 } })
  expect(latestStateText(harness, agent)).toContain('"affinity":10')

  await runCommand(harness, agent, '/persona use bob')
  expect(latestStateText(harness, agent)).toContain('No state is recorded')
})

test('each session owns its state', async () => {
  const harness = await mount()
  const first = await createAgent(harness, 'state-first')
  const second = await createAgent(harness, 'state-second')

  await callTool(harness, first, 'persona_state', { action: 'patch', values: { affinity: 42 } })
  const secondState = await callTool(harness, second, 'persona_state', { action: 'show' })
  expect(textOf(secondState)).toContain('No state is recorded')
  expect(personaStateMessages(second)).toHaveLength(0)
  expect(latestStateText(harness, first)).toContain('"affinity":42')
})
