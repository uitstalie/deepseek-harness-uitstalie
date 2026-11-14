/**
 * The global output-style configuration and its prompt section text.
 *
 * The file is user-owned YAML at `$DSH_HOME/personality/OUTPUT_STYLE.yaml`.
 * Reading validates the fixed enum values; a missing file uses the seed
 * defaults. Rendering keeps the design's field order and appends the fixed
 * safety boundary and status rules. It is not registered on an agent here.
 * @module @deepseek-ai/dsh-personality/output-style
 */

import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-store-atom'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { DEFAULT_OUTPUT_STYLE, OUTPUT_STYLE_FILE_NAME, OUTPUT_STYLE_STORE_PATH } from './defaults.ts'
import { globalPersonalityPath } from './global-store.ts'

/** Prompt section name for the output-style defaults. */
export const OUTPUT_STYLE_SECTION_NAME = 'personality:output-style'

/** Central section-order name for the output-style section. */
export const OUTPUT_STYLE_ORDER_NAME = 'PERSONALITY_OUTPUT_STYLE'


/** Accepted tone values. */
export const OUTPUT_TONES = ['direct', 'dry', 'warm', 'neutral'] as const

/** Accepted length values. */
export const OUTPUT_LENGTHS = ['terse', 'normal', 'detailed'] as const

/** Accepted list-style values. */
export const OUTPUT_LIST_STYLES = ['never', 'comparisons', 'steps'] as const

/** Accepted dispatch-voice values. */
export const OUTPUT_DISPATCH_VOICES = ['terse', 'coaching', 'neutral'] as const

/** One tone value. */
export type OutputTone = typeof OUTPUT_TONES[number]

/** One length value. */
export type OutputLength = typeof OUTPUT_LENGTHS[number]

/** One list style. */
export type OutputListStyle = typeof OUTPUT_LIST_STYLES[number]

/** One dispatch voice. */
export type OutputDispatchVoice = typeof OUTPUT_DISPATCH_VOICES[number]

/** Validated output-style configuration. */
export interface OutputStyleConfig {
  /** Schema revision; always 1. */
  readonly version: 1
  /** Overall tone. */
  readonly tone: OutputTone
  /** Reply length. */
  readonly length: OutputLength
  /** Whether to lead with the conclusion. */
  readonly leadWithConclusion: boolean
  /** When lists are allowed. */
  readonly lists: OutputListStyle
  /** Voice used for super-agent dispatch reports. */
  readonly dispatchVoice: OutputDispatchVoice
}

/** A config read; `config` falls back to the seed defaults when the file is absent. */
export interface OutputStyleRead {
  /** Absolute path shown to the user. */
  readonly path: string
  /** Validated configuration. */
  readonly config: OutputStyleConfig
  /** Opaque store version for a later guarded write. */
  readonly version?: string
}

/** Typed output-style failure. */
export class OutputStyleError extends Error {
  /**
   * @param message - reason naming the invalid key or value.
   */
  constructor(message: string) {
    super(message)
    this.name = 'OutputStyleError'
  }
}

/** Absolute path of the output-style file. */
export function outputStylePath(): string {
  return join(dirname(globalPersonalityPath()), OUTPUT_STYLE_FILE_NAME)
}

/** Parse one output-style YAML file. */
export function parseOutputStyle(text: string): OutputStyleConfig {
  let parsed: unknown
  try {
    parsed = parseYaml(text)
  } catch (error: unknown) {
    throw new OutputStyleError(`OUTPUT_STYLE.yaml is not valid YAML: ${String(error)}`)
  }
  const record = asRecord(parsed)
  if (record.version !== 1) throw new OutputStyleError('OUTPUT_STYLE.yaml.version must be 1')
  const tone = enumValue(record.tone, OUTPUT_TONES, 'tone')
  const length = enumValue(record.length, OUTPUT_LENGTHS, 'length')
  const lists = enumValue(record.lists, OUTPUT_LIST_STYLES, 'lists')
  const dispatchVoice = enumValue(record.dispatchVoice, OUTPUT_DISPATCH_VOICES, 'dispatchVoice')
  if (typeof record.leadWithConclusion !== 'boolean') {
    throw new OutputStyleError('OUTPUT_STYLE.yaml.leadWithConclusion must be a boolean')
  }
  return {
    version: 1,
    tone,
    length,
    leadWithConclusion: record.leadWithConclusion,
    lists,
    dispatchVoice,
  }
}

