# personality、JIRA 与 `.dsh` 工具的重排

[English](tool-surface-reorg.md) | 中文

状态：评审稿。篇幅上限：12 页 / 4,600 汉字；本稿约 3,690 汉字（约 8 页）。

## 1. 范围与证据

### 1.1 范围

本文覆盖三组工具及其存储：

- `personality_*` 工具与它们的全局文件（`PERSONALITY.md`、`WRITING_RULES.yaml`）；
- `jira_*` 工具、JIRA 账本，以及只为 JIRA 认领/派发循环存在的 `superagent_*` 工具；
- `.dsh` 存储工具（`tool-dsh-store`）及其服务。

本文不重新定义 `memory_*` 或 `workspace_*` 工具集；它们属于记忆与工作区信息设计。本文只声明与那份设计的边界，并列出需要那边修订的每个点。

### 1.2 证据窗口

下面的调用计数来自一个很长的 super agent 会话：827 个完成 turn，约 2,200 次工具调用。这是样本，不是全量普查。账本证据来自两个存储本身：

- `$DSH_HOME/jira` 的 JIRA 单据账本是一个 git 仓库；它最后一次提交与最后一次单据文件写入都是 2026-11-10 21:15 +0800；
- `D:\dqc\superAgent\.superagent\ledger` 的派发账本条目更新到 2026-11-17T09:34Z，`reports.jsonl` 在当天本地时间 17:34 被写入；
- personality 文件 `$DSH_HOME/personality/PERSONALITY.md` 在 2026-11-17 15:48 被写入。

运行构建还暴露了 `superagent_session` 与 `superagent_workspace`。它们不作为别名保留：两个名字都移除，能力由 `workspace_sessions` 实现。

### 1.3 为什么写这份文档

记忆设计把这三组工具留在范围外，却依赖它们的名字与存储。如果它们被单独、悄悄地重排，工作区工具集要么重复它们，要么与它们冲突。本文把归属写清，为 JIRA 提出移除路径，并在两边上线之前固定 personality 与 `.dsh` 的边界。

## 2. 现状盘点

### 2.1 personality 工具

| 工具 | 用途 | 调用方 / 角色 | 样本内调用 | 判断 |
|---|---|---|---|---|
| `personality_analyze` | 读取会话记录，返回有证据的候选；只读 | `minRole: 'subagent'`（`api.ts:121`） | 1 | 保留 |
| `personality_apply` | 把已确认候选写入全局 `PERSONALITY.md`；拒绝子代理（`agent-tools.ts:177`） | `minRole: 'agent'` | 3 | 保留，收窄 |
| `write_like_human` | 维护全局 `WRITING_RULES.yaml`；拒绝子代理（`writing-tool.ts:115`） | `minRole: 'agent'` | 0 | 并入 `personality_apply`；不保留独立工具 |

存储：`$DSH_HOME/personality/PERSONALITY.md`（`global-store.ts:25`）与 `$DSH_HOME/personality/WRITING_RULES.yaml`（`defaults.ts:26-29`）。两者都是全局、非工作区级，都经全局 `.dsh` store 写入（`global-store.ts:270-309`）。

### 2.2 JIRA 与 super agent 工具

JIRA 包里混着两个不同的产品：单据 CRUD，以及 super agent 派发循环。任何移除之前都必须先分开。JIRA 已废弃：按停用处理；本文只规划移除，不做兼容。

#### 2.2.1 JIRA 单据工具

| 工具 | 用途 | 样本内调用 | 判断 |
|---|---|---|---|
| `jira_issue` | 在本地 JIRA 账本里读取、创建、评论、转换状态、打标签、编辑单据（`toolIssue.ts:15`） | 11 | 现在移除 |
| `jira_kb` | 读写 JIRA 账本下的知识条目（`toolKb.ts:15`） | 1 | 现在移除 |
| `jira_list` | 按项目、状态、标签列单据（`toolList.ts:15`） | 7 | 现在移除 |

JIRA 账本本身自 2026-11-10 21:15 起没有数据写入，也没有新提交。上面的调用量很小，而且大多是读。证据支持的是“现在移除 JIRA 单据面”：账本数据删除，删除前可选做一次静态导出；删除后不可恢复。

