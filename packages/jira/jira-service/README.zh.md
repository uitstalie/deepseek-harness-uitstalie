---
description: "jira 账本的唯一写入者：解析根目录、打开存储、持有 push 队列与 settle、注册 ctx.jira 服务，并发布只读的 remote.jira 浏览器面。"
kind: "package-reference"
---

# @deepseek-ai/dsh-jira-service

[English](README.md) | 中文

## 概述

`dsh-jira-service` 是账本的唯一写入者：一行拥有一个账本，解析它的根目录、读取本机身份、打开存储、持有唯一的 push 队列、重新生成派生文件，并在每次提交后发出 `changed`。浏览器、其他能力与 CLI 都通过 `ctx.jira` 共享这个服务，因此一个账本永远不会有两个写入者。它还发布 `remote.jira`，即只读的浏览器面。push 默认关闭：写入先是本地提交，直到 `push.enabled` 打开队列。

## 目录

- [服务](#service)
- [Remote](#remote)
- [配置](#configuration)
- [测试](#tests)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="service"></a>

## 服务

一行 `jira-service` 拥有一个账本：它解析根目录、读取本机身份、打开存储、持有唯一的 push 队列、刷新派生文件，并在提交后发出 `changed`，供画看板或注入行的一方使用。

第二个消费方——UI、另一个能力、一个 shell——通过 `ctx.jira` 共享这个服务；其他任何人都不 push。跨进程时，存储自身的文件锁就是守卫，因此 CLI 可以在宿主会话打开时提交。

`ctx.jira` 实现 [`src/types.ts`](src/types.ts) 里的约定：读方法（`list`、`get`、`board`、`doctor`、`searchKnowledge`）、写方法（`create`、`transact`、`kbCreate`、`kbUpdate`）、`sync` 与 `settle`，以及 `changed` 订阅。每个方法返回 `Result`；错误是带十二个错误码之一的 `JiraError`；权限不在这里判定——`jira-agent` 的守卫在写入到达账本之前就拒绝它。

有两个方法是通往 agent 既有工具 runner 的 phase-1 桥：`store()` 交回已打开的存储，`notifyWrite()` 记录那些 runner 直接做出的写入，因此 `changed` 仍会触发，队列仍会武装。等工具迁到上面的写方法后，两者都会消失。

<a id="remote"></a>

## Remote

`ctx.jiraRemote` 是浏览器面，也是客户端唯一可以调用的东西：它是 `jira` 命名空间里的 Typert remote 服务（`remote.jira`），由这一行自己的构造函数挂在子 fiber 上，因此一行同时用同一个账本回答工具与 UI。

| 方法 | 返回 |
|---|---|
| `status()` | 根目录、审计 host、机器身份、push 开关、最近一次 push 结果、是否已武装 push |
| `board()` | 按 status 分组的 issue，blocked 组最后，带计数 |
| `list(query)` | 同一结果，按 `project`、`status`、`tag`、`tags`、`assignee`、`includeClosed`、`limit` 收窄 |
| `get(key)` | 一个 issue 的 frontmatter 字段与 Markdown 正文 |
| `kbSearch(query, topK?)` | 排序后的知识命中及其 `file:line` |

没有写方法：写入走模型的工具，由 agent 的守卫约束。每个结果都是纯 JSON——branded id、时间戳与身份都以 `string` 到达——因此浏览器不需要账本类型。账本失败会变成 `RemoteError`，其 code 是 `jira/<kebab-code>`（每个 `jira-core` 错误码一个），`details.jiraCode` 是账本自己的错误码；message 是账本格式化后的报告。

<a id="configuration"></a>

## 配置

| 键 | 作用 |
|---|---|
| `root` | 账本根目录；缺省时依次经 `$JIRA_ROOT`、`$DSH_HOME/jira`、profile 的 `.dsh/jira` 解析 |
| `host` | `owner.host` 审计字段；缺省时是本机主机名 |
| `machine_id` | 覆盖 `$DSH_HOME/dsh-jira/machine-id`（从不写进账本） |
| `remote` | 加载时接入的 git remote；仅在本地，绝不 clone 或 fetch |
| `push.enabled` | settle 是否安排 push；默认 false，一切留在本地 |
| `push.debounce_ms` | 防抖窗口；缺省时用 core 的默认值 |

词表（statuses、transitions、priorities、types、resolutions）在这里**不是**配置：它在账本的 `config.md` 里，由 git 管理版本。

<a id="tests"></a>

## 测试

`tests/composition.spec.ts` 通过真实 Loader 启动服务：一份仅测试用的 [`tests/fixtures/cordis.yml`](tests/fixtures/cordis.yml) 在临时账本上插入这一行，测试断言 `ctx.jira` 打开它、报告解析出的根目录与身份，并读取一个 issue 与看板。`tests/remote.spec.ts` 在含一个 issue 与一条知识条目的临时账本上启动同一行，直接调用 Remote 方法：JSON 安全的结果、分组看板、过滤、详情、知识命中，以及两个失败码。两者都用 `pnpm exec vitest run packages/jira/jira-service` 运行。

<a id="model-experience"></a>

## 模型体验

无，因为这里没有任何内容直接到达模型：工具在 `jira-agent` 里，本服务只决定账本在哪里、谁写入、以及提交是否离开这台机器；当 `push.enabled` 打开时，一次成功的 settle 会武装防抖，因此模型的写入先落为本地提交，随后才出发。

#### KV 缓存影响

自身没有；它做出的提交改变的是账本数据，只有 `jira-agent` 决定其中是否有文本重新进入请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- `store()`、`notifyWrite()` 与 `pushQueue()` 是上面描述的 phase-1 桥，不属于长期约定。
- 配置 schema 上没有声明 `.volatile()`（从设置页热更新），因此浏览器设置页可以显示生效值，但不能写这一行：设置服务只编辑插件声明为 volatile 的字段，按 profile 条目 id（`jira-service`）索引。
- `status()` 是同步的，在服务首次打开账本之前把 `machineId` 报为 `local`；要显示身份的客户端先读 `board()`（或任意其他方法）。
- 组合测试覆盖读面；写方法、`sync` 与 `settle` 由 `jira-core` 的套件与 agent 的接线套件覆盖。

<a id="dev-note"></a>

### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
