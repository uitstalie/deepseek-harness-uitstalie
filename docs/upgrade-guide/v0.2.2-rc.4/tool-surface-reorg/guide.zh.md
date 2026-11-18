---
kind: upgrade-guide
description: "JIRA 产品与 super agent 控制/账本工具被移除；会话生命周期移到 workspace_sessions，投递失败与重发移到 workspace_message，本地 JIRA 与派发数据删除后不可恢复。"
---
# JIRA 产品被移除；会话生命周期移到工作区工具集

[English](guide.md) | 中文

## 变更

JIRA 产品一步移除。单据、知识库与列表模型工具，执行器账本工具，认领/派发工具，super agent 控制与账本工具，三个 JIRA 技能，`/jira` 命令与写守卫，以及整个 `packages/jira` 包都不再存在。Web app 组合里的 JIRA 与 super agent 配置行以及 `jira-worker` 预设一并移除。不保留别名或兼容层。

会话生命周期现在由 `workspace_sessions` 承载，动作是 `list`、`get`、`start`、`append`、`prompt`、`stop`、`abort`、`fork`、`archive`、`compact` 与 `delete`。生命周期写入要求 super agent 角色；读取仍对工作区内所有 agent 开放。投递失败状态与重发现在由 `workspace_message` 承载：`status` 报告消息的投递状态、失败原因与尝试次数；`retry` 用同一请求标识重发失败消息。

`personality_apply` 拥有两个全局 personality 文件：只传 `candidates`（画像）或 `writingRules`（规则文件）之一，外加 `confirm: true`。`personality_analyze` 仍对子代理只读。`workspace_artifacts` 通过 `.dsh` store 校验 `.dsh` 路径，并拒绝 `.dsh/memory`。

本地 JIRA 账本 `$DSH_HOME/jira` 与 `.superagent` 下的派发历史在一次性导出到 `D:\dqc\_exports\tool-surface-reorg-20261118` 后删除。它们不可恢复；`workspace_tasks` 从空白开始，不导入旧历史。

## 迁移

1. 把所有 super agent 控制调用改为 `workspace_sessions` 动作（`start`、`append`、`prompt`、`stop`、`abort`、`fork`、`archive`、`compact`、`delete`），把账本调用改为 `workspace_tasks` 或 `workspace_message`。把认领的工作内容放进 `start` 的任务文本；不再有执行器账本工具。
2. 把 `write_like_human({ action, ... })` 改为 `personality_apply({ writingRules: { action, ... }, confirm: true })`。从允许清单与角色矩阵中移除 `write_like_human`。
3. 从 profile、patch 和包清单中移除 JIRA 与 super agent 行、`jira-worker` 预设以及 `@deepseek-ai/dsh-jira-*` 依赖。仍然引用它们的 patch 在加载时报告 `patch: entry ... not found`。
4. 用 `workspace_artifacts.publish` 加 `workspace_message.send` 的引用替换文件交接。用 Host 设置替换权限与模型选择。
5. 如需已删除数据，请在删除原文件前从导出中复制。确认：工具列表不含任何 JIRA 或 super agent 工具；`dsh --profile headless --dump-config` 不显示 JIRA 行或技能；发布 `.dsh/memory` 被拒绝。
