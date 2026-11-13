# Windows 实机评测：super agent（报告闭环 / 生命周期 / 路由 / 提问权限 / 环境 / memory）

[English](windows-superagent-eval-2026-11-09.md) | 中文


日期：2026-11-09。评测对象：Windows 10 实机上**正在运行**的 super agent（`@deepseek-ai/dsh-jira-agent` 的 `superagent_session` / `superagent_ledger` / 报告 journal / dispatch 台账），按 `goal/superagent-implementation-assessment-2026-11-08.md`、`goal/memory-plugin-assessment-2026-11-08.md`、 `goal/jira-ledger-assessment-2026-11-08.md` 的严重度尺度判定；`goal/linux-sandbox-audit.md` 只作平台差异参考。 交接文件：`docs/reviews/windows-superagent-eval-handoff-2026-11-09.md`。

**性质**：只读评测。未改生产代码、未改配置、未 commit、未 push；临时脚本与日志在 `.tmp-eval/`（未跟踪，见 §9）。 本文的三个事实等级严格分开：**代码已提交** / **runtime 已加载** / **Windows 实机复现**。

---

## 0. 结论摘要

1. **Windows 上的“正常报告闭环”这次真的成立了，且是实机证据，不是推断。** 2026-11-09 落盘截点 journal 累计 13 个 task id：**10 个 `delivered`、3 个仍 `pending`（含本评测会话自己）**， 且每个 delivered 恰好一条；super 会话收到 10 条 `[task-report]`，与 10 个 delivered 一一对应， 子会话 turn/end 与投递时间差 1–2 秒（§3.1）。这与 Fedora 报告“完成后没有自动回传”的历史结论**不同**： 当前 runtime 在 2026-11-09 权限修复基线上、含报告 journal 的 happy path 已工作。
2. **但 P0 没有关闭，只是换了几条。** 4 个 P0 的证据等级不同（复审已核）： 跨进程重复领取同一报告（**Windows 合成多进程 store 实验**，26 次领取 / 6 个应领；非真实双 Host 线上复现，原始 stdout 见 §3.1 与 `.tmp-eval/journal-race-stdout.txt`）； 空输出 turn 被自动记成 `returned`（**实机复现**）； 投递失败是不可重试的终态且无启动恢复（**代码+单测**，实机未制造失败）； `abort` 后继续不产生新绑定（**代码+单测**，实机未触发）。
3. **先纠正我自己的一处错误结论：dispatch domain 并没有停用。** 我最初只读主库（mtime 09:31:48、`-wal` 0 B）得出 “75 行、当日 0 行”，是**漏读 WAL**。把 `superagent.sqlite` + `-wal` + `-shm` 复制到临时目录后重查： **90 行、当日 15 行**，包含本评测任务与复审任务；`task-mw8m5yg4` 在 domain 的 `failed@02:12:52` 与人工 resolve 同一时刻。 所以 domain 已被 dispatch/resolve 实际使用（复审 §4.1 的更正成立）；需要核对的是它与 Markdown 投影的**权威关系与来源可观测性**， 而不是“未打开”。原 P1-1 撤销，改为 P2 可观测性项。
4. **沙箱副作用当前状态属实，但归因不能坐实。** `deepseek-harness-uitstalie-dev`、`superAgent`、`system_img` 三个 工作区根仍带 `Everyone:(CI)(DENY)(S,DC)` 与 `Low Mandatory Level:(OI)(CI)(NW)`；`<analyze-workspace>` 是 Medium。 交接文件记录了 11-07 的成功清理，所以“当时清理过”与“现在又出现”可以并存；ACE 无时间戳，写入者与时间未定。 **本次 ACL 根目录探针未复现历史 rename EPERM**；但同日 Web/esbuild 删除临时文件出现 `Access is denied`， 普通构建未通过（§3.5）。补充诊断已定位 esbuild 删除失败为 Low 进程受 Medium 文件的 No-Write-Up 限制（§3.8）， 这不改变工作区持久标签写入者与时间未定的结论。
5. **总体评级：C+（“可用但完整性与可恢复性未成立”）。** 按既有尺度，P0 未关闭，不建议判定为已收敛； 但也不能沿用“Windows 上报告根本回不来”的旧结论——那条已经不成立。

**最关键 3 条**：跨进程 claim 无原子性（§4 P0-1）；空输出/无报告被自动写成 `returned`（P0-2）； 投递失败无重试、无启动扫描（P0-3）。第 4 条 P0 是 abort 绑定（P0-4）。

---

## 1. 版本、环境与三种事实

### 1.1 运行中的 runtime

