/**
 * The `/persona` command: list the installed cards, select one for this session, or turn the
 * persona section off.
 *
 * The command is a human surface, not a model capability: it changes which card the next assembly
 * renders and never writes a card, the row configuration, or the session log. A selection is
 * process-local per session; restarting the process (or the session's agent after a restart) falls
 * back to the row's `active` card.
 * @module @deepseek-ai/dsh-persona-card/commands
 */

import type { Context } from '@deepseek-ai/cordis'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'

/** Name of the one registered command; `use`, `off`, and `list` ride its raw input. */
export const PERSONA_COMMAND_NAME = 'persona'

/** One-line grammar shown by every failure and advertised as the input hint. */
export const PERSONA_COMMAND_USAGE = 'Usage: /persona [list | use <id> | off]'

/**
 * What the command needs from the mounted provider.
 *
 * `selectionOf` distinguishes "this session chose nothing" (`undefined`, the row's `active` card
 * applies) from "this session turned the persona off" (`null`).
 */
export interface PersonaCommandTarget {
  /** Directory the provider reads cards from, rendered in list and failure output. */
  readonly directory: string
  /** Loaded card ids, sorted. */
  cards(): readonly string[]
  /** This session's explicit selection; `undefined` means the row default still applies. */
  selectionOf(sessionId: string): string | null | undefined
  /** The card the next assembly for this session renders; empty when the section is off. */
  effectiveOf(sessionId: string): string
  /** Set (`id`) or clear (`null`) this session's selection. */
  select(sessionId: string, selection: string | null): void
}

/**
 * Build the one `/persona` command definition.
 * @param target - the mounted provider's card view and selection store.
 * @returns the definition to register with the command registry.
 */
export function personaCommand(target: PersonaCommandTarget): CommandDefinition {
  return {
    definitionId: CommandDefinitionId('@deepseek-ai/dsh-persona-card'),
    name: PERSONA_COMMAND_NAME,
    description: 'List persona cards, use one for this session, or turn the persona off',
    input: { hint: '[list | use <id> | off]' },
    handler: invocation => execute(target, invocation),
  }
}

/**
 * Register `/persona` on a context that carries the command registry.
 * @param ctx - context carrying `commands`.
 * @param target - the mounted provider's card view and selection store.
 * @returns the registration disposer.
 */
export function registerPersonaCommands(ctx: Context, target: PersonaCommandTarget): () => void {
  return ctx.commands.register(personaCommand(target))
}

/** Dispatch one invocation: no input and `list` render the same view. */
function execute(target: PersonaCommandTarget, invocation: CommandInvocation): CommandResult {
  const sessionId = String(invocation.agent.session.id)
  const input = invocation.rawInput.trim()
  if (input === '' || /^list(?=\s|$)/iu.test(input)) return { kind: 'success', text: renderList(target, sessionId) }
  const use = /^use(?=\s|$)/iu.exec(input)
  if (use !== null) return useCard(target, sessionId, input.slice(use[0].length).trim())
  if (/^off(?=\s|$)/iu.test(input) && input.slice('off'.length).trim() === '') {
    target.select(sessionId, null)
    return { kind: 'success', text: 'Persona off for this session; the next assembly drops the section.' }
  }
  return {
    kind: 'error',
    text: `Unknown /persona form ${JSON.stringify(input)}. ${PERSONA_COMMAND_USAGE}`,
  }
}

/** Select one loaded card for the invoking session, naming the alternatives when it is missing. */
function useCard(target: PersonaCommandTarget, sessionId: string, id: string): CommandResult {
  if (id === '') return { kind: 'error', text: `Use needs a card id. ${PERSONA_COMMAND_USAGE}` }
  const known = target.cards()
  if (!known.includes(id)) {
    const installed = known.length === 0
      ? `No persona cards are installed in ${target.directory}.`
      : `Known cards: ${known.join(', ')}.`
    return { kind: 'error', text: `No persona card "${id}" in ${target.directory}. ${installed}` }
  }
  target.select(sessionId, id)
  return { kind: 'success', text: `Session persona set to "${id}"; the next assembly uses it.` }
}

/** Render every card, marking the one the next assembly uses, plus where the choice came from. */
function renderList(target: PersonaCommandTarget, sessionId: string): string {
  const known = target.cards()
  const effective = target.effectiveOf(sessionId)
  const selection = target.selectionOf(sessionId)
  const lines = [`Persona cards (${String(known.length)}) in ${target.directory}:`]
  if (known.length === 0) {
    lines.push('  (none)')
  } else {
    for (const id of known) lines.push(`  - ${id}${id === effective ? ' (current)' : ''}`)
  }
  if (selection === null) {
    lines.push('Current: off (this session turned the persona section off).')
  } else if (selection === undefined) {
    lines.push(effective === ''
      ? 'Current: none (the row\'s `active` card is empty).'
      : `Current: ${effective} (from the row\'s \`active\` card).`)
  } else {
    lines.push(`Current: ${effective} (selected for this session).`)
  }
  lines.push(PERSONA_COMMAND_USAGE)
  return lines.join('\n')
}
