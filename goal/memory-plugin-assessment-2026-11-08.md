# Memory 插件体系评估：实际使用、可靠性、职责边界与 Windows 复跑

> **Fedora 实机反馈**：本评估基于 Fedora（Linux）实机反馈，Windows 复跑后可能不同；后续以 Windows 复跑为准。

调查日期：2026-11-08。源码基线为当前 dev checkout 的 `34dbf54741`，调查开始前完成；报告与 jira 台账评估相邻，但不复述其 issue、dispatch 和报告路由实现。本文是只读调查，不是代码变更或已验证的重写方案；建议均需另行验收。

## 0. 结论先行

1. **本机的 memory 已经高频“生产和注入”，却没有形成可证明的“检索和恢复”闭环。** 固定截点内，13 个相关 root session 有 67 次 `memory_write` 调用（66 成功、1 失败），却只有 1 次 `memory_search`、0 次 `memory_read`，且唯一一次搜索因默认 `openAt: never` 直接失败。自动摘要则已结算 266 个 job，其中 72 个是历史容量失败；持久日志中出现 312 条 snapshot、75 条 notice/update 和 18 条 detail checkpoint。大量记录存在，不等于 agent 后来使用了它们。
2. **当前最需要修的是可靠性，不是再扩充记忆类型。** 默认组合的搜索会在查 MEMORY.md 之前失败；运行中连续完成的 turn 只保留最后一个待摘要项，中间 turn 可永久缺失；人工维护命令在 stale-version 重试时可能用新版本号覆盖旧正文；surface checkpoint 与 MEMORY.md 又没有共同事务。与此同时，每个完成的 turn 都花一次模型调用生成摘要并追加状态快照，且摘要无法解析时会把原始输出当 `decision` 保存。
3. **职责应按可淘汰性和权威性拆开：memory 只保留可淘汰的工作区结论/摘要与有界读取，不承载任务状态或安全约束。** DSH Session 是原始证据；compaction 是当前上下文的救急压缩；Jira issue/KB 是通用任务和策展知识；dispatch domain 与 `.superagent/reports.jsonl` 分别管业务结果和投递路由。若替换 memory，superagent 只需可选的 `append/recall/read` 接口与任务引用，不应依赖 MEMORY.md 格式、快照消息或 checkpoint 元数据。

### 建议的最小目标形态

- **保留**：root-only 工具接线、按工作区隔离、带来源的 bounded 读取、版本守卫写入、人工暂停/编辑/回滚能力。
- **先修**：默认检索降级、摘要队列完整性、冲突后重算、checkpoint 恢复、每轮快照膨胀。
- **移出**：pending/returned/failed、Session 路由、报告投递、后台 job 唯一性等运行控制；硬性“不可启动/不可配置”约束应进入 rules 或经确认的偏好，不应等待 memory 淘汰。

## 1. 调查范围、口径与限制

### 1.1 数据来源

- 核心实现：`packages/uitstalie/memory`，以及它依赖的 `dafeiyu`、`store-atom`、`session-query-sqlite`、Session surface 与 `fs-local`。
- 按需审查：`packages/uitstalie/ui-memory`；superagent 仅读 memory curation、工作区定义和与报告/domain 的引用点。
- 实际存储：dev 与 super workspace 的 `.dsh/memory/sessions/MEMORY.md`。
- 日志：`/home/uitstalie/.dsh/sessions` 下 dev、superagent、MTool、Rockstar Games 的 `session.v4.jsonl.zstd`。
- 组合：当前 base/web 的 memory 和 session-query 行、web profile；运行中的 runtime checkout 未改动。

### 1.2 固定截点与计数

调查截点为本任务首条 `turn/start` 的时间：**2026-11-08T21:31:01.034+08:00（epoch ms `1794144661034`）**。只解压到内存/标准输出，只计真正落盘事件；时间晚于截点的事件全部排除。统计树由本次 memory 调查的父 session 和子 agent 组成，连同刚完成的 jira 调查 `session-00f47534…` 一并排除；其他无 `session-` 前缀的调查子 agent 不进入 root 统计。

最终样本是 **13 个 root session**：dev 6、superagent 4、MTool 1、Rockstar 2。计数口径：

- 工具：只计 `tool/call.data.name` 为 `memory_*` 的事件；结果按 `toolCallId` 对齐，`isError:true` 为工具失败。
- 快照/更新/checkpoint：`user/message` 的 `source.kind === 'memory'`，分别按 `form:'snapshot'`、无 `window` 的 notice、带 `window` 的 checkpoint 分类。
- 摘要：计 `kind:'memory'` 的 `job/settled`，不把 job 注册重复算成一次完成；`killed` 与 `failed` 分开。
- compaction：计 start/summary/end，不把每次 `compaction/prune` 当成一次完整压缩。
- “复用”分两层：memory 工具真实 search/read，以及普通 `read`/`bash` 直接读 MEMORY.md；后者单独标注，不能混称工具闭环。

这是本机现有日志的横截面，不是稳定频率基准。旧日志跨越多个实现版本，报告将历史故障与当前源码分开；统计只证明日志中的可见事件，不能证明某条摘要在模型内部从未产生影响。

