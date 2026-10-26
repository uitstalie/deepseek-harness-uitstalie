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
import type { Agent } from '@deepseek-ai/dsh-agent'
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
} from './personality-file.ts'
import type { PersonalityEntry } from './personality-file.ts'
import { personalityPromptSection, renderPersonalityPrompt } from './prompt.ts'
import { personalityTools } from './tools.ts'
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
    create: runtime => createContribution(ctx, settings, runtime),
  })
  ctx.effect(() => registration, 'personality.register()')
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
    },
    onTurnEnd: () => {
      // v1 has no automatic-learning trigger: the model calls the tool, and a
      // completed turn is dispatched here and intentionally ignored.
    },
    dispose: () => {
      disposed = true
      watchController.abort()
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

/** Flatten any thrown value into a one-line message for logs. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
