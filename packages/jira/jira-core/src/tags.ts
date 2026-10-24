/**
 * core/tags — the tag naming rule and the "did you mean" search (decisions 26, 76, 86).
 *
 * Two jobs, both pure:
 *  - a tag (and a knowledge domain) is `lower-kebab`, at most 32 characters;
 *  - an unknown tag is refused with up to three nearest names, so a typo gets fixed
 *    instead of silently creating a near-duplicate.
 *
 * The search is deliberately small (alias match, then prefix, then Dice on bigrams with a
 * 0.5 floor) and dependency-free — decision 86 chose that over pulling in a fuzzy-match
 * library, because the whole point is to keep the package installable by copying it.
 */

export const TAG_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/
export const SUGGESTION_FLOOR = 0.5
export const SUGGESTION_LIMIT = 3

export type TagDef = Readonly<{ name: string; description?: string; aliases?: readonly string[] }>

/** Fold a name to its comparable form: lowercase, `-`/`_` removed. */
const fold = (value: string): string => value.toLowerCase().replaceAll(/[-_]/g, '')

/** Dice coefficient over character bigrams (`0` when either side is too short). */
export const similarity = (left: string, right: string): number => {
  const a = fold(left)
  const b = fold(right)
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return 0
  const bigrams = (value: string): Map<string, number> => {
    const counts = new Map<string, number>()
    for (let index = 0; index < value.length - 1; index += 1) {
      const pair = value.slice(index, index + 2)
      counts.set(pair, (counts.get(pair) ?? 0) + 1)
    }
    return counts
  }
  const leftPairs = bigrams(a)
  const rightPairs = bigrams(b)
  let shared = 0
  for (const [pair, count] of leftPairs) {
    const other = rightPairs.get(pair)
    if (other !== undefined) shared += Math.min(count, other)
  }
  const total = a.length - 1 + (b.length - 1)
  return total === 0 ? 0 : (2 * shared) / total
}

/**
 * Nearest known tags, best first. An exact alias hit wins; a prefix relationship is
 * treated as the strongest signal; otherwise the Dice score decides, above the floor.
 */
export const suggestTags = (
  known: readonly TagDef[],
  wanted: string,
  limit: number = SUGGESTION_LIMIT,
): readonly string[] => {
  const target = fold(wanted)
  const scored: { name: string; score: number }[] = []
  for (const tag of known) {
    if (fold(tag.name) === target) return Object.freeze([tag.name])
    const aliases = tag.aliases ?? []
    if (aliases.some(alias => fold(alias) === target)) return Object.freeze([tag.name])
    const folded = fold(tag.name)
    const prefix = folded.startsWith(target) || target.startsWith(folded)
    const score = prefix ? Math.max(similarity(tag.name, wanted), 0.9) : similarity(tag.name, wanted)
    if (score >= SUGGESTION_FLOOR) scored.push({ name: tag.name, score })
  }
  scored.sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
  return Object.freeze(scored.slice(0, limit).map(entry => entry.name))
}

export const isTagName = (value: string): boolean => TAG_PATTERN.test(value)
