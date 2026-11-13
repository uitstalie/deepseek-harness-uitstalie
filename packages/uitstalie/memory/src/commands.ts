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
  forgetMemoryEntries,
  pruneMemorySession,
  readMemoryDocument,
  revertMemorySummary,
  setMemorySummaryPaused,
  summarizeMemoryEntries,
  summaryPaused,
} from './memory-file.ts'
import type { MemoryEntry, MemoryEntryKind, MemoryForgetFilter, MemorySection } from './memory-file.ts'
import { MEMORY_ENTRY_KINDS } from './memory-file.ts'

/** Stable kind order for the `/memory stats` line. */
const MEMORY_ENTRY_LABELS = MEMORY_ENTRY_KINDS

/** Name of the one registered command; its subcommands ride the raw input. */
export const MEMORY_COMMAND_NAME = 'memory'

/** One-line grammar shown by every failure and advertised as the input hint. */
export const MEMORY_COMMAND_USAGE = 'Usage: /memory [summaries | stats | prune [keep] | prune --kind <kind> --tag <tag> --before-turn <n> [--session <id> | --all-sessions] | forget --kind <kind> --tag <tag> --before-turn <n> [--session <id> | --all-sessions] | pause | resume | edit <turn> <text> | revert <turn>]'

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
    description: 'Inspect, prune, forget, pause, resume, edit, or revert this workspace\'s memory summaries',
    input: { hint: '[summaries | stats | prune [keep] | forget ... | pause | resume | edit <turn> <text> | revert <turn>]' },
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
    const forget = /^forget(?=\s|$)/iu.exec(input)
    if (forget !== null) return await forgetEntries(ctx, invocation.agent.session, settings, input.slice(forget[0].length).trim())
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
  const evictions = read.document.evictions ?? []
  if (evictions.length > 0) {
    const last = evictions.at(-1)
    if (last !== undefined) {
      lines.push(`Evictions: ${String(evictions.length)} recorded; last ${last.at} removed [${last.kind}] `
        + `${last.text.slice(0, 80)}${last.text.length > 80 ? '…' : ''} (${last.reason}: ${last.detail}).`)
    }
  }
  if (stats.entries > settings.maxEntries) {
    lines.push(`Over the cap: /memory prune drops the oldest whole sections to ${String(settings.maxEntries)} entries.`)
  }
  lines.push(MEMORY_COMMAND_USAGE)
  return { kind: 'success', text: lines.join('\n') }
}

/**
 * Drop duplicate entries and over-cap sections, or delete entries selected by a filter.
 *
 * `prune` without arguments keeps the configured per-session cap; a bare number keeps that many.
 * Filter options (`--kind`, `--tag`, `--before-turn`, `--session`, `--all-sessions`) switch to the
 * explicit forget path, which records each removal.
 */
