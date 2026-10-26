---
description: "jira 账本的人面：带 23 个子命令的 `jira` 命令、退出码与逐字节稳定的中文输出，直接驱动 jira-core，不需要宿主上下文。"
kind: "package-reference"
---

# @deepseek-ai/dsh-jira-cli

[English](README.md) | 中文

## 概述

`dsh-jira-cli` 提供 `jira` 命令：23 个子命令，在 shell 里读写账本，另有 agent 解析的 `--json` 形式。它直接驱动 `jira-core`，不需要宿主、不需要 Cordis 上下文、也不需要 profile，因此账本仓库自己的 CI 可以在普通 checkout 上运行 `jira lint` 与 `jira generate --check`。退出码就是约定：`0` 成功、`1` 账本或 git 失败、`2` 用法错误。`jira-agent` 负责模型侧的等价物；两面共享 `jira-core` 的逻辑与它 `messages` 里的句子。

## 目录

- [命令](#commands)
- [测试](#tests)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="commands"></a>

## 命令

`assignee`、`batch`、`board`、`close`、`comment`、`doctor`、`generate`、`get`、`hooks`、`init`、`kb`、`link`、`lint`、`list`、`machines`、`new`、`project`、`switch`、`sync`、`tag-create`、`tags`、`update`、`verify-commit-msg`。

退出码就是约定：`0` 成功、`1` 账本或 git 失败、`2` 用法错误。输出是中文且逐字节稳定；`--json` 是 agent 读取的机器可读形式。`sync` 使用自己的队列——CLI 是独立进程，不共享宿主的队列。

<a id="tests"></a>

## 测试

`pnpm test` 运行 `node --test "src/**/*.test.ts"`：命令表与注册表的一致性（决策 187），以及一个人会走的进程内路径（`init` → `new` → `list` → `board` → `comment` → `switch` → `doctor` → `sync`），跑在真实的临时存储上。把这些迁移到 vitest 尚未完成。

<a id="model-experience"></a>

## 模型体验

无，因为这是人在 shell 里使用的面：模型侧的等价物是 `jira-agent` 里的 `jira_issue` / `jira_list` / `jira_kb`，两者共享 `jira-core` 的逻辑与它 `messages` 里的句子，因此文案不会在两面之间漂移。

#### KV 缓存影响

无；CLI 不组装请求，也不贡献任何提示词文本、工具 schema 或消息。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- `bin` 指向 `lib/index.js`，只有构建后才存在；源码模式下运行 `jira` 需要构建产物。仓库的应用启动规则要求应用由 profile 启动，因此这个 bin 是账本仓库 CI 的兼容面，而不是受支持的产品入口。
- `bin` 与 `sync` 队列的归属与独立包时相同；把 CLI 并到 `jira-service` 的队列被明确排除在范围之外（CLI 进程无法共享宿主的队列）。

<a id="dev-note"></a>

### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
