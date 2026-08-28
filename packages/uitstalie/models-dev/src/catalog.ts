/**
 * models.dev `api.json` 数据形状、边界校验与映射辅助。
 *
 * 数据集来自网络/文件边界，不可信任，因此 `parseCatalog` 会校验本包实际
 * 读取的字段，丢弃畸形条目而不是整体失败。未列出的字段原样透传（不检查）。
 *
 * 数据结构总览（对照 goal/model-provider-data-source.md 第 8 节）：
 * - 顶层：`Record<providerId, ModelsDevProvider>`（实测 204 个 provider）
 * - provider 级字段封闭为 7 个：id/env/npm/api/name/doc/models
 *   - `npm` 即协议方言（约 80% 是 `@ai-sdk/openai-compatible`）
 *   - `api` 是 baseURL，可含 `${ENV_VAR}` 插值
 * - model 级约 22 个字段，其中协议怪癖在两处：
 *   - `provider`：单模型覆盖 npm/api/shape（shape ∈ responses|completions）
 *   - `experimental.modes.<mode>.provider`：headers（beta flag）+ body 注入
 *
 * @module @deepseek-ai/dsh-models-dev/catalog
 */

/**
 * 无损 JSON 值（与请求体兼容的递归类型）。
 * 用于 extraParams 的 body 字段值，保证最终能 JSON.stringify 进请求体。
 */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/**
 * 数据集中一个模型的 reasoning 控制项（`reasoning_options` 数组的元素）。
 * 实测只有三种 type：
 * - `toggle`：开/关思考（1188 个 model），元素只有 type 字段
 * - `effort`：枚举档位（2965 个），带 values 数组（枚举池
 *   none/minimal/low/medium/high/xhigh/max/default）
 * - `budget_tokens`：数值预算（626 个，Anthropic 风格），可选 min/max
 * 注意约 1223 个 model 的 reasoning_options 是空数组 []。
 */
export interface ModelsDevReasoningOption {
  /** 控制项类型；`(string & {})` 保留未来新类型的透传能力。 */
  type: 'toggle' | 'effort' | 'budget_tokens' | (string & {})
  /** effort 档位的枚举值列表，仅 type=effort 时出现。 */
  values?: string[]
  /** budget_tokens 的下界（token 数），可选。 */
  min?: number
  /** budget_tokens 的上界（token 数），可选。 */
  max?: number
}

/**
 * `experimental.modes.<mode>.provider` 的形态：某模式下的协议覆盖。
 * 这是数据集里"奇怪参数"的真正载体（实测仅 38 个 model 使用）。
 * 典型例子：orcarouter 的 Claude 模型 fast 模式——
 * headers: {"anthropic-beta": "fast-mode-2026-02-01"}，body: {"speed": "fast"}。
 */
export interface ModelsDevModeProvider {
  /** 额外 HTTP 头（如 anthropic-beta beta flag）。 */
  headers?: Record<string, string>
  /** 额外顶层请求体字段（如 {"speed":"fast"}、service_tier）。 */
  body?: Record<string, JsonValue>
}

/**
 * 数据集中一个模型条目。字段全部实测自 api.json（7430 个 model 的扫描结果）；
 * 只有 id 是校验强制的，其余字段缺失表示"未知"而不是默认值。
 */