#### 2.2.2 JIRA 认领/派发工具

| 工具 | 用途 | 样本内调用 | 判断 |
|---|---|---|---|
| `superagent_scan` | 列账本里现在可接的单据（`superagent.ts:84`） | 0 | 现在移除 |
| `superagent_claim` | 在人确认后提议或认领单据（`superagent.ts:86`） | 0 | 现在移除 |
| `superagent_status` | 报告认领循环的计数与阻塞项（`superagent.ts:88`） | 0 | 现在移除 |
| `superagent_dispatch` | 为已认领单据启动执行会话（`superagent.ts:4773`） | 0 | 现在移除 |
| `superagent_source` | 从配置仓库导入开放单据（`superagent.ts:5008`） | 0 | 现在移除 |

这些工具只为跑 JIRA 工作而存在。样本里一个都没有被调用。派发账本仍在记录工作，但它记录的是工作区任务，不是 JIRA 单据；这个区分正是移除方案的核心。

#### 2.2.3 super agent 编排工具

| 工具 | 用途 | 样本内调用 | 判断 |
|---|---|---|---|
| `superagent_control` | super agent 循环的角色门控控制面（`superagent.ts:333`） | 497 | 归到 `workspace_*` |
| `superagent_ledger` | 读写派发账本（`superagent.ts:915`） | 311 | 归到 `workspace_tasks`；账本数据丢弃 |
| `superagent_deliver` | 把报告或消息投递给另一个会话（`superagent.ts:1879`） | 33 | 归到 `workspace_message` |
| `superagent_permission` | 切换会话权限预设（`superagent-permission.ts:15`） | 37 | 归到权限预设服务 |
| `superagent_models` | 读取并选择模型路由（`superagent.ts:755`） | 7 | 归到模型设置 |
| `issue_work` | 执行侧的单据工作（`workIssue.ts:26`） | 本会话 0 | 保留到执行流程被替换 |

运行构建还暴露了 `superagent_session` 与 `superagent_workspace`。不保留别名：两个名字都移除，`workspace_sessions` 实现该能力。

### 2.3 `.dsh` 存储工具

| 工具 | 用途 | 样本内调用 | 判断 |
|---|---|---|---|
| `tool-dsh-store` | 在工作区 `.dsh` 下创建、查询、删除文件与目录；拒绝修改 `.dsh/memory`，路径检查委托给 store 服务（`tool-dsh-store/src/tool.ts`） | 0 | 保留，唯一入口 |

store 服务（`ctx.dshStore`）负责项目根发现、路径限制、命名空间写入校验与会话策略门（`store-atom/src/service.ts`）。记忆能力经该服务写 `.dsh/memory`，不经过这个工具。这个工具是规则、技能与其他 `.dsh` 内容的模型侧入口。

## 3. 重排原则

### 3.1 每个命名空间一个主人

| 命名空间 | 主人 | 结果 |
|---|---|---|
| `workspace_*` | 工作区信息设计 | 会话、进展、任务、消息、产物 |
| `memory_*` | 记忆设计 | 只留全局事实与约定 |
| `personality_*` | 本文 | 画像、表达风格、写作规则 |
| `jira_*` | 现在移除 | 不再有模型访问 |
| `superagent_*` | 作为公开面移除 | 行为迁入 `workspace_*`，不迁入 JIRA |
| `tool-dsh-store` | 本文 | `.dsh` 唯一经校验的入口 |

### 3.2 `workspace_*` 取代 super agent 任务面

`superagent_ledger`、`superagent_deliver`、`superagent_session`、`superagent_workspace` 是当前的任务、消息与会话面。工作区工具集用显式范围、回执、引用与幂等键定义同样的概念。两者都留会造出两套任务系统；因此设计把行为迁到 `workspace_tasks`、`workspace_message`、`workspace_sessions`，不保留并行的 `superagent_*` 任务 API。

### 3.3 JIRA 现在移除；派发账本丢弃，不迁移

JIRA 已废弃并立即移除：工具与技能都走，只留 GitHub 凭据相关的代码/配置，其余 JIRA cloud 配置删除，不做兼容层。派发账本没有旧账或历史价值，直接丢弃，不迁移；`workspace_tasks` 从新开始，不导入、不兼容。

