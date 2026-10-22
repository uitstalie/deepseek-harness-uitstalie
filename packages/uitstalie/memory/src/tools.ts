/**
 * The three model-facing memory tools.
 *
 * `memory_write` appends one summary entry to this workspace's MEMORY.md through
 * the store's version-guarded write and refreshes the durable memory snapshot
 * after the write commits. `memory_search` searches this workspace's session
 * history and managed memory notes. `memory_read` renders one turn of a
 * workspace-authorized session as a bounded conversation surface; its turn
 * resolution, authorization, and rendering live in `read.ts`.
 *
 * Every tool derives the caller's workspace from the owning agent session and
 * never accepts a workspace argument, so a call can only reach the caller's own
 * sessions and memory file.
 * @module @deepseek-ai/dsh-memory/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { SessionResultFilter, SessionSearchHit } from '@deepseek-ai/dsh-session-query'
import type { MemorySettings } from './config.ts'
import {
  appendMemoryEntry,
  MEMORY_ENTRY_KINDS,
  MEMORY_KIND_REGISTRY,
  MemoryDocumentError,
  readMemoryDocument,
} from './memory-file.ts'
import type { MemoryEntryKind, MemorySection } from './memory-file.ts'
import { readMemoryWindow } from './read.ts'
import { refreshMemorySnapshot } from './snapshot.ts'

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
  /** Whether the excerpt came from a session event or the managed memory block. */
  readonly source: 'session' | 'memory'
  /** Session the excerpt belongs to. */
  readonly sessionId: string
  /** Event seq of the best match, for session results. */
  readonly seq?: number
  /** Turn number of the matching section's last turn, for memory results. */
  readonly turn?: number
  /** Event time in Unix epoch milliseconds, for session results. */
  readonly time?: number
  /** Bounded plain-text excerpt. */
  readonly snippet: string
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
 * @returns the three tools, in registration order.
 */
