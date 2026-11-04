/**
 * The jira capability provider: the model surface of the ledger.
 *
 * The plugin registers one capability with the dafeiyu organizer, which wires the three tools
 * (`jira_issue`, `jira_list`, `jira_kb`) and the `[store] jira · …` awareness line onto root
 * agents — and, on a delegated child, the executor's single `issue_work` tool instead (DH-512) —
 * and forwards each completed root turn back here to settle the ledger. Beside the capability
 * it installs the monotonic write guard, the `/jira` slash command and the three bundled skills.
 * The ledger itself — its root, its identity, its one push queue — belongs to `jira-service` and
 * is reached only through `ctx.jira`.
 *
 * The organizer owns the enable gate and per-agent wiring, so this provider never subscribes to
 * session or agent lifecycle events itself, and disabling the capability removes every
 * contribution it made. The write guard, `/jira` and the three skills deliberately stay outside
 * the gate (DH-309 boundary): the guard is a ledger invariant for every caller, `/jira` is a
 * human management surface, and the skills are user-invoked procedures. Gating them would let a
 * capability switch disable the guard while the ledger stays reachable.
 *
 * @module @deepseek-ai/dsh-jira-agent
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import type { CapabilityContribution, CapabilityRuntime } from '@deepseek-ai/dsh-dafeiyu'
import type {} from '@deepseek-ai/dsh-jira-service'
import type {} from '@deepseek-ai/dsh-skill'
import z from '@deepseek-ai/schemastery'
import {
  JIRA_CAPABILITY_DESCRIPTION,
  JIRA_CAPABILITY_ID,
  JIRA_CAPABILITY_LABEL,
  JIRA_CONTRACT_VERSION,
  JIRA_SETTINGS_ORDER,
  JIRA_SETTINGS_SECTION,
  createJiraContribution,
} from './contribution.ts'
import type { ContributionHost } from './contribution.ts'
import { defaultEnv } from './env.ts'
import { createSessionRecorder } from './sessionRecord.ts'
import {
  SUPERAGENT_CAPABILITY_DESCRIPTION,
  SUPERAGENT_CAPABILITY_ID,
  SUPERAGENT_CAPABILITY_LABEL,
  SUPERAGENT_SETTINGS_ORDER,
  SUPERAGENT_SETTINGS_SECTION,
  createSuperagentContribution,
  ensureSuperWorkspace,
  workspaceRegistryOf,
} from './superagent.ts'
import { installWriteGuard, registerJiraCommand, registerJiraSkills } from './wiring.ts'

export const name = 'jira-agent'

/**
 * The ledger service, the tool registry the guard registers with, and the organizer the
 * capability registers with. The command and skill registries are optional: a composition
 * without one keeps the tools and loses only that surface, so they are reached through
 * `ctx.inject` rather than declared here.
 */
export const inject = ['jira', 'tools', 'dafeiyu']

/**
 * The agent row's own configuration: which preset an executor Session joins.
 *
 * Everything about the ledger itself still belongs to the `jira-service` row, and whether a model
 * surface exists at all belongs to dafeiyu's gates. This one field exists because a real executor
 * Session gets a whole composition, and the composition it may join has to be decided here rather
 * than by the model (DH-702): without it a dispatched Session would inherit the dispatcher's tools.
 */
export type Config = Readonly<{
  /** The agent preset a `superagent_dispatch` Session joins; unset means dispatch refuses. */
  superagent_worker_preset?: string
  /** How many issues one dispatcher may hold in progress at once; defaults to two. */
  superagent_max_workers?: number
  /** The single GitHub repository the source polls, as `owner/name`; unset means no source. */
  superagent_github_repo?: string
  /** Whether a session-less dispatcher pass may run; defaults to false (DH-714). */
  superagent_daemon?: boolean
  /** The checkout a session-less claim is dispatched into; the daemon needs it to run. */
  superagent_daemon_workspace?: string
  /**
   * The directory the super agent lives in (DH-716); unset means no super workspace.
   *
   * It is registered once at mount, so it shows up in the workspace list like any other checkout,
   * and a conversation opened there is the dispatcher: it keeps `superagent_workspace` and loses
   * the ledger-bound claim verbs.
   */
  superagent_home?: string
}>

/** Schemastery schema for the row configuration. */
export const Config: z<Config> = z.object({
  superagent_worker_preset: z.string(),
  superagent_max_workers: z.number(),
  superagent_github_repo: z.string(),
  superagent_daemon: z.boolean(),
  superagent_daemon_workspace: z.string(),
  superagent_home: z.string(),
})

