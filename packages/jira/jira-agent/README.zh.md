---
description: "jira 账本的模型面：dafeiyu 能力提供者，注册 jira_issue、jira_list 与 jira_kb 三个工具、执行者的 issue_work 工具、认领闭环、写守卫、/jira 命令、随包 skill 与 turn 结束时的 settle。"
kind: "package-reference"
---

# @deepseek-ai/dsh-jira-agent

[English](README.md) | 中文

## 概述

通过 `jira_issue`、`jira_list` 与 `jira_kb` 读取和更新 issue 账本；被派遣的执行者使用 `issue_work`。root agent 还会收到账本提示行、写守卫、`/jira`、三个 skill 与 turn 结束时的 settle。独立开关的 superagent 能力提供认领、状态、来源、派遣与工作区/Session 控制工具。两个能力都接入 `ctx.jira`、工具注册表与 `ctx.dafeiyu`；命令与 skill 是可选的。`jira` 能力默认关闭；`superagent` 要求安全的 `superagent_home`。账本根目录、身份与 push 队列属于 `jira-service`。

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
| `tools.ts` | 注册表定义（root 与执行者两套）与每次调用的 store/caller 解析 |
| `workIssue.ts` | 执行者的工具：它的 schema、范围检查与 runner |
| `superagent.ts` | 认领闭环：可领性判定、提案与认领 |
| `superagent-permission.ts` | 单个目标 workspace Session 的权限目录、当前状态、审计切换与启动默认值 |
| `dispatch-reports.ts` | 超级 agent 自有的报告日志：提示前绑定、保存报告正文、投递失败查询与显式重试 |
| `dispatch-store.ts` | 可选的持久化 `superagent_dispatch` domain、Markdown 投影与迁移 |
| `awareness.ts` | `jira:store` 运行时上下文行及其由 `changed` 驱动的刷新 |
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

`pnpm test` 运行 `node --import tsx --test "src/**/*.test.ts"`。接线套件（`index`、`schema`、`surfaces`、`messages`）通过真实 Cordis 上下文挂载已发布的服务——system prompt、tools、dafeiyu、commands、skills 与 `jira-service`——因此它们演练真实的注册，而不是手工搭的宿主。

tsx loader 经仓库的 tsconfig paths 解析 workspace 包，所以源码 checkout 不需要先构建。在仓库根运行 `pnpm run test:jira` 会执行全部 jira `node:test` 套件与包级 vitest spec；CI 静态门禁运行 `test:jira:node`，vitest spec 由 coverage lane 覆盖。

<a id="model-experience"></a>

## 模型体验

### root 工具与执行者的工具

#### 模型看到什么

root agent（智能体）的每次请求都带三个工具：`jira_issue`（十个动词：`get`、`create`、`update`、`switch_state`、`comment`、`assignee`、`link`、`tag_create`、`close`、`batch_close`）、`jira_list`，以及带 `get`、`search`、`create`、`update` 的 `jira_kb`。被派遣的子 agent 带同样这三个用于读它被派的那条 issue，外加 `issue_work`（`progress`、`deliver`、`blocked`）；它的 `jira_issue` 与 `jira_kb` 写仍被拒，而读的不是注入行，是一段常驻的 `jira:executor` 说明。`issue_work` 只接受处于 in_progress、且指派给「派遣它的那个会话」的 issue，因此子 agent 只写它被派来的那一条，一旦交回复审就什么都写不了。它们的描述与 schema 保持精简，每个结果都以文本渲染。不能写入的会话发起的写入会以普通工具结果被拒绝，守卫会更早拒绝 `jira_issue`，因此不会有处理函数运行。

#### Token 影响

固定 schema 成本，出现在每次 root agent 请求上，外加每次调用的结果文本。子 agent 带的是三个账本 schema 加 `issue_work`，且没有注入行。

#### KV 缓存影响

在工具定义与可见性不变时前缀稳定。每个结果都是追加在可复用前缀之后的普通工具结果，调用不会让更早的条目失效。

### `jira:store` 注入行

#### 模型看到什么

