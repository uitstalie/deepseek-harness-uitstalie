---
description: "superagent 包组：独立于 Jira issue 台账的持久派发状态与报告投递。"
kind: "package-group"
---

# superagent/ — 持久派发状态与报告

[English](README.md) | 中文

## 概述

superagent 包独立于 issue 台账，保存工作区派发绑定、业务结果与报告投递。`superagent-core/` 拥有持久报告 journal、dispatch domain 与恢复操作。调用方可以在重启后恢复已保存的报告并确认已投递结果，而不重新开启失败工作。journal 领取仍是进程内保护；跨进程 ownership 需要独立机制。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx key |
|---|---|---|
| [`superagent-core/`](superagent-core/README.zh.md) | 持久报告 journal、dispatch domain 与启动恢复操作 | 库，无 key |

<a id="related-documentation"></a>
## 相关文档

- [Agent Teams 子系统](../../docs/subsystems/agent-team.zh.md)——共享任务协调；派发结果归属与报告投递保持独立。
- [Jira 包](../jira/README.zh.md)——可选 issue 引用与人可读派发投影。

<a id="dev-note"></a>
## 开发备注

无。