### 3.4 personality 与 global 记忆分开存储

personality 管助手怎么说话、用户对交互的偏好：画像、风格、写作规则。global 记忆管跨工作区适用的事实与约定：服务器地址、默认模型、共享工作规矩。内容型偏好（例如“不要用内部代号”）是 personality 或写作规则；事实（例如“共享网关在这个地址”）是 global 记忆。两个文件不合并，因为生命周期、评审流程与失败模式不同。

### 3.5 `.dsh` 存储保持唯一入口

`workspace_artifacts` 发布引用，不复制。对 `.dsh` 下的路径，发布或解析都必须经过 store 的路径与命名空间检查；产物工具不能变成第二个写入者。除记忆能力外，`.dsh/memory` 对所有工具只读。

## 4. 逐工具结论

| 工具 / 组 | 结论 | 理由 | 影响面 |
|---|---|---|---|
| `personality_analyze` | 保留 | 只读、便宜、子代理可用 | 无变化 |
| `personality_apply` | 保留，收窄 | 写全局画像；只接受已确认候选 | root agent；子代理已被拒绝 |
| `write_like_human` | 并入 `personality_apply`；不保留独立工具 | 样本零调用；一个工具应拥有两个全局文件 | 维护写作规则的 root agent |
| `PERSONALITY.md`、`WRITING_RULES.yaml` | 与 global 记忆分开 | 生命周期与评审流程不同 | 有画像规则的用户；不迁移 |
| `jira_issue` | 现在移除 | JIRA 废弃；低调用；不兼容 | 仍读 JIRA 单据的 agent 停止 |
| `jira_kb` | 现在移除 | 样本 1 次；知识库是本地 Markdown | 知识库读者 |
| `jira_list` | 现在移除 | 7 次；列单据是面板的职责 | 列单据的 agent |
| `superagent_scan`、`superagent_claim`、`superagent_status`、`superagent_dispatch`、`superagent_source` | 现在移除 | 零调用；循环由 `workspace_tasks` 取代 | JIRA 认领/派发用户 |
| `superagent_control`、`superagent_ledger`、`superagent_deliver` | 归到 `workspace_*`；不保留别名 | 大量使用；不能留下并行任务系统 | super agent 派发方；所有相关提示 |
| `superagent_permission` | 归到权限预设服务 | 会话策略已经持有预设 | 切换预设的会话 |
| `superagent_models` | 归到模型设置 | 模型路由是配置，不是任务工具 | 选择模型的会话 |
| `superagent_session`、`superagent_workspace` | 移除；不保留别名 | 运行构建观察到；`workspace_sessions` 实现该能力 | 用过别名的会话 |
| `issue_work` | 保留到执行流程被替换 | 执行角色需要写入路径 | 执行会话 |
| `tool-dsh-store` | 保留，`.dsh` 唯一入口 | 路径、命名空间与策略检查都在这里 | 编辑 `.dsh` 的 agent |
| JIRA 账本 `$DSH_HOME/jira` | 删除；删除前可选一次静态导出 | 不兼容；删除后不可恢复 | JIRA 读者、面板、CLI |
| 派发账本 `.superagent/ledger` | 丢弃；不迁移、不导入 | 没有旧账或历史价值 | 旧任务历史不可用；`workspace_tasks` 从新开始 |
| JIRA cloud 配置 | 只留 GitHub 凭据相关代码/配置；endpoint、项目/租户、超时等其余项删除 | GitHub 凭据可能复用；其余已无用 | JIRA/面板/CLI 用户；配置 owner |

## 5. JIRA 移除与 cloud 配置

### 5.1 立即移除

JIRA 一步移除，不分阶段：

- 移除 `jira_issue`、`jira_kb`、`jira_list`、认领/派发工具（`superagent_scan`、`superagent_claim`、`superagent_status`、`superagent_dispatch`、`superagent_source`），以及 JIRA 技能（`jira-work`、`jira-board`、`jira-triage`）。没有只读阶段、没有导出阶段、没有第 4 阶段。
- 只留 GitHub 凭据相关的代码/配置：凭据查找与读取它的代码留下。其余 JIRA cloud 配置（endpoint、项目/租户、超时与相关条目）删除，不保留兼容。
- 不为任何被移除的名字保留别名。`superagent_session` 与 `superagent_workspace` 也移除；`workspace_sessions` 实现该能力。
- 删除 JIRA 本地单据账本。删除前可选做一次静态导出；不做则数据不可恢复。移除后没有工具读它。
- 派发账本丢弃。没有迁移、没有导入、没有兼容；`workspace_tasks` 从新开始。旧任务历史不保留，这是可接受的，因为没有旧账或历史价值。

