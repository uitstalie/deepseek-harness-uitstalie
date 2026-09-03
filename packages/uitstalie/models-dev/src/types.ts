/**
 * models-dev 的 Remote 边界类型（@Remote 方法的 wire 载荷）。
 * Typert 契约：边界类型必须从一个公开的非根 type 子路径导出
 * （dsh-llm 的 ./types 同款）；本文件只放类型，不放运行时代码。
 *
 * @module @deepseek-ai/dsh-models-dev/types
 */

/**
 * 目录提供商摘要（@Remote 查询面；models.dev 设置页的列表行）。
 * 字段全部是 JSON 纯数据，协议方言（npm）与端点（api）是物化路由时的
 * 默认协议与默认 baseURL 来源。
 */
export interface CatalogProviderSummary {
  /** models.dev provider id（如 "deepseek"）。 */
  id: string
  /** 显示名。 */
  name?: string
  /** 协议方言（AI SDK 包名，如 "@ai-sdk/openai-compatible"）。 */
  npm?: string
  /** 目录给的 baseURL（可含 ${ENV_VAR} 插值）。 */
  api?: string
  /** 认证所需的环境变量名数组（目录自报；apiKeyRef 的默认值来源）。 */
  env?: string[]
  /** 该提供商的模型数。 */
  modelCount: number
}

/**
 * 目录模型摘要（@Remote 查询面；设置页的模型子集勾选行）。
 */
export interface CatalogModelSummary {
  /** 模型 id。 */
  id: string
  /** 显示名。 */
  name?: string
  /** 上下文窗口（token）。 */
  contextWindow?: number
  /** 最大输出 token。 */
  maxTokens?: number
  /** 输入模态（如 ["text","image"]）。 */
  inputModalities?: string[]
  /** 是否支持思考。 */
  reasoning?: boolean
}
