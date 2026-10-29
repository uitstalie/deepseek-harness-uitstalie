/**
 * Real-composition harness for the persona-card specs: the real agent loop, agent and session
 * registries, system prompt, command registry, the dafeiyu organizer, and the persona-card provider
 * mounted as a capability. Cards live in a temporary `DSH_HOME/persona` directory owned by the spec.
 * @module test-support/persona-harness
 */

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import Dafeiyu from '@deepseek-ai/dsh-dafeiyu'
import { SessionId } from '@deepseek-ai/dsh-session'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import {
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
} from '@deepseek-ai/dsh-agent-loop-testkit'
import type { AgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as PersonaCard from '../src/index.ts'
import type { Config } from '../src/provider.ts'

/** Services and helpers bound to one mounted persona-card composition. */
export interface PersonaTestHarness {
  /** Context owning every mounted service. */
  readonly ctx: Context
  /** Production agent driver mounted by the testkit. */
  readonly harness: AgentLoopTestHarness
  /** Fiber of the mounted persona-card provider, owned by {@link PersonaTestHarness.ctx}. */
  readonly personaFiber: Fiber
}

/** What one mounted persona-card composition enables. */
export interface PersonaMountOptions {
  /** Row `active` card; absent leaves sessions without a selection with no persona. */
  readonly active?: string
  /** Injection budget; absent uses the schema default. */
  readonly maxBytes?: number
  /** Whether the capability gate is open; defaults to open. */
  readonly enabled?: boolean
}

/**
 * Mount the real services and the provider into a caller-owned context.
 * @param ctx - caller-owned context that will own every mounted service.
 * @param options - the capability gate and the row configuration.
 * @returns the mounted services and the provider fiber.
 */
export async function mountPersona(ctx: Context, options: PersonaMountOptions = {}): Promise<PersonaTestHarness> {
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(Dafeiyu, { capabilities: { persona: { enabled: options.enabled ?? true } } })
  const plugin = {
    name: PersonaCard.name,
    inject: PersonaCard.inject,
    apply(pluginCtx: Context, config: Config) {
      PersonaCard.apply(pluginCtx, config)
    },
  }
  const config: Config = {
    ...(options.active === undefined ? {} : { active: options.active }),
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
  }
  const personaFiber = await ctx.plugin(plugin as never, config as never)
  const harness = await mountAgentLoopTestHarness(ctx)
  return { ctx, harness, personaFiber }
}

/**
 * Create one root agent with a fresh session.
 * @param mounted - the mounted composition.
 * @param id - agent and session identity.
 * @returns the published agent.
 */
export async function createAgent(mounted: PersonaTestHarness, id: string): Promise<Agent> {
  return mounted.harness.create(SessionId(id))
}

/**
 * Assemble the prompt for one agent and return its `persona` sections.
 * @param mounted - the mounted composition.
 * @param agent - the agent to assemble for.
 * @returns every registered `persona` section, in assembly order.
 */
export async function personaSections(
  mounted: PersonaTestHarness,
  agent: Agent,
): Promise<readonly { readonly name: string; readonly text: string }[]> {
  const assembly = await mounted.ctx.systemPrompt.assemble(assembleContextFor(agent))
  return assembly.sections.filter(section => section.name === PersonaCard.PERSONA_CARD_SECTION_NAME)
}

/**
 * Run one slash command through the real registry and return its settled result.
 * @param mounted - the mounted composition.
 * @param agent - the agent issuing the command.
 * @param line - the complete slash-command line.
 * @returns the settled command result.
 */
export async function runCommand(mounted: PersonaTestHarness, agent: Agent, line: string): Promise<CommandResult> {
  const execution = await mounted.ctx.commands.execute(agent, line, [], new AbortController().signal)
  if (execution === undefined) throw new Error(`command "${line}" did not resolve`)
  return execution.result
}

/**
 * Write one `persona/v1` card into the fixture home.
 * @param home - the fixture `DSH_HOME` directory.
 * @param id - card id (file name without `.md`).
 * @param displayName - the card's `name` field.
 * @returns the written path.
 */
export async function writeCard(home: string, id: string, displayName: string): Promise<string> {
  const path = join(home, PersonaCard.PERSONA_CARDS_DIRECTORY, `${id}.md`)
  await writeFile(path, [
    '---',
    'schema: persona/v1',
    `name: ${displayName}`,
    `description: ${displayName} is a fixture persona.`,
    '---',
    '',
  ].join('\n'), 'utf8')
  return path
}

/**
 * Poll a read until it returns a defined value.
 * @param read - value supplier; undefined keeps waiting.
 * @param timeoutMs - maximum wait before failing the spec.
 * @returns the first defined value.
 * @throws Error when the value stays undefined past the timeout.
 */
export async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value !== undefined) return value
    if (Date.now() >= deadline) throw new Error(`condition was not met within ${String(timeoutMs)}ms`)
    await new Promise<void>((resolve) => { setTimeout(resolve, 10) })
  }
}
