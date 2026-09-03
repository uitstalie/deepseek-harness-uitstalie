# models.dev 目录的 llm-plus 协议支持率（task9 #4）

数据源：`~/.dsh/cache/models-dev.json`（2026/09/02 拉取，212 provider / 7495 model）。分类规则即页面的 `defaultProtocol`：`npm` 含 anthropic→anthropic-messages、含 google→gemini、含 openai→openai-completions；model 级 `provider.shape:"responses"`→openai-responses（最高优先），model 级 `provider.npm` 覆盖 provider 级。

## 总览

| 类别 | providers | models | models 占比 |
|---|---|---|---|
| openai-completions（npm 含 openai，含 openai-compatible） | 177 | 5609 | 74.8% |
| anthropic-messages | 10 | 178 | 2.4% |
| gemini | 2 | 75 | 1.0% |
| openai-responses（shape:"responses" 的 model 级覆盖） | （跨 provider） | 26 | 0.3% |
| **直接可映射合计** | **189（89%）** | **5888** | **78.6%** |
| 未知方言（npm 为厂商私有 SDK 包） | 23 | 1607 | 21.4% |

## 未知方言分层（1607 models）

**A. 大概率 openai-completions 兼容（906 models）**：这些厂商公开文档均为 OpenAI 兼容端点，但 npm 包名不含 "openai"，自动映射不会命中——页面手选协议即可，**这是设计内的路径**（未知方言不猜，用户显式选）：

| models | npm |
|---|---|
| 368 | @ai-sdk/gateway（Vercel AI Gateway） |
| 357 | @openrouter/ai-sdk-provider（OpenRouter） |
| 62 | @ai-sdk/deepinfra |
| 38 | @ai-sdk/togetherai |
| 34 | @ai-sdk/mistral |
| 16 | @ai-sdk/groq |
| 13 | @ai-sdk/cohere |
| 12 | @ai-sdk/xai |
| 4 | @ai-sdk/perplexity |
| 2 | @ai-sdk/cerebras |

**B. 网关聚合类（281 models）**：merge-gateway-ai-sdk-provider(179)、venice-ai-sdk-provider(102)——聚合网关，通常也兼容 openai-completions，手选同上。

**C. 认证/端点语义确实不同（241 models）**：@ai-sdk/azure(127，api-version 路径 + deployment URL)、@ai-sdk/amazon-bedrock(114，AWS SigV4 签名)——四协议干净实现**不覆盖**，需要专用协议实现才考虑（当前显式不支持）。

**D. 其余厂商私有 SDK（179 models）**：aihubmix(77)、sap-ai-provider-v2(48)、gitlab(24)、ai-gateway-provider(12)、qvac(9)、watsonx(5)、vercel(3)、salad(1)——逐个评估，默认按 A 类手选尝试。

## 设计结论

1. 四协议 + shape 覆盖命中目录 78.6% 的 model（89% 的 provider 整体可映射），达到替换 pi-ai 的覆盖率门槛——pi-ai 的 compat 门禁体系所处理的"怪癖"，大头正是 A/B 类"实际上是 openai-completions 但要按家适配"，而在我们这边是**用户手选一次协议**而非代码猜测。
2. 未知方言不做任何自动猜测：页面默认协议留空、用户手选（已是现有 UX）。若 A 类手选后实测全部可用，后续 task 可考虑把"厂商私有 SDK 但文档确认 openai 兼容"的 npm 清单做成 models-dev 目录侧的显式映射表（数据，不是代码猜测）。
3. C 类（azure/bedrock）若要支持，是新增专用协议实现的独立 task，不在替换范围内。
