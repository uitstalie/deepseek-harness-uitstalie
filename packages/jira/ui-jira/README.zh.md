---
description: "jira 账本的浏览器面：显示账本行并读取看板、单个 issue 详情与知识搜索的设置页段落，自身没有写路径。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-jira

[English](README.md) | 中文

## 概述

`dsh-client-ui-jira` 提供 jira 账本的浏览器面：一个设置页段落（`id: 'jira'`、`order: 200`），显示账本行并读取账本本身——按 status 分组的看板、一个 issue 的详情，以及知识搜索。所有视图都是只读：写操作留给模型的工具，设置页会说明这一点，而不是提供一个它无法兑现的控件。`dafeiyu` 的 Capabilities 列表按 id 链接到这个段落，因此 id 与 order 是两面都从同一个模块读取的约定。

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
| 账本 | `remote.jira.status()`：根目录、审计 host、push 开关、最近一次 push、排队中的 push | 无 |
| 看板 | `remote.jira.board()`：按 status 分组的 issue，blocked 组最后，带计数 | 无 |
| Issue 详情 | `remote.jira.get(key)`：frontmatter 字段与 Markdown 正文 | 无 |
| 知识 | `remote.jira.kbSearch(query)`：排序后的命中及其 `file:line` | 无 |

三个行字段（`root`、`host`、`push.enabled`）只展示、不编辑：它们是 `jira-service` 行的配置，而设置服务只写插件声明为 `.volatile()` 的字段。页面说明这一点，而不是提供一个它无法兑现的控件。

写入留给模型：agent 的工具是通向账本唯一的路，`jira-agent` 的守卫约束它们。这里不读文件，也不写提交。

<a id="faces"></a>

## 面

- `src/index.ts`——宿主入口：一个空插件体加段落身份，因此 `jira-ui` 行经本包加载。
- `src/client/index.ts`——浏览器入口：挂载 `remote.jira`（`jira-service` 生成的 Host-for-Client 产物）、注册 `settings.jira` 文案字典，并把页面贡献到 `settings.section`。
- `src/client/store.ts`——页面控制器：一次看板读取、每次选择一次详情读取、每次查询一次知识搜索。它只发布纯数据；结构化失败以消息形式到达组件，文案留在字典里。

<a id="tests"></a>

## 测试

- `tests/jira-section.client.spec.tsx`——注册（段落 id/order/标签、dispose）与渲染：状态区块、一行看板、打开与关闭详情、知识搜索的 `file:line` 命中，以及看板读取失败后的重试。Remote 数据通过 store 收窄的 `JiraWire` 注入，因此断言针对的是读者看到的内容。
- `tests/entry.host.spec.ts`——宿主入口作为惰性插件加载并发布段落身份。

用 `pnpm exec vitest run packages/jira/ui-jira` 运行它们。

<a id="model-experience"></a>

## 模型体验

无，因为这里没有任何内容到达模型：页面读的是工具写入的同一个服务，因此读者看到的与模型改的不会不一致，UI 也没有自己的写路径。

#### KV 缓存影响

无；页面从不组装请求，也不贡献提示词文本、工具 schema 或结果。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **设置写路径：** 页面显示 `root`、`host` 与 `push.enabled`，但无法修改它们。要在这里写，需要 `jira-service` 的 schema 把这些字段声明为 `.volatile()`；在那之前，设置服务没有该行的命名空间，会拒绝写入。
- **看板位置：** 看板、详情与知识搜索渲染在设置页段落内。dock/侧栏看板会是第二个注册（以及设计师的布局），而不是这个段落的另一页。
- **dafeiyu Capabilities 列表：** Jira 行的标签、状态与「打开设置」跳转是 DH-12 的工作；本包只拥有它们链接到的段落。

<a id="dev-note"></a>

### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
