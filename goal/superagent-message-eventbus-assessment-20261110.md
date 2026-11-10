# Super agent 消息传递机制评估：现状是不是事件总线，以及要不要改

> 调查日期 2026-11-10；只读调查，不是实施方案。
> 源码基线：2026-11-10 调查开始时的基线（`HEAD = origin`）。调查期间他人推进了本地 HEAD：
> `DH-909` 改 `packages/uitstalie/memory/**`，`DH-910` 改
> `packages/jira/jira-agent/src/superagent-permission.ts`。调查时
> 对比基线与 HEAD 只列出这三个文件，本文引用的其余文件在该区间
> 无改动，行号仍对应当前树。本调查**未读取、未使用、未改动**这两处。
>
> 证据标记：
> - **【代码】** 直接在当前源码读到的事实，附 `文件:行号`。
> - **【文档】** 仓库文档或测试声明的结论，附出处；不代替代码复核。
> - **【推断】** 由代码路径推出、但我没有构造运行验证的结论。
> - **【未验证】** 没有证据，或只有间接证据。
>
> 本次未运行测试、未跑构建、未注入故障；下文“代码里有”不等于“实机验证过”。

---

## 0. 结论先行

1. **不是事件总线。** 现在的“消息传递”是三层拼起来的东西：**进程内直接方法调用**
   （`controller.create/prompt/list`）+ **会话日志里的耐久 inbox 追加**
   （`agent/inbox/spliced`）+ **宿主生命周期事件触发**
   （`session/event` → `turn/end` → 插件 `onTurnEnd`）。真正承担“不丢”的是会话 JSONL 和
   `.superagent/reports.jsonl`，不是任何总线。
2. **DSH 里确实有一条事件总线，但它只用于观察/触发，不用于传输消息。**
   `ctx.events`（Cordis，`ctx.on/emit/serial/parallel/waterfall`）是进程内、同步扇出、
   不持久、不重放、无 ack 的观察者总线；`session/event` 是“已经写进日志的事实”的广播。
   报告消息的**投递**从不经过它们，只有**回流触发**经过 `session/event`。
3. **现在的可靠性不是靠总线，而是靠一个 per-dispatch journal 状态机 + 文件 lease +
   启动恢复 + 显式重试**（`.superagent/reports.jsonl`、`claims/*.json`）。它已经是
   “outbox”的形状，只是还没有把“投递回执”和“启动对账”补完整。
4. **最该先修的不是“换成总线”，而是两处确认缺口**：报告被 settle 为 `delivered` 时，
   接收方会话日志可能还没落盘（最多 200 ms 批窗口）；以及“有 pending 绑定、但没有保存
   报告文本”的记录永远不会自动收敛。总线不会修这两个问题。
5. **建议“部分事件化”，不换总线**：把消息变成可识别的一等对象（`MessageSourceMap`
   增加 superagent 来源 kind，需扩展宿主 `controller.prompt` 的请求形状）、给 journal 补
   投递回执（`insertedAtSeq` + flush；`messageId` 需宿主接口一并暴露）、补启动对账与
   pending 可见性；Cordis 事件只用作“journal 状态变更后的通知”。粗估 7–13 人日；
   完整重构为通用消息总线约 30+ 人日，不建议。

> 每条结论的证据等级（【代码】/【文档】/【推断】/【未验证】）见 §1–§3；本节只是压缩后的判断。

---

## 1. 现状机制：从派活到回流，每一跳

### 1.1 全景

```
超管模型（super workspace 里的 root Session）
  │  superagent_control { action: start|append|prompt, ... }        [tool call]
  ▼
jira-agent / superagent.ts  runSessionTool
  │  ① recordDispatchReport → <superHome>/.superagent/reports.jsonl  (pending)
  │     （裸组合没有注入 journal 时回退到 <caller.cwd>，见 §3.2 G5）
  │  ② controller.create({workspaceId}) / controller.prompt(...)
  ▼
session-controller（同进程 Cordis service）
  │  SessionController.prompt → Commands.prompt → agent.followup / agent.steer
  ▼
agent-loop inbox（耐久队列）
  │  session.append('agent/inbox/spliced', ...)                     [会话日志 append]
  │  session/event (Cordis emit) → persistence JSONL / UI / telemetry / dafeiyu
  ▼
目标 workspace Session
  │  turn/start → user/message(source.rpcId = requestId) → … → turn/end
  │  session/event → dafeiyu 组织者（观察到 turn/end）
  ▼
dafeiyu → jira-agent contribution.onTurnEnd → handleTaskTurnEnd
  │  journal.forSession + claim（文件 lease）
  │  prepare(reportText/outcome) → controller.prompt(superSession, mode:'queue')
  ▼
超管 Session 的 inbox（next-turn）
  │  agent/inbox/spliced → 新回合 → 超管模型看到 `[task-report] …`
```

一句话：**上行是“工具调用 + 直接 prompt”；下行是“turn/end 事件触发 + 再直接 prompt”；
两边的耐久性分别由会话日志和报告 journal 提供。**

### 1.2 跳 1：超管发起——工具调用与目标选择

入口是 `superagent_control` 的 `run`：

- 工具注册与 action 分发：`packages/jira/jira-agent/src/superagent.ts:526-569`（`runControlTool`）。
- 真正执行三个动作的是 `runSessionTool`：`superagent.ts:2735-3202`。
- 目标由**显式地址**决定，不是广播：
  - `start`：`controller.create({ workspaceId })` 创建一个挂在目标 workspace 下的真实 Session
    （`superagent.ts:3017-3022`）。
  - `append`：先 `controller.list()`，再按 `cwd` 过滤该 workspace 的 Session；必须显式给
    `session`（或 `"latest"`），否则拒绝，理由是“绝不猜”（`superagent.ts:2835-2888`）。
  - `prompt`：直接按 `session` id 投递（`superagent.ts:3101-3162`）。
- 报告接收者是**调用者自己的 Session**：`reportTo = me.session`（`superagent.ts:2760-2761`），
  没有“注册一个 super agent 地址”这一步；谁调用的，报告就回谁。`me` 来自工具调用上下文
  （`packages/jira/jira-agent/src/tools.ts:137-150`）。
- 每次派发在 prompt 之前先写一条 journal 绑定：`recordDispatchReport`
  （`superagent.ts:985-1011`；调用点 `3054`、`2913`、`3148`）。写失败就拒绝派发，不进入 prompt。

