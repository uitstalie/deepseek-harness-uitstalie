/**
 * core/boardHtml — `jira board --html` (decision 87's P1).
 *
 * One self-contained file: inline CSS, no scripts, no external assets. That is deliberate — it must
 * open from a file:// URL on a machine with no network, and it must survive being committed to a
 * repository or published through GitHub Pages (decision 87's stated goal).
 *
 * The layout mirrors the Markdown board rather than inventing a second opinion: sections follow
 * `statuses[].order`, the blocked issues are lifted into their own section, closed issues come last,
 * and every section carries its count.
 *
 * Everything from the store is escaped. A summary is a human's text and will eventually contain an
 * angle bracket; a board that renders it as markup is a bug with a security taste.
 */

import { type Issue } from './entity.ts'
import { isBlocked } from './generate.ts'
import { type Vocab } from './vocab.ts'

export type BoardHtmlOptions = Readonly<{
  title?: string
  /** When the file was produced; omitted from the header when unknown rather than invented. */
  generatedAt?: string
  sourceTree?: string
}>

export const escapeHtml = (value: string): string =>
  value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;')

type Section = Readonly<{ id: string; title: string; issues: readonly Issue[]; kind: 'open' | 'blocked' | 'closed' }>

/** The same grouping the Markdown board uses, exposed so the two can be compared in a test. */
export const boardSections = (issues: readonly Issue[], vocab: Vocab): readonly Section[] => {
  const byKey = new Map(issues.map(issue => [String(issue.key), issue]))
  const closed = new Set(vocab.closed)
  const open = issues.filter(issue => !closed.has(issue.status))
  const blocked = open.filter(issue => isBlocked(issue, byKey, vocab))
  const blockedKeys = new Set(blocked.map(issue => String(issue.key)))

  const sections: Section[] = []
  const ordered = [...vocab.statuses].sort((left, right) => left.order - right.order)
  for (const status of ordered) {
    if (closed.has(status.name)) continue
    const inStatus = open.filter(issue => issue.status === status.name && !blockedKeys.has(String(issue.key)))
    sections.push(Object.freeze({ id: `status-${status.name}`, title: status.name, issues: Object.freeze(inStatus), kind: 'open' }))
  }
  if (blocked.length > 0) {
    sections.push(Object.freeze({ id: 'blocked', title: '被阻塞', issues: Object.freeze(blocked), kind: 'blocked' }))
  }
  const done = issues.filter(issue => closed.has(issue.status))
  if (done.length > 0) {
    sections.push(Object.freeze({ id: 'closed', title: '已关闭', issues: Object.freeze(done), kind: 'closed' }))
  }
  return Object.freeze(sections)
}

const css = `
:root { color-scheme: light dark; --line: #d8d8d8; --muted: #666; --accent: #2b6cb0; }
* { box-sizing: border-box; }
body { font: 15px/1.5 -apple-system, "Segoe UI", "Noto Sans CJK SC", sans-serif; margin: 0 auto; max-width: 68rem; padding: 1.5rem; }
h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
h2 { font-size: 1.05rem; margin: 2rem 0 .5rem; border-bottom: 1px solid var(--line); padding-bottom: .25rem; }
h2 .count { color: var(--muted); font-weight: normal; font-size: .9rem; }
.meta { color: var(--muted); font-size: .85rem; margin-bottom: 1rem; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 600; font-size: .8rem; text-transform: uppercase; letter-spacing: .02em; }
td.key { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; white-space: nowrap; }
td.pri { white-space: nowrap; }
tr.conflicted td.key::after { content: " ⚠"; }
.blocked h2 { color: #b7791f; }
.tags { color: var(--muted); font-size: .85rem; }
.empty { color: var(--muted); font-style: italic; }
footer { color: var(--muted); font-size: .85rem; margin-top: 2rem; }
`.trim()

const rows = (issues: readonly Issue[]): string => issues.map(issue => [
  `<tr${issue.conflicted ? ' class="conflicted"' : ''}>`,
  `<td class="key"><a href="#${escapeHtml(String(issue.key))}">${escapeHtml(String(issue.key))}</a></td>`,
  `<td>${escapeHtml(issue.summary)}</td>`,
  `<td class="pri">${escapeHtml(issue.priority)}</td>`,
  `<td>${escapeHtml(issue.assignee ?? '—')}</td>`,
  `<td>${escapeHtml(issue.updatedAt)}</td>`,
  `<td class="tags">${issue.tags.length === 0 ? '—' : escapeHtml(issue.tags.join(', '))}</td>`,
  '</tr>',
].join('')).join('\n')

const sectionHtml = (section: Section): string => [
  `<section class="${section.kind}" id="${escapeHtml(section.id)}">`,
  `<h2>${escapeHtml(section.title)} <span class="count">${String(section.issues.length)}</span></h2>`,
  section.issues.length === 0
    ? '<p class="empty">这里还没有内容</p>'
    : [
      '<table>',
      '<thead><tr><th>key</th><th>summary</th><th>priority</th><th>assignee</th><th>updated</th><th>tags</th></tr></thead>',
      `<tbody>${rows(section.issues)}</tbody>`,
      '</table>',
    ].join('\n'),
  '</section>',
].join('\n')

export const renderBoardHtml = (issues: readonly Issue[], vocab: Vocab, options: BoardHtmlOptions = {}): string => {
  const sections = boardSections(issues, vocab)
  const title = options.title ?? 'jira 看板'
  const hidden = issues.filter(issue => vocab.closed.includes(issue.status)).length

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${css}</style>`,
    '</head>',
    '<body>',
    `<h1>${escapeHtml(title)}</h1>`,
    `<p class="meta">${String(issues.length)} 条 issue，${String(hidden)} 条已关闭`
      + (options.generatedAt === undefined ? '' : ` · 生成于 ${escapeHtml(options.generatedAt)}`)
      + (options.sourceTree === undefined ? '' : ` · 输入 ${escapeHtml(options.sourceTree)}`)
      + '</p>',
    ...sections.map(sectionHtml),
    '<footer>静态文件：无脚本、无外链。用 <code>jira board --html</code> 重新生成。</footer>',
    '</body>',
    '</html>',
    '',
  ].join('\n')
}
