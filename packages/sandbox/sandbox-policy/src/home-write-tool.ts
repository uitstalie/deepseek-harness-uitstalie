/**
 * The approval-gated editor for the `home-write` force-read-only list.
 *
 * The tool can only change `excludePaths`; mode, home roots, temp
 * roots and symlink policy remain deployment configuration. Every add and
 * remove asks the composed approval channel first; a rejection includes the
 * concrete path that would become writable/read-only. Persisted edits go
 * through the same profile config editor as the settings UI, and every
 * applied change is appended to an audit JSONL beside the profile patch so a
 * later rollback can restore the previous value.
 *
 * @module @deepseek-ai/dsh-sandbox-policy/home-write-tool
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'

/** The tool name: a deliberate, narrow verb, not a generic config editor. */
export const HOME_WRITE_TOOL_NAME = 'sandbox_home_readonly'

/** One audit record appended after a successful approved change. */
export interface HomeWriteAuditRecord {
  readonly id: string
  readonly at: string
  readonly actor: string
  readonly action: 'add' | 'remove' | 'rollback'
  readonly path?: string
  readonly before: readonly string[]
  readonly after: readonly string[]
  readonly justification?: string
}

/** The subset of the profile config editor this tool needs; duck-typed on purpose. */
export interface HomeWriteConfigEditor {
  readonly documentPath: string
  entries(): readonly {
    readonly options: { readonly id: string; readonly name?: string }
  }[]
  configuration(): readonly {
    readonly entry: { readonly options: { readonly id: string; readonly name?: string } }
    readonly inherited: Readonly<Record<string, unknown>>
    readonly override: Readonly<Record<string, unknown>>
  }[]
  edit(
    entry: unknown,
    change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void>
}

/** The approval channel this tool must use; no local popup. */
export interface HomeWriteApproval {
  request(request: {
    readonly agent: unknown
    readonly toolName: string
    readonly callId: unknown
    readonly reason: string
    readonly displayReason?: { readonly en: string; readonly [locale: string]: string }
    readonly signal?: AbortSignal
  }): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>
}

/** What the tool needs from the live policy service. */
export interface HomeWritePolicyView {
  readonly homeWriteRoots: readonly string[]
  readonly homeWriteTempRoots: readonly string[]
  readonly excludePaths: readonly string[]
  readonly homeWriteAllowSymlinkedRoots: boolean
}

const AUDIT_FILE = 'sandbox-home-readonly-audit.jsonl'

/** Whether `candidate` is under `root` (canonical paths; case-insensitive on Windows). */
const under = (root: string, candidate: string): boolean => {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Resolve one candidate and enforce the symlink opt-in; return the canonical path. */
const resolveCandidate = (path: string, allowSymlink: boolean): string => {
  if (path.trim() === '' || !isAbsolute(path) || path.includes('\0')) {
    throw new Error('`path` must be an absolute path without NUL bytes')
  }
  let physical: string
  try {
    physical = realpathSync.native(path)
    if (!statSync(physical).isDirectory()) throw new Error('not a directory')
  } catch (error: unknown) {
    throw new Error(`\`path\` ${JSON.stringify(path)} must be an existing directory: ${String(error)}`)
  }
  if (!allowSymlink && physical !== resolve(path)) {
    throw new Error(`\`path\` ${JSON.stringify(path)} is a symlink spelling; use ${JSON.stringify(physical)} or enable homeWriteAllowSymlinkedRoots`)
  }
  return physical
}

/** Read the audit file; a missing file is an empty history. */
const readAudit = async (file: string): Promise<HomeWriteAuditRecord[]> => {
  try {
    return (await readFile(file, 'utf8')).split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line) as HomeWriteAuditRecord)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/** Append one audit record. */
const appendAudit = async (file: string, record: HomeWriteAuditRecord): Promise<void> => {
  await mkdir(dirname(file), { recursive: true })
  await appendFile(file, `${JSON.stringify(record)}\n`, 'utf8')
}

/** Ask the composed approval channel, mapping every non-grant outcome to a concrete refusal. */
const approve = async (
  approval: HomeWriteApproval | undefined,
  agent: unknown,
  callId: unknown,
  signal: AbortSignal | undefined,
  action: 'add' | 'remove' | 'rollback',
  path: string | undefined,
  justification: string,
): Promise<void> => {
  if (approval === undefined) throw new Error('home-write read-only changes require an approval service, and this deployment has none')
  const subject = action === 'remove'
    ? `Stop excluding ${JSON.stringify(path)}; under home-write that path becomes writable.`
    : action === 'add'
      ? `Exclude (force read-only) the path ${JSON.stringify(path)}.`
      : 'Roll back the previous force-read-only change.'
  const reason = `sandbox home-write ${action}: ${subject} Reason: ${justification}`
  const outcome = await approval.request({
    agent,
    toolName: HOME_WRITE_TOOL_NAME,
    callId,
    reason,
    displayReason: { en: reason },
    ...(signal === undefined ? {} : { signal }),
  })
  if (outcome === 'allowed-once') return
  if (outcome === 'rejected') {
    throw new Error(`the user rejected ${action === 'remove' ? 'REMOVING protection' : 'the change'}: ${subject}`)
  }
  if (outcome === 'cancelled') throw new Error(`the approval for ${action} was cancelled; ${subject}`)
  throw new Error(`approval for ${action} is unavailable; ${subject}`)
}

/**
 * Build the registration for the force-read-only editor.
 * @param ctx - plugin context carrying the policy service and optional approval/editor.
 * @param view - the live policy's effective list and boundary facts.
 * @returns the tool definition, or undefined when the tool registry is absent.
 */
export const homeWriteTool = (ctx: Context, view: HomeWritePolicyView): ToolDefinition => defineTool({
  name: HOME_WRITE_TOOL_NAME,
  description:
    'List or request an approval-gated change to the home-write excludePaths list. '
    + '`add` and `remove` ask the user through the approval channel; removal is a protection weakening '
    + 'and is shown with that consequence. `rollback` restores the previous audited list. The tool '
    + 'cannot change the sandbox mode, home roots, temp exceptions, or symlink policy.',
  parameters: {
    action: { type: 'string', required: true, enum: ['list', 'add', 'remove', 'rollback'], description: 'The operation.' },
    path: { type: 'string', description: 'add/remove: absolute directory path.' },
    justification: { type: 'string', description: 'add/remove/rollback: one sentence for the approval prompt.' },
  },
  output: {
    schema: { type: 'object', additionalProperties: false, properties: { roots: { type: 'array', items: { type: 'string' } }, path: { type: 'string' }, message: { type: 'string' } } },
    render: (_args, value) => [{ type: 'text', text: value.message ?? '' }],
  },
  async execute(args, exec) {
    const editor = ctx.get('configEditor') as HomeWriteConfigEditor | undefined
    const approval = ctx.get('approval') as HomeWriteApproval | undefined
    const entry = editor?.entries().find(row => row.options.id === 'sandbox-policy')
    if (editor === undefined || entry === undefined) throw new Error('persisting the home-write list needs the profile config editor and a sandbox-policy row')
    const auditFile = join(dirname(editor.documentPath), AUDIT_FILE)
    const list = [...view.excludePaths]
    if (args.action === 'list') {
      return { roots: list, message: `Excluded paths: ${list.length === 0 ? '(none)' : list.join(', ')}. Audit: ${auditFile}` }
    }
    if (args.justification === undefined || args.justification.trim() === '') {
      throw new Error('`justification` must be a non-empty sentence for an approval-gated change')
    }
    let next: string[]
    let action: 'add' | 'remove' | 'rollback' = args.action
    let path: string | undefined
    if (args.action === 'rollback') {
      const history = await readAudit(auditFile)
      const last = history.at(-1)
      if (last === undefined) throw new Error('there is no audited home-write change to roll back')
      await approve(approval, exec.agent, exec.callId, exec.signal, 'rollback', undefined, args.justification.trim())
      next = [...last.before]
      action = 'rollback'
    } else {
      const resolvedPath = resolveCandidate(args.path ?? '', view.homeWriteAllowSymlinkedRoots)
      path = resolvedPath
      const roots = [...view.homeWriteRoots, ...view.homeWriteTempRoots]
      if (roots.length > 0 && !roots.some(root => under(root, resolvedPath))) {
        throw new Error(`\`path\` ${JSON.stringify(resolvedPath)} must stay inside a configured home-write root or temp exception`)
      }
      await approve(approval, exec.agent, exec.callId, exec.signal, args.action, path, args.justification.trim())
      next = args.action === 'add'
        ? [...new Set([...list, path])]
        : list.filter(root => root !== path)
    }
    await editor.edit(entry, current => ({
      ...current,
      excludePaths: next,
    }))
    await appendAudit(auditFile, {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      at: new Date().toISOString(),
      actor: typeof (exec.agent as { session?: { id?: unknown } } | undefined)?.session?.id === 'string'
        ? (exec.agent as { session: { id: string } }).session.id
        : 'unknown',
      action,
      ...(path === undefined ? {} : { path }),
      before: list,
      after: next,
      justification: args.justification.trim(),
    })
    return {
      roots: next,
      ...(path === undefined ? {} : { path }),
      message: `Excluded paths updated (${action}). ${next.length === 0 ? 'No roots remain.' : next.join(', ')}`,
    }
  },
})