这一跳的性质：**进程内直接调用**（`controller.create/list/prompt`），**没有经过事件总线**。

### 1.3 跳 2：宿主受理——`prompt` 如何变成会话输入

- `superagent_control` 拿到的 `sessionController` 是 Cordis 服务：
  `sessionControllerOf(ctx)` 用 `ctx.get('sessionController')` 读取
  （`superagent.ts:4399-4408`）；接口是鸭子类型 `SessionControllerLike`
  （`superagent.ts:4333-4392`）。`@Remote` 装饰器只**标记**方法供远程 gateway 暴露，
  方法本身仍是普通实例方法（`packages/typert/protocol/src/index.ts:282-317`）。
  因此这里的 `controller.prompt(...)` 是**同进程直接调用**，不是 RPC。
- 宿主实现：`SessionController.prompt`（`packages/api/session-controller/src/index.ts:467-492`）
  → `SessionCommandController.prompt`（`packages/api/session-controller/src/commands.ts:321-387`）。
- 投递方式：
  - `mode: 'queue'` → `agent.followup(message)`（`commands.ts:373-374`）；
  - `mode: 'steer'` → `agent.steer(message)`（同一处）。
  - `source` 是 `kind: 'user'`，`rpcId` 就是工具层传来的 `requestId`
    （`session-controller/src/index.ts:485-490`）；`hasPromptRequest` 用这个 `rpcId` 做
    重复受理判断（`commands.ts:323`、`348`、`363`、`390-413`）。
- 关键点：**消息的“类型”没有专门的 superagent kind**。目标 Session 看到的是一条普通
  user 消息；唯一的机器标记是 `requestId` 前缀 `superagent-*` 和正文前缀。这一点在 §3.2
  会作为归因缺口展开。

### 1.4 跳 3：inbox 注入与会话日志——消息真正“落地”的地方

- `agent.followup` → `send(input, 'next-turn', true)`
  （`packages/core/agent-loop/src/agent.ts:171-186`）。
- `send` 调用 `this.inbox.splice(target, Infinity, 0, [message])`，然后 `wakeDriver`
  （`agent.ts:171-178`、`231-252`）。若 Agent 空闲，`wakeDriver` 立刻开一个 driver；
  若正在跑，消息排在 `next-turn`，到下一个回合再消费。
- `ReactLoopInbox.splice` 把这次变更写成一条**会话事件**：
  `this.session.append('agent/inbox/spliced', splice)`（`packages/core/agent-loop/src/inbox.ts:166-231`，
  append 在 `223`），并向 agent 作用域发 `agent/inbox/inserted`（`227-229`）。
- **inbox 不是内存队列，而是日志的投影**：`inboxProjectionDefinition` 从
  `agent/inbox/spliced` 折叠出 `next-turn` / `next-step`
  （`inbox.ts:26-64`）；`ReactLoopInbox` 只是读投影状态（`inbox.ts:73-94`）。
  所以“入队”在语义上等于“日志追加成功”。
- `Session.append` → `commit`：把事件压入内存 log，然后同步扇出 `session/event`
  （`packages/core/session/src/index.ts:896-916`；事件声明在 `:76`）。
- 持久化是**另一个订阅者**：`session-persistence-jsonl` 监听 `session/event`，把事件放进
  writer 的缓冲（`packages/session/session-persistence-jsonl/src/storage.ts:553-557`），
  最多延迟 `LIVE_WRITE_BATCH_MAX_DELAY_MS = 200` ms 再批量落盘
  （`storage.ts:37`、`278-285`）；`session/flush` 才同步 drain（`storage.ts:558-565`），
  写入路径确实 `fsync`（`storage.ts:1421-1459`）。
- 回合开始：`turn()` 先 append `turn/start`（`agent.ts:337`），`preStep` 从 inbox
  claim 输入（`agent.ts:288`），随后把 claim 到的消息 append 成 `user/message`
  （`agent.ts:465-474`）。

这一跳的性质：**会话日志 append（耐久）+ 宿主 inbox 投影（由日志派生）**。
`session/event` 在这里是“已提交事实的广播”，不是投递通道。

### 1.5 跳 4：工作区会话执行

- 目标 Session 是普通 root Session，执行模型/工具/回合，和人工对话没有区别。
- 派发消息在它的日志里是 `user/message`，`source.rpcId` 等于派发时的 `requestId`；
  这个身份是回流时把“哪个 turn”对回“哪次派发”的唯一依据（见下一跳）。
- 工作区 Session 自己可以再派 subagent；这不在本文的 superagent 消息链路里。

### 1.6 跳 5：回流触发——`turn/end` 如何到达插件

- 组织者是 dafeiyu capability：挂载时订阅 `session/event`
  （`packages/uitstalie/dafeiyu/src/index.ts:141`），只处理 `turn/end`
  （`index.ts:335-339`），按 Session 串行入队（`343-362`），再按注册顺序调用各
  capability 的 `onTurnEnd`（`365-388`）。
- 分派条件是 `scope !== 'root' || isRoot`（`index.ts:764-769`）；superagent contribution
  用 `scope: 'root'` 注册（`superagent.ts:5318`）。
- 因此：**回流的“触发”是事件驱动的**（`session/event` 是多订阅者的观察总线）；
  但事件本身只携带 `turn/end`，不携带“这是一次 superagent 派发”的语义。插件必须去读
  journal 才能知道。
- 插件收到后进入 `handleTaskTurnEnd`
  （`superagent.ts:4149-4300`，由 `onTurnEnd` 调用 `5363`）：
  1. 读该 Session 的全部 journal 绑定：`journal.forSession(sessionId)`（`4160-4172`）；
  2. 没有绑定就直接返回 false——不是本能力派的 turn，保持安静（`4173-4175`）；
  3. 从这条 `turn/end` 所属 turn 的 `user/message.source.rpcId` 里读 requestId
     （`turnPromptScan`，`3994-4027`；调用 `4184`），按 requestId 匹配 pending 绑定
     （`4188-4196`）；
  4. 没有身份信息时，才退化为 FIFO 取最老的 pending（`4199-4206`）——这是给旧记录
     的兼容路径；
  5. 对每个目标 `journal.claim(...)`（`4228`），拿不到 claim 就不投（`4238-4239`），
     防止并发/重放重复投递。

