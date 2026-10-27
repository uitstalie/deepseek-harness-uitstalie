/**
 * The `personality_learn` model tool.
 *
 * The tool records one low-risk personality entry with `source: 'auto'` after
 * the model saw an explicit user correction. It validates the kind, requires
 * evidence that names a positive session event seq, enforces the in-memory
 * per-session auto-learning budget, and refuses identity entries with the
 * manual-edit guidance. Refusals are canonical values, not thrown errors, so
 * the model can read the reason and act on it.
 * @module @deepseek-ai/dsh-personality/tools
 */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { AutoLearnBudget, PersonalitySettings } from './config.ts'
import {
  PERSONALITY_ENTRY_KINDS,
  PERSONALITY_KIND_REGISTRY,
  PersonalityDocumentError,
  personalityKindDefinition,
  writePersonalityEntry,
} from './personality-file.ts'

/** In-memory automatic writes charged to one session. */
export interface AutoLearnUsage {
  /** Entries charged so far. */
  entries: number
  /** Entry-text bytes charged so far. */
  bytes: number
}

/** State the tool shares with the capability registration. */
export interface PersonalityToolOptions {
  /** Per-session usage, owned by one capability registration. */
  readonly autoLearnUsage: Map<string, AutoLearnUsage>
  /** Refresh the calling agent's cached prompt text after a successful write. */
  readonly refresh: (agent: Agent | undefined) => Promise<void>
}

/** Canonical output value of `personality_learn`. */
export interface PersonalityLearnValue {
  /** Whether the entry was stored or refused. */
  readonly status: 'learned' | 'rejected'
  /** One line the model can act on. */
  readonly message: string
  /** Stored entry id, when the entry was stored. */
  readonly entry?: string
  /** Path that was written, when the entry was stored. */
  readonly path?: string
  /** Document revision the write produced, when the entry was stored. */
  readonly revision?: number
}

/** Refusal that asks the model to route identity changes through the user. */
const IDENTITY_MANUAL_MESSAGE = 'Identity entries describe who the user is and need user confirmation. Ask the user to edit PERSONALITY.md directly; `personality_learn` never writes identity.* entries.'

/** `kind` parameter description generated from the one kind registry. */
const KIND_DESCRIPTION = `Entry kind: ${
  PERSONALITY_KIND_REGISTRY.map(definition => `${definition.id} (${definition.description})`).join('; ')
}.`

