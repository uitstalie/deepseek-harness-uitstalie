/**
 * core/kbsearch — the text scan behind `jira_kb search` (decisions 37/54).
 *
 * The audit that produced this design rejected a vector store for the MVP: the store is text, the
 * whole library is a few hundred kilobytes, and a scan is honest about what it searched. Decision 85
 * keeps the escape hatch visible — an index is evaluated only when the scan's p95 passes 200 ms or
 * the store passes 5000 files, and `jira doctor` reports both.
 *
 * Two rules shape the answer:
 *   - every hit carries **`file:line`**, so a model can go back to the source instead of trusting a
 *     paraphrase (decision 54);
 *   - a hit is a **snippet** (≤ {@link SNIPPET_MAX}), never the body: the whole point of a search is
 *     to not paste the library into the context window (§6.2's volume constraint).
 */

import { knowledgePath, type KnowledgeEntry, type KnowledgeKey } from './kb.ts'
import { type Locale } from './render.ts'

/** Snippets are capped so ten hits cannot flood a context window (decision 54: "约 200 字"). */
export const SNIPPET_MAX = 200
export const TOP_K_DEFAULT = 10
export const TOP_K_MAX = 50

export const clampTopK = (topK: number | undefined): number => {
  if (topK === undefined || !Number.isFinite(topK) || topK <= 0) return TOP_K_DEFAULT
  return Math.min(Math.floor(topK), TOP_K_MAX)
}

export type KbHit = Readonly<{
  key: KnowledgeKey
  title: string
  domain: string
  kbType: string
  /** Store-relative path, so `file:line` can be opened (decision 54). */
  file: string
  /**
   * 1-based **file-absolute** line of the first match (frontmatter counted, decision 179); 1 when
   * only the title matched — that hit points at the file's start because the title lives in the
   * frontmatter, whose field lines are not tracked.
   */
  line: number
  snippet: string
  /** A hit in the title outranks any number of body hits (decision 54). */
  titleMatch: boolean
  matches: number
  capturedAt: string
}>

/** The result of one knowledge search: ranked hits, how many entries matched, and whether the cap hid some. */
export type KbSearch = Readonly<{
  hits: readonly KbHit[]
  /** Entries with at least one match, before `top_k`. */
  matched: number
  truncated: boolean
  topK: number
}>

const countOccurrences = (haystack: string, needle: string): number => {
  if (needle === '') return 0
  const lower = haystack.toLowerCase()
  let count = 0
  let index = lower.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = lower.indexOf(needle, index + needle.length)
  }
  return count
}

/** The window around a match, whitespace-collapsed and capped (decision 54). */
export const snippetAround = (body: string, matchIndex: number, matchLength: number): string => {
  const flat = body.replace(/\s+/gu, ' ').trim()
  if (flat === '') return ''
  if (flat.length <= SNIPPET_MAX) return flat

  const room = Math.max(20, Math.floor((SNIPPET_MAX - matchLength) / 2))
  const start = Math.max(0, matchIndex - room)
  const end = Math.min(flat.length, start + SNIPPET_MAX)
  const slice = flat.slice(start, end).trim()
  return `${start > 0 ? '…' : ''}${slice}${end < flat.length ? '…' : ''}`
}

/** The 1-based line of the first match **within the body** (decision 179 adds `bodyLine` to it). */
const firstMatchLine = (body: string, needle: string): number => {
  const index = body.toLowerCase().indexOf(needle)
  if (index === -1) return 1
  return body.slice(0, index).split('\n').length
}

const hitFor = (entry: KnowledgeEntry, needle: string): KbHit | undefined => {
  const titleMatches = countOccurrences(entry.title, needle)
  const bodyMatches = countOccurrences(entry.body, needle)
  const matches = titleMatches + bodyMatches
  if (matches === 0) return undefined

  const bodyIndex = entry.body.toLowerCase().indexOf(needle)
  return Object.freeze({
    key: entry.key,
    title: entry.title,
    domain: entry.domain,
    kbType: entry.kbType,
    file: knowledgePath(entry.domain, entry.key),
    // Decision 179: a citation must open the line it names — count the frontmatter, not just the body.
    line: bodyIndex === -1 ? 1 : entry.bodyLine + firstMatchLine(entry.body, needle) - 1,
    snippet: bodyIndex === -1
      ? snippetAround(entry.title, 0, 0)
      : snippetAround(entry.body, bodyIndex, needle.length),
    titleMatch: titleMatches > 0,
    matches,
    capturedAt: entry.source.capturedAt,
  })
}

