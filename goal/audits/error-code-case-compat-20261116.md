# 错误码大小写兼容性调查（2026-11-16）

## 结论

- 自定义错误码本身是正确方向：结构化错误要求稳定的机器可路由 `code`，不应回退为解析 message。
- 本次被改成大写的 **16 个旧 code 全部位于 `private: true` 的包**，没有出现在 TypeScript/Python SDK、`snapshots/`、发布文档/CHANGELOG、对外 API 响应 schema 或其它包的字符串契约中。
- 因此这 16 个旧 code 判定为 **仅内部使用：只需 release note，不需要兼容别名**。
- 另有 6 个新引入的 code（原先无 code 或原先是普通 `Error`），不是大小写重命名，不存在兼容问题；其中 `SANDBOX_MODE_DISABLED` 位于已发布包 `@deepseek-ai/dsh-sandbox`，但它是新 code，不是旧 code 改名。

## 改动清单（原文小写 → 现在大写）

| 错误类 | 包 | 旧 code | 新 code |
| --- | --- | --- | --- |
| `MemoryDocumentError` | `@deepseek-ai/dsh-memory`（private） | `invalid-document` | `INVALID_DOCUMENT` |
| `MemoryDocumentError` | 同上 | `unknown-kind` | `UNKNOWN_KIND` |
| `MemoryDocumentError` | 同上 | `budget-exceeded` | `BUDGET_EXCEEDED` |
| `MemoryDocumentError` | 同上 | `empty-summary` | `EMPTY_SUMMARY` |
| `PersonalityStoreError` | `@deepseek-ai/dsh-personality`（private） | `invalid-document` | `PERSONALITY_INVALID_DOCUMENT` |
| `PersonalityStoreError` | 同上 | `unknown-kind` | `PERSONALITY_UNKNOWN_KIND` |
| `PersonalityStoreError` | 同上 | `invalid-name` | `PERSONALITY_INVALID_NAME` |
| `PersonalityStoreError` | 同上 | `identity-manual` | `PERSONALITY_IDENTITY_MANUAL` |
| `PersonalityStoreError` | 同上 | `budget-exceeded` | `PERSONALITY_BUDGET_EXCEEDED` |
| `PersonalityStoreError` | 同上 | `legacy-conflict` | `PERSONALITY_LEGACY_CONFLICT` |
| `AnalyzeError` | 同上 | `invalid-request` | `PERSONALITY_ANALYZE_INVALID` |
| `ApplyError` | 同上 | `invalid-request` | `PERSONALITY_APPLY_INVALID` |
| `WritingRulesError` | 同上 | `invalid-document` | `PERSONALITY_INVALID_DOCUMENT` |
| `WritingRulesError` | 同上 | `rule-limit` | `PERSONALITY_RULE_LIMIT` |
| `WritingRulesError` | 同上 | `rule-not-found` | `PERSONALITY_RULE_NOT_FOUND` |
| `WritingRulesError` | 同上 | `duplicate-rule` | `PERSONALITY_DUPLICATE_RULE` |

新引入、非重命名：

| 错误类 | 包 | 旧状态 | 新 code |
| --- | --- | --- | --- |
| `OutputStyleError` | personality（private） | 无 `code` | `PERSONALITY_OUTPUT_STYLE_INVALID` |
| `StorePathError` | `@deepseek-ai/dsh-store-atom`（private） | 无 `code` | `STORE_PATH_REJECTED` |
| `SandboxModeDisabledError` | `@deepseek-ai/dsh-sandbox`（public） | 普通 `Error` | `SANDBOX_MODE_DISABLED` |
| `PersonaStateError` | `@deepseek-ai/dsh-persona-card`（private） | 无该类/无 `code` | `PERSONA_STATE_INVALID`、`PERSONA_STATE_UNKNOWN_REVISION`、`PERSONA_STATE_BUDGET_EXCEEDED` |

## 发布面逐项检查

| 面 | 结果 | 证据 |
| --- | --- | --- |
| TypeScript SDK（`packages/sdk/**`）、Python SDK（`python/**`） | 无命中 | `git grep` 新旧 code 在 `packages/sdk`、`python` 均为 0 |
| 会话快照（`snapshots/**`） | 无命中 | 新旧 code 在 `snapshots/` 为 0 |
| 已发布文档 / CHANGELOG | 无命中 | 新旧 code 在 `docs/`、`CHANGELOG*` 为 0；`docs/subsystems/session-reference.md:121` 只是另一个 code `SESSION_REFERENCE_BUDGET_EXCEEDED` |
| 对外 API 响应 schema | 无枚举约束 | `@deepseek-ai/dsh-typert-protocol` 的 `RemoteError.code` 是泛型字符串，不是这些 code 的枚举 |
| 其它包的字符串匹配 / 日志契约 | 无跨包命中 | 所有新旧 code 只出现在定义包（memory/personality/store-atom/persona-card）与其 tests |
| 包是否发布 | 16 个重命名 code 所属包均 `private: true` | `packages/uitstalie/{memory,personality,store-atom,persona-card}/package.json` 第 5 行 |

定义处与内部断言示例：

- `packages/uitstalie/memory/src/memory-file.ts:165`（`MemoryDocumentErrorCode`）
- `packages/uitstalie/personality/src/global-store.ts:94`（`PersonalityStoreErrorCode`）
- `packages/uitstalie/personality/src/writing-rules.ts:95`（`WritingRulesError`）
- `packages/uitstalie/memory/tests/summary.spec.ts:582-588`（内部断言）
- `packages/sandbox/sandbox/src/modes.ts:31`（新 `SANDBOX_MODE_DISABLED`，已发布包但非重命名）

## 三档结论

- **已发布面（必须兼容）：0 个重命名 code。**
- **仅内部使用（只需升级说明）：16 个重命名 code。**
- **无法判定：0 个重命名 code。** 唯一的产品层不确定点是：这些 private 插件经 DSH app 暴露给最终用户的 tool error 是否被视为对外可观察契约；当前证据不支持把它当 SDK/API schema 承诺。

## 兼容策略建议

**选择：只写 release note，不加兼容层。**

代价：如果外部消费者曾直接匹配旧小写 code，需要按 note 迁移；但这些包未发布、SDK/snapshot/schema 无引用，改动的实际外部影响为零。

不选别名映射的原因：

- 需要改 5 个错误类（memory/personality 的 store/analyze/apply/writing-rules），增加旧码→新码映射与长期维护；
- 旧 code 只在 private 包的内部 exports/测试中出现，没有已发布消费者；
- 别名会让“稳定 code”出现两个可接受拼写，削弱结构化错误契约。

不选“保留旧大小写、只对新码用大写”的原因：

- 同一个错误类会出现大小写不一致的 code，违背本次规范修复目标；
- 旧 code 本来就不是发布面，保留旧拼写没有收益。

若未来确认 DSH app 的 tool error 属于对外承诺，再补一层**读取侧**旧码归一化（`lowercase -> uppercase`），不要在写入侧同时发两个 code。
