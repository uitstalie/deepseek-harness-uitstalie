---
description: "工作区信息工具集：按已注册工作区限定作用域的 workspace_sessions、workspace_intents、workspace_tasks、workspace_message 与 workspace_artifacts，以及它们聚合的持久任务、意图卡、消息与产物状态。"
kind: "package-reference"
---

# @deepseek-ai/dsh-workspace-tools

[English](README.md) | 中文

## 摘要

`dsh-workspace-tools` 提供工作区信息工具集。它向 `dafeiyu` 组织者注册一个能力，由组织者把工具接到每个 agent 上，因此普通工作区会话与 super agent 共用同一套契约。工具集不持有任何已有归属的事实：会话来自 `ctx.sessionQuery`，工作区及其会话账目来自 `ctx.workspaceRegistry`，产物内容来自工作区目录。它只在 `$DSH_HOME/workspaces/<workspace-id>/` 下保存派发任务及其回执、意图卡及其版本、消息与产物引用。

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

每个工具都以 `minRole: 'subagent'` 注册；调用者的工作区是默认作用域。读取对所有 agent 开放；变更在工具内部检查调用者角色。

| 工具 | 动作 | 结果 |
|---|---|---|
| `workspace_sessions` | `list`、`get` | 会话摘要：状态、当前 turn、当前活动、最新进度与任务 id；`get` 另返回近期进度、待收件箱与产物数量 |
| `workspace_tasks` | `list`、`get`、`create`、`update`、`receipt` | 按状态与 assignee 过滤的任务摘要；`get` 返回任务、其回执、目标会话与产物引用；`create` 要求 active 意图卡与覆盖映射；`update` 推进状态机；`receipt` 追加对齐清单 |
| `workspace_message` | `read` | 按 id 读一条消息，或按目标会话分页读消息，含投递回执与产物引用 |
| `workspace_artifacts` | `list`、`resolve` | 每个产物的最新发布引用，可按会话、任务、kind 或路径前缀过滤；`resolve` 用记录版本比对文件，回答 `ok`、`changed`、`missing` 或 `denied` |
| `workspace_intents` | `create`、`get`、`confirm`、`correct`、`history`、`metrics` | 一个意图卡版本，含带来源标注的目标、验收、边界与产出形式条目；`confirm` 与 `correct` 追加状态；`history` 分页版本；`metrics` 汇总派发对齐 |

`list` 动作用不透明 cursor 分页，默认 20 条、上限 100 条。摘要会限制文本长度；原始 turn 仍由 `session_event_read` 读取，文件正文仍由 `read` 读取。

`workspace_tasks.create` 必须带 `intentId`、`intentVersion`、`workspace`、`acceptance`、`boundaries` 与六类 `taskType`。缺字段或缺卡返回 `INTENT_INCOMPLETE`，`proposed` 版本返回 `INTENT_UNCONFIRMED`，被 supersede 或非当前版本返回 `INTENT_STALE`，跨工作区的卡返回 `INTENT_SCOPE_MISMATCH`，未覆盖的卡点返回 `INTENT_COVERAGE_MISSING`。覆盖没有默认通过：卡里每个点都需要一条覆盖条目或一条显式 `nonCoverage` 理由。`receipt` 为卡里每个点追加一条带证据的对齐条目；`not_satisfied` 的验收点或 `violated` 的边界会把任务转入 `waiting_review` 或 `blocked`，绝不进入 `done`。

<a id="scope"></a>

## 作用域

调用会话的工作区，是注册表中列出该会话的那条账目，或规范路径等于该会话规范 cwd 的已注册工作区。调用只有在给出已注册 id 时才能访问其他工作区，且该读取会写入宿主日志。目录路径、未注册 id 与已注册工作区的子目录都得到同一个拒绝：先把该目录注册为工作区。id 不在已解析工作区账目上的会话在工作区里不可见，因此跨工作区问题不会被隐式回答。

`workspace_intents` 遵循同一作用域。一张卡只属于一个工作区；跨工作区请求会在每个目标工作区各建一张卡，且每张卡逐字保留用户原话。读取其他工作区的卡需要显式 id，并会被记录。任务引用别的工作区的卡时以 `INTENT_SCOPE_MISMATCH` 拒绝。