| 项 | 实测值 | 证据 |
|---|---|---|
| runtime checkout | `<runtime-checkout>` | 进程命令行 |
| runtime HEAD | `2026-11-09 权限修复基线`（`cli-desktop`，工作树 **0** 个改动） | `git -C … rev-parse HEAD`、`git status --porcelain` 空 |
| 启动方式 | `node --import tsx/esm apps/cli/src/bin.ts web`，PID 5084，启动于 **2026-11-09 09:45:03** | `Get-CimInstance Win32_Process -Filter "ProcessId=5084"` |
| 解释器 / 版本 | Node **v24.13.0**；根 package `@deepseek-ai/dsh-root@0.2.2-rc.1` | `node --version`、`package.json` |
| 监听 | `127.0.0.1:3080`（HTTP 401，需启动 token） | `netstat -ano`、`Invoke-WebRequest` |
| profile / home | `DSH_PROFILE=web`，`DSH_HOME=<DSH_HOME>`，super home `<super-workspace>` | 进程 env、`~/.dsh/profiles/web/cordis.patch.yml` |

关键事实：runtime 用 **tsx 直接跑 TypeScript 源码**，不经过打包产物。因此“runtime 加载的代码”就是 **干净的 runtime 工作树**，不是 `apps/web/dist` 的构建产物。

### 1.2 dev checkout 与 runtime 的一致性

- dev：`<dev-checkout>`，分支 `cli-desktop`，与 runtime 使用同一基线。
- 但 dev 工作树有 **79 个 status 条目（73 个已跟踪文件修改）**，包括 `agent.ts`、`session/src/*`、 `jira-agent/src/api-catalog.ts` 等。runtime 工作树是干净的，所以： **runtime 没有加载 dev 的未提交改动**。任何“dev 已修但 runtime 未必加载”的判断，在这台机器上是反向的： dev 上那些未提交修复**确实没有**被运行实例加载。
- 本次评测测量的代码基线是 runtime checkout，不是 `deepseek-harness-uitstalie-dev` 工作树。

### 1.3 机器与权限

- Windows 10 Pro 22H2，build **19045.6466**，x64。
- 用户 `TS-20240229UGAL\TS`，**非管理员**（`IsInRole(Administrator)=False`），进程完整性 **Medium**。
- 评测会话 cwd：`<dev-checkout>`；super 会话 `session-ecc925ac…` 的 cwd：`<super-workspace>`。
- 评测中途会话文件策略由 `workspace-write` 改为 `danger-full-access`（用户操作），不影响下述只读结论； memory 工具与 ACL 探测在两种策略下都做过。

### 1.4 三种事实分级（本文引用规则）

| 等级 | 含义 | 本文用法 |
|---|---|---|
| 已提交代码 | 源码/测试存在于测量基线 | 只用于解释机制和给出行号，不单独作为结论 |
| runtime 已加载 | 当前 3080 进程执行到该代码 | 由 live journal/台账/工具输出反证 |
| Windows 实机复现 | 本轮在这台机器上真实发生并可复核 | 结论的唯一硬证据 |

---

## 2. 现场数据（2026-11-09，runtime 自身产生）

- 报告 journal：`<super-workspace>\.superagent\reports.jsonl`，评测期间持续增长（10:12:12 仍在写）。
- dispatch 台账：`<super-workspace>\.superagent\ledger\*.md`（`ledger-544e144b…md`，537 KB）。
- dispatch domain：`<DSH_HOME>\storages\superagent.sqlite`（**90 行、当日 15 行**；必须连 `-wal` 一起读，见 §3.2）。
- super 会话日志：`<DSH_HOME>\sessions\--D-dqc-superAgent--\session-ecc925ac-d736-45f2-b1f6-8e84a8abe0ec\session.v4.jsonl.zstd`。
- 子会话日志：`…\--D-dqc-deepseek-harness-uitstalie-dev--\session-6e0cddc9-d2d7-487f-b93c-b97dbdc31c56\…`。
- 本评测任务自身也是被派遣的：`task-mw8mct4b-de1cbbd1`，子会话就是 `session-5599a833…`（本会话）， journal 在 prompt 之前已写入 `pending@2026-11-09T02:05:23Z`。

> 日志解码方法：session 日志是 **1911 个拼接的 zstd frame**，无长度前缀。Node 的 `zstdDecompressSync` 与 `createZstdDecompress` 都**只返回第一帧**（2.7 MB → 217 B），必须按 `28 b5 2f fd` 逐帧切片解压 （`.tmp-eval/decode-session.mjs`）。这是 Windows 复跑的硬坑：没有 `zstd` CLI，一次性 API 会静默截断。

---

## 3. 实测矩阵

### 3.1 A. 报告闭环

#### A-1 正常完成：成立（实机）

