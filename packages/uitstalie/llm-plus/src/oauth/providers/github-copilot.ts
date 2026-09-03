/**
 * github-copilot OAuth：GitHub device-code 换 GitHub access token，再经
 * copilot_internal/v2/token 换成 Copilot session token（短寿命，靠 refresh
 * 轮换）；登录后启用已知模型的 policy 并枚举可用模型。
 * 移植 pi-ai 的 github-copilot.js（模型枚举的 picker/policy 语义保留）。
 *
 * @module @deepseek-ai/dsh-llm-plus/oauth/providers/github-copilot
 */

import { pollDeviceCode } from '../device-code.ts'
import { trustedHttpUrl } from '../http.ts'
import type { DeviceAuthorization, OAuthInteraction, OAuthProviderDef, PlusOAuthCredential } from '../types.ts'

const CLIENT_ID = atob('SXYxLmI1MDdhMDhjODdlY2ZlOTg=')
const COPILOT_HEADERS = {
  'User-Agent': 'GitHubCopilotChat/0.35.0',
  'Editor-Version': 'vscode/1.107.0',
  'Editor-Plugin-Version': 'copilot-chat/0.35.0',
  'Copilot-Integration-Id': 'vscode-chat',
}
const COPILOT_API_VERSION = '2026-06-01'
const POLICY_CONCURRENCY = 4

/** Copilot 已知模型（登录后逐个启用 policy；清单来自 pi-ai 的 github-copilot.models.js）。 */
const KNOWN_MODEL_IDS = [
  'gpt-4o', 'gpt-4.1', 'gpt-5', 'gpt-5-mini', 'gpt-5-codex',
  'o3', 'o4-mini', 'codex-mini-latest',
  'claude-sonnet-4', 'claude-sonnet-4.5', 'claude-opus-4.1', 'claude-haiku-4.5',
  'gemini-2.0-flash-001', 'gemini-2.5-pro',
  'grok-code-fast-1',
]

/** 规范化企业域名输入（空白/非法按 undefined 处理）。 */
function normalizeDomain(input: string): string | undefined {
  const trimmed = input.trim()
  if (!trimmed) return undefined
  try {
    const url = trimmed.includes('://') ? new URL(trimmed) : new URL(`https://${trimmed}`)
    return url.hostname
  } catch {
    return undefined
  }
}

/** 域名 → 三个端点。 */
function getUrls(domain: string): { deviceCodeUrl: string; accessTokenUrl: string; copilotTokenUrl: string } {
  return {
    deviceCodeUrl: `https://${domain}/login/device/code`,
    accessTokenUrl: `https://${domain}/login/oauth/access_token`,
    copilotTokenUrl: `https://api.${domain}/copilot_internal/v2/token`,
  }
}

/**
 * 从 Copilot token 的 proxy-ep 解析 API base URL
 * （token 形如 tid=...;exp=...;proxy-ep=proxy.individual.githubcopilot.com;...）。
 */
function baseUrlFromToken(token: string, enterpriseDomain?: string): string {
  const match = /proxy-ep=([^;]+)/.exec(token)
  if (match?.[1] !== undefined) return `https://${match[1].replace(/^proxy\./, 'api.')}`
  if (enterpriseDomain !== undefined) return `https://copilot-api.${enterpriseDomain}`
  return 'https://api.individual.githubcopilot.com'
}

/** JSON GET（非 2xx 抛带状态码的错）。 */
async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, init)
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`${response.status} ${response.statusText}: ${text}`)
  }
  return response.json()
}

/** 模型清单条目的读取形状（只取我们消费的字段）。 */
interface CopilotModelEntry {
  id?: unknown
  capabilities?: { supports?: { tool_calls?: boolean } }
  model_picker_enabled?: boolean
  policy?: { state?: string }
}

