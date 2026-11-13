---
kind: upgrade-guide
description: "memory 增加有界淘汰与显式遗忘路径，摘要失败改为带原因码，会话搜索在单个存储会话不可读时继续工作。"
---

# memory 淘汰、显式遗忘与搜索容错

[English](guide.md) | 中文

## 变更

`dsh-memory` 不再仅因托管区块达到 `maxBytes` 就让写入失败。追加或摘要将超预算时，提供者按固定耐久度顺序逐条淘汰：先 `open`，再 `files`，再 `decision`，最后 `preference`，同一 kind 内最旧优先，且永不清除本次正在写入的 turn。每次移除都记录在 `MEMORY.md` frontmatter 中（`at`、`sessionId`、`kind`、`turn`、`text`、`reason`、`detail`）；`memory_write` 会逐条点名被淘汰的条目，并明确标出被淘汰的 `decision`。如果单条新写入在淘汰其它所有条目后仍放不下，仍会明确失败；此时应提高 `maxBytes` 或先遗忘一些条目。

模型面新增第四个工具 `memory_forget`，接受可选的 `kind`、`tag`、`beforeTurn`、`sessionId` 与 `allSessions`；`kind`、`tag`、`beforeTurn` 至少给一个。人工面新增 `/memory forget ...` 与带过滤的 `/memory prune --kind <kind> --tag <tag> --before-turn <n> [--session <id> | --all-sessions]`；`/memory prune [keep]` 保持原有的条数上限语义。每次显式移除同样写入 frontmatter，`memory_forget` 还会刷新 snapshot。

`maxBytes` 仍是可配置项，默认值仍为 `16384`；该默认值的理由现已写入配置 schema 与[配置目录](../../../config-catalog.zh.md#deepseek-aidsh-memory)：它与 snapshot 自身的 16 KiB 预算一致，使持久正文与渲染出的 snapshot 保持一个提示词规模。

摘要失败 notice 不再是固定的 `Memory summary failed; the previous memory is still in effect.`。它现在带稳定失败码、尝试次数与简短原因，例如：

```text
Memory summary failed [UPSTREAM_RATE_LIMIT] (attempt 2/2); previous memory still in effect: provider rate-limited
```

瞬时上游失败（限流、超时、server/transport 流错误、格式错误或空响应）在 notice 前有一次有界重试；预算、文件与授权失败在第一次尝试后直接报告。旧的 `MEMORY.md` 继续生效，完整错误写入 debug 日志。notice 仍按“每会话每失败码最多一条”的规则追加，成功 pass 会清除该状态。

`memory_search` 不再因单个存储会话无法观测而整体失败。提供者跳过该会话，保留它已有的索引行，继续搜索工作区其余会话，并在结果页返回 `warnings`；`memory_search` 把每条 warning 渲染成 `Warning:` 行，点名会话与失败原因。修复后的存储日志会在后续搜索中被拾取，无需重启。

v1→v2 Session 迁移现在会把终帧 `finish` 之后仅含 usage 的分片留在同一个 Assistant attempt 中。若已发布适配器先发 `finish` 再发 `usage`，日志的完整有序 attempt 会与消息的 chunk 引用不一致；现在该日志可以迁移，不再让读取失败。新的 `llm-plus` OpenAI 兼容流也把终帧 finish 推迟到流末尾，避免尾部 usage 帧再次制造该模式。

## 迁移

1. 不需要迁移 memory 文件。`evictions` 是可选 frontmatter 字段；旧提供者写出的文件解析行为不变，没有该字段的文件渲染行为也不变。
2. 只有工作区达到正文预算时才会发生自动淘汰。用 `/memory stats`（现在会报告已记录的淘汰）检查，若默认保留策略对该工作区过于激进，调高 `maxBytes`。
3. 枚举 memory 工具的 agent 现在会看到 `memory_forget`。更新任何按“三个 memory 工具”写死的 profile 工具白名单或文档。
4. 渲染 memory 摘要失败 notice 的客户端不要再匹配旧固定句。匹配 `Memory summary failed` 前缀，并读取方括号中的失败码与尝试次数；notice 仍限制在 120 字符内。
5. 搜索消费方可以读取 `SessionSearchPage` 的可选 `warnings` 字段。所有存储会话均成功观测时该字段缺席；`items` 与游标行为不变。
6. 确认变更：把测试工作区写到正文预算并观察下一次 `memory_write` 成功、带 `Evicted ...` 行与 `evictions:` frontmatter；用 tag 调用 `memory_forget` 并确认条目消失；构造一次摘要失败并确认 notice 含失败码与尝试次数；让搜索指向含一个损坏存储会话的工作区，确认其余会话命中并带 `Warning:` 行。

## 回滚

回滚本次变更涉及的 `dsh-memory`、`dsh-session-query`、`dsh-session-query-sqlite`、`dsh-session-format-v1-to-v2` 与 `dsh-llm-plus` 提交。两个方向的 memory 文件都可读：旧提供者忽略可选的 `evictions` 字段，新提供者接受没有该字段的文件；读取侧修复不会重写任何存储的 session 产物。
