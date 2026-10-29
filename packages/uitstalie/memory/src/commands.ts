/**
 * The `/memory` maintenance command: inspect the workspace summaries, pause or resume the automatic
 * summary job, and correct or revert one summary by hand.
 *
 * The command is a human surface over the same `MEMORY.md` the automatic job writes: an edit marks
 * the entry `source: manual` and bumps its revision, and every edit or revert is recorded in the
 * `MEMORY.history.json` sidecar so it can be reverted. The window schedule and the snapshot message
 * are untouched.
 * @module @deepseek-ai/dsh-memory/commands
 */

import type { Context } from '@deepseek-ai/cordis'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { Session } from '@deepseek-ai/dsh-session'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { MemorySettings } from './config.ts'
import {
  MemoryDocumentError,
  editMemorySummary,
  pruneMemorySession,
  readMemoryDocument,
  revertMemorySummary,
  setMemorySummaryPaused,
  summarizeMemoryEntries,
  summaryPaused,
} from './memory-file.ts'
import type { MemoryEntry, MemorySection } from './memory-file.ts'
import { MEMORY_ENTRY_KINDS } from './memory-file.ts'

/** Stable kind order for the `/memory stats` line. */
const MEMORY_ENTRY_LABELS = MEMORY_ENTRY_KINDS

/** Name of the one registered command; its subcommands ride the raw input. */
export const MEMORY_COMMAND_NAME = 'memory'

/** One-line grammar shown by every failure and advertised as the input hint. */
export const MEMORY_COMMAND_USAGE = 'Usage: /memory [summaries | stats | prune [keep] | pause | resume | edit <turn> <text> | revert <turn>]'

/**
 * Build the one `/memory` command definition.
 * @param ctx - context carrying `dshStore`.
 * @param settings - resolved provider settings, used for the body budget and a new document's window.
 * @returns the definition to register with the command registry.
 */
export function memoryCommand(ctx: Context, settings: MemorySettings): CommandDefinition {
  return {
    definitionId: CommandDefinitionId('@deepseek-ai/dsh-memory'),
    name: MEMORY_COMMAND_NAME,
    description: 'Inspect, prune, pause, resume, edit, or revert this workspace\'s memory summaries',
    input: { hint: '[summaries | stats | prune [keep] | pause | resume | edit <turn> <text> | revert <turn>]' },
    handler: invocation => execute(ctx, settings, invocation),
  }
}

/**
 * Register `/memory` on a context that carries the command registry.
 * @param ctx - context carrying `commands` and `dshStore`.
 * @param settings - resolved provider settings.
 * @returns the registration disposer.
 */
export function registerMemoryCommands(ctx: Context, settings: MemorySettings): () => void {
  return ctx.commands.register(memoryCommand(ctx, settings))
}

/** Dispatch one invocation; no input and `summaries` render the same view. */
async function execute(ctx: Context, settings: MemorySettings, invocation: CommandInvocation): Promise<CommandResult> {
  const input = invocation.rawInput.trim()
  try {
    if (input === '' || /^summaries(?=\s|$)/iu.test(input)) return await listSummaries(ctx, invocation.agent.session)
    if (/^stats(?=\s|$)/iu.test(input)) return await showStats(ctx, invocation.agent.session, settings)
    const prune = /^prune(?=\s|$)/iu.exec(input)
    if (prune !== null) return await pruneEntries(ctx, invocation.agent.session, settings, input.slice(prune[0].length).trim())
    if (/^pause(?=\s|$)/iu.test(input) && input.slice('pause'.length).trim() === '') return await setPaused(ctx, invocation.agent.session, settings, true)
    if (/^resume(?=\s|$)/iu.test(input) && input.slice('resume'.length).trim() === '') return await setPaused(ctx, invocation.agent.session, settings, false)
    const edit = /^edit(?=\s|$)/iu.exec(input)
    if (edit !== null) return await editOne(ctx, invocation.agent.session, settings, input.slice(edit[0].length).trim())
    const revert = /^revert(?=\s|$)/iu.exec(input)
    if (revert !== null) return await revertOne(ctx, invocation.agent.session, settings, input.slice(revert[0].length).trim())
    return { kind: 'error', text: `Unknown /memory form ${JSON.stringify(input)}. ${MEMORY_COMMAND_USAGE}` }
  } catch (error: unknown) {
    if (error instanceof MemoryDocumentError || error instanceof FsError) return { kind: 'error', text: error.message }
    throw error
  }
}

