/**
 * core/kb — the knowledge entity and its file codec (decision 75).
 *
 * A knowledge entry is a pure OKF Concept under `knowledge/<domain>/KB-<n>.md`: the **file name is
 * the key** (decision 107 — nothing writes `key` into the file), `type` comes from the store's
 * `kb_types` closed set, and the **source quadruple** (`machine_id` / `os` / `tool` /
 * `captured_at`) is required because the audit that produced this design found upstream lineage
 * nobody could trust (decision 75, §11.1).
 *
 * Both sides of decision 49 live here: {@link encodeKnowledge} is strict (an unknown or missing
 * key is refused, so a typo cannot silently eat a field) while {@link decodeKnowledge} is tolerant
 * (an unknown key becomes a warning, and a missing required field degrades instead of taking the
 * whole library down with it).
 */

import { type IssueKey, type Timestamp, asIdentity, asIssueKey } from './entity.ts'
import { type JiraError, invalidInput } from './errors.ts'
import { type Frontmatter, type FrontmatterValue, parseFrontmatter, renderFrontmatter } from './frontmatter.ts'
import { type Result, err, ok } from './result.ts'
import { isTagName } from './tags.ts'

export const KB_SCHEMA = 'kb/v1'
export const KB_DOCUMENT_TYPE_PREFIX = 'kb/'

/** Branded so a knowledge key cannot be passed where an issue key is expected. */
export type KnowledgeKey = string & { readonly __brand: 'KnowledgeKey' }

/**
 * Knowledge keys live in one number space, `KB-<n>` (decision 75), allocated from the counters
 * like any other key. The shape alone is not enough: `DH-1` has the same shape and is an **issue**
 * key, so the key space is what distinguishes them.
 */
export const KNOWLEDGE_KEY_SPACE = 'KB'

const KNOWLEDGE_KEY = new RegExp(`^(${KNOWLEDGE_KEY_SPACE})-(\\d+)$`, 'u')

export const asKnowledgeKey = (value: string): KnowledgeKey | undefined =>
  KNOWLEDGE_KEY.test(value.trim()) ? (value.trim() as KnowledgeKey) : undefined

/** Domain directory names follow the tag rule: lower-kebab, at most 32 characters (decision 76). */
export const isDomainName = (value: string): boolean => isTagName(value)

export type KnowledgeSource = Readonly<{
  machineId: string
  os: string
  tool: string
  capturedAt: Timestamp
  /** A path or a URL, when the entry was distilled from something outside the store. */
  source?: string
  /** Required when `source` is a file rather than a URL (decision 75). */
  sourceSha256?: string
}>

export type KnowledgeEntry = Readonly<{
  key: KnowledgeKey
  domain: string
  kbType: string
  title: string
  tags: readonly string[]
  source: KnowledgeSource
  /** The issues this entry was distilled from; the issue side mirrors it in `kb_refs`. */
  issues: readonly IssueKey[]
  body: string
  /**
   * The 1-based line the body starts on in the file (frontmatter counted). Hits cite `file:line`
   * as **file-absolute** lines (decision 179), so the offset has to live on the entity rather than
   * be guessed from the body.
   */
  bodyLine: number
}>

export type DecodedKnowledge = Readonly<{
  entry: KnowledgeEntry
  warnings: readonly string[]
  /** Unknown keys are tolerated on read and **refused on write** (decision 49), as for issues. */
  unknownKeys: readonly string[]
  /** The `schema` the file actually carries (decision 46). */
  schema: string
}>

/** The fields a KB file is allowed to carry; anything else is refused on write (decision 49). */
export const KB_FIELDS: readonly string[] = Object.freeze([
  'schema',
  'type',
  'title',
  'tags',
  'machine_id',
  'os',
  'tool',
  'captured_at',
  'source',
  'source_sha256',
  'issues',
])

export const knowledgePath = (domain: string, key: KnowledgeKey): string => `knowledge/${domain}/${key}.md`

const asText = (value: FrontmatterValue | undefined): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

const asList = (value: FrontmatterValue | undefined): readonly string[] =>
  Array.isArray(value) ? Object.freeze(value.map(entry => String(entry))) : Object.freeze([])

/**
 * Read one entry. Missing required fields are **warned about, not fatal** (decision 49's read
 * side): a library with one half-written file must still be searchable.
 */