一个提示词段，名为 `jira:store`，order `700`，渲染为一行：存储的名字、它持有的 project、知识条目与 open issue 数量，以及按机器锚定的只读 project 数量。空账本不渲染任何内容；它只在账本提交（`changed`）时重算，绝不按模型步骤重算。

#### Token 影响

每次 root agent 请求最多一行；空账本不贡献任何内容。

#### KV 缓存影响

只有提交改变计数时文本才变化，因此稳定的账本保持前缀缓存；变化的一行会从该段起重新分词。

### 认领闭环

#### 模型看到什么

部署打开 `superagent` 能力时，能力共注册九个工具，按角色分流：普通 root agent 拿到六个（`superagent_source`、`superagent_scan`、`superagent_claim`、`superagent_control`、`superagent_status`、`superagent_dispatch`），而超级 agent（在配置的 `superagent_home` 里打开的会话）拿到五个（`superagent_control`、`superagent_ledger`、`superagent_models`、`superagent_permission`、`superagent_deliver`）。`superagent_scan` 列出当下可领的 issue，`superagent_claim` 提案或认领其中一条，`superagent_status` 报告 ready/proposed/in-progress/in-review/blocked 计数和需要人的条目，`superagent_source` 把所配置 GitHub 仓库里还没见过的 open issue 导入成账本 issue 且从不写回 GitHub，`superagent_control` 列出或修改宿主的 workspace（登记、注销、重命名、列出目录已消失的孤儿登记），并运行和操纵其中的真实 Session，`superagent_ledger` 记录与更新 per-workspace 调度台账，`superagent_models` 列出 workspace Session 可用的 LLM 路由，`superagent_permission` 查看或切换一个显式指定的 workspace Session 的权限，`superagent_deliver` 把一个文件投送到已注册工作区，`superagent_dispatch` 把已认领的 issue 交给一个**真实 Session** 去执行，并把该 Session 以 `[dispatch:session]` 记在 issue 上，于是它还在跑时第二次派遣会被拒——它的 `recover` 动词重启主机重启后丢失的执行者——最后一个只在该行的 `superagent_worker_preset` 指名的 preset 存在时才可用，因为没有 preset 的 Session 会继承派遣方自己的账本写权，而不是只有 `issue_work`。只有当该 issue 最新那条评论仍是本会话自己的提案时才认得动，因此两次调用之间必然要问人一句；并且在会话已经有 `superagent_max_workers` 张单在途时（默认 2）也会拒绝——槽就是一张已认领的单，所以人的会话永远不被计入。每个完成的 root turn 还会以 observe 模式跑一次 pass：提案第一条 ready 的 issue，只写一条 `[claim-proposal]` 评论，永不认领；如果本会话已有进行中的工作，或最新评论已经是提案，则保持沉默。一个进程级、unref 的定时器每五分钟重复一次该 pass，并随能力 dispose 停止；没有 writable 会话时，它可以改为运行可选的**无会话 daemon**（行配置 `superagent_daemon` 与 `superagent_daemon_workspace`）：daemon 以自己的合成身份提案，随后由它自己认领并派遣已确认的提案——因为提案只能由写它的身份认领。被派遣的子 agent，以及加入了所配置 worker preset 的执行者 Session，十者都不带；jira 能力给这两者的是账本读工具 + `issue_work`，外加 `jira:executor` 段。 `superagent_control list` 会报告每个运行中会话的上下文百分比，并对达到 `superagent_compact_threshold_percent`（默认 30）的行标出 `recommendCompact`——这只是建议，是否压缩由超级 agent 决定。

##### 生命周期与报告语义

