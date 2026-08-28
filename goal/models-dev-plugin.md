# models-dev 插件：设计与使用

任务单：[task5](mission/task5.md)。第一个定制落地：models.dev 目录同步插件，包位于 `packages/uitstalie/models-dev/`（`@deepseek-ai/dsh-models-dev`）。

## 提供什么

**主入口（Service 类插件，默认导出 `ModelsDevCatalog`）**——注册 `ctx.modelsDev`：

- **目录同步**：启动时拉取 models.dev `api.json`（默认 `https://models.dev/api.json`，`file://` 可读磁盘），opencode 式磁盘缓存（默认 `~/.dsh/cache/models-dev.json`）+ TTL（默认 1h）：缓存新鲜零网络；拉取失败回退陈旧缓存；都无则空目录服务不阻塞启动。`refresh()` 强制重拉（并发共享、失败保留当前目录）。
- **查询**：`listProviders()` / `getProvider(id)` / `getModel(provider, model)`；`resolveModelDefaults(route, model)` 把数据集映射为 harness 形状（contextWindow/maxTokens/modalities/reasoningEfforts/reasoningToggle/reasoningBudget/interleavedField/cost/npm/shape/status）。
- **额外 params 写入位置**：config 的 `extraParams`（按 models.dev provider id 组织，provider 级 + model 级覆盖），`resolveExtraParams(route, model, mode?)` 合并数据集 `experimental.modes` 与用户配置（用户取胜）；`configuredBodyKeys(route)` 给出需注册的 body 键并集。
- **事件**：`models-dev/updated`（emit，目录替换后广播）。

**子入口 `./deepseek-extra-params`（函数插件）**——把配置的 body 参数注入 DeepSeek 请求：为每个配置键注册一个 `deepseekLlmApiExtensions` 顶层字段，prepare 时按 `body.model` 解析注入。inject `['modelsDev', 'deepseekLlmApiExtensions']`。

**`./invariant`**——仓库约定的伴生（无运行时不变量，原因已注明）。

## 使用方式（cordis.yml）

```yaml
- name: '@deepseek-ai/dsh-models-dev'
  config:
    sourceUrl: https://models.dev/api.json   # 可省（默认值即此）
    routeAliases:
      deepseek-official: deepseek            # 默认值即此
    extraParams:
      deepseek:
        body: { thinking: { type: enabled } }        # provider 级：所有模型生效
        models:
          deepseek-v4-flash:
            body: { thinking: { type: disabled } }   # model 级：覆盖同名键

# 需要 body 注入时再加一行（要求组合里有 deepseek-llm-api-extensions）：
- name: '@deepseek-ai/dsh-models-dev/deepseek-extra-params'
```

## 关键设计决策与理由

1. **body 注入走 `deepseekLlmApiExtensions` 缝，不走 `llm/stream` waterfall**：task5 初版设想是 waterfall，实测契约不可行——loop 组装的请求到达 waterfall 时深冻结（mutation 抛错）、waterfall 转发固定参数、且 `GenerateOptions` 没有携带额外 headers/body 的字段。api-extensions 是 DeepSeek 路由的设计写入位置（prepare 在序列化后、发送前调，能读 body.model；与基础请求字段冲突 fail loud）。
2. **headers 只有数据没有注入**：llm-deepseek 的 header 表自有、无缝。当前只在 `resolveExtraParams` 返回，供未来使用。
3. **数据集 mode 级 body 不参与自动注入**：requests 没有 mode 概念，自动注入只覆盖用户配置；mode 数据经 API 暴露。
4. **边界容错**：JSON 坏 → 抛（回退缓存）；单条目畸形 → 丢弃 + 日志。载荷上限 32MB。
5. **配置校验 fail loud**：extraParams 嵌套形状在构造器手工校验（schemastery 只能声明 dict(any)）。

## 已知缺口

- headers 无注入缝（上述）；其它 provider 路由（pi-ai 系）无 body 注入缝。
- 目录尚未接到 UI/运行时模型列表（`llm-deepseek.models` 仍是 settings 的事）；本插件目前是数据 + 注入层，UI 集成留后续任务。

## 相关插件退役评估（"是否不再需要"）