export const decodeKnowledge = (
  text: string,
  key: string,
  /**
   * The knowledge **domain**, which is the directory the file lives in — *not* the key's prefix.
   * The key is a global `KB-<n>` number (decision 75) and the domain is a topic, so the two are
   * independent: `knowledge/windows/KB-7.md` is perfectly normal.
   */
  domain: string,
): Result<DecodedKnowledge, JiraError> => {
  const knowledgeKey = asKnowledgeKey(key)
  if (knowledgeKey === undefined) return err(invalidInput(`"${key}" is not a knowledge key (expected e.g. KB-7)`))
  if (!isDomainName(domain)) {
    return err(invalidInput(`domain "${domain}" must be lower-kebab (letters, digits, dashes; ≤32)`, { domain }))
  }

  const parsed = parseFrontmatter(text)
  if (!parsed.ok) return parsed
  const { frontmatter, body } = parsed.value
  const warnings: string[] = []
  const unknownKeys: string[] = []

  for (const field of Object.keys(frontmatter)) {
    if (!KB_FIELDS.includes(field)) {
      unknownKeys.push(field)
      warnings.push(`unknown frontmatter key "${field}"`)
    }
  }
  if (frontmatter.schema !== KB_SCHEMA) warnings.push(`schema is "${String(frontmatter.schema)}", expected "${KB_SCHEMA}"`)

  const required: readonly (readonly [string, string | undefined])[] = [
    ['title', asText(frontmatter.title)],
    ['machine_id', asText(frontmatter.machine_id)],
    ['os', asText(frontmatter.os)],
    ['tool', asText(frontmatter.tool)],
    ['captured_at', asText(frontmatter.captured_at)],
  ]
  for (const [field, value] of required) {
    if (value === undefined) warnings.push(`missing required field "${field}"`)
  }

  const kbType = asText(frontmatter.type)
  if (kbType === undefined) warnings.push('missing required field "type"')

  const issues: IssueKey[] = []
  for (const entry of asList(frontmatter.issues)) {
    const issue = asIssueKey(entry)
    if (issue === undefined) warnings.push(`"${entry}" is not an issue key`)
    else issues.push(issue)
  }

  return ok(Object.freeze({
    entry: Object.freeze({
      key: knowledgeKey,
      domain,
      kbType: kbType ?? '',
      title: asText(frontmatter.title) ?? '',
      tags: asList(frontmatter.tags),
      source: Object.freeze({
        machineId: asText(frontmatter.machine_id) ?? '',
        os: asText(frontmatter.os) ?? '',
        tool: asText(frontmatter.tool) ?? '',
        capturedAt: (asText(frontmatter.captured_at) ?? '') as Timestamp,
        ...(asText(frontmatter.source) === undefined ? {} : { source: asText(frontmatter.source) as string }),
        ...(asText(frontmatter.source_sha256) === undefined
          ? {}
          : { sourceSha256: asText(frontmatter.source_sha256) as string }),
      }),
      issues: Object.freeze(issues),
      body,
      bodyLine: parsed.value.bodyLine,
    }),
    warnings: Object.freeze(warnings),
    unknownKeys: Object.freeze(unknownKeys),
    schema: (typeof frontmatter.schema === 'string' ? frontmatter.schema : ''),
  }))
}

export type EncodeKnowledgeOptions = Readonly<{
  /** The store's `kb_types`; the closed set the design requires (decision 75). */
  kbTypes: readonly string[]
}>

/**
 * The key-independent half of knowledge validation (decision 190): domain, title, type and tags
 * need nothing but the vocabulary, so a caller that allocates keys runs this **before**
 * allocating — a refused draft must never burn a `KB-<n>`. The source quadruple is not checked
 * here: it is built by the caller from its own context, and `encodeKnowledge` re-checks
 * everything at the write boundary anyway.
 */
