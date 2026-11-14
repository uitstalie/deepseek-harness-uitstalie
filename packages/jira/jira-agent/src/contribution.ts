/**
 * The dafeiyu capability: what the `jira` provider contributes to a root agent, and what it does
 * when a turn completes.
 *
 * The organizer owns the enable gate, the per-agent wiring and turn filtering, so this module
 * declares only the contribution: the three tools, the awareness section, the session's starting
 * commit (captured when the agent is created) and the settle that follows every completed turn.
 * Disabling the capability removes every one of them and stops the `changed` subscription.
 *
 * @module @deepseek-ai/dsh-jira-agent/contribution
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { withMinRole } from '@deepseek-ai/dsh-dafeiyu'
import type { CapabilityContribution, TurnEndInput } from '@deepseek-ai/dsh-dafeiyu'
import { createStoreAwareness, JIRA_AWARENESS_ORDER, JIRA_AWARENESS_SECTION_NAME } from './awareness.ts'
import { callerSessionId, isExecutorSession, isSubagent } from './caller.ts'
import { type HostEnv } from './env.ts'
import { nowUtc } from './envelope.ts'
import { type SessionRecorder, stateDirOf } from './sessionRecord.ts'
import { callerOf, jiraTools, jiraWorkerTools } from './tools.ts'

/** Stable capability id this provider registers with the organizer. */
export const JIRA_CAPABILITY_ID = 'jira'

/** Contract version the provider implements: contribution plus capability-list metadata. */
export const JIRA_CONTRACT_VERSION = 2

/** Display name in the organizer's capability list. */
export const JIRA_CAPABILITY_LABEL = 'Jira'

/** One-sentence capability-list description. */
export const JIRA_CAPABILITY_DESCRIPTION = 'Workspace issue ledger and knowledge base'

/** The section `ui-jira` owns, linked from the capability list. */
export const JIRA_SETTINGS_SECTION = 'jira'

/** Sort order of that section inside the settings navigation. */
export const JIRA_SETTINGS_ORDER = 200

/** Registry name of the standing instructions a delegated executor reads (DH-514). */
export const JIRA_EXECUTOR_SECTION_NAME = 'jira:executor'

/** One order after the awareness line: the same ledger, one level closer. */
export const JIRA_EXECUTOR_ORDER = 701

/**
 * The executor's standing instructions, as a static section.
 *
 * Static on purpose (DH-514): a child pays for the text once and keeps the prefix cached, so the
 * per-issue dispatch instruction only has to name the issue. This is what a worker preset would
 * have carried, without the extra bundle row.
 */
const EXECUTOR_SECTION = Object.freeze({
  name: JIRA_EXECUTOR_SECTION_NAME,
  order: JIRA_EXECUTOR_ORDER,
  text: 'You are executing one issue that a dispatcher claimed for you. Read it with jira_issue get '
    + 'and work in this checkout. Report through issue_work: `progress` while you work, `deliver` '
    + 'with the evidence when it is done, `blocked` with `waiting_for` when it cannot go on. That '
    + 'is the only way you may change the ledger; jira_issue and jira_kb writes are refused for you.',
})

/** The services and process facts one contribution is built from. */
export interface ContributionHost {
  /** The plugin context; `ctx.jira` is the ledger service. */
  readonly ctx: Context
  /** The process environment the state directory and read-only switch come from. */
  readonly env: HostEnv
  /** The clock, in milliseconds, that audit timestamps are formatted from. */
  readonly clock: () => number
  /** The per-plugin session recorder; a reload starts a fresh one. */
  readonly recorder: SessionRecorder
  /** The configured executor preset: a Session that joined it writes only through `issue_work`. */
  readonly workerPreset?: string
}

/**
 * The commit HEAD pointed at when the agent was created.
 *
 * The close-out scan starts here on the session's first completed turn and from its own watermark
 * afterwards, so a commit made during the session is scanned exactly once.
 * @param host - the contribution host whose ledger service resolves the root.
 * @returns the starting commit, or the empty string when there is no repository to ask.
 */
const headAtStart = (host: ContributionHost): Promise<string> => host.ctx.jira.gitHead()

/**
 * Refresh the derived files, commit them and record what this session touched.
 *
 * A read-only or delegated session writes nothing, not even here (decisions 89/93). A failure is
 * logged rather than thrown: the turn already completed, and dafeiyu isolates a failing hook
 * anyway — reporting it in the log is what makes it visible without turning it into an error the
 * user must handle.
 *
 * This is the operation `onTurnEnd` runs; it takes the agent rather than a whole
 * {@link TurnEndInput} so the same settle can be driven for the session's first turn from
 * `onAgentCreated` (the agent's creation is when the starting commit is captured).
 * @param host - the contribution host.
 * @param agent - the agent whose turn completed.
 * @param turn - the turn number, for the failure report.
 * @param head - the commit the session started from.
 * @returns a promise that settles after the settle and the close-out scan.
 */