/** Accepted evidence spelling: a bare seq, `seq 42`, or `#42`. */
const EVIDENCE_SEQ = /^(?:seq\s*#?\s*)?#?(\d+)$/iu

/**
 * Build the personality tool definitions for one agent.
 * @param ctx - context carrying `fs` and `dshStore`.
 * @param settings - resolved provider settings.
 * @param options - shared auto-learning usage and the prompt-cache refresh.
 * @returns the tool list, in registration order.
 */
export function personalityTools(
  ctx: Context,
  settings: PersonalitySettings,
  options: PersonalityToolOptions,
): readonly ToolDefinition[] {
  return [definePersonalityLearnTool(ctx, settings, options)]
}

/** Build `personality_learn`: record one auto-learned entry. */
function definePersonalityLearnTool(
  ctx: Context,
  settings: PersonalitySettings,
  options: PersonalityToolOptions,
): ToolDefinition {
  return defineTool({
    name: 'personality_learn',
    description:
      'Record one durable personality entry after an explicit user correction ("not what I meant", "from now on ..."). '
      + 'Use it for how this user words requests or prefers replies; identity entries need a manual edit by the user. '
      + 'Pass the session event seq that triggered the entry as evidence.',
    parameters: {
      kind: {
        type: 'string',
        required: true,
        description: KIND_DESCRIPTION,
      },
      content: {
        type: 'string',
        required: true,
        description: 'One paragraph stating the enduring habit or preference. Stored as one entry.',
      },
      evidence: {
        type: 'string',
        required: true,
        description: 'Session event seq that triggered this entry, for example "seq 42"; it must name a positive integer.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true, enum: ['learned', 'rejected'] },
          message: { type: 'string', required: true },
          entry: { type: 'string' },
          path: { type: 'string' },
          revision: { type: 'integer' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args, exec) {
      try {
        return await learn(ctx, settings, options, args, exec.agent, exec.signal)
      } catch (error: unknown) {
        if (error instanceof PersonalityDocumentError) return rejected(error.message)
        throw error
      }
    },
  })
}

/** Validate one call and store its entry when the budget allows. */
async function learn(
  ctx: Context,
  settings: PersonalitySettings,
  options: PersonalityToolOptions,
  args: { kind: string; content: string; evidence: string },
  agent: Agent | undefined,
  signal: AbortSignal,
): Promise<PersonalityLearnValue> {
  const session = requireSession(agent?.session)
  const definition = personalityKindDefinition(args.kind)
  if (definition === undefined) {
    return rejected(`Unknown personality kind ${JSON.stringify(args.kind)}; valid kinds: ${PERSONALITY_ENTRY_KINDS.join(', ')}.`)
  }
  if (definition.id === 'identity') return rejected(IDENTITY_MANUAL_MESSAGE)
  if (parseEvidenceSeq(args.evidence) === undefined) {
    return rejected('`evidence` must name a positive session event seq, for example "seq 42".')
  }
  const content = normalizeLearnedContent(args.content)
  const bytes = Buffer.byteLength(content, 'utf8')
  const usage = usageFor(options.autoLearnUsage, session.id)
  const refusal = checkAutoLearnBudget(settings.autoLearn, usage, bytes)
  if (refusal !== undefined) return rejected(refusal)
  const written = await writePersonalityEntry(ctx, session, {
    kind: definition.id,
    name: autoEntryName(definition.id, content),
    text: content,
  }, { settings, source: 'auto' }, signal)
  usage.entries += 1
  usage.bytes += bytes
  await options.refresh(agent)
  return {
    status: 'learned',
    message: `Recorded an auto-learned ${definition.id} entry ${written.entry.id} in ${written.path} (version ${String(written.revision)}).`,
    entry: written.entry.id,
    path: written.path,
    revision: written.revision,
  }
}

/** Build one canonical refusal value. */
function rejected(message: string): PersonalityLearnValue {
  return { status: 'rejected', message }
}

/** Require the owning agent session the tool writes through. */
function requireSession(session: Session | undefined): Session {
  if (session === undefined) throw new Error('personality_learn requires an owning agent session')
  return session
}

/**
 * Parse the evidence field into a positive session event seq.
 * @param evidence - model-supplied evidence string.
 * @returns the seq, or undefined when the text does not name one positive integer.
 */
function parseEvidenceSeq(evidence: string): number | undefined {
  const match = EVIDENCE_SEQ.exec(evidence.trim())
  const digits = match?.[1]
  if (digits === undefined) return undefined
  const seq = Number(digits)
  return Number.isSafeInteger(seq) && seq > 0 ? seq : undefined
}

/** Validate one entry paragraph before any write. */
function normalizeLearnedContent(content: string): string {
  const text = content.trim()
  if (text.length === 0) {
    throw new PersonalityDocumentError('personality_learn: content must not be empty', 'invalid-document')
  }
  if (/\n[ \t]*\n/u.test(text)) {
    throw new PersonalityDocumentError('personality_learn: content must be one paragraph without blank lines', 'invalid-document')
  }
  return text
}

/**
 * Derive a stable lower-kebab entry name from the learned content.
 *
 * The digest makes an identical correction update the same entry instead of
 * appending a duplicate.
 * @param kind - entry kind the content belongs to.
 * @param content - normalized entry text.
 * @returns `auto-` plus eight hexadecimal digest characters.
 */
export function autoEntryName(kind: string, content: string): string {
  const digest = createHash('sha256').update(`${kind}\u0000${content}`).digest('hex').slice(0, 8)
  return `auto-${digest}`
}

/** Read one session's usage record, creating it on first use. */
export function usageFor(usage: Map<string, AutoLearnUsage>, sessionId: string): AutoLearnUsage {
  const existing = usage.get(sessionId)
  if (existing !== undefined) return existing
  const created: AutoLearnUsage = { entries: 0, bytes: 0 }
  usage.set(sessionId, created)
  return created
}

/**
 * Check one write against the per-session auto-learning budget.
 * @param budget - resolved per-session budget.
 * @param usage - writes already charged to the session.
 * @param bytes - UTF-8 size of the candidate entry text.
 * @returns a refusal naming the remaining budget, or undefined when the write fits.
 */
export function checkAutoLearnBudget(
  budget: AutoLearnBudget,
  usage: AutoLearnUsage,
  bytes: number,
): string | undefined {
  const remainingEntries = Math.max(budget.entries - usage.entries, 0)
  const remainingBytes = Math.max(budget.bytes - usage.bytes, 0)
  if (remainingEntries > 0 && bytes <= remainingBytes) return undefined
  return `This session's personality auto-learn budget is exhausted: ${String(remainingEntries)} of ${String(budget.entries)} entries and ${String(remainingBytes)} of ${String(budget.bytes)} bytes remain, and this entry needs ${String(bytes)} bytes. Ask the user to edit PERSONALITY.md manually.`
}
