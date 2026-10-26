---
description: "jira 包组：jira 工具、CLI 与浏览器段落背后的跨机器 issue 账本，供浏览本组的读者阅读。"
kind: "package-group"
---

# jira/ — 跨机器的 issue 账本

[English](README.md) | 中文

## 概述

`jira` 是跨机器 issue 账本背后的包组：一个由 Markdown 文件组成的本地 git 仓库，DSH agent 跨会话、跨机器读写它。`jira-core` 持有领域与 git 原子，`jira-service` 是唯一写入者，持有 sync 与 `ctx.jira` 服务，`jira-agent` 通过三个工具、注入行与写守卫把账本暴露给模型，`jira-cli` 给人 `jira` 命令，`ui-jira` 增加浏览器段落，`jira-app` 把三行组合成可安装的 bundle。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>

## 包

每行给出包的贡献，以及挂载它的行、入口或组合包。

| 包 | 职责 | 行或入口 |
|---|---|---|
| [`jira-core`](jira-core/README.zh.md) | 账本原子：实体、编解码、带锁事务、git 与 push 原语、派生、doctor、知识库，以及共享的只读查询 | 无行；由其他包 import |
| [`jira-service`](jira-service/README.zh.md) | 唯一写入者：解析根目录、打开存储、持有 push 队列与 settle、注册 `ctx.jira`，并发布 `remote.jira` | 行 `jira-service` |
| [`jira-agent`](jira-agent/README.zh.md) | 模型面：三个 jira 工具、注入行、写守卫、`/jira`、skill 与 turn 结束时的 settle | 行 `jira-agent` |
| [`jira-cli`](jira-cli/README.zh.md) | 人面：带 23 个子命令、退出码与中文输出的 `jira` 命令 | `jira` bin；无行 |
| [`ui-jira`](ui-jira/README.zh.md) | 浏览器面：带账本状态、只读看板、issue 详情与知识搜索的 `jira` 设置页段落 | 行 `jira-ui` |
| [`jira-app`](../bundle/jira-app/README.zh.md) | profile 组合包：在已安装的 profile 上插入 service、agent 与浏览器行 | 组合包 patch |

-----

<a id="related-documentation"></a>

## 相关文档

- [DESIGN.md](DESIGN.md)——账本的决策记录，从外部仓库迁入。
- [HANDOVER.md](HANDOVER.md)——交接与操作记录：当前状态、机器设置与未完成工作。
- [MIGRATION.md](MIGRATION.md)——已执行的三层拆分及其约定。
- [ARCHIVE-SOURCE.md](ARCHIVE-SOURCE.md)——从外部仓库迁入了什么、未迁入什么，以及归档它的退出条件。
- [jira 能力约定](../../goal/jira-contract.md)——拆分背后的服务 API、提供方描述符、配置与 UI 约定。
- [工具子系统](../../docs/subsystems/tools.zh.md)——三个常驻 jira 工具如何注册并渲染结果。
- [系统提示词子系统](../../docs/subsystems/system-prompt.zh.md)——`jira:store` 注入行加入的段装配。
- [Typert 子系统](../../docs/subsystems/typert.zh.md)——为 `ui-jira` 提供 `remote.jira` 方法的生成式 Host-for-Client remote。
- [设置子系统](../../docs/subsystems/settings.zh.md)——`jira` 设置页贡献到的段落注册表。

-----

<a id="dev-note"></a>

## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本组由 `packages/bundle/jira-app/cordis.patch.yml` 与 `packages/bundle/web-app/cordis.patch.uitstalie.yml` 里的三行补丁挂载。这些包是私有的，因此其 API 不承诺上游兼容性；账本数据仓保留自己的历史与 CI。

</details>
