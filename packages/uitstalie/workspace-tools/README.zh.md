---
description: "工作区信息工具集：按已注册工作区限定作用域的 workspace_sessions、workspace_tasks、workspace_message 与 workspace_artifacts 读取，以及它们聚合的持久任务、消息与产物状态。"
kind: "package-reference"
---

# @deepseek-ai/dsh-workspace-tools

[English](README.md) | 中文

## 摘要

`dsh-workspace-tools` 提供工作区信息工具集。它向 `dafeiyu` 组织者注册一个能力，由组织者把工具接到每个 agent 上，因此普通工作区会话与 super agent 共用同一套读取契约。工具集不持有任何已有归属的事实：会话来自 `ctx.sessionQuery`，工作区及其会话账目来自 `ctx.workspaceRegistry`，产物内容来自工作区目录。它只在 `$DSH_HOME/workspaces/<workspace-id>/` 下保存派发任务、消息与产物引用。

## 目录

- [使用本包](#use-this-package)
- [工具](#tools)
- [作用域](#scope)
- [存储](#storage)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发说明](#dev-note)

<a id="use-this-package"></a>

## 使用本包

在组织者、存储、会话查询、文件系统与工作区注册表各行之后挂载本行：

```yaml
- id: workspace-tools
  name: '@deepseek-ai/dsh-workspace-tools'
```

提供者注入 `dafeiyu`、`dshStore`、`sessionQuery`、`workspaceRegistry` 与 `fs`；没有工作区注册表的 profile 会拒绝加载。

<a id="tools"></a>

## 工具

每个工具都以 `minRole: 'subagent'` 注册；调用者的工作区是默认作用域。

| 工具 | 动作 | 结果 |
|---|---|---|
| `workspace_sessions` | `list`、`get` | 会话语义摘要：状态、当前 turn、当前活动、最新进度与任务 id；`get` 另返回近期进度、待收件箱与产物数量 |
| `workspace_tasks` | `list`、`get` | 按状态与 assignee 过滤的任务摘要；`get` 返回任务、其回执、目标会话与产物引用 |
| `workspace_message` | `read` | 按 id 读一条消息，或按目标会话分页读消息，含投递回执与产物引用 |
| `workspace_artifacts` | `list`、`resolve` | 每个产物的最新发布引用，可按会话、任务、kind 或路径前缀过滤；`resolve` 用记录版本比对文件，回答 `ok`、`changed`、`missing` 或 `denied` |

`list` 动作用不透明 cursor 分页，默认 20 条、上限 100 条。摘要会限制文本长度；原始 turn 仍由 `session_event_read` 读取，文件正文仍由 `read` 读取。

<a id="scope"></a>

## 作用域

调用会话的工作区，是注册表中列出该会话的那条账目，或规范路径等于该会话规范 cwd 的已注册工作区。调用只有在给出已注册 id 时才能访问其他工作区，且该读取会写入宿主日志。目录路径、未注册 id 与已注册工作区的子目录都得到同一个拒绝：先把该目录注册为工作区。id 不在已解析工作区账目上的会话在工作区里不可见，因此跨工作区问题不会被隐式回答。

<a id="storage"></a>

## 存储

记录位于 `$DSH_HOME/workspaces/<workspace-id>/` 下：`tasks/<taskId>.json`、`messages/<messageId>.json` 与 `artifacts/<artifactId>.json`。读取时逐文件校验，因为持久记录是不可信边界；与 schema 不符的记录以 `WORKSPACE_RECORD_CORRUPT` 失败，而不是被跳过。产物记录保存每个已发布版本，`resolve` 用所选版本的 SHA-256 与工作区根内的文件比对。

<a id="model-experience"></a>

## 模型体验

### 工作区工具集

#### 模型看到什么

工作区里的每个 agent 都看到这四个工具的固定 schema；本步没有每轮消息，也没有提示词段。结果是受限摘要：一页最多 100 条，活动与进度都是一行字符串，且不返回文件正文或对话记录。`workspace_sessions` 的 `action: 'get'` 回答“上一回合做了什么”：它从会话自己的日志返回近期进度与当前活动，因此模型查询会话存储，而不依赖 memory 通知。

#### Token 影响

agent 可见这些工具时，每次请求的固定 schema 成本，加上每次调用的受限结果。四个 schema 携带 action 枚举、过滤器与 cursor，是这项贡献中最大的固定部分。

#### KV 缓存影响

在工具定义与可见性不变时前缀稳定。每个结果都是追加在可复用前缀之后的普通工具结果，调用不会让更早的条目失效。

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与后续工作

- **本步只有读侧** —— `workspace_tasks.create`/`update`/`receipt`、`workspace_intents`、`workspace_message.send` 与产物的 `publish`/`reference`/`request`/`grant` 在同一设计的后续里程碑中。在此之前，工作区的任务、消息与产物目录可读，但只有后续里程碑写入它们。
- **尚无授权模型** —— `resolve` 对同工作区调用者回答 `ok`，对工作区根外路径回答 `denied`；`pending` 与 `expired` 会随产物授权路径变得可达。
- **状态是推导的，不是存储的** —— `running` 来自 live agent，`done` 来自注册表归档集合，`blocked` 来自最近一次 `turn/end` 原因，其余会话报 `idle`。
- **工作区会话扫描会读每个账目日志** —— `workspace_sessions` 在分页前对账目中每个会话折叠状态，因此会话较多的工作区每次 list 都要为每个日志付费。

<a id="dev-note"></a>

### 开发说明

- `src/api.ts` 注册能力；`src/tools.ts` 固定注册顺序。
- `src/scope.ts` 负责工作区解析与跨工作区记录；`src/store.ts` 负责记录目录及其读取校验；`src/paging.ts` 负责 cursor。
- `tests/workspace-tools.spec.ts` 通过真实 agent loop、组织者、存储、会话查询与文件系统运行，工作区注册表为内存实现。
