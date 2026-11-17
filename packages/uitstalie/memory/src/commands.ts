/**
 * The `/memory` maintenance command for the global memory store.
 *
 * The command is a human surface with three forms only: `list` (the default),
 * `stats`, and `forget --topic <topic>` or `forget --id <entry-id>`. The
 * workspace-summary forms (`summaries`, `pause`, `resume`, `prune`, `edit`,
 * `revert`) are gone with the per-workspace summary job; the old files stay
 * readable through the one-time migration.
 * @module @deepseek-ai/dsh-memory/commands
 */

import type { Context } from '@deepseek-ai/cordis'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { FsError } from '@deepseek-ai/dsh-fs'
import {
  GLOBAL_MEMORY_MAX_BYTES,
  GLOBAL_MEMORY_TOPICS,
  GlobalMemoryError,
  forgetGlobalEntries,
  globalMemoryArchivePath,
  globalMemoryPath,
  readGlobalMemory,
  readGlobalMemoryArchive,
} from './global-memory.ts'
import type { GlobalMemoryTopic } from './global-memory.ts'
import { truncateToBytes } from './text.ts'

/** Name of the one registered command; its subcommands ride the raw input. */
export const MEMORY_COMMAND_NAME = 'memory'

/** One-line grammar shown by every failure and advertised as the input hint. */
export const MEMORY_COMMAND_USAGE = 'Usage: /memory [list | stats | forget --topic <topic> | forget --id <entry-id>]'

/** Bytes of one entry text rendered by `list`; the full text stays in the file and in search. */
const LIST_TEXT_MAX_BYTES = 240

/**
 * Build the one `/memory` command definition.
 * @param ctx - context carrying `dshStore`.
 * @returns the definition to register with the command registry.
 */
export function memoryCommand(ctx: Context): CommandDefinition {
  return {
    definitionId: CommandDefinitionId('@deepseek-ai/dsh-memory'),
    name: MEMORY_COMMAND_NAME,
    description: 'Inspect or forget global memory entries',
    input: { hint: '[list | stats | forget --topic <topic> | forget --id <entry-id>]' },
    handler: invocation => execute(ctx, invocation),
  }
}

/**
 * Register `/memory` on a context that carries the command registry.
 * @param ctx - context carrying `commands` and `dshStore`.
 * @returns the registration disposer.
 */
export function registerMemoryCommands(ctx: Context): () => void {
  return ctx.commands.register(memoryCommand(ctx))
}

/** Dispatch one invocation; no input and `list` render the same view. */
async function execute(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  const input = invocation.rawInput.trim()
  try {
    if (input === '' || /^list(?=\s|$)/iu.test(input)) return await listEntries(ctx)
    if (/^stats(?=\s|$)/iu.test(input)) return await showStats(ctx)
    const forget = /^forget(?=\s|$)/iu.exec(input)
    if (forget !== null) return await forgetEntry(ctx, input.slice(forget[0].length).trim())
    return { kind: 'error', text: `Unknown /memory form ${JSON.stringify(input)}. ${MEMORY_COMMAND_USAGE}` }
  } catch (error: unknown) {
    if (error instanceof GlobalMemoryError || error instanceof FsError) return { kind: 'error', text: error.message }
    throw error
  }
}

/** Render every active global entry, bounded per entry. */
async function listEntries(ctx: Context): Promise<CommandResult> {
  const read = await readGlobalMemory(ctx)
  const entries = read.document?.entries ?? []
  if (entries.length === 0) {
    return { kind: 'success', text: `Global memory is empty. ${read.path}` }
  }
  const bytes = entries.reduce((total, entry) => total + Buffer.byteLength(entry.text, 'utf8'), 0)
  const lines = [
    `Global memory: ${String(entries.length)} active entr${entries.length === 1 ? 'y' : 'ies'}, `
    + `${String(bytes)} B of ${String(GLOBAL_MEMORY_MAX_BYTES)} B. File: ${read.path}`,
    ...entries.map(entry =>
      `- [${entry.topic}] ${truncateToBytes(entry.text, LIST_TEXT_MAX_BYTES)} (${entry.createdAt}, id ${entry.id})`),
  ]
  return { kind: 'success', text: lines.join('\n') }
}

/** Render counts and paths for both the active file and the archive. */
async function showStats(ctx: Context): Promise<CommandResult> {
  const active = await readGlobalMemory(ctx)
  const archive = await readGlobalMemoryArchive(ctx)
  const activeEntries = active.document?.entries ?? []
  const archivedEntries = archive.document?.entries ?? []
  const topology = GLOBAL_MEMORY_TOPICS.map((topic) => {
    const count = activeEntries.filter(entry => entry.topic === topic).length
    return `${topic} ${String(count)}`
  }).join(', ')
  const bytes = activeEntries.reduce((total, entry) => total + Buffer.byteLength(entry.text, 'utf8'), 0)
  return {
    kind: 'success',
    text: [
      `Active: ${String(activeEntries.length)} entr${activeEntries.length === 1 ? 'y' : 'ies'} (${topology}) in ${active.path}`,
      `Bytes: ${String(bytes)} B of ${String(GLOBAL_MEMORY_MAX_BYTES)} B; revision ${String(active.document?.version ?? 0)}.`,
      `Archived: ${String(archivedEntries.length)} entr${archivedEntries.length === 1 ? 'y' : 'ies'} in ${archive.path} `
      + '(searchable with memory_search includeArchived; never injected).',
    ].join('\n'),
  }
}

/** Parse and execute `forget --topic <topic>` or `forget --id <entry-id>`. */
async function forgetEntry(ctx: Context, rest: string): Promise<CommandResult> {
  const topic = /^--topic\s+(\S+)$/iu.exec(rest)
  if (topic !== null) {
    const value = topic[1] as string
    if (!(GLOBAL_MEMORY_TOPICS as readonly string[]).includes(value)) {
      return { kind: 'error', text: `Unknown global topic ${JSON.stringify(value)}; valid topics: ${GLOBAL_MEMORY_TOPICS.join(', ')}.` }
    }
    const result = await forgetGlobalEntries(ctx, { topic: value as GlobalMemoryTopic })
    return {
      kind: 'success',
      text: result.removed === 0
        ? `No active entry for ${value}; ${String(result.remaining)} remain.`
        : `Forgot the ${value} entry; ${String(result.remaining)} remain. The text stays in ${globalMemoryArchivePath()}.`,
    }
  }
  const id = /^--id\s+(\S+)$/iu.exec(rest)
  if (id !== null) {
    const result = await forgetGlobalEntries(ctx, { entryId: id[1] as string })
    return {
      kind: 'success',
      text: result.removed === 0
        ? `No global entry with that id; ${String(result.remaining)} active entries remain.`
        : `Forgot ${String(result.removed)} global entry; ${String(result.remaining)} active entries remain.`,
    }
  }
  return { kind: 'error', text: `\`forget\` needs --topic or --id. ${MEMORY_COMMAND_USAGE}` }
}

/** Absolute path of the active file, re-exported for diagnostics and tests. */
export { globalMemoryPath }
