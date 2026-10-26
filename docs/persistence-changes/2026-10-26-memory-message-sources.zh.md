---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-26-memory-message-sources

[English](2026-10-26-memory-message-sources.md) | 中文

## 概述

共享消息来源联合类型新增附加的 memory 生产者：snapshot 形态携带一个具名 section，notice 形态携带单行 summary，并在分层检查点上携带被替换的回合窗口。memory 能力在记忆写入、摘要失败或回合分层检查点之后追加的用户消息上发出该来源。event:user/message、event:developer/message、event:agent/inbox/spliced（inserted 消息）与 event:session/title-llm-request（messages）都内嵌同一联合类型，因此各自摘要发生变化，除此之外没有其他结构差异。既有变体、字段与 SESSION_FORMAT_VERSION 均不变，因此本记录维持同一版本。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-26-memory-message-sources
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-user-rpc-principal"
    after: "507c4f9f9af76c4e9b724c142bb285f6833f9783e864807eedaa444f2d87fdc2"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "b44ccc9e12edc15d3f356781c1386fd987733ffceb0706a26928ce4d4de16807"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-user-rpc-principal"
    after: "eb033515eef2beaf56a5d6f2d4d610afed1f574653350fae5c77616f414047b7"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "988d4337942842ccadf5b7527ca0bf79737ec5b7ae0a522593e2b21437442e97"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

两个方向都保持含义。旧日志仍然可读，因为两种形态都是新增：没有既有来源变体被删除、收窄或改写，不含 memory 来源的日志含义与之前完全相同。遇到 memory 来源的旧读取方会保留该记录：source 槽位记录的策略以 'kind' 为判别字段并声明 unknownKinds 为 'preserve'；V4 消息准入只要求非空且由生产者拥有的 kind，只拒绝已退役的 'plugin' 包装，因此原样保留 'memory'；Chat 与 Trajectory 投影把未知生产者渲染为按持久化 kind 标注的注入内容，不会把它重新解释为人类 'user' 来源；模型请求序列化读取消息 role 与内容，不读取用户来源。新读取方读取旧日志时，缺少该变体即保持原有行为；出现 memory 来源也不会引入校验、回放或权限要求：其文本就是普通的模型可见内容，memory 提供方通过扫描会话表面重建自身状态，因此没有该能力的读取方只是显示一条注入消息。写入方只在 memory 能力产生的用户消息上发出该变体；developer 消息目前携带 'tool-registry' 来源，标题请求携带 'dsh-session-title-llm'，这两个根的其他部分均未变化。

<a id="verification"></a>
## 验证

pnpm --silent run verify-persistence-changes --json：报告这四个根为 union-variants-changed 且需要兼容性复核，未报告其他根。pnpm exec vitest run packages/uitstalie/memory/tests/snapshot.spec.ts packages/uitstalie/memory/tests/checkpoint.spec.ts packages/uitstalie/memory/tests/read.spec.ts：3 个文件、22 个测试通过。pnpm exec vitest run packages/session/session-format-v3-to-v4/tests/message-sources.spec.ts packages/session/session-persistence-jsonl/tests/native-source-admission.spec.ts：2 个文件、42 个测试通过，其中未知的直接来源 kind 在迁移与原生恢复中都得到保留，只拒绝畸形或已退役的 kind。pnpm exec vitest run packages/session/session-format-v3-to-v4/tests/sources.spec.ts：29 个测试通过。pnpm exec vitest run packages/session/session-title-llm/tests/llm.spec.ts：17 个测试通过。pnpm exec vitest run packages/client/ui-trajectory/tests/event-projection.client.spec.ts：5 个测试通过，其中未知生产者按其持久化 kind 渲染。

<a id="dev-note"></a>
## 开发备注

无。