export function memoryTools(ctx: Context, settings: MemorySettings): readonly ToolDefinition[] {
  return [
    defineMemoryWriteTool(ctx, settings),
    defineMemorySearchTool(ctx),
    defineMemoryReadTool(ctx),
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
        description: 'Optional labels; accepted but not persisted in this step.',
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
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Recorded a ${value.kind} memory entry in ${value.path}`
          + `${value.version === undefined ? '' : ` (version ${value.version})`}.`,
      }],
    },
    async execute(args, exec) {
      const session = requireSession(exec.agent?.session, 'memory_write')
      const content = normalizeEntryContent(args.content, args.kind)
      const facts = await readTurnFacts(ctx, session, exec.signal)
      if (facts === undefined) {
        throw new Error('memory_write requires an active turn: the session log has no turn/start event')
      }
      const written = await appendMemoryEntry(ctx, session, {
        kind: args.kind,
        text: content,
        turn: facts.turn,
        seq: facts.seq,
      }, exec.signal, { window: settings.window, maxBytes: settings.maxBytes })
      await refreshMemorySnapshot(ctx, exec.agent, exec.signal)
      return {
        path: written.path,
        kind: written.kind,
        ...written.version === undefined ? {} : { version: written.version },
      }
    },
  })
}

/** Build `memory_search`: search this workspace's sessions and memory notes. */
function defineMemorySearchTool(ctx: Context): ToolDefinition {
  return defineTool({
    name: 'memory_search',
    description:
      'Search this workspace\'s session history and managed memory notes for a phrase. '
      + 'Returns ranked excerpts with the session id and event seq; only sessions from this workspace are searched.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'Text to look for; matched literally, not as search syntax.',
      },
      sessionId: {
        type: 'string',
        description: 'Restrict the search to one session of this workspace.',
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
                source: { type: 'string', required: true, enum: ['session', 'memory'] },
                sessionId: { type: 'string', required: true },
                seq: { type: 'integer' },
                turn: { type: 'integer' },
                time: { type: 'integer' },
                snippet: { type: 'string', required: true },
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
      if (query.length === 0) throw new Error('memory_search: query must not be empty')
      const limit = clampSearchLimit(args.limit)
      const page = await ctx.sessionQuery.searchSessions({
        query,
        sessionFilters: workspaceFilters(session, args.sessionId),
        limit,
      }, { signal: exec.signal })
      const sessionItems = page.items.map(sessionSearchItem)
      const memoryItems = await searchMemoryEntries(ctx, session, query, exec.signal)
      return boundSearchValue({
        query,
        items: [...sessionItems, ...memoryItems].slice(0, limit),
        ...page.nextCursor === undefined ? {} : { truncated: true },
      }, MEMORY_SEARCH_MAX_BYTES)
    },
  })
}

/** Build `memory_read`: render one authorized session turn as a bounded transcript. */
function defineMemoryReadTool(ctx: Context): ToolDefinition {
  return defineTool({
    name: 'memory_read',
    description:
      'Read one completed turn from this workspace\'s session history as a conversation transcript. '
      + 'With no turn, it reads the latest completed turn; `seq` reads the turn containing that event. '
      + 'User and assistant text is kept, tool calls and results appear as status lines without payloads, '
      + 'and the result is capped at 16 KiB.',
    parameters: {
      sessionId: {
        type: 'string',
        description: 'Session to read; defaults to the current session.',
      },
      turn: {
        type: 'integer',
        description: 'Completed turn number to read; defaults to the latest completed turn.',
      },
      seq: {
        type: 'integer',
        description: 'Event seq whose containing turn to read, typically from a memory_search hit.',
      },
      before: {
        type: 'integer',
        description: 'Neighboring events to include before the turn, from 0 to 10; defaults to 0.',
      },
      after: {
        type: 'integer',
        description: 'Neighboring events to include after the turn, from 0 to 10; defaults to 0.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute(args, exec) {
      const session = requireSession(exec.agent?.session, 'memory_read')
      return readMemoryWindow(ctx, session, args, exec.signal)
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
  if (text.length === 0) throw new Error(`memory_write: content for a ${kind} entry must not be empty`)
  if (/[\r\n]/u.test(text)) {
    throw new Error('memory_write: content must be one line; the managed block stores one entry per line')
  }
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > MEMORY_WRITE_CONTENT_MAX_BYTES) {
    throw new Error(`memory_write: content is ${String(bytes)} bytes; the limit is ${String(MEMORY_WRITE_CONTENT_MAX_BYTES)}`)
  }
  return text
}

/** Require the owning agent session every memory tool is scoped to. */
function requireSession(session: Session | undefined, tool: string): Session {
  if (session === undefined) throw new Error(`${tool} requires an owning agent session`)
  return session
}

/** Clamp a model-supplied result limit into the contract range. */
function clampSearchLimit(limit: number | undefined): number {
  if (limit === undefined) return MEMORY_SEARCH_LIMIT
  return Math.min(Math.max(Math.trunc(limit), 1), MEMORY_SEARCH_LIMIT)
}

/** Build the session predicates every memory search applies. */
function workspaceFilters(session: Session, sessionId: string | undefined): readonly SessionResultFilter[] {
  const filters: SessionResultFilter[] = [
    { kind: 'cwd', values: [session.header.cwd ?? null] },
  ]
  if (sessionId !== undefined) filters.push({ kind: 'id', values: [SessionId(sessionId)] })
  return filters
}

/** Project one full-text session hit into a memory search item. */
function sessionSearchItem(hit: SessionSearchHit): MemorySearchItem {
  return {
    source: 'session',
    sessionId: hit.header.id,
    seq: hit.bestMatch.seq,
    time: hit.bestMatch.time,
    snippet: hit.bestMatch.snippet,
  }
}

/** Search the managed block of this workspace's MEMORY.md. */
async function searchMemoryEntries(
  ctx: Context,
  session: Session,
  query: string,
  signal: AbortSignal,
): Promise<readonly MemorySearchItem[]> {
  const sections = await readMemorySectionsSafely(ctx, session, signal)
  if (sections === undefined) return []
  const needle = query.toLowerCase()
  const items: MemorySearchItem[] = []
  for (const section of sections) {
    for (const entry of section.entries) {
      if (!entry.text.toLowerCase().includes(needle)) continue
      items.push({
        source: 'memory',
        sessionId: section.sessionId,
        turn: section.endTurn,
        snippet: `[${entry.kind}] ${entry.text}`,
      })
    }
  }
  return items
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

/** Render one `memory_search` value as the model-visible text. */
function renderMemorySearch(value: MemorySearchValue): string {
  if (value.items.length === 0) return `No memory matches for ${JSON.stringify(value.query)} in this workspace.`
  const lines = value.items.map(item => item.source === 'memory'
    ? `- [memory] ${item.sessionId} · turn ${String(item.turn ?? 0)} · ${item.snippet}`
    : `- [session] ${item.sessionId}#${String(item.seq ?? 0)} · ${formatTime(item.time)} · ${item.snippet}`)
  if (value.truncated === true) lines.push('(results truncated; narrow the query or lower `limit`)')
  return lines.join('\n')
}

/** Render one event time; an absent time renders as a dash. */
function formatTime(time: number | undefined): string {
  return time === undefined ? '—' : new Date(time).toISOString()
}
