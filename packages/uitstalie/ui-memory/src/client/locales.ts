/**
 * The memory settings section's copy (English is the key-set source of truth; the locale service
 * enforces a balanced Chinese pair at registration).
 * @module @deepseek-ai/dsh-client-ui-memory/locales
 */

/** English strings (the key-set source of truth for this pair). */
export const en = {
  nav: 'Memory',
  title: 'Memory',
  intro: 'Window thresholds, the summary model, and the MEMORY.md body budget. Saving applies to the next write or summary pass.',
  fieldDetail: 'Detail summary at turn age',
  fieldBrief: 'Brief summary at turn age',
  fieldForget: 'Forget body at turn age',
  fieldSessions: 'Sessions kept in MEMORY.md',
  fieldMaxBytes: 'Body budget (bytes)',
  fieldProvider: 'Summary provider',
  fieldModel: 'Summary model',
  placeholderInherit: 'inherit',
  placeholderModel: 'follow the routed model',
  save: 'Save',
  saving: 'Saving…',
  discard: 'Discard',
  saveFailed: 'The settings were not saved.',
  unavailable: 'The settings service is not composed here; this row cannot be edited.',
  invalidField: 'Enter a positive whole number.',
  staleNote: 'Older sessions are dropped from MEMORY.md when this limit is exceeded.',
}

/** The `settings.memory` namespace key union. */
export type MemoryKey = keyof typeof en

/** Chinese strings (same keys as {@link en}). */
export const zh: { [Key in keyof typeof en]: string } = {
  nav: 'Memory',
  title: 'Memory',
  intro: '窗口阈值、摘要模型与 MEMORY.md 正文预算。保存后在下一次写入或摘要时生效。',
  fieldDetail: '详细摘要的轮次年龄',
  fieldBrief: '简要摘要的轮次年龄',
  fieldForget: '忘记正文的轮次年龄',
  fieldSessions: 'MEMORY.md 保留的会话数',
  fieldMaxBytes: '正文预算（字节）',
  fieldProvider: '摘要 provider',
  fieldModel: '摘要模型',
  placeholderInherit: '继承',
  placeholderModel: '跟随本轮路由模型',
  save: '保存',
  saving: '保存中…',
  discard: '放弃修改',
  saveFailed: '设置未保存。',
  unavailable: '当前组合未挂载设置服务，无法编辑这一行。',
  invalidField: '请输入正整数。',
  staleNote: '超过该上限时，旧会话会从 MEMORY.md 中移除。',
}