/**
 * Rank the library for one query.
 *
 * Order (decision 54): a title hit first, then the number of hits, then the most recently captured.
 * The final tiebreak is the key, so identical scores never reorder between calls — a list that
 * shuffles itself makes an agent's second look contradict its first.
 */
export const searchKnowledge = (
  entries: readonly KnowledgeEntry[],
  query: string,
  topK?: number,
): KbSearch => {
  const limit = clampTopK(topK)
  const needle = query.trim().toLowerCase()
  if (needle === '') return Object.freeze({ hits: Object.freeze([]), matched: 0, truncated: false, topK: limit })

  const hits = entries
    .map(entry => hitFor(entry, needle))
    .filter((hit): hit is KbHit => hit !== undefined)
    .sort((left, right) =>
      Number(right.titleMatch) - Number(left.titleMatch)
      || right.matches - left.matches
      || right.capturedAt.localeCompare(left.capturedAt)
      || String(left.key).localeCompare(String(right.key)))

  const kept = hits.slice(0, limit)
  return Object.freeze({
    hits: Object.freeze(kept),
    matched: hits.length,
    truncated: hits.length > kept.length,
    topK: limit,
  })
}

/** The two sentences this renderer varies by locale; the hits themselves are data. */
type KbSearchWords = Readonly<{
  none: string
  more: (remaining: number, max: number) => string
}>

const KB_SEARCH_WORDS: Readonly<Record<Locale, KbSearchWords>> = Object.freeze({
  en: Object.freeze({
    none: 'no knowledge entries match',
    more: (remaining: number, max: number) =>
      `… ${String(remaining)} more match; raise \`top_k\` (max ${String(max)}) or narrow the query`,
  }),
  zh: Object.freeze({
    none: '没有匹配的知识条目',
    more: (remaining: number, max: number) =>
      `… 还有 ${String(remaining)} 条匹配；请调大 \`top_k\`（上限 ${String(max)}）或缩小检索词`,
  }),
})

/**
 * The one-entry view `jira kb get` prints: identity line, lineage, optional cross-references,
 * then the body. Kept next to `renderKbSearch` so both knowledge renderings live in one place
 * (DPMJ-211 — the CLI used to hand-build these lines inline).
 */
export const renderKbEntry = (entry: KnowledgeEntry): string =>
  [
    `${entry.key}  [${entry.kbType}]  ${entry.title}`,
    `${entry.domain} · captured ${entry.source.capturedAt} · ${entry.source.machineId}/${entry.source.os}/${entry.source.tool}`,
    ...(entry.issues.length === 0 ? [] : [`issues: ${entry.issues.join(', ')}`]),
    ...(entry.source.source === undefined ? [] : [`source: ${entry.source.source}`]),
    '',
    entry.body.replace(/\n$/, ''),
  ].join('\n')

/**
 * The summary a search returns: `file:line` plus the snippet, never the body.
 *
 * It is shared the same way `renderIssueHuman` is: the tool (the model) takes the English default,
 * and the CLI asks for `zh` (decision 55).
 */
export const renderKbSearch = (result: KbSearch, locale: Locale = 'en'): string => {
  const words = KB_SEARCH_WORDS[locale]
  if (result.hits.length === 0) return words.none
  const lines = result.hits.map(hit =>
    `- ${hit.key}  ${hit.title}  (${hit.file}:${String(hit.line)})\n  ${hit.snippet}`)
  if (result.truncated) {
    lines.push(words.more(result.matched - result.hits.length, TOP_K_MAX))
  }
  return lines.join('\n')
}
