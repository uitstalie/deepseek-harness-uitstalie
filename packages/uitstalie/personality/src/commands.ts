/**
 * The `/personality` drift-review command.
 *
 * The command grammar splits a slash line into one name plus verbatim input, so
 * one registered `personality` command carries three subcommands: `show`
 * renders the merged profile and its document versions, `diff` renders the
 * latest two global history records as a line diff, and `revert <version>`
 * restores one recorded managed block through the version-guarded write.
 * History review is global-only; `show` always reads the merged global and
 * overlay view.
 * @module @deepseek-ai/dsh-personality/commands
 */

import type { Context } from '@deepseek-ai/cordis'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { Session } from '@deepseek-ai/dsh-session'
import { FsError } from '@deepseek-ai/dsh-fs'
import { diffLines } from 'diff'
import type { PersonalitySettings } from './config.ts'
import {
  PERSONALITY_HISTORY_FILE_NAME,
  PersonalityDocumentError,
  readGlobalPersonalityHistory,
  readPersonality,
  revertGlobalPersonality,
} from './personality-file.ts'
import type {
  PersonalityEntryChange,
  PersonalityHistoryRead,
  PersonalityHistoryRecord,
  PersonalityRead,
} from './personality-file.ts'

/** Name of the one registered command; subcommands ride its raw input. */
export const PERSONALITY_COMMAND_NAME = 'personality'

/** One-line grammar shown by every failure and advertised as the input hint. */
export const PERSONALITY_COMMAND_USAGE = 'Usage: /personality [show|diff|revert <version>]'

/** Version history lines named in a revert failure at most. */
const KNOWN_VERSION_LIMIT = 10

/**
 * Render the merged profile: every entry id, kind, and one text line, plus the
 * document versions that produced the merged view.
 * @param ctx - context carrying `fs` and `dshStore`.
 * @param session - session whose workspace owns the overlay.
 * @param settings - resolved provider settings.
 * @param signal - cancellation for both file reads.
 * @returns a success result with the rendered profile, or an actionable error
 *   result when a profile file is invalid or unreadable.
 */
export async function showPersonality(
  ctx: Context,
  session: Session,
  settings: PersonalitySettings,
  signal?: AbortSignal,
): Promise<CommandResult> {
  try {
    const read = await readPersonality(ctx, session, settings, signal)
    return { kind: 'success', text: renderPersonalityProfile(read, settings) }
  } catch (error: unknown) {
    return commandFailure(error)
  }
}

/**
 * Render a line diff of the latest two global history records.
 * @param ctx - context carrying `fs`.
 * @param settings - resolved provider settings.
 * @param signal - cancellation for the history read.
 * @returns a success result with the diff, a success result explaining that
 *   fewer than two records exist, or an actionable error result when the
 *   history file is malformed.
 */
export async function diffPersonalityHistory(
  ctx: Context,
  settings: PersonalitySettings,
  signal?: AbortSignal,
): Promise<CommandResult> {
  let history: PersonalityHistoryRead
  try {
    history = await readGlobalPersonalityHistory(ctx, settings, signal)
  } catch (error: unknown) {
    return commandFailure(error)
  }
  const previous = history.records.at(-2)
  const latest = history.records.at(-1)
  if (previous === undefined || latest === undefined) {
    return { kind: 'success', text: describeMissingHistory(history.records.length) }
  }
  return {
    kind: 'success',
    text: [
      `Personality history diff: version ${String(previous.version)} (source: ${previous.source}) -> version ${String(latest.version)} (source: ${latest.source})`,
      ...renderBlockDiff(previous.block, latest.block),
    ].join('\n'),
  }
}

/**
 * Restore one history record's managed block into the global profile.
 *
 * The write is version-guarded, one stale conflict is retried after a re-read,
 * and the revert appends its own `source: 'user'` history line. Reverting to
 * the version the file already carries is a no-op.
 * @param ctx - context carrying `fs`.
 * @param session - session that requested the revert; recorded in the new history line.
 * @param settings - resolved provider settings.
 * @param argument - verbatim revert argument; must name one positive history version.
 * @param signal - cancellation for the reads, write, and history append.
 * @returns a success result describing the restore or the no-op, or an
 *   actionable error result for an invalid argument, an unknown version, or an
 *   invalid stored block.
 */
