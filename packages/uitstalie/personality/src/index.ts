/**
 * personality: the global personality capability.
 *
 * The provider registers one dafeiyu capability. It exposes three stable
 * prompt sections (profile, output style, enabled writing rules) and three
 * model tools: read-only `personality_analyze` on every agent, plus root-only
 * `personality_apply` and `write_like_human`. The old workspace overlay,
 * turn-end learning, proposal queue, drift-review command, and file watcher
 * are not wired here.
 *
 * The profile is user-owned data under `$DSH_HOME/personality/`. Activation
 * first moves the pre-rewrite `PERSONALITY.md` to `legacy/`, then seeds the two
 * configuration files when absent. Prompt text is cached per agent; there is no
 * watcher, so a file edited outside the tools reaches a new agent, not a live
 * one. Both write tools refresh the calling agent after a write.
 * @module @deepseek-ai/dsh-personality
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { CapabilityContribution, CapabilityRuntime } from '@deepseek-ai/dsh-dafeiyu'
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt'
import { personalityAnalyzeTool, personalityApplyTool } from './agent-tools.ts'
import { writingRulesTool } from './writing-tool.ts'
import { seedGlobalPersonalityFiles } from './defaults.ts'
import {
  migrateLegacyPersonality,
  readGlobalPersonality,
} from './global-store.ts'
import type { PersonalityDocument, PersonalityEntry } from './global-store.ts'
import { DEFAULT_OUTPUT_STYLE } from './defaults.ts'
import { readOutputStyle, renderOutputStyleSection } from './output-style.ts'
import type { OutputStyleConfig } from './output-style.ts'
import {
  readWritingRules,
  previewWritingRules,
  EMPTY_WRITING_RULES,
} from './writing-rules.ts'
import type { WritingRulesDocument } from './writing-rules.ts'
import {
  PROFILE_ORDER_NAME,
  PROFILE_SECTION_NAME,
  renderPersonalitySection,
} from './profile-prompt.ts'
import { OUTPUT_STYLE_ORDER_NAME, OUTPUT_STYLE_SECTION_NAME } from './output-style.ts'
import { WRITING_RULES_ORDER_NAME, WRITING_RULES_SECTION_NAME } from './writing-rules.ts'

/** Plugin name registered with Cordis. */
export const name = 'personality'

/** The organizer, global store, filesystem, session reader, and prompt service. */
export const inject = ['dafeiyu', 'dshStore', 'fs', 'sessionQuery', 'systemPrompt']

/** Stable capability id this provider registers with the organizer. */
export const PERSONALITY_CAPABILITY_ID = 'personality'

/** Contract version the provider implements. */
export const PERSONALITY_CONTRACT_VERSION = 2

/** Display name in the organizer's capability list. */
export const PERSONALITY_CAPABILITY_LABEL = 'Personality'

/** One-sentence capability-list description. */
export const PERSONALITY_CAPABILITY_DESCRIPTION = 'User-owned profile, output style, and writing rules with explicit analysis and confirmed apply'

/** One cached rendering of the three prompt sections for one agent. */
interface PromptBundle {
  /** Section 100 text. */
  readonly profile: string
  /** Section 690 text. */
  readonly outputStyle: string
  /** Section 695 text. */
  readonly writingRules: string
}

/** Register the global personality capability. */
export function apply(ctx: Context): void {
  const registration = ctx.dafeiyu.register({
    id: PERSONALITY_CAPABILITY_ID,
    contractVersion: PERSONALITY_CONTRACT_VERSION,
    label: PERSONALITY_CAPABILITY_LABEL,
    description: PERSONALITY_CAPABILITY_DESCRIPTION,
    config: {},
    create: runtime => createContribution(ctx, runtime),
  })
  ctx.effect(() => registration, 'personality.register()')
}

