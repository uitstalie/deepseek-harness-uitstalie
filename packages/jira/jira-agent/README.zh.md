---
description: "jira 账本的模型面：dafeiyu 能力提供者，注册 jira_issue、jira_list 与 jira_kb 三个工具、执行者的 issue_work 工具、认领闭环、写守卫、/jira 命令、随包 skill 与 turn 结束时的 settle。"
kind: "package-reference"
---

# @deepseek-ai/dsh-jira-agent

[English](README.md) | 中文

## 概述

`dsh-jira-agent` 是账本的模型面：一个 dafeiyu 能力提供者，在 root agent 上注册 `jira_issue`、`jira_list` 与 `jira_kb`，在被派遣的子 agent 上注册 `issue_work`，另有 `jira:store` 注入行、单调写守卫、`/jira` 命令、三个 skill 与 turn 结束时的 settle。第二个独立开关的 `superagent` 能力加上认领闭环（`superagent_scan`、`superagent_claim`、`superagent_status`、`superagent_workspace`、`superagent_dispatch`、`superagent_source`）。它注入 `ctx.jira`、工具注册表与 `ctx.dafeiyu`；命令与 skill 注册表是可选的。两个能力都按契约版本 2 注册，`settings.sectionId` 分别是 `jira` 与 `superagent`；`jira` 能力默认关闭，而 `superagent` 只在行配置了安全的 `superagent_home` 时默认开启。账本的根目录、身份与 push 队列属于 `jira-service` 行。

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
| `dispatch-reports.ts` | 超级 agent 自有的报告日志：提示前绑定、只投递一次、失败结算 |
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

