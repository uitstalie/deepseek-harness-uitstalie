/**
 * The four model-facing memory tools.
 *
 * `memory_write` appends one summary entry to this workspace's MEMORY.md through
 * the store's version-guarded write. `memory_resolve` archives finished open work,
 * `memory_search` searches this workspace's managed memory notes and archive,
 * and `memory_forget` removes entries. Session history is read with the
 * session tools (`session_search`, `session_event_read`, `workspace_sessions`),
 * never through a memory tool.
 *
 * Every tool derives the caller's workspace from the owning agent session and
 * never accepts a workspace argument, so a call can only reach the caller's own
 * memory file.
 * @module @deepseek-ai/dsh-memory/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { defineTool, ToolArgsError, ToolContextUnavailableError } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { MemorySettings } from './config.ts'
import {
  appendMemoryEntry,
  forgetMemoryEntries,
  MEMORY_ENTRY_KINDS,
  MEMORY_KIND_REGISTRY,
  MemoryDocumentError,
  normalizeEntryTags,
  readMemoryDocument,
  resolveMemoryEntriesInStore,
} from './memory-file.ts'
import type { MemoryEntryKind, MemorySection } from './memory-file.ts'
import { readMemoryArchive } from './archive.ts'
import { truncateToBytes } from './text.ts'

/** Maximum `content` of one `memory_write` entry, in UTF-8 bytes. */
const MEMORY_WRITE_CONTENT_MAX_BYTES = 8 * 1024

/** `kind` parameter description generated from the one kind registry. */
const MEMORY_KIND_DESCRIPTION = `Category of the entry: ${
  MEMORY_KIND_REGISTRY.map(definition => `${definition.id} (${definition.description})`).join('; ')
}.`

/** Default and maximum number of `memory_search` results. */
const MEMORY_SEARCH_LIMIT = 10

/** Maximum rendered size of one `memory_search` result, in UTF-8 bytes. */
const MEMORY_SEARCH_MAX_BYTES = 8 * 1024

/** Turn number and inclusive seq range folded from a session log. */
export interface TurnFacts {
  /** Turn number from the latest `turn/start`. */
  readonly turn: number
  /** Inclusive seq range of the turn's events. */
  readonly seq: readonly [number, number]
}

/** One ranked `memory_search` result. */
export interface MemorySearchItem {
  /** Session whose memory section the excerpt belongs to. */
  readonly sessionId: string
  /** Turn number of the matching section's last turn. */
  readonly turn?: number
  /** Bounded plain-text excerpt. */
  readonly snippet: string
  /** Whether the excerpt came from the searchable archive rather than the active block. */
  readonly archived?: boolean
  /** Rule that archived the entry, when `archived` is true. */
  readonly reason?: string
}

/** Canonical output value of `memory_search`. */
export interface MemorySearchValue {
  /** The query the results answer. */
  readonly query: string
  /** Ranked results, at most {@link MEMORY_SEARCH_LIMIT}. */
  readonly items: MemorySearchItem[]
  /** Whether results were dropped to stay inside the budget. */
  readonly truncated?: boolean
}

/**
 * Build the memory tool definitions for one root agent.
 * @param ctx - context carrying `dshStore` and `sessionQuery`.
 * @param settings - resolved provider settings.
 * @returns the four tools, in registration order.
 */
export function memoryTools(
  ctx: Context,
  settings: MemorySettings,
): readonly ToolDefinition[] {
  return [
    { ...defineMemoryWriteTool(ctx, settings), minRole: 'agent' },
    { ...defineMemoryResolveTool(ctx, settings), minRole: 'agent' },
    { ...defineMemoryForgetTool(ctx, settings), minRole: 'agent' },
    { ...defineMemorySearchTool(ctx), minRole: 'subagent' },
  ]
}