export async function revertPersonality(
  ctx: Context,
  session: Session,
  settings: PersonalitySettings,
  argument: string,
  signal?: AbortSignal,
): Promise<CommandResult> {
  const version = parsePersonalityVersion(argument)
  if (version === undefined) {
    return {
      kind: 'error',
      text: `Revert needs one positive history version, for example /personality revert 3. ${PERSONALITY_COMMAND_USAGE}`,
    }
  }
  let history: PersonalityHistoryRead
  try {
    history = await readGlobalPersonalityHistory(ctx, settings, signal)
  } catch (error: unknown) {
    return commandFailure(error)
  }
  const record = history.records.find(candidate => candidate.version === version)
  if (record === undefined) {
    return { kind: 'error', text: describeUnknownVersion(version, history.records) }
  }
  try {
    const outcome = await revertGlobalPersonality(ctx, session, settings, record, signal)
    if (outcome.kind === 'current') {
      return {
        kind: 'success',
        text: `The global profile is already at version ${String(outcome.version)}; nothing to revert.`,
      }
    }
    return {
      kind: 'success',
      text: `Restored version ${String(outcome.restored)} into ${outcome.path} as version ${String(outcome.revision)} (${summarizeChanges(outcome.diff)}).`,
    }
  } catch (error: unknown) {
    return commandFailure(error)
  }
}

/**
 * Build the one `/personality` command definition.
 * @param ctx - context carrying `commands`, `fs`, and `dshStore`.
 * @param settings - resolved provider settings.
 * @returns the definition to register with the command registry.
 */
export function personalityCommand(ctx: Context, settings: PersonalitySettings): CommandDefinition {
  return {
    definitionId: CommandDefinitionId('@deepseek-ai/dsh-personality'),
    name: PERSONALITY_COMMAND_NAME,
    description: 'Show, diff, or revert the personality profile',
    input: { hint: '[show|diff|revert <version>]' },
    handler: invocation => executePersonalityCommand(ctx, invocation, settings),
  }
}

/**
 * Register `/personality` on a context that carries the command registry.
 * @param ctx - context carrying `commands`, `fs`, and `dshStore`.
 * @param settings - resolved provider settings.
 * @returns the registration disposer.
 */
export function registerPersonalityCommands(ctx: Context, settings: PersonalitySettings): () => void {
  return ctx.commands.register(personalityCommand(ctx, settings))
}

/** One parsed `/personality` invocation. */
type PersonalitySubcommand =
  | { readonly kind: 'show' }
  | { readonly kind: 'diff' }
  | { readonly kind: 'revert'; readonly argument: string }

/** Parse the subcommand and its argument from the verbatim command input. */
function parsePersonalitySubcommand(rawInput: string): PersonalitySubcommand | undefined {
  const input = rawInput.trim()
  if (input.length === 0 || input.toLowerCase() === 'show') return { kind: 'show' }
  if (input.toLowerCase() === 'diff') return { kind: 'diff' }
  if (/^revert(?=\s|$)/iu.test(input)) {
    return { kind: 'revert', argument: input.slice('revert'.length).trim() }
  }
  return undefined
}

/** Dispatch one parsed invocation to its handler. */
async function executePersonalityCommand(
  ctx: Context,
  invocation: CommandInvocation,
  settings: PersonalitySettings,
): Promise<CommandResult> {
  const command = parsePersonalitySubcommand(invocation.rawInput)
  if (command === undefined) {
    return {
      kind: 'error',
      text: `Unknown /personality subcommand ${JSON.stringify(invocation.rawInput.trim())}. ${PERSONALITY_COMMAND_USAGE}`,
    }
  }
  switch (command.kind) {
    case 'show':
      return await showPersonality(ctx, invocation.agent.session, settings, invocation.signal)
    case 'diff':
      return await diffPersonalityHistory(ctx, settings, invocation.signal)
    case 'revert':
      return await revertPersonality(ctx, invocation.agent.session, settings, command.argument, invocation.signal)
    /* v8 ignore next 2 -- PersonalitySubcommand is closed and every member is handled above */
    default: return assertNever(command)
  }
}