### 1.7 跳 6：报告投递回超管——还是一条普通 prompt

- `deliverTaskReport`（`superagent.ts:3827-3974`）：
  1. `prepareReport(body)` 先把**完整报告文本 + 业务 outcome/result** 写进 journal
     （`3843-3863`，`reports.prepare` 在 `3854`），并只更新 domain、不写 Markdown 投影
     （`3856` 的 `project:false`）；
  2. 校验接收者仍然可见/未归档：`recipientAvailable`（`1086-1096`；调用 `3866-3874`）；
  3. 用 `controller.prompt({ sessionId: record.superSession, mode: 'queue', … })` 投递
     （正常路径 `3958-3964`；失败路径 `3919-3924`；已保存文本的显式重试 `3883-3888`）。
     注意：**这里仍然没有经过总线**，还是同一个 session-controller 直接调用。
- 效果：这条消息进入超管 Session 的 `next-turn`，如果没有正在跑的回合就**开一个新回合**；
  如果正在跑就排队到下一回合——正文前缀 `[task-report]` 是给模型的唯一提示
  （`3910`、`3944`、`3949`）。
- 投递成功后才 `settle(delivered)`，失败则 `settle(failed)` 并写原因
  （`4287-4296`）；成功时再把业务结果 append 到人读 Markdown 投影（`4289`）。
- 超管自己的 `turn/end` 不会再触发一次派发：`onTurnEnd` 对
  `isSuperAgentSession` 直接返回（`5368`）。

这一跳的性质：**直接 prompt + journal 状态机**；`session/event` 只负责“什么时候该做”，
不负责“把报告送到哪”。

### 1.8 四类责任，谁负责哪一段

| 责任 | 谁承担 | 机制 | 耐久性 |
|---|---|---|---|
| 目标选择/路由 | `jira-agent` 的 `runSessionTool` | `controller.create/list/prompt`，显式 session id | 不单独持久化；目标是 Session 本身 |
| 消息入队 | `session-controller` + `agent-loop` | `agent.followup/steer` → `inbox.splice` | 写 `agent/inbox/spliced`，随会话日志持久化 |
| 消息落盘 | `session-persistence-jsonl` | `session/event` 订阅者 → 批量 writer | 写入后 `fsync`；但在 200 ms 批窗口内可能丢尾 |
| 回合触发 | `agent-loop` | `wakeDriver` → `turn/start` | turn 边界也在日志里 |
| 回流触发 | `dafeiyu` + `session/event` | `turn/end` 观察者 | 事件本身**不持久**；靠日志里的 `turn/end` 可重建 |
| 回流状态/去重 | `superagent-core` 的 `DispatchReportStore` | `.superagent/reports.jsonl` + `claims/*.json` | 文件写入；无显式 `fsync`；有 lease/TTL |
| 业务结果 | `DispatchStore`（domain）+ Markdown 投影 | `superagent_dispatch` 域 / `.superagent/ledger/*.md` | domain 权威，投影 best-effort |
| 文件投递 | `superagent_deliver` | host 进程内 `copyFile` | 文件系统；**不是消息通道** |

### 1.9 三个容易被误认为“消息通道”的东西

- **`superagent_ledger` 不是消息通道。** 它读写 dispatch 业务台账
  （`superagent.ts:3599-3782`）；`report_status`/`retry_report` 只是 journal 的运维入口
  （`3639-3694`）。业务状态和报告投递是两件事：`prepare` 在投递前就把业务结果写进
  journal/domain（`3854-3857`），“报告有没有送到”只由 journal 的 delivery 状态回答。
- **`superagent_deliver` 不是消息通道。** 它把文件复制进已注册 workspace
  （`superagent.ts:1840-1913`），不经过 Session、不产生回合。它和本问题的“消息”只在
  命名上相似。
- **`session-log-deepseek/delivery-accepted` 与 superagent 无关。** 它是 DeepSeek 官方
  session-log 上传的水位标记：模块头就写明“Accepted sequence watermarks live in the
  canonical log”（`packages/session/session-log-deepseek/src/index.ts:2-5`），事件在
  `:253` 追加，折叠在 `:162-183`。把它当成“消息投递确认”会误判现状。
- **`superagent_dispatch` 是另一条派活路径，不发 `[task-report]`。** 它把 executor
  Session 的 `[dispatch:session]` 记录写进 issue 评论（`superagent.ts:4540-4570`），
  报告走 Jira 的 `issue_work`/claim 回路；executor 的 turn end 在 `onTurnEnd` 里被
  `isExecutorSession` 直接跳过（`superagent.ts:5366`），dispatcher 的 turn-end pass 只
  提案/认领（`runSuperagentPass`，`1415-1466`）。本文的 `[task-report]` 链路只属于
  `superagent_control` 的 `start/append/prompt`。

---

## 2. 判断：它到底是不是 event bus

### 2.1 判据

要把它叫“消息总线”，至少应满足以下五条里的多数：

1. **统一事件类型/信封**：消息有稳定的 type、payload、correlation/id，而不是裸调用参数。
2. **发布者与消费者解耦**：发布者不需要知道接收者；接收者按订阅关系得到消息。
3. **多订阅者/扇出**：同一事件可以有多个消费者，且不互相覆盖（或明确的竞争消费语义）。
4. **持久化与重放**：事件在发布后能活过进程、能被后来者按位置重放，并支持 ack/重试。
5. **跨进程/传输抽象**（可选）：至少不把“同进程对象引用”当作唯一定址方式。

### 2.2 逐条对照