export interface ModelsDevModel {
  /** 模型 id（必填，校验强制；如 "deepseek-v4-flash"）。 */
  id: string
  /** 显示名（如 "DeepSeek V4 Flash"）。 */
  name?: string
  /** 一句话描述。 */
  description?: string
  /** 模型族（173 个取值，如 deepseek-flash / claude-opus / gpt）。 */
  family?: string
  /** 是否支持附件/多模态输入。 */
  attachment?: boolean
  /** 是否支持 reasoning/思考。 */
  reasoning?: boolean
  /** reasoning 控制项列表，结构见 ModelsDevReasoningOption。 */
  reasoning_options?: ModelsDevReasoningOption[]
  /** 是否支持工具调用。 */
  tool_call?: boolean
  /** 是否支持结构化输出特性。 */
  structured_output?: boolean
  /** 是否支持 temperature 控制（注意是 boolean 不是数值）。 */
  temperature?: boolean
  /** 知识截止（"YYYY-MM" 格式，如 "2025-05"）。 */
  knowledge?: string
  /** 首次公开发布日期（"YYYY-MM-DD"）。 */
  release_date?: string
  /** 最近更新日期。 */
  last_updated?: string
  /** 输入/输出模态，如 {input:["text","image"], output:["text"]}。 */
  modalities?: { input?: string[]; output?: string[] }
  /** 权重是否公开。 */
  open_weights?: boolean
  /** token 上限：context=上下文窗口（必有），output=最大输出（必有），input=最大输入（1314 个 model 有）。 */
  limit?: { context?: number; output?: number; input?: number }
  /**
   * 价格（每百万 token 美元）：input/output 必有，可选 cache_read/cache_write/
   * reasoning（DeepSeek 的 reasoning token 单独计价）/input_audio/output_audio/
   * tiers（超上下文分档定价，数组）/context_over_200k（legacy 写法）。
   */
  cost?: {
    input?: number
    output?: number
    cache_read?: number
    cache_write?: number
    reasoning?: number
    [key: string]: unknown
  }
  /** 生命周期状态：实测取值 beta(74)/deprecated(192)，schema 还允许 alpha。 */
  status?: 'alpha' | 'beta' | 'deprecated' | (string & {})
  /**
   * 交错思考字段：流式响应里思考内容塞在哪个字段。
   * 对象形式 field ∈ "reasoning_content"(856) | "reasoning_details"(15)；
   * 裸 true(65) 表示支持但未指明字段。
   */
  interleaved?: boolean | { field?: string }
  /**
   * 单模型协议覆盖（274 个 model 有）：keyset 仅 {npm}/{api,npm}/{api,npm,shape}/{shape}。
   * shape ∈ "responses"|"completions" 即 OpenAI Responses API 与 Chat Completions 方言切换。
   */
  provider?: { npm?: string; api?: string; shape?: 'responses' | 'completions' | (string & {}) }
  /** 实验模式表：{modes: {<mode>: {cost?, provider?}}}，协议怪癖见 ModelsDevModeProvider。 */
  experimental?: { modes?: Record<string, { cost?: ModelsDevModel['cost']; provider?: ModelsDevModeProvider }> }
}

/**
 * 数据集中一个 provider 条目。字段封闭为 7 个（实测无 headers/options/region）。
 */
export interface ModelsDevProvider {
  /** provider id（与外层 Record 键一致；校验时以键兜底）。 */
  id: string
  /** 显示名。 */
  name?: string
  /** 认证所需的环境变量名数组（如 ["DEEPSEEK_API_KEY"]），长度 1-4。 */
  env?: string[]
  /** AI SDK 包名 = 协议方言；约 80% 是 "@ai-sdk/openai-compatible"。 */
  npm?: string
  /** Base URL，可含 ${ENV_VAR} 插值；26 家无此字段（如 anthropic、google 用 SDK 默认端点）。 */
  api?: string
  /** 文档/定价页 URL。 */
  doc?: string
  /** 模型表：modelId → ModelsDevModel。 */
  models: Record<string, ModelsDevModel>
}

/** 整个 api.json 载荷：provider id → provider 条目。 */
export type ModelsDevCatalogData = Record<string, ModelsDevProvider>

/**
 * 额外请求参数：本包拥有的用户侧写入位置。
 * headers 与 body 分开，因为它们的注入路径不同（body 可经
 * deepseekLlmApiExtensions 缝注入，headers 目前没有缝——见 goal/models-dev-plugin.md）。
 */
export interface ExtraParams {
  /** 额外 HTTP 头。 */
  headers?: Record<string, string>
  /** 额外顶层请求体字段（key = 顶层字段名，value = 任意 JSON 值）。 */
  body?: Record<string, JsonValue>
}

/**
 * 从数据集条目映射出的 harness 形状默认值。
 * 命名对齐 harness 侧契约（LlmResolvedModelInfo 的 contextWindow/maxTokens/
 * reasoning.efforts），使消费方不需要懂 models.dev 的字段名。
 */
