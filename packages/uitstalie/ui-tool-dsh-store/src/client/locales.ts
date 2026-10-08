/**
 * 侧边栏 rules 按钮的文案字典（英文为键集基准，中文同键——注册时 locale
 * 服务强制双语平衡）。
 * @module @deepseek-ai/dsh-client-ui-tool-dsh-store/locales
 */

/** English strings (the key-set source of truth for this pair). */
export const en = {
  button: 'Rules',
  buttonAria: 'Show the workspace rules of {name}',
  title: 'Workspace rules of {name}',
  loading: 'Loading rules…',
  loadFailed: 'Rules failed to load: {message}',
  empty: 'This workspace has no rules yet.',
  emptyHint: 'Rules live in .dsh/rules and every Markdown file there is always in context.',
  ruleFailed: 'Rule failed to load: {message}',
  close: 'Close',
}

/** Chinese strings, same keys. */
export const zh: typeof en = {
  button: '规则',
  buttonAria: '查看 {name} 的工作区规则',
  title: '{name} 的工作区规则',
  loading: '正在载入规则…',
  loadFailed: '规则载入失败：{message}',
  empty: '该工作区还没有规则。',
  emptyHint: '规则放在 .dsh/rules，那里的每个 Markdown 文件都始终进入上下文。',
  ruleFailed: '规则读取失败：{message}',
  close: '关闭',
}

/** Key set of the rules dictionary. */
export type RulesKey = keyof typeof en