### 5.2 依赖

- JIRA 面板与 CLI 不是模型工具。它们失去模型工具面，账本删除后也没有本地数据可读。不为它们做兼容层。
- 任何读取 JIRA 账本的调度或自动分析，必须在同一次变更里停止或下线；没有归档可读。
- 派发账本的写入方迁到 `workspace_tasks`；旧账本不再读。super agent 编排工具不是 JIRA，迁到 `workspace_*`。
- 发布后确认只留下 GitHub 凭据配置，其余 JIRA cloud 条目已删除。

### 5.3 回滚

- 移除是一个版本。回滚是重装上一版并恢复上一版配置；GitHub 凭据配置从未删除，其余 JIRA cloud 配置已删除，JIRA 本地数据已删除且不可恢复，只剩可选的静态导出。
- 派发账本已丢弃；回滚不能恢复其历史。这是可接受的，必须在发布说明里写明。

## 6. personality

### 6.1 与 global 记忆的边界

| 内容 | 归属 | 例子 |
|---|---|---|
| 画像、语气、交互风格 | personality profile | “直接说结论，先给判断” |
| 写作规则 | `WRITING_RULES.yaml` | “不要用内部代号” |
| 关于“怎么工作”的跨工作区偏好 | personality profile | “一次只问一个问题，不要问卷” |
| 跨工作区事实与约定 | global 记忆 | 共享网关地址；默认模型 |
| 工作区业务事实 | 工作区工具 | 会话进展、任务、产物 |

路由规则：如果一句话改变的是“助手怎么表现”，归 personality；如果它陈述的是“跨工作区什么是真的”，归 global 记忆。两者都拒绝的，是业务事实。

### 6.2 存储

不要把 `PERSONALITY.md` 或 `WRITING_RULES.yaml` 并进 global 记忆。它们是全局文件，有各自的修订、评审与提示注入路径。合并会让一次风格编辑与一次服务器地址编辑共享一个写入者、一份 diff、一次回滚。

### 6.3 工具

- 保留 `personality_analyze`，只读，子代理可用。
- 保留 `personality_apply`，只给 root agent；收窄到已确认候选与两个 personality 文件。
- `write_like_human` 并入 `personality_apply`；合并后的工具拥有两个全局文件，不再保留独立的 `write_like_human`。
- 不新增 `workspace_*` 的 personality 路径；personality 按定义就是全局的。

## 7. `.dsh` 工具

### 7.1 唯一入口

`tool-dsh-store` 仍是 `.dsh` 内容的唯一模型侧工具。它拥有创建、查询、删除；store 服务拥有路径规范化、根限制、命名空间检查与会话策略门。不引入新的 `dsh_*` 家族；改名成 `dsh_store` 没有行为收益，只是折腾，暂缓。

### 7.2 与 `workspace_artifacts` 的关系

`workspace_artifacts` 发布带 id、路径、哈希、大小、版本的引用。对 `.dsh` 下的路径，发布与解析必须经过 store 的检查：产物工具不写文件、不绕过路径限制、不复制 `.dsh/memory`。接收方在解析引用后，通过 store 工具或 store 服务读取内容。

### 7.3 权限与沙箱

store 工具在写入时检查 `.dsh` 规则，并拒绝修改 `.dsh/memory`。会话策略仍然门控写入；只读会话可以查询，但不能创建或删除。跨工作区产物引用必须显式且留痕；来自别的工作区的 `.dsh` 路径，只有在调用方有可读授权时才解析，否则结果是 `denied`，不是 `missing`。

## 8. 风险与待拍板点

### 8.1 需要你拍板

无。剩余决定已关闭；见 8.3。

### 8.2 风险