/** Build `memory_write`: append one entry to the caller's workspace MEMORY.md. */
function defineMemoryWriteTool(ctx: Context, settings: MemorySettings): ToolDefinition {
  return defineTool({
    name: 'memory_write',
    description:
      'Record one durable conclusion in this workspace\'s memory so later turns and sessions can recover it. '
      + 'Write one line per call and pick the category with `kind`. Use this tool instead of file tools: '
      + '`.dsh/memory` is managed by this capability.',
    parameters: {
      kind: {
        type: 'string',
        required: true,
        enum: [...MEMORY_ENTRY_KINDS],
        description: MEMORY_KIND_DESCRIPTION,
      },
      content: {
        type: 'string',
        required: true,
        description: 'One line stating the conclusion, at most 8 KiB.',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional labels recorded beside the entry, in write order; up to 8 labels of 64 characters.',
      },
      supersedes: {
        type: 'array',
        items: { type: 'string' },
        description: 'Tags naming older entries of the same kind in this session that this write replaces; '
          + 'matching entries are archived automatically when their tags intersect this list.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          version: { type: 'string' },
          kind: { type: 'string', required: true },
          evicted: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true },
                text: { type: 'string', required: true },
                turn: { type: 'integer' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: renderMemoryWrite(value),
      }],
    },
    async execute(args, exec) {
      const session = requireSession(exec.agent?.session, 'memory_write')
      const content = normalizeEntryContent(args.content, args.kind)
      const facts = await readTurnFacts(ctx, session, exec.signal)
      if (facts === undefined) {
        throw new ToolContextUnavailableError('memory_write requires an active turn: the session log has no turn/start event')
      }
      const written = await appendMemoryEntry(ctx, session, {
        kind: args.kind,
        text: content,
        tags: normalizeEntryTags(args.tags ?? []),
        ...args.supersedes === undefined ? {} : { supersedes: normalizeEntryTags(args.supersedes) },
        turn: facts.turn,
        seq: facts.seq,
      }, exec.signal, {
        window: settings.window,
        maxBytes: settings.maxBytes,
        maxEntries: settings.maxEntries,
        openTtlDays: settings.openTtlDays,
        filesTtlDays: settings.filesTtlDays,
        supersessionMinSharedTags: settings.supersessionMinSharedTags,
      })
      return {
        path: written.path,
        kind: written.kind,
        ...written.version === undefined ? {} : { version: written.version },
        ...written.evictions.length === 0 ? {} : {
          evicted: written.evictions.map(eviction => ({
            kind: eviction.kind,
            text: eviction.text,
            ...eviction.turn === undefined ? {} : { turn: eviction.turn },
          })),
        },
      }
    },
  })
}

/** Build `memory_resolve`: explicitly archive open work that is done. */
function defineMemoryResolveTool(
  ctx: Context,
  settings: MemorySettings,
): ToolDefinition {
  return defineTool({
    name: 'memory_resolve',
    description:
      'Mark finished work as resolved by archiving matching entries and removing them from the active memory block. '
      + 'Defaults to `open`; use it when a task, report, or phase completes so TTL does not have to clean it later. '
      + 'A call needs `turn`, `tag`, or an explicit `all: true`.',
    parameters: {
      sessionId: {
        type: 'string',
        description: 'Session whose entries are resolved; defaults to the current session.',
      },
      kind: {
        type: 'string',
        enum: [...MEMORY_ENTRY_KINDS],
        description: 'Kind to resolve; defaults to open.',
      },
      turn: {
        type: 'integer',
        description: 'Only resolve entries attributed to this turn.',
      },
      tag: {
        type: 'string',
        description: 'Only resolve entries carrying this label.',
      },
      all: {
        type: 'boolean',
        description: 'Resolve every matching entry when neither turn nor tag is supplied; required for a bare call.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          version: { type: 'string' },
          removed: { type: 'integer', required: true },
          remaining: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.removed === 0
          ? `No memory entries matched the resolve filter; ${String(value.remaining)} remain.`
          : `Resolved ${String(value.removed)} memory entr${value.removed === 1 ? 'y' : 'ies'}; ${String(value.remaining)} remain in the active block. The removed text is searchable in the archive.`,
      }],
    },
    async execute(args, exec) {
      const session = requireSession(exec.agent?.session, 'memory_resolve')
      const filter = {
        sessionId: args.sessionId ?? String(session.id),
        kind: args.kind ?? 'open',
        ...args.turn === undefined ? {} : { turn: args.turn },
        ...args.tag === undefined ? {} : { tag: args.tag },
        ...args.all === true ? { all: true } : {},
      }
      const result = await resolveMemoryEntriesInStore(ctx, session, filter, exec.signal, {
        window: settings.window,
        maxBytes: settings.maxBytes,
        maxEntries: settings.maxEntries,
      })
      return {
        path: result.path,
        ...result.version === undefined ? {} : { version: result.version },
        removed: result.removed,
        remaining: result.remaining,
      }
    },
  })
}

