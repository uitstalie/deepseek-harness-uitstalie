/**
 * memory: the memory capability provider. It registers one capability with the
 * dafeiyu organizer, which wires the fixed prompt section and the memory tools
 * onto root agents and forwards completed turns back here.
 *
 * The provider owns the window policy, the MEMORY.md file, the prompt text, and
 * the tools. It never subscribes to session events or registers tools itself:
 * the organizer decides which agents receive the contribution and filters the
 * turns the provider sees.
 * @module @deepseek-ai/dsh-memory
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CapabilityContribution, TurnEndInput } from '@deepseek-ai/dsh-dafeiyu'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-tool-dsh-store'
import { resolveConfig } from './config.ts'
import type { Config } from './config.ts'
import { MEMORY_PROMPT_SECTION } from './prompt.ts'
import { memoryTools } from './tools.ts'

export const name = 'memory'
/** The organizer, the store, filesystem access, and session history the capability reports on. */
export const inject = ['dafeiyu', 'dshStore', 'fs', 'sessionQuery']

/** Stable capability id this provider registers with the organizer. */
export const MEMORY_CAPABILITY_ID = 'memory'

/** Contract version the provider implements. */
export const MEMORY_CONTRACT_VERSION = 1

export { Config } from './config.ts'
export { resolveConfig } from './config.ts'
export type { MemorySettings } from './config.ts'
export {
  appendMemoryEntry,
  assertMemoryEntryKind,
  createMemoryDocument,
  DEFAULT_MEMORY_MAX_BYTES,
  DEFAULT_MEMORY_WINDOW,
  MEMORY_BLOCK_BEGIN,
  MEMORY_BLOCK_END,
  MEMORY_DOCUMENT_VERSION,
  MEMORY_ENTRY_KINDS,
  MEMORY_KIND_REGISTRY,
  MEMORY_STORE_PATH,
  MemoryDocumentError,
  memoryKindDefinition,
  parseMemoryDocument,
  readMemoryDocument,
  renderMemoryDocument,
} from './memory-file.ts'
export type {
  MemoryAppendOptions,
  MemoryAppendResult,
  MemoryDocument,
  MemoryDocumentErrorCode,
  MemoryDocumentRead,
  MemoryEntry,
  MemoryEntryInput,
  MemoryEntryKind,
  MemoryFrame,
  MemoryKindDefinition,
  MemorySection,
  MemorySessionRecord,
  MemoryTier,
  MemoryTurnRecord,
  MemoryWindow,
} from './memory-file.ts'
export { MEMORY_PROMPT_ORDER, MEMORY_PROMPT_SECTION, MEMORY_PROMPT_SECTION_NAME, MEMORY_PROMPT_TEXT } from './prompt.ts'
export { memoryTools } from './tools.ts'
export type { MemoryReadValue, MemorySearchItem, MemorySearchValue, TurnFacts } from './tools.ts'

/**
 * Register the memory capability with the organizer.
 *
 * Configuration is resolved once per plugin load; a bad window fails the load
 * rather than silently degrading. The organizer owns per-agent wiring and turn
 * filtering, so the contribution only declares what it provides. Tool closures
 * capture this plugin's context, whose `inject` declaration admits the services
 * the tools read; the organizer's runtime context does not declare them.
 * @param ctx - plugin context carrying the organizer and services.
 * @param config - raw provider configuration from the Loader row.
 * @throws Error when the window thresholds or summary model pair are invalid,
 *   or when the capability id is already registered.
 */
export function apply(ctx: Context, config: Config): void {
  const settings = resolveConfig(config)
  const registration = ctx.dafeiyu.register({
    id: MEMORY_CAPABILITY_ID,
    contractVersion: MEMORY_CONTRACT_VERSION,
    config: settings,
    create: (): CapabilityContribution => ({
      scope: 'root',
      promptSections: () => [MEMORY_PROMPT_SECTION],
      tools: () => memoryTools(ctx, settings),
      onTurnEnd: (input) => { validateTurnEnd(input) },
    }),
  })
  ctx.effect(() => registration, 'memory.register()')
}

/**
 * Validate one completed turn before the summary job exists.
 *
 * The organizer already filters turn outcomes and resolves the live agent; this
 * checks the one value read from the durable event, so a malformed turn number
 * fails loudly instead of being recorded into MEMORY.md later.
 * @param input - the completed turn dispatched by the organizer.
 * @throws Error when the turn number is not a non-negative safe integer.
 */
function validateTurnEnd(input: TurnEndInput): void {
  if (!Number.isSafeInteger(input.turn) || input.turn < 0) {
    throw new Error(`memory: turn/end carried an invalid turn number: ${String(input.turn)}`)
  }
}