export const validateKnowledgeDraft = (
  input: Readonly<{ domain: string; kbType: string; title: string; tags?: readonly string[] }>,
  options: EncodeKnowledgeOptions,
): Result<true, JiraError> => {
  if (!isDomainName(input.domain)) {
    return err(invalidInput(`domain "${input.domain}" must be lower-kebab (letters, digits, dashes; ≤32)`, {
      domain: input.domain,
    }))
  }
  if (input.title.trim() === '') return err(invalidInput('title must not be empty'))
  if (input.title.includes('\n')) return err(invalidInput('title must be a single line'))
  if (!options.kbTypes.includes(input.kbType)) {
    return err(invalidInput(`type "${input.kbType}" is not one of: ${options.kbTypes.join(', ')}`, {
      type: input.kbType,
      kbTypes: Object.freeze([...options.kbTypes]),
    }))
  }
  for (const tag of input.tags ?? []) {
    if (!isTagName(tag)) return err(invalidInput(`tag "${tag}" must be lower-kebab`, { tag }))
  }
  return ok(true)
}

const looksLikeUrl = (value: string): boolean => /^[a-z][a-z0-9+.-]*:\/\//iu.test(value)

/** Write one entry: strict, and the only place the field order is decided. */
export const encodeKnowledge = (
  entry: KnowledgeEntry,
  options: EncodeKnowledgeOptions,
): Result<string, JiraError> => {
  if (asKnowledgeKey(entry.key) === undefined) return err(invalidInput(`"${entry.key}" is not a knowledge key`))
  if (!isDomainName(entry.domain)) {
    return err(invalidInput(`domain "${entry.domain}" must be lower-kebab (letters, digits, dashes; ≤32)`, {
      domain: entry.domain,
    }))
  }

  if (entry.title.trim() === '') return err(invalidInput('title must not be empty', { key: entry.key }))
  if (entry.title.includes('\n')) return err(invalidInput('title must be a single line', { key: entry.key }))
  if (!options.kbTypes.includes(entry.kbType)) {
    return err(invalidInput(`type "${entry.kbType}" is not one of: ${options.kbTypes.join(', ')}`, {
      type: entry.kbType,
      kbTypes: Object.freeze([...options.kbTypes]),
    }))
  }
  for (const tag of entry.tags) {
    if (!isTagName(tag)) return err(invalidInput(`tag "${tag}" must be lower-kebab`, { tag }))
  }

  const source = entry.source
  for (const field of ['machineId', 'os', 'tool', 'capturedAt'] as const) {
    if (source[field].trim() === '') {
      return err(invalidInput(`the source field "${field}" is required (decision 75)`, { key: entry.key, field }))
    }
  }
  if (source.source !== undefined && !looksLikeUrl(source.source) && source.sourceSha256 === undefined) {
    return err(invalidInput('source_sha256 is required when the source is a file rather than a URL', {
      key: entry.key,
      source: source.source,
    }))
  }

  const frontmatter: Frontmatter = Object.freeze({
    schema: KB_SCHEMA,
    type: entry.kbType,
    title: entry.title,
    tags: Object.freeze([...entry.tags]),
    machine_id: source.machineId,
    os: source.os,
    tool: source.tool,
    captured_at: source.capturedAt,
    ...(source.source === undefined ? {} : { source: source.source }),
    ...(source.sourceSha256 === undefined ? {} : { source_sha256: source.sourceSha256 }),
    issues: Object.freeze([...entry.issues]),
  })
  return ok(renderFrontmatter(frontmatter, entry.body))
}

/** The identity a new entry records as its source (decision 48's tuple, kept whole). */
export const sourceOf = (input: Readonly<{
  machineId: string
  os: string
  tool: string
  capturedAt: Timestamp
  source?: string
  sourceSha256?: string
}>): KnowledgeSource =>
  Object.freeze({
    machineId: input.machineId,
    os: input.os,
    tool: input.tool,
    capturedAt: input.capturedAt,
    ...(input.source === undefined ? {} : { source: input.source }),
    ...(input.sourceSha256 === undefined ? {} : { sourceSha256: input.sourceSha256 }),
  })

/**
 * The machine inside an identity tuple (decision 48), or `undefined` when there is none.
 *
 * `human:daiqc` carries no machine, and inventing one from the human's name would put a person's
 * name into a lineage field. Callers fall back to the store's own machine id instead.
 */
export const machineIdOf = (identity: string): string | undefined => {
  const parsed = asIdentity(identity)
  if (parsed === undefined) return undefined
  const parts = parsed.split('|')
  if (parts.length < 3) return undefined
  const machine = parts[2]
  return machine === undefined || machine === '' ? undefined : machine
}
