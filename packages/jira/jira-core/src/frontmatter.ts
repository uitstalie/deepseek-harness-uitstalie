/**
 * core/frontmatter — the restricted frontmatter codec (DESIGN.md decision 105).
 *
 * WHY HAND-WRITTEN: the store keeps every record in a Markdown file whose truth is the
 * text itself, and the package must install offline by copying the directory (decision
 * 65). A third-party YAML parser would drag a runtime dependency along with it, so we
 * support a documented subset instead — and we **reject anything outside it loudly**,
 * because guessing is how a text truth source silently rots (decision 49/80).
 *
 * SUPPORTED SUBSET (everything else is an error, never a guess):
 *   ---
 *   key: plain scalar            # `true`/`false`/`null`/integers become typed values
 *   key: "quoted: scalar"        # double quotes: \" \\ \n ; single quotes: '' for '
 *   key: [a, b, "c d"]           # inline array of scalars (may be empty: [])
 *   key: [{ type: a, target: b }] # inline array of ONE-level flow maps (decision 70's
 *                                 # `links`); no nesting inside a flow map
 *   key:                         # a key with an empty value, followed by 1..n items
 *     - item
 *     - item
 *   # a whole-line comment is ignored (as is a blank line)
 *   ---
 *   body (everything after the closing fence; the conventional blank line that
 *         separates the fence from the body is a separator, not part of the body)
 *
 * REJECTED ON PURPOSE: nested maps, flow maps `{...}`, block scalars `|`/`>`, anchors &
 * aliases & tags, tabs, duplicate keys, non-snake keys, other indentation, `...`.
 */

import { type JiraError, invalidInput } from './errors.ts'
import { type Result, err, ok } from './result.ts'

export type FrontmatterScalar = string | number | boolean | null
/** One level deep, scalars only — enough for decision 70's `{ type, target }` entries. */
export type FrontmatterMap = Readonly<Record<string, FrontmatterScalar>>
/**
 * One level deep, scalars only — enough for the `transitions:` entries of the store's
 * `config.md`, which look like `- [todo, closed]`.
 */
export type FrontmatterNestedArray = readonly FrontmatterScalar[]
/** What a block- or inline-array entry may be: a scalar, a flow map, or a scalar array. */
export type FrontmatterItem = FrontmatterScalar | FrontmatterMap | FrontmatterNestedArray
export type FrontmatterValue = FrontmatterScalar | readonly FrontmatterItem[]
export type Frontmatter = Readonly<Record<string, FrontmatterValue>>
export type ParsedDocument = Readonly<{
  frontmatter: Frontmatter
  body: string
  /**
   * The 1-based line the body starts on, counting the frontmatter block and the blank separator
   * (decision 179: `file:line` citations must open the right line, so the offset travels with the
   * body instead of being recomputed by every consumer).
   */
  bodyLine: number
}>

const FENCE = '---'
const KEY_PATTERN = /^[a-z][a-z0-9_]*$/
const PLAIN_INTEGER = /^-?\d+$/
const BLOCK_ITEM = /^ {2}- (.*)$/
/** A plain scalar may not start with any of these: they all mean "YAML feature we do not support". */
const FORBIDDEN_LEAD = new Set(['{', '[', ']', '}', '&', '*', '!', '|', '>', '%', '@', '`'])
const RESERVED_PLAIN = new Set(['true', 'false', 'null', '~'])

const at = (line: number, text: string, reason: string): JiraError =>
  invalidInput(`unsupported frontmatter at line ${line}: ${reason}`, { line, text, reason })

/** Cut a trailing ` # comment`, ignoring `#` inside quotes. */
const stripComment = (input: string): string => {
  let quote: '"' | "'" | undefined
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]
    if (quote === '"') {
      if (char === '\\') index += 1
      else if (char === '"') quote = undefined
    } else if (quote === "'") {
      if (char === "'") {
        if (input[index + 1] === "'") index += 1
        else quote = undefined
      }
    } else if (char === '"' || char === "'") quote = char
    else if (char === '#' && (index === 0 || input[index - 1] === ' ')) return input.slice(0, index)
  }
  // An unterminated quote is rejected by parseScalar, so reaching the end means nothing was cut.
  return input
}