/** 枚举账号可用的模型 id（picker 优先；individual 端点允许 policy 兜底）。 */
async function fetchAvailableModelIds(copilotToken: string, enterpriseDomain: string | undefined, signal: AbortSignal): Promise<string[]> {
  const baseUrl = baseUrlFromToken(copilotToken, enterpriseDomain)
  const raw = await fetchJson(`${baseUrl}/models`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${copilotToken}`,
      ...COPILOT_HEADERS,
      'X-GitHub-Api-Version': COPILOT_API_VERSION,
    },
    signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
  })
  const data = (raw as { data?: unknown[] } | null)?.data
  if (!Array.isArray(data)) throw new Error('Invalid Copilot models response')
  const pickerIds: string[] = []
  const policyEnabledIds: string[] = []
  for (const rawItem of data) {
    const item = rawItem as CopilotModelEntry | null
    const id = item?.id
    if (!item || typeof id !== 'string') continue
    if (item.capabilities?.supports?.tool_calls === false) continue
    if (item.model_picker_enabled === true && item.policy?.state !== 'disabled') pickerIds.push(id)
    if (item.policy?.state === 'enabled') policyEnabledIds.push(id)
  }
  const allowPolicyFallback = baseUrl === 'https://api.individual.githubcopilot.com'
  return pickerIds.length > 0 || !allowPolicyFallback ? pickerIds : policyEnabledIds
}

/** 启用一个模型的 policy（部分模型要先接受条款才可用；失败静默为不可用）。 */
async function enableModel(token: string, modelId: string, enterpriseDomain: string | undefined, signal: AbortSignal): Promise<void> {
  const baseUrl = baseUrlFromToken(token, enterpriseDomain)
  try {
    await fetch(`${baseUrl}/models/${modelId}/policy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...COPILOT_HEADERS,
        'openai-intent': 'chat-policy',
        'x-interaction-type': 'chat-policy',
      },
      body: JSON.stringify({ state: 'enabled' }),
      signal,
    })
  } catch (error) {
    if (signal.aborted) throw error
    // 单模型启用失败不阻断登录
  }
}

/** 起点：GitHub device code（响应字段不齐/URL 不可信即抛）。 */
async function startDeviceFlow(domain: string, signal: AbortSignal): Promise<DeviceAuthorization> {
  const data = await fetchJson(getUrls(domain).deviceCodeUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'GitHubCopilotChat/0.35.0',
    },
    body: new URLSearchParams({ client_id: CLIENT_ID, scope: 'read:user' }).toString(),
    signal,
  }) as Record<string, unknown>
  const deviceCode = data['device_code']
  const userCode = data['user_code']
  const verificationUri = trustedHttpUrl(data['verification_uri'])
  const expiresIn = data['expires_in']
  if (typeof deviceCode !== 'string' || typeof userCode !== 'string'
    || verificationUri === undefined || typeof expiresIn !== 'number') {
    throw new Error('Invalid device code response fields')
  }
  const interval = data['interval']
  return {
    deviceCode,
    userCode,
    verificationUri,
    ...(typeof interval === 'number' ? { intervalSeconds: interval } : {}),
    expiresInSeconds: expiresIn,
  }
}

/** 轮询换 GitHub access token。 */
async function pollForGitHubAccessToken(domain: string, device: DeviceAuthorization, signal: AbortSignal): Promise<string> {
  return pollDeviceCode({
    device,
    signal,
    waitBeforeFirstPoll: true,
    poll: async () => {
      const raw = await fetchJson(getUrls(domain).accessTokenUrl, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'GitHubCopilotChat/0.35.0',
        },
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          device_code: device.deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }).toString(),
        signal,
      }) as Record<string, unknown>
      if (typeof raw['access_token'] === 'string') return { status: 'complete', value: raw['access_token'] }
      if (typeof raw['error'] === 'string') {
        const error = raw['error']
        const description = typeof raw['error_description'] === 'string' ? `: ${raw['error_description']}` : ''
        if (error === 'authorization_pending') return { status: 'pending' }
        if (error === 'slow_down') {
          const interval = raw['interval']
          return { status: 'slow_down', ...(typeof interval === 'number' ? { intervalSeconds: interval } : {}) }
        }
        return { status: 'failed', message: `Device flow failed: ${error}${description}` }
      }
      return { status: 'failed', message: 'Invalid device token response' }
    },
  })
}