/** Build `memory_forget`: remove matching entries and record each removal. */
function defineMemoryForgetTool(
  ctx: Context,
  settings: MemorySettings,
): ToolDefinition {
  return defineTool({
    name: 'memory_forget',
    description:
      'Remove memory entries selected by kind, tag, or turn age and record each removal in MEMORY.md. '
      + 'Use it to clean up a workspace whose memory body reached its budget; at least one filter is required. '
      + 'Entries without a turn are not matched by beforeTurn.',
    parameters: {
      kind: {
        type: 'string',
        enum: [...MEMORY_ENTRY_KINDS],
        description: `Only remove entries of this kind: ${MEMORY_ENTRY_KINDS.join(', ')}.`,
      },
      tag: {
        type: 'string',
        description: 'Only remove entries carrying this label.',
      },
      beforeTurn: {
        type: 'integer',
        description: 'Only remove entries older than this turn (an entry turn strictly less than this value).',
      },
      sessionId: {
        type: 'string',
        description: 'Session to forget in; defaults to the current session.',
      },
      allSessions: {
        type: 'boolean',
        description: 'Forget matching entries in every session of this workspace instead of one session.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          version: { type: 'string' },
          removed: { type: 'integer', required: true },
          remaining: { type: 'integer', required: true },
          sessions: { type: 'array', required: true, items: { type: 'string' } },
          kinds: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              decision: { type: 'integer', required: true },
              files: { type: 'integer', required: true },
              open: { type: 'integer', required: true },
              preference: { type: 'integer', required: true },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderMemoryForget(value) }],
    },
    async execute(args, exec) {
      const session = requireSession(exec.agent?.session, 'memory_forget')
      const filter = {
        ...args.kind === undefined ? {} : { kind: args.kind },
        ...args.tag === undefined ? {} : { tag: args.tag },
        ...args.beforeTurn === undefined ? {} : { beforeTurn: args.beforeTurn },
        ...args.sessionId === undefined ? {} : { sessionId: args.sessionId },
        ...args.allSessions === true ? { allSessions: true } : {},
      }
      const result = await forgetMemoryEntries(ctx, session, filter, exec.signal, {
        window: settings.window,
        maxBytes: settings.maxBytes,
        maxEntries: settings.maxEntries,
      })
      return {
        path: result.path,
        ...result.version === undefined ? {} : { version: result.version },
        removed: result.removed,
        remaining: result.remaining,
        sessions: [...result.sessions],
        kinds: {
          decision: result.kinds.decision,
          files: result.kinds.files,
          open: result.kinds.open,
          preference: result.kinds.preference,
        },
      }
    },
  })
}

/** Build `memory_search`: search this workspace's managed memory notes and archive. */
function defineMemorySearchTool(ctx: Context): ToolDefinition {
  return defineTool({
    name: 'memory_search',
    description:
      'Search this workspace\'s managed memory notes and archive for a phrase. Returns ranked excerpts with the '
      + 'session and turn the entry came from. Session history is not searched here: use `session_search` for '
      + 'session text and `session_event_read` for one turn.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'Text to look for; matched literally, not as search syntax.',
      },
      limit: {
        type: 'integer',
        description: `Maximum number of results, from 1 to ${String(MEMORY_SEARCH_LIMIT)}; defaults to ${String(MEMORY_SEARCH_LIMIT)}.`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', required: true },
          items: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sessionId: { type: 'string', required: true },
                turn: { type: 'integer' },
                snippet: { type: 'string', required: true },
                archived: { type: 'boolean' },
                reason: { type: 'string' },
              },
            },
          },
          truncated: { type: 'boolean' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderMemorySearch(value) }],
    },
    async execute(args, exec) {
      const session = requireSession(exec.agent?.session, 'memory_search')
      const query = args.query.trim()
      if (query.length === 0) throw new ToolArgsError(['query must not be empty'])
      const limit = clampSearchLimit(args.limit)
      const items = (await searchMemoryEntries(ctx, session, query, exec.signal)).slice(0, limit)
      return boundSearchValue({ query, items }, MEMORY_SEARCH_MAX_BYTES)
    },
  })
}