### 1.3 证据限制

- 未调用 memory/Jira/superagent 写工具，未启动或关闭服务/游戏，未改 runtime checkout，未修改任何被调查的存储。
- 没有为调查启动真实模型，因此没有新增 token 账单或 Windows 实机数据；辅助摘要成本用调用次数而非臆测的 token 总量表达。
- 运行实例可能落后于源码：例如调查时 runtime checkout 仍为 `c27876250d`。历史日志只能证明当时的可观察行为，当前问题另由源码行证明。
- 本轮没有对 Windows 做文件锁、junction、ACL 或真实 compaction 中断实验；相关段落明确列出待验证项。

## 2. 现状与实际使用证据

### 2.1 总量：写入远多于读取，自动工作远多于显式整理

| 工作区 | root session | turn/end（completed / aborted） | memory_write 调用 | 成功 / 失败 | memory_search | memory_read |
|---|---:|---:|---:|---:|---:|---:|
| dev | 6 | 77 / 2 | 6 | 6 / 0 | 0 | 0 |
| superagent | 4 | 136 / 4 | 59 | 59 / 0 | 1（失败） | 0 |
| MTool | 1 | 9 / 0 | 0 | 0 / 0 | 0 | 0 |
| Rockstar | 2 | 58 / 4 | 2 | 1 / 1 | 0 | 0 |
| **合计** | **13** | **280 / 10** | **67** | **66 / 1** | **1（失败）** | **0** |

`memory_write` 的 kind 为 decision 43、open 18、files 3、preference 3；写入正文合计 35,296 bytes。按规范化小写正文检查，67 份调用正文没有完全相同的重放，但语义重复明显：显式结论、同一 turn 的自动摘要、Session 最终回答和 dispatch outcome 往往各写一遍。`/memory` 命令没有出现在目标日志的 `command/run` 中；`curate_memory:true` 的真实调用为 0，出现该字样的记录均是功能介绍、源码或任务文本。

| 自动/注入行为 | 数量 | 正文 UTF-8 bytes | 解释 |
|---|---:|---:|---|
| memory job 已结算 | 266 | — | 192 completed、72 failed、2 killed |
| snapshot | 312 | 96,586 | 每次成功摘要可能再追加一份状态索引 |
| notice / 显式写入 update | 75 | 38,093 | 包含写入回显与历史失败提示 |
| detail checkpoint | 18 | 15,227 | 旧历史行为；不是当前每个 turn 都折叠 |
| 完整 compaction start/summary/end | 各 5 | — | 样本里只有 5 次完整边界 |

192 次 completed 只表示 provider 报告完成，不等于都写入了新摘要；空对话或暂停也可完成。312 个持久 snapshot 也不是“每次请求都增加 312 份”的账单：旧节点可被 compaction 移出 live surface。它准确证明的是**日志中的追加量和注入设计成本**，不是每轮累计 token 的测量。

### 2.2 “写了但没有被工具回读”的具体证据

- dev `session-390341c3-0508-4e01-ab10-6ccc67271095` 有 6 次成功写入（行 124、1065、1119、1160、2316、2358），其 session 中没有 memory search/read。后续 superagent 又在 `session-e00351a8…` 写入相似的上游同步、推送和报告修复结论；同一事实跨工作区各存一份是隔离设计的结果，但也意味着 super workspace 不能靠 memory 工具读取 dev 的结论。
- super `session-56e66d2e…` 有 24 次成功写入，无 search/read；`session-e00351a8…` 在截点前有 27 次成功写入、唯一一次失败搜索，无 read。大量 `task-*` tags 使这些条目更像 dispatch 结果副本，而非独立知识。
- MTool `session-88469918…` 无显式工具调用，仍有 9 个完成摘要 job 和 9 条 snapshot；零 memory 操作不等于零后台成本。
- 唯一一次历史补救尝试在 `session-e00351a8…` 行 144/145、seq 142/143，2026-11-07 21:36:03：搜索 `"tool-pair-repair unknown to this harness"` 返回 `Error: session search is disabled: this deployment configures the session-query index with openAt "never"`。随后行 433/seq 431 查 dispatch，行 435/seq 433 改用 `bash grep` 搜 `.superagent` 与 `.dsh/memory`，行 443 再直接查两个 checkout 的构建产物。也就是说，恢复工作靠通用工具完成，不是 memory 闭环完成。

存在少量直接文件读取：super `session-3f77ab15…` 行 62/seq 60 用普通 `read` 打开 MEMORY.md；`session-65b3d531…` 行 57/seq 55 用 bash 读 dev MEMORY.md。这证明人/agent 可以绕过工具看文件，不证明渐进检索有用，且跨工作区直读不能成为权限模型。

### 2.3 容量失败、淘汰与硬约束绕行

72 个失败全部来自旧 4 KiB 正文上限：dev 长 session 31 个，Rockstar 长 session 41 个。它们跨 2026-10-24 至 11-01 反复出现，不能把旧比例当作当前默认 16 KiB 实现的失败率；当前代码已把迁移放到追加之前，并增加 40 条/会话保留上限。

