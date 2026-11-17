/**
 * The three model-facing memory tools, all global-only.
 *
 * `memory_write` records one cross-workspace fact or convention in
 * `$DSH_HOME/memory/GLOBAL.md`; a business, dispatch, or persona entry is
 * refused with a tool hint instead of being dropped. `memory_search` searches
 * the global file and its archive; session history is `session_search` and
 * `session_event_read`. `memory_forget` removes global entries by topic or entry
 * id and has no session, turn, or kind filters.
 *
 * `memory_resolve` is gone: global memory has no open or dispatch entries to
 * resolve. Every tool is scoped to the harness home, never to the caller's
 * workspace, so an ordinary session and the super agent see the same store.
 * @module @deepseek-ai/dsh-memory/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { defineTool, ToolArgsError, ToolContextUnavailableError } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  GLOBAL_MEMORY_SEARCH_LIMIT,
  GLOBAL_MEMORY_TOPICS,
  forgetGlobalEntries,
  renderSearchValue,
  searchGlobalMemory,
  writeGlobalEntry,
} from './global-memory.ts'
import type { GlobalMemoryTopic } from './global-memory.ts'

/** Topic parameter description generated from the one topic registry. */
const TOPIC_DESCRIPTION = `One of the closed global topics: ${GLOBAL_MEMORY_TOPICS.join(', ')}. `
  + 'A business fact, dispatch state, or persona/style note is refused; it belongs to the workspace toolset or the personality capability.'

/**
 * Build the global memory tool definitions for one root agent.
 * @param ctx - context carrying `dshStore`.
 * @returns the three tools, in registration order.
 */
export function memoryTools(ctx: Context): readonly ToolDefinition[] {
  return [
    { ...defineMemoryWriteTool(ctx), minRole: 'agent' },
    { ...defineMemoryForgetTool(ctx), minRole: 'agent' },
    { ...defineMemorySearchTool(ctx), minRole: 'subagent' },
  ]
}

/** Build `memory_write`: record one global fact or convention. */
function defineMemoryWriteTool(ctx: Context): ToolDefinition {
  return defineTool({
    name: 'memory_write',
    description:
      'Record one cross-workspace fact or convention in the global memory store (`$DSH_HOME/memory/GLOBAL.md`) '
      + 'so every workspace session can recover it. A newer entry with the same topic archives the older one. '
      + 'Use this only for a fact that applies everywhere: a shared server, the harness default model, a shared '
      + 'account or tooling fact, or a shared convention. Business facts, dispatch or session state, and '
      + 'persona/style notes are refused with a pointer to the tool that owns them: `workspace_tasks`, '
      + '`workspace_intents`, `workspace_sessions`, `workspace_message`, `workspace_artifacts`, `session_search`, '
      + '`session_event_read`, `read`, or `personality_apply`/`write_like_human`. Do not edit `.dsh/memory` with file tools.',
    parameters: {
      topic: {
        type: 'string',
        required: true,
        enum: [...GLOBAL_MEMORY_TOPICS],
        description: TOPIC_DESCRIPTION,
      },
      text: {
        type: 'string',
        required: true,
        description: 'One line stating the fact or convention, at most 8 KiB; a business fact, dispatch state, or persona/style note is refused.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          topic: { type: 'string', required: true },
          id: { type: 'string', required: true },
          revision: { type: 'integer', required: true },
          version: { type: 'string' },
          archived: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              text: { type: 'string', required: true },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.archived === undefined
          ? `Recorded a ${value.topic} global memory entry in ${value.path} (revision ${String(value.revision)}).`
          : `Recorded a ${value.topic} global memory entry in ${value.path} (revision ${String(value.revision)}); `
            + `the previous entry (${value.archived.id}) was archived and stays searchable with \`includeArchived\`.`,
      }],
    },
    async execute(args, exec) {
      const session = requireSession(exec.agent?.session, 'memory_write')
      // The store classifies before it reads a file, so a refused entry never reaches the filesystem.
      const written = await writeGlobalEntry(ctx, {
        topic: assertGlobalTopic(args.topic),
        text: args.text,
        sourceSessionId: String(session.id),
      }, exec.signal)
      return {
        path: written.path,
        topic: written.topic,
        id: written.id,
        revision: written.revision,
        ...written.version === undefined ? {} : { version: written.version },
        ...written.archived === undefined ? {} : {
          archived: { id: written.archived.id, text: written.archived.text },
        },
      }
    },
  })
}

