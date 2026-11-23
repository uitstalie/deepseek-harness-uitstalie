/**
 * workspace-tools: the workspace information toolset provider.
 *
 * The provider registers one capability with the dafeiyu organizer, which wires
 * its tools onto every agent, and provides the `ctx.workspaceTasks` service so
 * a trusted in-process caller records the same task, validated against its
 * intent card when the task references one, instead of a
 * second list. It owns no records of its
 * own beyond the task, message, intent, and artifact state under
 * `$DSH_HOME/workspaces/`; sessions come from the session store, workspaces
 * from the workspace registry, and artifact content from the workspace
 * directory.
 * @module @deepseek-ai/dsh-workspace-tools
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { CapabilityContribution, CapabilityRuntime } from '@deepseek-ai/dsh-dafeiyu'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-store-atom'
import type {} from '@deepseek-ai/dsh-workspace'
import { createWorkspaceTasksService } from './service.ts'
import {
  LEASE_ACTIVE_TURN_GRACE_MS,
  LEASE_IDLE_MS,
  LEASE_MAX_MS,
  defaultLeaseHome,
  mountWorkspaceLease,
} from './lease.ts'
import {
  WORKSPACE_DIRECTORY_SECTION_NAME,
  WORKSPACE_DIRECTORY_SECTION_ORDER,
  WORKSPACE_ROUTING_SECTION_NAME,
  WORKSPACE_ROUTING_SECTION_ORDER,
  workspaceDirectoryText,
  workspaceRoutingText,
} from './prompt.ts'
import { workspaceTools } from './tools.ts'
import { mountReplyGate } from './reply-gate.ts'
import {
  DEFAULT_NOTICE_MAX_PER_TASK,
  DEFAULT_NOTICE_TTL_MS,
  mountCompletionNotices,
} from './completion.ts'
import type { CompletionNoticeMode } from './completion.ts'

export const name = 'workspace-tools'

/** Services the toolset reads: the organizer, workspace state, sessions, files, and registry. */
export const inject = ['dafeiyu', 'dshStore', 'sessionQuery', 'workspaceRegistry', 'fs']

/** Stable capability id this provider registers with the organizer. */
export const WORKSPACE_TOOLSET_CAPABILITY_ID = 'workspace-tools'

/** Contract version the provider implements: contribution plus capability-list metadata. */
export const WORKSPACE_TOOLSET_CONTRACT_VERSION = 2

/** Display name in the organizer's capability list. */
export const WORKSPACE_TOOLSET_LABEL = 'Workspace information'

/** One-sentence capability-list description. */
export const WORKSPACE_TOOLSET_DESCRIPTION = 'Sessions, dispatch tasks, intent cards, messages, artifact references, and question routing for the workspace'

/** Plugin configuration; every field is optional and the schema supplies the default. */
export interface Config {
  /** Workspace write lease: `enforce` refuses a conflicting write, `observe` only audits it. */
  mode?: 'enforce' | 'observe'
  /** Idle window after which an unrenewed lease may be reclaimed, in milliseconds. */
  idleMs?: number
  /** Hard cap on one lease's life, in milliseconds. */
  maxMs?: number
  /**
   * Idle window granted while the holder's turn is open in this process, in
   * milliseconds; a long-running turn keeps its lease instead of losing it to
   * the idle window.
   */
  activeTurnGraceMs?: number
  /** Deliver a task-bound completion notice to a dispatcher when its executor turn ends. */
  completionNotice?: CompletionNoticeMode
  /** Most notices one task may receive inside `noticeTtlMs`. */
  noticeMaxPerTask?: number
  /** Window for the per-task notice cap and duplicate guard, in milliseconds. */
  noticeTtlMs?: number
  /** Enforce that a turn started by a workspace_message must send a reply; default true. */
  replyGate?: boolean
}

/** Validated lease schema; the minimums keep a typo from turning the idle window into no lease at all. */
export const Config: z<Config> = z.object({
  mode: z.union([z.const('enforce'), z.const('observe')]).default('enforce'),
  idleMs: z.number().step(1).min(60_000).default(LEASE_IDLE_MS),
  maxMs: z.number().step(1).min(60_000).default(LEASE_MAX_MS),
  activeTurnGraceMs: z.number().step(1).min(60_000).default(LEASE_ACTIVE_TURN_GRACE_MS),
  completionNotice: z.union([z.const('off'), z.const('task-bound')]).default('off'),
  noticeMaxPerTask: z.number().step(1).min(1).default(DEFAULT_NOTICE_MAX_PER_TASK),
  noticeTtlMs: z.number().step(1).min(1).default(DEFAULT_NOTICE_TTL_MS),
  replyGate: z.boolean().default(true),
})

/**
 * Register the workspace toolset with the organizer.
 *
 * The organizer owns per-agent wiring, so the contribution only declares what
 * it provides. Tools capture this plugin's context, whose `inject` declaration
 * admits the services they read.
 * @param ctx - plugin context carrying the organizer and the read services.
 * @param config - write-lease mode and windows, and the completion-notice switch and limits.
 */
export function apply(ctx: Context, config: Config = {}): void {
  ctx.provide('workspaceTasks', createWorkspaceTasksService(ctx))
  mountWorkspaceLease(ctx, {
    home: defaultLeaseHome(),
    mode: config.mode ?? 'enforce',
    idleMs: config.idleMs ?? LEASE_IDLE_MS,
    maxMs: config.maxMs ?? LEASE_MAX_MS,
    activeTurnGraceMs: config.activeTurnGraceMs ?? LEASE_ACTIVE_TURN_GRACE_MS,
  })
  mountCompletionNotices(ctx, {
    mode: config.completionNotice ?? 'off',
    maxPerTask: config.noticeMaxPerTask ?? DEFAULT_NOTICE_MAX_PER_TASK,
    ttlMs: config.noticeTtlMs ?? DEFAULT_NOTICE_TTL_MS,
  })
  mountReplyGate(ctx, { mode: (config.replyGate ?? true) ? 'enforce' : 'off' })
  const registration = ctx.dafeiyu.register({
    id: WORKSPACE_TOOLSET_CAPABILITY_ID,
    contractVersion: WORKSPACE_TOOLSET_CONTRACT_VERSION,
    label: WORKSPACE_TOOLSET_LABEL,
    description: WORKSPACE_TOOLSET_DESCRIPTION,
    config: {},
    create: (_runtime: CapabilityRuntime): CapabilityContribution => ({
      scope: 'all',
      tools: () => workspaceTools(ctx),
      promptSections: () => [{
        name: WORKSPACE_DIRECTORY_SECTION_NAME,
        order: WORKSPACE_DIRECTORY_SECTION_ORDER,
        text: () => workspaceDirectoryText(ctx),
      }, {
        name: WORKSPACE_ROUTING_SECTION_NAME,
        order: WORKSPACE_ROUTING_SECTION_ORDER,
        text: () => workspaceRoutingText(),
      }],
    }),
  })
  ctx.effect(() => registration, 'workspace-tools.register()')
}