最有价值的实例是 Rockstar `session-0e8d563d-2670-46f7-a785-ab2a8788e639`：

- 行 4358/4359、seq 4356/4357，2026-10-25 13:17:23，`memory_write(kind:'preference')` 想记录“禁止调用 wine”；
- 返回 `Error: memory body is 4513 bytes, over the 4096-byte limit; forget or trim older entries before writing more`；
- 行 4363 的 assistant 明说“记忆体已经满了……把它固化成编辑规则”，随后创建 `.dsh/rules/no-wine.md`；行 4380 说明规则成为常驻工作区指令。

这说明规则优于可淘汰记忆承载硬约束，也暴露了失败恢复成本：调用者只能放弃或改走别的存储；当时没有可执行的模型侧修正接口。

当前 MEMORY.md 又展示了另一类“被遗忘/覆盖”：在 2026-11-08 21:39 左右、独立于上述日志截点的文件读取中，super 文件只剩 `session-e00351a8…` 的 turn 46–53，共 29 条，先前的显式偏好和其他任务结论已不在当前文件。该文件随后仍随父会话变化，故本段不是截点快照。源码的 `retainDocument` 会按 session 数、每 session 条数和总字节淘汰旧区块；frontmatter 对应 turn 记录也可被删除。原始 Session JSONL 仍是恢复来源，但默认全文检索不可用时，“原文件永远可搜索”的承诺没有可达的工具路径。

### 2.4 快照与 compaction：历史干扰已修一部分，现行成本仍存在

`1416a52e8b` 的记录给出了本机实测根因：原地替换早期 snapshot 使缓存前缀从约 16,896 token 后失效；`8d9fafefa5` 又记录 aged-turn 替换在普通 turn 上破坏前缀，并把 checkpoint 移到 compaction 边界。当前 append-only 是针对真实问题的修复，不应当作纯浪费撤销。

但日志仍给出两类具体反例：

1. super `session-56e66d2e…` 行 685、687、688、689、690、691（seq 683、685–689）在 2026-11-05 01:43–08:02 连续写入六条带 `surfaceOp:replace` 的相同 `Window: turns 18–21…` 快照；持久日志保留六份，但不表示 live surface 同时有六份。较早行 583/seq 581 还出现 `Window: no turns summarized yet`，尽管该 session 已有多轮摘要。该行为属于旧实现，不能用来说明当前 `lastSnapshotText` 一定仍有同样 bug；它证明旧替换逻辑曾反复写入同一状态。
2. super `session-e00351a8…` 在 2026-11-08 有 52 个截点前 snapshot。其他会话被淘汰后，多数只剩 215 bytes，反复重写 `Archived: turns … Raw turns stay in context until the next compaction`，并不携带新结论。显式写入另产生最长 1,066 bytes 的 `Memory updated` notice，600 字符截断后还提示“用 memory_read/search 看全文”，而 search 在该部署实际不可用。

当前文件摘要与原文在两次 compaction 之间并存，所以 MEMORY.md 不是“已经移出上下文”的证明。当前 snapshot 代码在 `forgottenThrough` 存在时先写 `Turns through N are removed from context`，又无条件下一句 `Raw turns stay in context until the next compaction`；文件可已遗忘正文而 surface 尚未替换，这是现行错误，不只是措辞含糊。样本的 5 次 compaction 中未找到可归因于 compaction 的“遗忘后重学”实例；常见重查代码/文件是正常工作，不能冒充遗忘证据。

## 3. Memory 插件的数据模型与生命周期

### 3.1 存储不是独立的“session memory 数据库”

权威文件为 `<projectRoot>/.dsh/memory/sessions/MEMORY.md`；另有最多 100 条人工编辑记录 `MEMORY.history.json`。workspace root 由 `dshStore.projectRootFor` 从 Session cwd 向上找 `.git`，不是把调用者传入的路径直接拼接。没有 `.git` 的 super workspace 使用其自身目录；子目录中的 Session 则可能归到上层 checkout。

YAML frontmatter 存 `version/window/summaryPaused` 与 session `id/cwd/updatedAt/turns/forgottenThrough`；正文是 `memory:begin/end` 托管区块。每个 session 以 turn 区间和 detail/brief 分节，条目支持 `decision/files/open/preference`、可选 tags、turn、人工 source 和 revision。显式工具没有 entry id 或 upsert，只有文本归一化去重；`open` 也不会在问题解决时自动关闭，旧结论与更新结论可同时存在。

这不是把 Session 原文复制成另一份完整数据库：工具只暴露对话面，摘要不取工具 payload。但它确实把 Session 的身份、路径、时间、摘要和 surface checkpoint 坐标复制进第二份存储，且两套状态需要恢复协议。

### 3.2 触发与窗口的真实顺序

