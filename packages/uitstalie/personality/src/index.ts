/**
 * personality: the personality capability provider. It registers one capability
 * with the dafeiyu organizer, which wires a stable system-prompt section and the
 * `personality_learn` tool onto every agent and forwards completed turns back
 * here.
 *
 * The provider owns PERSONALITY.md: the global profile under the harness home,
 * the optional workspace overlay, the prompt text, and the learning tool. It
 * never subscribes to session events or registers tools itself: the organizer
 * decides which agents receive the contribution and filters the turns the
 * provider sees. The prompt text is cached per agent because
 * `systemPrompt.section` evaluates its text synchronously; the global file is
 * preloaded when the capability activates, and each agent's merged view is read
 * again when that agent is created.
 * @module @deepseek-ai/dsh-personality
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CapabilityContribution, CapabilityRuntime } from '@deepseek-ai/dsh-dafeiyu'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-tool-dsh-store'
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

/** Contract version the provider implements. */
export const PERSONALITY_CONTRACT_VERSION = 1

export { Config } from './config.ts'
export { DEFAULT_AUTO_LEARN_BUDGET, resolveConfig } from './config.ts'
export type { AutoLearnBudget, AutoLearnConfig, PersonalitySettings } from './config.ts'
export {
  appendHistory,
  createPersonalityDocument,
  DEFAULT_PERSONALITY_MAX_BYTES,
  mergePersonalityEntries,
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
  personalityKindDefinition,
  readGlobalPersonality,
  readPersonality,
  renderPersonalityBlock,
  renderPersonalityDocument,
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
  PersonalityHistoryRecord,
  PersonalityHistorySource,
  PersonalityKindDefinition,
  PersonalityRead,
  PersonalityWriteOptions,
  PersonalityWriteResult,
} from './personality-file.ts'
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
 * per-agent prompt cache the synchronous section reads.
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
    config: settings,
    create: runtime => createContribution(ctx, settings, runtime),
  })
  ctx.effect(() => registration, 'personality.register()')
}

/**
 * Build the capability contribution and preload the global profile.
 *
 * The preload is what makes a profile visible to the first assembly: the
 * organizer waits for `create()` before wiring agents. The per-agent read then
 * merges the workspace overlay and picks up external file changes; it starts
 * when the organizer wires the agent.
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
  const autoLearnUsage = new Map<string, AutoLearnUsage>()
  const preloaded = await readPreloadedEntries(ctx, settings, runtime.signal)
  const fallbackText = renderPersonalityPrompt(preloaded)
  const refresh = async (agent: Agent | undefined): Promise<void> => {
    if (agent === undefined) return
    try {
      const read = await readPersonality(ctx, agent.session, settings, runtime.signal)
      promptTexts.set(agent, renderPersonalityPrompt(read.entries))
    } catch (error: unknown) {
      if (runtime.signal.aborted) return
      ctx.logger.warn(
        'personality: keeping the previous prompt text for session %s: %s',
        agent.id,
        error instanceof Error ? error.message : String(error),
      )
    }
  }
  return {
    scope: 'all',
    promptSections: agent => [personalityPromptSection(() => promptTexts.get(agent) ?? fallbackText)],
    tools: () => personalityTools(ctx, settings, {
      autoLearnUsage,
      refresh,
    }),
    onAgentCreated: (agent) => { void refresh(agent) },
    onTurnEnd: () => {
      // The skeleton has no drift review or automatic-learning trigger yet; a
      // completed turn is dispatched and intentionally ignored.
    },
    dispose: () => {
      autoLearnUsage.clear()
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
      error instanceof Error ? error.message : String(error),
    )
    return []
  }
}
