---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-18-jira-retirement

[English](2026-11-18-jira-retirement.md) | 中文

## 概述

JIRA 退场移除了 user 与 developer 消息来源中的 `jira-agent` 归因类型。携带它的历史 Session 日志仍可按文本读取；事件封装与 Session 头版本均未改变。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-18-jira-retirement
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-18-remove-critical-event-marker"
    after: "2148e56dbc9e6af522a7f5a4f07405efad7d676d1bb12a02ddb2b6084e5ee643"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-18-remove-critical-event-marker"
    after: "93b0316fa036f88759ac2dd4b0c0f8a4b66aac5c72fd7e3b5689ed0782d475b0"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-18-remove-critical-event-marker"
    after: "4a9f833141f52370b14def53650376c4ddb5f9f42cd8d2f0ff012d02deb71d69"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-18-remove-critical-event-marker"
    after: "3daa71f0b8c8540fac0c3dddb065f85133ddcbe32c922cd189f5934c3b5b3da1"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

旧读取器仍识别 `jira-agent` 类型，并保留记录的文本与元数据。没有该声明的新读取器把未知来源元数据当作不透明数据，同时保留消息正文，这正是被移除的生产者承诺的行为。回放、校验或权限行为都不依赖该类型，因此同一 Session 版本在两个方向都安全。

<a id="verification"></a>
## 验证

记录后运行 `pnpm run verify-persistence-changes`、`pnpm run typecheck`、`pnpm run doc-sync`，以及工作区、角色可见性、personality、memory 与 test-support 套件。

<a id="dev-note"></a>
## 开发备注

无。