1. `dafeiyu` 给 root agent 接固定 prompt 和三个工具；子 agent 不接线。
2. 每个 `reason.kind === 'completed'` 的 root turn 启动一个 memory job；同一 session 同时只跑一个 pass，后来者覆盖单个 pending。
3. pass 从 Session 读取本轮对话面，每段文本最多 2 KiB、合计 24 KiB；调用模型产出一至四条 JSON 条目，再写入 MEMORY.md。
4. tier migration 实际在 detail append **之前**执行；年龄阈值为 detail=6、brief=16、forget=21，最多保留 10 个 session。
5. 两次 compaction 之间文件仍可 brief/forget，但 surface 只追加；只有新的 `compaction/end` 到来才允许替换旧区间。
6. 成功写入后刷新 snapshot：depth-0 模式 append user message；prompt 模式更新 `memory-state` 段。已有快照时，显式 `memory_write` 只追加最多 600 字符正文的 update。
7. 失败保留旧文件；每 runner/session 第一次摘要失败追加 notice，之后只写 host 日志。暂停期间不回填，进程重启也没有持久未摘要游标。

因此“遗忘”有三件不同的事：托管正文被删、live surface 被替换、原始 Session 永久保存。只有前两项由 memory 管；第三项不属于它。prompt 模式也不减少摘要成本，还会让变化的 memory-state 影响其后的系统前缀。

### 3.3 单文件可靠性与跨文件事务不是一回事

`dshStore.writeFile` 将版本守卫映射到 `replaceIfVersion`；`fs-local` 用同目录私有 staging、sync 后 rename，Windows 对已有文件走 `ReplaceFileW` 并复制 DACL。它能保证单文件不会发布半截文本，但不能保证 MEMORY.md、history sidecar 和 Session surface 同事务。

追加路径 stale 后会重读并重组；维护命令却只换版本号再写旧 `document`。在允许 surface replace 的 compaction 边界，迁移先发 checkpoint 再写元数据，I/O 失败或进程退出可留下“surface 已替换、文件仍旧 tier/旧 seq”的半提交；两次 compaction 之间又可不发 checkpoint 而直接更新文件 tier/forgottenThrough。当前恢复使用 window/seq 匹配，是补偿而非原子事务。

## 4. 工具设计与 agent 反馈问题清单

严重度定义：P1 表示会丢失核心能力、持久缺段或覆盖新写入；P2 表示结果不完整、语义误导或显著增加摩擦；P3 表示局部边界、文档或可观测性问题。本次没有声称未经实测的 Windows 安全绕过。

### 4.1 P1：默认部署中检索不可用，且连 MEMORY.md 命中也无法返回

`memory_search` 先执行 `sessionQuery.searchSessions`，之后才读 MEMORY.md。base/web 默认 `openAt:'never'` 会抛 `SESSION_QUERY_SEARCH_DISABLED`，没有任何局部降级。真实错误见 §2.2；这不是“用户没装 SQLite”或“查询没有命中”，而是组合与工具默认语义冲突。

固定 prompt 仍要求 search→read，snapshot 与 update 又反复指向这两个工具。agent 不得不改用 grep/read；模型可见搜索范围和实际能力不一致。

### 4.2 P1：连续完成的 turn 会永久跳过中间摘要

每 session 只有一个 `pending: TurnEndInput`；运行中完成 turn 2、3 时，3 覆盖 2，pass 结束后只总结最新 3。`runPass` 只读取一个 turn，没有按最后持久 turn 回填。现有“两快速 turn”测试恰好不能覆盖第三个覆盖第二个的情况。

结果是 MEMORY.md 静默缺段，后续窗口和 checkpoint 也不会自动补齐。当前样本没有足够时序证明某个具体 turn 已由这条路径丢失，因此本条是**当前代码可确定的问题**，不是伪造的日志实例。

### 4.3 P1：pause/edit/revert/prune 的 stale 重试可能覆盖新摘要

这些维护操作先基于旧文档构造 next；`writeNextMemoryDocument` 遇 stale 后重读只为拿新 `version`，仍写原来的旧文档。与追加路径不同，它没有基于最新状态重算操作。

例如 pause 与后台摘要竞争时，第一次写被拒，第二次可接受新版本号并删掉刚提交的 turn 摘要，命令仍报告成功。这类覆盖可在同机不同 Session/进程出现，Windows 复跑必须显式注入竞争。

### 4.4 P2：自动摘要有每轮成本，却缺少“无结论”和质量失败语义

每个 completed root turn 都发辅助模型请求，不只 age=6 时才总结。摘要 prompt 在无 durable 结论时强制产出一个 decision；非法 JSON 或没有合法条目时，parser 又把最多 300 字符的原始模型输出作为 decision 写入。两者都把“没有可靠结论”变成持久事实。

主会话最终回答、显式 memory_write 与自动摘要还会重复记录同一事实；`open` 没有 supersede/resolve。现有 normalize 去重只识别等价文本，不能识别“已推送”取代“未推送”或新结论纠正旧结论。历史失败 notice 每 runner 仅一次，持续损坏只进日志，恢复通知也不可证明已被 agent 处理。

### 4.5 P2：snapshot 为状态索引而每轮追加，低信息内容也会累积

