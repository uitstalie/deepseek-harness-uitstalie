/**
 * Composition tests: the real persona-card provider over the real agent loop, organizer, system
 * prompt, and command registry. They cover the capability gate, per-session selection, `/persona`,
 * file-watch refresh, and disposal.
 */
import { afterEach, beforeEach, expect, test } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { PERSONA_CARD_SECTION_NAME, PERSONA_CARD_SECTION_ORDER } from '../src/index.ts'
import {
  createAgent,
  mountPersona,
  personaSections,
  runCommand,
  waitFor,
  writeCard,
} from './harness.ts'
import type { PersonaMountOptions, PersonaTestHarness } from './harness.ts'

let home: string
let previousHome: string | undefined
let contexts: Context[]
let mounted: PersonaTestHarness | undefined

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-persona-composition-'))
  previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  await mkdir(join(home, 'persona'), { recursive: true })
  await writeCard(home, 'alice', 'Alice')
  await writeCard(home, 'bob', 'Bob')
  contexts = []
})

afterEach(async () => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  await rm(home, { recursive: true, force: true })
})

/** Mount the composition into a fresh owned context. */
async function mount(options: PersonaMountOptions = { active: 'alice' }): Promise<PersonaTestHarness> {
  const ctx = new Context()
  contexts.push(ctx)
  mounted = await mountPersona(ctx, options)
  return mounted
}

/** Assemble and return the single expected section. */
async function sectionOf(harness: PersonaTestHarness, agent: Agent): Promise<string> {
  const sections = await personaSections(harness, agent)
  expect(sections).toHaveLength(1)
  return sections[0]?.text ?? ''
}

test('the configured card is injected once, at order 50', async () => {
  const harness = await mount()
  const agent = await createAgent(harness, 'persona-a')

  const sections = await personaSections(harness, agent)
  expect(sections).toHaveLength(1)
  expect(sections[0]?.name).toBe(PERSONA_CARD_SECTION_NAME)
  expect(sections[0]?.text).toContain('Alice')
  expect(sections[0]?.text).not.toContain('Bob')
  // After the deployment prefix (0) and before `personality` (100).
  expect(PERSONA_CARD_SECTION_ORDER).toBe(50)
})

test('a closed capability gate registers no section', async () => {
  const harness = await mount({ active: 'alice', enabled: false })
  const agent = await createAgent(harness, 'persona-off')

  expect(harness.ctx.dafeiyu.status().find(entry => entry.id === 'persona')?.state).toBe('disabled')
  expect(await personaSections(harness, agent)).toHaveLength(0)
})

test('/persona use switches only the invoking session', async () => {
  const harness = await mount()
  const first = await createAgent(harness, 'persona-first')
  const second = await createAgent(harness, 'persona-second')
  expect(await sectionOf(harness, first)).toContain('Alice')
  expect(await sectionOf(harness, second)).toContain('Alice')

  const result = await runCommand(harness, first, '/persona use bob')
  expect(result.kind).toBe('success')
  expect(result.text).toContain('bob')

  expect(await sectionOf(harness, first)).toContain('Bob')
  expect(await sectionOf(harness, second)).toContain('Alice')
})

test('/persona off suppresses only the invoking session', async () => {
  const harness = await mount()
  const first = await createAgent(harness, 'persona-off-first')
  const second = await createAgent(harness, 'persona-off-second')

  const result = await runCommand(harness, first, '/persona off')
  expect(result.kind).toBe('success')

  expect(await sectionOf(harness, first)).toBe('')
  expect(await sectionOf(harness, second)).toContain('Alice')
})

test('/persona and /persona list render the cards and the current marker', async () => {
  const harness = await mount()
  const agent = await createAgent(harness, 'persona-list')

  const bare = await runCommand(harness, agent, '/persona')
  expect(bare.kind).toBe('success')
  expect(bare.text).toContain('(2)')
  expect(bare.text).toContain('- alice (current)')
  expect(bare.text).toContain('- bob')
  expect(bare.text).toContain("from the row's `active` card")

  const listed = await runCommand(harness, agent, '/persona list')
  expect(listed.text).toBe(bare.text)
})

test('an unknown card is refused and names the installed cards', async () => {
  const harness = await mount()
  const agent = await createAgent(harness, 'persona-unknown')

  const result = await runCommand(harness, agent, '/persona use carol')
  expect(result.kind).toBe('error')
  expect(result.text).toContain('No persona card "carol"')
  expect(result.text).toContain('Known cards: alice, bob')
})

test('a card written after mount is watched without a reload', async () => {
  const harness = await mount()
  const agent = await createAgent(harness, 'persona-watch')
  await writeCard(home, 'carol', 'Carol')

  const listed = await waitFor(async () => {
    const result = await runCommand(harness, agent, '/persona list')
    return result.kind === 'success' && (result.text ?? '').includes('carol') ? result.text : undefined
  })
  expect(listed).toContain('- carol')

  const used = await runCommand(harness, agent, '/persona use carol')
  expect(used.kind).toBe('success')
  expect(await sectionOf(harness, agent)).toContain('Carol')
})

test('disposing the provider removes the section and the command', async () => {
  const harness = await mount()
  const agent = await createAgent(harness, 'persona-dispose')
  expect(await personaSections(harness, agent)).toHaveLength(1)
  expect(harness.ctx.commands.find(agent, 'persona')).toBeDefined()

  await harness.personaFiber.dispose()

  expect(await personaSections(harness, agent)).toHaveLength(0)
  expect(harness.ctx.commands.find(agent, 'persona')).toBeUndefined()
})
