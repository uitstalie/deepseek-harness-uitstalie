# task9 — llm-plus 完全替换 llm-pi-ai

## requirement

以 llm-plus 完全替换 llm-pi-ai（task6 任务单的既定目标：并存开发 → 灰度迁移 → 最终替换）。明确**不做** pi-ai 的 compat 门禁体系——它被 models.dev 数据 + 四个干净协议实现取代，这正是替换的意义。

## 范围（必做）

1. **OAuth 登录流**：经 authorization seam（`ctx.authorization.registerFlow`）为需要 PKCE 登录的 provider（Copilot/Codex 类）提供授权流；凭据入 credentials seam，与 apiKeyRef 并列作为路由凭据来源。
2. **per-route retryPolicy**：RouteConfig 增加 retryPolicy 字段，PlusAdapter override `providerRetryPolicy`（对齐 pi-ai 的 profile.retryPolicy → adapter 路径）。
3. **replay 降级告警**：replay envelope 对不齐/协议不符被丢弃时记 `logger.warn`（对齐 pi-ai 的 onReplayDegrade 可诊断性；静默仍是行为，告警是可观测性）。
4. **目录支持率扫描**：用 models.dev 全量数据统计四协议（+ shape:"responses"）的覆盖率，未知方言（bedrock/azure/vertex/mistral/cerebras 等）显式标"不支持"，产出报告落 goal/。
5. **灰度替换组合**：dsh-base bundle 的 pi-ai 行换 llm-plus（原生文件，标记+登记）；先 `disabled` pi-ai 验证一轮再物理删除；处理同名路由撞车（DUPLICATE_DIRECTORY/adapter 冲突）。

## 范围（应做）

6. **图片预算**：路由级 maxRequestImageBytes / requestImagePixelBudget（请求装配期强制，对齐 pi-ai 字段语义）。
7. **reasoning 细分**：models.dev reasoning_options 数据驱动——anthropic `budget_tokens`（min/max）、gemini thinkingBudget（已有数值路径）、openai effort 枚举校验。

## TODO（缓做，归后续 task）

- **WebSocket 传输**（pi-ai transport: sse/websocket/websocket-cached/auto）：无明确目标 provider 需求，需要时单独立 task。
- **cacheRetention**（none/short/long prompt caching 控制）：语义跨协议映射未定型（anthropic cache_control vs DeepSeek 自动缓存），需要时单独立 task。
- **defaultInput 默认模态**：模型 modalities 缺失时的路由级默认假设，需要时单独立 task。

## 原生文件修改登记

- `packages/bundle/base/cordis.patch.yml`：pi-ai 行 → llm-plus（先 disabled 灰度），带 `uitstalie-k3` 标记注释。
- `packages/bundle/base/package.json`：依赖换 llm-plus 两包（同步登记）。
- `pnpm-lock.yaml`：`pnpm install` 自动生成。

## 验证

- host 单测：retryPolicy 覆盖生效、降级告警触发、图片预算拒绝超限、reasoning 映射序列化正确。
- 真实 API e2e：deepseek（completions）、kimi-for-coding（anthropic）已实战；gemini/openai 有 key 则补。
- 灰度验证：禁用 pi-ai 后完整 boot + 已有路由全部可用 + 无路由撞车。