当前实现为避免缓存重写而不替换旧 snapshot，这是有实测依据的取舍；但每个摘要 pass 都会 append 全量索引，旧状态仍留在未 compaction 的 session 中。空 recent-sessions 时仍反复追加窗口说明；有索引时还可能把旧的跨 session 第一条摘要重新注入。

`snapshotTemplate` 在 16 KiB 核心文本截断后包裹且没有自身上限，因此完整消息可超过宣称的预算。depth-0→prompt 切换不会删除旧消息，可能同时保留两套状态。`forgottenThrough` 的 `removed from context` 与下一句 `Raw turns stay in context` 也可在文件已遗忘、surface 未折叠时同时成立。这是注入通道的固有权衡和现行状态错误，不应再被描述为“一条当前快照”。

### 4.6 P2：搜索与读取结果的完整性/错误可见性不足

- session hits 排在 memory hits 之前，再统一 slice；若 memory hits 被丢弃而 session 页无 nextCursor，`truncated` 不一定为真。
- MEMORY.md 解析失败只记日志并当作无 memory hits；最终可能显示 `No memory matches`，模型无法区分“不存在”“损坏”“被索引/字节上限省略”。
- `memory_read` 虽称 completed turn，实际配对任何 turn/end；默认最新 turn 可能是 aborted/failed/blocked。
- read 对不存在的 turn、未授权目标和空历史返回普通短文本而非 `isError`，对对话恢复友好，但机器侧不能仅靠错误标志区分全部失败。
- 读取每次只取一个 turn，邻接 before/after 各 0–10 个事件；不含工具参数和 payload。对定位原文安全且省上下文，但多 turn 调查需要多次调用，截断后又需更多往返。

### 4.7 P2：memory 与 superagent 的“整理”入口无法兑现其措辞

`curate_memory:true` 只给目标 Session 加一段 prompt，要求 merge duplicates、mark stale、补结论；底层 memory 工具没有 merge、mark stale、update/delete，唯一自动去重是相同文本保留第一条。目标 agent 只能靠人工命令/文件约定或新增近似条目，工具能力与任务语义不匹配。本机真实使用为 0，说明它目前不是已验证的维护路径。

### 4.8 P3：参数边界与 UI/文档有可见漂移

- `memory_search.limit` 和 `memory_read.before/after` 对越界值 clamp，而非按 schema 描述拒绝；`memory_write` 的 tags 超长/超数会截断/丢弃，不一定让调用者知道标签已变化。
- `memory_write` 成功只给 path/kind/version，不给 entry/turn，也不报告 snapshot 更新失败；后者只写日志。持久化成功与“已被未来请求看到”应明确区分。
- UI 只编辑 10 个 volatile 字段中的 7 个，不正文浏览/编辑，也不预检 detail<brief<forget 或 provider/model 成对。provider 对非法 volatile 更新保留旧值，UI 可能已接受新文本但宿主只写 warning。
- 中文 README 一处仍称 append 后再 migration，另一处称 snapshot 替换和 `Window:`，与当前“先 migration、append-only、Archived:”相反。报告以代码和事件为准。

## 5. 与 Jira、superagent、Session/compaction 的边界与冗余

### 5.1 唯一权威应按问题而不是按文件格式分配

| 要回答的问题 | 唯一权威 | memory 可以保留什么 | 不应复制什么 |
|---|---|---|---|
| 当时到底发生了什么、哪条工具证据存在 | DSH Session JSONL | session/turn/seq 引用与提炼结论 | 完整日志、报告正文副本 |
| 当前模型还能看到什么 | Session live surface | 可选的有界状态投影 | 把 MEMORY.md 当 live surface 权威 |
| 当前上下文因 token 压力如何救急 | compaction 事件与 checkpoint | 不参与路由，不另造紧急压缩 | 再次压缩同一范围作为独立控制面 |
| 任务需求、状态、人工复核、跨机 issue 历史 | Jira issue 台账 | 可选 issue key 与最终经验 | issue 状态/评论/claim lease |
| 可复用、已策展的知识与来源 | Jira KB 或独立知识接口 | 待提炼草稿、KB key 引用 | 把每条 turn 摘要当长期知识 |
| 哪个 dispatch 做了什么、业务结果如何 | superagent dispatch domain；兼容后端另行定义 | 可选 task id 与精炼决策 | pending/returned/failed、workspace 路由 |
| 报告是否绑定/投递/重试 | `.superagent/reports.jsonl` | 不参与 | Session/rpcId/投递状态 |
| 用户明确硬约束、稳定偏好 | rules/AGENTS.md 或经确认的 personality | 临时观察、候选偏好 | 把会淘汰的 preference 当唯一强制来源 |
| 可淘汰的工作区工作记忆 | MEMORY.md（或替换实现） | 条目、摘要、引用 | 其他系统的运行锁与状态机 |

当前的 super workspace 指令要求“resolve 后再 memory_write”，使 dispatch outcome/decision/open 在 Session、dispatch 和 memory 至少出现三份。对审计有用的最小重复是 task/issue **引用**；把整段报告和待决项复制到 memory 不能弥补报告路由或任务状态缺陷。

### 5.2 哪些职责应保留在 memory

