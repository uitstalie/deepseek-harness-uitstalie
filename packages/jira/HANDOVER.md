# 交接文档（"遗书"）— dsh-jira

> **如果我不在了、或换一个 agent 接手：从 §0.1 开始读。细节全在 `DESIGN.md`，不必回看任何对话记录。**
> 最后更新：**2026-10-23**（**199 条决策**、**702 测试全绿**、烟测 33/33、两个仓库同步干净）
> §0.1 是**当前的**状态与待办；§1 与 §2 写于 2026-10-15 夜（设计期），保留作历史，**以 §0.1 为准**。

---

## 0. 这是什么

给 DSH 的 agent 用的**跨设备持久任务台账 + 知识库**。

- **使用者：只有 uitstalie 一个人**，不是多人协作 → 不需要权限模型
- **多台机器**：Fedora KDE + Windows 10/11（无 macOS）
- **动机**：DSH 自带的 `todo_write` 是单会话的、`goal` 只能有一个目标，
  所以缺的是"跨会话、跨项目、跨机器的持久台账"
- 数据仓库是 `dsh-plugin-multidevice-jira-cloudstore`（**已创建**，见 §5）

---

## 0.1 接手须知（2026-10-16，2026-10-17 深夜更新 —— 只读这一节也能开工）

**一句话状态**：设计 **199** 条决策已定、**702 个测试全绿**、两个仓库都与 origin 同步。
第 1/2/3/**4** 档全部完成；2026-10-17 全面审计的 **14 个 issue（DPMJ-2~15）全部修复关闭**；
架构审查的 **9 个重构 issue（DPMJ-203~211）全部关闭**（决策 180~188；store.ts 587→329、
plugin/index.ts 1230→464、cli/main.ts 1080→280）；**试用反馈批次（DPMJ-212~218）也全部关闭**
（决策 189~196，由 Fedora 侧的 agent 实现：先校验后分配、工具面 tag-create、复合 close、batch_close、
键空间分离、体验批）。
**当前（2026-10-23 数据体检后）**：401（doctor 报告不忠实）已修（决策 197）✅；
402（知识条目回挂 issue 但不回填 `kb_refs`，6 条单边）已修（决策 198）✅。
**下一步是架构迁移**：`MIGRATION.md`（仓根）是**三层拆分与 dsfeiyu 归并的设计书**——一个 bundle +
五个包（jira-core / service / agent / cli / ui），数据仓不动，服务契约是 `ctx.get('jira')`；
建议先做阶段 0（单包内做 seam）。**给 dev 工作区的 agent 读的那份就是它。**
**注意**：两仓的 GitHub Actions 工作流是**手动禁用**状态（`disabled_manually`），远端门禁不跑；本地用
`node dist/cli/index.js lint|generate --check` 自检。

**2026-10-23（决策 199，架构复查）**：把「副作用边界」从约定变成守卫——`check-boundaries` 新增
`core/` 的 IO 白名单（只有 io/git/lock/hooks 可 import `node:fs`/`node:child_process`），自检 13→20 条；
顺带修真回归：`project.ts` 的裸 `access` 改走 `io.exists`。教训：只写在决策里的不变量会回退。

**2026-10-23（决策 198，DPMJ-402）**：引用成对——`jira_kb` create/update 带 `issues:` 时自动把知识键
回填进被引 issue 的 `kb_refs`（幂等，部分失败显式进 `mirror.failed`）；体检发现的 6 条单边引用用这个
新路径补齐。700 → **702** 测试，变异验证（去掉镜像 → 2 红）。

**2026-10-23（决策 197，DPMJ-401）**：doctor 说真话——已关闭 issue 的历史租约不再报
`lease-expired`（体检实测 37 条**全是关闭项**），`summary.tags` 从硬编码 0 改成快照里的真实计数，
人面摘要行也把标签数说出来。698 → **700** 测试。

**2026-10-19（决策 190，DPMJ-212，S1）**：先校验、后分配——`validateNewIssue`/`validateKnowledgeDraft`
两个 key 无关纯校验拆出，create 被拒不再烧号（实证断号 KB-1/2/6）；回执带 `keyAllocated: false`。
锁序不变。682 → **684** 测试，两处变异验证。

**2026-10-19（决策 189，试用反馈裁定）**：一位 DeepSeek Flash agent 真实试用（8 issue +
3 知识条目 + 31 次写）后，用户裁定四条：① `issue_types` 不加（task 涵盖 feature）；② **关闭必须
先经过 `in_progress`**（`transitions` 摘掉 `todo→closed`，词表驱动零代码；未认领就关的审计缺口
由复合动作 DPMJ-214 补）；③ 时间性等待不加字段（comment 写清等什么）；④ KB 撞车按原则分开
（知识与 issue 两个键空间，落地在 DPMJ-215）。fixtures/config.md 已与账本逐字同步。
反馈还实锤了一件事：KB-14 把知识条目 KB-12 写进 issues → 账本 CI 连红三次——**CI 是对的，数据错了**。
其余反馈登记为 DPMJ-212~218（S1×3：编号烧号/工具面无 tag-create/无复合动作，S2×2，S3×2）。

**2026-10-19（决策 188，DPMJ-211，架构重构收官）**：S3 杂项清扫——broken 条目改结构化
`BrokenFile{path,reason}`（plugin 的字符串考古删除）、`renderKbEntry` 归位 core、args.ts 的父目录
绕回修正、hooks shim 补注释。四条核实后**不修并写明理由**（emitWarning 直用、system/git 读 env
指控不成立、pid 无散布、checkStore 是合理长 dispatch）。679 → **681** 测试。
**至此 2026-10-19 架构审查的 9 个 issue（DPMJ-203~211）全部关闭。**

**2026-10-19（决策 187，DPMJ-210，最大的一刀）**：runCli 原子化——main.ts 1080 → **280 行**；
`cli/commands/` 21 个命令各一个文件（17–100 行）+ 注册表；`cli/runtime.ts` 装 CommandContext 与
组合子（`writeCommand` 吃掉写命令五胞胎、`optFlags` 吃掉 37 处条件 spread）；4 处 CLI 滞留的
core 逻辑下沉（uncommentGitMessage/collectKnownKeys/aheadBehind/claimNoticeOnce），`process.cwd()`
并入 CliRequest。CLI 中文输出逐字节不变。677 → **679** 测试。

**2026-10-19（决策 186，DPMJ-209）**：拆 plugin/index.ts——1230 → **464 行**接线层；
host/envelope/toolIssue/toolList/toolKb/sessionRecord 六个原子文件各归其位；apply 从 372 行一坨
变成命名步骤的组合（registerSlashCommand → … → registerTools），三个工具注册由 `registerTool`
组合子收敛。调用方零改动（re-export），1028 行测试原样全绿。675 → **677** 测试。
⚠️ **改了插件文件布局 → 活着的 DSH 进程必须换进程才生效**（决策 123）。

**2026-10-19（决策 185，DPMJ-208）**：拆 store.ts——587 → **329 行**装配点；提交编排去新
`core/commit.ts`（173 行）、键分配并入 `counters.ts`、`assertProjectKey` 归位 entity.ts。
调用方零改动（re-export 兼容层）；commit/counters 对 store 只用 `import type`（不成环）；
新守卫：re-export 与实现是同一函数对象。674 → **675** 测试。

**2026-10-19（决策 184，DPMJ-207）**：人面文案单一出处——`core/messages.ts` 收敛 9 条两面共有的
命令级中文消息（13 处替换点），漂移取舍写明；`messages.test.ts` 守卫「两面零字面量副本」
（变异：塞一份副本立刻红并点名）；顺带修了 3 处 i18n 断言表的既有过期条目。671 → **674** 测试。

**2026-10-19（决策 183，DPMJ-206）**：插件生命周期收口——模块级会话状态收进 `createSessionRecorder()`
闭包（键含 root，reload 换 root 不再漏记）、`systemPrompt.context` 过 `keep()`、injection 的 Result 不再
转 throw、项目键改用 core 的 `isProjectKey`。复核修正：「index.ts 零汉字有守卫」的说法已不成立
（决策 177 的人面回调合法带中文），HANDOVER 与 §11.8 改说真话。666 → **671** 测试，三处变异验证。

**2026-10-19（决策 182，DPMJ-205）**：路径规则单点化——`entity.ts` 三条 posix 相对规则
（`issueRelPath`/`commentRelPath`/`projectRelPath`）是唯一出处，`io.ts` 是唯一拼 root 出绝对形式的地方；
`projectPath` 同名两义拆成「绝对=projectPath / 相对=projectRelPath」。附带收益：喂 `git add` 的 pathspec
从 Windows 反斜杠变成规范 posix。662 → **666** 测试，两处变异验证。

**2026-10-19（决策 181，DPMJ-204）**：锁语义单点化——`lockOwnerOf`/`lockOptionsOf`/`networkLockPath`
收敛进 lock.ts，五处发散构造（含两处硬编码 `host:'dsh'`）归一；更深的发现是 `store.host` 本是
OS 主机名但只有插件在传（CLI 与 /jira 都落进 'unknown'），新增 `system.hostName(env)` 三处接线。
657 → **662** 测试，两处变异验证。顺带修掉 6 处「决策 240」错引用（应为决策 60）。

**2026-10-19（决策 180，DPMJ-203，架构重构第一刀）**：副作用收敛落地——`io` 补齐 `exists`/`listDir`/
`listDirEntries`/`mkdirp` 四个原子，14 处散落的裸 `readdir/access/writeFile` 全部下沉；core 里 `node:fs`
只剩 io/git/lock/hooks 四个正当边界（决策 102① 从口号变成事实，§11.8 G102 翻 ✅）；顺带堵掉
machine/session 绕过 BOM/CR 校验的旁路。652 → **657** 测试，两处变异验证。
**背景**：2026-10-19 架构审查（模块化隔离 + 原子化组合）登记了 DPMJ-203~211 共 9 个重构 issue，
按依赖顺序推进中（203 ✅ 已完成；204 锁收敛、205 路径收编、206 plugin 漏网、207 文案收敛、
208 拆 store、209 拆 plugin/index、210 runCli 原子化、211 S3 杂项）。

**2026-10-19（决策 179，三条用户裁定）**：① `jira_kb search` 的 `file:line` 改成**文件绝对行**
（frontmatter 计入：`parseFrontmatter` 返回 `bodyLine`，实体带着它，命中行 `bodyLine + 正文行 - 1`；
标题命中的 `line` 仍是 1，因为标题在 frontmatter、字段行号没跟踪——注释里写明）。② 决策 46 的
`comment/v1` 从清单**去掉**：评论是锚制、一个文件多条评论，frontmatter 只能描述文件 → 八种 schema。
③ 不装 `pre-push` 钩子（生成必须留在 DSH 进程内，决策 15），改为**报警**：doctor 的 `generated-stale`
点名 `jira sync`，`jira doctor` 在人面多一行 `! 派生文件已过期：推送前先 jira sync…`。
650 → 652 测试，两处变异验证。

**2026-10-19（决策 178，DPMJ-201）**：测试加固一批——四个"决策已落地但零测试"的行为补上守卫
（`push.dispose`、doctor 的 generated 新鲜度、`migrateGitignore`、`fromWire`），`removeTree` 从三份副本收成
`src/testing/removeTree.ts` 一份（八个文件的裸 `rm` 全换），十处 `it` 内 `mkdtemp` 改为登记后统一清；
三处"声称>实际"改说真话——其中 `kbstore.test.ts` 有一条断言**整段被注释吞掉**，移出后变异立刻能失败。
634 → **650** 测试，六处变异验证。顺带查出 `jira_kb search` 的行号偏差，登记为 DPMJ-202（未修，需拍板）。

**2026-10-17（决策 159，第 4 档最后一片）**：JSON 与工具返回键一律 snake_case —— `core/render.ts` 的 `toWire` 一个转换点，`renderIssueJson` / 三个 tool 的返回边界 / CLI 的 `--json` 都走它；实体内部仍 camelCase；三份 skill 不用改（它们写的是参数名）；一条"逐个键"的守卫 + 两处变异验证。589 测试全绿。**第 4 档到此全部完成。**

**2026-10-17（决策 158，第 4 档第七片）**：`KEY_EXHAUSTED` 可达了——一个 project 的号到 **9999** 为止（`MAX_KEY_NUMBER`），超限由 `claimKey` 拒绝并点名 project / 上限 / 本会给到几号；单元 + 集成用例 + 变异验证。586 测试全绿。

**2026-10-17（决策 157，第 4 档第六片）**：凡引用宿主必须标版本——§2 开头加核对基线（`0.2.1-alpha.2` @ `2946bfe41b`），§8 里点名宿主的 7 条就地标版本；顺手修正决策 95 的过期事实（本机现在只有一个宿主 checkout）。

**2026-10-17（决策 156，第 4 档第五片）**：长路径的「启动时报错」那一半落地——判据收进 `core/config.resolveStoreRoot`（CLI 与插件共用），超平台上限拒绝、≥240 只警告；顺带新建 `core/config.test.ts`（此前零测试）。583 测试全绿。

**2026-10-17（决策 155，第 4 档第四片）**：`/jira` 补 `show <KEY>` 与 `tags lint`（都只读，决策 38/83），并修掉「子命令不接受位置参数」的结构问题；579 测试全绿。

**2026-10-17（决策 154，第 4 档第三片）**：三个潜伏项收口——`frontmatter.ts` 注释里那个被渲染成真 TAB 的 `\t`、评论 `merge=union` 的**反向**断言（issue / `config.md` / `BOARD.md` 必须是 `unspecified`，变异验证过）、`_merge/` 的边界写清（归并时由人自建，工具不做归并）。577 测试仍全绿。

**2026-10-17（决策 150，第 4 档第二片）**：决策 91 落地——`machineDisplayName` 不再是死代码（`machines list` 的第二列改用它，`（无 label）` 不再出现）、缺 label 的提示改成**每台机器一次**（句子是纯函数，标记文件在机器状态目录里，`--json` 不带散文）、机器状态目录的算法收进 `core/machine.ts` 的 `machineStateDir` 由插件与 CLI 共用。555 测试全绿，变异验证过。

**2026-10-17（决策 149，第 4 档第一片）**：结果信封统一——**失败也带 `me`**（模型才能从拒绝里知道自己是谁、为什么不能写）、**部分读取带 `message`**（决策 80 的「不静默」那一半）、`jira_list` 的 `rejected.file` 从 `'issues'` 改成真路径；`me` 进了三个输出 schema 的 required，那条测试改成真的检查取值。553 测试全绿，两处变异验证。

**2026-10-17 深夜刚落地的（决策 148，详见 §2 第 5 条）**：重生成的时机从"会话结束"改到**每次推送之前**
（`pull --rebase` → 重生成+提交 → push），顺带修掉两个真 bug：插件推送队列里**从写下就是死代码**的 `pull`
钩子（注释与代码同一行，`//` 吞掉了整个钩子），以及 **rebase 没有身份回退**（CI 抓出：猜不出 git 身份的
环境上 rebase 会停住并把账本留在中途）。552 测试全绿（+6），三处变异验证都做了。
⚠️ **改的是插件代码 → 活着的 DSH 进程必须换进程才生效**（决策 123，见下方"环境与陷阱"）。

### 2026-10-17 全面审计：**已全部修复** ✅

五面并行只读审计（核心账本/git、插件层、CLI/System、脚本/文档、测试质量）+ 主会话独立抽查账本仓，
共发现 S1×5、S2×14（归并 8 批）、S3 一批，登记为账本 issue DPMJ-2~15。**14 个 issue 全部修复关闭**
（决策 160-177，逐条状态见下方"审计发现的修复进度"表）；收尾的 DPMJ-104/105 于 2026-10-19 完成，
精读新发现汇总为 DPMJ-201（当前唯一待办）。

**审计确认无问题的重要方面**（不要重复查）：CRLF/BOM 强制、git 身份回退（含 rebase）、锁内 revision CAS、
机器 ID 隔离、lease 文本比较、workspace 远程归一化、插件模型面全英文、guard 单调性、注入面无注入风险、
isConcurrencySafe 声明与实现一致、store/generateStore 测试质量、全仓 0 个假测试、UNC 路径处理、
决策表 1–153 无缺号无重号、账本 hooks（commit-msg + prepare-commit-msg）在位。

### 五个命令（照抄即可）

```powershell
cd D:\dqc\dsh-plugin-multidevice-jira
.\node_modules\.bin\tsc.cmd -p tsconfig.test.json   # 类型检查（含测试文件）
node --test "src/**/*.test.ts"                      # 702 个测试
.\node_modules\.bin\tsc.cmd -p tsconfig.json        # 构建 dist/
node scripts/smoke.mjs                              # 三面烟测 33 步
node scripts/check-boundaries.mjs                   # 分层 / 宿主依赖 / console 守卫
```

- `pnpm check` = 两个 `tsc` + 边界守卫；另有 `pnpm test` / `pnpm smoke` / `pnpm check:text` / `pnpm check:build`。
- ⚠️ **烟测跑的是 `dist/` 构建产物** —— 只改源码不构建，烟测会继续跑旧代码（本轮为此白绕过一次）。
- ⚠️ 测试用 Node 的**类型擦除**直接跑 `.ts`，所以类型有错也可能"跑得动"；**两道都要看**。

### 第 4 档：全部完成 ✅（2026-10-17）

| 组 | 决策 | 结果 |
|---|---|---|
| §11.8 潜伏项 | 154 + 158 | 注释里的假 TAB、评论 `merge=union` 的反向断言、`_merge/` 的边界、`KEY_EXHAUSTED` 可达（号段上限 9999） |
| `/jira show` + `tags lint` | 155 | 两个只读子命令；顺带修掉"子命令不接受位置参数" |
| 启动长路径检查 | 156 | 超平台上限拒绝、≥240 警告，判据在 `core/config` |
| 宿主引用补版本号 | 157 | §2 核对基线 + §8 里 7 条就地标版本 |
| JSON / 工具返回 snake_case | 159 | `toWire` 一个转换点，三个出口都走它，逐个键守卫 |

**审计发现也已全部修完**（见下方"审计发现的修复进度"表）——当前唯一待办是账本里的 **DPMJ-201**（测试加固，S2）；另外还有几个**要用户拍板**的开放问题（下一节）。

### 审计发现的修复进度（账本 DPMJ project）

| issue | 级别 | 状态 |
|---|---|---|
| DPMJ-2 锁回收 TOCTOU + 锁无心跳 | S1 | ✅ **已修（决策 160）**：回收先拿 `<lock>.reclaim` 标记、拿到后再读 owner 比对、只删自己判为 stale 的那一份；持锁者每 `staleMs/3` 写心跳，`staleSince` 取「目录 mtime 与心跳的较新者」；顺手修掉「owner 写失败留下新鲜无主锁」（审计的 S3）。两处变异验证 |
| DPMJ-3 只读/子代理会话结束时越权写 | S1 | ✅ **已修（决策 161）**：`closeOutSession` 并入 `mayWrite` 分支；成对用例（只读=什么都不写，可写=确实写评论+watermark），并修掉夹具里一个会让负例假绿的坑（`headAtStart` 在 `agent/created` 送达时捕获，须先送达再让提交落地） |
| DPMJ-4 项目键未校验 → 路径穿越 | S1 | ✅ **已修（决策 162）**：`PROJECT_KEY_PATTERN`/`isProjectKey` 进 `core/entity`，`createInStore` 与 `allocateKey` 在拼任何路径之前校验（`allocateKeyLocked` 承接原逻辑），CLI 与 `/jira` 用同一条校验给出人话错误；core 用例断言五个坏键都被拒且账本外什么都不多 |
| DPMJ-5 `assignee --override` 永不可用 | S1 | ✅ **已修（决策 163）**：`override` 移进 `flags`；并给 `COMMANDS` 加**加载即自检**（只允许 `maxPositionals`/`flags`，多一键就 throw）——这类「类型系统看不见的错位」现在在 import 阶段就炸，变异验证过 |
| DPMJ-6 边界守卫漏检多行/动态 import | S1 | ✅ **已修（决策 164）**：`check-boundaries.mjs` 改成**按语句扫描**（极小分词器，注释与字符串内容不进匹配器）+ 跨层判定按**解析后的落点**比；带 13 条形状的 `--self-test` 且**每次 `pnpm check` 都跑**；真文件探针（多行宿主 import / 动态宿主 import）各报一条 |
| DPMJ-7 git 写路径一批 | S2 | ✅ **已修（决策 165）**：收编排除「有活跃锁的在途写入」与 `*.tmp-*`；`commitStoreWrite` 加 `beforeCommit` 钩子（锁内），`regenerateAndCommit` 在锁内重算 source_tree 后必要时重渲染；`push` 有 15 s 超时；`runGit` 超时保留 stderr + error 分支清定时器 |
| DPMJ-8 插件层一批 | S2 | ✅ **已修（决策 166）**：`apply` 返回 disposer（工具/guard/订阅/命令/技能/队列全部可撤销）、命令面与 store 用**同一个** machine 身份、`/jira sync` 复用插件队列（拉+结算+推）；顺手三条 S3 |
| DPMJ-9 System/CLI 一批 | S2 | ✅ **已修（决策 167）**：`gitEnv` 大小写不敏感 + `GIT_NAMESPACE`、长路径按 root+40 量、`safeFileName` 补齐合同并真的被 `sessionPath`/`claimNotice` 用上、`sessionPath` 消毒 id、`$DSH_HOME` 相对路径绝对化 + `~` 展开 |
| DPMJ-10 io/args 一批 | S2 | ✅ **已修（决策 169）**：`sourceTreeEntries` 读不全就报错（不再哈希残缺树）、`currentSourceTree` 随之 `Result`；args 空值/重复 flag/单横线/未闭合引号不再静默；`--root` 先 trim |
| DPMJ-11 测试面一批 | S2 | ✅ **已修（决策 170）**：`inspect`/`validate` 有了直接测试、恰等边界（`isStale`）、写重试覆盖、**9 个临时目录全部清理**（实测增量 0）、`bothPlatforms` 用到新文件 |
| DPMJ-103 settle 跟不上 | S3 | ✅ **已修（决策 171）**：机理是插件队列与 CLI 在同一克隆上抢 fetch/rebase；`pullRebase` 现在走独立的 `network.lock`、被「分支已被 fetch 更新」拒时重试一次、`jira sync` 失败时报告领先/落后 |
| DPMJ-12 文档纪律一批 | S2 | ✅ **已修（决策 172）**：i18n 重复键守卫（+`--selftest` 进 `check:text`）、决策表恢复严格升序、修「决策 240」错引用、`jira-work` 补 `jira_kb` 段、工具 description 补拦截规则；§11.8 的翻状态拆为 DPMJ-104 |
| DPMJ-13 守卫质量一批 | S2 | ✅ **已修（决策 173）**：smoke 的注入行不再空串可绿、dist 不新鲜就拒绝跑、账本 CI 的提交绑定查全 range、`board.html` 真的检查无外链 |
| DPMJ-14 零碎 S3 清扫 | S3 | ✅ **已修（决策 174）**：`projectOf` 并到 `entity.ts`（两处别名）、ci.yml 过期注释、`check-text` 的 UTF-8 判定、USAGE 的 `--root` 兜底链、HANDOVER 的 `src/bin` 幽灵路径 |
| DPMJ-101 分配号/首写/渲染 | S3 | ✅ **已修（决策 176）**：`claimKey` 的 seed 在块内也生效（种子不会再被发出去）、`git init` 进 store 锁；「每路径全量渲染」记为纯性能项、未改并写明理由 |
| DPMJ-102 插件层三口径 | S3 | ✅ **已修（决策 177）**：会话记录最多重试 3 次（"试过"≠"记下了"）、`/jira status` 的可写性由调用者提供、读操作 30 s 的取舍写进注释；**会话记录的重试没有单元测试**，已在 issue 里列为未测项 |
| DPMJ-104 §11.8 翻状态 | S3 | ✅ **已完成（2026-10-19）**：十余行「已实现但标 ❌/⚠️」逐行对代码复核后翻转（含两处组间自相矛盾对齐），决策 64 的「AST」措辞按实修正为「语句级扫描+自检」；仍属实的缺口（57/58/59/81/82/29/102/67/73·119）保持原状态并更新证据；`comment/v1` 不存在标为「待用户裁定」；commit `998a161` |
| DPMJ-105 精读 16 个测试文件 | S3 | ✅ **已完成（2026-10-19）**：16 个文件全部逐行读完（两批独立审阅），逐文件结论在 issue 评论里；发现汇总为 **DPMJ-201**（S2：dispose/doctor-generated/migrateGitignore/fromWire 零测试 + 裸 rm 清理不统一；S3 一批） |
| DPMJ-201 测试加固 | S2 | ✅ **已完成（决策 178，2026-10-19）**：`dispose`/doctor-generated/`migrateGitignore`/`fromWire` 四个零测试的已落地行为补上守卫；`src/testing/removeTree.ts` 收编三份副本、八个文件的裸 `rm` 全换；十处 `it` 内 `mkdtemp` 改为登记后统一清；三处"声称>实际"改真（含一处**整段被注释吞掉的断言**）；测试 634 → **650**，六处变异验证 |
| DPMJ-202 `jira_kb search` 行号偏差 | S2 | ✅ **已修（决策 179，2026-10-19）**：`line` 改成**文件绝对行**（`ParsedDocument.bodyLine` + `KnowledgeEntry.bodyLine` + `hitFor` 加偏移，create 走一次 encode→decode 往返拿真实值）；测试断言"被引用的那一行真的写着检索词"；变异验证（改回正文相对 → 2 条失败） |

### 需要用户拍板的开放问题（别自己决定）

1. ~~手工 `git push` 绕过 settle~~ → **已裁定（决策 179）**：**不装 `pre-push` 钩子**（生成必须留在 DSH 进程内，决策 15），改为**报警**——`jira doctor` 在派生文件过期时打出一行 `! 派生文件已过期：推送前先 jira sync…`，`generated-stale` 文案也点名 `jira sync`。剩下的风险（不看 doctor 就 push）是**已知且已出声**的，不再需要新机制。
2. ~~`_merge/` 与 `K2_KEY_EXHAUSTED` 怎么算~~ → **已裁定并落地**：`_merge/` 由人自建（决策 154）、号段上限 9999（决策 158，用户裁定）。
3. ~~决策 41 要不要保留 camelCase 兼容层~~ → **已落地为直接换**（决策 159，`toWire` 单点转换，无兼容层——没有外部消费者）。
4. ~~`comment/v1` schema 不存在~~ → **已裁定为设计（决策 179）**：评论按决策 68 是锚制、一个文件多条评论，frontmatter 只能描述文件 → 决策 46 的清单去掉 `comment/v1`，八种 schema。

### 本会话（2026-10-17）在活账本上验证过什么 —— 别再重复验证

- **决策 148 活体验证**：活进程里写一条 → 防抖 flush 自动补出 `chore: 重生成派生工件 [no-issue]`
  （只动 `log.md` + `projects/DEMO/log.md`）→ 推送 → 本机=origin、工作区干净、**账本 CI（ledger）绿**。
- **分叉活体验证**：让"另一台机器"先推一条 → 本机落后 → 再写一条 → flush 把本机提交 **rebase 到远端之上**
  （远端那条完整保留，没有 force）→ 结算 → 推送 → ledger CI 绿。
- 账本里因此多了 3 条自我说明的评论（DEMO-1 ×2、DEMO-2 ×1）；这两个 issue 本身就是"示例、可随时删除"。
- 这两次验证的价值：`pull` 钩子曾是死代码、rebase 曾缺身份回退——**都是 CI 或活体才暴露的**，测试里已各有一条守卫。

### 踩过的坑：绿着推上去、活了才炸

**2026-10-18：网络锁把自己锁进了仓库（决策 175）**。决策 171 把锁放在 `.jira/network.lock/`，而账本仓的 `.gitignore` 是旧版（逐条列，没有这一条），于是收编提交把 `owner.json` 收了进去；它后来被删，那个「已暂存的删除」让每一次 `pull --rebase` 都拒绝跑——settle 永远失败、账本永远落后。**教训**：往仓库目录里放运行时状态前先确认 ignore 模式在，而且 ignore 文件本身也要能迁移。

**2026-10-18：账本 CI 在 settle 之后报 `log.md（stale）`（决策 168）**。不是偶发：`log.md` 的窗口原本「先取最近 100 条再过滤掉无 key 的」，无 key 的 settle 提交因为改了 `projects/*/log.md` 也进了那个窗口，把最老的一条带 key 的行挤出去 —— 于是它刚写下的 `log.md` 在提交那一刻就过期。修法是让 git 先过滤（`--grep`）再 `-n`。**教训**：`log -- ` 这类「路径过滤」的语义下，生成物自己也在被扫描的路径里，任何「取最近 N 条再筛」的写法都会被生成物自己的提交搅乱。（2026-10-17 20:50）

- **决策 159 把工具值改成 snake_case，却忘了宿主的 `output.render` 读的是同一份值** —— `renderIssueHuman` 读 `issue.kbRefs` 得到 `undefined`，`undefined.length` 直接抛，**每一次 `jira_issue get` 都返回 `invalid output`**，而 589 个测试当时全绿。
- 为什么测试没抓住：守卫只断言了**数据形状**（键都是 snake_case），没有一条**渲染过真实取值**；而宿主真正走的就是渲染那条路。
- 已修（`fromWire` 对称还原 + 三个 render 开头调用）并补上守卫：**对真实取值调 `output.render`**，四种形状（get / 拒读 / list / kb）各渲一次。变异验证：把 `fromWire` 拿掉 → 用例报出与活体一字不差的错。
- **规矩**：任何"改工具返回值"的改动，**必须同时跑一遍 `output.render`**；只验证形状不算验证。

### 踩过的坑：CI 上的假红（2026-10-17）

- **`ENOTEMPTY ... .git/objects/pack`**：555 个断言全过、job 仍然红——测试清目录时 `git` 的后台帮手
  还在写 pack，`rm -rf` 就报 ENOTEMPTY。`force: true` **不**重试这种情况。已给三个会跑 `git clone`
  的测试文件（`project` / `rebase` / `plugin/index`）换上带退避重试的 `removeTree()`；以后新增"真 git"
  的测试请照抄那个小帮手，不要直接 `rm`。
- 定位这类红之前的**规矩**：先看 `# pass/fail` 与失败文件，别急着改代码——本次红与当次改动无关。

### 协作纪律（不遵守会返工）

1. **任何行为变更 = 一条新决策行**（`DESIGN.md` §8，**下一条编号 200**）+ 本文件加一段；
   实施完把 §11.8 里对应的行翻成 ✅ 并写下落点。**每条新决策还要在 §11.7 的影响面索引里留一行。**
2. **模型面英文、人面中文**（决策 55）：工具描述 / 错误码 / JSON 键 / schema / `JiraError.message` **必须英文**；
   `src/plugin/index.ts` 的工具描述/错误码/schema **必须英文**；人面回调里的中文是允许的（决策 177 的
   `/jira status` 可写性行就是反例——旧规则「index.ts 零汉字」从那时起已不存在，守卫也不再数汉字）。
3. 字符串迁移**一律**用 `scripts/i18n-human.mjs` 与 `scripts/i18n-tests.mjs`：逐条**断言命中**、
   找不到且没翻过就**报错退出**、幂等。手工 sed 会漏（这套脚本两次按设计拦住实施者）。
4. 提交信息用**中文** + 决策号；提交前 `node --test` + 构建 + 烟测都要过。
5. **两个仓库**：本插件仓，和账本仓 `C:\Users\TS\.dsh\jira`（`uitstalie/dsh-plugin-multidevice-jira-cloudstore`）。
   两者都有自己的 git 钩子与 CI（账本仓的是 `.github/workflows/ledger.yml`：lint + `generate --check` + 提交信息绑定）。
6. **读路径不得写**（决策 38）；**绝不** `--force` / `reset --hard`（红线 1）。
7. 边界不可破：**不导入任何宿主包**（只允许 `node:*` 与相对路径，决策 108）、`core` 不依赖 `cli`/`plugin`、
   只有 git 钩子 shim 与两个入口可直写 `console`。`scripts/check-boundaries.mjs` 会拦
   —— 它上线当天就抓到一条真实违例（`/jira` 反向依赖 CLI 的参数解析器，已把 `args.ts` 移进 `core/`）。

### 环境与陷阱（踩过的，别再踩）

- **热重载有边界**（决策 123，2026-10-17 实测）：profile patch 的**配置**是热的；但 `link:` 进来的包
  **代码在进程里被缓存**，所以**改了 `src/**` 必须换进程**（GUI 那个 3080 进程要重启，本会话跑在里面时
  不要自己去重启它）。只改配置不需要。构建（`tsc -p tsconfig.json`）仍然必须先做。
- `DSH_READ_ONLY_SESSION` 是**宿主从不设置的假信号**；真信号是 `agent.options.agentPreset`（只读预设）。
- 账本里 `log.md`（以及每个 Bundle 的 `log.md`）的输入是**提交历史而非源树** → 任何新提交都会让它们 stale
  （`generate --check` 因此会红，这是设计如此）。**自决策 148 起这件事由推送队列自己负责**：
  每次 flush 的顺序是 `pull --rebase` → 重生成+提交 → push，所以**推出去的 HEAD 一定是新的**；
  但**工作区在"写入之后、下次推送之前"仍可能过期**，`jira doctor` 报 stale 是正常的，
  手工修一条用 `jira generate`（CLI 那条只写文件、不提交——它不会自己提交，这也是它和队列的区别）。
- **无 remote / `push.enabled: false` 的 store 不走 settle**：那时只在会话结束时重生成一次（决策 148 的代价）。
- 账本仓的 `.github/**` **不在**生成物源树白名单里 → 加 CI 不会让新鲜度检查变红。
- 历史坑（仍然有效）：非 ASCII 路径必须用 `fileURLToPath`（§5 硬约束 12）；可选宿主服务必须
  `ctx.get(...)` 读、不能属性读（§6.2）；包入口指向 `dist/`，**装之前必须构建**。

---

## 1. 现状

> ⚠️ **本节写于 2026-10-15 夜（设计期），数字已过期** —— 最新状态见 **§0.1**。保留作历史。

| 项 | 状态 |
|---|---|
| 阶段 | **实现期**：设计已收尾（A 类 **A1–A42** 全部定案），**插件已有实现**——core / CLI / 适配层 / 3 技能 / `/jira`；数据仓已建并接入 |
| 文档规模 | `DESIGN.md` **约 2100 行、119 条已确认决策**（§8） |
| 已建仓库 | 本仓库，GitHub **private**，默认分支 `main`；已推 **126** 个提交 |
| 数据仓 | `dsh-plugin-multidevice-jira-cloudstore`（private，16 提交）：`config.md` 词表**已定案**（5 状态 + `S1–S5` + `kb_types`，见 §2） |
| 曾经的未验证事实 | ~~`dsh web` 里宿主层注册的 tool 可不可见~~ → ✅ **已查明（决策 101）**：**可见**（走 bundle 包 + 宿主平面 insert）。**三路 spike 全部结案**（决策 96 / 100 / 101） |
| 唯一暂停的话题 | **（无）**——KB 检索已于本轮审计后定案（`DESIGN.md` §11.1、决策 37） |
| 一致性自检 | 已做**两轮**：第一轮修 22 处；第二轮针对决策 41–82 的落地（两路独立复核，修掉 P0 九条 / P1 十七条 / 排版四处，并清掉"表头计数与实际不符"） |
| 一致性自检（第三轮） | **Fedora 侧复核（2026-10-15 夜）**：修掉本文件过时数字与表格破损、`DESIGN.md` §8 决策 **104–119 归位**（原被误放进「历史」小节、且表格被切成 3 段）、§11.2 / §11.3 过期状态 |
| CI | ✅ `.github/workflows/ci.yml` 已落地（决策 66）：**ubuntu + windows × Node 22.19 / 24** 跑全部测试；另有文本卫生（LF / 无 BOM）与"构建产物含 manifest 声明的路径"两项检查，**均过变异验证**。job ② 的 frontmatter 校验与生成物新鲜度仍缺（需 store 侧生成器） |
| Fedora 真机验证 | ✅ **真机可用**。测试从 274 涨到 **290 全绿**（`pnpm install` 1.3 s、零运行时依赖；`tsc` 干净）；抓获并修掉 **2 个真 bug** + 1 条**测试的平台假设** + 1 个 inject 违规，见下 |
| 生成器 | 🟡 **核心已落地、尚未接线**：`core/generate.ts`（四个生成物的版式，决策 39/79/87）+ `io.sourceTreeEntries` + **15 个测试**。**还差 CLI 的 `generate` 命令**（见 §2 第 2 条）|

> **Fedora 首跑抓获（2026-10-15 夜）**
>
> 1. **真 bug——非 ASCII 路径让三个技能静默消失。** 包根目录用 `URL.pathname` 推导，而它保持
>    百分号编码，于是 `~/桌面/…` 下算出的路径**不存在**：三个随包技能**全部被跳过**，
>    而工具列表与界面上**没有任何提示**（内部只有一条 `skipped`）。改用 `fileURLToPath`，
>    并新增回归测试。已立为 **`DESIGN.md` §5 第 12 条硬约束**。
>    **注意：CI 也测不到它**——runner 的检出路径是 ASCII，只有"构造非 ASCII 路径"的测试能守。
> 2. **测试自己的平台假设。** `git.test.ts` 假设 `git init` 之后 `core.fileMode` 是空的；
>    但 **Fedora 上 git 自己就会写 `true`**（文件系统有 exec 位），插件"只补缺失键、绝不覆盖
>    已有值"的行为**反而是对的**。已改为借 runner 注入缝显式驱动"缺省 / 已有"两种状态，
>    不再依赖平台 git 写不写。
>
> 3. **没构建 = 装不上。** 包入口指向 `dist/`，而 `dist/` 被 `.gitignore` 排除；全新 clone 上直接
>    `dsh plugin add` 会 `failed to import`，该行**不激活**。**`pnpm build` 是安装的前置**
>    （已写进 §10 第一步）。
> 4. **可选宿主服务不能用属性读取。** 插件访问 `ctx.commands` / `ctx.skills`，却只在 `inject` 里
>    声明了 `tools` → 宿主抛 `cannot get property "commands" without inject`，整行不激活。
>    已改为 `ctx.get('commands')` / `ctx.get('skills')`。**单元测试抓不到**（决策 108 的假 ctx
>    不是宿主代理），只有真机集成测试能暴露——规则已记入 `DESIGN.md` §6.2。
>
> **✅ 真机验证已通过（2026-10-15 夜）**：用一次性 profile `jiraverify`（headless 模板）装上插件后，
> 真实会话**无任何激活警告**；会话日志里**出现 `jira_issue` 工具与三个技能**
> （`jira-work` / `jira-board` / `jira-triage`）——"装上去模型看得见"从推断变成实测。
>
> 5. **假 ctx 已改为"宿主代理式"（已做）。** 并把不可达的服务字段**从 `JiraHostContext` 里删掉**——
>    第 4 类 bug 于是有两道防线：`tsc` 拒绝属性读取；测试的代理假 ctx 抛与宿主**同样的错**。
>    两道都做了变异验证（注入写法 → `tsc` 报 `TS2339`；绕过类型 → **20 个测试失败**）。
>    测试总数 **275**（274 + 这条守护用例）。
>
> 6. **无需重启，热更新已生效（用户实测确认）。** profile 的 `patchReload: live` 在 `dist/` 补齐后
>    就把插件装上了——"改 JS 需重启"那条只适用于**替换已加载的模块**，首次导入此前不存在的
>    构建产物不需要。
>
> 7. **没有 git 身份 = 提交静默全失败（严重）。** CI runner / 全新机器 / 容器上没有
>    `user.name`/`user.email`，`git commit` 报 `Author identity unknown`；而**文件写入是成功的**，
>    于是台账看起来健康、**git 里什么都没有**（无审计、无 `git revert`、无跨机同步，`log.md`
>    永远拿不到提交）。已改为**按次注入** `-c user.name=dsh-jira -c user.email=jira@local`
>    （绝不写进仓库配置——`user.name` 同时是 §4.9 `human:<name>` 的来源）。已立为**决策 146**，
>    复现条件是 `user.useConfigOnly=true`，并加了两个守护用例。
>
> 8. **知识域计数把生成物算成了条目（已修）。** `domainRows` 自己扫 `knowledge/<域>/` 递归数 `.md`，
>    于是生成的 `index.md`/`log.md` 被算成知识：根索引对只有 1 条条目的域报 **3 条**，而且那个数字
>    只在**第一次生成之后**才出现，所以**单次 `generate` 不是不动点**（CI 的"重跑后 diff 为空"会挂）。
>    改为从 `listKnowledge` 的同一份 listing 派生（`KnowledgeListing` 新增 `domains`），并加了回归用例
>    （变异验证：注入 `+2` → 断言在计数上失败）。**§11.7 决策 120 那行早就写明**"任何枚举 store 文件的
>    代码都要先问一句生成物排除干净了吗"——这条预测兑现了。
>
> **仍未做**：① 决策 66 的 job ② 里 **frontmatter 校验**与**生成物新鲜度断言**——它们需要
> `BOARD.md` / `index.md` / `log.md` 的**生成器**，而 `jira board` 目前只打印不写文件；
> 这两项属于 **store 仓库**的 CI。② 设计里的 **`jira_list` / `jira_kb` 尚未实现**
> （当前只有 1 个工具 `jira_issue`，列表与看板靠 CLI 与 `/jira`）。

> **Windows 机两轮新增：决策 33–82（设计收尾）与 83–119（实现落地）**（逐条内容见 `DESIGN.md` §8；本节只详述 33–40）
>
> - **33** `gh` **不是依赖**，只是开发期便利；**部署 / 使用电脑不得假设有它**（SSH / 网页兜底）。
> - **34** **离线可用是硬要求**：无 `gh`、无 SSH、连不上云端、不保证同步时，建改 issue / 评论 /
>   tag / KB / 锁 / CAS / 提交绑定 / 看板都必须**本地照常可用**，连不上不得阻塞任何操作。
>   连带把「`BOARD.md` **只**由 GitHub Action 生成」改为 **Action 与插件都能生成、`core` 里只写一次**
>   （**已定案**：Action 与插件都能生成）。
> - **35** 那台离线机上是**从零建的空独立实例**，与主 store **无共享历史**；
>   连带收窄决策 11「单个 store」= 仅指共享主 store 那一层。
> - **36** 跨实例**默认不合并**（相当于"新分支"，key 各从 `1` 开始，不预留号段）；
>   真合并时一次性**人工重编号 + 重新编排**，产出旧→新 key 映射表，**不是持续同步**。
> - **37** **KB 检索：不做向量、不做 RAG、不引入本地 ML 模型**。关键字检索就是**直接遍历 store 里的
>   `.md` 做子串匹配**（实测上游正式库 59 文件 / 116 KB、单次全量扫描 **0.3 ms**；全仓 135 文件 / 351 KB、1.5 ms）
>   ——这个体量**根本不需要索引**。相关反例与要抄的做法全在 `DESIGN.md` §11.1。
> - **38** **读操作不得写**：`jira_list` / `jira_issue get` / KB 检索一律**不修改任何文件**；
>   "热度 / 活力 / 代际"这类统计要么落到 `var/` 派生侧、要么干脆不做。
> - **39** **生成物必须可验证新鲜**：单独成文件、内嵌 `generated_at` + 源树 hash，并有断言新鲜度的检查。
>   上游 `index.md` **陈旧两个月、整个域缺失无人发现**；`log.md` 还把"手写段 + 生成段"塞在同一文件里、
>   靠魔法字符串 `## 事件流` 切分。两个都是实证反面教材。
> - **40** **forge 可替换**：设计**不锚定 GitHub**。只用 git 能力的部分三家通吃；
>   **依赖 forge 产品功能的只有四处**（Action 生成 `BOARD.md`、`gh` CLI、分支保护、网页编辑），
>   换 GitLab 时按 `DESIGN.md` §7.4 的**替换清单**逐个换（+ 换用 `glab`），其余设计不动。
>   store 暂放 GitHub private（决策 8 不变）——用户表态"**可能要换**"，所以留了这条路。
>
> **两条待核项**（`DESIGN.md` §11.2）：① 这台 Windows 机的 DSH 是 **`0.2.0-rc.2`**，
> 而 §2.2 与本文档记的是 `0.2.1-alpha.2`；② §2.7 方案 ④（`preset:` patch）的唯一出处
> `docs/architecture.md:25` **在本版本不存在**，核对前 ④ 不入方案。

---

## 2. 下一步

> ⚠️ **本节写于 2026-10-15 夜（设计期），下面列的 1–4 项当时都还没做** —— 它们**后来全部完成**，
> 最新待办见 **§0.1**。保留作历史（含当时的原计划 `details` 折叠）。

**已完成**：KB 审计定案（`DESIGN.md` §11.1、决策 37–39）；数据仓 `cloudstore` 已创建并推骨架（见 §5）；
**`config.md` 词表已定案**——5 个状态 `todo / in_progress / in_review / closed / cancelled`。
`closed` 与 `cancelled` **同属"关闭集合"**（不进待办；**归档 MVP 不做**，决策 62）
（用户裁定"读法 ①"，理由是每条关闭记录都统一带一个结论字段）；为区分"中止"与"结论"，
`resolutions` **新增了 `abandoned`**——**别把 `cancelled` 配上 `invalid`**（`DESIGN.md` §4.16 修正记录）。

**接下来：**

1. ~~开始写代码~~ → ✅ **已写**；~~真机验证~~ → ✅ **已完成**（见下方"Fedora 首跑"与 §1 的 CI 行）。
   插件**已装进 `web` profile**，且**热更新已生效**（用户实测）；前提是 `pnpm build` 先跑过（§10 第一步）。
2. ✅ **已接线**（决策 120）：`jira generate` / `generate --check`（退出码 1 供 CI） / doctor 的 `generated-missing|unmarked|stale`；幂等由「内容未变则保留 generated_at」保证，所以 CI 的「重跑 + git diff 为空」成立。原计划保留在下方备查。

   <details><summary>原计划</summary>

   2. **把 `core/generate.ts` 接到 CLI** —— 生成器**核心已落地**（四文件版式 + 头部 + 源树哈希，
      **15 个测试**），但**还写不出文件**：
      - 加 `generate` 命令（写 `BOARD.md` / `index.md` / `log.md` / `tags/index.md`）
      - 加 `generate --check`（供 CI 断言"重跑后 `git diff` 为空"）
      - 把新鲜度比对接进 `doctor`（决策 39 要求"提交前 / CI / `/jira` 体检"三处可用）
      ⚠️ **这会新增第 11 个 CLI 子命令**，与**决策 118 的"CLI 十个子命令"冲突** → 必须
      **新增一条决策**（下一条编号 **120**），并在 `DESIGN.md` §11.7 影响面索引里留一行。
      ⚠️ `log.md` 的输入是**提交历史而非文件**，所以它的头部哈希**无法自证新鲜**，只能靠
      "重跑 + diff 为空"来验（`core/io.ts` 的 `isGeneratedInput` 注释写了为什么）。

   </details>

3. ✅ **已实现**（决策 121）：`jira_list` 三处一致（工具 / CLI `list` / core/list.ts 全序排序、被阻塞单独成组、limit 20/100、counts 描述全集）。原计划保留在下方。

   <details><summary>原计划</summary>

   3. **实现 `jira_list`** —— 设计里的第 2 个常驻工具（**目前只有 1 个** `jira_issue`）：
      参数 `project? / status? / tags? / assignee? / link? / limit? / include_closed?` →
      `{ items, groups, counts, truncated, writable, me }`；排序分组按**决策 53**（先 project →
      再 `statuses[].order` → 组内 priority 升序 → 同级 `updated` 倒序；**被阻塞单独成组放最后**；
      `limit` 默认 20、上限 100）。`core/generate.ts` 里已有同样的分组与"被阻塞"判定可复用。

   </details>

4. ✅ **`jira_kb` 已实现**（决策 124）：`get`/`create`/`update`/`search` 四个动作，来源四件套由 store 记录，search 给 `file:line` + ≤200 字片段、绝不回整篇。剩下的：KB 的 CLI 子命令（决策 83 的 `jira kb`）、`kb_refs` 与 issue 的双向引用在写路径上打通、以及 §11.6 的 C 类与 §11.2 的版本待核项。

   <details><summary>原计划</summary>

   4. 之后：`jira_kb`；`DESIGN.md` §11.6 的 C 类（实现期新取舍）；§11.2 的版本待核项。

   </details>

> **已作废的原计划**：用户带 KB 实现回来 → 一起过 §11.1 → 再定目录结构建仓。
> **这三步均已完成**（原话"审计完了明天再说"已兑现）。

---

5. ✅ **已做：重生成的时机 = 每次推送之前**（决策 148，2026-10-17 深夜用户裁定"方案 B"）。
   **为什么**：实测确认**推送发生在会话中途**（收编提交 5 秒内就被防抖队列推走），而写一条 issue 会让
   生成物过期 → 会话中途的每次推送都带着陈旧生成物 → **数据仓门禁基本常红**，直到会话结束那次重生成才修好。
   **用户先选"折进每次写入的那个提交"，实施中撞到两件实测事实**（这也是它没被选的原因，别重复走一遍）：
   - ① **对 `log.md` 不可能**：写入提交自己带 keyed 主题（`DH-1: …`），而 `log.md` 列的就是 keyed 提交，
     所以它一提交 `log.md` 立刻过期——文件不能包含自己所在提交的哈希。实测：写入后只剩
     `['log.md', 'projects/DH/log.md']` 过期（其余四个已被折进去），**推出去的 HEAD 仍然红**。
   - ② **"每次写入两个提交"（写入 + unkeyed 生成物提交）可行，但冲突面更大**：每个生成物提交都要参与
     跨机 rebase 合并，而生成物必然两边不同（头部带 `generated_at`/`source_tree`）→ 实测旧用例
     "两边各改一处、应当干净合并"的那次 `pull --rebase` 直接 stopped（`无法应用 DH-1: update (rev 2)`）。
   **最终落地（方案 B）**：`core/push.ts` 的推送队列加 **`settle` 钩子**，顺序固定
   **`pull --rebase` → `settle`（重生成+提交）→ push**；`settle` 失败**拦住推送**（不推门禁必红的提交）。
   `settle` 是**每次 flush 的参数**（`flushNow({ settle })`）而不是队列属性：能不能写是**调用者**的属性
   （决策 89/93），防抖那条路必然可写（只由已成功的写入武装），会话结束那条把 `writable` 传进来。
   接线两处：`src/plugin/index.ts` 的队列（`settle: () => regenerateAndCommit(...)`）与 CLI 的 `sync`。
   **顺带修掉一个从写下就是死代码的钩子**：插件推送队列的 `pull`（决策 134）**注释与代码在同一行**，
   `//` 吞掉了整个钩子（`db7743e` 起）→ 插件的推送**从来不 pull**，两台机器时会 non-fast-forward
   无限重试；只有 CLI 的 `sync` 有。
   **测试**：546 → **551**（`push.test.ts` +4：顺序 / settle 失败拦住推送 / 防抖必 settle 而显式 flush 由调用者决定 /
   无 remote 不 settle；`plugin/index.test.ts` +1：**端到端**——真 bare remote + 另一台机器的提交 →
   工具写入 → 防抖 flush → 克隆 bare 跑 `checkGenerated` 为空）。
   **两处变异验证**：① 把插件的 `pull` 钩子重新注释掉 → 那条端到端用例失败（36/37）；
   ② 把 `settle` 挪到 `pull` **之前** → 顺序用例失败，且端到端失败在小字断言"检出的提交是新的"、
   报 `log.md: stale`（正是这条决策要消灭的红法）。
   **CI 又抓出第二个真 bug（已修，决策 146 的适用范围）**：新写的端到端用例**本机全绿、CI 四个 job 全红**。
   原因是 `git pull --rebase` 要**重放**提交，而重放会**创建**提交 → 它和 `git commit` 一样需要**提交者身份**；
   决策 146 的回退只给了 `git commit`。于是在 git **猜不出**身份的环境（CI runner / 全新容器 /
   `user.useConfigOnly=true`）里：rebase 以「提交者身份未知」停住、**把账本留在 rebase 中途**
   （HEAD 分离、被重放的改动停在暂存区）、推送永远不发生；本机全绿只因我这台机器的 git 能从 GECOS/主机名
   猜出身份。修法：`core/git.ts` 导出 `identityArgs`，`core/rebase.ts` 的 `pull --rebase` 与提交同一套按次注入。
   **测试侧也钉住了这个条件**：`plugin/index.test.ts` 顶部设 `user.useConfigOnly=true`，并在本机存在身份时
   隐藏 global/system config —— 否则这个 bug 只在 CI 上可见（本机复现命令就是那两行 env）。
   **变异验证**：把 `identityArgs` 从 rebase 里拿掉 → 端到端用例立刻失败，证据是
   `dir status: A projects/DH/comments/DH-12.md` + `rebase state: true`（我第一版诊断把目录当成文件读，
   报了假的 `false`，已修）。
   **代价（用户已知并接受）**：本地工作区在"写入之后、下次推送之前"仍可能过期（`jira doctor` 会报 stale）；
   无 remote / `push.enabled: false` 不走 settle（会话结束那次照旧）。

## 3. 文件地图

| 文件 | 作用 |
|---|---|
| `DESIGN.md` | **唯一真相源**。§1 定位 / §2 DSH 事实基础 / §3 分层 / §4 数据模型 / §5 存储与并发 / §6 接口 / §7 仓库方案 / §8 决策清单（**到 148 条**）/ §9 风险 / §10 参考 / §11 未决与红线（**§11.8 是实现覆盖清点**，第 4 档的待办就在那里；**§11.7 是改动影响面索引**） |
| `HANDOVER.md` | 本文件（**§0.1 是当前状态**） |
| `src/core/` | 全部行为：`store/codec/mutate/validate/errors/io/lock/git/config/vocab` + 各功能域（`lint` `doctor` `generate` `generateStore` `inspect` `keyset` `tagsLint` `consistency` `perf` `boardHtml` `project` `workspace` `machine` `machines` `provision` `hooks` `commitmsg` `push` `rebase` `session` `tagstore` `kb` `kbstore` `kbsearch` `args` `render`） |
| `src/cli/` `src/plugin/` | 两个适配层：`cli/index.ts` 是进程入口（`bin` 在 package.json 里指向它，没有单独的 `src/bin` 目录）+ `dsh` 插件行（工具 / 命令 / 技能） |
| `scripts/smoke.mjs` | **三面烟测 33 步**（只读 CLI 块 → 克隆生命周期 → 钩子纪律 → 注入行 → 工作区绑定）。**跑的是 `dist/`** |
| `scripts/check-boundaries.mjs` | 决策 108 + 分层的守卫（宿主包 / core↛适配层 / `console` 白名单）；已接进 `pnpm check` |
| `scripts/i18n-human.mjs` `scripts/i18n-tests.mjs` | 人面中文化的迁移工具：逐条**断言命中**、幂等、找不到就报错（**加字符串请走它们**） |
| `scripts/check-text.mjs` `scripts/check-build.mjs` | 文本卫生（LF / 无 BOM）与"构建产物含 manifest 声明的路径" |
| `.github/workflows/ci.yml` | 本仓 CI（ubuntu + windows × Node 22/24 跑全部测试 + 两项检查） |

---

## 4. 设计期最重要的 10 条（丢了会返工）

1. **文件即数据、git 即审计**——不自己造审计系统；`git revert` 就是版本回退
2. **绝不** `checkout --force` / `reset --hard` / `clean`；脏工作树先作为独立 commit 提交掉
3. 数据仓库的**第一个文件是 `.gitattributes`**：`* text=auto eol=lf`；评论文件声明 `merge=union`
4. **Windows 上 `rename` 不是可靠原子操作**（要重试退避）；锁用 **`mkdir` 唯一原语**（决策 59），**不用 `flock`、不引第三方锁库**；**两级锁**（决策 58）
5. **不解析人类可读的 `git log` 输出**（Windows 会 GBK + `\r\n`）——用 plumbing + NUL 分隔
6. 写事务里**绝不 push**；**绝不隐式 pull**
7. **每机一份** `counters/<machine_id>.json` → key 分配在 git 层面**零冲突**，且可离线创建
8. **有向 link 只存单向**，反侧一律派生（`parent`→`children`、`is_blocked_by`→`blocks`）
9. **拦截只对"走工具的那条路"有效**——人直接改文件天然绕过。
   只读策略、commit 绑定、tag 校验都是这一条
10. **注入的是"存储意识"（一行统计），不是待办议程**——议程注入被明确否决过

---

## 5. 环境事实

- `gh` 已登录 **`uitstalie`**，Git 操作用 SSH，密钥就位
- `$DSH_HOME=C:\Users\TS\.dsh`，当前 profile `web`；DSH 版本**本机实测 `0.2.0-rc.2`**——文档别处曾记 `0.2.1-alpha.2`，属**待核**（peer 依赖按部署机实际版本钉，决策 63）
- **宿主 checkout 有两个，别搞混**（本轮实测）：`D:\dqc\deepseek-harness-uitstalie`（**0.2.0-rc.2**，分支 `master`）**正在跑 3080 的 GUI**——启动命令是 `node --import tsx/esm apps/cli/src/bin.ts web`，**直跑源码、免构建**；`D:\dqc\deepseek-harness-uitstalie-dev`（**0.2.1-alpha.2**，分支 `cli-desktop`）是**最新的魔改版本**，会**不定期 pull 同步到跑 3080 的那个 checkout**（两者 remote 同一个：`git@github.com:uitstalie/deepseek-harness-uitstalie.git`）。→ **插件要面向的"将来的宿主"是 dev 的版本，master 只是当前宿主**（Fedora 那台的路径不同，是 `~/桌面/dsh/…`）。
- **本机现在有两个 GUI 在跑，且共用一个 profile**：**3080 = `deepseek-harness-uitstalie`（rc.2, master）**、**3081 = `deepseek-harness-uitstalie-dev`（alpha.2, cli-desktop）**；两者都用 `$DSH_HOME/profiles/web`。**后果**：① 插件装进 profile 后**两个 GUI 都会去加载**（profile 的 `node_modules` 是共享解析锚点之一）；② 因此 **peer 范围必须同时满足 rc.2 与 alpha.2**，否则 `compatibility-preflight` 会在其中一边把该行 `disabled: true`（只打 stderr）；③ 现有 `profiles/web/cordis.patch.yml` 里 insert 的 `models-dev`/`ui-models-dev` **在 rc.2 里解析不到**（rc.2 的 `packages/uitstalie/` 是空的，dev 才有）——这既是"patch 装了 ≠ 一定挂上"的活例，也是 3080 启动时那条 warning 的来源。
- 目录：`dsh-plugin-multidevice-jira/`（本仓库）、`dsh-jira-storage/`（空，只剩 `.dsh`）、
  `dsh-common-storage/`（空；原为知识库占位，**知识库已并入 jira**，此目录可能废弃）
- **知识库既有实现**：`D:\dqc\kb-llm`（两个仓，都在**公司内网 GitLab**：`KB-LLM-Deploy` 引擎 +
  `KB-LLM-WIKI` 内容）。⚠️ **里面含真实 JIRA 单号、员工姓名、内部代号与未发布产品结论**——
  **不要整体外传；拿它做测试或演示前必须先脱敏。** 审计结论见 `DESIGN.md` §11.1（决策 37–39）。
- **数据仓（store）**：`dsh-plugin-multidevice-jira-cloudstore`（GitHub **private**，默认 `main`），
  本机 clone 在 `D:\dqc\dsh-plugin-multidevice-jira-cloudstore`。
  注意 `DESIGN.md` §5 里那个 `$DSH_HOME/jira` 是**插件运行时的默认 `root`**；
  开发期的 clone 放在哪都行，靠配置指过去即可。
  提交：`a179db2`（骨架，`.gitattributes` **先行**）→ `7442482`（5 状态）→ `ca7d8e4`（读法 B + `abandoned`）→ 之后陆续补 `kb_types` / `.jira/locks/` / `var/` 等。
  **`config.md` 已定案**（5 状态 + `S1–S5` + `kb_types`，见 §2）。
- 两个仓库都是 private；**计划后续暴露 public 镜像**
- ✅ **Windows 机器的 Git 凭据已验证可用**（本机实测：`git ls-remote origin` 与
  `git push --dry-run origin main` 均成功；走 SSH + Git Credential Manager，**与 `gh` 无关**）
- ✅ **本机（Windows）已装 `gh 2.102.0`**：用户级便携安装到 `%LOCALAPPDATA%\Programs\gh\bin`
  （不进系统目录、不需提权；winget 的 `GitHub.cli` 是机器级 MSI，要 UAC），已加入**用户** PATH。
  **已 `gh auth login`**：账号 `uitstalie`、存在 keyring、协议 SSH、scopes `repo` / `read:org` / `gist`。
- ✅ **旧的 GitHub 令牌已注销并清理干净**（本轮完成）：那份凭据是 **Git Credential Manager 签发的
  OAuth 令牌**（client id `0120e057bd645470c1ed`，scopes `gist` / `repo` / `workflow`），
  **不在 "Personal access tokens" 页面**，只能在
  **Settings → Applications → Authorized OAuth Apps** 里撤掉 GCM 的授权。
  撤后实测：旧令牌返回 **HTTP 401**、本地副本已用 `git credential reject` 清掉
  （Windows 凭据管理器里只剩 `gh:github.com:*` 两条）、`gh` 自身认证未受影响、SSH 路径正常。
  **只有 HTTPS 方式的 git 操作**需要重新授权，**SSH 不受影响**（本仓库用的就是 SSH）。
  > 备查：`gh auth login --with-token` 曾试图复用它，因**缺 `read:org`** 被拒——
  > 即它本来就不是一个可用的 gh 凭据。
- 本仓库自身也是**跨机器仓库**：已加 `.gitattributes`（强制 LF）与 `.editorconfig`（UTF-8 无 BOM）
- **Fedora 机（2026-10-15 夜实测）**：`$DSH_HOME=/home/uitstalie/.dsh`、profile `web`、
  GUI 在 **3080**（进程 `pnpm dsh web`）；宿主 checkout `~/桌面/dsh/deepseek-harness-uitstalie`，
  版本 **`0.2.1-alpha.2`**、分支 `cli-desktop`（同日 21:13 同步过）。
  **注意路径是中文"桌面"，不是 `Desktop`。**
  `node v25.9.0` / `pnpm 11.28.5`（满足 engines）；`gh` 已登录 `uitstalie`（SSH）。
  两个仓库 clone 在 `~/桌面/dsh/`：`dsh-plugin-multidevice-jira` 与 `...-cloudstore`。
  ⚠️ **profile 里尚未安装本插件**（`profiles/web/package.json` 无 jira 相关行）→ 要真机验证得先装。

---

## 6. 怎么和这个人协作（下一个人/agent 必读）

- **全程中文**
- **一次只问一个问题**，用选项卡片。原话："一个个对话模式来问，看着太累了"
- **文档即真相源**：每个决定**当场**写回 `DESIGN.md`，不留口头结论
- **他会直接纠正错误结论**，而且经常是对的。
  **被纠正后要在文档里留"修正记录"，不要静默改掉**（`DESIGN.md` 里已有**多处**这样的记录，
  这是刻意保留的，防止以后又绕回错误结论）
- **他会鼓励你多问**："你想的越多，越容易确定设计"、"尽可能多问问题"
- **"多问"是被明确肯定的工作方式**（用户原话，本轮）：「多问是好事，能尽量想清楚设计目标是好的，**即使后面改变了也知道谁会被影响到**，而不是现在这种拍脑袋处理。」
  → 所以：**宁可多问，不要凭印象拍板**；"我扫到的"不等于"全部"（本轮"只差 §11.3"的判断**漏了 55+ 条**，见 `DESIGN.md` §11.6 的诚实结论）。
- **每写一条决定，顺手记它的影响面**：改动会牵动哪些节 / 哪些其它决策 / 哪些产物。改动前先查索引（`DESIGN.md` §11.7），不要只看它自己那一节。
- **计数必须数出来**：凡"还剩 N 条 / 多少处"一律用脚本按实际行数数，不写估计值（本轮正是这样才发现"表头计数 39 vs 实际编号 42"、"§8 少了一行"）。
- **批量改文档后必须核对结构**：表格行数 / 编号连续性（1–N 无重无缺）/ 代码围栏成对 / "有没有把整行误替换成片段"。本轮就因此**误删过 §8 的一行**、也**漏插过三次**（工具用法的坑），全靠结构核对抓回来——**改完不核对，等于没改**。
- **编码原则三条（用户原话）**：「1. 所有的内容**原子化、function 化**；2. **能组合就组合**，多使用 **data class**，多去复用组合，而不是自己写一堆东西；3. 原子化之后，后面可以很好地控制。」→ 落成 `DESIGN.md` **§3.1**（含形状示例），**review 只问三句**：有隐藏状态吗？在组合还是在重写？能单独测吗？
- **用户看不懂 TS**（原话："ts 啥的看不懂，记得写 test case 就行"）→ **交付证据一律用测试与行为描述**：报告里写"跑了几条测试、命令输出是什么、失败会怎样"，**不要贴代码片段**，也不要指望他 review 源码。测试是这套代码唯一对人可见的说明书。
- **DSH 侧结论只读文档与清单文件**（`docs/**/*.md`、各包 `README.md`、`package.json`、`*.yml`），
  **不读 `src/*.ts`**——因为他的 DSH 是魔改 fork，源码不能当作上游依据
- **会话工作目录若不在本仓库内，改文件需要沙箱越权批准**。
  建议每次**从本仓库目录开会话**，否则每次编辑都要批准一次

---

## 7. 会话里出现过的错误结论（别重犯）

这些都被用户纠正过，`DESIGN.md` 相应位置留了记录：

| 错误结论 | 为什么错 |
|---|---|
| "配置状态机就是跑偏了" | 那是 **DSH 核心 surface** 的取向，不约束插件自己的领域模型 |
| "注入待办队列是价值支点" | 那是噪声；Jira 是**记录**不是调度器，只注入存储意识 |
| "`duplicate` 变成 link 后 `resolution` 就多余了" | link 是**关系**，resolution 是**结论**，两回事 |
| "`limitation` 是个带生命周期的实体" | 它只是 `resolution` 的一个**取值** |
| "固定 category 才能让通用代码理解状态" | 只在"每个 project 各自一套状态机"时才成立；现在是全局一套，理由消失 |

---

## 8. 如果这个项目不再继续

- **License: MIT**（已定）
- **代码已存在**（core / CLI / 插件层，273 测试），但**从未在 Fedora 这台机器上跑过**——跨机器正确性尚未验证
- 无外部依赖、无部署；**数据仓已建**（删仓时注意它含真实台账与知识库，不是空壳）

---

## 9. 关键决策速查（完整版见 `DESIGN.md` §8）

- 单个 store，定位"单人多设备"；**每工作区 = 一个 project**，身份锚在 **git 远程地址**而非路径
- 机器身份 `md5(os + currentUser + SN)`；**双系统算两台机器**
- agent 身份 `agent:<model>|<tool>|<machine_id>|<session_id>`（`tool` = dsh / claude-code / trae / …）
- 存储形态：**Markdown + YAML frontmatter**，遵循 **OKF 规范**；每条 issue 一个文件
- 状态机：**单一全局 `config.md`**，状态可配置、**只增不删**、下线用 `deprecated` + 摘入边 → **零数据迁移**
- 关系：固定闭集 `related` / `duplicate` / `is_blocked_by` / `parent`；跨域分类靠 **tag 注册表**（description 必填）
- 完成结论：`resolution` 可配置（`fixed` / `invalid` / `limitation` / **`abandoned`**），**关闭集合内一律必填**（决策 25）
- 并发：`revision` **可选**，过期则拒绝并返回当前值（不静默覆盖）
- 看板：**`BOARD.md` 由 Action 与插件都能生成，生成代码在 `core` 里只写一次**（决策 15；原"只由 Action 生成"已被离线要求推翻），顺带做 frontmatter 校验
- 提交绑定：**本地 hook 拦截**，未绑定须显式 `[no-issue]`；**只拦未来、不追溯历史**
- 接口：常驻 3 个 tool（`jira_issue` / `jira_list` / `jira_kb`），其余 `deferLoading`；
  人用 `/jira` 斜杠命令（**零模型 token**）

---

## 10. 在 Windows 上第一次跑（明天的入口）

**如果你是另一个 agent，在没有这段对话历史的 Windows 机器上接手：按本节的顺序做。**

### 第一步：拿到仓库、**构建**、并确认能推送

```powershell
git clone git@github.com:uitstalie/dsh-plugin-multidevice-jira.git
cd dsh-plugin-multidevice-jira
pnpm install                     # 只有 @types/node + typescript，零运行时依赖
pnpm build                       # ★ 必须先构建，见下
pnpm test                        # 应 274 全绿
git ls-remote origin             # 能列出远程引用 = 凭据就位
git push --dry-run origin main   # 成功 = push 授权就位（不写入任何数据）
```

- **★ `pnpm build` 不是可选项。** 包入口指向 `./dist/plugin/index.js`（决策 65：`tsc` 产物
  **拷贝到目标机**），而 `dist/` 在 `.gitignore` 里、**不在仓库中**。跳过构建直接
  `dsh plugin add` 的后果是 `failed to import` → 该行**不激活**（2026-10-15 Fedora 实测踩过）。
- 仓库是 **private**，凭据必须在这台机器上单独配好（放好 SSH key，或 `gh auth login`）。
  **不要假设 Fedora 那台机器的凭据会自动可用。**
- 判据是**能访问远程**，不是"装着 `gh`"。`git ls-remote` 失败时**先停下来问人要凭据**，不要尝试绕过。

> **修正记录（Windows 机实测）**：本节早期把 `gh auth status` 写成硬前提
> （"必须先有输出且已登录；否则后面一步都做不了"）——**那是错的**。
> `gh` 只是 GitHub 的 API 客户端；clone/push 走的是 SSH key 或 Git Credential Manager，两者互不依赖。
> 实测当时本机**尚未安装 `gh`**（那次验证完全没经过 `gh`；`gh` 是之后才按需装上的），
> `git ls-remote origin` 与 `git push --dry-run origin main` 均成功。
> `gh` 只在**建仓库、开分支保护、调 GitHub API** 时才必需——而这些也要尽量留 SSH / 网页兜底路径
> （见 `DESIGN.md` §8 决策 33）。

### 第二步：选一个安全的本地路径

- **不要**放在 OneDrive / Dropbox / 网盘同步目录里——云同步会与 git 争抢文件。
- 路径尽量浅（Windows 默认 260 字符上限），例如 `C:\dev\dsh-plugin-multidevice-jira`。

### 第三步：读文档的顺序

1. 本文件（`HANDOVER.md`）——你已经在这里了
2. `DESIGN.md` §11（未决与待办 + 实现期红线）——**这是最该先看的**
3. `DESIGN.md` §8（**119 条**已确认决策速查）+ §11.6（未决清单：A 全清、B 全清）
4. 需要细节时再按需翻 §1–§7

### 第四步：两机交替的硬纪律

这是**两台机器共用一个仓库**，所以：

- **开工前**：`git pull --rebase`
- **收工前**：`git push`
- 两台机器不要同时编辑同一文件；真冲突时**保留双方并标注**，不要自动择一

### 第五步：Windows 上的注意事项

- 本仓库已用 `.gitattributes` 强制 LF。**不要去改 `core.autocrlf`**，让 `.gitattributes` 说话。
- 编辑器建议遵守 `.editorconfig`（UTF-8 **无 BOM**）。BOM 会污染 diff。
- 本仓库里没有二进制文件，但规则已预留。

### 第六步：下一件事

**读 §0.1 的"一句话状态"**（那里是唯一可信的待办指针——当前唯一待办是账本里的 DPMJ-201，测试加固）。
不要从 §1/§2 找待办——那两节是历史，数字早过期了。

开工前先跑一遍"五个命令"，确认基线是绿的：`pnpm check` + `pnpm test`（应为 **702** 个测试全过）+
`pnpm build` + `pnpm smoke --root <store>`（应为 33/33）。基线不绿就先查基线，别叠加改动。

---

## 11. 关于"另一个 agent"的提醒

> **2026-10-17（本轮，最值得先读的六条）**
>
> 1. **两个真 bug 都只在"非本机环境"暴露**：① 插件推送队列的 `pull` 钩子**从写下就是死代码**
>    （注释与代码落在同一行，`//` 把整个钩子吞了）——插件的推送从来不 pull，两台机器时 push 被拒为
>    non-fast-forward 并无限重试；② `git pull --rebase` **缺身份回退**（重放提交要创建提交，就像
>    `git commit` 一样需要身份），在猜不出 git 身份的环境上 rebase 会停住并把账本留在中途。
>    **教训**：本机 git 能从 GECOS/主机名猜出身份，所以本机永远看不到 ②；CI runner 看不到 ① 之外的东西。
>    → **判据**：任何"只在 CI 红、本机绿"的现象，先问"本机有什么是 CI 没有的"（身份、HOME、已有远端、已有缓存）。
> 2. **把 CI 的条件钉进测试里**：`src/plugin/index.test.ts` 顶部设 `user.useConfigOnly=true`，
>    并在本机存在身份时隐藏 global/system config —— 于是 ② 这种 bug 在本机就能复现。
>    **这是本轮最有价值的一招**，以后"只在 CI 发生"的问题照此办理。
> 3. **红之前先看 `# pass/fail`**：本轮那次 `ENOTEMPTY ... .git/objects/pack` 是**555 个断言全过、
>    job 仍然红**——红在测试自己的收尾（git 后台帮手还在写 pack）。`force: true` 不重试这种情况。
>    已加 `removeTree()`（三个会跑 `git clone` 的测试文件）；**新增"真 git"测试请照抄它，不要直接 `rm`**。
> 4. **批量改写会咬到自己**：我用正则把 `await rm(x, {…})` 全局换成 `removeTree(x)`，把**帮手自己体内**
>    那次 `rm` 也换掉了 → 无限递归 → 测试数从 555 掉到 526。**改写前先保护被改写的那段代码**，
>    改完看 `# tests` 的总数有没有掉。
> 5. **活体验证仍然必要**：决策 148 的三段（写入 → 结算提交 → 推送 → 账本 CI 绿；以及分叉时的
>    rebase）都是在**活进程 + 真远端**上验的，测试里也有对应守卫。别再重复验一次，但也别只看测试。
> 6. **改插件代码 = 换进程**（决策 123）：`link:` 进来的包代码缓存在进程里；**改完必须重启 DSH**，
>    只改配置才是热的。本轮重启后按设计生效（`[store]` 注入行回来、结算提交按预期出现）。



接手者可能不共享任何对话上下文，因此：

- **所有结论都必须能从 `DESIGN.md` / 本文件读出来**。如果发现某个决定只在对话里存在，
  那就是文档的 bug——**请补进 `DESIGN.md`，而不是依赖记忆**。
- `DESIGN.md` 里的"**修正记录**"是刻意保留的：它们记录了曾经走错又走回来的结论。
  **不要删掉它们**，否则下一个人会重犯同样的错（见 §7 的表）。
- 用户会直接纠正你，而且经常是对的。被纠正时：**当场改文档 + 留修正记录**。
> **宿主拒绝 schema 时是"静默不激活"（2026-10-16 真机再遇一次，值得记）**：日志只会出现
> `dsh: warning: 1 entry did not activate dsh-jira (@uitstalie/dsh-jira): JsonSchemaError: ...`，
> 随后**该插件整行不加载**（工具全都不出现），但 **boot 不会失败**。本轮那次的原因是
> `dist/` 是**旧构建**（决策 110 之前的属性级 `required: true` 形态）。**排查顺序**：
> ① 看告警原文里点名的 schema 路径；② 确认 `dist/` 是**刚构建**的（`pnpm build`，必要时先删 `dist/`）；
> ③ 跑 `src/plugin/schema.test.ts`（把宿主的 `allowedFor` 规则镜像了过来）——
>    它会在本地抓住这类写法，不必等宿主报警。
>
> **并且：改插件代码后，"重载"是不够的——必须换一个进程（2026-10-16 实测）**。宿主把
> `link:` 进来的包 **缓存在进程内存里**，live 重载只是**用缓存里的模块重新 apply 该行**：
> 于是 3080 那个从 10-15 09:13 起就在跑的进程，今天改 patch（10:41）与在 GUI 里开关插件
> （11:04）都会重复报同一个 schema 错——**报错点名的行号（`dist/plugin/index.js:96`）在
> 新构建里根本不是注册调用**，这就是"跑的是旧模块"的铁证；同一个 profile 用**新进程**起来
> （本机曾用 `--port 3090` 临时实例验证）则**零告警**。所以：
> * 改 **patch/配置** → live 生效；
> * 改 **插件代码** → 必须新起进程（重启，或另起一个实例验证）。
> **让插件代码热重载（2026-10-16 实测，建议每台机器都做一次）**
>
> `dsh-hmr` 的 `root` 是"模块监视根"，**base bundle 给 web profile 设的是 `root: []`** → 默认**只监视配置**。
> 于是"改完代码刷新页面"永远无效（宿主进程里的模块没变），必须重启——直到在 profile 的
> `cordis.patch.yml` 里把它纳入监视（**配置变更本身是热生效的，不需要重启**）：
>
> ```yaml
> - id: hmr
>   name: '@deepseek-ai/dsh-hmr'
>   config:
>     root:
>       - D:/dqc/dsh-plugin-multidevice-jira
> ```
>
> **验证手法（不依赖 GUI，值得复用）**：找一个插件在 `apply` 时会做的、**可观测且可恢复**的副作用
> （本插件是 `ensureRemote` 指 origin）→ 先把它改成错的 → 重新构建并 **触碰 `dist` 里的文件** →
> 若几秒内被自动纠正，说明模块被重载、`apply` 重新执行了。实测 **3 秒**。
> **新增的三个命令（2026-10-16，都在真机上验过）**
>
> * `jira lint [--json]` —— **结构合法性**，给 CI 用（退出码 1）：词表成员（status / issue_type /
>   priority / tags / kb_types）、**悬空引用**（issue→link、issue→`kb_refs`、KB→`issues[]`）、
>   读不出来的文件。**刻意不管策略**（"被阻塞却已认领"不报——一个乱报的 CI 会失去信任）。
> * `jira machines [list|label --name X [--note T] [--os O]]` —— 机器注册表 `machines/<id>.md`；
>   显示规则：有 label 用 label，否则 id 前 6 位（决策 91）。
> * `jira doctor` 现在多报两行：**决策 85 的两个量**（KB 扫描 p95 与 store 文件数，对照
>   200 ms / 5000 给"该不该上索引"的判定）。实测 p95 ~1–3 ms、文件 22 → 余量约两个数量级。
>
> **PowerShell 教训（本轮又栽一次）**：**不要把 `-replace` 直接写在 .NET 方法调用的参数位置上**
> （`[IO.File]::WriteAllText($p, "..." -replace "a","b", $enc)` 会被解析成 4 个参数而报
> "找不到参数计数为 4 的重载"，**而且不写文件**）。先把文本拼进变量，再调用。
> 同类坑已出现多次：here-string 直接当方法参数、`Write-Output` 混进返回值、双引号里写 `"` 。
> **提交绑定、tags lint、project（2026-10-16，真机验过）**
>
> * `jira verify-commit-msg <FILE>` —— hook 调的就是它：key 必须在**首行**（或 `[no-issue]` 在同一行），
>   每个 key 都要在账本里**存在**（issue ∪ 知识），`Merge`/`Revert`/`fixup!`/`squash!` 豁免。
> * `jira hooks [status|install|uninstall|prepare-commit-msg <FILE>]` —— 装的是 **Node 薄壳**，
>   调用同一个 CLI；既有 hook 改名 `*.jira-backup` 并**链式调用**（**运行期**判断，backup 后出现也算）。
>   解释器按 shebang 选：Windows 上被保留的 `#!/bin/sh` hook 用**安装时嵌进 shim 的 git 自带 shell**
>   （PATH 里没有 `sh`，而 `bash.exe` 是 WSL，跑不了 Windows 路径的脚本）。
> * **store 仓库已装好 hook**：`machines label` 之类提交是 `… [no-issue]`，issue 是 `DEMO-1: …`，
>   KB 是 `KB-1: kb create`（知识 key 也算存在）。要卸掉：`jira hooks uninstall --root <store>`。
> * `jira tags lint` —— 三段报告（≤1 次使用 / 缺 description / Dice ≥ 0.7 的相似对），**只报告**。
> * `jira project [list|bind --key P [--path DIR]|rebind --from A --to B]` —— `project.md` 不存 key。
> **CLI 的完整命令清单（决策 128，21 个；`src/surfaces.test.ts` 会与 tool 动词对比）**
>
> * issue 七动词：`get` · `new` · `update` · `switch` · `comment` · `link` · `assignee`
>   （tool 的动作名是 `get`/`create`/`update`/`switch_state`/`comment`/`link`/`assignee`；
>   `create→new`、`switch_state→switch` 是刻意的人话命名）
> * 多动作名词：`kb get|create|update|search` · `tags lint` · `project list|bind|rebind` ·
>   `machines list|label` · `hooks status|install|uninstall|prepare-commit-msg`
> * 运维与其它：`init` · `list` · `board` · `generate` · `sync` · `doctor` · `lint` ·
>   `verify-commit-msg` · `help`
> * 新增命令后请跑 `src/surfaces.test.ts`：它要求"每个 tool 动词都有 CLI 命令、每个命令都出现在 usage"。
> **烟测（2026-10-16 新增，建议每次动完就顺手跑一遍）**
>
> ```
> pnpm smoke                 # 对当前 store；也可 node scripts/smoke.mjs --root <store> [--keep]
> ```
>
> 三层：① **人类面**：真 store 上跑全部只读命令（list / lint / lint --keys / doctor / board /
> board --html / tags lint / project list / machines list / hooks status / kb search / get）——
> **一个字节都不写**（决策 38）。② **写入面**：把 store **克隆**到临时目录，在里面跑完整生命周期
> （new → comment → 真实状态流转 → assignee → kb create/update → `--kb-refs` 交叉引用 → 带
> resolution 关闭 → generate → lint → doctor → `lint --keys --compare`），**从不 push**。
> ③ **提交纪律**：先给克隆装 hook，然后只检查**装完之后新产生**的提交是否合规（历史提交不归它管）。
>
> 真机结果：**全绿**（30 步；含 `board.html` 2604 字符、自包含、无 script、无外链）。
> **注入行（决策 78/130，2026-10-16 落地并由真机验证）**
>
> 会话上下文里会出现一行 `[store] {n} projects · {m} knowledge · {k} open issues[ | read-only: {r}]`：
>
> * 注册名 `jira:store`、`PromptContext`（**不是** prompt section——计数变化会击穿 KV cache）、
>   `order 40`、**5 秒复用**、**空 store 注入空串**；provider 同步，故文本来自后台刷新的缓存（落后一步，零 IO）。
> * 项目口径（决策 130 修正）：**有 `project.md` 或至少一条 issue 的目录**才算项目；
>   `read-only` = **没有 remote** 的项目（§4.11）——`jira new` 建的项目没 bind 过，没有 remote，
>   所以本机那行现在是 `… | read-only: 1`。
> * 通过 `ctx.get('systemPrompt')?.context(...)` 注册：这是**可选服务**，宿主没有它插件照常加载。
> * ⚠️ **C10（未做）**：§4.11 的"无 remote ⇒ 拒绝写入"目前只有错误码与提示，**写路径并不真的拦**。
> **注入行的完整形态（决策 131，2026-10-16）**
>
> ```
> [store] jira · workspace → new project DPMJ on first write · 1 projects · 1 knowledge · 0 open issues | read-only: 1
> ```
>
> * 三段：**哪个账本**（store 目录名）· **这个工作区与它的关系**（§4.10 的解析结果）· **多大**，末尾按需 ` | read-only: {r}`。
> * 工作区来自 `AssembleContext.scope`——**scope 就是 agent**，于是 `session.header.cwd`（§2.5 的不可变原始项目路径）可读；缓存**按 cwd 键控**。
> * 解析永远**只读**（决策 38）：命中 `remotes[]`（优先 `upstream`）→ 复用；否则 `paths[]`；否则**派生** key（**从仓库名**，不是路径）；
>   无 remote → `owner-machine`（别的机器的 agent 只读）。
> * ⚠️ provider 是同步的：**会话里第一次 assembly 那行是空的**，几百毫秒后（后台扫描完成）才出现——这是设计内的"一步延迟"。
> * ⚠️ **C11**：解析出"未命中"后**只说要登记、实际不登记**；`jira new` 仍必须显式 `--project`。
> **写侧的"该拒就拒"（决策 132，2026-10-16）**
>
> 审计发现四件"该拒却静默处理"的事，都已改成拒绝，且 issue 与 knowledge **两条实体同一套规则**：
>
> * **未知 frontmatter 键**：以前读时警告、**下次写入就把它丢掉** ✗ → 现在写事务直接拒绝并点名（`unknownKeys`）。
> * **未知/未来 `schema`**：以前只警告，下一个写入者把 `issue/v2` 覆写成 v1 ✗ → 现在写事务拒绝。
> * **`STALE_REVISION`**：以前工具在**锁外**比 revision、CLI 连 flag 都没有 ✗ → 现在 CAS 在 `transact` **锁内**做，
>   不符时返回类型化 `STALE_REVISION`（附 expected/actual）；`--expected-revision` 是**全局 flag**，五个写命令都能用。
> * **身份串**：以前 `validateIdentity` 只看前缀（`agent:x` 也算合法 ✗）→ 现在 `agent:` 必须**四段非空**、`human:` 不得含 `|`，
>   并在**每个写事务**里校验 acting identity。
>
> 真机验证：`jira update <KEY> --expected-revision 99`（陈旧）→ 退出 1、文件未改；`--expected-revision 1` → 成功。
> **首次写入登记 + 异机拦截（决策 133，2026-10-16）**
>
> * **C11 已收口**：从没 bind 过的工作区，**第一次写入**就会登记成 project（派生 key、规范化 remote、
>   当前路径入 `paths[]`、policy/owner）——`jira new` 与工具 `create` 都**可以不给 `--project`**。
>   派生规则：仓库名首字母（`brand-new` → `BN`），重名追加数字（→ `BN2`）；读会话**绝不登记**。
> * **C10 已收口**：`assertProjectWritable` 接进工具写路径与 CLI 五个写命令。
>   判据：项目 `agent_write_policy: owner-machine`（**没有 remote**）且 owner 不是本机、且调用者是 **agent**
>   → `FOREIGN_MACHINE_READ_ONLY`（消息点名机器）。**人类照写、本机 agent 照写。**
> * 对现有用法的影响：**没有影响**——本机 agent 与人都能照常写；只有当一台机器去写另一台机器的
>   "无 remote 项目"时才会被拒（这正是 §4.11 要的）。
> **pull --rebase + 冲突标记 + 只读会话（决策 134，2026-10-16）**
>
> * `jira sync` 与插件的推送队列现在**先 fetch + pull --rebase（15 s 上限）再推**；**两边都动过**的 issue
>   会被打上 `conflicted: true` 并留一条评论（走正常写事务：加锁、提交、审计）。**rebase 停住 = 只报告、
>   绝不强制、也不推** —— 需要人工解决。
> * **只读会话**：原来认的 `DSH_READ_ONLY_SESSION` 是**宿主从不设置的假信号** ✗。真正的信号是
>   `agent.options.agentPreset`（宿主预设标签形如 `preset.readOnly`）——现在只读预设也会被拒写（读照常）。
>   注意这是插件**遵从会话意图**，不是沙箱拦（宿主插件在 workspace 沙箱之外执行，§2.5）。
> * `runGit` 现在支持超时（`{ timeoutMs }`），供 15 s 的 pull 使用。
> **认领租约（决策 135，2026-10-16）**
>
> * 认领 = 起租（`claimed_at` + `lease_expires_at = +2 h`，到秒）；释放 = 清租。
> * **活跃租约挡别人**：换人认领会拒绝，错误里点名持有者与到期时刻（多个 agent 并行时这就是"别撞车"）。
> * **过期可接管**：接管时写一条评论记录"谁的租约在何时失效"——这条评论**只在写事务里**产生（读路径不落盘，决策 38）。
> * **续租**：任何**会改动 issue 的写入**顺带续租；只延长、不缩短、**不动 revision**（租约是元数据），且不产生额外写入。
> * 注意：`lease_expires_at` 是**两个平铺标量字段**，因为 frontmatter 子集故意不接受顶层 flow map。
> * ⚠️ 仍缺：把"已过期、可重新认领"**显式渲染**给模型；`doctor` 也没有过期租约的报告。
> **会话块（决策 137，2026-10-16）**
>
> * `sessions/<session_id>.md`（`session/v1`）：**首次成功写入**时落一次，含 `tool`/`model`/`machine_id`/`started_at`
>   与**原始 `tool_evidence`**（决策 10：证据要记下来，不靠后来猜）。幂等：已有文件原样不动；记录失败**绝不**影响写入。
> * **收尾扫描**：会话创建时记 HEAD，收尾时 `git log` 出本次提交 → 每个被提到的 issue 加一条评论（短 sha + subject），
>   走正常写事务（加锁/提交 ✓）。水位线在 `$DSH_HOME/dsh-jira/session-scan/<id>.json`；整段有界且异常被吞。
> * **踩到的真 bug**：扫描自己产生的评论提交会被下一次扫描当成"会话碰过的提交"→ 无限自我循环。
>   现在**跳过纯评论提交**（`<KEY>: comment (rev N)`）；评论本身已经把"有人说过话"记在账本里了。
> **tag 注册表写入路径（决策 138 / 26，2026-10-16）**
>
> * 新增 `jira tag-create NAME --description TEXT [--alias A]`：写 `tags/<name>.md`（`tag/v1`）。
> * 规则：名字小写归一 + 必须 `lower-kebab`；**description 必填**（空的直接拒绝且不落盘）；
>   重名拒绝并**引用已有描述**；别名折叠去空。
> * 写出的形状与**既有读取方**（`loadTags`）严格一致 —— 测试断言的是 `loadTags` 深比较与
>   `lintTags` 不再报"缺描述"，而不是只断言文件存在。
> **每个 Bundle 的 index/log（决策 139 / 79，2026-10-16）**
>
> * `projects/<P>/index.md` + `log.md`、`knowledge/<域>/index.md` + `log.md` 现在都会生成；
>   生成集是**动态**的（路径来自一次渲染），plan/write/check 全部跟着走。
> * 根 `log.md` 的条数从 50 改成设计要求的 **100**。
> * 顺手修了两个"把生成物当输入"的潜伏缺陷：`isGeneratedInput` 此前把 `tags/index.md` 算进**源树哈希**；
>   知识域列举只挡 `index.md` 不挡 `log.md`（烟测抓到 lint 把 `log.md` 当条目解析）。
> * 记住：**烟测跑的是构建产物** —— 只改源码不 `tsc -p tsconfig.json`，烟测会继续用旧代码（这次就绕了一圈）。
> **工具声明与单调 guard（决策 141 / 84 / 96）——第 2 档收口**
>
> * `jira_list` 5 s + 恒可并行；`jira` 30 s + **白名单**并行（只有 `get`；无法归类 → 独占，fail closed）；
>   `jira_kb` 30 s（保守，不声明并行）。
> * 注册**恰好一个** `ctx.tools.guard`：写动作 + 不可写会话（只读预设 / 环境变量 / 子代理）→ 拒绝。
>   它是**单调**的——没有别的插件能强制放行（这正是设计选它的理由）。
> * 声明 `timeoutMs` 等于承诺转发 `exec.signal`（宿主文档原话），所以 `RunOptions.signal` 已接上。
> * 第 2 档（设计点名却完全没做的功能）到此全部完成。剩下：**第 3 档（人面中文）**与**第 4 档（便宜项）**。
> **第 3 档开工：人面中文（决策 142 / 55）**
>
> * 范围：**人面**中文（CLI usage/帮助/人面报告 · 生成物 · doctor/lint 人面输出）；**模型面**保持英文
>   （工具描述、错误码、JSON 键）。
> * 已做：CLI 帮助面（`USAGE` 重写 + 56 条 flag 说明 / 60 处）全部中文；命令**语法**保持原样（人要敲的东西）。
> * 工具：`scripts/i18n-human.mjs` —— 逐条**断言命中**，找不到就报错退出（静默漏改不可能）；
>   先 `--dry` 看数量，再真跑。后续片（CLI 运行时消息、生成物、doctor/lint 渲染）沿用同一套。
> * 待做：CLI 的运行时人面消息、`BOARD/README/index/log/tags/每 Bundle` 生成物、doctor/lint/board 渲染。
> **第 3 档第二片：CLI 运行时消息中文（决策 143）**
>
> * CLI 的结果行与用法错误共 35 处已中文化；key、状态名、路径、类型名等**数据**保持原样。
> * `scripts/i18n-tests.mjs`：把断言英文输出的测试也逐条断言地改过来。13 处失败全在"测试断言英文"，
>   没有一处是行为错——这也是这套脚本的价值：它逼你面对每一个改动点，而不是笼统地 sed。
> * 两个坑记下来：中文**不该**在全角括号前留空格（CLI 输出没有，测试也要去掉）；脚本第二次跑要能识别
>   "已经翻过了"（否则会误报找不到 ✗）。
> * 第 3 档还剩：生成物（BOARD/README/index/log/tags/每 Bundle）与渲染器（doctor/lint/board/kb）。
> **第 3 档第三片：渲染器 + 生成物中文（决策 144）**
>
> * 渲染器（doctor/lint/perf/tagsLint/keyset/machines/project/boardHtml）与生成物（BOARD/README/index/log/tags/每 Bundle）
>   的人面散文中文化；**诊断载荷**（Problem.message / lint finding / JiraError.message）保持英文——它们同时出现在
>   `--json` 与工具返回值里，属机器面。
> * **共享渲染器的拆分（本片最重要的结构）**：`renderIssueHuman` 与 `renderKbSearch` 同时服务人面与模型面 ✗ →
>   加 `locale: 'en' | 'zh'`，**默认 en**：插件调用点一字未改（仍英文），只有 CLI 传 `'zh'`；
>   脚本新增守卫**断言** `src/plugin` 里不含 `'zh'`。数据（key/状态/优先级/身份/时刻/链接类型）两语言一致。
> * 脚本：能替换的用断言表；**必须留下的英文**用 `LOCALE_PAIRS` **成对校验**（缺一侧即报错）+ `MUST_STAY_ENGLISH` 数据守卫。
> * 测试 532 → **536**；8 个测试文件 47 处断言改写；其中一处 `findIndex` 断言若不改形状会**恒真** ✗，已修正并补进表。
> * ⚠️ **同时修正 143 的夸大**：上一片声称「CLI 运行时消息已全中文」不成立 ✗（`unknown command/flag`、`jira init`、
>   `jira generate`、`jira hooks` 详情、`KB-1 created`、`N comment(s)`、`--limit` 提示、`/jira` 自身消息等仍是英文）
>   → 列为第 3 档第四片。
> **第 3 档第四片 + 分层守卫（决策 145）**
>
> * 补完上一片漏掉的 53 处人面文案：`cli/args.ts` 的解析器消息、`jira init`/`generate`/`hooks` 的散文、
>   `N 条评论`、`--limit` 提示、五个「未知的 … 动作」、`读不到 <file>`、`! machines-unlabelled`、
>   以及 `/jira` 的 21 处（帮助头、状态散文、子命令结果、命令自身的 description）。
> * **`args.ts` 搬进了 `core/`**：`/jira` 复用 CLI 的参数解析器，方向是 plugin → cli ✗ ——
>   新写的**边界守卫当场抓到**这条违例 ✓，于是把解析器（连同测试）移进 core ✓，两个适配层都从 core 拿 ✓。
> * 新增 `scripts/check-boundaries.mjs` 并接进 `pnpm check`：决策 108（绝不导入宿主包）+ 分层 +
>   §3.1 ①（只有 git 钩子 shim 与两个入口可直写 `console`）。它是**源码扫描而非解析器**，脚本头写明了这个取舍。
> * `scripts/i18n-tests.mjs` 加**重复键守卫**（JS 对象字面量会静默保留同名键的后一个 ✗，会让同文件第二张表悄悄取代第一张）。
> * **刻意保留英文的地方**（都不是漏网）：所有 `JiraError.message` 载荷（它们出现在 `--json` 与工具返回值里 ✓）、
>   `warning:` 前缀（后面接的是原样英文载荷 ✓）、`renderVerdict`（git 钩子诊断，有 `[no-issue]` 逃生门契约 ✓）、
>   以及 `machine-unregistered` 这类**稳定标识符**（句子中文、token 保留 ✓）。
> **SystemAdapter + 两个真 bug（决策 151，2026-10-17）**
>
> * 起因就是你说的那件事：Fedora 修完 Windows 红、Windows 修完 Fedora 红。这次的真因是
>   `node:os.devNull`（Windows 上的 `nul`）被当成「空配置文件」—— Windows 的 git 之后每条命令都
>   `fatal: unable to access '//./nul': Invalid argument`，于是两条会话收尾用例稳定红（CI 绿、本机红）。
> * 新增 `core/system.ts`（SystemAdapter）：平台**事实**与**纯派生**只住在这里，规则是
>   **凡是行为依赖 OS，就只能是它的成员**。已收编 `runGit` 的子进程环境（剥掉 `GIT_DIR` / `GIT_WORK_TREE` /
>   `GIT_INDEX_FILE` 等）、`git init` 的配置表、`normalizePath` / `samePath`、`kbstore` 的 os、插件 origin、
>   钩子解释器、测试清理退避。
> * 它**故意不是上帝类**：不持有 store、不做 IO、不跑 git；所以 `systemFor('win32')` / `systemFor('linux')`
>   能在**一台机器上同时跑两个平台的规则**（9 条用例）。以后「另一台机器才红」先来这里加一条用例，而不是去借机器。
> * 同一提交修掉两个真 bug：① `regenerateAndCommit` 把 `commitStoreWrite` 的**软失败**当成功（决策 148 的核心），
>   并加了跨平台可复现的回归用例；② 测试里的「空配置」从设备路径改成正空文件 + `GIT_CONFIG_NOSYSTEM=1`。
> * 刻意保留：钩子**脚本内部**仍读 `process.platform`（钩子运行时读自己所在机器，这是对的）。
> **双平台用例夹具（决策 152）**
>
> * `src/testing/bothPlatforms.ts` 的 `bothPlatforms(name, async (system, platform) => …)`：同一段用例
>   在 `systemFor('win32')` 与 `systemFor('linux')` 各跑一次 —— **不用借机器**就能让"只在一个平台成立"的规则变红。
> * 平台敏感函数改为可注入平台：`bindProject` / `rebindProject` / `renderProjects` 的 input 加 `platform?`，
>   `resolveWorkspace(..., platform)`。
> * `paths[]` 的比较从**字符串相等**改成 `samePath`（Windows 大小写不敏感、POSIX 敏感）。
> * 夹具第一次跑就抓到真 bug：`bindProject` 用了模块级 `system`（宿主平台）而不是按 `input.platform` 造的那个。
> * 新增用例在 `src/core/paths.test.ts`（4 条 = 2 个平台 × 2 组断言）。
> **System 模块化 + 范围扩大（决策 153）**
>
> * `src/core/system.ts` → **模块** `src/core/system/{types,paths,env,git,policy,index}.ts`。
> * 范围扩到"跨平台公共类"：路径（`normalizePath`/`toPosix`/`resolvePath`/`samePath`/`safeFileName`/
>   `exceedsPathLimit`/`approachesPathLimit`）、目录（`homeDir`/`stateDir`/`defaultStoreRoot`）、
>   git（`gitEnv`）、策略（写/删重试）。**参数里的路径**（`--root`）走 `resolvePath`。
> * **消掉一处已漂移的重复**：库根优先级原有两份实现（`core/config` 与 CLI），**CLI 那份丢了 `~/.dsh` 兜底**；
>   现在只有 `core/config` 一处，CLI 只负责把失败翻成中文。并加了启动长路径提示（决策 240）。
> * 收编时又抓到一个真错：`homeDir` 曾把"用户目录"当成 dsh 的家，而 dsh 的家是 `<profile>/.dsh`。已修。
> * 全仓只剩 `hooks.ts` 里**钩子脚本内部**读 `process.platform`（正确：钩子运行时读自己所在机器）。
> * 现状：577 测试全绿、build 0、烟测 33/33、boundaries 59 文件无违例。

## CI 额度（2026-10-19 夜）

用户要求临时关掉远程 CI（Actions 额度快用完）。两个仓库的 workflow 已 `disabled_manually`：

- 插件仓：`gh workflow disable ci.yml`（恢复：`gh workflow enable ci.yml`）
- 账本仓：`gh workflow disable ledger.yml`（恢复：`gh workflow enable ledger.yml`）

**关闭期间推送不会触发 Actions**，所以本地把关全靠：`pnpm check`（两个 tsc + 边界）、`pnpm test`（693）、
`pnpm check:text`、`pnpm build` + `pnpm check:build`、`node scripts/smoke.mjs --root <store>`（33/33），
以及账本仓的 `generate --check`。恢复 CI 后建议先跑一轮全量确认。