/** Render this session's sections, their entries, and whether the automatic job runs. */
async function listSummaries(ctx: Context, session: Session): Promise<CommandResult> {
  const read = await readMemoryDocument(ctx, session)
  const document = read.document
  if (document === undefined) return { kind: 'success', text: `No memory summaries yet: ${read.path} does not exist.` }
  const sections = document.sections.filter(section => section.sessionId === String(session.id))
  const lines = [
    `Memory summaries in ${read.path} (automatic job: ${summaryPaused(document) ? 'paused' : 'running'}).`,
  ]
  if (sections.length === 0) {
    lines.push('This session has no summarized turns yet.')
  } else {
    for (const section of sections) lines.push(...renderSection(section))
  }
  lines.push(MEMORY_COMMAND_USAGE)
  return { kind: 'success', text: lines.join('\n') }
}

/** Render this session's entry counts, bytes, kinds, turn span, and the configured cap. */
async function showStats(ctx: Context, session: Session, settings: MemorySettings): Promise<CommandResult> {
  const read = await readMemoryDocument(ctx, session)
  if (read.document === undefined) return { kind: 'success', text: `No memory entries yet: ${read.path} does not exist.` }
  const stats = summarizeMemoryEntries(read.document, String(session.id))
  const kinds = MEMORY_ENTRY_LABELS
    .filter(kind => stats.kinds[kind] > 0)
    .map(kind => `${kind} ${String(stats.kinds[kind])}`)
    .join(', ')
  const lines = [
    `Memory entries in ${read.path}:`,
    `Total: ${String(stats.entries)} (auto ${String(stats.auto)}, manual ${String(stats.manual)}); ${String(stats.bytes)} bytes; cap ${String(settings.maxEntries)} per session.`,
    `Kinds: ${kinds === '' ? 'none' : kinds}.`,
    stats.turns === undefined ? 'Turns: none attributed.' : `Turns: ${String(stats.turns[0])}–${String(stats.turns[1])}.`,
  ]
  if (stats.entries > settings.maxEntries) {
    lines.push(`Over the cap: /memory prune drops the oldest whole sections to ${String(settings.maxEntries)} entries.`)
  }
  lines.push(MEMORY_COMMAND_USAGE)
  return { kind: 'success', text: lines.join('\n') }
}

/** Drop duplicate entries and over-cap sections, optionally with an explicit keep count. */
async function pruneEntries(
  ctx: Context,
  session: Session,
  settings: MemorySettings,
  argument: string,
): Promise<CommandResult> {
  let keep = settings.maxEntries
  if (argument !== '') {
    if (!/^\d+$/u.test(argument)) {
      return { kind: 'error', text: `Prune takes one optional positive entry cap, for example /memory prune 20. ${MEMORY_COMMAND_USAGE}` }
    }
    keep = Number(argument)
    if (!Number.isSafeInteger(keep) || keep < 1) {
      return { kind: 'error', text: `The prune cap must be a positive integer. ${MEMORY_COMMAND_USAGE}` }
    }
  }
  const result = await pruneMemorySession(ctx, session, { keep }, undefined, {
    window: settings.window,
    maxBytes: settings.maxBytes,
    maxEntries: keep,
  })
  return {
    kind: 'success',
    text: `Pruned ${result.path}: removed ${String(result.duplicates)} duplicate(s) and ${String(result.overCap)} over-cap entries; ${String(result.remaining)} remain (cap ${String(result.keep)}).`,
  }
}