journal 逐条（评测中段截点 02:12Z：`lines=20 records=20 distinct ids=8`；下文 §3.1 A-4 说明 8 与 13 的关系）：

```
lines=20 records=20 distinct ids=8
task-mw8lnutt… pending@01:45:59Z -> delivering@01:50:43Z -> delivered@01:50:43Z  attempts=0,1,1
task-mw8lvw5q… pending@01:52:14Z -> delivering@01:58:22Z -> delivered@01:58:22Z
task-mw8lxomm… pending@01:53:37Z -> delivering@02:01:49Z -> delivered@02:01:49Z
task-mw8m5yg4…  pending@02:00:03Z -> delivering@02:12:12Z -> delivered@02:12:12Z
task-mw8m9vx1… pending@02:03:07Z -> delivering@02:08:13Z -> delivered@02:08:13Z
```

子会话 turn 边界（`session-log.mjs … turns`）：

```
2906 2026-11-09 01:50:42Z turn/end {"turn":7,"reason":{"kind":"completed"}}
2993 2026-11-09 01:58:20Z turn/end {"turn":8,"reason":{"kind":"completed"}}
3141 2026-11-09 02:01:47Z turn/end {"turn":9,"reason":{"kind":"completed"}}
3163 2026-11-09 02:12:10Z turn/end {"turn":10,"reason":{"kind":"completed"}}
```

super 会话收到的对应 `[task-report]`（`kind:"user"`，`rpcId:"superagent-report-…"`）：

```
607 01:57:35Z [task-report] session-a20c592e… task-mw8lret8-5650a2b5 (context 16%).
635 01:58:22Z [task-report] session-6e0cddc9… task-mw8lvw5q-3c97f302 (context 56%).
690 02:01:49Z [task-report] session-6e0cddc9… task-mw8lxomm-d5af2d74 (context 62%).
856 02:12:12Z [task-report] session-6e0cddc9… task-mw8m5yg4-c19b2a0a (context 63%), but produced no assistant text.
```

投递延迟 1–2 s；每个 task 一条；全天 10 条 delivered，无重复。**这是“runtime 已加载 + 实机复现”。**

#### A-2 无报告（空输出）：被看见，但台账写成成功（实机，P0）

`turn 10` 完成但没有任何 assistant 文本。系统做了两件事：

1. 报告正文是诊断句，**这是对的**： `[task-report] … finished its turn (task task-mw8m5yg4-c19b2a0a) … but produced no assistant text. Inspect the Session … do not assume the task succeeded.`（super 日志 seq 856）
2. 但台账投影在投递前就写了 `returned`（`superagent.ts:3927` → `projectReportToLedger`）， 文件证据 `ledger-544e144b-651b-4202-a71b-ad04d7660f63.md`：

```
6050: ## task-mw8m5yg4-c19b2a0a · returned
6096: - dispatched: 2026-11-09T02:00:03Z
6097: - updated:   2026-11-09T02:12:12Z
6100: - outcome: the turn ended completed without assistant text
6102: ## task-mw8m5yg4-c19b2a0a · failed
```

`superagent_ledger list` 在 02:12:14 也确实返回 `returned`（super 日志 seq 863），到 02:12:52 才被人工 `resolve status=failed` 改成 failed（seq 911-912）。**“没有产出”被自动记成 `returned`，需要人纠正。** 这就是 Fedora P0“业务结果在投递前写成 returned”的一个更尖锐的实例：连空输出也 returned。

#### A-3 投递失败：机制存在，但仍是终态（代码+单测，实机未制造）

`handleTaskTurnEnd` 的失败分支只 warn + settle failed，不重试：

```
3949: if (delivered) { await settleReport(… 'delivered' …) }
3952:   host.ctx.logger.warn('… the report was NOT delivered; marking the dispatch failed')
3957:   await settleReport(host, journal, report.id, 'failed', at, 'the report could not be delivered …')
```

`claim` 明确不领取 failed：`dispatch-reports.ts:243 if (status === 'delivered' || status === 'failed') return undefined`。 单元测试 `marks the report failed and warns when delivery fails` 通过；但**没有 retry 工具、没有 UI 重试入口**， journal 也只有 `forSession/claim/all` 读接口。启动时也不扫描 pending/delivering：本轮读遍 capability 初始化（`superagent.ts:4483-4527`）与 `handleTaskTurnEnd`，唯一恢复是“下一次 turn-end 触发 claim，lease 过期后 retry”（`dispatch-reports.ts:244-249`）； `superSessionForReport`（`superagent.ts:3670-3700`）只回退接收者，不是启动恢复。

**限制**：本轮没有关闭接收方或注入写失败，无法在 live 上展示“failed 后用户看到什么”。因此“失败可见/可重试”按 **代码+单测成立、实机未验证**计。