/** Build `memory_forget`: remove global entries by topic or entry id. */
function defineMemoryForgetTool(ctx: Context): ToolDefinition {
  return defineTool({
    name: 'memory_forget',
    description:
      'Remove a global memory entry by `topic` or `entryId` and record the removal in `GLOBAL.archive.md`. '
      + 'There are no session, turn, kind, tag, or TTL filters: global memory is a small cross-workspace store, '
      + 'and an entry is identified by its topic or its id. Use it to free space or to retire a superseded convention.',
    parameters: {
      topic: {
        type: 'string',
        enum: [...GLOBAL_MEMORY_TOPICS],
        description: 'Archive the active entry with this topic.',
      },
      entryId: {
        type: 'string',
        description: 'Remove the entry with this id from the active file or the archive.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          removed: { type: 'integer', required: true },
          remaining: { type: 'integer', required: true },
          topics: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.removed === 0
          ? `No global memory entry matched; ${String(value.remaining)} remain in the active file.`
          : `Forgot ${String(value.removed)} global memory entr${value.removed === 1 ? 'y' : 'ies'} `
            + `(${value.topics.join(', ')}); ${String(value.remaining)} remain. The removed text stays searchable in the archive.`,
      }],
    },
    async execute(args, exec) {
      requireSession(exec.agent?.session, 'memory_forget')
      if (args.topic === undefined && args.entryId === undefined) {
        throw new ToolArgsError(['one of `topic` or `entryId` is required; global memory has no session filters'])
      }
      const result = await forgetGlobalEntries(ctx, {
        ...args.topic === undefined ? {} : { topic: args.topic },
        ...args.entryId === undefined ? {} : { entryId: args.entryId },
      }, exec.signal)
      return {
        path: result.path,
        removed: result.removed,
        remaining: result.remaining,
        topics: [...result.topics],
      }
    },
  })
}

/** Build `memory_search`: search the global file and, on request, its archive. */
function defineMemorySearchTool(ctx: Context): ToolDefinition {
  return defineTool({
    name: 'memory_search',
    description:
      'Search the global memory store (cross-workspace facts and conventions) and, when `includeArchived` is set, '
      + 'its archive. Returns exact-topic or substring matches with their topic, text, and source session. '
      + 'Session history is not searched here: use `session_search` for an older session and `session_event_read` '
      + 'for one turn; use `workspace_sessions` for what a session is doing.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'Text to look for; matched literally against topic and text, case-insensitively.',
      },
      limit: {
        type: 'integer',
        description: `Maximum number of results, from 1 to ${String(GLOBAL_MEMORY_SEARCH_LIMIT)}; defaults to ${String(GLOBAL_MEMORY_SEARCH_LIMIT)}.`,
      },
      includeArchived: {
        type: 'boolean',
        description: 'Include entries that were superseded or forgotten; archived entries are never injected.',
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
                id: { type: 'string', required: true },
                topic: { type: 'string', required: true },
                text: { type: 'string', required: true },
                sourceSessionId: { type: 'string', required: true },
                createdAt: { type: 'string', required: true },
                archived: { type: 'boolean' },
                reason: { type: 'string' },
              },
            },
          },
          truncated: { type: 'boolean' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderSearchValue(value) }],
    },
    async execute(args, exec) {
      requireSession(exec.agent?.session, 'memory_search')
      const query = args.query.trim()
      if (query.length === 0) throw new ToolArgsError(['query must not be empty'])
      return await searchGlobalMemory(ctx, query, {
        ...args.limit === undefined ? {} : { limit: args.limit },
        ...args.includeArchived === true ? { includeArchived: true } : {},
      }, exec.signal)
    },
  })
}

/** Require the owning agent session every memory tool is scoped to. */
function requireSession(session: Session | undefined, tool: string): Session {
  if (session === undefined) throw new ToolContextUnavailableError(`${tool} requires an owning agent session`)
  return session
}

/** Assert one topic is in the allowlist; the schema check normally covers this. */
export function assertGlobalTopic(topic: string): GlobalMemoryTopic {
  if (!(GLOBAL_MEMORY_TOPICS as readonly string[]).includes(topic)) {
    throw new ToolArgsError([`topic must be one of ${GLOBAL_MEMORY_TOPICS.join(', ')}`])
  }
  return topic as GlobalMemoryTopic
}
