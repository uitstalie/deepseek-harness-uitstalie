/**
 * The model surface of the jira ledger: the three resident tools' schemas and runners, the
 * caller/permission adapter, the `/jira` read-only command, the bundled skills and the
 * session-close-out bookkeeping.
 *
 * This module is the package's controlled re-export. The Cordis plugin that registers these
 * surfaces — tools, command, skills, the write guard, the awareness line and the settle effect —
 * is the next step: its previous form is preserved under `deferred/` with its wiring tests, and it
 * expects a host whose `tools.register` accepts these definitions.
 *
 * @module @deepseek-ai/dsh-jira-agent
 */

export { type Caller, callerCwd, callerSessionId, describeCaller, isSubagent } from './caller.ts'
export { type CommandsHost, type CommandDefinition, type CommandInvocation, type CommandOptions, type CommandResult, createJiraCommand, registerCommand, runJiraCommand } from './command.ts'
export { type RunOptions, type ToolValue, actorFor, asString, asStringList, failure, nowUtc, okValue, skipped } from './envelope.ts'
export { type HostEnv, type JiraConfig, type JiraExec, type JiraHostContext, type JiraToolDefinition, type ToolGuard, defaultEnv } from './host.ts'
export {
  closeOutSession,
  createSessionRecorder,
  readPushFailure,
  recordPushOutcome,
  stateDirOf,
  toolEvidenceOf,
  type SessionFacts,
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
