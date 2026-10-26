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
import type { CapabilityContribution, TurnEndInput } from '@deepseek-ai/dsh-dafeiyu'
import { createStoreAwareness } from './awareness.ts'
import { callerSessionId } from './caller.ts'
import { type HostEnv } from './env.ts'
import { nowUtc } from './envelope.ts'
import { type SessionRecorder, stateDirOf } from './sessionRecord.ts'
import { callerOf, jiraTools } from './tools.ts'

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
 * @returns the contribution the organizer wires onto root agents.
 */
export const createJiraContribution = (host: ContributionHost): CapabilityContribution => {
  const awareness = createStoreAwareness(host.ctx.jira)
  const tools = jiraTools(host)
  /** Starting commits captured at agent creation, keyed by the agent that owns the session. */
  const heads = new WeakMap<Agent, Promise<string>>()

  return Object.freeze({
    // A child agent gets neither the tools nor the awareness line; the handlers still refuse a
    // delegated caller's write, because a PTC sub-dispatch can reach a tool the child was denied.
    scope: 'root',
    tools: () => tools,
    promptSections: () => [awareness.section],
    onAgentCreated: (agent: Agent) => {
      heads.set(agent, headAtStart(host))
      // A resumed or newly opened root agent sees the current ledger before its first turn.
      void awareness.refresh()
    },
    onTurnEnd: async (input: TurnEndInput) => {
      await settleCompletedTurn(host, input.agent, input.turn, await (heads.get(input.agent) ?? headAtStart(host)))
    },
    dispose: () => {
      awareness.dispose()
    },
  })
}