部署打开 `superagent` 能力时，能力共注册十一个工具，按角色分流：普通 root agent 拿到六个（`superagent_source`、`superagent_scan`、`superagent_claim`、`superagent_workspace`、`superagent_status`、`superagent_dispatch`），而超级 agent（在配置的 `superagent_home` 里打开的会话）拿到六个（`superagent_workspace`、`superagent_session`、`superagent_ledger`、`superagent_models`、`superagent_permission`、`superagent_deliver`）。`superagent_scan` 列出当下可领的 issue，`superagent_claim` 提案或认领其中一条，`superagent_status` 报告 ready/proposed/in-progress/in-review/blocked 计数和需要人的条目，`superagent_source` 把所配置 GitHub 仓库里还没见过的 open issue 导入成账本 issue 且从不写回 GitHub，`superagent_workspace` 列出或修改宿主的 workspace（登记、注销、重命名、列出目录已消失的孤儿登记），`superagent_session` 运行并操纵真实的 workspace Session，`superagent_ledger` 记录与更新 per-workspace 调度台账，`superagent_models` 列出 workspace Session 可用的 LLM 路由，`superagent_permission` 查看或切换一个显式指定的 workspace Session 的权限，`superagent_deliver` 把一个文件投送到已注册工作区，`superagent_dispatch` 把已认领的 issue 交给一个**真实 Session** 去执行，并把该 Session 以 `[dispatch:session]` 记在 issue 上，于是它还在跑时第二次派遣会被拒——它的 `recover` 动词重启主机重启后丢失的执行者——最后一个只在该行的 `superagent_worker_preset` 指名的 preset 存在时才可用，因为没有 preset 的 Session 会继承派遣方自己的账本写权，而不是只有 `issue_work`。只有当该 issue 最新那条评论仍是本会话自己的提案时才认得动，因此两次调用之间必然要问人一句；并且在会话已经有 `superagent_max_workers` 张单在途时（默认 2）也会拒绝——槽就是一张已认领的单，所以人的会话永远不被计入。每个完成的 root turn 还会以 observe 模式跑一次 pass：提案第一条 ready 的 issue，只写一条 `[claim-proposal]` 评论，永不认领；如果本会话已有进行中的工作，或最新评论已经是提案，则保持沉默。一个进程级、unref 的定时器每五分钟重复一次该 pass，并随能力 dispose 停止；没有 writable 会话时，它可以改为运行可选的**无会话 daemon**（行配置 `superagent_daemon` 与 `superagent_daemon_workspace`）：daemon 以自己的合成身份提案，随后由它自己认领并派遣已确认的提案——因为提案只能由写它的身份认领。被派遣的子 agent，以及加入了所配置 worker preset 的执行者 Session，十者都不带；jira 能力给这两者的是账本读工具 + `issue_work`，外加 `jira:executor` 段。 `superagent_session list` 会报告每个运行中会话的上下文百分比，并对达到 `superagent_compact_threshold_percent`（默认 30）的行标出 `recommendCompact`——这只是建议，是否压缩由超级 agent 决定。`compact` 通过宿主的手动压缩接缝（与 `/compact` 同一条）压缩一个会话，会话运行中会拒绝，因此绝不打断任务；`append`/`prompt` 可以带 `compact: true` 先压缩再投递，带 `curate_memory: true` 让该工作区会话先整理自己的记忆（记忆是 per-workspace 的，这里绝不写别的工作区的存储），回合回报会带上压缩前后的上下文百分比。 `append`/`prompt` 还接受 `delivery`：`queue`（默认）等当前 turn 结束再作为新 turn 投递；`interrupt` 把指令 steer 进正在跑的 turn，让会话在下一个 step 看到，且不中止已经在执行的工具调用。会话空闲时两种都会排队；结果会写明实际用的投递方式、是否回退，以及落地的 seq。 当某个工作区会话的 turn 超过 `superagent_long_running_minutes`（默认 10 分钟）时，每次请求还会带上刷新过的 `[superagent monitor]` 行（年龄、最后活动、在跑的工具），由超级 agent 自己判断怎么处理。`inspect` 展示运行中会话的实时状态（turn 开始时间、已运行多久、最后活动、在跑工具）与最近步骤/错误；`abort` 中止当前 turn、回报抓到的现场，并在其空闲后用 `text` 继续；空闲会话会被拒绝，不会假装中止。 新的 super workspace 会写入一份 `AGENTS.md` 定义（已存在则保留人的修改），之后开在该目录的会话都会读到角色与派发约定，而不是只靠能力提示词。报告路由属于超级 agent，而不是这份台账：每次派发在子会话提示被接受**之前**向 `.superagent/reports.jsonl` 追加一条 `pending` 绑定（子 `sessionId`、提示 `requestId`、`superSession`、工作区与指令）。turn end 钩子按该 turn 自己的 `user/message.source.rpcId` 匹配、抢占、只投递一次并结算为 `delivered`；投递失败会留下 `failed` 记录并记录原因，而不是静默丢弃。该日志不依赖 storage domain，也能跨重载恢复。`.superagent/ledger/<workspace-id>.md` 投影与可选的 `superagent_dispatch` 存储域仍是 `superagent_ledger` 的人类可读、可审计台账；turn end 钩子在投递后尽力把结果投影过去，因此台账缺失或损坏都不会抑制报告。每次派发向台账追加一条 `pending`；`superagent_ledger resolve` 再补结论、产物与未决决策。台账只引用 jira issue key，不复制 issue 状态。durable 结论交给 `memory_write`（super workspace 的 MEMORY.md 是 per-workspace、append-only、单行 8 KiB、managed block 16 KiB、每 session 40 条），所以调度台账单独用结构化文件，而不硬塞进 memory。 `superagent_session` 的 `start`、`append`、`prompt` 接受可选的 `provider`、`model`、`reasoning_effort`（与 `subagent` 同名）。宿主的 `session.selectModel` 会记录 Session 的模型选择，所以 append/prompt 可以在**下一轮**切换而不 fork；回执带上 host 接受的 `model`。三个字段都省略则沿用当前/default 路由。`superagent_models` 从同一个 `llm` 注册表列出 provider、该 provider 的 model，或某个 model 的 reasoning efforts；workspace Session 没有 subagent 的 route allowlist，列出的就是部署实际可路由的面。 `superagent_deliver` 是超级 agent 对工作区目录的唯一写入：宿主进程把文件（报告、xlsx/csv、或用户放在 `$DSH_HOME/attachments` 下的附件）复制进已注册工作区，校验目标落在该工作区的物理目录内，并且除非 `overwrite` 为 true，否则不覆盖已有文件。能力把已注册工作区贡献给 in-process 文件围栏的 fs-only 白名单，所以 `write`/`edit` 也能写进去；shell 与 terminal 的围栏不变，这也是 Windows ACL 这类无法表达额外根的主机还能正常工作的原因。把 `superagent_write_registered_workspaces` 设为 false 可退回单工作区围栏。 workspace 工具的 `remove` 走 live registry，而不是存储文件：它只注销登记，保留目录和所有 Session 日志，并要求 `confirm` 重复目标 id、title 或 path；`rename` 只改显示标题。`superagent_session delete` 只在宿主提供真正 Session 删除 API 时可用。当前宿主只有 `archive`，所以工具会明确拒绝而不是假装删除，`~/.dsh/sessions` 下的持久 JSONL 仍在。
`superagent_session start` 在投递首个任务前显式建立 `workspace-write`；失败时新 Session 不接收任务并返回错误。`superagent_permission` 的 `list` 不需要目标，`get` 与 `set` 必须同时给出已注册的 `workspace` 和精确的 `session` id。`set` 通过现有权限服务写入 `permission/preset` 及变化的 sandbox/approval 事件，并验证生效值。配置提供时可选择 `read-only`、`workspace-write` 与 `danger-full-access`。`soft` 只在无 OS 隔离的软策略组合里可用，映射到 `guarded`：进程保留完全文件权限，以工具/路径黑名单限制模型工具，审批策略独立不变，不使用 ACL 或 OS 隔离；它不会禁用仍在运行的 OS 沙盒。扩大权限需要 `reason`；已授权的 super agent 不必为每次切换再获得人工批准。

#### Token 影响

能力打开时，普通 root agent 的每次请求多六个小 schema（超级 agent 是六个），外加结果文本：候选列表、带派遣说明的已认领 issue、状态计数，或 workspace 清单。

#### KV 缓存影响

能力与其定义不变时前缀稳定；两个能力各开各的门，打开一个不会扰动另一个的工具表。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **持久化报告日志是派遣的必需条件。** 工具会在报告绑定无法写入时于提示前拒绝；`superagent_dispatch` 与 Markdown 台账只是可审计的投影，台账失败不会丢失报告。没有 `storageDomain` 或 SQLite 路径无法打开时，台账回退到 Markdown，而不是阻止启动。已归档/已派遣的记录保留 `orphanedAt`，已归档或停止的 Session 的待处理报告绑定变为 failed；两种存储都不会静默删除审计历史。
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
