# 模型提供方插件的数据来源调查

任务单：[task4](mission/task4.md)。结论先行：**运行时模型目录以"写死"为主——`dsh-llm-deepseek` 是源码硬编码表，`dsh-llm-pi-ai` 是 pi-ai 库内置的静态 JSON 目录；两者都允许 settings.yaml 覆盖。网络获取只存在于设置页的 "fetch available models" 辅助动作，且 DeepSeek 官方路由没有注册这个通道。**

## 总览表

| 插件 | 结论 | 运行时目录来源 | 网络获取 |
|---|---|---|---|
| `dsh-llm` | 契约层（不生产数据） | 注册的 adapter 回调 | 仅 `registerModelDiscovery` 通道 |
| `dsh-llm-deepseek` | **写死**（可整表覆盖） | `DEFAULT_MODELS`（src/index.ts:91-112） | 无 |
| `dsh-llm-pi-ai` | **混合** | pi-ai 静态 JSON + settings `models`/`modelOverrides` | 仅设置页对未知路由 `GET /models`（src/discovery.ts:244） |
| `dsh-api-session-controller` | 投影 | `buildModelCatalog` 聚合 `ctx.llm` | 无 |
| `dsh-client-ui-model-selection` | 消费 | `session.modelCatalog()` Remote | 无 |
| `dsh-client-ui-settings-models` | 编辑 + 探测 | `llm`/`settings` Remote，编辑写 settings.yaml | `llm.discoverModels` |
| `dsh-deepseek-llm-api-extensions` / `dsh-plugin-package-inventory-deepseek` | 无目录数据 | — | — |

## 1. 契约层：dsh-llm 不生产目录数据

`ctx.llm`（`LlmRuntime`，packages/llm/llm/src/index.ts:326）的模型目录 API：

- `listModels(provider)`（adapter 侧 src/index.ts:232，默认返回 `[]`）：**advisory** 目录——"catalog membership is advisory, not request validation"（src/index.ts:226-228），请求路由不校验成员资格；
- `resolveModel(provider, model)`（src/index.ts:245）→ `resolveModelInfo()`：返回 `contextWindow`/`defaultMaxTokens`/`reasoning.efforts`；
- `registerModelDiscovery(settingsNs, discover)`（src/index.ts:548）+ `@Remote discoverModels`（src/index.ts:620-638）：**唯一的网络获取通道**，面向设置页的配置草稿探测，结果不入库；
- `registerConfigurableProviders()`：声明可被设置 UI 配置的 provider（携带 settings 命名空间与路径）；
- 事件 `llm/adapters-updated` 经 api-remotes 转发到浏览器。

## 2. dsh-llm-deepseek：写死 + settings 整表覆盖，零网络发现

- 硬编码默认表 `DEFAULT_MODELS`（src/index.ts:91-112），3 条：`deepseek-v4-flash`、`deepseek-v4-pro`、`deepseek-v4-flash-vision-exp`（唯一声明 `inputModalities: ['text','image']` + 像素/字节预算）；常量 `DEFAULT_CONTEXT_WINDOW = 1_000_000`、`DEFAULT_MAX_TOKENS = 256_000`（src/adapter.ts:140-142）；**无 pricing 表**。
- 全包唯一 `fetch` 是 `POST {baseURL}/chat/completions`（src/adapter.ts:643）；**没有 `/models` 请求，也没有调用 `registerModelDiscovery`**——DeepSeek 路由在设置 UI 中不可"fetch available models"。
- 覆盖路径：cordis.yml `Config.models` 或 settings.yaml 的 `llm-deepseek.models` 数组（src/index.ts:138、183），经 `resolveModels()`（src/index.ts:213-279）校验后**整体替换**默认表（无增量 override）。
- 消费侧：`listModels()` 直接返回配置表映射（src/adapter.ts:381-383）；`resolveModel()` 查表，未命中退化为 text-only + 默认容量（src/adapter.ts:393-430）。
- 数据流：`DEFAULT_MODELS` / settings → `resolveAdapterOptions()` → `DeepSeekAdapter.listModels/resolveModel` → `ctx.llm` → Host 投影 → UI。

## 3. dsh-llm-pi-ai：pi-ai 静态目录为底 + settings 覆盖 + 配置态一次性网络探测