export interface ModelDefaults {
  /** 上下文窗口（token），来自 limit.context。 */
  contextWindow?: number
  /** 最大输入 token，来自 limit.input（仅部分 model 有）。 */
  maxInputTokens?: number
  /** 最大输出 token，来自 limit.output。 */
  maxTokens?: number
  /** 输入模态列表（如 ["text","image"]）。 */
  inputModalities?: string[]
  /** 输出模态列表。 */
  outputModalities?: string[]
  /** reasoning effort 档位枚举，从 reasoning_options 的 effort 项扁平化而来。 */
  reasoningEfforts?: string[]
  /** 是否支持思考开关（toggle）。 */
  reasoningToggle?: boolean
  /** reasoning 数值预算范围（budget_tokens）。 */
  reasoningBudget?: { min?: number; max?: number }
  /** 是否支持工具调用。 */
  toolCall?: boolean
  /** 是否支持结构化输出。 */
  structuredOutput?: boolean
  /** 交错思考字段名（reasoning_content / reasoning_details）。 */
  interleavedField?: string
  /** 协议方言提示（AI SDK 包名）；model 级覆盖优先于 provider 级。 */
  npm?: string
  /** responses/completions 方言切换（仅当 model 覆盖 provider 默认时出现）。 */
  shape?: string
  /** 生命周期状态（beta/deprecated 等）。 */
  status?: string
  /** 价格表（原样透传数据集形状）。 */
  cost?: ModelsDevModel['cost']
}

/**
 * 判定未知值是否为非空对象（且非数组）。
 * 数据集校验的基础谓词，所有字段检查都建立在它之上。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把未知值收窄为 string[]；任一元素非字符串则整体返回 undefined
 * （宁缺勿滥：modalities 错误比缺失更危险，会导致 UI/路由误判能力）。
 */
function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value.filter((item): item is string => typeof item === 'string')
  return out.length === value.length ? out : undefined
}

/** 把未知值收窄为有限 number；否则 undefined。 */
function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 在边界校验一个数据集模型条目。
 *
 * 策略：整体透传 + 关键字段重校验。`id` 必须是非空字符串（否则整条丢弃）；
 * `limit` 的三个数字与 `modalities` 的两个数组重新收窄（数据集历史上
 * 出现过脏值，这两个字段会被 harness 消费方直接拿去算容量和能力）；
 * 这两个字段存在但不是对象时直接删除（类型撒谎比缺失更危险）。
 *
 * @param raw - 未校验的条目。
 * @returns 收窄后的条目；essential 字段畸形时返回 undefined（由调用方丢弃）。
 */
export function validateModel(raw: unknown): ModelsDevModel | undefined {
  if (!isRecord(raw)) return undefined
  if (typeof raw.id !== 'string' || raw.id.length === 0) return undefined
  // 先整体透传（保留本包不识别的字段，如未来新增能力字段），再覆盖重校验字段
  const model: ModelsDevModel = { ...raw, id: raw.id } as ModelsDevModel
  if (raw.limit !== undefined) {
    if (!isRecord(raw.limit)) {
      delete model.limit
    } else {
      // exactOptionalPropertyTypes 下不能直接塞 undefined；先收窄到局部常量再条件展开
      const context = asNumber(raw.limit.context)
      const output = asNumber(raw.limit.output)
      const input = asNumber(raw.limit.input)
      model.limit = {
        ...(context === undefined ? {} : { context }),
        ...(output === undefined ? {} : { output }),
        ...(input === undefined ? {} : { input }),
      }
    }
  }
  if (raw.modalities !== undefined) {
    if (!isRecord(raw.modalities)) {
      delete model.modalities
    } else {
      const input = asStringArray(raw.modalities.input)
      const output = asStringArray(raw.modalities.output)
      // 两个数组都收窄失败时删除整个字段，不给模型凭空造一个空 modalities
      if (input === undefined && output === undefined) delete model.modalities
      else model.modalities = { ...(input === undefined ? {} : { input }), ...(output === undefined ? {} : { output }) }
    }
  }
  return model
}

/**
 * 解析并校验一份 api.json 载荷。
 *
 * 容错策略：JSON 语法错误或顶层不是对象 → 抛 SyntaxError（整份不可用，
 * 调用方会回退到缓存）；单个 provider/model 条目畸形 → 丢弃该条目并经
 * onDrop 报告，其余条目照常服务。这保证数据集里一个坏条目不会让全目录瘫痪。
 *
 * @param text - 来自网络或磁盘的原始 JSON 文本。
 * @param onDrop - 每个被丢弃的 provider/model 条目收到一条诊断（用于日志）。
 * @returns 校验后的目录。
 * @throws {SyntaxError} 载荷不是 JSON 或顶层不是 provider 对象表。
 */
