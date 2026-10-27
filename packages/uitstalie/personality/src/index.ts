/**
 * personality: the personality capability provider. It registers one capability
 * with the dafeiyu organizer, which wires a stable system-prompt section and the
 * `personality_learn` tool onto every agent and forwards completed turns back
 * here. It also registers the `/personality` drift-review command when a
 * command registry is composed.
 *
 * The provider owns PERSONALITY.md: the global profile under the harness home,
 * the optional workspace overlay, the prompt text, the learning tool, and the
 * version history the command reviews. It never subscribes to session events:
 * the organizer decides which agents receive the contribution and filters the
 * turns the provider sees. The prompt text is cached per agent because
 * `systemPrompt.section` evaluates its text synchronously; the global file is
 * preloaded when the capability activates, one global watcher refreshes that
 * cache while agents live, and each agent's merged view is read again when that
 * agent is created.
 * @module @deepseek-ai/dsh-personality
 */

import type { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { CapabilityContribution, CapabilityRuntime } from '@deepseek-ai/dsh-dafeiyu'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-store-atom'
import { registerPersonalityCommands } from './commands.ts'
import { resolveConfig } from './config.ts'
import type { Config, PersonalitySettings } from './config.ts'
import {
  PersonalityDocumentError,
  readGlobalPersonality,
  readPersonality,
  writePersonalityEntry,
} from './personality-file.ts'
import type { PersonalityEntry, PersonalityEntryKind } from './personality-file.ts'
import { personalityPromptSection, renderPersonalityPrompt } from './prompt.ts'
import PersonalityRemote, { createPersonalityProposalOperations } from './remote.ts'
import { autoEntryName, checkAutoLearnBudget, personalityTools, usageFor } from './tools.ts'
import type { AutoLearnUsage } from './tools.ts'

export const name = 'personality'
/** The organizer, the workspace store, and filesystem access for the global profile. */
export const inject = ['dafeiyu', 'dshStore', 'fs']

/** Stable capability id this provider registers with the organizer. */
export const PERSONALITY_CAPABILITY_ID = 'personality'

/** Contract version the provider implements: contribution plus capability-list metadata. */
export const PERSONALITY_CONTRACT_VERSION = 2

/** Display name in the organizer's capability list. */
export const PERSONALITY_CAPABILITY_LABEL = 'Personality'

/** One-sentence capability-list description. */
export const PERSONALITY_CAPABILITY_DESCRIPTION = 'User-authored working preferences and learned habits applied to every session'

export { Config } from './config.ts'
export { DEFAULT_AUTO_LEARN_BUDGET, resolveConfig } from './config.ts'
export type { AutoLearnBudget, AutoLearnConfig, PersonalitySettings } from './config.ts'
export {
  appendHistory,
  createPersonalityDocument,
  DEFAULT_PERSONALITY_MAX_BYTES,
  mergePersonalityEntries,
  parsePersonalityBlock,
  parsePersonalityDocument,
  parsePersonalityEntryId,
  PERSONALITY_BLOCK_BEGIN,
  PERSONALITY_BLOCK_END,
  PERSONALITY_ENTRY_KINDS,
  PERSONALITY_FILE_NAME,
  PERSONALITY_HISTORY_FILE_NAME,
  PERSONALITY_HISTORY_STORE_PATH,
  PERSONALITY_INITIAL_VERSION,
  PERSONALITY_KIND_REGISTRY,
  PERSONALITY_STORE_PATH,
  PERSONALITY_WORKSPACE_ENTRY_KINDS,
  PersonalityDocumentError,
  personalityGlobalTarget,
  personalityKindDefinition,
  readGlobalPersonality,
  readGlobalPersonalityHistory,
  readPersonality,
  renderPersonalityBlock,
  renderPersonalityDocument,
  revertGlobalPersonality,
  writePersonalityEntry,
} from './personality-file.ts'
export type {
  PersonalityDocument,
  PersonalityDocumentErrorCode,
  PersonalityEntry,
  PersonalityEntryChange,
  PersonalityEntryInput,
  PersonalityEntryKind,
  PersonalityFileRead,
  PersonalityFileTarget,
  PersonalityFrame,
  PersonalityHistoryRead,
  PersonalityHistoryRecord,
  PersonalityHistorySource,
  PersonalityKindDefinition,
  PersonalityRead,
  PersonalityRevertOutcome,
  PersonalityWriteOptions,
  PersonalityWriteResult,
} from './personality-file.ts'
export {
  decideProposal,
  PERSONALITY_PENDING_PROPOSAL_LIMIT,
  PERSONALITY_PROPOSAL_KINDS,
  PERSONALITY_PROPOSALS_FILE_NAME,
  proposeIdentity,
  PersonalityProposalError,
  readProposals,
} from './proposals.ts'
export type {
  PersonalityProposal,
  PersonalityProposalErrorCode,
  PersonalityProposalInput,
  PersonalityProposalRead,
  PersonalityProposalStatus,
} from './proposals.ts'
export {
  diffPersonalityHistory,
  PERSONALITY_COMMAND_NAME,
  PERSONALITY_COMMAND_USAGE,
  personalityCommand,
  registerPersonalityCommands,
  revertPersonality,
  showPersonality,
} from './commands.ts'
export {
  PERSONALITY_PROMPT_ORDER,
  PERSONALITY_PROMPT_PREAMBLE,
  PERSONALITY_PROMPT_SECTION_NAME,
  personalityPromptSection,
  renderPersonalityPrompt,
} from './prompt.ts'
export { personalityTools } from './tools.ts'
export type { AutoLearnUsage, PersonalityLearnValue, PersonalityToolOptions } from './tools.ts'

/**
 * Register the personality capability with the organizer.
 *
 * Configuration is resolved once per plugin load, so a bad path or budget fails
 * the load rather than silently degrading. The organizer owns per-agent wiring
 * and turn filtering; the contribution declares what it provides and keeps the
 * per-agent prompt cache the synchronous section reads. The `/personality`
 * command registers through an optional child context, so a composition that
 * has no command registry still gets the prompt section and the tool.
 * @param ctx - plugin context carrying the organizer and services.
 * @param config - raw provider configuration from the Loader row.
 * @throws Error when the resolved settings are invalid or the capability id is
 *   already registered.
 */
export function apply(ctx: Context, config: Config): void {
  const settings = resolveConfig(config)
  const registration = ctx.dafeiyu.register({
    id: PERSONALITY_CAPABILITY_ID,
    contractVersion: PERSONALITY_CONTRACT_VERSION,
    label: PERSONALITY_CAPABILITY_LABEL,
    description: PERSONALITY_CAPABILITY_DESCRIPTION,
    config: settings,
    settings: { sectionId: 'personality', order: 210 },
    create: runtime => createContribution(ctx, settings, runtime),
  })
  ctx.effect(() => registration, 'personality.register()')
  // The settings page reads and decides through this face; it exists even when
  // the capability's model surface is disabled, because the queue is user data.
  ctx.provide('personalityProposals', createPersonalityProposalOperations(ctx, settings))
  void ctx.plugin(PersonalityRemote)
  // The command child activates only when a command registry is composed.
  ctx.inject(['commands'], (commandCtx) => {
    registerPersonalityCommands(commandCtx, settings)
  })
}

/**
 * Build the capability contribution, preload the global profile, and watch it.
 *
 * The preload is what makes a profile visible to the first assembly: the
 * organizer waits for `create()` before wiring agents. The per-agent read then
 * merges the workspace overlay and picks up external file changes; it starts
 * when the organizer wires the agent. One global watcher keeps the cached text
 * current while agents live; a backend that cannot watch degrades to the
 * per-agent read and logs the reason at debug.
 * @param ctx - plugin context carrying `fs` and `dshStore`.
 * @param settings - resolved provider settings.
 * @param runtime - the organizer's context and cancellation for this registration.
 * @returns the contribution wired onto every agent.
 */
async function createContribution(
  ctx: Context,
  settings: PersonalitySettings,
  runtime: CapabilityRuntime,
): Promise<CapabilityContribution> {
  // Owned by this registration: a WeakMap lets a disposed agent's text be
  // collected without a per-agent disposal hook, which the contribution lacks.
  const promptTexts = new WeakMap<Agent, string>()
  // Live agents are refreshed after a watched file change; each agent's own
  // effect removes it again when that agent's context is disposed.
  const liveAgents = new Set<Agent>()
  const autoLearnUsage = new Map<string, AutoLearnUsage>()
  const overlayControllers = new Set<AbortController>()
  const preloaded = await readPreloadedEntries(ctx, settings, runtime.signal)
  let fallbackText = renderPersonalityPrompt(preloaded)
  const watchController = new AbortController()
  let stopWatch: (() => Promise<void>) | undefined
  let disposed = false
  let refreshQueue = Promise.resolve()

  const refresh = async (agent: Agent | undefined): Promise<void> => {
    if (agent === undefined) return
    try {
      const read = await readPersonality(ctx, agent.session, settings, runtime.signal)
      promptTexts.set(agent, renderPersonalityPrompt(read.entries))
    } catch (error: unknown) {
      if (runtime.signal.aborted || disposed) return
      ctx.logger.warn(
        'personality: keeping the previous prompt text for session %s: %s',
        agent.id,
        errorMessage(error),
      )
    }
  }

  const reload = async (): Promise<void> => {
    let entries: readonly PersonalityEntry[]
    try {
      const read = await readGlobalPersonality(ctx, settings, watchController.signal)
      entries = read.document?.entries ?? []
    } catch (error: unknown) {
      if (watchController.signal.aborted || disposed) return
      ctx.logger.warn(
        'personality: keeping the cached profile after a failed refresh: %s',
        errorMessage(error),
      )
      return
    }
    fallbackText = renderPersonalityPrompt(entries)
    await Promise.all([...liveAgents].map(async agent => refresh(agent)))
  }

  const scheduleReload = (): void => {
    if (disposed) return
    refreshQueue = refreshQueue
      .then(async () => { if (!disposed) await reload() })
      .catch((error: unknown) => {
        ctx.logger.warn('personality: profile refresh failed: %s', errorMessage(error))
      })
  }

  const startWatch = async (): Promise<void> => {
    try {
      const target = await ctx.fs.resolve(settings.globalPath, { signal: watchController.signal })
      const close = await ctx.fs.watch(target, (error) => {
        if (error !== undefined) {
          if (!disposed) {
            ctx.logger.warn(
              'personality: filesystem watch failed for %s: %s',
              settings.globalPath,
              error.message,
            )
          }
          return
        }
        scheduleReload()
      }, watchController.signal)
      if (disposed) {
        await close()
        return
      }
      stopWatch = close
    } catch (error: unknown) {
      if (watchController.signal.aborted || disposed) return
      ctx.logger.debug(
        'personality: filesystem watch is unavailable for %s; the profile is re-read when an agent is created: %s',
        settings.globalPath,
        errorMessage(error),
      )
    }
  }
  // Watch setup must not delay or fail activation; a watcher that finishes
  // initializing after disposal is closed by the branch above.
  if (!runtime.signal.aborted) void startWatch()

  /**
   * Watch one agent's workspace overlay and refresh that agent's cached text.
   *
   * The overlay file may not exist yet, so the watcher prefers the file, then
   * its directory, then the store root; a store that cannot be watched keeps the
   * creation-time read (the overlay is still re-read for a new agent). One
   * invalidation serializes behind the same per-agent refresh the global watcher
   * uses, so many overlay writes cheaply coalesce into the latest text.
   */
  const startOverlayWatch = async (agent: Agent): Promise<void> => {
    const controller = new AbortController()
    overlayControllers.add(controller)
    let close: (() => Promise<void>) | undefined
    agent.ctx.effect(() => async () => {
      controller.abort()
      overlayControllers.delete(controller)
      if (close !== undefined) {
        await close().catch((error: unknown) => {
          ctx.logger.warn('personality: could not close the overlay watcher: %s', errorMessage(error))
        })
      }
    }, 'personality: close the overlay watcher')
    try {
      const root = await ctx.dshStore.rootFor(agent.session, controller.signal)
      for (const candidate of [settings.workspaceStorePath, 'memory', '.']) {
        let target
        try {
          target = await ctx.fs.resolve(join(root, candidate), { signal: controller.signal })
        } catch {
          continue
        }
        if (await ctx.fs.stat(target, controller.signal) === undefined) continue
        close = await ctx.fs.watch(target, (error) => {
          if (error !== undefined) {
            if (!disposed && !controller.signal.aborted) {
              ctx.logger.warn('personality: overlay watch failed for session %s: %s', agent.id, error.message)
            }
            return
          }
          void refresh(agent)
        }, controller.signal)
        return
      }
    } catch (error: unknown) {
      if (!disposed && !controller.signal.aborted && !runtime.signal.aborted) {
        ctx.logger.debug(
          'personality: overlay watch is unavailable for session %s; the overlay is re-read when an agent is created: %s',
          agent.id,
          errorMessage(error),
        )
      }
    }
  }

  return {
    scope: 'all',
    promptSections: agent => [personalityPromptSection(() => promptTexts.get(agent) ?? fallbackText)],
    tools: () => personalityTools(ctx, settings, {
      autoLearnUsage,
      refresh,
    }),
    onAgentCreated: (agent) => {
      liveAgents.add(agent)
      agent.ctx.effect(() => () => { liveAgents.delete(agent) }, 'personality: forget a disposed agent')
      void refresh(agent)
      if (!runtime.signal.aborted) void startOverlayWatch(agent)
    },
    onTurnEnd: async (input) => {
      if (runtime.signal.aborted || input.signal.aborted) return
      const agents = ctx.get('agents')
      if (agents !== undefined && !agents.roots().includes(input.agent)) return
      const correction = detectCorrection(input.session, input.turn, input.event.seq)
      if (correction === undefined) return
      await learnCorrection(ctx, settings, autoLearnUsage, input.session, input.agent, correction, input.signal, refresh)
    },
    dispose: () => {
      disposed = true
      watchController.abort()
      for (const controller of overlayControllers) controller.abort()
      overlayControllers.clear()
      autoLearnUsage.clear()
      liveAgents.clear()
      const close = stopWatch
      stopWatch = undefined
      if (close !== undefined) {
        void close().catch((error: unknown) => {
          ctx.logger.warn('personality: could not close the profile watcher: %s', errorMessage(error))
        })
      }
    },
  }
}

/**
 * Read the global profile once for the fallback prompt text.
 *
 * A corrupt or unreadable profile is contained to a logged warning: the
 * capability stays active with an empty section until a later agent read
 * succeeds.
 * @param ctx - plugin context carrying `fs`.
 * @param settings - resolved provider settings.
 * @param signal - cancellation for this registration.
 * @returns the global entries, or an empty list when the file is absent or invalid.
 */
async function readPreloadedEntries(
  ctx: Context,
  settings: PersonalitySettings,
  signal: AbortSignal,
): Promise<readonly PersonalityEntry[]> {
  try {
    return (await readGlobalPersonality(ctx, settings, signal)).document?.entries ?? []
  } catch (error: unknown) {
    if (signal.aborted) return []
    if (error instanceof PersonalityDocumentError) {
      ctx.logger.warn('personality: ignoring the global PERSONALITY.md: %s', error.message)
      return []
    }
    ctx.logger.warn(
      'personality: could not read the global PERSONALITY.md: %s',
      errorMessage(error),
    )
    return []
  }
}

/** One explicit user correction detected on a completed turn. */
interface CorrectionSignal {
  /** Kind the correction maps onto. */
  readonly kind: PersonalityEntryKind
  /** The user's sentence, trimmed. */
  readonly text: string
  /** Event seq of the correcting message, for diagnostics. */
  readonly seq: number
}

/**
 * Explicit-correction rules applied to one user message.
 *
 * Order matters: a durable style sentence ("from now on answer in Chinese") also
 * matches the broader durable-preference rule, so the style rule runs first. The
 * patterns are deliberately narrow — an ordinary instruction is not a correction
 * and must not become a personality entry.
 */
const CORRECTION_RULES: readonly { readonly kind: PersonalityEntryKind; readonly pattern: RegExp }[] = [
  {
    kind: 'understanding',
    pattern: /^(?:其实[，,\s]?|不是这个意思|不是这样|我说的是|我的意思是|我指的是|i meant\b|not what i meant|actually[,\s])/iu,
  },
  {
    kind: 'style',
    pattern: new RegExp(
      '^(?:以后|下次|from now on\\b|going forward\\b).*'
      + '(?:回复|回答|说话|写|语气|格式|风格|语言|中文|英文|reply|respond|write|format|tone|style|language|english|chinese)',
      'iu',
    ),
  },
  {
    kind: 'preference',
    pattern: /^(?:以后|下次|from now on\b|going forward\b)/iu,
  },
]

/**
 * Find the last explicit correction in one completed turn.
 *
 * The turn's user messages are read from the live log once per completed turn
 * (the organizer already filtered the turn); the last match wins so a later
 * correction supersedes an earlier one.
 * @param session - session whose log is read.
 * @param turn - the completed turn number.
 * @param endSeq - the `turn/end` event seq, the inclusive upper bound.
 * @returns the correction and its evidence seq, or undefined when the turn has none.
 */
function detectCorrection(session: Session, turn: number, endSeq: number): CorrectionSignal | undefined {
  // oxlint-disable-next-line typescript/no-deprecated -- reads the just-finished turn from the live log
  const events = session.snapshotEvents()
  let startSeq: number | undefined
  for (const event of events) {
    if (event.type === 'turn/start' && event.data.turn === turn) startSeq = event.seq
  }
  if (startSeq === undefined) return undefined
  let found: CorrectionSignal | undefined
  for (const event of events) {
    if (event.seq <= startSeq || event.seq > endSeq) continue
    if (event.type !== 'user/message' || event.data.source.kind !== 'user') continue
    const text = event.data.content
      .flatMap(block => block.type === 'text' ? [block.text] : [])
      .join('\n')
      .trim()
    if (text.length < 4 || text.length > 400) continue
    const rule = CORRECTION_RULES.find(candidate => candidate.pattern.test(text))
    if (rule !== undefined) found = { kind: rule.kind, text, seq: event.seq }
  }
  return found
}

/**
 * Store one turn-end correction under the same per-session budget the tool uses.
 *
 * A refusal is a debug log, not a failure: the turn is already complete and the
 * budget exists precisely so automatic writes cannot flood the profile.
 * @param ctx - plugin context for the write and the logs.
 * @param settings - resolved provider settings.
 * @param usageMap - per-session auto-learning usage shared with the tool.
 * @param session - session the correction came from.
 * @param agent - agent whose cached prompt is refreshed after the write.
 * @param correction - the detected correction.
 * @param signal - cancellation for the write.
 * @param refresh - prompt-cache refresh for the agent.
 */
async function learnCorrection(
  ctx: Context,
  settings: PersonalitySettings,
  usageMap: Map<string, AutoLearnUsage>,
  session: Session,
  agent: Agent,
  correction: CorrectionSignal,
  signal: AbortSignal,
  refresh: (agent: Agent | undefined) => Promise<void>,
): Promise<void> {
  const bytes = Buffer.byteLength(correction.text, 'utf8')
  const usage = usageFor(usageMap, session.id)
  const refusal = checkAutoLearnBudget(settings.autoLearn, usage, bytes)
  if (refusal !== undefined) {
    ctx.logger.debug('personality: automatic learning skipped for session %s: %s', session.id, refusal)
    return
  }
  try {
    // A turn-end write can be the first store write of the session, so the root may not exist.
    await ctx.dshStore.prepare(session, signal)
    await writePersonalityEntry(ctx, session, {
      kind: correction.kind,
      name: autoEntryName(correction.kind, correction.text),
      text: correction.text,
    }, { settings, source: 'auto' }, signal)
    usage.entries += 1
    usage.bytes += bytes
    await refresh(agent)
  } catch (error: unknown) {
    if (signal.aborted) return
    ctx.logger.warn('personality: automatic learning failed for session %s: %s', session.id, errorMessage(error))
  }
}

/** Flatten any thrown value into a one-line message for logs. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
