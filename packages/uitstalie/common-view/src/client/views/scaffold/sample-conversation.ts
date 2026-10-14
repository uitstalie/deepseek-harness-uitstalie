/**
 * The conversation the scaffold draws in the middle region: the Session lineage
 * its header renders as breadcrumbs, and the view tabs that sit beside them.
 * @module @deepseek-ai/dsh-client-common-view/sample-conversation
 */
import type { CommonViewKey } from '../../locales.ts'

/** One view tab of the middle region. */
export interface ConversationTab {
  /** Stable identity of the view. */
  id: string
  /** Dictionary key of the label; the view's own definition owns the wording. */
  labelKey: CommonViewKey
}

/** The sample conversation surface. */
export const SAMPLE_CONVERSATION = {
  /**
   * Session lineage, current last: the shell walks a Session's subagent parents
   * and renders each ancestor as a crumb.
   */
  breadcrumbs: ['重构会话标题的自动生成', '子智能体：整理工具目录'],
  /** View tabs in the shell's order; the shell shows the strip only with two or more. */
  tabs: [
    { id: 'chat', labelKey: 'scaffold.tabChat' },
    { id: 'trajectory', labelKey: 'scaffold.tabTrajectory' },
  ] as readonly ConversationTab[],
  /** The view the ledger has selected. */
  activeTab: 'chat',
  /** Whether the Session is still blank, which is the phase the hero belongs to. */
  hero: true,
}