export function parseCatalog(text: string, onDrop?: (entry: string, reason: string) => void): ModelsDevCatalogData {
  const raw: unknown = JSON.parse(text)
  if (!isRecord(raw)) throw new SyntaxError('models.dev catalog: top-level payload must be an object of providers')
  // null-prototype：provider id 来自外部数据，避免 "__proto__" 这类键污染
  const data: ModelsDevCatalogData = Object.create(null)
  for (const [providerId, providerRaw] of Object.entries(raw)) {
    if (!isRecord(providerRaw) || !isRecord(providerRaw.models)) {
      onDrop?.(providerId, 'provider entry must be an object with a models map')
      continue
    }
    const models: Record<string, ModelsDevModel> = Object.create(null)
    for (const [modelId, modelRaw] of Object.entries(providerRaw.models)) {
      const model = validateModel(modelRaw)
      if (model === undefined) {
        onDrop?.(`${providerId}/${modelId}`, 'model entry must be an object with a string id')
        continue
      }
      models[modelId] = model
    }
    data[providerId] = {
      ...(providerRaw as unknown as ModelsDevProvider),
      // provider.id 缺失时以外层键兜底（数据集规范上两者一致）
      id: typeof providerRaw.id === 'string' ? providerRaw.id : providerId,
      models,
    }
  }
  return data
}

/**
 * 把一个数据集模型（连同其 provider 的协议方言）映射为 harness 形状默认值。
 *
 * 只做"翻译"不做"猜测"：缺失字段保持缺失（undefined），消费方据此区分
 * "未知"与"默认值"。reasoning_options 的三种形态被压平成
 * reasoningEfforts / reasoningToggle / reasoningBudget 三个独立字段。
 *
 * @param model - 校验后的数据集条目。
 * @param providerNpm - 所属 provider 的 npm 方言，model 未覆盖时作为兜底。
 * @returns 映射结果；缺失字段表示"未知"，绝不猜测。
 */
export function modelDefaults(model: ModelsDevModel, providerNpm?: string): ModelDefaults {
  const efforts: string[] = []
  let reasoningBudget: { min?: number; max?: number } | undefined
  let reasoningToggle = false
  for (const option of model.reasoning_options ?? []) {
    if (option.type === 'effort' && option.values) efforts.push(...option.values)
    else if (option.type === 'toggle') reasoningToggle = true
    else if (option.type === 'budget_tokens') {
      reasoningBudget = {
        ...(option.min === undefined ? {} : { min: option.min }),
        ...(option.max === undefined ? {} : { max: option.max }),
      }
    }
  }
  const npm = model.provider?.npm ?? providerNpm
  return {
    ...(model.limit?.context === undefined ? {} : { contextWindow: model.limit.context }),
    ...(model.limit?.output === undefined ? {} : { maxTokens: model.limit.output }),
    ...(model.limit?.input === undefined ? {} : { maxInputTokens: model.limit.input }),
    ...(model.modalities?.input === undefined ? {} : { inputModalities: [...model.modalities.input] }),
    ...(model.modalities?.output === undefined ? {} : { outputModalities: [...model.modalities.output] }),
    ...(efforts.length === 0 ? {} : { reasoningEfforts: efforts }),
    ...(reasoningToggle ? { reasoningToggle } : {}),
    ...(reasoningBudget === undefined ? {} : { reasoningBudget }),
    ...(model.tool_call === undefined ? {} : { toolCall: model.tool_call }),
    ...(model.structured_output === undefined ? {} : { structuredOutput: model.structured_output }),
    // interleaved 裸 true 时按数据集的绝对多数约定落到 reasoning_content
    ...(typeof model.interleaved === 'object' && model.interleaved.field
      ? { interleavedField: model.interleaved.field }
      : model.interleaved === true ? { interleavedField: 'reasoning_content' } : {}),
    ...(npm === undefined ? {} : { npm }),
    ...(model.provider?.shape === undefined ? {} : { shape: model.provider.shape }),
    ...(model.status === undefined ? {} : { status: model.status }),
    ...(model.cost === undefined ? {} : { cost: model.cost }),
  }
}

/**
 * 合并两份 extra params；override 按 key 取胜。
 * headers 与 body 分别做浅合并（key 级覆盖），不做深合并——
 * body 值是用户声明的完整字段值，深合并会制造出乎意料的半成品对象。
 */
export function mergeExtraParams(base: ExtraParams, override: ExtraParams): ExtraParams {
  return {
    ...(base.headers || override.headers ? { headers: { ...base.headers, ...override.headers } } : {}),
    ...(base.body || override.body ? { body: { ...base.body, ...override.body } } : {}),
  }
}