const parseScalar = (raw: string, line: number, text: string): Result<FrontmatterScalar, JiraError> => {
  const value = raw.trim()
  if (value === '') return ok('')

  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length < 2) return err(at(line, text, 'unterminated double quote'))
    const inner = value.slice(1, -1)
    const out: string[] = []
    for (let index = 0; index < inner.length; index += 1) {
      const char = inner[index]
      if (char !== '\\') {
        if (char === '"') return err(at(line, text, 'unescaped double quote'))
        out.push(char ?? '')
        continue
      }
      const next = inner[index + 1]
      if (next === 'n') out.push('\n')
      else if (next === '\\') out.push('\\')
      else if (next === '"') out.push('"')
      else return err(at(line, text, `unsupported escape \\${String(next)}`))
      index += 1
    }
    return ok(out.join(''))
  }

  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) return err(at(line, text, 'unterminated single quote'))
    return ok(value.slice(1, -1).replaceAll("''", "'"))
  }

  if (value.includes('\t')) return err(at(line, text, 'tab character'))
  if (value.includes(': ')) return err(at(line, text, 'unquoted colon; quote the value'))
  if (FORBIDDEN_LEAD.has(value[0] ?? '')) return err(at(line, text, `leading "${value[0] ?? ''}" implies an unsupported YAML feature`))
  if (value.startsWith('- ')) return err(at(line, text, 'a bare list item outside a key'))

  if (value === 'true') return ok(true)
  if (value === 'false') return ok(false)
  if (value === 'null' || value === '~') return ok(null)
  if (PLAIN_INTEGER.test(value)) return ok(Number.parseInt(value, 10))
  return ok(value)
}

/** `{ key: scalar, key2: scalar }` — one level, no nesting, no trailing comma tolerance. */
const parseFlowMap = (raw: string, line: number, text: string): Result<FrontmatterMap, JiraError> => {
  const value = raw.trim()
  if (!value.startsWith('{') || !value.endsWith('}')) return err(at(line, text, 'unterminated flow map'))
  const inner = value.slice(1, -1).trim()
  if (inner === '') return ok(Object.freeze({}))
  const entries: Record<string, FrontmatterScalar> = {}
  for (const part of inner.split(',')) {
    const separator = part.indexOf(':')
    if (separator === -1) return err(at(line, text, 'a flow-map entry needs "key: value"'))
    const key = part.slice(0, separator).trim()
    if (!KEY_PATTERN.test(key)) return err(at(line, text, `flow-map key "${key}" is not lower_snake_case`))
    if (key in entries) return err(at(line, text, `duplicate flow-map key "${key}"`))
    const parsed = parseScalar(part.slice(separator + 1), line, text)
    if (!parsed.ok) return parsed
    entries[key] = parsed.value
  }
  return ok(Object.freeze(entries))
}

const parseArrayItem = (
  raw: string,
  line: number,
  text: string,
): Result<FrontmatterItem, JiraError> => {
  const value = raw.trim()
  if (value.startsWith('{')) return parseFlowMap(value, line, text)
  if (value.startsWith('[')) {
    const nested = parseInlineArray(value, line, text)
    if (!nested.ok) return nested
    if (nested.value.some(entry => itemKindOf(entry) !== 'scalar')) {
      return err(at(line, text, 'a nested array may contain only scalars'))
    }
    return ok(nested.value as readonly FrontmatterScalar[])
  }
  return parseScalar(value, line, text)
}

const itemKindOf = (item: FrontmatterItem): 'scalar' | 'map' | 'array' =>
  Array.isArray(item) ? 'array' : typeof item === 'object' && item !== null ? 'map' : 'scalar'