| 判据 | 现状 | 判定 |
|---|---|---|
| 1. 统一事件类型/信封 | 会话日志有类型化事件（`user/message`、`agent/inbox/spliced`、`turn/end`，见 `packages/core/session/src/index.ts:76`、`known-event-types.ts`），但**投递**的载荷是 `SessionPromptRequest` 对象（`controller.prompt`），没有“消息事件”类型；报告正文靠字符串前缀 `[task-report]` 区分（`superagent.ts:3910/3944/3949`） | **部分**：日志侧有类型，传输侧没有 |
| 2. 发布者/消费者解耦 | 上行：发布者显式指定 `sessionId`，消费者就是该 Session（`superagent.ts:2922-2927`、`3157-3162`）。下行：插件不知道哪个 Session 会结束，靠 `session/event` 过滤，**这一半是解耦的**（`dafeiyu/src/index.ts:141`、`335-339`） | **一半**：上行绑定地址，下行观察事件 |
| 3. 多订阅者/扇出 | `session/event` 确实有几十个订阅者（持久化、UI、telemetry、goal、dafeiyu…；见 `docs/event-producer-consumer.md:77`），但那是**对日志的观察**。消息本身只有一个消费者（接收 Session 的 inbox）；没有竞争消费/负载均衡 | **观察层是**，**消息层不是** |
| 4. 持久化与重放 | 会话日志可回放（`sessions.create(id,{seed})`、projection 折叠）；报告 journal 有状态机、lease、重试和启动恢复。但 `session/event`/`ctx.emit` 的监听器是**实时**的：晚订阅者收不到旧事件，没有 offset/ack。journal 的 `delivered` 是投递状态，不是可重放的事件流 | **有持久化，但不是总线语义**；重放靠日志折叠，不靠订阅 |
| 5. 跨进程/传输抽象 | 无。`controller.prompt` 是同进程方法调用（`@Remote` 只是标记，`typert/protocol/src/index.ts:282-317`）；`ctx.events` 是进程内总线（`docs/cordis-api/context.md:120-127`）。journal 文件可跨进程读，claim 也有文件 lease（`superagent-core/src/index.ts:224-263`），但**投递调用本身不跨进程** | **否** |

补充事实：

- DSH 的“事件总线”是 Cordis 的 `ctx.events`，文档原话是 “The event bus. Its methods are
  also mixed onto `ctx`”（`docs/cordis-api/context.md:120-127`）。它有四种模式：
  `emit`（同步广播、忽略返回值）、`bail`、`serial`（按注册顺序 await）、
  `waterfall`（中间件链）（`docs/user/develop/framework/events.md:23-77`）。
  它**没有**持久化、重放、ack、跨进程和“晚订阅补发”。
- `session/event` 是会话日志提交后的广播（`session/src/index.ts:896-916`）；文档明确区分：
  “`turn/*`、`step/*`、`tool/*` 是持久会话事件类型，不是同名 Cordis 事件；要观察它们，
  监听 `session/event` 并检查 `event.type`”（`docs/user/develop/framework/events.md:104-106`）。
- `agent/inbox/inserted` 也是 Cordis 事件（`docs/event-producer-consumer.md:21`），
  但它的消费者是 goal/subagent/tool-jobs 等**观察者**；`jira-agent` 不在订阅者列表里。
  也就是说：**inbox 插入事件存在，但 superagent 的传递不靠它。**

### 2.3 结论

**不是基于 event bus 的消息传递。** 更准确的描述是：

> **“显式地址的直接投递（RPC 风格）+ 耐久 inbox/会话日志 + turn 生命周期事件触发 +
> 独立报告 journal 的状态机/lease/恢复”。**

它有事件驱动的**一半**（回流触发），也有持久日志（会话 JSONL + journal），但没有
“消息总线”的核心：**发布者不寻址、订阅者多播、事件可重放/可 ack**。把 `session/event`
叫总线没错，但它只是**观察**层；把 `controller.prompt` 叫消息总线就错了，它是**投递**层。

### 2.4 为什么会有“像总线”的错觉

- Cordis 文档本身把 `ctx.events` 叫 “event bus”，而 `session/event` 是它上面最热的事件；
- 回流确实是“订阅 `turn/end` → 触发动作”，看起来像消息订阅；
- 会话日志里能看到 `agent/inbox/spliced`、`user/message`、`turn/start`，像是“消息事件流”；
- 报告以“新回合 + 新 user 消息”出现，观感像“推送了一条消息”。

但这些都是**对已发生事实的观察**或**投递后的结果**；真正决定“发给谁、何时发、发没发成功”
的是显式调用和 journal，不是订阅关系。

---

## 3. 脆弱点：现在靠什么不丢，缺口在哪

### 3.1 现在靠什么保证不丢

| 保证 | 机制 | 证据 |
|---|---|---|
| 派发不丢 | **先写 journal 绑定，再 prompt**；写失败就不派发 | `superagent.ts:3054`、`2913`、`3148`；`985-1011` |
| prompt 失败可见 | prompt 抛错时把绑定 settle 为 `failed`；`start` 还会把 ledger 置 failed | `failDispatchReport` `1021-1035`；`failStart` `3004-3016` |
| 投递不重 | 每任务文件 lease（`open(...,'wx')` + owner/TTL），claim 成功才投；过期才允许接手 | `superagent-core/src/index.ts:224-263`、`365-391`；两进程测试 `index.test.ts:88-121` |
| 内容不丢 | 投递前把完整报告文本 + outcome 存进 journal；失败可显式重试 | `reports.prepare` `426-440`；`superagent.ts:3843-3863`、`3652-3694` |
| 崩溃后可恢复 | 启动扫描 pending/delivering，重投已保存文本；已 delivered/failed 不自动重开 | `recovery.ts:34-81`；接线 `superagent.ts:4953-4973` |
| 会话/归档可收尾 | `workspace/session-stop`（parallel 事件）与 `domain/changed` 把未结算报告标 failed/orphaned | `superagent.ts:4908-4951`；事件声明 `packages/workspace/workspace/src/index.ts:147`、`:484` |
| 业务结果与投递分离 | `prepare` 先写业务结果（domain），投递成功后才写人读投影 | `superagent.ts:3854-3857`、`4287-4289` |
| 空输出不冒充成功 | 完成但无 assistant 文本时记为 `failed`（`empty-output`），仍发诊断报告 | `superagent.ts:3846-3852` |

注意两个“耐久性”细节：

- 会话日志的实时写入是**批量**的（最多 200 ms），写入时 `fsync`；所以“append 返回”不等于
  “已经在磁盘上”。（`storage.ts:37`、`278-285`、`1421-1459`）
- journal 用 `appendFile`（`superagent-core/src/index.ts:217-221`），没有显式 `fsync`；
  它比会话日志更“先写先回”，但也不是 fsync 级保证。
- `superagent-core/README.md:58` 说 “One instance is not a cross-process lock”；那指的是
  store 实例内的写链（`exclusive`）。**claim** 另有一把文件 lease
  （`superagent-core/src/index.ts:224-263`），两进程测试覆盖的是 claim，不是任意 journal 写。
  不要把这句话理解成“claim 只在本进程有效”。