/** Pause or resume the automatic job. */
async function setPaused(ctx: Context, session: Session, settings: MemorySettings, paused: boolean): Promise<CommandResult> {
  const result = await setMemorySummaryPaused(ctx, session, paused, undefined, {
    window: settings.window,
    maxBytes: settings.maxBytes,
  })
  return {
    kind: 'success',
    text: paused
      ? `Automatic summaries paused in ${result.path}; completed turns stay unsummarized until /memory resume.`
      : `Automatic summaries resumed in ${result.path}; the next completed turn continues from the current window.`,
  }
}

/** Parse `<turn> <text>` and replace the entry. */
async function editOne(ctx: Context, session: Session, settings: MemorySettings, argument: string): Promise<CommandResult> {
  const parsed = parseTurnArgument(argument, 'edit')
  if ('error' in parsed) return parsed.error
  if (parsed.text === '') {
    return { kind: 'error', text: `Edit needs replacement text after the turn number. ${MEMORY_COMMAND_USAGE}` }
  }
  const result = await editMemorySummary(ctx, session, { turn: parsed.turn }, parsed.text, undefined, {
    window: settings.window,
    maxBytes: settings.maxBytes,
  })
  return {
    kind: 'success',
    text: `Updated the summary for turn ${String(result.turn)} (version ${String(result.version ?? '?')}, ${result.tier}) in ${result.path}.`,
  }
}

/** Parse `<turn>` and restore the latest recorded text. */
async function revertOne(ctx: Context, session: Session, settings: MemorySettings, argument: string): Promise<CommandResult> {
  const parsed = parseTurnArgument(argument, 'revert')
  if ('error' in parsed) return parsed.error
  const result = await revertMemorySummary(ctx, session, { turn: parsed.turn }, undefined, {
    window: settings.window,
    maxBytes: settings.maxBytes,
  })
  return {
    kind: 'success',
    text: `Reverted the summary for turn ${String(result.turn)} (${result.tier}) in ${result.path}.`,
  }
}

/** One parsed `edit`/`revert` argument, or the error result explaining it. */
type ParsedTurnArgument =
  | { readonly turn: number; readonly text: string }
  | { readonly error: CommandResult }

/** Parse one turn argument and its optional trailing text. */
function parseTurnArgument(argument: string, verb: string): ParsedTurnArgument {
  const match = /^(?<turn>\d+)(?:(?<rest>[\s\S]*))?$/u.exec(argument.trim())
  const serialized = match?.groups?.['turn']
  if (serialized === undefined) {
    return {
      error: { kind: 'error', text: `${verb} needs a turn number first, for example /memory ${verb} 3. ${MEMORY_COMMAND_USAGE}` },
    }
  }
  const turn = Number(serialized)
  if (!Number.isSafeInteger(turn) || turn < 0) {
    return { error: { kind: 'error', text: `${verb} needs a non-negative turn number. ${MEMORY_COMMAND_USAGE}` } }
  }
  return { turn, text: (match?.groups?.['rest'] ?? '').trim() }
}

/** Render one section and its entries, marking manual edits and their revision. */
function renderSection(section: MemorySection): readonly string[] {
  const lines = [`- turns ${String(section.startTurn)}–${String(section.endTurn)} (${section.tier}):`]
  for (const entry of section.entries) lines.push(`  ${renderEntry(entry)}`)
  return lines
}

/** Render one entry with its kind, turn, source, revision, and labels. */
function renderEntry(entry: MemoryEntry): string {
  const details = [
    `[${entry.kind}]`,
    entry.turn === undefined ? undefined : `turn ${String(entry.turn)}`,
    entry.source === 'manual' ? `manual v${String(entry.version ?? 1)}` : 'auto',
    entry.tags === undefined || entry.tags.length === 0 ? undefined : `tags: ${entry.tags.join(', ')}`,
    entry.text,
  ].filter((part): part is string => part !== undefined)
  return details.join(' · ')
}
