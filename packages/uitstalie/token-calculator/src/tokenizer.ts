/**
 * Offline DeepSeek V4 tokenizer: byte-level BPE with the tokenizer's own split pretokenizer.
 *
 * The tokenizer JSON is the HuggingFace `LlamaTokenizerFast` file shipped with the DeepSeek V4
 * tokenizer (128,000 vocabulary entries, 127,741 merges, 1,283 added tokens). It is stored gzipped
 * beside the package so counting needs no network, Python, or native binding. Loading is lazy and
 * cached for the process.
 * @module @deepseek-ai/dsh-token-calculator/tokenizer
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

/** One tokenizer.json added token. */
interface AddedToken {
  /** Stable id this content encodes to. */
  readonly id: number
  /** Literal content matched in the text before BPE. */
  readonly content: string
}

/** The pieces of tokenizer.json the calculator uses. */
interface LoadedTokenizer {
  /** Byte-level BPE vocabulary: merged symbol to id. */
  readonly vocab: ReadonlyMap<string, number>
  /** BPE merge rank keyed by `left\u0000right`. */
  readonly merges: ReadonlyMap<string, number>
  /** Added tokens grouped by first UTF-16 code unit, longest first. */
  readonly addedByFirst: ReadonlyMap<string, readonly AddedToken[]>
  /** The tokenizer's own ordered Split regexes. */
  readonly splits: readonly RegExp[]
  /** Byte to byte-level symbol (GPT-2 mapping). */
  readonly byteSymbol: readonly string[]
}

/** Counts for one measured text. */
export interface TokenCount {
  /** Number of DeepSeek V4 tokens. */
  readonly tokens: number
  /** UTF-16 characters in the text. */
  readonly characters: number
  /** UTF-8 bytes in the text. */
  readonly bytes: number
}

/** Options of {@link countTokens}. */
export interface CountTokensOptions {
  /** Whether to prepend the BOS token (`<｜begin▁of▁sentence｜>`, id 0); default false. */
  readonly addSpecialTokens?: boolean
}

/** Asset path, resolved from both `src/` (tests) and `lib/` (built package). */
const TOKENIZER_ASSET = new URL('../assets/deepseek-v4.tokenizer.json.gz', import.meta.url)

let cached: LoadedTokenizer | undefined

/** Build the GPT-2 byte-to-unicode table: printable bytes keep their character, the rest shift. */
function buildByteSymbols(): string[] {
  const direct: number[] = []
  for (let byte = 33; byte <= 126; byte += 1) direct.push(byte)
  for (let byte = 161; byte <= 172; byte += 1) direct.push(byte)
  for (let byte = 174; byte <= 255; byte += 1) direct.push(byte)
  const symbols: string[] = new Array<string>(256).fill('')
  for (const byte of direct) symbols[byte] = String.fromCodePoint(byte)
  let extra = 0
  for (let byte = 0; byte <= 255; byte += 1) {
    if (symbols[byte] !== '') continue
    symbols[byte] = String.fromCodePoint(256 + extra)
    extra += 1
  }
  return symbols
}

/**
 * Load and cache the tokenizer asset.
 * @returns the parsed vocabulary, merge ranks, added-token index, split regexes, and byte table.
 */
export function loadTokenizer(): LoadedTokenizer {
  if (cached !== undefined) return cached
  const json = JSON.parse(gunzipSync(readFileSync(fileURLToPath(TOKENIZER_ASSET))).toString('utf8')) as {
    added_tokens: { id: number; content: string }[]
    pre_tokenizer: { pretokenizers: { type: string; pattern?: { Regex?: string } }[] }
    model: { vocab: Record<string, number>; merges: string[] }
  }
  const vocab = new Map(Object.entries(json.model.vocab))
  const merges = new Map<string, number>()
  for (const [rank, merge] of json.model.merges.entries()) {
    const space = merge.indexOf(' ')
    merges.set(`${merge.slice(0, space)}\u0000${merge.slice(space + 1)}`, rank)
  }
  const added = json.added_tokens
    .map(token => ({ id: token.id, content: token.content }))
    .sort((left, right) => right.content.length - left.content.length)
  const addedByFirst = new Map<string, AddedToken[]>()
  for (const token of added) {
    const first = token.content[0] ?? ''
    const list = addedByFirst.get(first) ?? []
    list.push(token)
    addedByFirst.set(first, list)
  }
  const splits = json.pre_tokenizer.pretokenizers
    .filter(part => part.type === 'Split' && part.pattern?.Regex !== undefined)
    .map(part => new RegExp(part.pattern?.Regex ?? '', 'gu'))
  cached = { vocab, merges, addedByFirst, splits, byteSymbol: buildByteSymbols() }
  return cached
}