- **pi-ai 库本身是静态目录**：`dist/providers/*.models.js` 导入编译期生成的 `data/<provider>.json`（约 37 个 provider，含 cost/contextWindow/maxTokens/compat 全字段，`.manifest.json` 记录生成时间）。pi-ai 有可选 `fetchModels` 动态刷新机制，但**没有任何内置 provider 使用**，dsh-llm-pi-ai 也从不调用——运行时目录完全离线。
- **合并逻辑**（src/catalog.ts:797-908 的 `resolveRouteModels()`）：`models` 为空 → 内置目录原样服务；非空 → 以内置条目为底逐字段覆盖；`modelOverrides` 只允许命中内置目录的 id；手工路由（pi-ai 不认识的 provider）必须自带 `api` + `baseURL` + `models`。
- **唯一网络通道**：`discoverModels()`（src/discovery.ts:195）——已在内置目录的路由直接答内置目录**零网络**（:201-211）；只有未知路由才 `GET {baseURL}/models`（:244，仅 openai 协议，4MiB 上限），结果是"候选元数据"，不落库——settings.yaml 才是唯一事实源。

## 4. Host → UI 链路

- **Host 投影**：`buildModelCatalog()`（api/session-controller/src/catalog.ts:16-67）= `ctx.llm.listProviders()` → 每 provider `listModels()` + 每模型 `resolveModelInfo()`，默认选择来自 `ctx.agentDefaultModel.currentSelection()`；经 `@Remote modelCatalog()` 暴露。
- **模型选择器**（ui-model-selection）：`session.modelCatalog()` Remote 拉取，按 Host generation 缓存；监听 `llm/adapters-updated`、`settings/document-updated`、`credentials/reference-updated` 三事件刷新；`/model` 弹窗与 composer 模型座位共用。
- **设置页**（ui-settings-models）：直连 `settings`/`credentials`/`llm` 三个 Remote；DeepSeek 路由用 `DeepSeekModelsEditor` 策划编辑 `llm-deepseek.models`（id/name/contextWindow/maxTokens 可编辑）；pi-ai 路由用 `ModelListEditor` 编辑 `models` 数组并内嵌 "fetch available models" → `llm.discoverModels`。写入路径：编辑 → settings Remote 写用户层 → Host watcher → `installSettingsSection` onChange → 下一次 `listModels` 生效 → `llm/adapters-updated` → 浏览器刷新。

## 5. settings 层的自定义能力（无需改源码）

- `llm-deepseek.models`：`DeepSeekCatalogModel[]`，整体替换，字段 id/name/description/contextWindow/maxTokens/inputModalities/imagePixelBudget/imageMaxBytes。
- `llm-pi-ai.providers.<route>.models`（整体替换内置目录）与 `.modelOverrides`（按 id 逐字段修正内置条目）；手工路由还能声明 `api`/`baseURL`/`compat`/`reasoningEfforts`。

## 6. 对定制的关键结论

1. 运行时目录的全部事实源是 **(a) `DEFAULT_MODELS` / settings `llm-deepseek.models`** 与 **(b) pi-ai 内置 JSON + settings `models`/`modelOverrides`**——都是静态数据。
2. 网络获取仅存在于设置页 discovery 辅助动作；DeepSeek 官方路由未注册 discovery（缝已存在：`ctx.llm.registerModelDiscovery` + `llm/discoverModels` Remote 即入口）。
3. 契约上 catalog 仅 advisory，请求路由不校验模型成员资格——模型不在目录里也能发请求，只是 UI 不显示、`resolveModelInfo` 退化到默认容量。
4. 若要新增模型：当前最低成本路径是 settings.yaml 的 `llm-deepseek.models` 覆盖或 Models 设置页编辑，零代码改动。

## 7. OpenCode 的对照机制：models.dev

OpenCode 的 provider/模型目录确实来自网络获取（源码：`sst/opencode` 的 `packages/core/src/models-dev.ts`，消费方 `packages/opencode/src/provider/provider.ts` 的 `fromModelsDevProvider`/`fromModelsDevModel`）：

