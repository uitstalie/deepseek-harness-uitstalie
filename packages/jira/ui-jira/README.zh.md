---
description: "jira 账本的浏览器面：编辑账本行并读取看板、单个 issue 详情与知识搜索的设置页段落；账本本身在这里仍然只读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-jira

[English](README.md) | 中文

## 概述

`dsh-client-ui-jira` 提供 jira 账本的浏览器面：一个设置页段落（`id: 'jira'`、`order: 200`），编辑账本行并读取账本本身——按 status 分组的看板、一个 issue 的详情，以及知识搜索。账本视图仍然只读（写操作留给模型的工具）；行字段可编辑，因为 `jira-service` 把它们声明为 volatile，保存后无需重启即可生效。`dafeiyu` 的 Capabilities 列表按 id 链接到这个段落，因此 id 与 order 是两面都从同一个模块读取的约定。

## 目录

- [页面](#the-page)
- [面](#faces)
- [测试](#tests)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

`dafeiyu` 的 Capabilities 列表按 id（`settings.sectionId: 'jira'`）链接到这个段落，因此 id 与 order 是约定。两面都从 [`src/section.ts`](src/section.ts) 读取它们。

<a id="the-page"></a>

## 页面

| 区块 | 数据 | 写入 |
|---|---|---|
| 账本 | `remote.jira.status()`：根目录、审计 host、push 开关、最近一次 push、排队中的 push | 经设置服务写 `root`、`host`、`push.enabled` |
| 看板 | `remote.jira.board()`：按 status 分组的 issue，blocked 组最后，带计数 | 无 |
| Issue 详情 | `remote.jira.get(key)`：frontmatter 字段与 Markdown 正文 | 无 |
| 知识 | `remote.jira.kbSearch(query)`：排序后的命中及其 `file:line` | 无 |

三个行字段（`root`、`host`、`push.enabled`）在设置区块里编辑。保存经设置服务写入 `jira-service` 的 profile 行；开关立即写入，服务无需重启即可按新值重新打开账本。账本写入仍留给模型：agent 的工具是通向账本唯一的路，`jira-agent` 的守卫约束它们。这里不读账本文件，也不写提交。

页面跟随 `remote.jira.watch(signal)`：每次提交的变更——工具、另一个会话、一次 sync——都会刷新看板、账本状态与已打开的 issue 详情；重连后重读同一批快照，因为不重放。每次读取都带代次，较晚到达的旧答案会被丢弃；通知的 `version` 落后于已应用值时也不会再刷新。知识命中是一次查询的快照：变更只把它们标为过期而不自动重跑，下一次检索会替换它们。这里不轮询、也不监听账本文件。

<a id="faces"></a>

## 面

- `src/index.ts`——宿主入口：一个空插件体加段落身份，因此 `jira-ui` 行经本包加载。
- `src/client/index.ts`——浏览器入口：挂载 `remote.jira`（`jira-service` 生成的 Host-for-Client 产物）、注册 `settings.jira` 文案字典，并把页面贡献到 `settings.section`。
- `src/client/store.ts`——页面控制器：每次加载一次看板读取、每次选择一次详情读取、每次查询一次知识搜索，外加每次 Host 变更后的同一批读取。每次读取一个代次，丢弃晚到的答案；通知的 `version` 丢弃延迟的通告。它只发布纯数据；结构化失败以消息形式到达组件，文案留在字典里。

<a id="tests"></a>

## 测试

- `tests/jira-section.client.spec.tsx`——注册（段落 id/order/标签、dispose）、Host 变更流刷新已打开的页面并随 fiber 停止，以及渲染：状态区块、一行看板、打开与关闭详情、知识搜索的 `file:line` 命中，以及看板读取失败后的重试。Remote 数据通过 store 收窄的 `JiraWire` 注入，因此断言针对的是读者看到的内容。
- `tests/store.client.spec.ts`——不带浏览器的变更路径：看板/状态/详情刷新、晚到的看板与详情答案、知识过期、通知 version 排序、重连，以及未打开的页面不读取。
- `tests/entry.host.spec.ts`——宿主入口作为惰性插件加载并发布段落身份。

用 `pnpm exec vitest run packages/jira/ui-jira` 运行它们。

<a id="model-experience"></a>

## 模型体验

无，因为这里没有任何内容到达模型：页面读的是工具写入的同一个服务，因此读者看到的与模型改的不会不一致，UI 也没有自己的写路径。

#### KV 缓存影响

无；页面从不组装请求，也不贡献提示词文本、工具 schema 或结果。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **看板位置：** 看板、详情与知识搜索渲染在设置页段落内。dock/侧栏看板会是第二个注册（以及设计师的布局），而不是这个段落的另一页。
- **dafeiyu Capabilities 列表：** Jira 行的标签、状态与「打开设置」跳转是 DH-12 的工作；本包只拥有它们链接到的段落。
- **另一进程的写入：** 变更流携带的是本 Host 的写入（工具、会话、sync）。另一个进程里的 CLI 写入在这里不会通告；页面会在下一次本进程内变更、`connection/reset` 或设置段重新挂载时补上。监听账本文件会是第二套变更源，超出本包范围。

<a id="dev-note"></a>

### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
