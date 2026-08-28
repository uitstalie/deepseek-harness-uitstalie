# llm-plus（pi-ai-plus）设计文档

任务单：[task6](mission/task6.md)。自有三协议 LLM 适配器，包位于 `packages/uitstalie/llm-plus/`（`@deepseek-ai/dsh-llm-plus`）。定位：与 llm-pi-ai 并存开发、灰度迁移，最终替换。

## 为什么合并重构而不是裁剪

pi-ai 栈是双层桥接：harness StreamChunk ↔ pi-ai 内部词汇 ↔ 6 种 wire 协议，中间夹着"按 URL 猜 compat + 23 个可配置字段 + 门禁防上游漂移"。**门禁系统存在的唯一理由是不拥有协议实现**。协议实现归我们所有后：无上游可漂移（门禁删除）、无 URL 猜测（协议显式声明）、额外 params 原生注入（adapter 自有，不需要 deepseek-llm-api-extensions 绕道）。

数据支撑（models.dev 实测）：协议方言由 `npm` 字段标注，80% 是 openai-compatible；148 处 model 级覆盖（`shape: responses|completions`、Kimi Code/MiniMax 走 anthropic 协议等）——目录数据已含协议提示，adapter 只需要照做。

## 架构

```
models.dev 目录（dsh-models-dev：目录数据 + extraParams 写入位置）
        │ 可选（ctx.get('modelsDev')，缺席退化手工 models）
        ▼
llm-plus（PlusAdapter extends LlmAdapter，注册到 ctx.llm）
        ├── config.ts    路由表声明：protocol/baseURL/apiKeyRef/modelsDevProvider/models/headers/body
        ├── protocol.ts  协议接口（buildRequest + createTranslator）+ BaseTranslator（block 簿记）
        ├── sse.ts       SSE 分帧器（\r\n、多行 data、心跳注释、残帧补发）
        └── protocols/   openai-completions / anthropic-messages / gemini 三个实现
```

每条路由显式声明协议名，无猜测。额外 params 合并顺序：目录 extraParams 垫底 < 路由级 headers/body 取胜。

## 协议要点（实现时已固化的差异）

| | openai-completions | anthropic-messages | gemini |
|---|---|---|---|
| 端点 | `{base}/chat/completions` | `{base}/v1/messages` | `{base}/v1beta/models/{model}:streamGenerateContent?alt=sse` |
| 认证头 | `Authorization: Bearer` | `x-api-key` + `anthropic-version` | `x-goog-api-key` |
| block 索引 | 无（reasoning/text 惰性分配；tool_calls 带 provider index 需映射） | provider 自带（content_block index） | 无（part 顺序即增量） |
| reasoning | `reasoning_content` 增量字段；请求 `reasoning_effort` 透传 | `thinking_delta`；请求 `thinking: {type: enabled}` | part 内 `thought: true`；请求 `thinkingConfig` |
| 工具调用 | 流式增量（arguments 字符串） | 流式增量（input_json_delta） | **完整帧**（functionCall 一次给全） |
| 工具结果 | role:tool 消息（tool_call_id） | user 消息 tool_result 块 | functionResponse **需要函数名**（扫历史建 id→name 映射） |
| usage | 流尾空 choices 帧（include_usage） | message_start + message_delta 两段 | usageMetadata 末帧 |
| 硬约束 | — | max_tokens 必填（兜底 8192）；user/assistant 交替（合并连续同角色） | 角色词汇 user/model |

历史序列化共同规则：assistant 的 reasoning 块丢弃（DeepSeek 等要求不回带，回带反而 400）；image 块 v1 抛 `UNSUPPORTED`（fail loud 优于静默丢图）。

## v2 范围（已实现，2026/08/28）

主干之后的后续项已全部落地，除了 OAuth（按约定挂起）：

