/**
 * core/vocab — the store's vocabulary, read from `config.md` (§4.2).
 *
 * This is the "data drives behaviour" half of decision 102 ②: statuses, priorities,
 * transitions, the closed set and the resolutions all live in the store, so adding one is
 * a data edit rather than a code change. What lives *here* is the checking that the data
 * is coherent — a vocabulary that names a status in `transitions` but not in `statuses`
 * would otherwise disable the state machine silently.
 */

import { type JiraError, invalidInput } from './errors.ts'
import { type Frontmatter, type FrontmatterMap, type FrontmatterScalar, parseFrontmatter } from './frontmatter.ts'
import { type Result, err, ok } from './result.ts'

export const CONFIG_SCHEMA = 'config/v1'
export const CONFIG_DOCUMENT_TYPE = 'config'
/** New issues without an explicit priority get this one (asked and answered: S3). */
export const DEFAULT_PRIORITY = 'S3'

export type StatusDef = Readonly<{ name: string; order: number; deprecated?: boolean }>

/** The parsed `config.md` vocabulary: the closed sets, the status order and the transition edges. */
export type Vocab = Readonly<{
  issueTypes: readonly string[]
  kbTypes: readonly string[]
  priorities: readonly string[]
  statuses: readonly StatusDef[]
  /** Directed edges, `[from, to]`. */
  transitions: readonly (readonly [string, string])[]
  /** Statuses that mean "finished"; a resolution is required to enter any of them. */
  closed: readonly string[]
  resolutions: readonly string[]
}>

const asScalarList = (value: FrontmatterScalar | readonly unknown[] | undefined): readonly string[] =>
  Array.isArray(value) ? value.map(entry => String(entry)) : []

const asMapList = (value: unknown): readonly FrontmatterMap[] =>
  Array.isArray(value)
    ? (value.filter(entry => typeof entry === 'object' && entry !== null && !Array.isArray(entry)) as readonly FrontmatterMap[])
    : []

const requiredList = (frontmatter: Frontmatter, key: string): Result<readonly string[], JiraError> => {
  const value = frontmatter[key]
  const list = asScalarList(value as never)
  return list.length === 0
    ? err(invalidInput(`config.md is missing a non-empty \`${key}\``, { field: key }))
    : ok(list)
}

/** Read the vocabulary, then check it against itself. */
export const parseVocab = (text: string): Result<Vocab, JiraError> => {
  const parsed = parseFrontmatter(text)
  if (!parsed.ok) return parsed
  const frontmatter = parsed.value.frontmatter

  const schema = frontmatter.schema
  if (schema !== CONFIG_SCHEMA) {
    return err(invalidInput(`config.md \`schema\` must be "${CONFIG_SCHEMA}"`, { schema: String(schema) }))
  }
  if (frontmatter.type !== CONFIG_DOCUMENT_TYPE) {
    return err(invalidInput(`config.md \`type\` must be "${CONFIG_DOCUMENT_TYPE}"`, { type: String(frontmatter.type) }))
  }

  const issueTypes = requiredList(frontmatter, 'issue_types')
  if (!issueTypes.ok) return issueTypes
  const priorities = requiredList(frontmatter, 'priorities')
  if (!priorities.ok) return priorities
  const resolutions = requiredList(frontmatter, 'resolutions')
  if (!resolutions.ok) return resolutions
  const closed = requiredList(frontmatter, 'closed')
  if (!closed.ok) return closed
  const kbTypes = requiredList(frontmatter, 'kb_types')
  if (!kbTypes.ok) return kbTypes

  const statuses: StatusDef[] = []
  for (const [index, entry] of asMapList(frontmatter.statuses).entries()) {
    const name = entry.name
    const order = entry.order
    if (typeof name !== 'string' || name === '') {
      return err(invalidInput(`status #${index + 1} needs a \`name\``, { index }))
    }
    if (typeof order !== 'number') {
      return err(invalidInput(`status "${name}" needs a numeric \`order\``, { status: name }))
    }
    statuses.push(Object.freeze(entry.deprecated === true ? { name, order, deprecated: true } : { name, order }))
  }
  if (statuses.length === 0) return err(invalidInput('config.md must declare at least one status'))

  const transitions: (readonly [string, string])[] = []
  for (const entry of Array.isArray(frontmatter.transitions) ? frontmatter.transitions : []) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      return err(invalidInput('each transition must be a `[from, to]` pair', { entry: String(entry) }))
    }
    transitions.push(Object.freeze([String(entry[0]), String(entry[1])] as const))
  }

  const vocab: Vocab = Object.freeze({
    issueTypes: issueTypes.value,
    kbTypes: kbTypes.value,
    priorities: priorities.value,
    statuses: Object.freeze(statuses),
    transitions: Object.freeze(transitions),
    closed: closed.value,
    resolutions: resolutions.value,
  })
  return checkVocab(vocab)
}

/** The self-consistency checks: every name used must be declared somewhere. */
export const checkVocab = (vocab: Vocab): Result<Vocab, JiraError> => {
  const names = new Set(vocab.statuses.map(status => status.name))
  const problems: string[] = []

  const duplicateNames = vocab.statuses.length !== names.size
  if (duplicateNames) problems.push('two statuses share a name')
  const orders = new Set(vocab.statuses.map(status => status.order))
  if (orders.size !== vocab.statuses.length) problems.push('two statuses share an `order`')

  for (const status of vocab.closed) {
    if (!names.has(status)) problems.push(`\`closed\` names unknown status "${status}"`)
  }
  for (const [from, to] of vocab.transitions) {
    if (!names.has(from)) problems.push(`a transition starts at unknown status "${from}"`)
    if (!names.has(to)) problems.push(`a transition ends at unknown status "${to}"`)
  }
  if (vocab.closed.length === 0) problems.push('`closed` must not be empty')

  return problems.length === 0
    ? ok(vocab)
    : err(invalidInput(`config.md is inconsistent: ${problems.length} problem(s)`, { problems: Object.freeze(problems) }))
}

/* ── the queries the write path and the board use ─────────────────────────────── */

export const isClosedStatus = (vocab: Vocab, status: string): boolean => vocab.closed.includes(status)

export const statusOrder = (vocab: Vocab, status: string): number =>
  vocab.statuses.find(entry => entry.name === status)?.order ?? Number.MAX_SAFE_INTEGER

export const isKnownStatus = (vocab: Vocab, status: string): boolean =>
  vocab.statuses.some(entry => entry.name === status)

export const isLegalTransition = (vocab: Vocab, from: string, to: string): boolean =>
  vocab.transitions.some(([start, end]) => start === from && end === to)

export const legalTargets = (vocab: Vocab, from: string): readonly string[] =>
  Object.freeze(vocab.transitions.filter(([start]) => start === from).map(([, end]) => end))