### 3.2 已知缺口（按影响排序）

**G1（高，推断）：`delivered` 可能先于接收方消息落盘。**
`controller.prompt` 在 `agent.followup → inbox.splice → session.append` 返回后就算成功
（`commands.ts:373-374`、`agent.ts:171-178`、`inbox.ts:223`），而持久化是 200 ms 批处理
（`storage.ts:278-285`）。`deliverTaskReport` 立刻返回 true（`superagent.ts:3958-3965`），
随后 `settle(delivered)`（`4287-4288`）。如果进程在“prompt 返回”和“writer drain”之间崩溃，
journal 说 `delivered`，但超管会话日志里可能没有这条报告；启动恢复会跳过 `delivered`
（`recovery.ts:41-43`），**不会自动补发**（只能人工 `inspect` 子 Session 后重派）。
对照：`schedule` 插件在投递后显式 `await ctx.sessions.flush(...)`，拿不到 ack 就抛错
（`packages/schedule/schedule/src/runtime.ts:352-362`）；superagent 没有这一步。
【代码路径支持；未注入故障验证】

**G2（高，推断）：崩溃窗口会重复投递。**
投递成功但 `settle` 未写成时，journal 停在 `delivering`；5 分钟后 lease 过期
（`superagent-core/src/index.ts:41`、`365-391`），启动恢复会重新 claim 并再 prompt 一次
（`recovery.ts:58-77`、`superagent.ts:4955-4971`）。重投使用**新的** `requestId`
（`superagent.ts:4964`、`3884`），而宿主去重只认 `requestId`（`commands.ts:323`、`390-413`），
所以不会去重：超管可能收到两条相同 `[task-report]`。
这不会重复执行业务任务，但可能让超管重复记账、重复动作；属于 at-least-once，而不是
exactly-once。【代码路径支持；未注入故障验证】
（`docs/reviews/audit-fix-coverage-20261110.md` 的 P0-4 备注也提到“late in-flight settlement
can still duplicate a delivered report”。）

**G3（高，代码）：没有保存文本的 pending 永远不会自动收敛。**
`recovery.ts:45-47` 明确跳过 `reportText === undefined` 的 pending；而 `reportText` 只在
`turn/end` 的 hook 里 `prepare` 时才写入（`superagent.ts:3843-3863`）。两个真实窗口：
1. 进程在 `record` 之后、prompt 之前崩溃 → 绑定 pending、无文本；
2. 插件在 `turn/end` 恰好未挂载/被 reload（hook 是实时订阅，`dafeiyu/src/index.ts:141`）
   → 这一轮永远没有 `prepare`；重挂后也不会补，因为 `handleTaskTurnEnd` 只处理**当前**
   这条 `turn/end` 的 requestId（`superagent.ts:4181-4214`），旧 pending 不会被匹配。
   `report_status` 只列 `failed`/`delivering`（`superagent-core/src/index.ts:466-470`；
   `superagent.ts:3639-3646`），所以这个状态对模型**不可见**；只有
   `superagent_ledger list` 可能从业务台账看到 pending。
【代码；窗口是否真实发生未验证】

**G4（中，未验证）：真实重启没有被端到端验证。**
`docs/reviews/audit-fix-coverage-20261110.md:53` 明确写 P0-3 为 partial，“A real Host restart
remains unverified”。仓库里的“remount”测试是直接调用 `handleTaskTurnEnd`
（`superagent.test.ts:1226-1232`，空 `tasks` Map），不是实际 mount/remount 后再启动扫描；
dispose 测试是新建 contribution 后立即 dispose（`superagent.test.ts:3319-3334`）。
【文档 + 测试代码；未运行】

**G5（低，配置边界）：没有 `superagent_home` 的组合里，`control` 仍暴露但报告没有 journal。**
先澄清一个容易写错的地方：在**配置了** `superagent_home` 的生产组合里，`control` 工具
把 `reportStore` 显式注入给 runner（`superagent.ts:5288-5296`，store 建在 `4843`），
`recordDispatchReport` 优先用它（`:998`），回流 hook 读同一个 store（`:4160`），
所以**不存在“写到 caller.cwd、hook 读 superHome”的错位**。
真正的边界是**没有** `superagent_home` 时：`reportStore` 为 undefined，
`recordDispatchReport` 回退到 `caller.cwd`（`:996-998`），而 `handleTaskTurnEnd` 的
journal 也是 undefined（`:4160`），于是 `control` 的 `start/append/prompt` 仍可被
任何非 executor root 调用（`:5319-5336`），但报告没有 journal 可绑定/恢复 →
**不会回流**。这不是主路径缺陷，而是“未配置 super agent 的部署仍暴露了它的消息工具”。
另外，角色分离只靠提示词：非 super root 调用时 `reportTo = me.session`（`:2760-2761`），
报告会回到调用者自己，不一定是使用者预期的“回超管”。【代码 + 推断；未构造运行验证】

**G6（中，代码）：消息没有来源归因。**
两个方向的消息都是 `source.kind = 'user'`（`session-controller/src/index.ts:485-490`），
目标 Session 无法从 source 区分“人说的”和“superagent 派的”；唯一标记是
`rpcId` 前缀和正文前缀（`superagent.ts:3910/3944/3949`）。这会影响 UI 呈现、审计、以及
“把机器消息当人消息处理”的误判。对比：`schedule` 用 `source.kind='schedule'`
（`packages/schedule/schedule/src/runtime.ts:5-9`、`353`），subagent 用
`'agent-message'`/`'subagent-settled'`（`packages/subagent/subagent/src/continuation-messages.ts:29-45`）。
【代码】

**G7（中，推断）：投递顺序只有“每 Session FIFO”，没有“每任务保序”。**
报告按 `targets` 顺序逐个 prompt（`superagent.ts:4225-4298`），最终进入超管 inbox 的
`next-turn` 队列（`inbox.ts:108-113`），所以同一超管 Session 内是调用顺序；但不同子 Session
的 turn 结束顺序本身不确定，启动恢复按 journal 的 `updatedAt` 排序
（`superagent-core/src/index.ts:317-324`）。原型设计里承诺的“同一工单到同一对话保序”
（`goal/super-agent.md:152`）在当前实现里没有显式保证。【推断】