1. 工作区内有界的历史检索与读取，且原始 Session 可回溯。
2. 显式、可审查的 durable conclusion；有 kind/tags/turn/seq，但不必发明通用任务状态。
3. 可淘汰的跨 Session 摘要和按价值的保留策略。
4. 用户可暂停、编辑、回滚；失败与降级必须可见。
5. 可选的少量恢复提示；它不应每轮重放状态，也不能改变任务路由。

### 5.3 若替换/重写，superagent 的最小依赖

不需要暴露 MEMORY.md parser、window、tier、snapshotPosition、checkpointSeq 或 `MemorySummaryRunner`。建议只保留一个可选、中性接口：

- `appendConclusion({ workspace/session, taskId?, issueKey?, kind, text, tags?, source })`：只在调用者确有需要时写精炼结论；返回持久 id/version 和是否仅为缓存。
- `recall({ query, workspace/session, limit })`：可以只搜条目，或在 Session 搜索不可用时明确返回 partial；不保证其他工作区可读。
- `readReference({ sessionId, turn?/seq? })`：复用 DSH sessionQuery 的授权和有界读取，而不是 superagent 自读 `.dsh`。
- `curate` 若保留，必须是实际存储支持的 merge/supersede/delete 操作；否则从 superagent 参数和指令移除，不再用 prompt 模拟能力。

superagent 的 start/append/prompt、journal、dispatch 状态、compaction 和报告投递应在没有 memory provider 时完全工作。memory 关闭只影响可选经验恢复，不影响任务正确性。

## 6. 优化建议：优先级、收益与成本

| 优先级 | 建议 | 收益 | 成本与验收 |
|---|---|---|---|
| P0 | 解耦 MEMORY.md 搜索与可选 Session FTS；`openAt:never` 时仍返回 memory 命中，并显式标记 session partial | 恢复默认部署唯一检索入口 | 低；真实 base/web Loader 下测 memory-only 命中、无命中、Session disabled 三种结果 |
| P0 | 用持久高水位+待摘要队列替代单 pending；pass 依序补完，不把多个 turn 错写成一条 | 消除静默历史缺段 | 中；阻塞 turn 1、完成 2/3、重启/暂停/失败后验证全部且不重复 |
| P0 | 所有 read-modify-write 在 stale 后基于最新文档重算；命令和 sidecar 明确提交顺序 | 防止维护操作覆盖新结论 | 中；pause/edit/revert/prune 各注入真实竞争写并断言不丢数据 |
| P0 | 定义 checkpoint↔文件恢复协议，启动扫描并修复半提交；区分成功与失败的 compaction/end | 防止 checkpoint 与文件元数据脱节、正文已忘而原文仍在等状态时序错误 | 中高；在 checkpoint 后注入 I/O 失败/退出，验证 snapshot、frontmatter、surface 可收敛 |
| P1 | 停止每 turn 无条件生成“有结论”摘要；允许 entries:[]，解析失败不存原文，按显式写入/批次/关键节点触发 | 降低模型调用、重复与错误持久化 | 中；对比相同任务集的召回、写入条数、延迟与模型用量，而非只看文件更小 |
| P1 | 重做快照为“启动/需要时一份有界索引”，去掉每 pass 全量 append；模板纳入总预算 | 降低上下文干扰，保留 KV 修复成果 | 中；长 session 测 live 快照数、首请求 KV、compaction 后残留与真实首 token 成本 |
| P1 | 为条目增加稳定 id、supersedes/resolves 与读侧修正语义；open 不再与已解决 decision 并列永存 | 消除“未推送/已推送”等陈旧状态竞争 | 中；格式迁移、检索去重、人工回滚与跨进程竞争都要测 |
| P1 | 搜索结果显示 source 缺失/损坏/截断原因；read 按真实 completed 语义并允许精确小范围 payload 引用 | 降低误判与补救往返 | 低中；负例和模型可见文本快照覆盖，不能只测结构化值 |
| P1 | 移除或实现 `curate_memory` 的 merge/mark stale 能力；superagent 只在任务引用层调用 memory | 避免空泛 prompt 与跨职责重复 | 低至中；无 memory provider 时完成完整 dispatch/report 作为必过验收 |
| P2 | 将硬约束迁移到 rules/经确认 personality；memory 的 preference 只保存候选或观察 | 避免安全约束被淘汰 | 低；以真实 no-wine/no-launch 例验证新 Session 首轮即可见 |
| P2 | UI 展示正文、来源、淘汰与错误；保存跨字段配置时回读实际生效值 | 让人工治理可发现、可纠错 | 中；覆盖无 settings service、非法更新、正文损坏和只读部署 |
| P2 | 收敛固定 prompt、工具描述和 README 的重复/漂移；保留必要的“数据非指令” | 减少常驻成本与错误使用 | 低；模型可见文本对比和文档检查，不能牺牲权限与失败语义 |

不建议先做向量检索或把 MEMORY.md 换成另一个更大的控制面。现有问题是默认检索不可达、生命周期不完整和职责混杂；换索引技术不会修复这些问题。

## 7. Windows 复跑注意事项

### 7.1 固定身份、版本与组合，不照搬本机路径