#### A-4 重复报告：journal 不重复，台账重复（实机）

- journal（截点 02:12Z）：`lines=20`、`ids=8`、6 个 delivered；到报告落盘时增长为 **13 个 id：10 delivered / 3 pending**。 始终没有出现同一 id 的两条 delivered；评测中段每 id 恰好一条。
- 台账：同一 task 会有多段。`task-mw8lnutt-aa5ccf25` 有**两段 returned**（`:5347`、`:5462`）， 一段来自自动投影、一段来自人工 resolve；`m5yg4` 有 returned + failed 两段。 报告本身只投递一次（super 日志只有一条 `task-mw8m5yg4` 报告），**所谓“重复报告”在当前 Windows 运行里 表现为台账重复段，不是重复投递**。这与 Fedora 报告“不同 task id 重复到达”的历史现象不同。

#### A-5 ledger / journal / domain / UI 是否同一状态

| 面 | 今天的 `task-mw8m5yg4` | 结论 |
|---|---|---|
| journal | `delivered`（02:12:12） | 投递事实 |
| 台账 Markdown | 先 `returned`（6050），后人工 `failed`（6102） | 业务事实被人纠正 |
| dispatch domain | 02:12:52 起为 `failed`；此前自动投影期为 `returned`（最终态 failed，见 §3.2） | 自动状态先错 40 秒，人工纠正后正确 |
| UI 面板 | 未打开（3080 要 token） | 未验证 |

四个面**没有显示同一状态**。domain 的缺失不是这条任务特有，而是全局的（§3.2）。

### 3.2 dispatch domain：已打开并被使用；权威关系与来源需核对（原结论撤销）

> **修订（2026-11-09，k3.1 复审后）**：本节初版断言“domain 未打开、全程 Markdown、今日 0 条”，**错误**。 错因：只用 `node:sqlite` 只读打开主库、未应用 WAL，读到的是 09:31 的旧快照。以下为重查结果与更正。

- **重查方法**：把 `<DSH_HOME>\storages\superagent.sqlite` **连同 `-wal`（267,832 B）与 `-shm`** 复制到 `.tmp-eval/dbcopy/`，以读写方式打开副本（SQLite 自动恢复 WAL），再查 `u_superagent_dispatch_dispatches`。
- **结果**：`rows 90`，状态 `{"returned":63,"pending":23,"failed":4}`，当日（2026-11-09）**15 行**； `task-mw8lnutt` 在 01:45:59 创建、01:50:57 returned；`task-mw8m5yg4` 在 **02:12:52 failed**（与人工 resolve 同刻）； 本评测任务 `task-mw8mct4b` 与复审任务 `task-mw8n3mda` 也都在 domain 里。
- **结论**：当前 runtime 的 `DispatchStore` 已打开，dispatch/resolve 确实写入 SQLite。原报告“domain 未打开／ `store.list` 返回 undefined／Markdown 独有任务”的推理链不成立：`superagent_ledger list` 返回的任务在 domain 中同样存在， 不能据此反推数据源（复审 §4.1）。P1-1 撤销。
- **仍需保留的弱结论（P2）**：`superagent_ledger` 不暴露“这条来自 domain 还是 Markdown、是否降级及原因”， 人只能从结果猜；`DispatchStore` 构造时单次采样 `storageDomain`（`dispatch-store.ts:169-171`）仍是“晚到服务即永久降级”的 静态生命周期风险，但**不是本次实机根因**（本次已正常打开）。
- **权威关系**：domain 与 Markdown 投影同时存在（`dispatch-store.ts:214-227` 投影同步）。本轮**未**对同一 id 做 domain/投影逐字段比对；`artifacts/decisions` 在 domain 已 returned 后被 `dispatch-store.ts:282-289` 短路、 投影不可重放的问题仍由复审提出（未实跑），列 P2/未验证。

### 3.3 B. 生命周期

