/**
 * The jira settings section's copy (English is the key-set source of truth; the locale service
 * enforces a balanced Chinese pair at registration).
 *
 * @module @deepseek-ai/dsh-client-ui-jira/locales
 */

/** English strings (the key-set source of truth for this pair). */
export const en = {
  nav: 'Jira',
  title: 'Jira ledger',
  intro: 'The workspace issue ledger and its knowledge base, read-only. Writes go through the agent tools.',
  statusTitle: 'Ledger',
  fieldRoot: 'Root',
  fieldHost: 'Audit host',
  fieldPush: 'Push after settle',
  fieldPending: 'Queued push',
  hostDefault: 'machine hostname',
  stateOn: 'on',
  stateOff: 'off',
  pendingArmed: 'a push is armed',
  pendingIdle: 'no push armed',
  lastSync: 'Last push',
  lastSyncNever: 'never',
  lastSyncOk: 'succeeded at {at}',
  lastSyncFailed: 'failed at {at}: {message}',
  statusFailed: 'The ledger status could not be read: {message}',
  settingsNote: 'These fields are the jira-service row configuration. This page shows the effective values; edit the row in the profile configuration to change them.',
  boardTitle: 'Board',
  boardLoading: 'Reading the ledger…',
  boardEmpty: 'No issue matches.',
  boardFailed: 'The ledger could not be read: {message}',
  boardCounts: '{returned} of {matched} issues',
  boardRemaining: '{remaining} more match the filter',
  blockedBadge: 'blocked',
  retry: 'Retry',
  unassigned: 'unassigned',
  detailTitle: 'Issue {key}',
  detailLoading: 'Reading the issue…',
  detailFailed: 'The issue could not be read: {message}',
  detailClose: 'Close',
  detailStatus: 'Status',
  detailPriority: 'Priority',
  detailType: 'Type',
  detailAssignee: 'Assignee',
  detailReporter: 'Reporter',
  detailTags: 'Tags',
  detailLinks: 'Links',
  detailCreated: 'Created',
  detailUpdated: 'Updated',
  detailRevision: 'Revision',
  detailResolution: 'Resolution',
  detailNote: 'Note',
  detailKnowledge: 'Knowledge',
  detailBody: 'Description',
  detailNone: 'none',
  kbTitle: 'Knowledge base',
  kbPlaceholder: 'Search the knowledge base…',
  kbAction: 'Search',
  kbLoading: 'Searching…',
  kbEmpty: 'No knowledge entry matches.',
  kbFailed: 'The search failed: {message}',
  kbMatched: '{matched} hits, {topK} at most',
  kbLocation: '{file}:{line}',
}

/** The settings.jira namespace key union. */
export type JiraKey = keyof typeof en

/** Chinese strings (same keys as {@link en}). */
export const zh: { [Key in keyof typeof en]: string } = {
  nav: 'Jira',
  title: 'Jira 台账',
  intro: '工作区 issue 台账与知识库，只读；写入只经模型工具。',
  statusTitle: '台账',
  fieldRoot: '根目录',
  fieldHost: '审计主机',
  fieldPush: '收尾后推送',
  fieldPending: '排队中的推送',
  hostDefault: '本机主机名',
  stateOn: '开',
  stateOff: '关',
  pendingArmed: '推送已排队',
  pendingIdle: '无排队推送',
  lastSync: '上次推送',
  lastSyncNever: '从未',
  lastSyncOk: '成功于 {at}',
  lastSyncFailed: '失败于 {at}：{message}',
  statusFailed: '读取台账状态失败：{message}',
  settingsNote: '这三个字段是 jira-service 行的配置。本页只展示生效值；如需修改，请编辑 profile 配置里的该行。',
  boardTitle: '看板',
  boardLoading: '正在读取台账…',
  boardEmpty: '没有匹配的 issue。',
  boardFailed: '读取台账失败：{message}',
  boardCounts: '{returned}/{matched} 条 issue',
  boardRemaining: '还有 {remaining} 条匹配筛选条件',
  blockedBadge: '被阻塞',
  retry: '重试',
  unassigned: '未认领',
  detailTitle: 'Issue {key}',
  detailLoading: '正在读取 issue…',
  detailFailed: '读取 issue 失败：{message}',
  detailClose: '关闭',
  detailStatus: '状态',
  detailPriority: '严重程度',
  detailType: '类型',
  detailAssignee: '认领人',
  detailReporter: '报告人',
  detailTags: '标签',
  detailLinks: '链接',
  detailCreated: '创建于',
  detailUpdated: '更新于',
  detailRevision: '修订号',
  detailResolution: '结论',
  detailNote: '备注',
  detailKnowledge: '知识条目',
  detailBody: '描述',
  detailNone: '无',
  kbTitle: '知识库',
  kbPlaceholder: '检索知识库…',
  kbAction: '检索',
  kbLoading: '检索中…',
  kbEmpty: '没有匹配的知识条目。',
  kbFailed: '检索失败：{message}',
  kbMatched: '{matched} 条命中，最多 {topK} 条',
  kbLocation: '{file}:{line}',
}

/**
 * Fill a dictionary sentence's `{param}` placeholders.
 * @param text - dictionary copy containing `{name}` placeholders.
 * @param params - placeholder name to replacement value.
 * @returns the copy with every provided placeholder replaced.
 */
export function fill(text: string, params: Record<string, string>): string {
  let out = text
  for (const [key, value] of Object.entries(params)) {
    out = out.replaceAll(`{${key}}`, value)
  }
  return out
}