/** Render one configuration as canonical YAML. */
export function renderOutputStyle(config: OutputStyleConfig): string {
  return stringifyYaml({
    version: config.version,
    tone: config.tone,
    length: config.length,
    leadWithConclusion: config.leadWithConclusion,
    lists: config.lists,
    dispatchVoice: config.dispatchVoice,
  }, { lineWidth: 0 })
}

/** Read the output-style file; absence returns the seed defaults. */
export async function readOutputStyle(ctx: Context, signal?: AbortSignal): Promise<OutputStyleRead> {
  const read = await ctx.dshStore.readFile(undefined, OUTPUT_STYLE_STORE_PATH, {
    scope: 'global',
    ...signal === undefined ? {} : { signal },
  })
  if (read.text === undefined) return { path: outputStylePath(), config: DEFAULT_OUTPUT_STYLE }
  return {
    path: outputStylePath(),
    config: parseOutputStyle(read.text),
    ...read.version === undefined ? {} : { version: read.version },
  }
}

/**
 * Render the section text: fixed field order, concrete style entries, the hard
 * boundary, and the status constraints that configuration cannot disable.
 */
export function renderOutputStyleSection(
  config: OutputStyleConfig,
  options: { readonly styleEntries?: readonly { readonly text: string }[]; readonly dispatch?: boolean } = {},
): string {
  const styleEntries = options.styleEntries ?? []
  const dispatch = options.dispatch === true
  const lines = [
    'Output style defaults:',
    `- Tone: ${config.tone}.`,
    `- Length: ${config.length}.`,
    `- Lead with the conclusion: ${config.leadWithConclusion ? 'yes' : 'no'}.`,
    `- Lists: ${config.lists}.`,
    ...dispatch ? [`- Dispatch voice: ${config.dispatchVoice}.`] : [],
  ]
  if (styleEntries.length > 0) {
    lines.push('Concrete style entries take priority over these defaults:')
    for (const entry of styleEntries) lines.push(`- ${entry.text.replaceAll(/\s+/gu, ' ').trim()}`)
  }
  lines.push(
    '',
    'Hard boundary:',
    'Output style never overrides safety, approval, sandbox, tool permission, or workspace rules. When they conflict, the rule wins.',
    '',
    'Status reporting discipline:',
    '- State done / blocked / failed / unverified only from tool receipts; without a receipt, write "report delivery unconfirmed".',
    '- Do not say "I will monitor/report back later automatically"; monitor is a query, not a subscription.',
    '- Without start.stage=prompted, do not write "started/dispatched".',
    '- Mark repeated reports as duplicate; write routing as "→ reuse <title> (<id>)" or "→ new <title>, reason: …".',
    '- When a person\'s decision is needed, ask only one necessary question; do not package an ask_user_question whole-turn cancellation as "waiting".',
  )
  return lines.join('\n')
}

/** Narrow one YAML value to a mapping. */
function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new OutputStyleError('OUTPUT_STYLE.yaml must be a mapping')
  }
  return value as Record<string, unknown>
}

/** Read one required enum value. */
function enumValue<T extends string>(value: unknown, values: readonly T[], key: string): T {
  if (typeof value === 'string' && (values as readonly string[]).includes(value)) return value as T
  throw new OutputStyleError(`OUTPUT_STYLE.yaml.${key} must be one of: ${values.join(', ')}`)
}
