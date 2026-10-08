/**
 * The single model-facing `tool-dsh-store` tool: create, query, and delete files
 * and folders under a workspace's `.dsh` directory. Paths are validated before
 * use, mutations pass the session policy gate, and the `rules` namespace is
 * checked for authoring rules before anything is written.
 * @module @deepseek-ai/dsh-tool-dsh-store/tool
 */

import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { trimmedInstructionDigest } from '@deepseek-ai/dsh-agent-instructions'
import { scanWorkspaceRules } from '@deepseek-ai/dsh-agent-instructions-plus'
import { normalizeStorePath, resolveStoreTarget, RULES_NAMESPACE_PATTERN, STORE_DIR_NAME } from './paths.ts'
import {
  createStoreFile,
  createStoreFolder,
  queryStoreTarget,
  removeStoreTarget,
} from './store-ops.ts'
import { resolveStorePolicy } from './policy.ts'

/** The per-file cap applied when the rules namespace is scanned for duplicates. */
const RULE_SOURCE_MAX_BYTES = 256 * 1024

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
  /**
   * Resolve the absolute `.dsh` root of the calling session, creating it when
   * the configuration asks for that.
   */
  resolveRoot(exec: ToolExecution): Promise<string>
}

/**
 * Validate one `rules/**` creation against the namespace's authoring rules.
 *
 * Rules are always-on plain Markdown with no activation metadata, so the only
 * two ways to author a bad rule are a non-Markdown or empty file and a file
 * whose text repeats an existing rule. Both are refused here, before the write,
 * so the loaded rules never contain a silent duplicate.
 * @param fileSystem - provider used to scan the existing rules.
 * @param root - absolute `.dsh` root.
 * @param displayPath - the `.dsh`-relative target path.
 * @param content - the text about to be written.
 * @param signal - cancellation for the scan.
 * @throws Error naming the violated rule; nothing is written.
 */
async function validateRuleCreate(
  fileSystem: FileSystem,
  root: string,
  displayPath: string,
  content: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!RULES_NAMESPACE_PATTERN.test(displayPath)) {
    throw new Error('invalid rule: a rule file is Markdown under `rules/`, for example `rules/api.md`')
  }
  if (content.trim().length === 0) throw new Error('invalid rule: rule text must not be empty')
  const scan = await scanWorkspaceRules(fileSystem, {
    projectRoot: dirname(root),
    maxSourceBytes: RULE_SOURCE_MAX_BYTES,
    ...signal === undefined ? {} : { signal },
  })
  const digest = trimmedInstructionDigest(content)
  const duplicate = scan.files.find(file => trimmedInstructionDigest(file.content) === digest)
  if (duplicate !== undefined) {
    throw new Error(`duplicate rule: ${duplicate.displayPath} already carries this text; edit that file instead of adding a copy`)
  }
}

/**
 * Build the `tool-dsh-store` tool definition.
 * @param ctx - plugin context carrying the filesystem and sandbox-policy services.
 * @param options - root resolution for the calling session.
 * @returns the tool definition to register on `ctx.tools`.
 */
export function defineStoreTool(ctx: Context, options: StoreToolOptions) {
  return defineTool({
    name: 'tool-dsh-store',
    description:
      `Create, inspect, and delete files and folders under this workspace's \`${STORE_DIR_NAME}\` directory, `
      + `which carries editor rules (\`${STORE_DIR_NAME}/rules\`), project skills, and runtime snapshots. `
      + 'Give a path relative to that directory. Use this tool instead of the generic write, edit, or shell '
      + `tools for \`${STORE_DIR_NAME}\` content, because it validates the path, refuses rules that repeat an `
      + 'existing rule, and reports what it deleted.',
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
      const fileSystem = ctx.fs
      const root = await options.resolveRoot(exec)
      const normalized = normalizeStorePath(args.path)
      const absolutePath = resolveStoreTarget(root, normalized)
      const displayPath = normalized.displayPath

      // Querying reads the store, so a read-only session may still inspect it;
      // only create and delete pass the write gate.
      if (args.action === 'query') {
        const queried = await queryStoreTarget(fileSystem, absolutePath, displayPath, {
          readText: true,
          signal: exec.signal,
        })
        return {
          action: 'query',
          path: queried.path,
          kind: queried.kind,
          ...queried.entries.length === 0 ? {} : { entries: queried.entries.map(entry => ({ ...entry })) },
          ...queried.text === undefined ? {} : { text: queried.text },
        }
      }

      const policy = resolveStorePolicy(ctx, exec)

      if (args.action === 'create') {
        if (args.target === 'folder') {
          await createStoreFolder(fileSystem, absolutePath, displayPath, exec.signal, policy.execution)
          return { action: 'create', path: displayPath, kind: 'directory' }
        }
        if (args.target !== 'file') throw new Error('invalid create: `target` must be `file` or `folder`')
        if (args.content === undefined) throw new Error('invalid create: creating a file requires `content`')
        if (isRulesPath(displayPath)) {
          await validateRuleCreate(fileSystem, root, displayPath, args.content, exec.signal)
        }
        await createStoreFile(fileSystem, absolutePath, displayPath, args.content, exec.signal, policy.execution)
        return { action: 'create', path: displayPath, kind: 'file' }
      }

      const existing = await fileSystem.stat(
        await fileSystem.resolve(absolutePath, { signal: exec.signal }),
        exec.signal,
      )
      if (existing === undefined) throw new Error(`not found: ${STORE_DIR_NAME}/${displayPath}`)
      if (displayPath.length === 0) throw new Error(`refusing to delete the ${STORE_DIR_NAME} root`)
      const removed = await removeStoreTarget(
        fileSystem,
        absolutePath,
        displayPath,
        args.recursive === true,
        exec.signal,
        policy.execution,
      )
      return { action: 'delete', path: removed.path, kind: removed.kind === 'directory' ? 'directory' : 'file' }
    },
    presentCall: args => ({ card: 'generic', title: `.dsh store: ${args.action}`, kind: 'other', rawInput: args }),
  })
}

/** Whether a `.dsh`-relative path names a rule file. */
function isRulesPath(displayPath: string): boolean {
  return displayPath === 'rules' || displayPath.startsWith('rules/')
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