/** Split every segment by one Split pretokenizer, isolating matches like `behavior: Isolated`. */
function splitWith(segments: readonly string[], regex: RegExp): string[] {
  const out: string[] = []
  for (const segment of segments) {
    if (segment === '') continue
    let last = 0
    for (const match of segment.matchAll(regex)) {
      const index = match.index
      const text = match[0]
      if (text === '') continue
      if (index > last) out.push(segment.slice(last, index))
      out.push(text)
      last = index + text.length
    }
    if (last < segment.length) out.push(segment.slice(last))
  }
  return out
}

/** Apply the tokenizer's full pretokenizer chain to one text. */
function pretokenize(text: string, tokenizer: LoadedTokenizer): string[] {
  let segments: string[] = [text]
  for (const regex of tokenizer.splits) segments = splitWith(segments, regex)
  return segments
}

/** Map one segment's UTF-8 bytes to byte-level symbols. */
function toByteSymbols(segment: string, tokenizer: LoadedTokenizer): string[] {
  const bytes = Buffer.from(segment, 'utf8')
  const symbols: string[] = new Array<string>(bytes.length)
  for (const [index, byte] of bytes.entries()) symbols[index] = tokenizer.byteSymbol[byte] ?? ''
  return symbols
}

/** Merge one byte-level segment with the vocabulary's BPE ranks and return its token ids. */
function bpeIds(segment: string, tokenizer: LoadedTokenizer): number[] {
  let symbols = toByteSymbols(segment, tokenizer)
  if (symbols.length === 0) return []
  const { merges, vocab } = tokenizer
  while (symbols.length > 1) {
    let bestRank = Number.POSITIVE_INFINITY
    let bestIndex = -1
    let bestSymbol = ''
    for (let index = 0; index + 1 < symbols.length; index += 1) {
      const left = symbols[index] ?? ''
      const right = symbols[index + 1] ?? ''
      const rank = merges.get(`${left}\u0000${right}`)
      if (rank !== undefined && rank < bestRank) {
        bestRank = rank
        bestIndex = index
        bestSymbol = left + right
      }
    }
    if (bestIndex < 0) break
    symbols = [
      ...symbols.slice(0, bestIndex),
      bestSymbol,
      ...symbols.slice(bestIndex + 2),
    ]
  }
  return symbols.map(symbol => vocab.get(symbol) ?? -1)
}

/**
 * Encode one text to DeepSeek V4 token ids.
 * @param text - the text to measure.
 * @param options - whether to prepend BOS.
 * @returns token ids; -1 marks a byte-level symbol the vocabulary lacks.
 */
export function encodeTokens(text: string, options: CountTokensOptions = {}): number[] {
  const tokenizer = loadTokenizer()
  const ids: number[] = []
  if (options.addSpecialTokens === true) ids.push(0)
  let index = 0
  while (index < text.length) {
    const candidates = tokenizer.addedByFirst.get(text[index] ?? '')
    const matched = candidates?.find(token => text.startsWith(token.content, index))
    if (matched !== undefined) {
      ids.push(matched.id)
      index += matched.content.length
      continue
    }
    // Bound this BPE run at the next position where an added token starts.
    let end = index + 1
    while (end < text.length) {
      const next = tokenizer.addedByFirst.get(text[end] ?? '')
      if (next !== undefined && next.some(token => text.startsWith(token.content, end))) break
      end += 1
    }
    for (const segment of pretokenize(text.slice(index, end), tokenizer)) ids.push(...bpeIds(segment, tokenizer))
    index = end
  }
  return ids
}

/**
 * Count DeepSeek V4 tokens in one text.
 * @param text - the text to measure.
 * @param options - whether to count the BOS token too.
 * @returns the token, character, and byte counts.
 */
export function countTokens(text: string, options: CountTokensOptions = {}): TokenCount {
  return {
    tokens: encodeTokens(text, options).length,
    characters: text.length,
    bytes: Buffer.byteLength(text, 'utf8'),
  }
}
