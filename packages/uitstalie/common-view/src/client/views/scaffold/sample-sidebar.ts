/**
 * The sidebar replica's data: workspace groups and the sessions inside them,
 * carrying the same fields the shipped sidebar shows — a trailing time label, an
 * optional state dot, an optional pin, and an archived look.
 * @module @deepseek-ai/dsh-client-common-view/sample-sidebar
 */

/** One session row of the replica. */
export interface SidebarRow {
  /** Stable identity of the session. */
  id: string
  /** Session title. */
  title: string
  /** Trailing time label, as the shipped row shows it. */
  time: string
  /** Whether the session is the selected one. */
  selected?: boolean | undefined
  /** Whether the session is running; the leading cell draws its state dot only then. */
  running?: boolean | undefined
  /** Whether the session is pinned; the row then trails a pin indicator. */
  pinned?: boolean | undefined
  /** Whether the session is archived; its title drops to the caption label step. */
  archived?: boolean | undefined
}

/** One workspace group of the replica. */
export interface SidebarGroup {
  /** Stable identity of the workspace. */
  id: string
  /** Workspace title, shown by the group row. */
  title: string
  /** Whether the group lists its sessions. */
  expanded: boolean
  /** The sessions this group lists. */
  rows: readonly SidebarRow[]
}

/** Sample groups whose fields mirror a working set of sessions. */
export const SAMPLE_GROUPS: readonly SidebarGroup[] = [
  {
    id: 'deepseek-harness-uitstalie-dev',
    title: 'deepseek-harness-uitstalie-dev',
    expanded: true,
    rows: [
      { id: 's-1', title: 'button 能力与 DefaultButton', time: 'now', selected: true, running: true },
      { id: 's-2', title: '脚手架：父 view 大布局', time: '12m', pinned: true },
      { id: 's-3', title: 'common-view：组合渲染 → 回落原生', time: '1h' },
      { id: 's-4', title: '侧边栏复刻：groups 与 items', time: '3h', archived: true },
    ],
  },
  {
    id: 'deepseek-harness-uitstalie',
    title: 'deepseek-harness-uitstalie',
    expanded: false,
    rows: [
      { id: 's-5', title: 'task23：rebase 到上游并推送', time: 'Yest' },
      { id: 's-6', title: 'view 研究：会话行动作条', time: '2d' },
    ],
  },
]
