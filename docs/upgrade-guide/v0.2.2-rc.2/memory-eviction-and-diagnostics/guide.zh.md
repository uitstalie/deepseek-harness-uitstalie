---
kind: upgrade-guide
description: "memory 增加有界淘汰与显式遗忘路径，摘要失败改为带原因码，会话搜索在单个存储会话不可读时继续工作。"
---

# memory 淘汰、显式遗忘与搜索容错

[English](guide.md) | 中文

## 变更

`dsh-memory` 不再仅因托管区块达到 `maxBytes` 就让写入失败。追加或摘要将超预算时，提供者按固定耐久度顺序逐条淘汰：先 `open`，再 `files`，再 `decision`，最后 `preference`，同一 kind 内最旧优先，且永不清除本次正在写入的 turn。每次移除都记录在 `MEMORY.md` frontmatter 中（`at`、`sessionId`、`kind`、`turn`、`text`、`reason`、`detail`）；`memory_write` 会逐条点名被淘汰的条目，并明确标出被淘汰的 `decision`。如果单条新写入在淘汰其它所有条目后仍放不下，仍会明确失败。

模型面新增 `memory_forget` 工具，接受可选的 `kind`、`tag`、`beforeTurn`、`sessionId` 与 `allSessions`；`kind`、`tag`、`beforeTurn` 至少给一个。人工面新增 `/memory forget` 与带过滤的 `/memory prune --kind --tag --before-turn [--session|--all-sessions]`；`/memory prune [keep]` 保持原有的条数上限语义。`maxBytes` 默认仍为 `16384`，该默认值现已在配置 schema 与配置目录中说明：它与 snapshot 自身的 16 KiB 预算一致。

摘要失败 notice 现在带稳定失败码、尝试次数与简短原因，例如 `Memory summary failed [UPSTREAM_RATE_LIMIT] (attempt 2/2); previous memory still in effect: provider rate-limited`。瞬时上游失败在 notice 前有一次有界重试；预算、文件与授权失败在第一次尝试后直接报告。旧的 `MEMORY.md` 继续生效，notice 仍按“每会话每失败码最多一条”的规则追加，成功 pass 会清除该状态。

`memory_search` 跳过单个无法观测的存储会话，保留已有索引行，继续搜索其余会话，并返回 `warnings` 渲染成 `Warning:` 行。v1→v2 迁移会把终帧 `finish` 之后仅含 usage 的分片留在同一个 Assistant attempt 中；`llm-plus` 的 OpenAI 兼容流把 `finish` 推迟到流末尾。

活跃记忆在容量淘汰之前自动清理，顺序固定：TTL → supersession → 同 turn 去重 → 容量淘汰。`open` 默认 3 天 TTL，`files` 默认 14 天（`openTtlDays`、`filesTtlDays`；`0` 关闭），`decision`/`preference` 永不自动过期。`memory_resolve` 显式归档已完成的 `open` 工作。`memory_write` 新增 `supersedes`；没有它时，supersession 要求同会话、同短命 kind、旧 turn 更小、至少 `supersessionMinSharedTags`（默认 2）个共享 tags，且 Jaccard ≥ 0.5。同 turn 去重只合并共享提交哈希或命名同一唯一文件路径的条目，保留更长文本。自动移除会把完整正文写入 `MEMORY.archive.md`，并在 frontmatter 追加有界审计记录；归档按 `(session, turn, kind, 归一化文本)` 去重。归档写失败时，TTL/resolve/supersede/去重移除会跳过，但新条目仍然提交。

`summarizeEveryTurns` 控制多少个完成的 turn 共用一次摘要调用。默认 `1` 保持每个 turn 一次调用。大于 `1` 时，N 个 turn 合并成一次严格的 `{ turns: [...] }` 模型回复，并用一次带版本守卫的写入提交每个 turn 的条目；会话销毁时 flush 未满批，失败保留整个 pending 批，取消不写任何内容，tier 迁移仍在每批之后执行。

## 迁移

1. 不需要迁移 memory 文件；`evictions` 是可选字段，没有该字段的文件解析与渲染行为不变。
2. 只有工作区达到正文预算时才会发生淘汰。用 `/memory stats` 检查，若保留策略过于激进，调高 `maxBytes`。
3. 更新按“三个 memory 工具”写死的 profile 工具白名单与文档，加入 `memory_forget`。
4. 渲染摘要失败 notice 的客户端应匹配 `Memory summary failed` 前缀并读取失败码与尝试次数，不要再匹配旧固定句。
5. 搜索消费方可以读取可选的 `warnings` 字段；所有存储会话均成功观测时该字段缺席。
6. 确认：把测试工作区写到预算并观察 `Evicted ...` 与 `evictions:` 条目；按 tag 遗忘；构造摘要失败；让搜索包含一个损坏会话。回滚 `dsh-memory`、`dsh-session-query`、`dsh-session-query-sqlite`、`dsh-session-format-v1-to-v2` 与 `dsh-llm-plus` 提交即可；两个方向的 memory 文件都可读。
