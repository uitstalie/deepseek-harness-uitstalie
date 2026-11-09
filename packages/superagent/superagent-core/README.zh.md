---
description: "用于工作区派发的持久报告 journal，独立于 issue 台账保存任务绑定和投递状态。"
kind: "package-library"
---

# @deepseek-ai/dsh-superagent-core

[English](README.md) | 中文

## 概述

调用方可以在允许工作开始前，把工作区 Session 与 prompt 身份绑定到一次派发，再独立保存和结算它的报告投递，不依赖 issue 台账。journal 保存 pending、delivering、delivered 和 failed 状态及尝试次数、错误，并支持读取失败报告以显式重试。`DispatchStore` 将业务结果持久化到 dispatch domain，并接受显式投影接口来输出人可读内容。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

用 `DispatchReportStore` 指向 super workspace 根目录。调用方必须在允许子 prompt 前记录绑定，在投递前领取并准备报告，再在接收方接受或拒绝后结算结果。journal 位于 `.superagent/reports.jsonl`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

本包包含 journal、dispatch domain 模型及 domain store 的文件操作，不导入 Jira 服务、issue 类型或 Markdown parser。journal 写入按 store 实例串行；新实例可以读取每个任务的最新记录。domain store 通过 `DispatchProjection` 接收旧 Markdown 的导入与投影，业务结果仍保留在 domain。调用方仍负责投递、重试策略与生命周期编排。

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- **单实例不是跨进程锁**——多个 Host 写同一 journal 时，需要独立 ownership 或原子领取机制。
- **投递由调用方编排**——journal 不发送消息、不重启 Session，也不决定失败报告何时重试。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
