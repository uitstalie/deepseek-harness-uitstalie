# personality、JIRA 退场与 `.dsh` 工具的重排

[English](tool-surface-reorg.md) | 中文

状态：已实现。JIRA 产品退场，包括其模型工具、技能、面板、CLI、本地账本、派发历史与 super agent 工具；只保留 GitHub 上的 cloudstore 仓库及其内容与历史，按数据原样保留，不接入任何工具或流程。会话生命周期现在由 `workspace_sessions` 承载；投递与回传只经 `workspace_message`，任务状态只经 `workspace_tasks`，工作区请求与回传契约归[记忆/工作区设计](memory-scoping.zh.md) 6.5 节。personality 用一个工具拥有两个全局文件，`tool-dsh-store` 仍是唯一 `.dsh` 入口。篇幅上限：12 页 / 4,600 汉字。

## 1. 范围与结果

本文覆盖被重排的三组工具：

- personality 工具及其两个全局文件；
- JIRA 产品，以及只为它的认领/派发循环存在的 super agent 工具；
- `.dsh` 存储工具。

JIRA 产品一步移除。不保留别名、分阶段移除或兼容层。回滚等于重装上一版；被删除的本地账本与派发历史无法恢复。

## 2. 退场的 JIRA 面

JIRA 模型工具、执行器账本工具、认领/派发工具、super agent 控制与账本工具、三个 JIRA 技能、`/jira` 命令、写守卫、注入行与回合结束账本结算全部移除。`packages/jira` 包与派发核心包删除。Web app 组合不再挂载 JIRA 服务、agent 或面板行，也不再提供执行器预设。

JIRA 只保留云端数据仓：GitHub 上的 cloudstore 仓库及其内容与历史，按数据原样保留，不接入任何工具或流程，不作为设计能力，也不需要凭据或 remote 接入说明。代码中没有 JIRA endpoint、project、tenant 或 timeout 设置；本地账本的路径与审计设置随账本一起移除。

本地 JIRA 账本 `$DSH_HOME/jira` 与 `.superagent` 下的派发历史已删除，不可恢复；没有模型工具读取已删除路径。工作区任务存储从空白开始，不导入旧历史。

受影响的对象：期望旧工具的提示词、技能与评测集；引用 JIRA 行或执行器预设的 profile 与 patch；失去本地数据的 JIRA 面板与 CLI 用户；以及转录里提到旧调用的已存储 Session，新调用返回 `unknown tool`。

## 3. 会话生命周期与投递状态搬进 `workspace_*`

`workspace_sessions` 是唯一的会话生命周期入口。动作是 `list`、`get`、`run`、`start`、`append`、`prompt`、`stop`、`abort`、`fork`、`archive`、`compact` 与 `delete`。

- `list` 与 `get` 保持既有读语义：工作区会话、状态、当前活动、最近进展、待处理收件箱与产物计数。
- `run` 是一次调用完成交付：继续目标会话（`sessionId`，不给就继续最近更新的那条），只有工作区里没有会话时才新开；`new_session: true` 在人要求新会话时强制新开，首个任务缺省用 `text`，标题缺省时派生。
- `start` 在指定的已注册工作区创建 Session，只接收并发送首个任务文本与可选（缺省派生的）标题；它不检查意图卡。工作区请求是通用能力：任意 agent 可经 `workspace_message` 或 `workspace_sessions` 向其他 agent/session 发起请求，超级工作区也用同一套工具调用派发和接收；意图卡与 `workspace_tasks` 只在需要正式任务记录时使用，细节归[记忆/工作区设计](memory-scoping.zh.md) 6.5 节。
- `append` 继续指定 Session 或最近更新的 Session；`prompt` 只面向明确的 Session id。
- `stop` 切断运行中的 turn、不投递文本；`abort` 切断后再投递后续文本。
- `fork`、`archive`、`compact` 与 `delete` 保留 Host 生命周期语义。`delete` 要求精确重复 Session id 作为确认；Host 没有真实删除 API 时明确拒绝。

调用方工作区是默认范围。生命周期写动作对工作区内任何 agent 开放；跨工作区写要求 super agent（已实现）；读取仍对工作区内所有 agent 开放。跨工作区调用必须显式给出已注册工作区 id，并留痕。

