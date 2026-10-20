/**
 * Plus loader: appends the always-on context sources to the native
 * workspace-instruction baseline, in one `agent-instructions` message.
 *
 * This is a seam, not a general injection layer: the sources today are workspace
 * rules, and memory or personality can register later through
 * `ctx.agentContextSources`. Skills keep their own injection through the skill
 * seam. The native loader stays mounted on its own row; this plugin only
 * decorates the baseline it produced.
 * @module @deepseek-ai/dsh-agent-instructions-plus
 */

import { createHash } from 'node:crypto'
import type {} from '@deepseek-ai/dsh-working-directory'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import {
  baselineInstructionState,
  findProjectRoot,
  resolveConfig,
  workspaceBaselineIdentity,
} from '@deepseek-ai/dsh-agent-instructions'
import type { ResolvedConfig } from '@deepseek-ai/dsh-agent-instructions'
import { Config, resolveRulesConfig } from './config.ts'
import type { ResolvedRulesConfig } from './config.ts'
import { createRulesSource } from './rules-source.ts'
import { createAgentContextSources } from './sources.ts'

/** Baseline identity fields the shipped presets configure for the native loader. */
const NATIVE_BASELINE_MAX_BYTES = 65536

export const name = 'agent-instructions-plus'
/**
 * Same projection and directory dependencies as the native loader: the turn
 * boundary drives touches, and both chains scan the Session's current
 * directory rather than its creation directory.
 */
export const inject = ['sessionProjections', 'workingDirectory']

export { Config }
export { resolveRulesConfig, DEFAULT_RULES_MAX_BYTES, DEFAULT_RULES_MAX_SOURCE_BYTES } from './config.ts'
export type { ResolvedRulesConfig, RulesConfig } from './config.ts'
export { RULES_DIRECTORY, rulesScanChanged, scanWorkspaceRules } from './rules.ts'
export type { RulesScan, RulesScanOptions } from './rules.ts'
export { createAgentContextSources } from './sources.ts'
export type { AgentContextContribution, AgentContextInput, AgentContextSource, AgentContextSources } from './sources.ts'
export { createRulesSource } from './rules-source.ts'

/** Per-session bookkeeping for the rendered source segment. */
interface SourceAttachment {
  /** Digest of the retained source set at the last baseline this plugin touched. */
  digest: string
}

/** A message the native loader produced as its durable workspace-instruction baseline. */
function isBaselineMessage(message: UserMessage): boolean {
  return message.source.kind === 'agent-instructions' && message.source.baseline === true
}

/**
 * Register the plus loader and its source seam.
 * @param ctx - plugin context carrying the working directory and filesystem.
 * @param config - the always-on sources this seam contributes.
 */
export function apply(ctx: Context, config: Config): void {
  const rules: ResolvedRulesConfig = resolveRulesConfig(config.rules)
  const native: ResolvedConfig = resolveConfig({ maxBytes: NATIVE_BASELINE_MAX_BYTES })
  const sources = createAgentContextSources()
  ctx.provide('agentContextSources', sources)
  sources.register(createRulesSource(rules))
  const attachments = new WeakMap<Session, SourceAttachment>()

  /**
   * Render every registered source for one agent step.
   * @param agent - the agent being prepared.
   * @param fileSystem - provider used by the sources.
   * @param signal - cancellation for the step.
   * @returns the joined segment and its set digest, or undefined when no source applies.
   */
  const renderSources = async (
    agent: Agent,
    fileSystem: FileSystem,
    signal: AbortSignal,
  ): Promise<{ text: string; digest: string } | undefined> => {
    const registered = sources.list()
    if (registered.length === 0) return undefined
    const cwd = await ctx.workingDirectory.ensure(agent, signal)
    const projectRoot = await findProjectRoot(cwd, native.projectRootMarkers, fileSystem, signal)
    const retained: { name: string; text: string; digest: string }[] = []
    for (const source of registered) {
      const contribution = await source.render({ agent, fileSystem, projectRoot, signal })
      if (contribution === undefined) continue
      retained.push({ name: source.name, ...contribution })
    }
    if (retained.length === 0) return undefined
    const hash = createHash('sha1')
    for (const contribution of retained) {
      hash.update(contribution.name)
      hash.update('\0')
      hash.update(contribution.digest)
      hash.update('\n')
    }
    return {
      text: retained.filter(contribution => contribution.text.length > 0).map(contribution => contribution.text).join('\n\n'),
      digest: hash.digest('hex'),
    }
  }

  /** Append the source segment to a baseline message, keeping its durable source facts. */
  const appendSegment = (message: UserMessage, text: string): UserMessage => createUserMessage({
    content: [...message.content, { type: 'text', text }],
    source: message.source,
  })

  /**
   * Emit a replacement baseline carrying the source segment.
   * Used only when the sources changed while the native loader had nothing to say.
   */
  const replacementBaseline = async (
    agent: Agent,
    fileSystem: FileSystem,
    signal: AbortSignal,
    text: string,
  ): Promise<UserMessage | undefined> => {
    if (text.length === 0) return undefined
    const cwd = await ctx.workingDirectory.ensure(agent, signal)
    const projectRoot = await findProjectRoot(cwd, native.projectRootMarkers, fileSystem, signal)
    return createUserMessage({
      content: [{ type: 'text', text }],
      source: {
        kind: 'agent-instructions',
        form: 'instructions',
        baseline: true,
        baselineIdentity: workspaceBaselineIdentity(native, cwd, projectRoot),
        changes: [...baselineInstructionState([]).changes.values()],
      },
    })
  }

  // The native loader registers its own listener on its preset row; this
  // listener wraps whichever decision comes out of the chain and only adds the
  // source segment, so the AGENTS portion stays byte-identical to native.
  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const fileSystem = ctx.get('fs')
    if (fileSystem === undefined) return decision
    const segment = await renderSources(agent, fileSystem, signal)
    if (segment === undefined) return decision
    const attachment = attachments.get(agent.session)

    const baselineIndex = decision.messages.findLastIndex(isBaselineMessage)
    if (baselineIndex >= 0) {
      if (segment.text.length === 0) return decision
      const target = decision.messages[baselineIndex]
      if (target === undefined) return decision
      attachments.set(agent.session, { digest: segment.digest })
      return { ...decision, messages: decision.messages.toSpliced(baselineIndex, 1, appendSegment(target, segment.text)) }
    }

    const pendingIndex = agent.inbox.nextStep.findLastIndex(isBaselineMessage)
    if (pendingIndex >= 0) {
      if (segment.text.length === 0) return decision
      const target = agent.inbox.nextStep[pendingIndex]
      if (target === undefined) return decision
      attachments.set(agent.session, { digest: segment.digest })
      agent.inbox.replace(target.id, appendSegment(target, segment.text))
      return decision
    }

    if (attachment !== undefined && attachment.digest === segment.digest) return decision
    const replacement = await replacementBaseline(agent, fileSystem, signal, segment.text)
    if (replacement === undefined) return decision
    attachments.set(agent.session, { digest: segment.digest })
    if (decision.messages.length === 0) {
      agent.inbox.prepend('next-step', replacement)
      return decision
    }
    const lastClaimedIndex = decision.messages.findLastIndex(message => messages.includes(message))
    return {
      ...decision,
      messages: decision.messages.toSpliced(lastClaimedIndex + 1, 0, replacement),
    }
  })
}