/** Build the contribution; activation migrates and seeds before any agent exists. */
async function createContribution(
  ctx: Context,
  runtime: CapabilityRuntime,
): Promise<CapabilityContribution> {
  try {
    await migrateLegacyPersonality(ctx, runtime.signal)
  } catch (error: unknown) {
    ctx.logger.warn('personality: legacy migration failed; personality stays unavailable: %s', String(error))
    throw error
  }
  try {
    await seedGlobalPersonalityFiles(ctx, runtime.signal)
  } catch (error: unknown) {
    ctx.logger.warn('personality: could not seed configuration files: %s', String(error))
  }

  const fallback = await loadBundle(ctx, runtime.signal, false)
  const promptTexts = new WeakMap<Agent, PromptBundle>()

  const refresh = async (agent: Agent): Promise<void> => {
    promptTexts.set(agent, await loadBundle(ctx, runtime.signal, isRootAgent(agent)))
  }
  const analyzeTool = personalityAnalyzeTool(ctx)
  const applyTool = personalityApplyTool(ctx, refresh)
  const rulesTool = writingRulesTool(ctx, refresh)

  return {
    scope: 'all',
    promptSections: agent => sectionsFor(ctx, agent, promptTexts, fallback),
    tools: agent => isRootAgent(agent) ? [analyzeTool, applyTool, rulesTool] : [analyzeTool],
    onAgentCreated: (agent) => {
      /* v8 ignore next 3 -- loadBundle contains every file read failure; refresh has no other throw. */
      void refresh(agent).catch((error: unknown) => {
        ctx.logger.warn('personality: could not load the prompt bundle for agent %s: %s', agent.id, String(error))
      })
    },
  }
}

/** Build the three prompt sections with the agent cache and the activation fallback. */
function sectionsFor(
  ctx: Context,
  agent: Agent,
  promptTexts: WeakMap<Agent, PromptBundle>,
  fallback: PromptBundle,
): readonly PromptSection[] {
  const bundle = (): PromptBundle => promptTexts.get(agent) ?? fallback
  return [
    {
      name: PROFILE_SECTION_NAME,
      order: ctx.systemPrompt.getSectionOrder(PROFILE_ORDER_NAME),
      text: () => bundle().profile,
    },
    {
      name: OUTPUT_STYLE_SECTION_NAME,
      order: ctx.systemPrompt.getSectionOrder(OUTPUT_STYLE_ORDER_NAME),
      text: () => bundle().outputStyle,
    },
    {
      name: WRITING_RULES_SECTION_NAME,
      order: ctx.systemPrompt.getSectionOrder(WRITING_RULES_ORDER_NAME),
      text: () => bundle().writingRules,
    },
  ]
}

/** Read all three files into section text, degrading each independently. */
async function loadBundle(ctx: Context, signal: AbortSignal, dispatch: boolean): Promise<PromptBundle> {
  let personality: PersonalityDocument | undefined
  let style: OutputStyleConfig = DEFAULT_OUTPUT_STYLE
  let rules: WritingRulesDocument = EMPTY_WRITING_RULES
  try {
    personality = (await readGlobalPersonality(ctx, signal)).document
  } catch (error: unknown) {
    ctx.logger.warn('personality: ignoring the global profile: %s', String(error))
  }
  try {
    style = (await readOutputStyle(ctx, signal)).config
  } catch (error: unknown) {
    ctx.logger.warn('personality: ignoring OUTPUT_STYLE.yaml: %s', String(error))
  }
  try {
    rules = (await readWritingRules(ctx, signal)).document
  } catch (error: unknown) {
    ctx.logger.warn('personality: ignoring WRITING_RULES.yaml: %s', String(error))
  }
  const entries: readonly PersonalityEntry[] = personality?.entries ?? []
  return {
    profile: renderPersonalitySection(entries),
    outputStyle: renderOutputStyleSection(style, {
      styleEntries: entries.filter(entry => entry.kind === 'style'),
      dispatch,
    }),
    writingRules: previewWritingRules(rules),
  }
}

/** Whether this agent is a root conversation, not a delegated child. */
function isRootAgent(agent: Agent): boolean {
  const header = agent.session.header
  return header.origin !== 'subagent'
    && header.parentSession === undefined
    && (header.delegationDepth ?? 0) === 0
}