/** GitHub access token → Copilot session token（过期时刻留 5 分钟提前量）。 */
async function exchangeCopilotToken(
  githubAccessToken: string,
  enterpriseDomain: string | undefined,
  signal: AbortSignal,
): Promise<PlusOAuthCredential> {
  const domain = enterpriseDomain ?? 'github.com'
  const raw = await fetchJson(getUrls(domain).copilotTokenUrl, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${githubAccessToken}`,
      ...COPILOT_HEADERS,
    },
    signal,
  }) as Record<string, unknown>
  const token = raw['token']
  const expiresAt = raw['expires_at']
  if (typeof token !== 'string' || typeof expiresAt !== 'number') {
    throw new Error('Invalid Copilot token response fields')
  }
  return {
    type: 'oauth',
    refresh: githubAccessToken,
    access: token,
    expires: expiresAt * 1000 - 5 * 60 * 1000,
    ...(enterpriseDomain === undefined ? {} : { enterpriseUrl: enterpriseDomain }),
  }
}

/** 刷新时用存储凭据里的企业域名。 */
function credentialDomain(credential: PlusOAuthCredential): string | undefined {
  return credential.enterpriseUrl === undefined ? undefined : normalizeDomain(credential.enterpriseUrl)
}

/** github-copilot 的 OAuth 行为定义。 */
export const githubCopilotOAuth: OAuthProviderDef = {
  id: 'github-copilot',
  loginLabel: 'Sign in with GitHub Copilot',
  login: async (interaction: OAuthInteraction) => {
    const input = await interaction.prompt({
      kind: 'text',
      message: 'GitHub Enterprise URL/domain (blank for github.com)',
      placeholder: 'company.ghe.com',
    })
    if (interaction.signal.aborted) throw new Error('Login cancelled')
    const enterpriseDomain = normalizeDomain(input)
    if (input.trim() !== '' && enterpriseDomain === undefined) {
      throw new Error('Invalid GitHub Enterprise URL/domain')
    }
    const domain = enterpriseDomain ?? 'github.com'
    const device = await startDeviceFlow(domain, interaction.signal)
    interaction.notify({
      message: 'Open the verification page and enter the code to sign in to GitHub.',
      url: device.verificationUriComplete ?? device.verificationUri,
      code: device.userCode,
    })
    const githubAccessToken = await pollForGitHubAccessToken(domain, device, interaction.signal)
    const credentials = await exchangeCopilotToken(githubAccessToken, enterpriseDomain, interaction.signal)
    interaction.notify({ message: 'Enabling models…' })
    // 登录后启用已知模型的 policy（并发 4），再枚举可用模型清单
    for (let index = 0; index < KNOWN_MODEL_IDS.length; index += POLICY_CONCURRENCY) {
      await Promise.all(KNOWN_MODEL_IDS.slice(index, index + POLICY_CONCURRENCY)
        .map(modelId => enableModel(credentials.access, modelId, enterpriseDomain, interaction.signal)))
    }
    return {
      ...credentials,
      availableModelIds: await fetchAvailableModelIds(credentials.access, enterpriseDomain, interaction.signal),
    }
  },
  refresh: async (credential, signal) => {
    const domain = credentialDomain(credential)
    const refreshed = await exchangeCopilotToken(credential.refresh, domain, signal)
    return {
      ...refreshed,
      availableModelIds: await fetchAvailableModelIds(refreshed.access, domain, signal),
    }
  },
  toAuth: credential => ({
    apiKey: credential.access,
    baseURL: baseUrlFromToken(credential.access, credentialDomain(credential)),
  }),
}