**G8（低，代码）：`delivered.accepted` 在报告路径被忽略。**
`deliverTaskReport` 调 `controller.prompt` 后直接 `return true`，不看返回值
（`superagent.ts:3958-3965`）。当前 `Commands.prompt` 只会 resolve `{accepted:true}` 或抛错
（`commands.ts:384`），所以今天无害；但这是一条隐式契约，换成别的实现就可能把
`accepted:false` 当成成功。【代码 + 推断】

### 3.3 证据边界

- 以上 G1/G2/G3 都是**代码路径可推出**的窗口，但我没有注入崩溃/磁盘失败，也没有真实
  Host 重启；严重度是“如果窗口命中”的影响，不是实测发生率。
- P0-3 的“真实重启未验证”是仓库自己的结论
  （`docs/reviews/audit-fix-coverage-20261110.md:53`、`:143`），不是本文新发现。
- 我没有验证 UI 是否展示报告投递状态；就代码看，`jira-service` 的 status/remote
  读的是 issue 台账，不读 `.superagent/reports.jsonl`（`superagent-status.ts` 全文）。

---

## 4. 如果改 event bus：要什么、谁发谁收、怎么持久化

### 4.1 先把三层分开

| 层 | 现在是什么 | 换成总线是否合适 |
|---|---|---|
| **传输层**（把消息送进目标 Session） | `controller.prompt` 直接调用 → inbox | **不合适**：总线不能替代 Session 的受理语义（queue/steer、wake、requestId 去重、冷启动恢复） |
| **触发层**（什么时候该送） | `session/event` → dafeiyu → `onTurnEnd` | **已经事件化**；可保留 |
| **观察层**（状态变更给 UI/台账/审计看） | 插件内联调用（投影、日志） | **适合事件化**：这是唯一值得加“总线”的地方 |

所以“改成 event bus”如果指**传输层**，答案是不改；如果指**观察层**，可以做，而且成本低。

### 4.2 三种方案

**方案 A（推荐）：传输不变，观察层事件化 + journal 当 outbox。**
- 传输仍是 `controller.prompt`；journal 仍是唯一权威；
- 每次 journal 状态变更后发一个 Cordis 通知事件（`emit`），订阅者收到后**回读 journal**，
  而不是把事件当消息；
- 给 journal 补 `messageId` / `deliveredAt` / `attempt` 回执，投递后 flush 接收方会话；
- 启动时对账 pending 与子 Session 日志。
- 成本：5–9 人日；风险低；**不含来源 kind**（那一步要动宿主 `prompt` 请求，
  见 §4.6 第 1 条，另加 2–4 人日）。

**方案 B（中等）：抽象 `MessagePort` 接口，统一“派发/报告”的投递与回执。**
- 定义 `dispatch()` / `report()` 两个端口方法，内部仍用 `controller.prompt`；
- 测试可替换为内存实现；未来若 Host 提供更强的投递 API，只换实现；
- 顺带把 `accepted`、`messageId`、`insertedAtSeq` 变成显式返回。
- 成本：8–12 人日；收益是可测试性和未来兼容；不引入总线。

**方案 C（不推荐）：真正的消息总线/队列服务。**
- 需要新进程/新存储、topic/queue、ack、重试、顺序、保留、权限；
- 仍然要一个“投递适配器”调用 `controller.prompt`；等于在 journal 之上再叠一套状态；
- 跨进程在当前 DSH 部署里不支持（单 Host），多 Host 也不被 session 写入模型支持。
- 成本：30+ 人日 + 长期维护；收益主要是“看起来解耦”，不解决 G1/G2/G3。

### 4.3 如果做方案 A：事件清单

事件是**通知**，不是载荷；每个事件都带 `taskId`，订阅者据此回读 journal。

| 事件 | 发布者（唯一） | 订阅者（建议） | 持久化位置 |
|---|---|---|---|
| `superagent/dispatch-recorded` | `recordDispatchReport`（prompt 前） | UI 状态、审计；可选 ledger 投影 | `reports.jsonl` 的 `pending` 行 |
| `superagent/dispatch-admitted` | `runSessionTool`（prompt 后） | UI、monitor | `reports.jsonl` 更新（`admittedAt`/`messageId`） |
| `superagent/dispatch-failed` | `failDispatchReport` / `failStart` | UI、审计 | `reports.jsonl` 的 `failed` 行 |
| `superagent/turn-ended` | `handleTaskTurnEnd`（`prepare` 后） | UI、memory 提示 | `reports.jsonl` 的 `delivering` + `reportText` |
| `superagent/report-queued` | `deliverTaskReport`（prompt + flush 后、settle 前） | UI、可选 ledger 投影触发器 | `reports.jsonl` 的 `delivering` 行（待 settle） |
| `superagent/report-delivered` / `report-failed` | `settleReport` | UI、审计、ledger 投影 | `reports.jsonl` 终态 |
| `superagent/report-retried` | `runLedgerTool retry_report` | UI | `reports.jsonl` 新行 |
| `superagent/session-orphaned` | `workspace/session-stop` / `domain/changed` handler | UI、审计 | `reports.jsonl` failed + domain orphaned |

发布者只有 journal 的写入方，避免“谁都能发”导致双重真相。订阅者**不允许**投递；
它们只读 journal、更新视图。若某个订阅者挂了，不影响投递。

### 4.4 持久化与重放

- **不要**让 Cordis 事件承担持久化：`emit` 不持久、不重放、不 await
  （`docs/user/develop/framework/events.md:27-39`）。晚挂载的 UI 收不到历史。
- 正确的重放源是 journal：`DispatchReportStore.all()` 读每个 id 的最新行
  （`superagent-core/src/index.ts:269-285`），文件本身保留每一次状态转换；需要历史就加
  `history()` 读全行，而不是 replay 事件。
- 如果一定要“事件流”语义：把每次转换写成**会话日志的 plugin record**
  （`plugin:superagent/...`，`ignorable`、不进入模型上下文，
  `session/src/index.ts:471-479`），放在**超管 Session** 的日志里；这样 UI/轨迹可回放，
  且不新增存储。代价是跨 Session 写入和冷 Session 激活，复杂度和 journal 重叠，
  只能作为“人读时间线”的可选增强，不作为投递权威。
- 结论：**journal 是 outbox/状态机；会话日志是消息内容；Cordis 事件只是通知。**

### 4.5 跨进程要不要

**不要。** 理由：