- **`start` 多步失败残留空 Session**（代码确认，实机未制造）： `2817` start → `2838 controller.create` → `2845` 选模型 → `2853` rename → `2864` 写报告绑定 → `2872` prompt。 模型失败（2847）、标题失败（2855）、绑定失败（2867）都直接 `return failure`，**不删除、不标记、不提供继续入口**。 唯一“先解析”的是 workspace/task/reportTo（2818-2835）。没有测试覆盖逐步失败残留。
- **`abort` 后继续没有新绑定**（代码确认，实机未触发）： `3113-3169`：cancel → waitForIdle → `prompt({ requestId: 'superagent-recover-…' })`。 **没有 `recordDispatchReport`**，所以 abort 后那段 instruction 完成时不会按新任务回传。 单测 `aborts a running Session, reports the scene and continues it` 只断言了 `resumed`，没有断言新报告。 与 Fedora P0 3.3 一致，未修复。
- **`archive` 后的 pending/delivering**：单测 `fails pending reports when their Session is archived or stopped` 通过； `failPendingForSessions` 只处理 **pending**（`dispatch-reports.ts:271-279`），**不处理 delivering**； capability 的 archive/stop 路径（`superagent.ts:4570-4607`）也不等待在途 deliver/settle，归档后仍可能迟到发送。
- **唯一 super Session 的 recipient**：journal 的 `superSession` 在派发时写入（`superagent.ts:890`）， 空时才回退 `superSessionForReport`（`:3670-3703`），选“最近更新的 super root Session”，**可能不是原派遣者**； 找不到就 settle failed + warn（`3911-3919`）。本轮 10 条报告全部带 `superSession`，**没有用到回退**；回退行为未实跑。
- **`abort` 的 `accepted:false` 未检查**：`3157-3168` 在 `admitted.accepted` 为 false 时仍返回 `resumed:true`； 正常 `append/prompt` 同样可能留下 pending binding。应纳入 P0-4 验收。
- **settle 失败残留 delivering**：`3716-3733` 把 journal 的 settle 写失败只记 warning；实际已送达但 delivered 未落盘时， 之后可能在 lease 后重发，启动仍不扫描。属 P0-3 的静态扩展。
- **模块级 journal owner 不参与 dispose 静默**：`reportJournals` 是模块级 Map（`836-851`），dispose（`4985-5004`） 不清 Map、也不等待已开始的 report 处理，存在 dispose 后迟发/迟写的窗口（复审 §5.1，未实跑）。

### 3.4 C. Session 路由

- **缺显式 session 会拒绝**（代码+实机行为）：`append` 在未给 session 时返回 `append needs \`session\`: which of …`（`2703-2724`）；本轮 super 的每次 append 都显式带了 `session-6e0cddc9…` / `session-a20c592e…`（super 日志 seq 569、590、673、732、839）。
- **未注册 workspace 会拒绝**：`"…" is not a registered workspace`（`2665-2666`）。
- **`list` 的信息足够用**（实机）：返回 title/model/effort/context%/cache%/lastTask/running/idle （super 日志 seq 667：`session-6e0cddc9… memory 与 jira 插件实现审查 running 2m context 61% deepseek-official/deepseek-flash cache 100% (consider compact)`）。
- **untitled/重名**：今天新建的会话都有标题（`Windows super agent 评测`、`反馈记录分析 2026-11-06～2026-11-09`）， 未出现 untitled；历史 untitled 行为未在本轮复现。
- **递归台账文件名（历史遗留，实机可见）**： `ledger/` 下存在 `D__dqc_superAgent_.superagent_ledger_544e144b….md`、 `…_D__dqc_superAgent_.superagent_ledger_544e144b….md`（两层、三层嵌套），时间 2026-11-05； domain 里对应记录的 `workspace.id` 被写成这个 slug、`path` 带反引号（`` `<dev-checkout>…` ``）。 当前 `append` 已拒绝未注册 workspace，但 `DispatchStore.migrate()` 仍会把这些历史行读进 domain （`dispatch-store.ts:205-211`），`ledgerFileOf` 继续按 id 生成文件名（`dispatch-ledger.ts:116-117`）。

### 3.5 E. Windows 环境

- **ACL/完整性标签仍在**（实机，与交接文件 §2.3 冲突）：

| 工作区 | `Everyone:(CI)(DENY)(S,DC)` | 完整性标签 |
|---|---|---|
| `<dev-checkout>` | 有 | **Low** `(OI)(CI)(NW)` |
| `<super-workspace>` | 有 | **Low** |
| `<system-img-workspace>` | 有 | **Low** |
| `<analyze-workspace>`（今天未打开） | 无 | **Medium** |

