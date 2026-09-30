/**
 * Plus loader: the native workspace-instruction chain plus always-on
 * `<projectRoot>/.dsh/rules` Markdown, delivered in one `agent-instructions`
 * message so the model sees a single chain.
 *
 * The native loader is mounted below a decorator listener rather than copied:
 * the decorator wraps whatever the native loader produced, appending the rules
 * segment to its baseline message, and emits a replacement baseline of its own
 * only when the rules set changed while the native chain stayed put.
 *
 * @module @deepseek-ai/dsh-agent-instructions-plus
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import {
  Config as NativeConfigSchema,
  apply as applyNative,
  baselineInstructionState,
  findProjectRoot,
  inject as nativeInject,
  loadBaselineInstructionSet,
  name as nativeName,
  renderAgentInstructions,
  resolveConfig,
  workspaceBaselineIdentity,
} from '@deepseek-ai/dsh-agent-instructions'
import type { ResolvedConfig } from '@deepseek-ai/dsh-agent-instructions'
import { Config, resolveRulesConfig } from './config.ts'
import type { ResolvedRulesConfig } from './config.ts'
import { scanWorkspaceRules } from './rules.ts'

export const name = 'agent-instructions-plus'
/** Same projection dependency as the reused loader: the turn boundary drives touches. */
export const inject = ['sessionProjections']

export { Config }
export { resolveRulesConfig, DEFAULT_RULES_MAX_BYTES, DEFAULT_RULES_MAX_SOURCE_BYTES } from './config.ts'
export type { ResolvedRulesConfig, RulesConfig } from './config.ts'
export { RULES_DIRECTORY, rulesScanChanged, scanWorkspaceRules } from './rules.ts'
export type { RulesScan, RulesScanOptions } from './rules.ts'

/** Per-session bookkeeping for the rules segment. */
interface RulesAttachment {
  /** Digest of the retained rules set at the last baseline this plugin touched. */
  digest: string
}

/** A message the reused loader produced as its durable workspace-instruction baseline. */
function isBaselineMessage(message: UserMessage): boolean {
  return message.source.kind === 'agent-instructions' && message.source.baseline === true
}

/**
 * Register the plus loader.
 * @param ctx - plugin context; the decorator is registered before the reused loader mounts.
 * @param config - native loader configuration plus the rules section.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved: ResolvedConfig = resolveConfig(config.agentInstructions)
  const rules: ResolvedRulesConfig = resolveRulesConfig(config.rules)
  const attachments = new WeakMap<Session, RulesAttachment>()

  /** Render the rules segment for one session and return it with its set digest. */
  const rulesSegment = async (
    session: Session,
    signal: AbortSignal,
  ): Promise<{ text: string; digest: string } | undefined> => {
    if (!rules.enabled || rules.maxBytes <= 0 || !Number.isFinite(rules.maxBytes)) return undefined
    const fileSystem = ctx.get('fs')
    if (fileSystem === undefined) return undefined
    const cwd = session.header.cwd ?? process.cwd()
    const projectRoot = await findProjectRoot(cwd, resolved.projectRootMarkers, fileSystem, signal)
    const scan = await scanWorkspaceRules(fileSystem, {
      projectRoot,
      maxSourceBytes: rules.maxSourceBytes,
      signal,
    })
    if (scan.files.length === 0) return { text: '', digest: scan.digest }
    const rendered = renderAgentInstructions(scan.files, { maxBytes: rules.maxBytes })
    return { text: rendered.text, digest: scan.digest }
  }

  /** Append the rules segment to a baseline message, keeping its durable source facts. */
  const appendSegment = (message: UserMessage, text: string): UserMessage => createUserMessage({
    content: [...message.content, { type: 'text', text }],
    source: message.source,
  })

  /**
   * Emit a replacement baseline carrying the native chain and the rules segment.
   * Used only when the rules changed while the native loader had nothing to say.
   */
  const replacementBaseline = async (
    session: Session,
    fileSystem: FileSystem,
    signal: AbortSignal,
    rulesText: string,
  ): Promise<UserMessage | undefined> => {
    const cwd = session.header.cwd ?? process.cwd()
    const projectRoot = await findProjectRoot(cwd, resolved.projectRootMarkers, fileSystem, signal)
    const instructions = await loadBaselineInstructionSet({
      cwd,
      dshHome: resolved.dshHome,
      projectRootMarkers: resolved.projectRootMarkers,
      maxBytes: resolved.maxBytes,
      maxSourceBytes: resolved.maxSourceBytes,
      instructionFileCandidates: resolved.instructionFileCandidates,
      localInstructionFileCandidates: resolved.localInstructionFileCandidates,
      projectRoot,
      replacePreviousBaseline: true,
      signal,
    }, fileSystem)
    const text = [instructions?.rendered.text ?? '', rulesText].filter(part => part.length > 0).join('\n\n')
    if (text.length === 0) return undefined
    return createUserMessage({
      content: [{ type: 'text', text }],
      source: {
        kind: 'agent-instructions',
        form: 'instructions',
        baseline: true,
        baselineIdentity: workspaceBaselineIdentity(resolved, cwd, projectRoot),
        changes: [...baselineInstructionState(instructions?.included ?? []).changes.values()],
      },
    })
  }

  // Registered before the reused loader mounts, so this listener wraps it: the
  // waterfall reaches the native loader through `next()`, and the rules segment
  // joins whichever channel that loader used for its baseline — the batch it
  // returned, or the pending inbox it kept when the batch owned no step.
  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (!rules.enabled || decision.kind !== 'enter') return decision
    const fileSystem = ctx.get('fs')
    if (fileSystem === undefined) return decision
    const segment = await rulesSegment(agent.session, signal)
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
    const replacement = await replacementBaseline(agent.session, fileSystem, signal, segment.text)
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

  // Mount the reused loader beneath the decorator with the user's native section.
  void ctx.plugin({
    name: nativeName,
    inject: nativeInject,
    Config: NativeConfigSchema,
    apply: applyNative,
  }, config.agentInstructions)
}
