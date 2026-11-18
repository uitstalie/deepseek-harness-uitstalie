# 真实数据上的记忆迁移 dry-run：分类精度与业务历史缺口

[English](memory-migration-dryrun-review-20261118.md) | 中文

状态：复核备忘。dry-run 已在七个真实工作区上跑过，未写入任何记忆数据；没有执行迁移，本次改动只涉及文档。证据是本工作区未跟踪的报告 `prompt-audit/memory-migration-dryrun-20261118.md`（569 行、152,690 B，文件 SHA-256 `61b4e521db3c959630048cbd1901369a3e678721041fb4dab87104845967bdc2`）；报告自身的确认哈希是 `8c14917baae312c048d0cc298b892e172f50ddaf162dd5304a62cc4704c58f97`。

## 1. 范围与证据

本次运行覆盖 `superagent`、`deepseek-harness-uitstalie-dev`、`rimworld`、`qq-bridge-uitstalie`、`mo`、`display` 与 `Stardew Valley`。命令是 `node_modules/.bin/tsx packages/uitstalie/memory/scripts/migrate-global-memory.ts`，每个已注册工作区一个 `--workspace`；dry-run 是默认模式，报告落在 `prompt-audit/memory-migration-dryrun-20261118.md`。

| 度量 | 报告值 |
|---|---|
| 工作区 | 7 |
| 存在的记忆文件 | 11 |
| 扫描路径 | 14 |
| 条目 | 416 |
| 条目文本 | 85,097 B |
| global 候选 | 27（4,713 B） |
| 丢弃 | 389 |
| 类别 | global 27、dispatch 62、business 174、persona 6、无法判定 147 |

报告在本工作区未跟踪，不属于本次改动。它的 `Report hash` 是 apply 确认令牌，不是报告文件的 SHA-256：`--apply <hash>` 会重新扫描并比对令牌，而对文件执行 `sha256sum` 得到 `61b4e521…`，因为报告文本带有生成时间戳与格式。本备忘引用的是 2026-11-18 这份副本的候选编号与报告行号。

## 2. 结论

这次运行回答了量级问题，没有回答分类问题。416 条里有 389 条（93.5%）不是全局事实，27 条（6.5%，4,713 B）被建议迁移；这支持设计中「绝大多数旧条目本来就不是全局事实」的判断。分类精度不支持直接 apply：27 条候选里有 23 条是会话状态、已删除机制或工作区业务，只有 4 条可以论证为 global。业务与无法判定的体量暴露的是检索缺口，不是缺少物理归档。

| 发现 | 性质 | 证据 | 后果 |
|---|---|---|---|
| 27 条候选里有 23 条不是全局事实 | 真问题 | 3.1–3.3 节；候选 #1、#3、#5–#12、#14–#15、#17–#27 | apply 会把一次性状态、死约定与工作区业务写进 `GLOBAL.md` |
| 8 条候选描述第 3–4 步已删除的机制 | 真问题 | #5–#12；报告里有 10 条记录点名已删除能力 | apply 会把死约定固化成永久约定 |
| 321 条业务与无法判定条目没有活的检索路径 | 设计缺口 | business 174 + 无法判定 147；工作区 `MEMORY.archive.md`；`memory_search` 只读全局存储 | 归档字节还在，但没有界面读它们，设计也没有指定所有者 |
| `Summary` 写 11 个文件，`Files` 列 14 条路径 | 报告表述 | 缺 3 个归档：`display`、`qq-bridge-uitstalie`、`mo` | 读者会看到计数不一致 |
| 条目字节与文件字节是不同度量 | 报告表述 | 条目文本 85,097 B；磁盘上 188,169 B | `entries` 旁的 `85097 B` 不是文件总量 |
| `Report hash` 不是文件 SHA-256 | 报告表述 | `8c14917b…` 对 `61b4e521…` | `sha256sum` 无法复现确认令牌 |
| `discard` 行不写去向 | 报告表述 | 389 条丢弃条目 | 读者看不出 apply 会把活动文件的丢弃条目追加到工作区归档 |

