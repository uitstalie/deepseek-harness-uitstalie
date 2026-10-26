---
description: "jira 账本的模型面：dafeiyu 能力提供者，注册 jira_issue、jira_list 与 jira_kb 三个工具、写守卫、/jira 命令、随包 skill 与 turn 结束时的 settle。"
kind: "package-reference"
---

# @deepseek-ai/dsh-jira-agent

[English](README.md) | 中文

## 概述

`dsh-jira-agent` 是账本的模型面：一个 dafeiyu 能力提供者，注册三个常驻工具（带十个动词的 `jira_issue`、`jira_list`、`jira_kb`）、一行 `jira:store` 注入段、单调递增的写守卫、`/jira` 命令、三个 skill，以及 turn 结束时的 settle。它注入 `ctx.jira`、工具注册表与 `ctx.dafeiyu`；命令与 skill 注册表是可选的，因此缺少这些注册表的组合仍保留工具。它按契约版本 2 注册，带 `enabledByDefault: false` 与 `settings.sectionId: 'jira'` 供能力列表使用。账本的位置、机器身份与 push 队列属于 `jira-service` 行，因此这一行没有自己的配置。

## 目录

- [内容](#contents)
- [测试](#tests)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="contents"></a>

## 内容

| 模块 | 负责 |
|---|---|
| `index.ts` | 插件入口：`name` / `inject` / `Config` / `apply`，以及受控再导出 |
| `contribution.ts` | dafeiyu 能力：scope、工具、注入段、agent 钩子、turn 结束时的 settle、dispose |
| `tools.ts` | 三个注册表定义与每次调用的 store/caller 解析 |
| `awareness.ts` | `jira:store` 提示词段及其由 `changed` 驱动的刷新 |
| `wiring.ts` | 写守卫、`/jira` 命令注册与 skill 注册 |
| `toolIssue.ts` / `toolList.ts` / `toolKb.ts` | 工具 schema、描述与 runner |
| `envelope.ts` / `caller.ts` | wire 与实体转换、身份元组、谁在提问 |
| `command.ts` / `skills.ts` | `/jira` 子命令与三个 skill |
| `sessionRecord.ts` | 收尾扫描、push 失败记录与按 apply 的会话记录器 |
| `testing/host.ts` | 接线套件挂载的真实组合测试 harness |

`/jira` 除 `new` 与 `sync` 外是只读的；`sync` 刷新服务自己的队列，而不是另起一个队列。

可写的 root agent 每完成一个 turn 都会 settle 账本：重新生成派生文件并提交，然后由会话收尾记录该会话在它提到的 issue 上做出的提交。只有 service 行打开 push 开关时，成功的 settle 才会安排 push。

<a id="tests"></a>

## 测试

`pnpm test` 运行 `node --test "src/**/*.test.ts"`。接线套件（`index`、`schema`、`surfaces`、`messages`）通过真实 Cordis 上下文挂载已发布的服务——system prompt、tools、dafeiyu、commands、skills 与 `jira-service`——因此它们演练真实的注册，而不是手工搭的宿主。

这些套件通过包的根入口解析 workspace 包，也就是构建后的 `lib/` 入口。在源码 checkout 里先运行 `pnpm run build:artifacts`。

<a id="model-experience"></a>

## 模型体验

### 三个常驻 jira 工具

#### 模型看到什么

root agent（智能体）的每次请求都带三个工具：`jira_issue`（十个动词：`get`、`create`、`update`、`switch_state`、`comment`、`assignee`、`link`、`tag_create`、`close`、`batch_close`）、`jira_list`，以及带 `get`、`search`、`create`、`update` 的 `jira_kb`。它们的描述与 schema 保持精简，每个结果都以文本渲染。子 agent 既拿不到工具也拿不到注入行，因为能力注册为 `scope: 'root'`。不能写入的会话发起的写入会以普通工具结果被拒绝，守卫会更早拒绝，因此不会有处理函数运行。

#### Token 影响

固定 schema 成本，出现在每次 root agent 请求上，外加每次调用的结果文本。子 agent 完全不带这些。

#### KV 缓存影响

在工具定义与可见性不变时前缀稳定。每个结果都是追加在可复用前缀之后的普通工具结果，调用不会让更早的条目失效。

### `jira:store` 注入行

#### 模型看到什么

一个提示词段，名为 `jira:store`，order `700`，渲染为一行：存储的名字、它持有的 project、知识条目与 open issue 数量，以及按机器锚定的只读 project 数量。空账本不渲染任何内容；它只在账本提交（`changed`）时重算，绝不按模型步骤重算。

#### Token 影响

每次 root agent 请求最多一行；空账本不贡献任何内容。

#### KV 缓存影响

只有提交改变计数时文本才变化，因此稳定的账本保持前缀缓存；变化的一行会从该段起重新分词。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **浏览器面属于 `ui-jira`，不属于本包。** agent 拥有工具、注入行与写守卫；`jira` 设置页通过 `remote.jira` 读同一个账本，关闭能力只隐藏模型面。
- **runner 模块仍按深路径 import `jira-core`。** phase-1 桥通过 `ctx.jira.store()` 打开存储；把 runner 迁到服务自己的读/写方法是 phase-2 的后续工作。
- **CLI 一致性断言被拆开。** 独立包在一个测试里比较工具动词与 CLI 命令名。`jira-agent` 不得依赖 `jira-cli`，因此 CLI 保留自己的表/处理函数/用法测试，两个面之间的映射不再受守卫。
- **注入行不再写 workspace 绑定。** 约定里的这一段只写存储及其计数；workspace→project 的说法在独立插件里是 context source。

<a id="dev-note"></a>

### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