export const settleCompletedTurn = async (
  host: ContributionHost,
  agent: Agent,
  turn: number,
  head: string,
): Promise<void> => {
  if (!callerOf(host, agent).writable) return
  const settled = await host.ctx.jira.settle()
  if (!settled.ok) {
    host.ctx.logger.warn('jira: settle after turn %d failed: %s', turn, settled.error.message)
    return
  }
  const sessionId = callerSessionId(agent)
  if (sessionId === undefined) return
  await host.ctx.jira.closeOutSession(
    sessionId,
    head,
    stateDirOf(host.env, host.ctx.jira.root),
    nowUtc(host.clock),
  )
}

/**
 * Build one capability contribution.
 *
 * `create()` runs once per enabled registration, so the `changed` subscription and the tool
 * definitions live exactly as long as the capability does.
 * @param host - the services and process facts the contribution reads.
 * @param workerPreset - the configured executor preset; an agent that joined it is a worker.
 * @returns the contribution the organizer wires onto root agents.
 */
export const createJiraContribution = (host: ContributionHost, workerPreset?: string): CapabilityContribution => {
  const awareness = createStoreAwareness(host.ctx.jira)
  const tools = jiraTools(host)
  const workerTools = jiraWorkerTools(host)
  /** Starting commits captured at agent creation, keyed by the agent that owns the session. */
  const heads = new WeakMap<Agent, Promise<string>>()
  /**
   * Whether this agent is an executor rather than a dispatcher: a delegated child, or a real
   * Session that joined the worker preset (DH-703). Both get the reading tools plus `issue_work`,
   * and neither settles the ledger.
   */
  const isWorker = (agent: Agent): boolean => isSubagent(agent) || isExecutorSession(agent, workerPreset)

  // The awareness line is a runtime context (appended when it changes), not a system-prompt
  // section: the ledger counts change while a conversation is open, and a changing system prefix
  // invalidates the provider's cache for the entire conversation.
  let awarenessContextDispose: (() => void) | undefined
  const inject = (host.ctx as { inject?: (names: readonly string[], callback: (scope: unknown) => void) => unknown }).inject
  if (typeof inject === 'function') {
    inject.call(host.ctx, ['systemPrompt'], (scope) => {
      const systemPrompt = (scope as {
        systemPrompt?: { context?: (entry: {
          name: string
          order: number
          text: (context: { agent?: Agent }) => string
        }) => () => void }
      }).systemPrompt
      if (systemPrompt?.context === undefined) return
      awarenessContextDispose = systemPrompt.context({
        name: JIRA_AWARENESS_SECTION_NAME,
        order: JIRA_AWARENESS_ORDER,
        text: (context: { agent?: Agent }) => {
          const agent = context.agent
          return agent === undefined || isWorker(agent) ? '' : awareness.text()
        },
      })
    })
  }

  return Object.freeze({
    // DH-512/514/703: a worker gets the ledger's three tools for reading the issue it was
    // dispatched for (their writes stay refused, decision 89, and `jira_kb` checks the same
    // verdict) plus `issue_work`, which is the only surface it may write through.
    scope: 'all',
    tools: (agent: Agent) => Object.freeze((isWorker(agent) ? [...tools, ...workerTools] : tools).map(tool => withMinRole(tool, 'agent'))),
    promptSections: (agent: Agent) => (isWorker(agent) ? [EXECUTOR_SECTION] : []),
    onAgentCreated: (agent: Agent) => {
      // A worker neither settles the ledger nor scans the session's commits: it writes one issue
      // through `issue_work`, and the dispatcher owns the commit history.
      if (isWorker(agent)) return
      heads.set(agent, headAtStart(host))
      // A resumed or newly opened root agent sees the current ledger before its first turn.
      void awareness.refresh()
    },
    onTurnEnd: async (input: TurnEndInput) => {
      if (isWorker(input.agent)) return
      await settleCompletedTurn(host, input.agent, input.turn, await (heads.get(input.agent) ?? headAtStart(host)))
    },
    dispose: () => {
      awarenessContextDispose?.()
      awarenessContextDispose = undefined
      awareness.dispose()
    },
  })
}
