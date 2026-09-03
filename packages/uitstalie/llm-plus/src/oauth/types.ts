/**
 * llm-plus OAuth 的数据形状（纯数据接口，无逻辑）。
 *
 * 凭据持久化在 credentials seam：key = credentialKey('llm-plus', routeId)，
 * 记录为 {kind:'grant', payload: PlusOAuthCredential}（对齐 pi-ai 的记录
 * 词汇；payload 对 seam 是 opaque JSON）。
 *
 * @module @deepseek-ai/dsh-llm-plus/oauth/types
 */

import type { AuthorizationNotice, AuthorizationPrompt } from '@deepseek-ai/dsh-authorization'

/** 存储的 OAuth 凭据（路由级，随刷新轮换）。 */
export interface PlusOAuthCredential {
  /** 固定判别字段。 */
  type: 'oauth'
  /** access token（Bearer 值）。 */
  access: string
  /** refresh token（部分 provider 刷新时不轮换，沿用旧值）。 */
  refresh: string
  /** 过期时刻（epoch ms，已含刷新提前量）。 */
  expires: number
  /** GitHub Enterprise 域名（github-copilot 专用）。 */
  enterpriseUrl?: string
  /** Copilot 的可用模型白名单（登录时枚举；空 = 未知）。 */
  availableModelIds?: string[]
  /** Codex 的 chatgpt_account_id（从 access token 的 JWT 解析）。 */
  accountId?: string
}

/** RFC 8628 device authorization 起点响应的标准化形状。 */
export interface DeviceAuthorization {
  /** 轮询用的设备码。 */
  deviceCode: string
  /** 用户输入用的人类可读码。 */
  userCode: string
  /** 验证页 URL（已校验 http/https）。 */
  verificationUri: string
  /** 带码直跳 URL（有则优先展示）。 */
  verificationUriComplete?: string
  /** 服务端建议的轮询间隔（秒）。 */
  intervalSeconds?: number
  /** 设备码有效期（秒）。 */
  expiresInSeconds?: number
}

/**
 * flow 交互面：authorization seam 的 AuthorizationSession 词汇
 * （notify/prompt/signal 直接用缝的 wire 类型），flow 实现只面向它
 * （单测可直造）。
 */
export interface OAuthInteraction {
  /** 取消信号（用户取消 / fiber 摘除 / 超时）。 */
  signal: AbortSignal
  /** 进度通知（device code 的 url+code 走这里到 UI）。 */
  notify(notice: AuthorizationNotice): void
  /** 提问（手贴 code / 企业域名 / 方式选择）；拒绝时 reject。 */
  prompt(prompt: AuthorizationPrompt): Promise<string>
}

/** 请求认证推导结果（Bearer 值 + 可选的凭据级 baseURL 覆盖）。 */
export interface OAuthRequestAuth {
  /** Authorization: Bearer 的值。 */
  apiKey: string
  /** 凭据级端点覆盖（github-copilot 从 token 的 proxy-ep 解析）。 */
  baseURL?: string
}

/**
 * 一个 provider 的 OAuth 行为定义（数据 + 行为的组合）。
 * 六家有固定端点：anthropic/openrouter/openai-codex 为 PKCE（codex 另有
 * device-code 备选），github-copilot/kimi-coding/xai 为 device-code。
 * radius 是动态构造（无端点常量），不在表内。
 */
export interface OAuthProviderDef {
  /** 配置里的 flow id（路由 oauth 字段值，如 'kimi-coding'）。 */
  id: string
  /** 登录按钮/flow 注册文案。 */
  loginLabel: string
  /** 执行登录：驱动交互面直到拿到成品凭据。 */
  login(interaction: OAuthInteraction): Promise<PlusOAuthCredential>
  /**
   * 刷新：用旧凭据换新的。401/403/invalid_grant = 凭据已死，抛错
   * （调用方清记录并要求重登）；429/5xx 是可重试故障。
   */
  refresh(credential: PlusOAuthCredential, signal: AbortSignal): Promise<PlusOAuthCredential>
  /** 推导请求认证。 */
  toAuth(credential: PlusOAuthCredential): OAuthRequestAuth
}
