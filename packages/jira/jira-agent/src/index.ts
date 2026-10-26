/**
 * The jira capability provider: the model surface of the ledger.
 *
 * The plugin registers one capability with the dafeiyu organizer, which wires the three tools
 * (`jira_issue`, `jira_list`, `jira_kb`) and the `[store] jira · …` awareness line onto root
 * agents and forwards each completed turn back here to settle the ledger. Beside the capability
 * it installs the monotonic write guard, the `/jira` slash command and the three bundled skills.
 * The ledger itself — its root, its identity, its one push queue — belongs to `jira-service` and
 * is reached only through `ctx.jira`.
 *
 * The organizer owns the enable gate and per-agent wiring, so this provider never subscribes to
 * session or agent lifecycle events itself, and disabling the capability removes every
 * contribution it made.
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
 * The agent row takes no configuration of its own.
 *
 * Where the ledger lives, who writes it and whether a settle pushes all belong to the
 * `jira-service` row; whether the model surface is created at all belongs to dafeiyu's
 * `capabilities.jira.enabled` gate. A config field here would be a second place for one of them.
 */
export type Config = Readonly<Record<never, never>>

/** Schemastery schema for the empty row configuration. */
export const Config: z<Config> = z.object({})

/**
 * Register the jira capability and its always-on surfaces.
 * @param ctx - plugin context carrying the ledger service, the tool registry and the organizer.
 * @param config - the row configuration; empty by contract.
 */
export function apply(ctx: Context, config: Config): void {
  const env = defaultEnv()
  const clock = (): number => Date.now()
  const recorder = createSessionRecorder()
  const host: ContributionHost = Object.freeze({ ctx, env, clock, recorder })

  installWriteGuard(ctx, env)
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
    create: (_runtime: CapabilityRuntime): CapabilityContribution => createJiraContribution(host),
  })
  ctx.effect(() => registration, 'jira.register()')
}

export { JIRA_AWARENESS_ORDER, JIRA_AWARENESS_SECTION_NAME, createStoreAwareness } from './awareness.ts'
export type { AwarenessSource, StoreAwareness } from './awareness.ts'
export {
  type Caller,
  agentPresetOf,
  callerCwd,
  callerSessionId,
  describeCaller,
  isSubagent,
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
export { type CallContext, type ToolHost, jiraTools } from './tools.ts'
export { JIRA_COMMAND_NAME, installWriteGuard, registerJiraCommand, registerJiraSkills } from './wiring.ts'
