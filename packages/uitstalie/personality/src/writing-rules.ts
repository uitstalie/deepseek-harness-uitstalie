/**
 * The global writing-rules data and section text.
 *
 * The file is user-owned YAML at `$DSH_HOME/personality/WRITING_RULES.yaml`.
 * The model-facing CRUD tool is registered later; this module owns validation,
 * the 32-rule / 4 KiB bounds, the canonical preview, and the version-guarded
 * read/write pair. It is not registered on an agent here.
 * @module @deepseek-ai/dsh-personality/writing-rules
 */

import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { WRITING_RULES_FILE_NAME, WRITING_RULES_STORE_PATH } from './defaults.ts'
import { globalPersonalityPath } from './global-store.ts'

/** Prompt section name for enabled writing rules. */
export const WRITING_RULES_SECTION_NAME = 'personality:writing-rules'

/** Central section-order name for the writing-rules section. */
export const WRITING_RULES_ORDER_NAME = 'PERSONALITY_WRITING_RULES'


/** Maximum number of rules in one file. */
export const WRITING_RULES_MAX_RULES = 32

/** Maximum characters in one rule text. */
export const WRITING_RULES_MAX_TEXT_CHARS = 240

/** Maximum combined rule-text bytes in one file. */
export const WRITING_RULES_MAX_TEXT_BYTES = 4096

/** One writing rule. */
export interface WritingRule {
  /** Lower-kebab id, unique in the file. */
  readonly id: string
  /** One rule, 1–240 characters. */
  readonly text: string
  /** Whether the rule is injected. */
  readonly enabled: boolean
  /** Sort key; smaller first. */
  readonly order: number
}

/** The validated writing-rules file. */
export interface WritingRulesDocument {
  /** Schema revision; always 1. */
  readonly version: 1
  /** Rules in file order. */
  readonly rules: readonly WritingRule[]
}

/** A writing-rules read; `document` is the empty document when the file is absent. */
export interface WritingRulesRead {
  /** Absolute path shown to the user. */
  readonly path: string
  /** Validated document. */
  readonly document: WritingRulesDocument
  /** Opaque store version for a later guarded write. */
  readonly version?: string
}

/** Tool actions the model can request. */
export type WritingRuleAction = 'list' | 'add' | 'update' | 'remove' | 'enable' | 'disable' | 'preview'

/** One CRUD request. */
export interface WritingRuleInput {
  /** Action to perform. */
  readonly action: WritingRuleAction
  /** Rule id; required except for `add` and `list`. */
  readonly id?: string
  /** Rule text; required for `add` and `update`. */
  readonly text?: string
  /** Sort key; optional for `add` and `update`. */
  readonly order?: number
  /** Enabled state; optional for `add` and `update`. */
  readonly enabled?: boolean
}

/** A pure mutation result. */
export interface WritingRulesMutation {
  /** Document after the requested action. */
  readonly document: WritingRulesDocument
  /** Preview text when the action is `preview` or `list`; otherwise undefined. */
  readonly promptSection?: string
}

/** Typed writing-rules failure. */
export class WritingRulesError extends Error {
  /**
   * @param message - reason naming the offending rule or value.
   * @param code - stable failure kind.
   */
  constructor(message: string, readonly code: 'invalid-document' | 'rule-limit' | 'rule-not-found' | 'duplicate-rule' = 'invalid-document') {
    super(message)
    this.name = 'WritingRulesError'
  }
}

/** The empty document seeded on first activation. */
export const EMPTY_WRITING_RULES: WritingRulesDocument = Object.freeze({ version: 1, rules: [] })

/** Absolute path of the writing-rules file. */
export function writingRulesPath(): string {
  return join(dirname(globalPersonalityPath()), WRITING_RULES_FILE_NAME)
}