/**
 * Fold the current turn number and seq range from a live-preferred session log.
 * @param ctx - context carrying `sessionQuery`.
 * @param session - session whose log is observed.
 * @param signal - cancellation for the observation.
 * @returns the latest `turn/start` facts, or undefined when the log has none.
 */
export async function readTurnFacts(
  ctx: Context,
  session: Session,
  signal?: AbortSignal,
): Promise<TurnFacts | undefined> {
  using observation = await ctx.sessionQuery.observeSession(session.id, {
    ...signal === undefined ? {} : { signal },
    projectionMode: 'none',
  })
  return foldTurnFacts(observation.events)
}

/** Fold the latest `turn/start` event into turn and seq facts. */
function foldTurnFacts(events: readonly SessionEvent[]): TurnFacts | undefined {
  let turn: number | undefined
  let startSeq: number | undefined
  let lastSeq: number | undefined
  for (const event of events) {
    lastSeq = event.seq
    if (event.type !== 'turn/start') continue
    turn = event.data.turn
    startSeq = event.seq
  }
  if (turn === undefined || startSeq === undefined) return undefined
  return { turn, seq: [startSeq, lastSeq ?? startSeq] }
}

/** Validate and normalize one `memory_write` content line. */
function normalizeEntryContent(content: string, kind: MemoryEntryKind): string {
  const text = content.trim()
  if (text.length === 0) throw new ToolArgsError([`content for a ${kind} entry must not be empty`])
  if (/[\r\n]/u.test(text)) {
    throw new ToolArgsError(['content must be one line; the managed block stores one entry per line'])
  }
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > MEMORY_WRITE_CONTENT_MAX_BYTES) {
    throw new ToolArgsError([`content is ${String(bytes)} bytes; the limit is ${String(MEMORY_WRITE_CONTENT_MAX_BYTES)}`])
  }
  return text
}

/** Require the owning agent session every memory tool is scoped to. */
function requireSession(session: Session | undefined, tool: string): Session {
  if (session === undefined) throw new ToolContextUnavailableError(`${tool} requires an owning agent session`)
  return session
}

/** Clamp a model-supplied result limit into the contract range. */
function clampSearchLimit(limit: number | undefined): number {
  if (limit === undefined) return MEMORY_SEARCH_LIMIT
  return Math.min(Math.max(Math.trunc(limit), 1), MEMORY_SEARCH_LIMIT)
}

/** Search the managed block of this workspace's MEMORY.md. */
async function searchMemoryEntries(
  ctx: Context,
  session: Session,
  query: string,
  signal: AbortSignal,
): Promise<readonly MemorySearchItem[]> {
  const needle = query.toLowerCase()
  const items: MemorySearchItem[] = []
  const sections = await readMemorySectionsSafely(ctx, session, signal)
  for (const section of sections ?? []) {
    for (const entry of section.entries) {
      if (!entry.text.toLowerCase().includes(needle)) continue
      items.push({
        sessionId: section.sessionId,
        turn: section.endTurn,
        snippet: `[${entry.kind}] ${entry.text}`,
      })
    }
  }
  const archived = await readArchiveSafely(ctx, session, signal)
  for (const record of archived) {
    if (!record.text.toLowerCase().includes(needle)) continue
    items.push({
      sessionId: record.sessionId,
      ...record.turn === undefined ? {} : { turn: record.turn },
      snippet: `[${record.kind}] ${record.text} (archived: ${record.reason})`,
      archived: true,
      reason: record.reason,
    })
  }
  return items
}

/** Read archive records, containing a store failure to a logged skip. */
async function readArchiveSafely(
  ctx: Context,
  session: Session,
  signal: AbortSignal,
): Promise<readonly import('./memory-file.ts').MemoryArchiveRecord[]> {
  try {
    return await readMemoryArchive(ctx, session, signal)
  } catch (error: unknown) {
    ctx.logger.warn('memory: skipping the archive half of search: %s', error instanceof Error ? error.message : String(error))
    return []
  }
}

