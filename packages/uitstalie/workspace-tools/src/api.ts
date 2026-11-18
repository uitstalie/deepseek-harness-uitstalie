/**
 * workspace-tools: the workspace information toolset provider.
 *
 * The provider registers one capability with the dafeiyu organizer, which wires
 * its tools onto every agent, and provides the `ctx.workspaceTasks` service so
 * a trusted in-process caller records the same card-validated task instead of a
 * second list. It owns no records of its
 * own beyond the task, message, intent, and artifact state under
 * `$DSH_HOME/workspaces/`; sessions come from the session store, workspaces
 * from the workspace registry, and artifact content from the workspace
 * directory.
 * @module @deepseek-ai/dsh-workspace-tools
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CapabilityContribution, CapabilityRuntime } from '@deepseek-ai/dsh-dafeiyu'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-store-atom'
import type {} from '@deepseek-ai/dsh-workspace'
import { createWorkspaceTasksService } from './service.ts'
import {
  WORKSPACE_DIRECTORY_SECTION_NAME,
  WORKSPACE_DIRECTORY_SECTION_ORDER,
  workspaceDirectoryText,
} from './prompt.ts'
import { workspaceTools } from './tools.ts'

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
export const WORKSPACE_TOOLSET_DESCRIPTION = 'Sessions, dispatch tasks, intent cards, messages, and artifact references for the workspace'

/**
 * Register the workspace toolset with the organizer.
 *
 * The organizer owns per-agent wiring, so the contribution only declares what
 * it provides. Tools capture this plugin's context, whose `inject` declaration
 * admits the services they read.
 * @param ctx - plugin context carrying the organizer and the read services.
 */
export function apply(ctx: Context): void {
  ctx.provide('workspaceTasks', createWorkspaceTasksService(ctx))
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
      }],
    }),
  })
  ctx.effect(() => registration, 'workspace-tools.register()')
}