- **当前残留属实，归因未定**：ACE 无时间戳，无法区分“11-07 未清净”“后续旧进程重写”还是“本次打开工作区时重新施加”。 交接文件所依据的台账确实记录了 11-07 的现场清理（`ledger-544e144b….md:4023-4069`：清 15 个路径 DENY、9 个目录 Low→Medium， 7 个工作区验证；`:4075-4083`：代码不再写 Low/DENY、旧后端默认禁用 fail-closed）。**“当时清理成功”与“现在又出现” 可以同时成立**，不能据此说 handoff 造假。`analyze` 为 Medium 也不足以单独证明“未打开”是唯一原因。
- **本次 ACL 根目录探针未复现历史 rename EPERM**（限定口径）：Medium 进程（非管理员）对工作区根做 `write/rename/unlink/mkdir/rename dir/rm -r` 全部 OK（`.tmp-eval/acl-probe.mjs`），且只覆盖这一组 token/路径/操作。 这只能说明**该探针未报错**，不能推出“当前没有 EPERM”或“DENY 对所有删除路径都不生效”；目录/文件、父目录 DELETE_CHILD、目标 DELETE、继承标志与 restricted token 需分别验证。
- **同日构建权限故障已由补充诊断定位**：台账 `:6294-6312` 记录 02:22 的 `pnpm run build` **9/10 gates**， 失败在 Web build：`[vite:esbuild-transpile] remove <temp>\esbuild-...: Access is denied.`， 三次重试、改 TEMP、脱离 Vite 的 `esbuild.transform` 最小复现均失败。补充诊断读取真实残留文件的 ACL 与当前 token， 确认 Low 完整性进程受 Medium 文件的 No-Write-Up 限制；根因与平台建议见 §3.8。
- **普通权限构建**：本评测没有重跑全仓 `pnpm run build`（只读约束 + dev 树 79 个未提交改动 + 会动 `node_modules`）。 同机台账显示 `tsc -b tsconfig.host.json` 与 `pnpm run typecheck` 已通过、build 9/10（卡在 Web/esbuild）， 但这仍是**引用证据**；本评测独立跑的只有 `pnpm install --frozen-lockfile`（成功）与 `node:test`（全绿）。 `vitest run` 该两个 `.test.ts` 返回 `No test files found`（exit 1），**不计为通过**。
- **junction / 路径别名、文件锁、并发写 memory**：**未验证**（原因见 §7）。多进程 journal 已单独做合成实验（P0-1）。

### 3.6 D. 提问 / 权限

- **`ask_user_question` 取消/超时**：Windows 本轮**没有发生提问**。子会话 `6e0cddc9` 只有 1 次 `approval/asked` + 1 次 `approval/decided`（工具目录里有 `ask_user_question`，但没有调用）。 跨会话 `memory_read` 被拒绝的实测见 §3.7。**D 的提问路径未验证。**
- **permission preset 按任务生效**：`start` 没有 permission 参数（`SESSION_PARAMETERS` 只有 workspace/task/title/model/effort/session/delivery/compact/curate_memory 等），super 自身由 `superagent_permission_preset` 固定（`index.ts` config）；子会话的 preset 来自 `agentPreset`（`superagent.ts:2840-2842`）。 **“按任务选权限”在工具面上不存在**，本轮也未改配置验证。未验证。
- **effort 是否强制人工往返**：今天 `start` 未传 effort，子会话 header 已是 `reasoningEffort:"high"` （`request/header` seq 13），说明默认值生效、**没有人工往返**。但工具对“声明了 efforts 的模型”仍强制 `reasoning_effort`（`superagent.ts:536`、`1925`）；`kimi-code-plan-cn/k3.1-pro` 正声明 low/high/max （super 日志 seq 755-756），对它派发就会往返。**该分支未实跑**。

### 3.7 F. memory 检索

- **默认 `memory_search` 不可用**（实机，本会话 + super 会话都复现；**P1**，按 `goal/memory-plugin-assessment-2026-11-08.md:138-144` 与交接文件）：
```
Error: session search is disabled: this deployment configures the session-query index with openAt "never"
```

本轮单测结果（Windows，实测 runtime 基线）： `dispatch-reports` + `dispatch-store` **15/15 pass**；`superagent.test.ts` **83/83 pass**（152 s）。 覆盖“绑定先于 prompt”“同 turn 只投一次”“空文本最小报告 + 警告”“失败置 failed”等。 **注意**：`vitest run` 该两个 `.test.ts` 返回 `No test files found`（exit 1）——它们由 `node:test` 跑，不能计入 vitest 通过； `:857-888` 的 “remount 恢复” 只是空 Map 下直接调用 turn-end handler，**不能证明启动恢复**。

---

## 7. 未验证事项与原因