- DSH 当前是单 Host；`goal/super-agent.md` 与 `docs/reviews/audit-fix-coverage-20261110.md`
  的 “Scope: single-Host only” 已明确不做 Host-to-Host 协调。
- 即便将来要跨 Host，Session 写入本身有 writer-held 限制
  （`docs/reviews/audit-fix-coverage-20261110.md:25` 引用的证据），消息总线也不能替代
  会话归属；先要解决的是“哪个 Host 拥有这个 Session”，而不是“消息怎么广播”。
- 现有 journal 的 claim lease 已经处理了同一 home 下两个 Node 进程的竞争
  （`superagent-core/src/index.ts:224-263`；两进程测试 `index.test.ts:88-121`），
  这是当前唯一需要防的跨进程场景；不需要 broker。

### 4.6 迁移路径（方案 A）

1. **加消息来源 kind**（要动宿主 API，不只是本地改名）：当前 `SessionController.prompt`
   自己把 source 固定成 `kind: 'user'`（`session-controller/src/index.ts:485-490`），
   调用方没有地方传 source。因此需要二选一：
   - 给 `SessionPromptRequest` 增加可选 `source`（或新增 `promptAs`），由 controller
     校验/落库（推荐，保留 dedupe 与冷启动）；
   - 或绕过 controller 直接 `resolveAgent` + `agent.followup(createUserMessage(...))`
     （不推荐：丢掉 `hasPromptRequest` 去重与未来校验）。
   然后在 `jira-agent` 里 `declare module '@deepseek-ai/dsh-llm'` 增加
   `superagent-dispatch` / `superagent-report`，字段含 `taskId`、`from`、`to`、`attempt`。
   *注意*：这是持久化面变更（`MessageSourceMap` 会被 persistence catalog/format 检查），
   需要同步文档与 format 测试；这也是为什么它排在回执/对账之后。
2. **加投递回执**：`deliverTaskReport` 在 prompt 后 `await sessions.flush(superSession)`；
   失败就 `settle(failed)` 而不是 `delivered`；把 `insertedAtSeq` 写进 journal
   （`insertionSeqOf` 已经能读到，`superagent.ts:2197-2207`）。`messageId` 需要 controller
   在返回值里暴露（可选，与第 1 条的宿主 API 一起做）。参考 `schedule` 的 `send()`
   （`runtime.ts:352-362`）。
3. **补启动对账**：启动恢复对“pending 且无文本”的绑定，读子 Session 日志
   （`sessionQuery.observeSession`，已在 `inspect` 用过：`superagent.ts:3210-3255`），
   用 `turn/end` + requestId 重建报告；找不到就标 failed + 可见原因。这直接关闭 G3。
4. **补 `report_status`**：把 pending（含无文本）、orphaned、delivering 都列出来，
   并标 `hasSavedText`；`retry_report` 只对 failed 开放（保持现状）。
5. **加通知事件**：按 §4.3 发 `emit`；UI/ledger 投影改为订阅 + 回读 journal。
   保留内联投影作为 fallback，避免事件丢失时功能退化。
6. **（可选）抽 `MessagePort`**：把 `controller.prompt` 包成两个方法，测试可替换；
   不改变语义。

回滚：1–4 都是 additive；5 的订阅者可随时退回内联；6 是内部重构。

### 4.7 风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| 事件先于持久化 | 先 emit 后写 journal，崩溃就丢通知/状态 | **先写 journal，再 emit**；订阅者回读 journal |
| 事件当消息 | 订阅者把 `emit` 当可靠投递，重启后丢 | 文档/类型上禁止；事件只带 `taskId` |
| 多订阅者拖慢/抛错 | `emit` 是同步扇出，慢订阅者阻塞 append | 订阅者只做轻量入队/回读；重活异步 |
| 重复投递 | G2 的 lease 窗口 | 在 journal 里存 `deliveryKey`/`taskId`，投递前查最近日志；或明确接受 at-least-once |
| 持久化面变更 | 新增 message source kind 触发 format/catalog/文档门 | 单独 PR，先跑 persistence/format 相关测试；不和新事件混在一起 |
| 冷 Session 写入 | 在超管 Session 写 plugin record 需要激活/写权限 | 只用 journal 作为权威；plugin record 仅可选 |

### 4.8 对 `superagent_control` / ledger 的影响

- **`superagent_control`**：对外 schema 不变；`delivery` 结果可以多一个 `messageId`
  （可选字段）；`start/append/prompt` 的行为、拒绝顺序、report 路由都不变。
  若采纳来源 kind，需要先扩展宿主 `prompt` 请求（见 §4.6 第 1 条）；只包一层
  `controller.prompt` 并不能改变 source。
- **`superagent_ledger`**：业务语义不变；`report_status` 增加 pending/orphaned 行；
  `retry_report` 不变。人读 Markdown 投影从“内联调用”变成“订阅者 + 回读”，
  必须幂等（`DispatchStore.resolve` 已经有 `changed()` 判重，`dispatch-store.ts:313-356`）。
- **`superagent_deliver`**：不受影响（文件复制，不是消息）。
- **UI/Remote**：`superagent-status.ts` 目前只读 issue 台账，不读报告 journal；
  若要展示投递状态，新增只读 Remote 比“让 UI 订阅 Cordis 事件”更稳（浏览器进程不在
  同一事件总线里）。

---

## 5. 建议

### 5.1 做 / 不做 / 部分做

**不做（至少现在不做）**

- 不把传输层换成消息总线/队列/代理；不引入新进程、新存储、topic/consumer group。
- 不做跨进程消息总线；单 Host 是当前支持边界。
- 不为“解耦”而把报告投递改成 `ctx.emit` 订阅——那会把耐久性做没。

**做（优先级从高到低）**

1. **投递回执**：prompt 后 flush 接收方会话，成功才 `delivered`；失败标 failed。
   直接关闭 G1。工作量约 1–2 人日。
2. **启动对账**：pending + 无文本的绑定，从子 Session 日志重建报告或标 failed/needs-person；
   `report_status` 暴露 pending。关闭 G3。工作量约 2–4 人日。
3. **去重/幂等**：把 `taskId`/`deliveryKey` 放进投递与 journal，重投前查最近日志；
   把 at-least-once 变成“常见路径 exactly-once”。缓解 G2。工作量约 1–2 人日。