1. 记录 dev/runtime 各自 commit、实际运行 build、profile 行、DSH_HOME、workspace header cwd、项目根发现结果和 memory root。当前 dev 的源码结论不能替代运行实例事实。
2. 显式记录 `session-query-sqlite.path/openAt`。默认 `:memory:` + `never` 与 memory 的搜索承诺冲突；若改为 `first-search`，要分别测内存索引和持久索引，不能把两者当同一跨重启行为。
3. 用真实绝对路径配置 super home 和工作区，不复制 Linux 的 `/home/uitstalie/...`；同时记录 path 大小写、尾分隔符、junction/symlink 形式。
4. `.dsh` store 接受 `/` 或 `\` 的相对路径，并拒绝盘符/UNC/逃逸/保留名；MEMORY.md 内部路径是 store-relative `memory/sessions/MEMORY.md`，不要让 Windows 调查脚本把它当 POSIX 绝对路径。
5. 保留现有未跟踪 `.dsh` 等数据；报告、memory 文件、Session 原始日志、dispatch domain 和报告 journal 分别备份，不放进同一实时共享目录让两机并发写。

### 7.2 路径身份与单文件发布要实机验收

- `memory_search/read` 的跨 Session 授权按 `header.cwd` **逐字相等**。Windows 同一目录的大小写、尾部分隔符、8.3 名或 junction 别名可能错误拒绝另一 Session；这是可用性风险，不是扩大读取权限。测试要比较 Session header，而不是只比较 UI 展示路径。
- store 的词法 containment 后还会由 fs resolve/realpath；若 `.dsh` 内存在 symlink/junction，必须实测最终写入目标与 sandbox 是否仍符合预期，不能只凭路径字符串宣称隔离成立。
- `fs-local` 已有 Windows `ReplaceFileW`、DACL 复制和 staging 逻辑，但这只是实现证据。需测目标被编辑器/杀软短暂占用、目标消失、写入中断、重启后 temp 残留与恢复。
- 版本冲突重试不是跨进程锁；MEMORY.md 与 history 是两次独立发布。两个 Host 同时操作同一工作区时，要测丢失更新和 sidecar 与正文不同步。
- 日志解压不要假定 Windows 有 `zstd`/`jq`/GNU 工具；用项目明确的 Node/zstd 依赖在内存中解码。记录固定截点，以 callId 对齐调用与结果，排除当前调查树。

### 7.3 快照、压缩与跨机一致性

- depth-0 与 prompt 分开测：前者累计持久 user 消息，后者变化系统段；切换时旧 depth-0 消息仍在，不能只看新配置就断言只有一份。
- 在真实 provider 上记录每次请求的 cacheRead/input 与上下文 surface，而不是从日志 event 数估算 KV；同时记录成功/失败 compaction/end 后 memory checkpoint 的时机。
- 原始 Session、memory 摘要、UI 设置和 SQLite 索引的可移植性不同。跨机复制 MEMORY.md 后，旧 session id/cwd/seq 必须能在目标机解析；否则只能把它当可读存档，不能宣称恢复了同一路径的历史。
- 同一工作区跨机使用时，明确哪个 Host 写 memory 和运行摘要 job；版本守卫不是分布式锁，不能靠两机共享文件代替 ownership。
- 按 `goal/AGENTS.md`，本机 Windows 不跑已知必红的 snapshot 通道；Windows 验收采用 focused 行为测试与实机记录，平台快照信号归 macOS/Linux CI。

### 7.4 建议的 Windows 最小复跑矩阵

1. **默认组合基线**：memory 条目已存在、Session FTS 为 never，搜索仍能返回条目并标明 session 部分不可用；read 用 seq 能定位原文。
2. **连续 turn**：阻塞第一摘要，完成第二、第三，再重启/暂停恢复；三个 turn 都有唯一摘要，无 pending 覆盖。
3. **维护竞争**：pause/edit/revert/prune 与后台写并发，stale 后重算，正文和 history 均不丢竞争结果。
4. **迁移中断**：detail/brief/forget 各在 checkpoint 后注入写失败/退出；重启可修复，失败 compaction 不触发错误折叠。
5. **长会话与缓存**：50 个有/无结论 turn，统计摘要调用、snapshot 条数、live bytes、cache 命中与 compaction 后残留。
6. **治理与职责**：无 memory provider 时 dispatch/report 仍完整；有 open 旧结论时可 supersede；硬约束在新 Session 首轮由 rules/personality 到达。
7. **Windows 文件与路径**：大小写/尾分隔符/junction 的 cwd 授权，ReplaceFileW 占用/消失/崩溃，两个 Host 竞争，备份后恢复。
8. **跨机**：Fedora 与 Windows 分别引用同一 task/issue，但各自 Session 路径和 memory 不冒充共享运行锁；同步后按可移植引用恢复，而非依赖本机绝对路径。

## 8. 附录：证据索引

### 8.1 关键源码

| 主题 | 路径与行 |
|---|---|
| 能力接线、root-only、turn 过滤与启动 snapshot | `packages/uitstalie/memory/src/index.ts:201-283` |
| 三个工具的参数、执行顺序与模型可见渲染 | `packages/uitstalie/memory/src/tools.ts:108-305,343-485` |
| read 授权、turn 配对、截断与短文本失败 | `packages/uitstalie/memory/src/read.ts:85-189,191-309` |
| 文档字段、kind 与默认窗口 | `packages/uitstalie/memory/src/memory-file.ts:30-193` |
| 维护命令与 stale 后旧文档重试 | 同上 `:528-781` |
| append、淘汰、去重与每 session 条数 | 同上 `:843-970,1764-2020` |
| checkpoint 与文件的非事务迁移 | 同上 `:998-1061,1182-1335,1410-1419` |
| 单 pending、每 turn 摘要、输入与 fallback | `packages/uitstalie/memory/src/summary.ts:117-158,203-399,436-527,605-697` |
| snapshot 注入、预算、append-only 与 update | `packages/uitstalie/memory/src/snapshot.ts:160-233,241-309,312-464` |
| live surface 区间避让 | `packages/uitstalie/memory/src/checkpoint.ts:72-120,139-228` |
| openAt:never 的正式拒绝 | `packages/session-query/session-query-sqlite/src/index.ts:268-344` |
| base 默认组合 | `packages/bundle/base/cordis.patch.yml:149-161` |
| store 根发现、版本守卫与策略 | `packages/uitstalie/store-atom/src/service.ts:199-351` |
| store 相对路径与 Windows 拒绝矩阵 | `packages/uitstalie/store-atom/src/paths.ts:54-127` |
| 原子写及 Windows DACL/replace | `packages/fs/fs-local/src/fsio.ts:601-701` |
| superagent curation 与 memory 指令 | `packages/jira/jira-agent/src/superagent.ts:2042-2057`；`super-workspace-definition.ts:37-57` |
| UI 配置范围与跨字段缺口 | `packages/uitstalie/ui-memory/src/client/settings.ts:34-49,112-116,156-215` |
| 历史缓存问题与修复依据 | `git show 1416a52e8b`、`git show 8d9fafefa5` |

### 8.2 关键 Session 文件

下列路径均相对于 `/home/uitstalie/.dsh/sessions/`，文件均为 `session.v4.jsonl.zstd`；“行”为 zstd 解压后的 JSONL 行。

| 用途 | 工作区目录 / session / 证据 |
|---|---|
| dev 显式写入、无工具回读 | `--home-uitstalie-~684C~9762-dsh-deepseek-harness-uitstalie-dev--/session-390341c3-0508-4e01-ab10-6ccc67271095`；写调用行 124、1065、1119、1160、2316、2358 |
| 历史容量失败与快照 | 同目录 `session-486d5296-3fd8-4158-84c7-fb5abc42257c`；失败例行 4262–4265，后续行 4300–4302；重复状态见 §2.4 |
| super 24 写、16 个旧 checkpoint、1 次 compaction | `--home-uitstalie-~684C~9762-dsh-superagent--/session-56e66d2e-dbe6-40ac-98c6-2a4ef3840ea8`；相同快照行 685、687–691；compaction 行 883–887 |
| 唯一搜索失败与补救 | 同目录 `session-e00351a8-2a4e-48f1-ad6e-e107d926d723`；行 144/145（seq 142/143），随后行 433–443；截点前 27 次写成功 |
| 直接文件读取对照 | 同目录 `session-3f77ab15-21eb-437c-a6e9-942e0a26381e` 行 62/seq 60；`session-65b3d531-d66a-4e47-8d32-57c26d171ebf` 行 57/seq 55 |
| 硬约束写失败并转 rules | `--home-uitstalie-Games-grand-theft-auto-san-andreas-drive_c-Program~0020Files~0020~0028x86~0029-Rockstar~0020Games--/session-0e8d563d-2670-46f7-a785-ab2a8788e639`；行 4358/4359、4363、4380 |
| 无显式 memory 使用但自动摘要 | `--home-uitstalie-~684C~9762-steam-MTool-Tool--/session-88469918-e849-410a-a896-c6b4152b1252`；截点前 9 个完成 job、9 条 snapshot |

### 8.3 本机文件快照与复核入口

- dev MEMORY.md 在 2026-11-08 22:37 左右复核时为 15,544 bytes、5 个 session、49 条；super MEMORY.md 在约 21:39 的独立读取中为 9,832 bytes，且只保留一个活跃 session 的末段。后者是随父会话继续变化的运行时文件，不是固定截点快照；它证明淘汰已发生，不能用旧 session 的全部写入数推断当前文件仍保存全部正文。
- 本报告的数字复核脚本未落盘：用 Python `subprocess` 调只读 `zstd -dc`，逐行解析 JSONL，以 `time <= 1794144661034` 固定截点，按上述事件类型计数；Windows 复跑应把同等逻辑写成临时/内存脚本，不依赖 shell 工具集。
- 先前未跟踪的 `prompt-audit/` 提供过工具文本/token 测量和缓存背景，但仍是未跟踪材料；本报告没有修改、提交或把它当当前运行的独立证明。