| 项 | 原因 |
|---|---|
| 真投递失败在 live 的可见性/可重试/UI | 未关闭接收方或注入写失败；只做了单测与代码路径 |
| 重启后的启动恢复 | 不能重启 3080（会中断用户会话）；journal 无启动扫描可由代码确认 |
| `ask_user_question` 取消/超时 | Windows 本轮子会话无提问（只有 1 次 approval） |
| permission preset 按任务生效 | 工具面没有 permission 参数；未改配置 |
| UI 面板是否显示投递状态 | 3080 需要启动 token（`?token=` 43 字符），未驱动浏览器 |
| junction / 路径别名 | 未测；需要构造 junction 并比对 `sameCheckout`/memory 的逐字 cwd |
| 文件锁（Session lease） | 未测；需要两个宿主同时写同一 Session |
| 并发写同一 `MEMORY.md` | 未测；需要第二个 memory-capable 宿主/进程，属改配置范围 |
| 全仓 `pnpm run build` | 本评测未独立重跑；只有同机台账的 9/10 与 esbuild `Access is denied`（引用证据，未复跑） |
| domain 与 Markdown 投影的逐字段一致性 | 本次只核对了行数/状态/时间，未对同一 id 做 artifacts/decisions 逐字段比对 |
| `abort` 实机续跑 | 未构造运行中 turn；代码与单测确认无新绑定 |
| 递归文件名是否仍能新生成 | 当前 `append` 拒绝未注册 workspace；`start` 是否也拒绝未单独验证 |

---

## 8. 建议（按“先正确、再收敛”）

1. **P0-1**：给 journal 一个真正的跨进程 claim——同目录锁文件（`mkdir`/独占打开）+ 租约，或把 claim 变成 原子 rename/单写者；至少把“同一 superHome 只允许一个投递者”做成显式拒绝而不是靠部署约束。
2. **P0-2**：把“业务结果”和“投递状态”分开落账：无 assistant 文本 / 投递失败时自动投影必须是 `failed`（或 `unknown`），不要先写 `returned`；`projectReportToLedger` 放在 `deliver` 成功之后，或在 outcome 里显式标注 “无产出”。
3. **P0-3**：失败不是终态。给 `superagent_ledger` 加 `retry`，启动时扫描 pending/delivering（含 lease 过期）， 并在 UI 显示 failed + 原因。
4. **P0-4**：`abort` 续跑的 prompt 也走 `recordDispatchReport`（新 taskId + requestId），否则续跑永远不会回报。
5. **P1-1**：解耦 `memory_search` 与 session FTS——`openAt:"never"` 时仍返回 MEMORY.md 命中并显式标 `partial`； 不要把“检索不可用”留给调用者 grep 兜底。
6. **P1-2/P1-3**：继续做受控的 ACL 前后快照与持久标签写入者定位，区分历史残留、旧进程重写和当前入口施加；Windows 默认按 §3.8 改为完全权限软沙盒，保留黑名单、工具策略和审计日志，硬 ACL/Low 完整性只作可选强隔离。该建议待实施，本文不代表配置已切换。
7. **P1-4**：`start` 先解析 model/title/permission/binding 能力，再 create；无法避免的失败写 `created/configured/admitted/failed` 并可继续/清理。
8. **P1-5**：投影必须可重放；已 returned 后补 artifacts/decisions 不能被短路；历史非法 workspace id 与嵌套 ledger 只归档、不删证据。
9. **P2-1**：`superagent_ledger` 返回里标明数据源（domain/Markdown）与降级原因；`storageDomain` 晚到时可重试或显式拒绝。

---

## 9. 临时文件

`.tmp-eval/` 为未跟踪临时目录，现保留**脚本、测试日志与竞态 stdout 转录**（约 30 KB）： `journal-summary.mjs`、`domain-dump.mjs`、`decode-session.mjs`、`session-log.mjs`、`journal-race.mjs`、 `claim-child.mjs`、`acl-probe.mjs`、`journal-race-stdout.txt`，以及 `nodetest-{dispatch,superagent}.log`、`vitest-dispatch.log`。 合成 journal（3000 行）、`dbcopy/` 与 ACL 探测残留已删除；可随时整体删除 `.tmp-eval/`。 未改动生产代码/配置，未 commit/push；未删除任何既有台账、journal、Session 日志。

---

## 附录：证据索引

| 主题 | 位置 |
|---|---|
| 报告 journal 格式与 claim | `packages/jira/jira-agent/src/dispatch-reports.ts:147-305`（claim 239-258、failed 终态 243、lease 244-249） |
| 自动投影先于投递 | `packages/jira/jira-agent/src/superagent.ts:3923-3927` |
| 无文本 outcome | `superagent.ts:949`；live `ledger-544e144b….md:6100` |
| 投递失败终态 | `superagent.ts:3949-3957` |
| `abort` 无绑定 | `superagent.ts:3113-3169` |
| `start` 顺序与失败残留 | `superagent.ts:2817-2896`（create 2838、model 2845、rename 2853、bind 2864、prompt 2872） |
| `append` 显式 session / 未注册 workspace | `superagent.ts:2664-2724` |
| ledger list 的 domain 回退 | `superagent.ts:3375-3376`；`dispatch-store.ts:234-236` |
| domain 单次采样 | `dispatch-store.ts:170-171`；`storage-domain/src/index.ts:223-234` |
| 递归文件名 | `dispatch-ledger.ts:116-117`；`<super-workspace>\.superagent\ledger\D__dqc_…` |
| effort 强制 | `superagent.ts:536,1925` |
| 本机 live 证据 | `<super-workspace>\.superagent\reports.jsonl`；`…\ledger\544e144b….md:5347,5462,6050,6100,6102`；`~\.dsh\storages\superagent.sqlite`；super 会话 `session-ecc925ac…` |
| 评测脚本 | `.tmp-eval/{journal-summary,domain-dump,decode-session,session-log,journal-race,claim-child,acl-probe}.mjs`；竞态 stdout 转录 `.tmp-eval/journal-race-stdout.txt` |