4. **消息来源 kind**：`superagent-dispatch`/`superagent-report`，让目标 Session 和 UI
   能区分机器消息与人消息。关闭 G6；也是后续 UI/审计的基础。需要扩展宿主 `prompt`
   请求（见 §4.6 第 1 条），工作量约 3–5 人日（含宿主接口、持久化 catalog/format 测试）。
5. **通知事件**（可选）：按 §4.3 发 Cordis 事件，UI/投影订阅；这是“部分事件化”的
   唯一部分，价值在观察层，不在传输层。工作量约 2–3 人日。

**部分做 / 先观察**

- `MessagePort` 抽象：等第 1–4 项稳定后再做，避免先抽象后改语义。
- 会话日志 plugin record 时间线：等 UI 真的需要“可回放投递历史”时再做。

### 5.2 为什么不是“直接上总线”

- 现有失败模式（G1–G3）都是**确认与恢复**问题，不是“发布者/消费者耦合”问题；
  总线不会让 `controller.prompt` 更耐久，也不会替你把 pending 对账。
- DSH 的 `ctx.events` 不持久、不重放、不 ack；把它当传输会**降低**可靠性。
- 真正耐久的两个东西（会话日志、journal）已经在正确的位置；再叠一个总线只会产生
  第三个真相源。
- 单 Host 边界下，跨进程总线没有使用场景。

### 5.3 工作量粗估（1 人，熟悉该模块）

| 项 | 粗估 | 备注 |
|---|---|---|
| 投递回执 + flush | 1–2 人日 | 含失败分支测试 |
| 启动对账 + `report_status` | 2–4 人日 | 需要 `sessionQuery` 读子日志 |
| 去重/幂等 | 1–2 人日 | 与 1 可合并 |
| 消息来源 kind | 3–5 人日 | 需扩展宿主 `prompt` 请求；persistence catalog/format/文档门是主要成本 |
| 通知事件 + 订阅者 | 2–3 人日 | 可选；UI 侧另算 |
| 真实重启验收 | 1–2 人日 | 需要可控的进程重启/新 contribution + 空内存 |
| **推荐组合（1–4）** | **7–13 人日** | 不含 UI 与通知事件 |
| 完整总线（方案 C） | 30+ 人日 | 不建议 |

### 5.4 验收建议

- **G1**：在 `controller.prompt` 返回后、journal settle 前注入“接收方持久化未完成”，
  断言不会写出 `delivered`；恢复后报告仍能送达且只有一条。
- **G3**：构造 pending + 无文本 + 子 Session 已结束（或无新 turn）的场景，启动后
  必须收敛为“已送达 / failed + 可见原因 / needs-person”，不能静默 pending。
- **G2**：在 `delivered` settle 前杀进程，重启后允许至多一次重投，但必须能通过
  `taskId` 去重或明确记录重复。
- **真实 remount**：不是直接调 `handleTaskTurnEnd`，而是新建 contribution、空 `tasks`、
  不发送任何新 turn，只靠 journal + 子日志恢复。
- **无 `superagent_home` 的部署**：验证 `control` 的 `start/append/prompt` 是否应该直接
  拒绝（没有 journal 就没有报告），而不是让调用方以为“派出去了”。这比讨论
  “报告写到哪个 root”更贴近实际（生产组合的 store 由 `superHome` 注入，见 G5）。
- **来源 kind（若做）**：先在宿主 `prompt` 请求上断言“不传 source 仍是 user、传了非法
  source 被拒”，再断言子/超管日志里的 `source.kind` 与 `taskId` 可回读；不要只测
  `declare module` 的类型合并。

---

## 6. 给用户的 5 行摘要

1. **不是 event bus**：派活是 `superagent_control` 直接调宿主 `controller.prompt`，回流是 `session/event` 的 `turn/end` 事件触发后再直接 prompt；总线只在“触发/观察”这一层。
2. **耐久性不在总线**：消息落在会话日志的 `agent/inbox/spliced`，报告状态落在 `.superagent/reports.jsonl`（lease + 恢复 + 重试），这才是现在不丢的原因。
3. **最危险的不是耦合**：`delivered` 可能先于接收方消息落盘（200 ms 批窗口），以及“pending 无文本”永远不收敛；这两个比“换成总线”更值得先修。
4. **要改就部分事件化**：保留直接投递，把 journal 当 outbox，补投递回执/启动对账/来源 kind；Cordis 事件只做“状态变了”的通知，不做传输。
5. **不建议全量总线**：单 Host、无跨进程需求，完整总线 30+ 人日且会引入第三个真相源；推荐组合约 7–13 人日，先修 G1/G3 再加 G2/G6。

---

## 附录 A：关键证据索引

- 工具与路由：`packages/jira/jira-agent/src/superagent.ts:526-569`、`2735-3202`、`5319-5336`。
- 宿主受理：`packages/api/session-controller/src/index.ts:467-492`、
  `commands.ts:321-413`；`packages/core/agent-loop/src/agent.ts:171-186`、`231-252`、`337`、`465-474`。
- inbox/日志：`packages/core/agent-loop/src/inbox.ts:26-64`、`166-231`；
  `packages/core/session/src/index.ts:76`、`896-916`；
  `packages/session/session-persistence-jsonl/src/storage.ts:37`、`278-285`、`553-565`、`1421-1459`。
- 回流触发：`packages/uitstalie/dafeiyu/src/index.ts:141`、`335-388`、`764-769`；
  `superagent.ts:4149-4300`、`5355-5370`。
- 报告投递：`superagent.ts:3827-3974`、`1086-1096`、`4953-4973`、`5371-5404`。
- journal：`packages/superagent/superagent-core/src/index.ts:31-41`、`217-221`、`224-263`、
  `365-391`、`426-440`、`466-486`、`512-531`；`recovery.ts:34-81`。
- 事件总线语义：`docs/cordis-api/context.md:120-127`、
  `docs/user/develop/framework/events.md:23-77`、`104-106`、
  `docs/event-producer-consumer.md:21`、`77`、`103`。
- 对照实现：`packages/schedule/schedule/src/runtime.ts:5-9`、`352-362`；
  `packages/subagent/subagent/src/continuation-messages.ts:29-45`。
- 现状评审：`docs/reviews/audit-fix-coverage-20261110.md:21-29`、`51-54`、`143`。
- 设计背景（原型 outbox/inbox）：`goal/super-agent.md:152`、`154`、`418`。