/**
 * Register the jira capability and its always-on surfaces.
 * @param ctx - plugin context carrying the ledger service, the tool registry and the organizer.
 * @param config - the row configuration; empty by contract.
 */
export function apply(ctx: Context, config: Config): void {
  const env = defaultEnv()
  const clock = (): number => Date.now()
  const recorder = createSessionRecorder()
  const host: ContributionHost = Object.freeze({
    ctx,
    env,
    clock,
    recorder,
    ...(config.superagent_worker_preset === undefined ? {} : { workerPreset: config.superagent_worker_preset }),
  })

  installWriteGuard(ctx, env, config.superagent_worker_preset)
  // The super workspace is a directory plus one registry row, never a second state: registering it
  // here is what makes it visible in the workspace list before anyone opens a conversation (DH-716).
  const superHome = config.superagent_home
  if (superHome !== undefined && superHome.trim() !== '') {
    ctx.inject(['workspaceRegistry'], async (workspaceCtx) => {
      const registry = workspaceRegistryOf(workspaceCtx)
      if (registry === undefined) return
      try {
        await ensureSuperWorkspace(registry, superHome)
      } catch (error: unknown) {
        ctx.logger.warn('jira-agent: the super workspace %s could not be registered: %s', superHome, String(error))
      }
    })
  }
  // Optional registries: the child fiber activates only when the service is composed, and its
  // registrations are released with it.
  ctx.inject(['commands'], (commandCtx) => {
    registerJiraCommand(commandCtx.commands, ctx, env, clock)
  })
  ctx.inject(['skills'], async (skillCtx) => {
    // Awaited: the skill registry opens an effect per registration, and the child fiber must
    // still be active when the file reads finish.
    await registerJiraSkills(skillCtx.skills, import.meta.url)
  })

  const registration = ctx.dafeiyu.register({
    id: JIRA_CAPABILITY_ID,
    contractVersion: JIRA_CONTRACT_VERSION,
    label: JIRA_CAPABILITY_LABEL,
    description: JIRA_CAPABILITY_DESCRIPTION,
    enabledByDefault: false,
    settings: { sectionId: JIRA_SETTINGS_SECTION, order: JIRA_SETTINGS_ORDER },
    config: Object.freeze({ ...config }),
    create: (_runtime: CapabilityRuntime): CapabilityContribution =>
      createJiraContribution(host, config.superagent_worker_preset),
  })
  ctx.effect(() => registration, 'jira.register()')

  // DH-513: the claim loop is a second capability on the same row. It is gated on its own, and it
  // has its own id so a deployment can enable the dispatcher without widening the ledger's surface.
  const superagent = ctx.dafeiyu.register({
    id: SUPERAGENT_CAPABILITY_ID,
    contractVersion: JIRA_CONTRACT_VERSION,
    label: SUPERAGENT_CAPABILITY_LABEL,
    description: SUPERAGENT_CAPABILITY_DESCRIPTION,
    enabledByDefault: false,
    settings: { sectionId: SUPERAGENT_SETTINGS_SECTION, order: SUPERAGENT_SETTINGS_ORDER },
    config: Object.freeze({}),
    create: (_runtime: CapabilityRuntime): CapabilityContribution =>
      createSuperagentContribution(
        host,
        config.superagent_worker_preset,
        config.superagent_max_workers,
        config.superagent_github_repo,
        {
          enabled: config.superagent_daemon === true,
          ...(config.superagent_daemon_workspace === undefined ? {} : { workspace: config.superagent_daemon_workspace }),
        },
        config.superagent_home,
      ),
  })
  ctx.effect(() => superagent, 'superagent.register()')
}