const parseInlineArray = (
  raw: string,
  line: number,
  text: string,
): Result<readonly FrontmatterItem[], JiraError> => {
  const value = raw.trim()
  if (!value.startsWith('[') || !value.endsWith(']')) return err(at(line, text, 'unterminated inline array'))
  const inner = value.slice(1, -1).trim()
  if (inner === '') return ok(Object.freeze([] as FrontmatterScalar[]))
  const items: FrontmatterItem[] = []
  // An array is homogeneous — all scalars, all flow maps, or all scalar arrays — so the
  // value has one shape a reader can rely on. Mixing them is outside the subset.
  let kind: 'scalar' | 'map' | 'array' | undefined
  const push = (item: FrontmatterItem): Result<void, JiraError> => {
    const itemKind = itemKindOf(item)
    if (kind !== undefined && kind !== itemKind) {
      return err(at(line, text, 'an array must be all scalars, all flow maps, or all arrays'))
    }
    kind = itemKind
    items.push(item)
    return ok(undefined)
  }
  let buffer = ''
  let quote: '"' | "'" | undefined
  let braces = 0
  let brackets = 0
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index]
    if (quote === '"') {
      buffer += char
      if (char === '\\') {
        buffer += inner[index + 1] ?? ''
        index += 1
      } else if (char === '"') quote = undefined
      continue
    }
    if (quote === "'") {
      buffer += char
      if (char === "'") {
        if (inner[index + 1] === "'") {
          buffer += "'"
          index += 1
        } else quote = undefined
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      buffer += char
      continue
    }
    // Track both depths so a comma inside a nested `[...]` or `{...}` is not a separator,
    // and so exactly one level of nesting is admitted.
    if (char === '{') braces += 1
    if (char === '}') braces -= 1
    if (char === '[') brackets += 1
    if (char === ']') brackets -= 1
    if (braces < 0 || braces > 1 || brackets < 0 || brackets > 1) {
      return err(at(line, text, 'nested collection inside an inline array (one level only)'))
    }
    if (char === ',' && braces === 0 && brackets === 0) {
      const parsed = parseArrayItem(buffer, line, text)
      if (!parsed.ok) return parsed
      const pushed = push(parsed.value)
      if (!pushed.ok) return pushed
      buffer = ''
      continue
    }
    buffer += char
  }
  if (quote !== undefined) return err(at(line, text, 'unterminated quote inside an inline array'))
  const parsed = parseArrayItem(buffer, line, text)
  if (!parsed.ok) return parsed
  const pushed = push(parsed.value)
  if (!pushed.ok) return pushed
  return ok(Object.freeze(items))
}

/** Split a document into frontmatter text lines and the body, or explain why it cannot. */
const splitDocument = (text: string): Result<readonly string[], JiraError> => {
  if (text.startsWith('\uFEFF')) return err(invalidInput('file starts with a BOM; the store keeps plain UTF-8', { reason: 'bom' }))
  const lines = text.replaceAll('\r\n', '\n').split('\n')
  if (lines[0]?.trim() !== FENCE) return err(invalidInput('file does not start with a "---" frontmatter fence', { reason: 'no-frontmatter' }))
  return ok(Object.freeze(lines))
}