- **openai-responses 协议**（第四种实现）：item 词汇（function_call/function_call_output/reasoning 独立 item）、`store:false` + `include: reasoning.encrypted_content`、response.* 事件系列翻译。
- **replay（签名回带）**：自有 envelope `{kind:'llm-plus', version:1, protocol, response, blocks}` 随 finish chunk 的 replayState 持久化，blocks 与发出 block 按首次出现顺序对齐（harness 契约）。三协议各有实现：**anthropic** 采集 `signature_delta` → 历史恢复为带签名的 thinking 块（thinking 必须先于 text）；**gemini** 采集 part 级 `thoughtSignature`（含 functionCall part）→ 恢复为带签名 part；**openai-responses** 采集 reasoning item 的 id + `encrypted_content` → 回带 reasoning item。降级规则：kind/version/protocol 不匹配或 blocks 与 content 位置对不齐 → 丢弃 reasoning（强于伪造）；openai-completions 协议无 replay（DeepSeek 要求不回带 reasoning_content）。
- **credentials seam（唯一凭据路径）**：路由配置 `apiKeyRef`（POSIX 标识符），每请求 `ctx.credentials.resolve(credentialRef(ref))` 解析，轮换立即生效；缺失报可行动的 AUTH 错误（绝不回显密钥内容）。**不读 process.env**——环境变量与 .env 的分层兜底是 credentials provider（credentials-local）自己的职责。
- **图片**：三协议各自的图片形态（openai 的 image_url data URL / anthropic 的 base64 source / gemini 的 inlineData；responses 的 input_image）。字节经 attachments 服务 `readImage` 读取；模型不收图（inputModalities 无 image）或服务缺席时降级为 `textOnlyImageText` 占位符（静默丢图会让模型对着空气回答）。
- **settings 动态化**：`installSettingsSection` 把 cordis.yml 配置注册为 `llm-plus` 命名空间的 base 层；用户层变更 → 重新解析路由 → `registration.replace()` + `adapter.updateRoutes()` 原子替换；settings 服务缺席时接线休眠（纯 cordis.yml 模式）。在途请求持旧路由快照不受影响。
- **请求期材料注入**：协议接口的 `buildRequest(route, options, assets)` 第三参携带 adapter 解析好的 apiKey 与图片解析器，协议实现只管用不管来源。

仍挂起：**OAuth（PKCE 登录流，Copilot/Codex 类 provider）**——主干完成后再按协议/provider 加入；挂接点是 authorization seam（`ctx.authorization.registerFlow`）。

## v1 范围与明确的后续项（历史记录，已被 v2 取代）

v1：三种协议、api-key（环境变量）、models.dev 目录集成、额外 params 原生注入、text/reasoning/tool-call/usage/finish 全链路。

后续（最终替换 llm-pi-ai 前必须补）：
- **replay**：reasoning 模型的签名回带（Anthropic/OpenAI 要求多轮原样回带 provider 私有签名，否则历史被当伪造）。本质：finish chunk 的 `replayState` envelope + 序列化时从 session 重建。协议词汇已留好口子（`ReplayEnvelope`）。
- **OAuth**：GitHub Copilot / OpenAI Codex 的 PKCE 登录（不发 api-key 的 provider）。
- **credentials seam 接入**：当前 api-key 只读环境变量；settings UI 写入的 key 在 credentials 里。
- **settings 动态化**：v1 路由表挂在 cordis.yml config（fiber 重启生效）；`registerConfigurableProviders` + settings section 留待 UI 集成时做。
- **图片**：三协议的 image 序列化（attachments 服务集成）。
- **openai-responses 协议**：models.dev 有 `shape: responses` 标注（Bedrock mantle 等），需要时加第四种实现。

## 使用方式（cordis.yml）

```yaml
- name: '@deepseek-ai/dsh-models-dev'          # 可选：动态目录 + extraParams 写入位置
- name: '@deepseek-ai/dsh-llm-plus'
  config:
    routes:
      deepseek-plus:                            # routeId 即 provider 路由名
        protocol: openai-completions
        baseURL: https://api.deepseek.com
        apiKeyRef: DEEPSEEK_API_KEY             # credentials seam 的引用名
        modelsDevProvider: deepseek             # 接 models.dev 目录
      kimi-code:
        protocol: anthropic-messages            # Anthropic 协议的 Kimi
        baseURL: https://api.moonshot.ai/anthropic
        apiKeyRef: MOONSHOT_API_KEY
        modelsDevProvider: moonshotai
      glm-plus:
        protocol: openai-completions            # openai-compat 的 GLM
        baseURL: https://open.bigmodel.cn/api/paas/v4
        apiKeyRef: ZHIPU_API_KEY
        modelsDevProvider: zhipuai
      gemini-plus:
        protocol: gemini                        # gemini 原生
        apiKeyRef: GEMINI_API_KEY               # baseURL 用协议默认
        modelsDevProvider: google
```

## 测试

`tests/llm-plus.spec.ts`（6 个组合级用例）：真实 Context + 真实 LlmRuntime + 罐装 SSE，覆盖三协议的请求序列化与流翻译全链路、目录集成（listModels/resolveModel/额外 body 注入）、HTTP 429 的错误分类（RATE_LIMIT + retryAfter）、非法配置的激活期 fail loud、fiber 摘除。
