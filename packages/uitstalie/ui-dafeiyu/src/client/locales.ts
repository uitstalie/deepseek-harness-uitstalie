/**
 * The capability list's copy (English is the key-set source of truth; the
 * locale service enforces a balanced Chinese pair at registration).
 *
 * @module @deepseek-ai/dsh-client-ui-dafeiyu/locales
 */

/** English strings (the key-set source of truth for this pair). */
export const en = {
  nav: 'Capabilities',
  title: 'Capabilities',
  intro: 'Every capability registered with the organizer. The switch is the organizer gate; each provider still owns its own settings page.',
  loading: 'Reading capabilities…',
  empty: 'This composition registers no capability.',
  failed: 'The capability list could not be read: {message}',
  retry: 'Retry',
  stateActive: 'on',
  stateDisabled: 'off',
  stateMissing: 'not loaded',
  stateFailed: 'failed',
  failure: 'Last failure: {message}',
  missingNote: 'Configured, but its plugin row is not loaded.',
  turnOn: 'Turn on {name}',
  turnOff: 'Turn off {name}',
  openSettings: 'Open settings',
  gateNote: 'The switch is the organizer gate only: turning a capability off withdraws it from running sessions immediately, and turning it on applies from the next new session. Provider configuration stays on the provider page.',
  updateRefused: 'The host refused this switch.',
  updateFailed: 'The switch could not be changed: {message}',
}

/** The settings.capabilities namespace key union. */
export type CapabilityKey = keyof typeof en

/** Chinese strings (same keys as {@link en}). */
export const zh: { [Key in keyof typeof en]: string } = {
  nav: '能力',
  title: '能力总代',
  intro: '组织者注册的每个能力。开关是组织者的门；具体配置仍归各 provider 自己的设置页。',
  loading: '正在读取能力…',
  empty: '当前组合没有注册任何能力。',
  failed: '读取能力列表失败：{message}',
  retry: '重试',
  stateActive: '开',
  stateDisabled: '关',
  stateMissing: '未加载',
  stateFailed: '失败',
  failure: '最近一次失败：{message}',
  missingNote: '配置里有这个能力，但它的插件行没有加载。',
  turnOn: '开启 {name}',
  turnOff: '关闭 {name}',
  openSettings: '打开设置',
  gateNote: '开关只控制组织者门：关闭会立刻从运行中的会话撤销该能力，开启从下一次新建会话开始生效。provider 自己的配置留在它的设置页。',
  updateRefused: '宿主拒绝了这次开关修改。',
  updateFailed: '修改开关失败：{message}',
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