| 插件 | 结论 | 理由 |
|---|---|---|
| `dsh-llm-pi-ai` 的内置静态目录 | **价值大减，但插件整体不能退役** | 目录职能可被本插件取代（动态、更新快）；但 pi-ai 还承担多 provider 路由、OAuth 登录、wire 适配——目录只是它的附带品 |
| `dsh-llm-deepseek` 的 `DEFAULT_MODELS` | **可被取代，但不能删** | 它是 fallback 默认值；本插件缺席时仍需它兜底。取代方式是 settings `llm-deepseek.models` 由本插件数据生成（后续任务做同步器） |
| pi-ai 的 `discoverModels`（`GET /models` 探测） | **可被取代** | models.dev 目录覆盖面远大于单端点探测；设置页 "fetch available models" 对已知 provider 本就零网络 |
| `dsh-plugin-package-inventory-deepseek` / `dsh-deepseek-llm-api-extensions` | **无关，保留** | 前者是请求元数据上报；后者恰是本插件依赖的写入缝 |

**净结论**：本插件落地后没有插件可以物理删除；可退役的是"pi-ai 静态目录作为事实源"这一职能。真正的简化发生在后续：若做"models.dev → settings `llm-deepseek.models` 同步器"，`DEFAULT_MODELS` 表就只剩 fallback 意义。

## 附：dsh-llm-pi-ai 的复杂度解剖（"为什么这么多东西"）

**总量**：src 12 文件约 3805 行 / 152 KB（只比 llm-deepseek 大约 30%，却服务 39 provider / 1267 模型）；tests 约 237 KB（代码的 1.5 倍，coverage 门禁的代价）。

**一个插件干了四份工**（复杂度的真实来源）：

| 职责 | 落点 | 占比 | 归因 |
|---|---|---|---|
| 声明式 provider 配置系统（catalog 三层合并 + compat 门禁 + reasoningEfforts + modelOverrides） | catalog.ts(43KB) + config.ts(21KB) | ~43% | 本插件自写；pi-ai 只给原语不给配置层 |
| seam 翻译（消息转换/事件翻译/replay 签名） | context/stream/replay.ts | ~22% | 任何适配器都有；replay 是 pi-ai 特有（签名须原样回带） |
| 认证平面桥接（OAuth PKCE ↔ harness credentials seam） | auth/login/provider.ts | ~17% | pi-ai 只给流程不给持久化，宿主必须补 CredentialStore |
| settings 动态化（每请求解析、原子重注册） | index.ts | ~10% | harness 架构要求（无重启生效） |
| 不可变快照 + 流生命周期 | adapter.ts | ~12% | pi-ai 惰性解析 × harness 每步冻结语义的结构性要求 |
| 端点探测（设置页 fetch 按钮） | discovery.ts | ~8% | 本插件自写 |
| 上游缺陷代偿（错误码正则反推等） | 散点 ~60 行 | <1% | pi-ai 拍平错误 cause 链等 |

**设计动因**（有 Agent Note 背书）：它是 `dsh-llm-deepseek` 的**设计验证孪生**（2026-06-13 note：同一 StreamChunk 词汇交两个内部迥异的实现，逼出词汇缺陷）+ **通用多 provider 网关**（2026-07-14 note：OpenRouter/私有网关/OAuth provider）+ **声明式路由**（2026-08-03 note：catalog 只是默认值，路由是声明出来的）。

**裁剪分档**（若分支收窄为"DeepSeek 官方 + models.dev 动态目录 + 少量兼容网关"）：

- **必需**（pi-ai 发请求就不能动）：stream.ts、replay.ts、context.ts 主干、adapter.ts 快照机制、provider.ts 协议表、config.ts schema 主干；
- **可裁**：discovery.ts 整删（284 行，被 models.dev 取代，唯一损失是私有端点的拉模型按钮）、login.ts + OAuth 写路径（~200 行，DeepSeek 系全是 api-key）、compat 门禁收窄到 3-5 个高频字段（~15KB，代价是失去上游升级预警）、modelOverrides 删、rejectRemovedFields（pre-release 守卫，release 后本就该删）；
- **可替代**：静态目录的"事实源"职能 → dsh-models-dev（但 catalog 的运行时构造职能——reuseCatalogProvider/auth 声明/compat 值——models.dev 只给数据不给实现，替代不了）。

裁剪次序：discovery → login/OAuth → compat 收窄 → modelOverrides，约去 40-50KB src + 对应测试；剩余骨架每个字都有 Agent Note 或 seam 契约撑着。
