---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-12-superagent-notice-source

[English](2026-11-12-superagent-notice-source.md) | 中文

## 概述

新增 jira-agent 的 context-formed user-message source kind，用于 superagent 工作区定义提醒。该 kind 只承担归因：携带 notice form 与一行 summary，不改变任何已有持久化字段的形状。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-12-superagent-notice-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-09-critical-event-attribution"
    after: "14e2aeb6b9c85cd464a86322e15eff8a9844942e0dc6c2d1bb9a6b44e4cf4675"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-09-critical-event-attribution"
    after: "30284af1b48ef0fd0b5c7fad406a022dd5fb6b320e5f16970fbbdd1424498ba5"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-09-critical-event-attribution"
    after: "4820f1c88a7bd93c9d332db24cb8b4a55d77757dfcaec6a0f1a749f5b50ad744"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-09-critical-event-attribution"
    after: "fb80b645949c6095d7ef524fcc6d08b245fe3a9249ff69a8a3562a79a49139f4"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

没有该插件的读者会把已记录的消息文本当作普通用户消息保留并忽略 source 元数据；提醒不参与重放、校验或授权，因此从未出现过提醒的 Session 行为完全不变。新读者仍能读取全部历史 source kind 与混合日志；缺少该 kind 时保持旧行为。Session header、事件 envelope 与事件版本均不变。

<a id="verification"></a>
## 验证

gen-persistence-catalog 已重建 catalog 与 schema inventory；verify-persistence-changes 记录并校验本确认；jira-agent 套件 227/227 通过（含托管段追加/采纳测试），typecheck 5/5，lint 保持 557 errors / 0 warnings 基线。

<a id="dev-note"></a>
## 开发备注

无。
