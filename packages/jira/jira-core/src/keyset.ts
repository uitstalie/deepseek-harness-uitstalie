/**
 * core/keyset — the key inventory and the comparison list (decision 94).
 *
 * Independent instances are expected to exist (decision 35/36): two machines that never talked to
 * each other will both have handed out `DH-1`, `DH-2`, … So before merging, a human needs one thing
 * the dangling-reference report cannot give: **which keys exist on each side, and which of them
 * collide**. A collision whose summary differs is a genuine clash; one whose summary matches is
 * almost certainly the same issue recorded twice, and the merge can treat it as the same.
 *
 * The design deliberately does **not** ship merge tooling (decision 94: MVP does not do it). This is
 * one of its two promised supports; the mapping table itself stays a human's file.
 */

import { type Issue } from './entity.ts'

export type KeyRow = Readonly<{
  key: string
  project: string
  status: string
  summary: string
  updatedAt: string
}>

export type KeyInventory = Readonly<{
  rows: readonly KeyRow[]
  byProject: readonly Readonly<{ project: string; rows: readonly KeyRow[] }>[]
  total: number
}>

const rowOf = (issue: Issue): KeyRow => Object.freeze({
  key: String(issue.key),
  project: issue.project,
  status: issue.status,
  summary: issue.summary,
  updatedAt: issue.updatedAt,
})

export const keyInventory = (issues: readonly Issue[]): KeyInventory => {
  const rows = [...issues].map(rowOf).sort((left, right) =>
    left.project.localeCompare(right.project) || left.key.localeCompare(right.key))

  const byProject: { project: string; rows: KeyRow[] }[] = []
  for (const row of rows) {
    const last = byProject[byProject.length - 1]
    if (last !== undefined && last.project === row.project) last.rows.push(row)
    else byProject.push({ project: row.project, rows: [row] })
  }

  return Object.freeze({
    rows: Object.freeze(rows),
    byProject: Object.freeze(byProject.map(group => Object.freeze({ project: group.project, rows: Object.freeze(group.rows) }))),
    total: rows.length,
  })
}

export type KeyCollision = Readonly<{
  key: string
  left: KeyRow
  right: KeyRow
  /** Same summary on both sides: almost certainly one issue, not two. */
  sameSummary: boolean
}>

export type KeyComparison = Readonly<{
  leftTotal: number
  rightTotal: number
  onlyLeft: readonly KeyRow[]
  onlyRight: readonly KeyRow[]
  collisions: readonly KeyCollision[]
}>

export const compareKeyInventories = (left: KeyInventory, right: KeyInventory): KeyComparison => {
  const rightByKey = new Map(right.rows.map(row => [row.key, row]))
  const leftByKey = new Map(left.rows.map(row => [row.key, row]))

  const collisions: KeyCollision[] = []
  for (const row of left.rows) {
    const other = rightByKey.get(row.key)
    if (other === undefined) continue
    collisions.push(Object.freeze({ key: row.key, left: row, right: other, sameSummary: row.summary === other.summary }))
  }

  return Object.freeze({
    leftTotal: left.total,
    rightTotal: right.total,
    onlyLeft: Object.freeze(left.rows.filter(row => !rightByKey.has(row.key))),
    onlyRight: Object.freeze(right.rows.filter(row => !leftByKey.has(row.key))),
    collisions: Object.freeze(collisions),
  })
}

/** The inventory as a list a human can read next to the other side's. */
export const renderKeyInventory = (inventory: KeyInventory, label = '本账本'): string => {
  const lines: string[] = []
  for (const group of inventory.byProject) {
    lines.push(`${group.project}（${String(group.rows.length)}）：`)
    for (const row of group.rows) {
      lines.push(`  ${row.key}  [${row.status}]  ${row.updatedAt}  ${row.summary}`)
    }
  }
  if (lines.length === 0) lines.push('（没有 issue）')
  lines.push(`${label}：${String(inventory.total)} 个 key`)
  return `${lines.join('\n')}\n`
}

/**
 * The comparison, with collisions first: those are the decisions a merge has to make, and the ones
 * whose summaries differ are the ones worth a human's attention.
 */
export const renderKeyComparison = (comparison: KeyComparison, leftLabel = '本账本', rightLabel = '另一账本'): string => {
  const clashes = comparison.collisions.filter(collision => !collision.sameSummary)
  const same = comparison.collisions.filter(collision => collision.sameSummary)
  const lines: string[] = []

  lines.push(`同 key 但 summary 不同（${String(clashes.length)}）—— 这些是真冲突：`)
  lines.push(...(clashes.length === 0 ? ['  （无）'] : clashes.map(collision =>
    `  ${collision.key}\n    ${leftLabel}：${collision.left.summary}\n    ${rightLabel}：${collision.right.summary}`)))

  lines.push(`同 key 且 summary 相同（${String(same.length)}）—— 多半是同一条记了两次：`)
  lines.push(...(same.length === 0 ? ['  （无）'] : same.map(collision => `  ${collision.key}  ${collision.left.summary}`)))

  lines.push(`只在 ${leftLabel}（${String(comparison.onlyLeft.length)}）：`)
  lines.push(...(comparison.onlyLeft.length === 0 ? ['  （无）'] : comparison.onlyLeft.map(row => `  ${row.key}  [${row.status}]  ${row.summary}`)))

  lines.push(`只在 ${rightLabel}（${String(comparison.onlyRight.length)}）：`)
  lines.push(...(comparison.onlyRight.length === 0 ? ['  （无）'] : comparison.onlyRight.map(row => `  ${row.key}  [${row.status}]  ${row.summary}`)))

  lines.push(`合计：${leftLabel} ${String(comparison.leftTotal)}，${rightLabel} ${String(comparison.rightTotal)}；映射表写到 _merge/<UTC>-from-<machine_id>.md（决策 94 的约定，目录在归并时自建 —— 工具不做归并）`)
  return `${lines.join('\n')}\n`
}
