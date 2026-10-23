/**
 * The single model-facing `tool-dsh-store` tool: create, query, and delete files
 * and folders under a workspace's `.dsh` directory.
 *
 * The tool is a consumer of the `.dsh` base interface (`ctx.dshStore`), which
 * owns project-root discovery, path confinement, the store operations, the
 * namespace authoring checks, and the session policy gate.
 * @module @deepseek-ai/dsh-tool-dsh-store/tool
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { normalizeStorePath, STORE_DIR_NAME } from './paths.ts'
import { isMemoryPath } from './namespaces.ts'
import type { DshStore } from './service.ts'

/** What one store call reports back to the model. */
export interface StoreToolValue {
  /** The action this call performed. */
  action: 'create' | 'query' | 'delete'
  /** Target path relative to `.dsh`; the root is the empty string. */
  path: string
  /** Target kind after the call. */
  kind: 'file' | 'directory' | 'missing' | 'other'
  /** Direct children of a queried directory, in path order. */
  entries?: { path: string; kind: string; size?: number }[]
  /** Text of a queried file when the caller asked for it. */
  text?: string
}

/** Inputs of the tool definition. */
export interface StoreToolOptions {
  /** The `.dsh` base interface this tool drives. */
  store: DshStore
}

/**
 * Build the `tool-dsh-store` tool definition.
 * @param ctx - plugin context (kept for the tool's presentation and future consumers).
 * @param options - the store service the tool drives.
 * @returns the tool definition to register on `ctx.tools`.
 */
export function defineStoreTool(ctx: Context, options: StoreToolOptions): ToolDefinition {
  void ctx
  return defineTool({
    name: 'tool-dsh-store',
    description:
      `Create, inspect, and delete files and folders under this workspace's \`${STORE_DIR_NAME}\` directory, `
      + `which carries editor rules (\`${STORE_DIR_NAME}/rules\`), project skills, and runtime snapshots; `
      + `\`${STORE_DIR_NAME}/memory\` is managed by the memory capability and read-only for this tool. `
      + 'Give a path relative to that directory. Use this tool instead of the generic write, edit, or shell '
      + `tools for \`${STORE_DIR_NAME}\` content, because it validates the path, refuses a rule that repeats an `
      + 'existing rule or a skill document missing the frontmatter a skill needs, and reports what it deleted.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['create', 'query', 'delete'],
        description: 'create writes, query lists or reads, delete removes.',
      },
      path: {
        type: 'string',
        required: true,
        description: `Target path relative to \`${STORE_DIR_NAME}\`, for example \`rules/api.md\`; an empty path names the store root.`,
      },
      target: {
        type: 'string',
        enum: ['file', 'folder'],
        description: 'What to create; required for create and ignored otherwise.',
      },
      content: {
        type: 'string',
        description: 'Complete file text; required when creating a file.',
      },
      recursive: {
        type: 'boolean',
        description: 'Delete a folder together with its contents; a populated folder is refused without it.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true, enum: ['create', 'query', 'delete'] },
          path: { type: 'string', required: true },
          kind: { type: 'string', required: true, enum: ['file', 'directory', 'missing', 'other'] },
          entries: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                size: { type: 'integer' },
              },
            },
          },
          text: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderStoreValue(value) }],
    },
    async execute(args, exec): Promise<StoreToolValue> {
      const session = exec.agent?.session
      if (session === undefined) throw new Error('tool-dsh-store requires an owning agent session')

      // The memory capability owns its namespace and writes it through the store
      // service; this tool may read that area but not mutate it. Checking before
      // the policy gate keeps that explanation even for a read-only session.
      if (args.action !== 'query') refuseMemoryPath(args.path)

      // Querying reads the store, so a read-only session may still inspect it;
      // only create and delete pass the write gate inside the store service.
      if (args.action === 'query') {
        const queried = await options.store.query(session, args.path, { signal: exec.signal })
        return {
          action: 'query',
          path: queried.path,
          kind: queried.kind,
          ...queried.entries.length === 0 ? {} : { entries: queried.entries.map(entry => ({ ...entry })) },
          ...queried.text === undefined ? {} : { text: queried.text },
        }
      }

      if (args.action === 'create') {
        if (args.target === 'folder') {
          const created = await options.store.createFolder(session, args.path, { signal: exec.signal })
          return { action: 'create', path: created.path, kind: 'directory' }
        }
        if (args.target !== 'file') throw new Error('invalid create: `target` must be `file` or `folder`')
        if (args.content === undefined) throw new Error('invalid create: creating a file requires `content`')
        const created = await options.store.createFile(session, args.path, args.content, { signal: exec.signal })
        return { action: 'create', path: created.path, kind: 'file' }
      }

      const removed = await options.store.remove(session, args.path, {
        recursive: args.recursive === true,
        signal: exec.signal,
      })
      return { action: 'delete', path: removed.path, kind: removed.kind === 'directory' ? 'directory' : 'file' }
    },
    presentCall: args => ({ card: 'generic', title: `.dsh store: ${args.action}`, kind: 'other', rawInput: args }),
  })
}

/**
 * Refuse a model-side create or delete inside the managed-memory area. The
 * memory capability owns that area and persists it through the store service;
 * this tool may only query it.
 * @param path - the model-supplied store-relative path.
 * @throws Error when the normalized path is `memory` or below it.
 */
function refuseMemoryPath(path: string): void {
  if (!isMemoryPath(normalizeStorePath(path).displayPath)) return
  throw new Error(
    `refusing to modify ${STORE_DIR_NAME}/memory: memory is managed by the memory capability; use its tools instead`,
  )
}

/** Render one store result as the model-visible text. */
function renderStoreValue(value: StoreToolValue): string {
  const target = value.path.length === 0 ? `${STORE_DIR_NAME}/` : `${STORE_DIR_NAME}/${value.path}`
  if (value.action === 'create') return `Created ${value.kind} ${target}.`
  if (value.action === 'delete') return `Deleted ${value.kind} ${target}.`
  if (value.kind === 'missing') return `Not found: ${target}.`
  if (value.kind === 'other') return `${target} is neither a file nor a folder.`
  if (value.kind === 'file') {
    return value.text === undefined ? `${target} is a file.` : `${target}:\n${value.text}`
  }
  const entries = value.entries ?? []
  const lines = entries.map((entry) => {
    const suffix = entry.size === undefined ? '' : ` (${entry.size} bytes)`
    return `- ${entry.kind} ${STORE_DIR_NAME}/${entry.path}${suffix}`
  })
  return [`${target} contains ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}:`, ...lines].join('\n')
}