```markdown
`compact` compacts one Session through the host's manual-compaction seam (the same one `/compact` uses) and refuses while the Session runs, so a task is never interrupted; `append`/`prompt` accept `compact: true` to compact before the text is admitted, `curate_memory: true` to make the workspace Session tidy its own memory first (memory stays per-workspace; this checkout never writes another workspace's store), and a turn report carries the context percentage before and after. `append`/`prompt` also accept `delivery`: `queue` (the default) admits the text after the running turn ends, while `interrupt` steers it into that turn so the Session sees it at its next step without aborting a tool call already in flight. An idle Session queues either way; the result names the delivery actually used, whether it fell back, and the seq it landed at. Every request also carries a refreshed `[superagent monitor]` line when a workspace Session's open turn passes `superagent_long_running_minutes` (default 10), listing its age, last activity and in-flight tool; the super agent decides what to do with it. `inspect` shows a running Session's live status (turn start, elapsed, last activity, in-flight tool) and its recent steps and errors. `abort` cancels a running turn, reports the captured scene, and continues the Session with `text` once it is idle; an idle Session is refused instead of faked. Report routing belongs to the super agent, not to this ledger: every dispatch appends a `pending` binding to `.superagent/reports.jsonl` (child `sessionId`, prompt `requestId`, `superSession`, workspace and instruction) **before** the child prompt is admitted. The turn-end hook matches the ending turn by its own `user/message.source.rpcId`, claims the binding, delivers the report once, and settles it `delivered`; a failed delivery leaves a `failed` record and logs the reason instead of dropping the report. The journal needs no storage-domain composition and survives a reload. The `.superagent/ledger/<workspace-id>.md` projection and the optional `superagent_dispatch` storage domain remain the human-readable, auditable ledger for `superagent_ledger` (one record per task id, `per-record` layout, backed by the base composition's `superagent.sqlite` in the deployment's storages directory); the turn-end hook projects the outcome there best-effort after delivery, so a missing or malformed ledger entry can never suppress a report. The domain records `workspace` (id/title/path), `sessionId`, `superSession`, status/timestamps, outcome, artifacts and decisions. On first open the store imports existing Markdown entries without rewriting them, skips keys already present, and preserves task IDs/timestamps; a repeated open is a no-op. Archive/stop marks pending ledger records `orphanedAt`, retains them for audit, and fails any still-pending report binding for that Session. A host without `storageDomain` (or whose route is unavailable) keeps the Markdown ledger path for record/list/resolve, with no startup failure; reports do not depend on it.
```

##### 派发与监控结果

```markdown
Dispatch and monitoring results include context usage, delivery, status, and task-report fields; business results remain separate from report delivery.
```

#### Token 影响

能力打开时，普通 root agent 的每次请求多六个小 schema（超级 agent 多五个），外加结果文本：候选列表、带派遣说明的已认领 issue、状态计数，或 workspace 清单。

#### KV 缓存影响

能力与其定义不变时前缀稳定；两个能力各开各的门，打开一个不会扰动另一个的工具表。

### 工作区交接与报告

#### 模型看到什么

新的超级工作区会得到一份 `AGENTS.md`：插件只拥有 `superagent:managed` 标记之间的托管段（当前 v1），其中写着角色与派遣约定；标记之外的内容永远不会被改写。能力创建时与每个超级会话打开时都会复查：版本升级只替换托管段，手工改过托管段则保留并发一次可见提醒，文件未变化则完全不写。已注册工作区可以在自己的 `AGENTS.md` 里用 `<!-- superagent:conventions begin -->` 与 `<!-- superagent:conventions end -->` 声明派遣约定；该段会按工作区 id 排序、仅在变化时注入超级 agent 的 runtime context，brief 必须引用它。超级 agent 永远不写这一段——由所属工作区维护；政策判断留在人写在插件托管段之外的文本里。每次派遣向 `.superagent/ledger/<workspace-id>.md` 追加 `pending` 行。turn 结束时，domain 先记录业务 `returned`/`failed`，再独立投递报告；只有成功投递才刷新 Markdown 投影。`superagent_ledger resolve` 结算或修正结果、产物与未决决策；pending 任务必须有非空 outcome，不能改回 pending。`report_status` 列出失败投递及原因，`retry_report` 在接收方恢复后重投保存的原文。派发结果给出台账目录与 Markdown 文件。台账只引用 Jira issue key，Jira 拥有 issue 状态。持久结论由 `memory_write` 保存（MEMORY.md 按工作区隔离、只追加，每行 8 KiB、托管块 16 KiB、每会话 40 条），因此台账使用独立结构化文件。`superagent_control` 的 `start`、`append`、`prompt` 接受可选的 `provider`、`model` 与 `reasoning_effort`；`session.selectModel` 记录选择，append/prompt 在下一轮生效而不 fork，回执包含接受的模型。省略三者则沿用当前默认路由。`superagent_models` 从同一 `llm` 注册表列出路由；workspace Session 没有 subagent 路由白名单。`superagent_deliver` 把报告、表格或 `$DSH_HOME/attachments` 中的附件复制到注册工作区，验证目标位于物理目录内，默认不覆盖。能力把注册工作区加入进程内文件系统的 fs-only 授权，因此 `write`/`edit` 可在其中写入；shell 与终端隔离不变。`superagent_write_registered_workspaces: false` 可恢复单工作区围栏。`remove_workspace` 通过 live registry 注销，保留目录与 Session 日志，并要求 `confirm` 重复目标 id、title 或 path；`rename_workspace` 只改标题。`superagent_control delete` 只在宿主提供真实 Session 擦除 API 时可用；当前宿主只有 `archive`，工具明确拒绝而不伪装成功，`~/.dsh/sessions` 下的 JSONL 保留。