/** Parse one writing-rules YAML file. */
export function parseWritingRules(text: string): WritingRulesDocument {
  let parsed: unknown
  try {
    parsed = parseYaml(text)
  } catch (error: unknown) {
    throw new WritingRulesError(`WRITING_RULES.yaml is not valid YAML: ${String(error)}`)
  }
  const record = asRecord(parsed)
  if (record.version !== 1) throw new WritingRulesError('WRITING_RULES.yaml.version must be 1')
  if (!Array.isArray(record.rules)) throw new WritingRulesError('WRITING_RULES.yaml.rules must be a sequence')
  if (record.rules.length > WRITING_RULES_MAX_RULES) {
    throw new WritingRulesError(`WRITING_RULES.yaml holds ${String(record.rules.length)} rules, over the ${String(WRITING_RULES_MAX_RULES)}-rule limit`, 'rule-limit')
  }
  const rules: WritingRule[] = []
  const seen = new Set<string>()
  for (const [index, raw] of record.rules.entries()) {
    const entry = asRecord(raw)
    const id = entry.id
    const ruleText = entry.text
    if (typeof id !== 'string' || typeof ruleText !== 'string' || typeof entry.enabled !== 'boolean' || typeof entry.order !== 'number') {
      throw new WritingRulesError(`WRITING_RULES.yaml.rules[${String(index)}] needs string id/text, boolean enabled, and number order`)
    }
    assertRuleId(id)
    if (seen.has(id)) throw new WritingRulesError(`WRITING_RULES.yaml has duplicate rule id ${JSON.stringify(id)}`, 'duplicate-rule')
    seen.add(id)
    rules.push({
      id,
      text: normalizeRuleText(ruleText),
      enabled: entry.enabled,
      order: requireOrder(entry.order),
    })
  }
  const document: WritingRulesDocument = { version: 1, rules }
  assertRuleBudget(document)
  return document
}

/** Render one document as canonical YAML. */
export function renderWritingRules(document: WritingRulesDocument): string {
  assertRuleBudget(document)
  return stringifyYaml({
    version: 1,
    rules: [...document.rules].map(rule => ({
      id: rule.id,
      text: rule.text,
      enabled: rule.enabled,
      order: rule.order,
    })),
  }, { lineWidth: 0 })
}

/** Read the writing-rules file; absence returns the empty document. */
export async function readWritingRules(ctx: Context, signal?: AbortSignal): Promise<WritingRulesRead> {
  const read = await ctx.dshStore.readFile(undefined, WRITING_RULES_STORE_PATH, {
    scope: 'global',
    ...signal === undefined ? {} : { signal },
  })
  if (read.text === undefined) return { path: writingRulesPath(), document: EMPTY_WRITING_RULES }
  return {
    path: writingRulesPath(),
    document: parseWritingRules(read.text),
    ...read.version === undefined ? {} : { version: read.version },
  }
}

/** Write one document through the store's opaque version guard. */
export async function writeWritingRules(
  ctx: Context,
  document: WritingRulesDocument,
  expectedVersion?: string,
  signal?: AbortSignal,
): Promise<{ readonly path: string; readonly version?: string }> {
  const written = await ctx.dshStore.writeFile(undefined, WRITING_RULES_STORE_PATH, renderWritingRules(document), {
    scope: 'global',
    ...expectedVersion === undefined ? {} : { expected: expectedVersion },
    ...signal === undefined ? {} : { signal },
  })
  return {
    path: writingRulesPath(),
    ...written.version === undefined ? {} : { version: written.version },
  }
}

/** Apply one CRUD action without touching the store. */
export function mutateWritingRules(document: WritingRulesDocument, input: WritingRuleInput): WritingRulesMutation {
  switch (input.action) {
    case 'list':
      return { document, promptSection: previewWritingRules(document) }
    case 'preview':
      return { document, promptSection: previewWritingRules(document) }
    case 'add': {
      const text = requiredText(input.text)
      const id = input.id ?? autoRuleId(document, text)
      if (document.rules.some(rule => rule.id === id)) {
        throw new WritingRulesError(`writing rule ${JSON.stringify(id)} already exists`, 'duplicate-rule')
      }
      const rule: WritingRule = {
        id,
        text,
        enabled: input.enabled ?? true,
        order: input.order === undefined ? nextOrder(document) : requireOrder(input.order),
      }
      assertRuleId(rule.id)
      return { document: withRules([...document.rules, rule]) }
    }
    case 'update': {
      const id = requiredId(input.id)
      const current = document.rules.find(rule => rule.id === id)
      if (current === undefined) throw new WritingRulesError(`writing rule ${JSON.stringify(id)} does not exist`, 'rule-not-found')
      const next: WritingRule = {
        id,
        text: input.text === undefined ? current.text : requiredText(input.text),
        enabled: input.enabled ?? current.enabled,
        order: input.order === undefined ? current.order : requireOrder(input.order),
      }
      return { document: withRules(document.rules.map(rule => rule.id === id ? next : rule)) }
    }
    case 'remove': {
      const id = requiredId(input.id)
      if (!document.rules.some(rule => rule.id === id)) {
        throw new WritingRulesError(`writing rule ${JSON.stringify(id)} does not exist`, 'rule-not-found')
      }
      return { document: withRules(document.rules.filter(rule => rule.id !== id)) }
    }
    case 'enable':
      return { document: setEnabled(document, requiredId(input.id), true) }
    case 'disable':
      return { document: setEnabled(document, requiredId(input.id), false) }
  }
}