## 3. 候选分类

报告提出 27 条 global 候选。按设计自己的定义——跨工作区的事实或约定——有 23 条不符合。即使把 6 条工作区业务记录重新归类，27 条里仍有 17 条是会话状态或已删除机制。

| 类别 | 候选 | 数量 |
|---|---|---|
| 会话或任务状态 | #1、#3、#14、#17、#18、#21、#22、#23、#26 | 9 |
| 已删除或已被取代的记忆机制 | #5、#6、#7、#8、#9、#10、#11、#12 | 8 |
| 工作区业务或偏好 | #15、#19、#20、#24、#25、#27 | 6 |
| 可以论证为 global | #2、#4、#13、#16 | 4 |

### 3.1 会话与任务状态

这些条目记录的是某一时刻任务停在哪：#1 说游戏启动验证没做；#14 说 dev worktree 只有四个预期内的未跟踪项；#17 要求下次启动确认 SMAPI 日志；#18 记录 mod 列表基线 139 → 138；#21 说 `pnpm install` 还没跑；#22 说 JIRA 删除需要人决定；#23 记录一次性的 `node_modules` 诊断；#26 是 RimSort 的确认步骤。下一步或 worktree 快照不是跨工作区约定，迁移它会把瞬时状态变成永久状态。

### 3.2 已删除与已被取代的机制

八条候选描述的是第 3–4 步已删除的记忆行为：#5 提议溢出驱逐，并假定没有 `memory_forget`；#6 规定摘要失败通知；#7 与 #11 陈述 TTL 默认值与 `memory_resolve`；#8 与 #12 描述 `summarizeEveryTurns`；#9 描述摘要批处理；#10 记录 TTL → 取代 → 同轮去重 → 容量驱逐的顺序。每轮摘要作业、活的 TTL 清理、`memory_resolve` 与快照注入都已从模型与人类界面移除，`memory-scoping.md` 第 9 节与 12.1 节记录了这一点。旧设置行与解析器仍为旧文件保留，所以这些文本不只是旧：它们描述的是当前没有任何界面执行的行为。

全文检索能找到 11 条记录提到 `TTL defaults`、`memory_resolve`、`summarizeEveryTurns`、摘要批处理或 `snapshot`：候选 #7、#8、#9、#11、#12，以及报告第 264、296、312、326、364、442 行的丢弃条目。其中 10 条点名了已删除能力；第 296 行是一条关于过期设计快照的 persona 条目，不是记忆快照。迁移这 10 条会把死约定变成常驻的全局约定。

### 3.3 工作区业务与偏好

六条候选属于某一个工作区：#15 记录 dev checkout 里的 `setup-dsh.mjs` 行为；#19 记录一条 Stardew 研究许可；#20 记录一项审批策略设置；#24 记录一个未提交的 ReGrowth2 文件；#25 记录 RimSort 用户规则 schema；#27 记录喷口烟雾 tint 结论。设计说业务历史留在其工作区、全局记忆只放跨工作区事实；这些都是工作区事实或许可，而 #20 是会话设置，不应该变成全局默认。

### 3.4 可以论证为 global 的记录

四条候选可以论证为 global，但这组仍不干净。#2 记录一条 KWin 启动约束，却提议 `global-account`，而内容是机器事实；#4 记录 `write_like_human` 仅 root 可写，却锚定到一个提示词段落编号；#13 记录一次性迁移的 dry-run 默认行为；#16 记录任务状态机。#16 是最清楚的持久约定；#4 属于某个所有者记录的 harness 行为；#13 是一次性工具的操作步骤；#2 的主题错了。四条里最多两条不需要二次复核就能迁移。

## 4. 报告表述

报告可用，但有五个表述选择会诱导误读。

