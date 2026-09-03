/**
 * llm-plus OAuth Remote 面的 wire 数据形状（纯数据接口，无逻辑）。
 * Typert 契约：边界类型必须从公开的非根 type 子路径导出（本文件即该子路径）。
 *
 * @module @deepseek-ai/dsh-llm-plus/types
 */

/** 一条带 OAuth 能力的路由在页面上的行。 */
export interface OAuthRouteInfo {
  /** 路由 id。 */
  routeId: string
  /** flow id（六家之一）。 */
  flow: string
  /** 登录按钮文案。 */
  label: string
  /** 是否已有可用凭据（grant 在库）。 */
  configured: boolean
}

/** 一次登录尝试的通知条目（页面渲染 url 为链接、code 为大字）。 */
export interface AttemptNoticeView {
  /** 消息文本。 */
  message: string
  /** 相关 URL（授权页/验证页）。 */
  url?: string
  /** 设备码/用户码。 */
  code?: string
}

/** 待答 prompt 的页面视图。 */
export interface AttemptPromptView {
  /** prompt id（submitPromptAnswer 的回答地址）。 */
  promptId: string
  /** 展示形态。 */
  kind: 'text' | 'secret' | 'select'
  /** 问题文本。 */
  message: string
  /** 输入占位符。 */
  placeholder?: string
  /** select 的选项。 */
  options?: readonly { id: string; label: string }[]
}

/** 一次登录尝试的完整页面视图（轮询桥的载荷）。 */
export interface AttemptView {
  /** 尝试 id。 */
  id: string
  /** 所属路由。 */
  routeId: string
  /** 状态（终态：authorized/failed/cancelled）。 */
  status: 'running' | 'authorized' | 'failed' | 'cancelled'
  /** 已到达的通知（按到达顺序）。 */
  notices: AttemptNoticeView[]
  /** 待答的 prompt（无则缺席）。 */
  pendingPrompt?: AttemptPromptView
  /** 终态为 failed 时的错误消息。 */
  error?: string
}