export const parseFrontmatter = (text: string): Result<ParsedDocument, JiraError> => {
  const split = splitDocument(text)
  if (!split.ok) return split
  const lines = split.value

  const entries = new Map<string, FrontmatterValue>()
  let index = 1
  let closed = false

  while (index < lines.length) {
    const raw = lines[index] ?? ''
    const lineNumber = index + 1
    index += 1

    if (raw.trim() === FENCE) {
      closed = true
      break
    }
    if (raw.trim() === '') continue
    if (raw.startsWith('\t')) return err(at(lineNumber, raw, 'tab indentation'))
    if (raw.trimStart().startsWith('#')) continue

    const match = /^([^:]+):(.*)$/.exec(raw)
    if (match === null) return err(at(lineNumber, raw, 'expected a "key: value" line'))
    const rawKey = (match[1] ?? '').trim()
    const rawValue = match[2] ?? ''
    if (!KEY_PATTERN.test(rawKey)) return err(at(lineNumber, raw, `key "${rawKey}" is not lower_snake_case`))

    const stripped = stripComment(rawValue)

    if (stripped.trim() === '') {
      // `key:` with nothing after it: either an empty value or the head of a block array.
      const items: FrontmatterItem[] = []
      let blockKind: 'scalar' | 'map' | 'array' | undefined
      while (index < lines.length) {
        const candidate = lines[index] ?? ''
        if (candidate.trim() === '') { index += 1; continue }
        if (candidate.trim() === FENCE || !candidate.startsWith(' ')) break
        const item = BLOCK_ITEM.exec(candidate)
        if (item === null) return err(at(index + 1, candidate, 'unsupported indentation in a block array (use exactly two spaces and "- ")'))
        // A block-array entry may carry a trailing comment of its own (- [a, b] # note).
        const parsed = parseArrayItem(stripComment(item[1] ?? ''), index + 1, candidate)
        if (!parsed.ok) return parsed
        const kind = itemKindOf(parsed.value)
        if (blockKind !== undefined && blockKind !== kind) {
          return err(at(index + 1, candidate, 'a block array must be all scalars, all flow maps, or all arrays'))
        }
        blockKind = kind
        items.push(parsed.value)
        index += 1
      }
      if (entries.has(rawKey)) return err(at(lineNumber, raw, `duplicate key "${rawKey}"`))
      entries.set(rawKey, items.length === 0 ? null : Object.freeze(items))
      continue
    }

    const parsed = stripped.trim().startsWith('[')
      ? parseInlineArray(stripped, lineNumber, raw)
      : parseScalar(stripped, lineNumber, raw)
    if (!parsed.ok) return parsed
    if (entries.has(rawKey)) return err(at(lineNumber, raw, `duplicate key "${rawKey}"`))
    entries.set(rawKey, parsed.value)
  }

  if (!closed) return err(invalidInput('frontmatter fence "---" is never closed', { reason: 'unclosed-fence' }))
  // The blank line after the fence separates it from the body; `renderFrontmatter`
  // always emits exactly one, so stripping the leading newlines keeps the pair exact.
  const tail = lines.slice(index)
  let blank = 0
  while (blank < tail.length && (tail[blank] ?? '') === '') blank += 1
  return ok(Object.freeze({
    frontmatter: Object.freeze(Object.fromEntries(entries)),
    body: tail.join('\n').replace(/^\n+/, ''),
    // `index` is the first line after the closing fence, so the body starts at index + blanks + 1.
    bodyLine: index + blank + 1,
  }))
}

/**
 * Whether a plain (unquoted) scalar would survive a round trip. The rules mirror what
 * `parseScalar` accepts, so the pair stays exact: a colon alone is harmless, a colon
 * followed by a space starts a mapping; `#` alone is harmless, ` #` starts a comment.
 */
const needsQuotes = (value: string): boolean => {
  if (value === '') return true
  if (value.trim() !== value) return true
  if (RESERVED_PLAIN.has(value)) return true
  if (PLAIN_INTEGER.test(value)) return true
  if (value.includes(': ') || value.endsWith(':')) return true
  if (value.startsWith('#') || value.includes(' #') || value.endsWith('#')) return true
  if (value.startsWith('- ')) return true
  if (/[\n\t"'[\]{},]/.test(value)) return true
  if (FORBIDDEN_LEAD.has(value[0] ?? '')) return true
  return false
}

const renderScalar = (value: FrontmatterScalar): string => {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return String(value)
  if (!needsQuotes(value)) return value
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n')}"`
}

const renderFlowMap = (map: FrontmatterMap): string =>
  `{ ${Object.entries(map).map(([key, value]) => `${key}: ${renderScalar(value)}`).join(', ')} }`

/**
 * The exact inverse of {@link parseFrontmatter} for the subset it accepts: LF only, no
 * BOM, no trailing spaces, one blank line between the fence and the body.
 */
export const renderFrontmatter = (frontmatter: Frontmatter, body: string): string => {
  const lines: string[] = [FENCE]
  for (const [key, value] of Object.entries(frontmatter)) {
    if (Array.isArray(value)) {
      const items = value as readonly FrontmatterItem[]
      const rendered = items.map((item) => {
        if (Array.isArray(item)) return `[${item.map(renderScalar).join(', ')}]`
        return typeof item === 'object' && item !== null ? renderFlowMap(item as FrontmatterMap) : renderScalar(item)
      })
      lines.push(items.length === 0 ? `${key}: []` : `${key}: [${rendered.join(', ')}]`)
      continue
    }
    lines.push(`${key}: ${renderScalar(value as FrontmatterScalar)}`)
  }
  lines.push(FENCE)
  const trimmedBody = body.replace(/^\n+/, '').replace(/\n*$/, '')
  return `${lines.join('\n')}\n${trimmedBody === '' ? '' : `\n${trimmedBody}\n`}`
}