export { JIRA_AWARENESS_ORDER, JIRA_AWARENESS_SECTION_NAME, createStoreAwareness } from './awareness.ts'
export type { AwarenessSource, StoreAwareness } from './awareness.ts'
export {
  type Caller,
  agentPresetOf,
  callerCwd,
  callerParentSessionId,
  callerSessionId,
  describeCaller,
  isExecutorSession,
  isSubagent,
  sessionAgentPreset,
} from './caller.ts'
export {
  type CommandDefinition,
  type CommandInvocation,
  type CommandOptions,
  type CommandResult,
  createJiraCommand,
  runJiraCommand,
} from './command.ts'
export {
  JIRA_CAPABILITY_DESCRIPTION,
  JIRA_CAPABILITY_ID,
  JIRA_CAPABILITY_LABEL,
  JIRA_CONTRACT_VERSION,
  JIRA_EXECUTOR_ORDER,
  JIRA_EXECUTOR_SECTION_NAME,
  JIRA_SETTINGS_ORDER,
  JIRA_SETTINGS_SECTION,
  createJiraContribution,
  settleCompletedTurn,
} from './contribution.ts'
export type { ContributionHost } from './contribution.ts'
export { type HostEnv, defaultEnv, readOnlySession } from './env.ts'
export { type RunOptions, type ToolValue, actorFor, asString, asStringList, failure, nowUtc, okValue, skipped } from './envelope.ts'
export {
  createSessionRecorder,
  readPushFailure,
  recordPushOutcome,
  stateDirOf,
  toolEvidenceOf,
  type SessionFacts,
  type SessionRecorder,
} from './sessionRecord.ts'
export {
  SKILL_CATALOGUE,
  type SkillDefinition,
  type SkillsHost,
  packageRootFrom,
  readSkillBody,
  registerSkills,
  skillPath,
} from './skills.ts'
export {
  ISSUE_DESCRIPTION,
  ISSUE_OUTPUT_SCHEMA,
  ISSUE_PARAMETERS,
  READ_ACTIONS,
  READ_TIMEOUT_MS,
  TOOL_NAME,
  WRITE_ACTIONS,
  WRITE_TIMEOUT_MS,
  runIssueTool,
} from './toolIssue.ts'
export { KB_DESCRIPTION, KB_OUTPUT_SCHEMA, KB_PARAMETERS, KB_TOOL_NAME, runKbTool } from './toolKb.ts'
export { LIST_DESCRIPTION, LIST_OUTPUT_SCHEMA, LIST_PARAMETERS, LIST_TOOL_NAME, runListTool } from './toolList.ts'
export { type CallContext, type ToolHost, jiraTools, jiraWorkerTools } from './tools.ts'
export {
  type GhRunner,
  type GithubItem,
  pollGithub,
} from './github.ts'
export { JIRA_COMMAND_NAME, installWriteGuard, registerJiraCommand, registerJiraSkills } from './wiring.ts'
export {
  REVIEW_STATUS,
  WAITING_FOR,
  WORK_ACTIONS,
  WORK_DESCRIPTION,
  WORK_PARAMETERS,
  WORK_TOOL_NAME,
  type WorkAccess,
  blockedBody,
  blockedMarker,
  runWorkTool,
  workAccess,
} from './workIssue.ts'
export {
  CLAIM_APPROVED_MARKER,
  CLAIMABLE_STATUS,
  CLAIM_DESCRIPTION,
  CLAIM_PARAMETERS,
  CLAIM_TOOL_NAME,
  DEFAULT_MAX_WORKERS,
  DAEMON_SESSION_ID,
  DISPATCH_DESCRIPTION,
  DISPATCH_MARKER,
  DISPATCH_PARAMETERS,
  DISPATCH_TOOL_NAME,
  PROPOSAL_MARKER,
  SCAN_DESCRIPTION,
  SCAN_PARAMETERS,
  SCAN_TOOL_NAME,
  SOURCE_DESCRIPTION,
  SOURCE_PARAMETERS,
  SOURCE_TOOL_NAME,
  STATUS_TOOL_NAME,
  SUPERAGENT_CAPABILITY_DESCRIPTION,
  SUPERAGENT_CAPABILITY_ID,
  SUPERAGENT_CAPABILITY_LABEL,
  SUPERAGENT_OUTPUT_SCHEMA,
  SUPERAGENT_SECTION,
  SUPERAGENT_SECTION_NAME,
  SUPERAGENT_SECTION_ORDER,
  SUPERAGENT_WORKSPACE_TITLE,
  WORKSPACE_DESCRIPTION,
  WORKSPACE_PARAMETERS,
  WORKSPACE_TOOL_NAME,
  type Claimability,
  type DaemonPassOptions,
  type SessionControllerLike,
  type SuperagentDaemonConfig,
  type WorkspaceLike,
  type WorkspaceRegistryLike,
  claimability,
  createSuperagentContribution,
  daemonIdentityOf,
  dispatchInstruction,
  dispatchRecordOf,
  ensureSuperWorkspace,
  isBlocked,
  isSuperAgentSession,
  openProposal,
  runClaimTool,
  runDaemonPass,
  runDispatchTool,
  runScanTool,
  runSourceTool,
  runStatusTool,
  runSuperagentPass,
  runWorkspaceTool,
  sameCheckout,
  sessionControllerOf,
  workspaceRegistryOf,
} from './superagent.ts'
