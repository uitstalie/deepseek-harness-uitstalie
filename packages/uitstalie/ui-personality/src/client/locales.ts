/**
 * The identity proposal queue's copy (English is the key-set source of truth;
 * the locale service enforces a balanced Chinese pair at registration).
 *
 * @module @deepseek-ai/dsh-client-ui-personality/locales
 */

/** English strings (the key-set source of truth for this pair). */
export const en = {
  nav: 'Personality',
  title: 'Personality',
  intro: 'Identity entries describe who you are, so the provider never writes one on its own. The model can queue a proposal; accepting one writes it into PERSONALITY.md, rejecting leaves the profile unchanged.',
  loading: 'Reading proposals…',
  empty: 'No identity proposals are queued.',
  failed: 'The proposal queue could not be read: {message}',
  retry: 'Retry',
  evidence: 'Evidence: {evidence}',
  queuedAt: 'Queued {date}',
  pending: 'pending',
  accepted: 'accepted',
  rejected: 'rejected',
  accept: 'Accept',
  reject: 'Reject',
  acceptName: 'Accept the identity proposal {name}',
  rejectName: 'Reject the identity proposal {name}',
  decideFailed: 'The decision could not be applied: {message}',
  rule: 'Accepting writes the entry through the version-guarded profile write; rejecting only records the decision. The /personality command offers the same choices.',
  settingsTitle: 'Provider settings',
  settingsIntro: 'Edits the volatile fields of the personality row. Saving applies to the next tool call, automatic-learning decision or history write.',
  fieldOverlay: 'Read and write the workspace overlay',
  fieldMaxBytes: 'PERSONALITY.md body budget (bytes)',
  fieldAutoLearnEntries: 'Automatic entries per session',
  fieldAutoLearnBytes: 'Automatic bytes per session',
  fieldHistoryLimit: 'History records kept per file',
  save: 'Save',
  saving: 'Saving…',
  discard: 'Discard',
  saveFailed: 'The provider settings were not saved.',
  settingsUnavailable: 'The settings service is not composed here; the provider fields cannot be edited.',
  invalidField: 'Enter a positive whole number.',
}

/** The settings.personality namespace key union. */
export type PersonalityKey = keyof typeof en

/** Chinese strings (same keys as {@link en}). */
export const zh: { [Key in keyof typeof en]: string } = {
  nav: '人格',
  title: '人格档案',
  intro: 'identity 条目描述“你是谁”，因此 provider 不会自行写入。模型可以把提案排入队列；接受会写入 PERSONALITY.md，拒绝不改动档案。',
  loading: '正在读取提案…',
  empty: '当前没有待处理的 identity 提案。',
  failed: '无法读取提案队列：{message}',
  retry: '重试',
  evidence: '证据：{evidence}',
  queuedAt: '提议于 {date}',
  pending: '待接受',
  accepted: '已接受',
  rejected: '已拒绝',
  accept: '接受',
  reject: '拒绝',
  acceptName: '接受 identity 提案 {name}',
  rejectName: '拒绝 identity 提案 {name}',
  decideFailed: '无法应用这次决定：{message}',
  rule: '接受会经版本守卫的档案写入落盘；拒绝只记录决定。`/personality` 命令提供同样的选择。',
  settingsTitle: 'Provider 设置',
  settingsIntro: '编辑 personality 行的 volatile 字段。保存后在下一次工具调用、自动学习判定或历史写入时生效。',
  fieldOverlay: '读写 workspace overlay',
  fieldMaxBytes: 'PERSONALITY.md 正文预算（字节）',
  fieldAutoLearnEntries: '每会话自动条目数',
  fieldAutoLearnBytes: '每会话自动写入字节数',
  fieldHistoryLimit: '每个文件保留的历史记录数',
  save: '保存',
  saving: '保存中…',
  discard: '放弃修改',
  saveFailed: 'Provider 设置未保存。',
  settingsUnavailable: '当前组合未挂载设置服务，无法编辑 provider 字段。',
  invalidField: '请输入正整数。',
}

/**
 * Fill one `{name}` placeholder in a copy string.
 * @param text - the copy template.
 * @param params - placeholder values keyed by placeholder name.
 * @returns the copy with every matching placeholder replaced.
 */
export function fill(text: string, params: Record<string, string>): string {
  let out = text
  for (const [key, value] of Object.entries(params)) {
    out = out.replaceAll(`{${key}}`, value)
  }
  return out
}
