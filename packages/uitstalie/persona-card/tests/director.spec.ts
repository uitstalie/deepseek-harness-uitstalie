/**
 * Director-note tests: the `/director` command, the depth-0 `director-note` message, replacement on
 * update, the cleared placeholder, and re-publication at a completed turn end.
 */
import { afterEach, beforeEach, expect, test } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  DIRECTOR_NOTE_CLEARED,
  DIRECTOR_NOTE_MAX_BYTES,
} from '../src/index.ts'
import {
  createAgent,
  directorMessages,
  mountPersona,
  runCommand,
  waitFor,
  writeCard,
} from './harness.ts'
import type { PersonaTestHarness } from './harness.ts'

let home: string
let previousHome: string | undefined
let contexts: Context[]
let mounted: PersonaTestHarness

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-persona-director-'))
  previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  await mkdir(join(home, 'persona'), { recursive: true })
  await writeCard(home, 'alice', 'Alice')
  contexts = []
  const ctx = new Context()
  contexts.push(ctx)
  mounted = await mountPersona(ctx, { active: 'alice' })
})

afterEach(async () => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  await rm(home, { recursive: true, force: true })
})

/** Latest note message text. */
function latestNote(agent: Agent): string | undefined {
  return directorMessages(agent).at(-1)?.text
}

test('a session starts without a director note', async () => {
  const agent = await createAgent(mounted, 'director-none')
  expect(directorMessages(agent)).toHaveLength(0)

  const shown = await runCommand(mounted, agent, '/director')
  expect(shown.kind).toBe('success')
  expect(shown.text).toContain('No director note')
})

test('/director set publishes one depth-0 message and /director shows it', async () => {
  const agent = await createAgent(mounted, 'director-set')
  const result = await runCommand(mounted, agent, '/director set keep the scene tense and brief')
  expect(result.kind).toBe('success')

  const messages = directorMessages(agent)
  expect(messages).toHaveLength(1)
  expect(messages[0]?.text).toContain('keep the scene tense and brief')

  const shown = await runCommand(mounted, agent, '/director show')
  expect(shown.text).toContain('keep the scene tense and brief')
})

test('a second set replaces the note instead of appending another message', async () => {
  const agent = await createAgent(mounted, 'director-replace')
  await runCommand(mounted, agent, '/director set first')
  const afterFirst = agent.session.surface.nodes.length

  await runCommand(mounted, agent, '/director set second scene')
  expect(agent.session.surface.nodes.length).toBe(afterFirst)
  expect(latestNote(agent)).toContain('second scene')
  expect(latestNote(agent)).not.toContain('first')
})

test('/director clear leaves one cleared placeholder', async () => {
  const agent = await createAgent(mounted, 'director-clear')
  await runCommand(mounted, agent, '/director set a note')
  const cleared = await runCommand(mounted, agent, '/director clear')
  expect(cleared.kind).toBe('success')

  expect(latestNote(agent)).toContain(DIRECTOR_NOTE_CLEARED)
  expect(directorMessages(agent)).toHaveLength(2)
  expect((await runCommand(mounted, agent, '/director')).text).toContain('No director note')
})

test('a completed turn republishes the note at depth 0', async () => {
  const agent = await createAgent(mounted, 'director-turn')
  await runCommand(mounted, agent, '/director set stay in the storm scene')

  agent.session.append('turn/start', { turn: 1 })
  agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await waitFor(() => directorMessages(agent).length >= 2 ? true : undefined)

  const messages = directorMessages(agent)
  expect(messages.length).toBeGreaterThanOrEqual(2)
  expect(messages.at(-1)?.text).toContain('stay in the storm scene')
})

test('invalid notes and grammar are refused with the limit named', async () => {
  const agent = await createAgent(mounted, 'director-invalid')

  const empty = await runCommand(mounted, agent, '/director set   ')
  expect(empty.kind).toBe('error')
  expect(empty.text).toContain('non-empty')

  const long = await runCommand(mounted, agent, `/director set ${'x'.repeat(DIRECTOR_NOTE_MAX_BYTES + 1)}`)
  expect(long.kind).toBe('error')
  expect(long.text).toContain(String(DIRECTOR_NOTE_MAX_BYTES))

  const unknown = await runCommand(mounted, agent, '/director dance')
  expect(unknown.kind).toBe('error')
  expect(unknown.text).toContain('Unknown /director form')
})