意图卡的 `create`、`confirm` 与 `correct` 需要 super agent 角色或用户；普通 agent 只读卡。在卡片 UI 出现之前，用户决定经由 super agent 进入存储。任务创建、任务状态变更与派发者记录的 assignee 需要 super agent；被指定为任务目标会话的会话可以更新该任务并追加自己的回执。每次变更都带 request id，因此重试不会重复写入卡版本、任务或回执。

<a id="storage"></a>

## 存储

记录位于 `$DSH_HOME/workspaces/<workspace-id>/` 下：`tasks/<taskId>.json`、`messages/<messageId>.json`、`artifacts/<artifactId>.json`，以及 `intents/<intentId>/` 下的 `index.json` 与 `versions/<n>.json`。读取时逐文件校验，因为持久记录是不可信边界；与 schema 不符的记录以 `WORKSPACE_RECORD_CORRUPT` 失败，而不是被跳过。产物记录保存每个已发布版本，`resolve` 用所选版本的 SHA-256 与工作区根内的文件比对。

卡索引保存每个版本的当前状态、最新 active 版本、逐条确认时间与版本列表；每个版本文件保存不可变的卡内容，从不重写。纠正追加一个版本，并让被 supersede 的旧版本仍可读；确认只改索引。`proposed` 版本携带一个带稳定 id 的汇总确认请求。意图 id 由工作区与其幂等键推导，因此重试的 create 返回它已经写过的版本。

<a id="model-experience"></a>

## 模型体验

### 工作区工具集

#### 模型看到什么

工作区里的每个 agent 都看到这五个工具的固定 schema；本步没有每轮消息，也没有提示词段。结果是受限摘要：一页最多 100 条，活动与进度都是一行字符串，且不返回文件正文或对话记录。`workspace_sessions` 的 `action: 'get'` 回答“上一回合做了什么”：它从会话自己的日志返回近期进度与当前活动，因此模型查询会话存储，而不依赖 memory 通知。

`workspace_intents.get` 返回卡版本，并为每个条目给出稳定 point id，因此 `create` 与 `receipt` 能直接指名某个点而不用重复其文本。`proposed` 版本返回它的确认请求；在版本变 active 之前，任务无法派发。`workspace_tasks.get` 返回每条回执记录的对齐清单，因此漂移会以列表形式出现。

#### Token 影响

agent 可见这些工具时，每次请求的固定 schema 成本，加上每次调用的受限结果。五个 schema 携带 action 枚举、过滤器、卡条目、覆盖与对齐，是这项贡献中最大的固定部分。

#### KV 缓存影响

在工具定义与可见性不变时前缀稳定。每个结果都是追加在可复用前缀之后的普通工具结果，调用不会让更早的条目失效。

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与后续工作

- **本步没有卡片 UI** —— `confirm` 与 `correct` 是模型可调用的，且需要 super agent，由它记录对话送达的用户决定。没有 super agent 或卡片 UI 时，`proposed` 版本无法激活。`workspace_message.send` 与产物的 `publish`/`reference`/`request`/`grant` 仍是同一设计的后续里程碑。
- **尚无授权模型** —— `resolve` 对同工作区调用者回答 `ok`，对工作区根外路径回答 `denied`；`pending` 与 `expired` 会随产物授权路径变得可达。
- **状态是推导的，不是存储的** —— `running` 来自 live agent，`done` 来自注册表归档集合，`blocked` 来自最近一次 `turn/end` 原因，其余会话报 `idle`。
- **工作区会话扫描会读每个账目日志** —— `workspace_sessions` 在分页前对账目中每个会话折叠状态，因此会话较多的工作区每次 list 都要为每个日志付费。

<a id="dev-note"></a>

### 开发说明

- `src/api.ts` 注册能力；`src/tools.ts` 固定注册顺序。
- `src/scope.ts` 负责工作区解析与跨工作区记录；`src/store.ts` 负责任务、消息与产物目录及其读取校验；`src/intent-store.ts` 负责追加式意图卡；`src/intent-rules.ts` 负责来源规则、point id、覆盖与对齐；`src/paging.ts` 负责 cursor。
- `tests/workspace-tools.spec.ts` 与 `tests/intents.spec.ts` 通过真实 agent loop、组织者、存储、会话查询与文件系统运行，工作区注册表为内存实现。