- 文件：`Summary` 数的是 11 个存在的文件，`Files` 打印的是 14 条扫描路径。缺的三个归档是 `display`、`qq-bridge-uitstalie` 与 `mo`，所以差异由报告自身解释，不是扫描错误。缺失的是七个归档里的三个，不是多数。
- 字节：`Summary` 的 `entries: 416 (85097 B)` 是条目文本之和；`Files` 行报的是磁盘文件大小，合计 188,169 B。两个数字都对，但报告没有标注度量口径。
- 哈希：`Report hash:` 是扫描载荷上的 apply 令牌。文件的 SHA-256 是 `61b4e521…`。设计把它叫作「报告的 SHA-256 哈希」（8.2 节），读起来像文件校验和。
- 丢弃去向：每条丢弃行只写 `discard` 就结束。它没有说 apply 会向工作区 `MEMORY.archive.md` 追加记录，所以读者无法只凭报告确认保留。
- 截断：丢弃条目的文本截在 200 字符，389 条里有 121 条以省略号结尾。报告列出了每一条，但不是全文归档；长文本只留在源文件里，apply 之后才进工作区归档。

## 5. 设计缺口

### 5.1 业务历史没有活的检索路径

设计说业务历史留在其工作区，工作区归档是旧数据（`memory-scoping.md` 12.1 节）。apply 在物理上保留了它：`applyMemoryMigration` 在重写活动文件之前，把来自活动文件的每一条丢弃条目追加到该工作区的 `MEMORY.archive.md`，说明文字是 `discarded by migration (business: …)`；归档记录的 `reason` 是 `migration`；已经在归档里的条目原地保留。测试 `apply migrates only confirmed global entries, backs up every changed file, and keeps old files parseable` 断言归档里有被丢弃的文本和 `"reason":"migration"`。

因此「迁移没有为工作区侧建立归档路径」这条更早的判断有误。缺口在检索与持久性：第 4 步之后，`memory_search` 只读 `GLOBAL.md` 与 `GLOBAL.archive.md`；没有工具读工作区归档；设计除了「留在其工作区」之外没有给业务历史指定所有者。源文件仍持有每一条，apply 会把活动文件的丢弃条目复制进归档，所以 dry-run 报告不是文本的唯一副本。它是唯一一份跨工作区、带分类的清单，而默认 dry-run 不写文件——本次报告之所以存在，是因为它被写到了一个未跟踪路径；apply 会把 `report.md` 存到 `$DSH_HOME/memory/migration/runs/<run-id>/`。设计没有说这两份副本里哪一份是保留记录，也没有说以后应由哪个界面回答业务历史问题。

### 5.2 global 类没有可操作的判据

设计用例子定义 `global`——共享服务器地址、harness 默认模型、统一规矩、跨工作区偏好——并把任务与会话状态留给 `dispatch` 类、把工作区事实留给 `business` 类。分类器的原因字符串是一行类别，例如「a shared convention」与「a shared tooling fact」。它们不区分持久约定与下一步、worktree 快照或一次性诊断，所以 #1、#14、#17、#18 能通过 `global` 判定。这是设计缺口：类表只有文字描述，没有测试或 fixture（测试前置数据）规定哪些一次性记录必须被拒绝。

## 6. 本轮不做什么

本轮只改文档。它不改 `packages/uitstalie/memory/src/migration.ts` 或分类器，不在真实数据上 apply，不做回滚演练，也不为业务历史选定去向。27 条候选保持未确认；`memory-scoping.md` 14.4 节的 apply 项保持未勾选。

## 7. 复现

- 对每个已注册工作区各传一个 `--workspace` 跑 dry-run，并把报告写到文件；确认 `$DSH_HOME/memory` 未变。
- 用 `sha256sum prompt-audit/memory-migration-dryrun-20261118.md` 检查文件哈希；只把它与报告的 `Report hash` 对比，以确认两者是不同度量。
- 阅读 #1、#14、#17、#18、#7–#12 的候选与丢弃段，以及 3.2 节引用的行。
- 运行证明归档追加的迁移测试：`pnpm exec vitest run packages/uitstalie/memory/tests/migration.spec.ts`。
