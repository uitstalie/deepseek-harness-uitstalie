/**
 * models.dev 设置页的文案字典（英文为键集基准，中文同键——
 * 注册时 locale 服务强制双语平衡）。
 *
 * @module @deepseek-ai/dsh-client-ui-models-dev/locales
 */

/** English strings (the key-set source of truth for this pair). */
export const en = {
  nav: 'Models.dev',
  subtitle: 'Browse the fetched models.dev catalog and materialize providers as your own routes.',
  filterPlaceholder: 'Filter providers…',
  loading: 'Loading catalog…',
  loadFailed: 'Catalog failed to load: {message}',
  retry: 'Retry',
  empty: 'The catalog is empty.',
  emptyFilter: 'No providers match the filter.',
  modelsCount: '{count} models',
  addSelected: 'Add {count} provider(s)',
  adding: 'Adding…',
  addedRoutes: 'Added routes: {routes}',
  addFailed: 'Add failed: {message}',
  conflict: 'Settings changed elsewhere; reload and retry.',
  protocolRequired: 'Pick a protocol for {provider}.',
  invalidJson: '{field} must be a JSON object: {provider}',
  fieldRouteId: 'Route id',
  fieldDisplayName: 'Display name',
  fieldProtocol: 'Protocol',
  fieldBaseURL: 'Base URL',
  fieldApiKeyRef: 'Credential ref',
  fieldApiKey: 'API key',
  fieldHeaders: 'Extra headers (JSON)',
  fieldBody: 'Extra body fields (JSON)',
  fieldModels: 'Models',
  protocolChoose: 'choose…',
  apiKeyPlaceholder: 'Paste the key once — it is stored in the credentials service',
  modelsAll: 'All catalog models (follows the catalog)',
  modelsSubset: 'Selected subset',
  modelsLoading: 'loading models…',
  interpolatedUrl: 'The catalog endpoint contains {"${VAR}"} interpolation — fill in the concrete URL.',
}

/** The settings.models-dev namespace key union. */
export type ModelsDevKey = keyof typeof en

/** Chinese strings (same keys as {@link en}). */
export const zh: { [Key in keyof typeof en]: string } = {
  nav: '模型目录',
  subtitle: '浏览已拉取的 models.dev 目录，勾选提供商并物化为你自己的路由。',
  filterPlaceholder: '筛选提供商…',
  loading: '目录加载中…',
  loadFailed: '目录加载失败：{message}',
  retry: '重试',
  empty: '目录是空的。',
  emptyFilter: '没有匹配筛选的提供商。',
  modelsCount: '{count} 个模型',
  addSelected: '添加 {count} 个提供商',
  adding: '添加中…',
  addedRoutes: '已添加路由：{routes}',
  addFailed: '添加失败：{message}',
  conflict: '设置在别处被修改，请刷新后重试。',
  protocolRequired: '请为 {provider} 选择协议。',
  invalidJson: '{field} 必须是 JSON 对象：{provider}',
  fieldRouteId: '路由 id',
  fieldDisplayName: '显示名',
  fieldProtocol: '协议',
  fieldBaseURL: 'Base URL',
  fieldApiKeyRef: '凭据引用',
  fieldApiKey: 'API key',
  fieldHeaders: '额外请求头（JSON）',
  fieldBody: '额外请求体字段（JSON）',
  fieldModels: '模型',
  protocolChoose: '选择…',
  apiKeyPlaceholder: '粘贴一次密钥——存入凭据服务',
  modelsAll: '全部目录模型（跟随目录）',
  modelsSubset: '选定子集',
  modelsLoading: '模型加载中…',
  interpolatedUrl: '目录端点含 {"${VAR}"} 插值——请填具体 URL。',
}

/**
 * {param} 插值（字典文案的占位符替换；locale 的 t 只做查表，
 * 动态片段由调用方经本函数填充）。
 */
export function fill(text: string, params: Record<string, string>): string {
  let out = text
  for (const [key, value] of Object.entries(params)) {
    out = out.replaceAll(`{${key}}`, value)
  }
  return out
}