/** Render enabled rules in section order; an empty set is an empty string. */
export function previewWritingRules(document: WritingRulesDocument): string {
  const enabled = [...document.rules]
    .filter(rule => rule.enabled)
    .sort((left, right) => left.order - right.order || (left.id < right.id ? -1 : 1))
  if (enabled.length === 0) return ''
  return enabled.map(rule => `- ${rule.text.replaceAll(/\s+/gu, ' ').trim()}`).join('\n')
}

/** Build the seeded empty document text. */

/** Validate one rule text and return its trimmed form. */
function normalizeRuleText(text: string): string {
  const normalized = text.trim().replaceAll(/\s+/gu, ' ')
  if (normalized.length === 0) throw new WritingRulesError('writing rule text must not be empty')
  if (Array.from(normalized).length > WRITING_RULES_MAX_TEXT_CHARS) {
    throw new WritingRulesError(
      `writing rule text is ${String(Array.from(normalized).length)} characters, over the ${String(WRITING_RULES_MAX_TEXT_CHARS)}-character limit`,
      'rule-limit',
    )
  }
  return normalized
}

/** Require one text field, normalizing it. */
function requiredText(text: string | undefined): string {
  if (text === undefined) throw new WritingRulesError('writing rule text is required for add and update')
  return normalizeRuleText(text)
}

/** Require one id field. */
function requiredId(id: string | undefined): string {
  if (id === undefined) throw new WritingRulesError('writing rule id is required for this action')
  assertRuleId(id)
  return id
}

/** Validate one lower-kebab rule id. */
function assertRuleId(id: string): void {
  if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id)) return
  throw new WritingRulesError(`writing rule id ${JSON.stringify(id)} must be lower-kebab-case`)
}

/** Require one integer order. */
function requireOrder(order: number): number {
  if (Number.isSafeInteger(order)) return order
  throw new WritingRulesError('writing rule order must be a safe integer')
}

/** Return a new document with one rule list. */
function withRules(rules: readonly WritingRule[]): WritingRulesDocument {
  const next: WritingRulesDocument = { version: 1, rules }
  assertRuleBudget(next)
  return next
}

/** Toggle one rule, rejecting an unknown id. */
function setEnabled(document: WritingRulesDocument, id: string, enabled: boolean): WritingRulesDocument {
  if (!document.rules.some(rule => rule.id === id)) {
    throw new WritingRulesError(`writing rule ${JSON.stringify(id)} does not exist`, 'rule-not-found')
  }
  return withRules(document.rules.map(rule => rule.id === id ? { ...rule, enabled } : rule))
}

/** Next order after the current maximum, spaced by ten. */
function nextOrder(document: WritingRulesDocument): number {
  return document.rules.reduce((maximum, rule) => Math.max(maximum, rule.order), 0) + 10
}

/** Derive a stable lower-kebab id from the rule text. */
function autoRuleId(document: WritingRulesDocument, text: string): string {
  const base = text.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 32)
    || `rule-${createHash('sha256').update(text).digest('hex').slice(0, 8)}`
  let id = base
  let suffix = 2
  while (document.rules.some(rule => rule.id === id)) {
    id = `${base}-${String(suffix)}`
    suffix += 1
  }
  return id
}

/** Enforce the rule shape, count, and combined text-byte bounds. */
function assertRuleBudget(document: WritingRulesDocument): void {
  for (const rule of document.rules) {
    assertRuleId(rule.id)
    normalizeRuleText(rule.text)
    requireOrder(rule.order)
    if (typeof rule.enabled !== 'boolean') {
      throw new WritingRulesError(`writing rule ${JSON.stringify(rule.id)} enabled must be a boolean`)
    }
  }
  if (document.rules.length > WRITING_RULES_MAX_RULES) {
    throw new WritingRulesError(`writing rules hold ${String(document.rules.length)} rules, over the ${String(WRITING_RULES_MAX_RULES)}-rule limit`, 'rule-limit')
  }
  const bytes = document.rules.reduce((total, rule) => total + Buffer.byteLength(rule.text, 'utf8'), 0)
  if (bytes > WRITING_RULES_MAX_TEXT_BYTES) {
    throw new WritingRulesError(`writing rule text is ${String(bytes)} bytes, over the ${String(WRITING_RULES_MAX_TEXT_BYTES)}-byte limit`, 'rule-limit')
  }
}

/** Narrow one YAML value to a mapping. */
function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WritingRulesError('WRITING_RULES.yaml must be a mapping')
  }
  return value as Record<string, unknown>
}