/** Render the merged profile and the versions that produced it. */
function renderPersonalityProfile(read: PersonalityRead, settings: PersonalitySettings): string {
  const global = read.global.document === undefined
    ? 'none'
    : String(read.global.document.version)
  const overlay = !settings.workspaceOverlay
    ? 'disabled'
    : read.workspace?.document === undefined
      ? 'none'
      : `version ${String(read.workspace.document.version)}`
  const lines = ['Personality profile', `Global version: ${global}`, `Workspace overlay: ${overlay}`]
  if (read.entries.length === 0) {
    lines.push('No personality entries.')
  } else {
    lines.push(`Entries (${String(read.entries.length)}):`)
    for (const entry of read.entries) {
      lines.push(`- ${entry.id} [${entry.kind}] ${oneLine(entry.text)}`)
    }
  }
  return lines.join('\n')
}

/** Diff two managed blocks line by line, marking added and removed lines. */
function renderBlockDiff(before: string, after: string): readonly string[] {
  const lines: string[] = []
  for (const part of diffLines(before, after)) {
    const prefix = part.added ? '+' : part.removed ? '-' : ' '
    const body = part.value.endsWith('\n') ? part.value.slice(0, -1) : part.value
    if (body.length === 0) continue
    for (const line of body.split('\n')) lines.push(`${prefix}${line}`)
  }
  return lines
}

/** Collapse one entry paragraph onto one display line. */
function oneLine(text: string): string {
  return text.replaceAll(/\s+/gu, ' ').trim()
}

/** Parse a revert argument into one positive safe integer version. */
function parsePersonalityVersion(argument: string): number | undefined {
  const text = argument.trim()
  if (!/^\d+$/u.test(text)) return undefined
  const version = Number(text)
  return Number.isSafeInteger(version) && version > 0 ? version : undefined
}

/** Explain why a diff cannot be rendered from this many history records. */
function describeMissingHistory(count: number): string {
  if (count === 0) {
    return `No personality history yet: ${PERSONALITY_HISTORY_FILE_NAME} has no records, so there is no earlier version to diff.`
  }
  return `Only one personality history record exists in ${PERSONALITY_HISTORY_FILE_NAME}; a diff needs at least two.`
}

/** Name the versions a failed revert could have used. */
function describeUnknownVersion(version: number, records: readonly PersonalityHistoryRecord[]): string {
  if (records.length === 0) {
    return `No personality history yet, so version ${String(version)} does not exist.`
  }
  const known = records
    .slice(-KNOWN_VERSION_LIMIT)
    .map(record => String(record.version))
    .join(', ')
  return `No history record for version ${String(version)}. Known versions: ${known}.`
}

/** Count the by-id changes a revert produced. */
function summarizeChanges(changes: readonly PersonalityEntryChange[]): string {
  const counts = { added: 0, updated: 0, removed: 0 }
  for (const change of changes) counts[change.change] += 1
  return `${String(counts.added)} added, ${String(counts.updated)} updated, ${String(counts.removed)} removed`
}

/** Convert an expected file failure into a human-only command result. */
function commandFailure(error: unknown): CommandResult {
  if (error instanceof PersonalityDocumentError || error instanceof FsError) {
    return { kind: 'error', text: error.message }
  }
  throw error
}

/** Fail loudly if a locally closed union gains an unhandled member. */
/* v8 ignore start -- closed-union backstop is unreachable without violating the TypeScript contract */
function assertNever(value: never): never {
  throw new TypeError(`unknown personality subcommand: ${String(value)}`)
}
/* v8 ignore stop */
