/**
 * The conversation the scaffold draws in the middle region: the Session lineage
 * its header renders as breadcrumbs, and the view tabs that sit beside them.
 * @module @deepseek-ai/dsh-client-common-view/sample-conversation
 */
import type { CommonViewKey } from '../../locales.ts'
import type { TranscriptMessage } from './ChatTranscript.tsx'

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
  /** Context occupancy the composer's meter reports. */
  occupancy: {
    percent: 45,
    usedTokens: 132_000,
    contextWindow: 256_000,
    breakdown: { systemTokens: 9_400, toolsTokens: 38_600, messageTokens: 84_000 },
  },
  /** The transcript, oldest first. */
  messages: [
    { id: 'm-1', role: 'user', text: '把侧栏的会话行动作条照原生复刻一遍' },
    { id: 'm-2', role: 'assistant', text: '会话行现在是 ⋯ 菜单 + 归档 + 图钉，归档行不提供图钉。' },
    { id: 'm-3', role: 'user', text: '顺便确认一下 hover 时的间距。' },
  ] as readonly TranscriptMessage[],
}