/** Read the managed-block sections, containing a corrupt file to a logged skip. */
async function readMemorySectionsSafely(
  ctx: Context,
  session: Session,
  signal: AbortSignal,
): Promise<readonly MemorySection[] | undefined> {
  try {
    return (await readMemoryDocument(ctx, session, signal)).document?.sections
  } catch (error: unknown) {
    if (!(error instanceof MemoryDocumentError)) throw error
    ctx.logger.warn('memory: skipping the managed-block search: %s', error.message)
    return undefined
  }
}

/** Drop trailing results until the rendered search value fits the byte budget. */
function boundSearchValue(value: MemorySearchValue, maxBytes: number): MemorySearchValue {
  const items = [...value.items]
  let current = value
  while (items.length > 0 && Buffer.byteLength(renderMemorySearch(current), 'utf8') > maxBytes) {
    items.pop()
    current = { ...value, items, truncated: true }
  }
  return current
}

/** One evicted entry projected into the `memory_write` result. */
interface MemoryWriteEviction {
  /** Kind of the removed entry. */
  readonly kind: string
  /** Bounded text copy of the removed entry. */
  readonly text: string
  /** Turn the removed entry summarized, when it carried one. */
  readonly turn?: number
}

/** `memory_write` result value. */
interface MemoryWriteValue {
  /** Store-relative path that was written. */
  readonly path: string
  /** Version of the written file, when the store reported one. */
  readonly version?: string
  /** Kind of the appended entry. */
  readonly kind: string
  /** Entries the write evicted to fit the body budget. */
  readonly evicted?: readonly MemoryWriteEviction[]
}

/** Render one `memory_write` value, naming every eviction it caused. */
function renderMemoryWrite(value: MemoryWriteValue): string {
  const lines = [
    `Recorded a ${value.kind} memory entry in ${value.path}`
      + `${value.version === undefined ? '' : ` (version ${value.version})`}.`,
  ]
  const evicted = value.evicted ?? []
  if (evicted.length > 0) {
    lines.push(`Evicted ${String(evicted.length)} older entr${evicted.length === 1 ? 'y' : 'ies'} to stay within the memory body budget:`)
    for (const eviction of evicted) {
      const turn = eviction.turn === undefined ? '' : ` (turn ${String(eviction.turn)})`
      lines.push(`- [${eviction.kind}]${turn} ${truncateToBytes(eviction.text, 160)}`)
    }
    if (evicted.some(eviction => eviction.kind === 'decision')) {
      lines.push('A decision entry was evicted; the removal is recorded in the MEMORY.md frontmatter.')
    }
  }
  return lines.join('\n')
}

/** `memory_forget` result value. */
interface MemoryForgetValue {
  /** Store-relative path that was written or left untouched. */
  readonly path: string
  /** Entries removed by the filter. */
  readonly removed: number
  /** Entries remaining in the target sessions. */
  readonly remaining: number
  /** Sessions the filter covered. */
  readonly sessions: readonly string[]
  /** Removed entries per kind. */
  readonly kinds: Readonly<Record<string, number>>
}

/** Render one `memory_forget` value. */
function renderMemoryForget(value: MemoryForgetValue): string {
  const sessions = value.sessions.join(', ')
  if (value.removed === 0) {
    return `No memory entries matched the forget filter; ${String(value.remaining)} remain in ${sessions}.`
  }
  const counts = Object.entries(value.kinds)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${kind} ${String(count)}`)
    .join(', ')
  return `Forgot ${String(value.removed)} memory entr${value.removed === 1 ? 'y' : 'ies'} from ${sessions}`
    + ` (${counts}); ${String(value.remaining)} remain. Removals are recorded in ${value.path}.`
}

/** Render one `memory_search` value as the model-visible text. */
function renderMemorySearch(value: MemorySearchValue): string {
  const lines = value.items.length === 0
    ? [`No memory matches for ${JSON.stringify(value.query)} in this workspace.`]
    : value.items.map(item =>
      `- [memory] ${item.sessionId} · turn ${String(item.turn ?? 0)}`
      + `${item.archived === true ? ` · archived: ${item.reason ?? 'unknown'}` : ''} · ${item.snippet}`)
  if (value.truncated === true) lines.push('(results truncated; narrow the query or lower `limit`)')
  return lines.join('\n')
}