- JIRA 本地数据删除；没有可选的静态导出就不可恢复。
- 丢弃派发账本会丢旧任务历史。接受，因为没有历史价值；不要尝试导入。
- GitHub 凭据相关代码/配置被随工具误删：把它排除在移除之外，发布后确认仍在。其余 JIRA cloud 配置是有意删除。
- 过渡期两套任务系统：`superagent_*` 与 `workspace_*`。缓解：旧面不接新功能；设定固定结束日期；工作区工具先落。
- personality 与 global 记忆重复记同一条偏好。缓解：6.1 的路由规则，加上首批迁移条目的评审。
- 通过产物绕过 `.dsh`。缓解：发布与解析都走 store 检查；`.dsh/memory` 保持只读。
- 立即移除没有阶段回滚：重装上一版；丢掉的派发账本与删除的 JIRA 数据都无法恢复。

### 8.3 本轮确认

- JIRA：现在移除，不分阶段；只留 GitHub 凭据相关代码/配置；其余 JIRA cloud 配置删除；不做兼容层。
- 派发账本：丢弃；不迁移、不导入；`workspace_tasks` 从新开始。
- JIRA 技能：随工具一起移除；不留副本。
- 别名：不保留；`superagent_session` 与 `superagent_workspace` 移除，`workspace_*` 实现能力。
- JIRA 本地数据：删除；删除前可选一次静态导出；不可恢复。
- personality：`write_like_human` 并入 `personality_apply`；不保留独立工具。

## 9. 与记忆/工作区设计的冲突

| 点 | 记忆/工作区设计说 | 本设计说 | 动作 |
|---|---|---|---|
| `superagent_*` 各行 | 不变，范围外（2.3 节、6.2 节表） | 编排工具归到 `workspace_*`；不保留别名；JIRA 循环现在移除 | 工具面设计赢；修订记忆设计的表 |
| `superagent_deliver` | 未提；`workspace_message` 取代回合结束投递 | `superagent_deliver` 是当前投递面，且被大量使用 | 工具面设计赢；加入记忆设计映射并随迁移移除 |
| `.dsh` 行 | 范围外、不变 | `tool-dsh-store` 保持唯一入口；产物引用它 | 无冲突；记忆设计加一条指向本文的引用 |
| personality 存储 | 边界留白 | 不合并存储；画像与写作规则分开 | 工具面设计赢；记忆设计解决 2.3 节的留白 |
| `workspace_*` vs `dsh_*` 命名 | 列为待对齐冲突 | 现在不改 `dsh_*`；`tool-dsh-store` 保留名字 | 工具面设计赢；记录决定 |

JIRA 现在移除：`jiraKey`、账本兼容、`superagent_*` 的 JIRA 绑定都直接去掉，不做调和，因此不再列为冲突行。派发账本丢弃、不迁移；记忆设计已改为 `workspace_tasks` 从新开始，因此也没有冲突行。

本文不修改记忆设计。批准之后，上表就是要在那边应用的具体修订；在此之前，记忆设计里的“范围外”表述对它的范围仍然成立。

## 10. 附录：证据与未决数据

- 工具调用计数：一个 super agent 会话，827 个完成 turn，约 2,200 次工具调用。JIRA 单据工具 19 次；JIRA 认领/派发工具 0 次；super agent 编排核心 841 次（`superagent_control`、`superagent_ledger`、`superagent_deliver`），另有 139 次属于 session、permission、models、workspace；personality 4 次；`.dsh` store 0 次。
- JIRA 账本：`$DSH_HOME/jira`，git 仓库，最后一次提交与最后一次单据写入为 2026-11-10 21:15 +0800；`projects/` 下 315 个文件，知识条目 13 个。删除；删除前可选一次静态导出；不可恢复。
- 派发账本：`.superagent/ledger`，最后更新 2026-11-17T09:34Z；`reports.jsonl` 于 2026-11-17 本地 17:34 写入。丢弃；不迁移；`workspace_tasks` 从新开始。
- personality：`PERSONALITY.md` 于 2026-11-17 15:48 写入；该路径下未观察到 `WRITING_RULES.yaml`。
- 局限：一个会话不是普查；运行构建暴露的别名现已移除；JIRA 面板与 CLI 不是模型工具，未计入。