async function pruneEntries(
  ctx: Context,
  session: Session,
  settings: MemorySettings,
  argument: string,
): Promise<CommandResult> {
  if (argument !== '' && !/^\d+$/u.test(argument)) {
    if (!argument.startsWith('--')) {
      return { kind: 'error', text: `Prune takes one optional positive entry cap, for example /memory prune 20. ${MEMORY_COMMAND_USAGE}` }
    }
    return forgetWithFilter(ctx, session, settings, argument, 'prune')
  }
  let keep = settings.maxEntries
  if (argument !== '') {
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

/** Delete entries selected by `/memory forget` or the filtered `/memory prune` form. */
async function forgetEntries(
  ctx: Context,
  session: Session,
  settings: MemorySettings,
  argument: string,
): Promise<CommandResult> {
  if (argument === '') {
    return { kind: 'error', text: `Forget needs at least one filter. ${MEMORY_COMMAND_USAGE}` }
  }
  return forgetWithFilter(ctx, session, settings, argument, 'forget')
}

/** Parse filter options, run the forget, and render what left. */
async function forgetWithFilter(
  ctx: Context,
  session: Session,
  settings: MemorySettings,
  argument: string,
  verb: string,
): Promise<CommandResult> {
  const parsed = parseForgetFilter(argument)
  if ('error' in parsed) return parsed.error
  const result = await forgetMemoryEntries(ctx, session, parsed.filter, undefined, {
    window: settings.window,
    maxBytes: settings.maxBytes,
    maxEntries: settings.maxEntries,
  })
  if (result.removed === 0) {
    return {
      kind: 'success',
      text: `No memory entries matched /memory ${verb} ${argument}; ${String(result.remaining)} remain in ${result.sessions.join(', ')}.`,
    }
  }
  const counts = MEMORY_ENTRY_LABELS
    .filter(kind => result.kinds[kind] > 0)
    .map(kind => `${kind} ${String(result.kinds[kind])}`)
    .join(', ')
  return {
    kind: 'success',
    text: `Forgot ${String(result.removed)} memory entr${result.removed === 1 ? 'y' : 'ies'} from ${result.sessions.join(', ')} (${counts}); ${String(result.remaining)} remain. Each removal is recorded in ${result.path}.`,
  }
}

/** One parsed filter or the command error explaining why it is invalid. */
type ParsedForgetFilter =
  | { readonly filter: MemoryForgetFilter }
  | { readonly error: CommandResult }

/** Parse `--kind`, `--tag`, `--before-turn`, `--session`, and `--all-sessions`. */
function parseForgetFilter(argument: string): ParsedForgetFilter {
  const tokens = tokenizeArguments(argument)
  if (tokens === undefined) {
    return { error: { kind: 'error', text: `Unbalanced quotes in the forget filter. ${MEMORY_COMMAND_USAGE}` } }
  }
  const values: {
    kind?: MemoryEntryKind
    tag?: string
    beforeTurn?: number
    sessionId?: string
    allSessions?: true
  } = {}
  let index = 0
  while (index < tokens.length) {
    const option = tokens[index] as string
    if (option === '--all-sessions') {
      values.allSessions = true
      index += 1
      continue
    }
    const value = tokens[index + 1]
    if (value === undefined) {
      return { error: { kind: 'error', text: `Option ${option} needs a value. ${MEMORY_COMMAND_USAGE}` } }
    }
    switch (option) {
      case '--kind': {
        const kind = MEMORY_ENTRY_KINDS.find(candidate => candidate === value)
        if (kind === undefined) {
          return { error: { kind: 'error', text: `Unknown kind ${JSON.stringify(value)}; use ${MEMORY_ENTRY_KINDS.join(', ')}. ${MEMORY_COMMAND_USAGE}` } }
        }
        values.kind = kind
        break
      }
      case '--tag':
        if (value.trim() === '') {
          return { error: { kind: 'error', text: `The tag must not be empty. ${MEMORY_COMMAND_USAGE}` } }
        }
        values.tag = value.trim()
        break
      case '--before-turn': {
        if (!/^\d+$/u.test(value)) {
          return { error: { kind: 'error', text: `--before-turn needs a non-negative integer. ${MEMORY_COMMAND_USAGE}` } }
        }
        const turn = Number(value)
        if (!Number.isSafeInteger(turn)) {
          return { error: { kind: 'error', text: `--before-turn is outside the safe integer range. ${MEMORY_COMMAND_USAGE}` } }
        }
        values.beforeTurn = turn
        break
      }
      case '--session':
        if (value.trim() === '') {
          return { error: { kind: 'error', text: `--session needs a session id. ${MEMORY_COMMAND_USAGE}` } }
        }
        values.sessionId = value.trim()
        break
      default:
        return { error: { kind: 'error', text: `Unknown forget option ${JSON.stringify(option)}. ${MEMORY_COMMAND_USAGE}` } }
    }
    index += 2
  }
  if (values.allSessions === true && values.sessionId !== undefined) {
    return { error: { kind: 'error', text: `Use either --session or --all-sessions, not both. ${MEMORY_COMMAND_USAGE}` } }
  }
  if (values.kind === undefined && values.tag === undefined && values.beforeTurn === undefined) {
    return { error: { kind: 'error', text: `Forget needs at least one of --kind, --tag, or --before-turn. ${MEMORY_COMMAND_USAGE}` } }
  }
  return { filter: values }
}

/** Split one command argument into quoted or whitespace-separated tokens. */
function tokenizeArguments(argument: string): string[] | undefined {
  const tokens: string[] = []
  let current = ''
  let quote: string | undefined
  let started = false
  for (const character of argument) {
    if (quote !== undefined) {
      if (character === quote) quote = undefined
      else current += character
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      started = true
      continue
    }
    if (/\s/u.test(character)) {
      if (started) {
        tokens.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += character
    started = true
  }
  if (quote !== undefined) return undefined
  if (started) tokens.push(current)
  return tokens
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
    text: `Updated the summary for turn ${result.turn} (version ${result.version ?? '?'}, ${result.tier}) in ${result.path}.`,
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
