/**
 * core/tagsLint — the tag registry report (decision 86).
 *
 * Three fixed sections, thresholds as decided, and **no automatic edits**: a tag name is a human's
 * vocabulary, and a tool that renames them silently would be rewriting history in the commit log.
 *
 *   - **used once or never** (count ≤ 1): a tag nobody uses is either a typo or a plan;
 *   - **missing `description`**: the registry's whole purpose is explaining a tag to the next person;
 *   - **highly similar pairs** (Dice ≥ 0.7): candidates for an alias, which is the mechanism the
 *     design chose (decision 86: alias → prefix → Dice, never a fuzzy dependency).
 */

import { type Issue } from './entity.ts'
import { tagUseCounts } from './generate.ts'
import { type TagDef } from './tags.ts'
import { similarity } from './tags.ts'

/** Decision 86's threshold for "these two are probably the same tag". */
export const SIMILARITY_THRESHOLD = 0.7

export type SimilarPair = Readonly<{ left: string; right: string; score: number; shared: boolean }>

export type TagsLintReport = Readonly<{
  /** Registered tags used by at most one issue, including never. */
  barelyUsed: readonly Readonly<{ name: string; count: number }>[]
  missingDescription: readonly string[]
  similar: readonly SimilarPair[]
  counts: Readonly<{ tags: number; issues: number }>
}>

export const lintTags = (tags: readonly TagDef[], issues: readonly Issue[]): TagsLintReport => {
  const counts = tagUseCounts(issues)

  const barelyUsed = tags
    .map(tag => ({ name: tag.name, count: counts.get(tag.name) ?? 0 }))
    .filter(entry => entry.count <= 1)
    .sort((left, right) => left.count - right.count || left.name.localeCompare(right.name))

  const missingDescription = tags
    .filter(tag => (tag.description ?? '').trim() === '')
    .map(tag => tag.name)
    .sort()

  const similar: SimilarPair[] = []
  for (let left = 0; left < tags.length; left += 1) {
    for (let right = left + 1; right < tags.length; right += 1) {
      const a = tags[left]
      const b = tags[right]
      if (a === undefined || b === undefined) continue
      const score = similarity(a.name, b.name)
      if (score < SIMILARITY_THRESHOLD) continue
      // A declared alias is the fix decision 86 prescribes, so say when it is already in place.
      const shared = (a.aliases ?? []).includes(b.name) || (b.aliases ?? []).includes(a.name)
      // Fixed order inside the pair, so the report does not change when the registry does.
      const [first, second] = [a.name, b.name].sort()
      similar.push(Object.freeze({ left: first ?? a.name, right: second ?? b.name, score: Math.round(score * 100) / 100, shared }))
    }
  }
  similar.sort((left, right) => right.score - left.score || left.left.localeCompare(right.left))

  return Object.freeze({
    barelyUsed: Object.freeze(barelyUsed),
    missingDescription: Object.freeze(missingDescription),
    similar: Object.freeze(similar),
    counts: Object.freeze({ tags: tags.length, issues: issues.length }),
  })
}

/** The three sections, always all three: "nothing here" is information too. */
export const renderTagsLint = (report: TagsLintReport): string => {
  const lines: string[] = []
  lines.push(`只用过一次（${String(report.barelyUsed.length)}）：`)
  lines.push(...(report.barelyUsed.length === 0
    ? ['  （无）']
    : report.barelyUsed.map(entry => `  ${entry.name}  (${String(entry.count)})`)))

  lines.push(`缺少 description（${String(report.missingDescription.length)}）：`)
  lines.push(...(report.missingDescription.length === 0 ? ['  （无）'] : report.missingDescription.map(name => `  ${name}`)))

  lines.push(`相似对，Dice ≥ ${String(SIMILARITY_THRESHOLD)}（${String(report.similar.length)}）：`)
  lines.push(...(report.similar.length === 0
    ? ['  （无）']
    : report.similar.map(pair =>
      `  ${pair.left} ~ ${pair.right}  （${String(pair.score)}${pair.shared ? '，已声明 alias' : ''}）`)))

  lines.push(`已检查：${String(report.counts.tags)} 个标签 / ${String(report.counts.issues)} 条 issue —— 只报告，绝不改写`)
  return `${lines.join('\n')}\n`
}