投递状态由 `workspace_message` 承载。`send` 记录消息与投递尝试。`status` 报告消息状态、失败原因与尝试次数。`retry` 用同一请求标识、正文与引用重发失败消息；重复 retry 不会重复入队。失败消息仍可用 `read` 读出，因此失败不会静默丢失。

工作区请求与回传契约由记忆/工作区设计拥有（[记忆/工作区设计](memory-scoping.zh.md) 5.4、6.5、11.8 节）：任意 agent 可经 `workspace_message`（`send`/`read`/`status`/`retry`）向同一工作区的其他 agent/session 发起请求；需要正式任务记录时才用意图卡与 `workspace_tasks`，简单的或明确的动作不需要单独发卡。执行者用 `workspace_message.send` 带 `taskId` 回传，跨工作区只按任务绑定放行（`task.targetSessionId` 是调用者、`task.dispatcherSessionId` 是发送目标，已实现），`requestId` 幂等，`status`/`retry` 处理失败，任务状态只经 `workspace_tasks`。本工作区的建任务与意图卡写动作对任何 agent 开放；跨工作区写仍要求 super agent。本文不重复定义这些契约。

## 4. Personality

`personality_analyze` 保持只读并对子代理可用。`personality_apply` 只对 root agent 开放，拥有两个全局文件：只传 `candidates`（画像）或 `writingRules`（规则文件）之一，外加字面量 `confirm: true`。两个文件不与全局记忆合并；它们有各自的生命周期、评审流程与提示词段。

## 5. `.dsh`

`tool-dsh-store` 仍是 `.dsh` 内容唯一的模型面入口。`workspace_artifacts` 发布与解析引用；对 `.dsh` 路径调用 store 的路径归一化与命名空间检查，并拒绝 `.dsh/memory`。它不会成为第二个 store 写入者。

## 6. 最终工具面

| 命名空间 | 所有者 | 成员 |
|---|---|---|
| `workspace_*` | 工作区信息设计 | `workspace_sessions`、`workspace_intents`、`workspace_tasks`、`workspace_message`、`workspace_artifacts` |
| `ask_user_question_plus` | 工作区信息设计 | 拒绝非 super 会话在别的 agent 发来的请求里的交互提问，并给出派发方；人自己发起的或 super agent 的 turn 原样转给宿主 `userQuestions` 服务 |
| `memory_*` | 记忆设计 | `memory_write`、`memory_forget`、`memory_search` |
| `personality_*` | 本次改动 | `personality_analyze`、`personality_apply` |
| `tool-dsh-store` | 本次改动 | 唯一经校验的 `.dsh` 入口 |
| 已退场 | — | JIRA 与 super agent 工具组，无别名 |

`workspace_sessions` 现在承载生命周期动作；`workspace_message` 承载投递状态与重发。不再保留并行的任务或投递 API。

## 7. 风险与回滚

- 本地 JIRA 账本与派发历史已删除；删除后不可恢复。云端只保留 cloudstore 数据仓，按数据原样，不接入工具或流程。
- 移除是一个发布，没有分阶段路径。回滚靠重装上一版；被删数据不会回来。
- 仍引用旧工具或 JIRA 行的提示词与预设会显式失败：工具调用返回 `unknown tool`，命名已移除行的 patch 在加载时失败。
- `.dsh` 边界由 store 执行；`.dsh/memory` 下的产物路径被拒绝，而不是被复制。

## 8. 与记忆/工作区设计对齐

记忆设计的映射行已在同一改动中修订：JIRA 认领/派发面移除，JIRA 模型工具消失，投递与回传归 `workspace_message`，任务状态归 `workspace_tasks`，会话生命周期归 `workspace_sessions`，`.dsh` 指针保留。工作区请求与回传契约只由记忆/工作区设计定义；本文只指向它。`workspace_tasks` 从空白开始；不存在 JIRA key 或账本兼容字段。

## 9. 验证

实现改动记录了实际执行的门禁：仓库 typecheck、受影响包测试（工作区工具、personality、memory、角色可见性、组合）、文档同步、配置与插件目录、包路径、升级指南与双语配对。重建组合的工具目录不含任何退场名称，`packages/jira` 不再存在。