##### 权限建立与切换

```markdown
`superagent_control start` explicitly establishes `workspace-write` before it admits the first task; failure leaves the new Session unprompted and returns an error. `superagent_permission` `list` needs no target, while `get` and `set` require both the registered `workspace` and an exact `session` id. `set` uses the existing permission service, records `permission/preset` plus changed sandbox/approval events, and verifies the effective values. The available presets include `read-only`, `workspace-write`, and `danger-full-access` when configured. `soft` is available only in the unconfined soft-policy composition and selects `guarded`: full process file access with tool/path blacklists, unchanged independent approval policy, and no ACL or OS confinement. It never disables a live OS sandbox. Widening access requires `reason`; the authorized super agent does not need another human approval for each switch.
```
#### Token 影响

派发结果携带工作区、Session、模型、台账与报告路由字段；文件交接还会携带投送后的路径。

#### KV 缓存影响

结果不改写系统提示词。报告作为后续消息到达，选定的路由在下一轮边界生效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **持久化报告日志是派遣的必需条件。** 工具会在报告绑定无法写入时于提示前拒绝；dispatch domain 拥有业务结果，Markdown 台账只是人类可读投影，投影失败不会丢失报告。失败投递可由 `report_status` 查询，`retry_report` 显式重投保存的正文。没有 `storageDomain` 或 SQLite 路径无法打开时，台账回退到 Markdown，而不是阻止启动。已归档/已派遣的记录保留 `orphanedAt`，已归档或停止的 Session 的待处理报告绑定变为 failed；两种存储都不会静默删除审计历史。
- **浏览器面属于 `ui-jira`，不属于本包。** agent 拥有工具、注入行与写守卫；`jira` 设置页通过 `remote.jira` 读同一个账本，关闭能力只隐藏模型面。
- **所有 runner 都走 `ctx.jira`。** 工具模块只从 `jira-core` 的包根 import 类型与展示辅助函数；它们不会在服务背后打开存储、加锁、跑 git 或写文件。`packages/jira/tests/agent-boundary.spec.ts` 是守住这一点的棘轮。
- **派发面同时需要 worker preset 与超级 home。** 行里没配 `superagent_worker_preset` 时 `superagent_dispatch` 直接拒绝；在有人配置 `superagent_home` 之前能力保持关闭。随包发布的 `web-app` 分支层把 `jira-worker` preset 与 `jira-agent` 行配成一对；覆盖该行的部署必须保留这个配对。
- **CLI 一致性断言在本包之外。** `packages/jira/tests/parity.spec.ts` 是不依赖任一运行时的一侧：同时读取本包的工具动词与 `jira-cli` 的命令表，因此两个面得到比较，而无须让任一包依赖另一个。
- **无会话 daemon 需要显式开启，且必须有 checkout。** `superagent_daemon` 默认 false；`superagent_daemon_workspace` 未配置，或缺少 worker preset / session controller 时，daemon pass 不写任何东西。它的 dispatcher 身份是合成的（`agent:daemon|dsh|<machine>|superagent-daemon`），且永不写人类确认。
- **注入行不再写 workspace 绑定。** 约定里的这一段只写存储及其计数；workspace→project 的说法在独立插件里是 context source。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