---

## k3.1 复审修订记录

复审报告：[windows-superagent-eval-k3.1-review-2026-11-09.md](windows-superagent-eval-k3.1-review-2026-11-09.zh.md)。 结论：**部分接受；维持 C+ 与 4 条 P0，0 降级**。本报告按复审修正如下（只改证据与口径，不改结论）。

| # | 复审意见 | 本报告修改 |
|---|---|---|
| 1 | **dispatch domain 结论错误**：SQLite（含 WAL）在截点前已有当日写入；主库 mtime 未变是 WAL 所致；“list 返回 Markdown 任务”不能反推 `store.list` undefined | **撤销原 P1-1** 与“domain 未打开/全走 Markdown/今日 0 条/75 行”全部表述；§3.2 重写为重查（**90 行、当日 15 行**，含本评测与复审任务），说明错因是只读主库漏 WAL、给出 WAL 安全查询方法；domain 权威关系改为待核（P2-1），单次采样只作静态风险 |
| 2 | **EPERM 口径过宽**：ACL 根目录探针未复现 ≠ 当前没有 EPERM；同日 Web/esbuild 删除临时文件 `Access is denied`、普通构建 9/10 | §3.5 改为“**本次 ACL 根目录探针未复现历史 rename EPERM**（限定 token/路径/操作）”，并列同日 esbuild 权限故障（台账 `:6294-6312`，引用证据、未独立复跑），明确两类错误不能互相证明/否定；P1-2 标题改为“当前残留/重新出现，写入者与时间未定”，P1-3 单列构建权限调查 |
| 3 | **26/6 缺原始日志与实验边界**：应写“合成多进程 store 实验”，不能写成线上双 Host 已重复投递 | P0-1 改为 **Windows 合成多进程 store 实验复现（非双 Host 线上）**，补脚本路径与 `.tmp-eval/journal-race-stdout.txt`（标注为会话转录、非程序落盘），写明 barrier/seed/未覆盖 settle、崩溃、接收方去重，注明**复审未独立复跑**；§5 同步改为“确认机制，不外推线上故障率” |
| 4 | **memory_search 应恢复为 P1**（既有尺度 `goal/memory-plugin…:138-144`、交接文件） | P2-1 → **P1-1**；§3.7 标注 P1；§5 表“维持并修正严重度”。`memory_read` 不分 interrupted/failed 保持 P2 |

复审同时指出、本报告一并修正的次级问题：

- **P0-3/P0-4 证据扩展**：补 settle 失败残留 delivering（`superagent.ts:3716-3733`）、archive/stop 不等待在途 （`dispatch-reports.ts:271-279`、`superagent.ts:4570-4607`）、`accepted:false` 未检查（`:3157-3168`）、 recipient 回退（`:3670-3703`）、模块级 `reportJournals` 不随 dispose 清理（`:836-851`、`:4985-5004`）。
- **remount 测试≠启动恢复**：`:857-888` 只是空 Map 下直接调用 handler，已在 P0-3 与 §6 注明。
- **测试口径**：`vitest run` 这两个 `.test.ts` 实际是 `No test files found`（exit 1），不再计入通过；`node:test` 15/15 与 83/83 仍成立。
- **重复台账段**：`:5347`/`:5462` 是追加式投影历史，不是重复投递；真正问题是已 returned 后补写被 `dispatch-store.ts:282-289` 短路、投影不可重放。
- **memory §4.8 文档漂移**：撤销该具体断言（P2-5 改写），不再把它当作已复核的当前漂移。
- **“推翻旧结论”限缩**：只表示当前 Windows runtime 已观察的 happy path 会自动回传；不表示重启/多 Host/注入失败路径可靠。

**未补足的证据与影响**：P0-1 仍无真实双 Host 端到端投递证据、无复审独立复跑；P0-3/P0-4 仍是静态确认、无实机失败注入； domain 与投影未做逐字段一致性比对。这些降低的是**证据覆盖率**，不改变 4 条 P0 的确定性缺陷判定，C+ 与 P0 数量不变。
