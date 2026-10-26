---
description: "jira 账本的原子层：实体、issue/v1 编解码、带锁写事务、git 与 push 原语、派生、知识库、doctor 与 lint 报告，以及 CLI 与服务共享的只读查询。"
kind: "package-reference"
---

# @deepseek-ai/dsh-jira-core

[English](README.md) | 中文

## 概述

`dsh-jira-core` 存放 jira 账本的原子能力：issue、project、machine 与 tag 模型，`issue/v1` frontmatter 编解码，两级 `mkdir` 锁与 compare-and-set 写事务，git、rebase 与防抖 push 原语，派生出的 `BOARD.md`/`index.md`/`log.md`，doctor 与 lint 报告，知识库，以及 CLI 与服务共享的只读查询。它只 import `node:*` 与自身相对模块——不 import 任何 `@deepseek-ai` 包——因此 CLI 与测试可以直接运行它，不需要宿主上下文。`jira-agent` 把这些原子组合成模型工具，面向人的中文句子只写在一个 `messages` 模块里，两面 import 同一份字符串。

## 目录

- [模块](#modules)
- [测试](#tests)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

账本本身是另一个独立的 git 仓库，由 Markdown 文件组成。[DESIGN.md](../DESIGN.md)（决策记录）与 [HANDOVER.md](../HANDOVER.md)（交接与操作记录）放在上一级 `packages/jira/`，因为错误码测试把决策行读作它的定义。

<a id="modules"></a>

## 模块

| 入口（经 `@deepseek-ai/dsh-jira-core`） | 负责 |
|---|---|
| `entities` | issue/project/machine/tag 键、时间戳、身份，issue、comment 与 project 值 |
| `codec` | `issue/v1` frontmatter 文档：decode、encode、round-trip |
| `store` | 存储创建、`storePaths`、词表、`transact`（两级锁、CAS、审计身份、提交） |
| `git`, `rebase`, `push`, `lock` | 注入身份与超时的子进程 git、`pull --rebase`、防抖 push 队列、`mkdir` 锁原语 |
| `generate`, `generateStore` | 派生出的 `BOARD.md`/`index.md`/`log.md`/`tags/index.md`、源树哈希、重生成并提交 |
| `doctor`, `lint`, `inspect` | 一致性报告，以及 CLI 与服务共享的只读查询 |
| `kb`, `kbstore`, `kbsearch` | 知识键、知识文档的创建与更新、`file:line` 搜索 |
| `messages` | 每条面向人的句子唯一的书写处 |
| `result`, `errors` | `Result`、`JiraError` 及其十二个错误码 |

`src/index.ts` 是受控的再导出面。包也把自己的 `src/*.ts` 暴露为 `./*`；只有 `jira-cli` 使用它，因为一条 CLI 命令需要与服务相同的原子。

<a id="tests"></a>

## 测试

`pnpm test` 运行 `node --test "src/**/*.test.ts"`——测试套件从独立插件仓库原样搬来，仍使用 Node 测试运行器。把它迁移到仓库的 vitest 配置尚未完成。

`fixtures/config.md` 是账本仓库 `config.md` 的逐字副本；两者必须一起修改（决策 189）。

<a id="model-experience"></a>

## 模型体验

无，因为这里没有任何内容到达模型：`jira-agent` 把这些原子组合成工具，面向人的中文句子在 [`src/messages.ts`](src/messages.ts) 与各渲染器里，两面 import 同一份字符串。

#### KV 缓存影响

无；本包不组装请求，也不贡献任何提示词文本、工具 schema 或消息。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- `messages.test.ts`（决策 184：两面都不得逐字重述文案）位于 `jira-agent/src/messages.test.ts`，因为它要读两棵源树。
- `surfaces.test.ts`（CLI ⊇ 工具动词的对照表）位于 `jira-agent/src/surfaces.test.ts`，因为它横跨 `jira-cli` 与 `jira-agent`。

<a id="dev-note"></a>

### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