- **URL**：`GET https://models.opencode.ai/api.json`（即 [models.dev](https://models.dev) 的数据；`models.dev/api.json` 同样可用，实测约 4.4MB JSON）。可被环境变量 `OPENCODE_MODELS_URL` 覆盖。
- **数据形状**：`Record<providerId, Provider>`；每个 provider 含 `id`/`env`（所需环境变量名列表）/`npm`（AI SDK 包）/`api`（baseURL）/`name`/`doc`/`models`；每个 model 含 `name`/`family`/`attachment`/`reasoning`/`reasoning_options`/`tool_call`/`structured_output`/`modalities`/`open_weights`/`limit: {context, output}`/`cost: {input, output, cache_read, cache_write}`/`release_date`/`last_updated`。
- **缓存策略**：写到 cache 目录 `models.json`（自定义 source 时按 URL hash 分文件），TTL 5 分钟；跨进程 flock 防并发写；临时文件 + rename 原子发布。
- **降级链**：磁盘缓存 → 编译期内嵌快照（`OPENCODE_MODELS_DEV` 宏）→ `OPENCODE_DISABLE_MODELS_FETCH` 时返回空；`OPENCODE_MODELS_PATH` 可指定本地文件完全替代网络。
- 超时 10s，带自定义 User-Agent。

**对本分支定制的启示**：harness 侧对应的注入点已存在——`ctx.llm.registerModelDiscovery`（设置页探测）与 adapter 的 `listModels`/`resolveModel`（运行时目录）。一个"models.dev 同步插件"可以作为**新增 Provider 插件**：启动时拉取 `api.json`（带磁盘缓存与 TTL），映射为 `LlmModelInfo[]`，写进 settings 的 `llm-deepseek.models` 或直接替换 adapter 的目录来源，全程不碰原生文件。

## 8. api.json 的协议细节覆盖度（对 4.4MB 实物全量扫描，204 provider / 7430 model）

**结论：协议怪癖基本都在数据里**，分布在三处：

### 8.1 协议方言（provider 级 `npm` + model 级 `provider` 覆盖）

- Provider 级字段封闭为 7 个：`id`/`env`（API key 环境变量名）/`npm`（AI SDK 包 = 协议方言）/`api`（baseURL，可含 `${ENV_VAR}` 插值，26 家无此字段）/`name`/`doc`/`models`。**无 headers/options 字段**。
- `npm` 共 30 种取值，**80%（164/204）是 `@ai-sdk/openai-compatible`**；原生方言仅 anthropic(9)/openai(5)/azure(2)/google-vertex/bedrock/cohere 等少数。
- **Model 级 `provider` 字段**（274 个 model）：单模型覆盖协议——keyset 仅 `{npm}` / `{api,npm}` / `{api,npm,shape}` / `{shape}` 四种；**`shape` ∈ `responses` | `completions`**，即 OpenAI Responses API 与 Chat Completions 方言的切换标记。例：`{"npm":"@ai-sdk/openai","api":"...","shape":"responses"}`。

### 8.2 Reasoning 参数形态（model 级 `reasoning_options`，5222 个 model 有）

封闭三种元素类型，可直接映射到 harness 的 `reasoningEfforts` 契约：

- `{"type":"toggle"}`（1188 个）：开/关思考；
- `{"type":"effort","values":[...]}`（2965 个）：枚举池 `none/minimal/low/medium/high/xhigh/max/default`（47 种组合；DeepSeek 是 `toggle`+`high,max`）；
- `{"type":"budget_tokens","min"?,"max"?}`（626 个）：Anthropic 风格的数值预算。

配套字段 `interleaved`（936 个 model）：`{"field":"reasoning_content"}`（856）或 `"reasoning_details"`（15）或裸 `true`（65）——即流式响应里思考内容塞在哪个字段，harness 的 `StreamChunk` 翻译层需要它。

### 8.3 特殊请求参数（model 级 `experimental.modes`，38 个 model）

真正"奇怪的参数"藏在这里：恒为 `{modes: {<mode>: {cost?, provider?}}}`，其中 `provider` 可携带 **`headers`**（如 `anthropic-beta: fast-mode-2026-02-01`）与 **`body` 注入**（如 `{"speed":"fast"}`、`service_tier: "priority"`）。即 beta flag、优先级档位这类非标参数有数据支撑，但仅 38 个 model 使用，且嵌套在 mode 下。

### 8.4 其余字段

- `cost`：`input`/`output` 必有，可选 `cache_read`（4498）/`cache_write`/`reasoning`（148，DeepSeek 即如此）/`input_audio`/`output_audio`/`tiers`（422，超上下文分档定价）/`context_over_200k`（legacy）；
- `limit`：`context`/`output` 必有，`input` 可选（1314）；
- 能力布尔：`attachment`/`reasoning`/`tool_call` 全量，`structured_output`（5052）/`temperature`（6941，boolean 非数值）；
- `modalities`（input/output 数组）、`family`（173 个取值）、`knowledge`、`release_date`/`last_updated`、`open_weights`、`status`（`beta` 74 / `deprecated` 192）。

### 8.5 缺口（数据里没有的）

- **Provider 级自定义 headers / 全局请求体注入**（如某些网关要求的固定 header）——只有 `experimental.modes` 下的 per-model per-mode 形式；
- **参数黑名单**（"某模型不支持 `top_p`"这类负向声明）——只有正向能力布尔；
- **harness 现有契约更窄**：`LlmModelInfo`（dsh-llm/src/types.ts:285）只有 provider/id/name/description/inputModalities，`LlmResolvedModelInfo` 只有 contextWindow/defaultMaxTokens/reasoning.efforts——`cost`、`interleaved`、`shape`、modes 等字段要利用，需扩展契约或在定制插件内私有消费。

### 8.6 其他可用端点

`models.dev` 还提供：`/models.json`（provider 无关的模型元数据）、`/catalog.json`（两者合并）、`/logos/{provider}.svg`（provider 图标）。源数据在 `sst/models.dev` 仓库以 TOML 维护（`providers/<id>/provider.toml` + `models/*.toml`），CI 校验 schema。
