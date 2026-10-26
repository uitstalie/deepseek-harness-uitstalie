# dsh-jira 设计备忘（讨论稿 v3）

> 状态：**讨论稿 v3**（82 条已确认决策）。 已做过**两轮**全文一致性自检：第一轮修正 22 处；第二轮针对决策 41–82 的落地（两路独立复核，修掉 P0 九条 / P1 十七条 / 排版四处）。 **唯一未验证的事实：§2.7 的 spike（tool 在 `dsh web` 里的可见性）——已降级为非阻塞**（§11.2）。 **已无暂停的话题**：KB 检索已定案（**不做向量、不做 RAG、不引入本地 ML 模型**，关键字检索直接扫文本； 见 §11.1、决策 37）——该案连同既有实现的审计已于 2026-10 完成。 本文所有 DSH 侧结论均来自**文档与清单文件**（`docs/**/*.md`、各包 `README.md`、`package.json`、`*.yml`、生成的 catalog）， 未读取任何 `src/*.ts` 实现。引用均给出路径与行号，便于复核。 本文档已迁入**插件源码仓库** `dsh-plugin-multidevice-jira`（两机路径不同：Windows 是 `D:\dqc\…`，Fedora 是 `~/桌面/dsh/…`；见 `HANDOVER.md` §5。GitHub 私有）。

---

## 1. 定位

DSH 已有的能力，决定了本插件不该重复造什么：

| 已有能力 | 作用域 | 为什么不够 |
|---|---|---|
| `todo_write` | 单会话，整体替换 | 换会话即失效；是"给自己的草稿"，不是台账 |
| `goal` | 单会话，单一 objective | 一个会话只能有一个目标 |
| `plan mode` | 人机协作状态 | 一次性 |
| `subagent` / `workflow` | 并行执行 | 不留下可追溯的分配记录 |

**本插件要解决的问题是「跨会话、跨项目、持久的任务台账」，价值有四条：**

1. **长期记忆** — agent 换会话、换项目后仍知道"答应过什么、还没做完什么"。
2. **工作队列** — 人可预先排入工作，agent 下次开工自行领取。
3. **审计** — 哪次会话、哪个子代理、何时把哪条改成了什么状态。
4. **认领语义** — 多 agent / 多机并行时"谁在做，别撞车"。

`project / issue / status / assignee / comment` 这套词汇只是**恰好合适**——人和模型都熟悉。这个定位直接推导出取舍：

> **不需要**：sprint 排期、权限模型、报表。（这些是**我的建议**，不是文档结论。）
>
> 但**状态机是可配置的**——见 §4.2 的结论修正：那属于你的领域模型， 不受 DSH 核心 surface 的"最小化"取向约束。

---

## 2. 事实基础（已核实的 DSH 扩展点）

> **核对基线（决策 98/157）**：本节的每一条结论，以及下文所有引用宿主 **源码 / 文档 / 告警原文** 的地方， 都核对于 **`@deepseek-ai/dsh-root@0.2.1-alpha.2`**（checkout 于提交「docs(goal): register the branch's known limitations (task39)」）。 宿主一升级，这些结论就可能不成立 —— **引用处的版本号是「这条结论当时对得上哪一版」的凭据**， 所以凡新增对宿主的断言，请就地标版本；改动时同步更新这一行（决策 98 的由来：曾经只写「查宿主源码确认」， 过一版之后没人知道那句还成不成立）。

### 2.1 插件如何被安装与加载

- 插件 = npm 包，声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`。 patch 是 YAML 数组，`insert` 若干 `{ id, name, config, disabled }` 行，`name` 是模块说明符（可带子路径，如 `pkg/tools`）。 → `docs/user/develop/basic/publish.md:13,20-44,56-64`
- 安装：`dsh plugin --profile <name> add <spec>`（转发给 pnpm）。首个 bundle 自动追加进 `dsh.profile.bundles`。 → `docs/user/develop/basic/publish.md:77-101`
- 分层顺序：各 bundle patch（按 `bundles` 顺序）→ profile 的 `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → `--patch` 覆盖层。 **后层整行覆盖 `config`（不深合并）**。→ `docs/user/develop/basic/publish.md:118-132`
- 开发期：`link:` 安装本地 checkout；`--patch` 可直接指向绝对路径的 TS 源码（源码运行时）。 → `docs/user/develop/basic/index.md:48-64`、`publish.md:80-107`

### 2.2 依赖与版本兼容

- DSH 官方包**已发布到 npm**：`@deepseek-ai/dsh-tools` 的 `alpha` tag = `0.2.1-alpha.2`，与本 checkout 版本一致（`publishConfig.access: public`）。 已核对 npm registry 元数据。
- **安装与启动都会校验 peer 范围**，与本运行时版本不符会被拒，需要显式登记 exact-version 豁免 （`plugin-manager` 的 `list_version_exemptions` / `set_version_exemption`，或 CLI `dsh plugin allow-version`）。 → `apps/cli/README.md`（Profiles 节）、`packages/boot/plugin-manager/README.md:66-75`
- 规则：**必须与宿主共享实例的 DSH 包同时写进 `peerDependencies` 和 `devDependencies`**；独立第三方依赖放 `dependencies`。 → `docs/user/develop/basic/publish.md:103`

> **已定（决策 63）**：peer 与 dev **同时钉当前宿主实际装的版本**——本机实测 `@deepseek-ai/dsh-tools` = **`0.2.0-rc.2`**； `engines` **跟随 DSH 自己的声明**：实测本机 DSH checkout 写的是 `node: "^22.19.0 || >=24.0.0"`（`dsh-tools` 自己不带 engines）。 **并且"换机器要重核版本"**：本机是 `0.2.0-rc.2`，而文档别处记的是 `0.2.1-alpha.2`（§11.2 待核）—— → **已查明（本轮）**：`0.2.1-alpha.2` 来自**第二个 checkout** `D:\dqc\deepseek-harness-uitstalie-dev`（分支 `cli-desktop`）；**正在跑 GUI 的是** `D:\dqc\deepseek-harness-uitstalie`（`master`，**0.2.0-rc.2**，用 `tsx` 直跑源码），全局 npm 装的也是 0.2.0-rc.2。结论见**决策 95**（peer 用同时接受两者的 range）。 决策 33 已定"部署机不保证有 gh"，**同理部署机也不保证版本一致**，所以 peer 范围必须按**那台机器实际装的**写。


### 2.3 Agent 能力注册点

| 能力 | 接口 | 依据 |
|---|---|---|
| Tool | `ctx.tools.register(defineTool({...}))` | `docs/user/develop/basic/tool.md:12-33` |
| Skill | `ctx.skills` 是 **provider 注册表**，接口 `{ name, list, get }` | `docs/subsystems/skills.md:30-51` |
| Skill（文件态） | `<projectRoot>/.dsh/skills`（rank 100）、`<dshHome>/skills`（rank 400） | `docs/subsystems/skills.md:64-77` |
| System prompt | `ctx.systemPrompt.section(...)`；**动态内容用 `PromptContext`**（cache-safe，仅在变化时记录） | `docs/subsystems/system-prompt.md:44-76,124-150` |
| 人类斜杠命令 | `ctx.commands.register({ name, description, input?, handler })`；handler **直接对 agent 执行，不产生模型消息**（零 token） | `docs/subsystems/commands.md:33-53,82-93`、`packages/interaction/commands/README.md:41,50-54` |
| Tool 延迟加载 | `ToolSchema.deferLoading: true` —— 注册但**不进入 prompt 装配** | `docs/subsystems/llm-streaming.md:672-683`、`packages/core/tools/README.md:240` |
| Tool 并发声明 | `isConcurrencySafe` —— **只有返回 `true` 才算并发安全，省略即独占** | `docs/subsystems/tools.md:71-80` |
| Tool 可见性范围 | `ctx.tools.restrict({allow?,deny?})`、`ctx.tools.schemas(scope)` | `packages/core/tools/README.md:83-85` |
| 插件配置 schema | `export const Config = Schema.object({...})`（**Schemastery**；原生 zod 未被文档认可用于插件 Config） | `docs/user/develop/basic/config.md:11-45` |
| 生命周期清理 | `ctx.effect()` / `ctx.on()`，注册即可逆 | `docs/cordis-primer.md`（Registrations are reversible effects） |

### 2.4 持久化：为什么不用 DSH 的存储服务

| 文档明确写明的短板 | 对本案的影响 |
|---|---|
| `storage-json`：**无跨进程写锁**，两进程写同一 unit 交错替换，last-completion wins | 多 agent / 多机并发直接失效 |
| `storage-domain`：**无数据迁移**，版本不符直接 reject | schema 必然演进，每次都要手搬数据 |
| `domain/changed` 仅**进程内**事件 | 无法跨会话/跨进程通知 |
| 不支持跨表事务、索引、多段 key | "查我的待办"要全表扫描 |
| 文档从未声明第三方插件可用（也未禁止） | 属未授权区域，随时可能变 |
| storage `root` **故意不给默认值** | 无约定可蹭，必须自定 |

→ `packages/storage/storage-json/README.md:141`、`packages/storage/storage-domain/README.md:146-148`、 `docs/subsystems/storage.md:47,126`、`docs/config-catalog.md:3203-3209`

**结论：自己管文件反而是文档支持度最高、依赖最少的路线**——我们需要的能力（版本化、跨进程锁、人可读、审计）恰好全是 `ctx.storage` 明确不提供的。

### 2.5 其他核实到的约束

- **`appendPluginRecord` / `PluginRecordMap` 明令禁止外部插件使用**：`packages/core/session/README.md:70` 明确"本仓库之外的插件也不得调用"。会话日志集成**只有** declaration-merge `SessionEventMap` 一条合法路径（`docs/subsystems/session.md:749`）。
- **`Workspace` 实体没有扩展槽**（`docs/subsystems/workspace.md:32-113`），"项目 ↔ 工作区"映射必须自存。
- **`SessionHeader.cwd` 是创建时不可变的原始项目路径**，`working-directory/change` 只改会话内有效目录、不改项目归属 （`docs/subsystems/working-directory.md:5,11`）——这是自动归属 project 的可靠依据。
- **上游没有任何 git-backed 记录存储**；`ctx.worktrees` 是实验性的、只管代码 checkout（`docs/subsystems/worktrees.md:5,11`）。
- `.dsh/` 约定由 `packages/uitstalie/`（本 fork 的私有包组）拥有，**不是上游扩展点**，不蹭。 → `packages/uitstalie/tool-dsh-store/README.md:29,33-37,59`
- **Host 插件代码在 workspace 沙箱之外、进程内执行**（`packages/boot/plugin-manager/README.md:31`）， 因此写 `$DSH_HOME` 下的自有数据目录不受文件沙箱限制。
- profile `web` 的 `patchReload: live`：**改 YAML 热重载，改 JS 模块需重启进程** （`packages/boot/plugin-manager/README.md:140`）。

### 2.6 重要：上游已有一个实验性的"任务板" —— `agent-team`

`packages/experimental/agent-team` 已经实现了相当接近 mini-Jira 的东西：

- 实体 `TeamTaskSnapshot { id(task-<n>), revision, subject, description, status, ownerId?, blockedBy[], writeScopes[] }`
- 工具 `team_task_create / get / list / update`，`update` 用动词枚举 `claim|release|edit|set_dependencies|complete|reopen|reassign|delete`（`docs/tool-catalog.md:2323-2488`）
- **CAS 并发**：每次变更存完整快照，`revision` 是 compare-and-set 值，过期即报 `TEAM_TASK_STALE_REVISION` （`docs/subsystems/agent-team.md:58,74`）
- Web GUI 投影：`SessionProjectionMap.agentTeam` 把非删除的任务广播给浏览器
- 完整的 Model Experience / Known Limitations / Agent Note 文档

→ `docs/subsystems/agent-team.md`、`packages/experimental/agent-team/README.md`、`packages/experimental/tool-agent-team/README.md`

**它的边界（也正是本插件的立足点）**：

| 维度 | `agent-team` | 本插件 |
|---|---|---|
| 作用域 | `TeamId` = 根 `session_id`，**单个会话树** | **跨会话、跨项目、跨进程、跨机器** |
| 持久化 | Session 日志（log-only 事件） | 独立 git 仓库 |
| 项目容器 | **无**（没有分组实体） | `Project` + 人类可读键 `<KEY>-<n>`（如 `DH-12`） |
| 评论 | **无**（只有 peer 消息） | `Comment` 实体 |
| 历史回读 | **无**（只有"当前值"） | git log（决策 42：**不另做** `events.jsonl`） |
| 查询过滤 | 弱（`status/owner/ready`） | 按项目/状态/标签/指派人 |
| 稳定性 | README 自述 "**Experimental prototype with no stability promise**" | 我们自主控制 |
| 跨进程 | "**concurrent processes over one Team are unsupported**" | lockfile 协调 |

> **设计姿态：不替代 `agent-team`，而是它的持久层。** 长期可以设想：`agent-team` 的板是"实时视图"，本插件的仓库是"总账"。 但 MVP 阶段两者**互不依赖**，本插件必须能独立工作。

**必须复用它的三个机制**（这些是上游用真金白银换来的结论）：

1. **CAS + `revision`**：每次变更存完整快照，`expected_revision` 不匹配即拒绝。别用 last-write-wins。
2. **id 永不复用**：耗尽时返回类型化错误（`TEAM_TASK_LIMIT` 的做法），不要回绕。
3. **声明完整结果 schema，渲染为紧凑 JSON**：上游 Agent Note **明确否决**了"返回无类型 JSON" （`.agents/notes/implemented/feature/2026-08-05-agent-teams.md:67-79`）。

**还要注意它踩过的坑**：

- "**No automatic ownership release**" —— 不活动、被中断、进程退出都**不会**释放 owner。 所以"认领"必须有显式的 lease/超时设计，否则任务会永久卡在某人名下。
- "**Advisory write scopes**" 而非锁 —— 上游明确拒绝了把 owner/writeScopes 当互斥锁： "外部写者会绕过它、崩溃的 owner 会永久持有、路径前缀重叠无法证明语义独立。 **虚假的互斥比显式警告更危险**。" 这条判断我们要继承。
- "每个变更把完整看板（含描述）广播给每个浏览器" —— 描述变长后 token/带宽成本失控。我们不做广播式投影。

### 2.7 关键技术风险：tool 在 `dsh web` 里到底可不可见

> 🧪 **真机实测（2026-10-15，本机）**：① `dsh plugin --profile web add D:\dqc\dsh-plugin-multidevice-jira` → **`link:` 安装**（零依赖，全程未联网）；② profile 补丁里 `insert` 一行 → 用 **dev（0.2.1-alpha.2）** checkout 起临时实例（3082）：**stderr 完全干净、行激活成功**；③ 首次尝试因 schema 方言写错（决策 110）只出现 `warning: 1 entry did not activate` 而**不阻断启动**。→ **决策 101 的"可见 + 坏行只 warning"从推断变成实测。** **④ 重要细节**：`dsh plugin add <路径>` **自己就会把包加进 `dsh.profile.bundles`**（因为包里声明了 `dsh.bundle.patch`）——所以**不需要**手工再往 profile 补丁里 `insert` 一遍；两处都写同一个 id 是"同一行两个来源"（实测无害，但违反单一来源，已清理为由 bundle 层提供）。 **⑤ 人类会话验证（2026-10-15）**：用户在 **3081（dev / 0.2.1-alpha.2）**的真实会话里确认——**`jira_issue` 工具可见、`get DEMO-1` 成功**，返回的字段（key / summary / status / priority / project+type / revision / tags / reporter / assignee / created+updated / 正文）与我们实体逐项一致。→ **决策 101 至此闭环：设计（宿主平面 insert）→ 真机加载（3082/3083 两版干净）→ 人类可用（3081 实测）。**

> ✅ **已结案（决策 101，只读源码探索）**：**用 patch 装的插件在 `dsh web` 里会被加载**——`dsh web` ≡ `dsh --profile web`，与其它 profile **走完全同一套 loader/patch 流程，没有任何 surface/kind/包名过滤**；条件是**包的 bare specifier 可解析**。且 **profile 补丁在 web bundle 的 `disabled: true` 之后应用**，所以 insert 一个**全新 id 不会被那些 disable 影响**，注册进 global 层后**所有会话（含 `minimal`）都可见**、单行可按 id 开关、坏行只 warning。**"preset-plane gate" 不是运行时闸门，而是仓库级 CI 不变量**（`scripts/verify-cordis-config.ts:139-166`"一个 row 只能属于一个平面"，只约束随仓库发布的文件）。**结论：走 ①，且做成 bundle 包**；preset（②）只在"明确要按 preset 分配能力"时才用。下面保留**原始的风险分析**作为决策过程的记录。

> **③ 已解决（决策 96）**：读当前会话的谱系不需要绕——**`exec.agent.session.header`** 直接给出 `origin` / `parentSession` / `delegationDepth`（权威判据是 `@deepseek-ai/dsh-subagent` 的 `delegationDepthOf(agent)`）。→ **"subagent 只读"可以落地**，唯一限定是"进程外 subagent provider 不受拦截"。
>

这是全案最大的不确定性，文档给出的是一幅**有裂缝的图景**：

- **一方面**：`packages/bundle/web-app/README.md:103` 说 "base 把 per-agent 的 tool 行**在这里禁用**， 由 preset roster 接管"；`packages/boot/plugin-manager/README.md:33` 印证—— "没有 agent preset 的部署才在 profile patch 里启用；**preset 驱动的会话用的是它自己 preset 里的那一行**"。
- **另一方面**：官方入门教程就是往 profile 层 `insert` 一行，然后 `pnpm dsh web --patch ...` 工具就可见 （`docs/user/develop/basic/index.md:48-64`、`tool.md:42-46`）。
- **机制上**：`packages/preset/agent-preset-registry/README.md:56` —— "Plugin registrations inherit the preset scope, and the Agent scope's parent link controls visibility"。 即**宿主层注册的 tool 属于全局 scope、沿父链可见**；preset 行只在显式 `ctx.tools.restrict({allow,deny})` 时遮蔽。

> **① 的回退已定（决策 97，用户裁定）**：「**如果实在不行的话，转内置插件，然后看情况合并到 dev 去得了**」——即 patch / `insert` 若在 `dsh web` 里不可见（或要靠**冻结 preset roster** 才能可见，而那是每次 DSH 升级手工同步上百行的代价），就**把 `dsh-jira` 做成内置插件放进 fork**（`-dev` 仓），走仓库自己的构建与加载，稳定后再决定是否并回 dev。
>
> **① 的机制证据（本轮自读，rc.2）**：可见性 = **沿 scope 链的祖先贡献**。`packages/bundle/headless/src/index.ts:334-337` 的注释是直接证明——"This bundle composes no preset roster, so **the model-facing rows sit in the host plane and the agent reads them from the global layer**"。而宿主平面/agent 平面的**归属判据**写在 `.agents/notes/implemented/architecture/2026-08-10-host-plane-ownership-after-presets.md:9,19,39`：宿主平面 = 有 realm 之外的读者、或注册目标进程级；其余每会话一份的能力归 agent 平面。shipped preset（如 `presets/standard.patch.yml`）**只列自己的 `plugins`，不设 allow-list**，所以宿主平面的新行不会被遮蔽。
>
> **唯一的残余不确定**：`web-app/cordis.patch.yml:543` 提到一个"**preset-plane gate**"，它"**reads declared row ids without regard to `disabled`**"（原文动机是让 `tool-ralph` 别落回宿主平面）。我的读法是"**被 preset 声明过的 id 会在宿主平面被抑制**"，因此**我们全新的 id（没有任何 preset 声明它）不受影响**——但**gate 的实现代码我没有找到**（全库搜 `preset-plane`/`presetPlane`/`agentPlane` 只命中注释与文档）。→ **置信度约 85%，剩下 15% 靠一次 10 分钟实测**（装一个只注册一个 tool 的最小 bundle → 看它在 `dsh web` 里出不出现）。**实测失败就按决策 97 转内置插件。**
>
> **这条回退很便宜，原因是分层**：`core`（纯逻辑、零 DSH 依赖）**两条路径共用**，外部插件与内置插件只是**薄适配层的两种宿主方式**——"转内置"换的是绑定方式，不是重写。
>
**四种放置方案与代价：**

| 方案 | 做法 | 优点 | 代价 |
|---|---|---|---|
| ① 宿主层 insert | patch 里 `insert: { id, name }` | 一行搞定、跟随升级、官方教程路径 | 若某 preset 用了 allow-list 就隐身（文档未说明） |
| ② 覆盖 `preset-standard` | 按 id 覆盖并**重述整个 `config.plugins`** | 一定可见 | **冻结 roster**：上游更新不会自动合并（`agent-preset-registry/README.md:99`），每次 DSH 升级要手工同步上百行 |
| ③ 新增自己的 preset | `insert` 一个 `@deepseek-ai/dsh-agent-preset` 行 | 不覆盖、不冻结 | 会话必须显式选它；默认 `standard` 里没有 |
| ④ **`preset:` patch** | `docs/architecture.md:25` 说存在"在 declaration 的 `config.plugins` 内施加操作"的 preset patch | 理论上正解：只追加、不重述 | **全仓库没有任何 YAML 示例**（文档只此一句散文），行为未经验证 |

> **行动项：做一个 20 行的 hello-tool spike，验证 ① 和 ④。** **不必先于业务代码**——它只决定**分发方式**，而分发已推后（§11.2）；但越早验越省事。 问题一：宿主层 `insert` 后，`dsh web` 会话里模型能否真的调用它？ 问题二：`preset:` patch 语法是否可用？ 这两个答案直接决定分发方式，属于"先验证再投入"的关键路径。
>
> **待核（Windows 机实测）**：本机 checkout 里**方案 ④ 的唯一出处 `docs/architecture.md:25` 不存在** （该行讲的是 `dsh-base` 各 bundle；`docs/**` 与 `.agents/**` 搜不到 `preset patch`）， 所以 ④ 在核对前**视为无依据**。详见 §11.2。

---

## 3. 分层架构（为"将来并入内置"留门）

约束：先独立仓库开发，日后可能并入魔改 DSH。据此分层 （**包结构已定案（决策 64）**：**单包多入口**——一个 npm 包内部三层目录，用 `exports` 暴露 `.`（DSH 插件）与 `./cli` 两个入口；边界靠 **AST 边界检查器**守住，抄上游 `enginev2_boundary_check` 的做法）：
> **为什么不是 monorepo（决策 64）**：三个包能带来"没声明就 import 不到"的硬边界，但代价是三份 `package.json`、 workspace 配置、构建编排与版本同步——而 `core` 目前**只有你自己用**（§3 的原始理由）。 边界改用**机器守卫**：一条 AST 检查（`core` 不得 import DSH、`cli` 不得 import 插件层），进 CI，退出码非 0 即违规。

```
dsh-plugin-multidevice-jira/   ← **单包多入口**（决策 64）
├─ src/core/        纯逻辑，零 DSH 依赖：实体模型、校验、状态机、文件存储、git 层
├─ src/cli/         纯命令行，零 DSH 依赖：人与 agent 共用同一命令（`exports: "./cli"`）
└─ src/plugin/      薄适配层：tool 注册 / skill provider / prompt 注入 / settings（`exports: "."`）
```

三条硬理由：

1. `core` 可脱离 DSH 单独测试，不需要启动 harness。
2. CLI 让 agent 有一条**不消耗常驻 tool 声明 token** 的路径（配合 skill 按需加载）。
3. **将来内置时 `core` 直接搬，适配层塌缩成 `cordis.patch.yml` 里的一两行 row**，迁移成本≈0。

副产物：适配层只依赖文档化 seam（`ctx.tools` / `ctx.skills` / `ctx.systemPrompt` / `ctx.settings`），

### 3.1 编码原则（决策 102，用户裁定）

> 原话：「1. 所有的内容**原子化、function 化**；2. **能组合就组合**，多使用 **data class**，多去复用组合，而不是自己写一堆东西；3. 原子化之后，后面可以很好地控制。」

把这三条落成**可检查**的规矩：

**① 原子化 + function 化**
- `core` 的每个能力都是一个**纯函数**：输入 → 输出，**不碰隐藏状态**（不读全局、不读 `Date.now()` / `process.env`、不碰文件系统）。
- 副作用**只**出现在边界：`core/io`、`src/cli`、`src/plugin`（文件读写、git 调用、进程、网络、宿主 API）。
- **一个函数只做一件事**，名字就是契约；宁可 10 个 5 行的函数，不要 1 个 50 行的函数。
- 时间、随机、环境一律**当参数传进来**（`at` / `machineId` / `newKey`）——这样才可测、可重放。

**② 组合 + data class**
- 领域实体一律是**不可变数据**（`readonly` 字段的 `type` / `interface` + 工厂函数），**不用类继承**；"改" = **返回新对象**（copy-on-write）。
- **组合优先**：小的纯函数**串成管道**，而不是让一个函数内联所有步骤。
- **不重复造轮子**：路径规范化、哈希、时间格式化、锁原语——用标准库或已有的原子。**YAML / frontmatter 解析是个例外**：决策 65 说的是"零 **native** 依赖"（理由只是跨平台产物），并未禁止第三方纯 JS 依赖；但"**拷贝包目录 + `dsh plugin add <路径>`**"的离线安装（决策 65）意味着**依赖也得跟着走**，于是"引不引第三方解析器"变成一条独立取舍（见 §11.6 的待定项）。
- 变体与词表**数据驱动**：状态机、优先级、resolution、`kb_types` 全部从 `config.md` 的词表读（§4.2），代码里**不硬编码分支**。

**③ 原子化换来可控性**
- 每个原子**可单独测试**（`node:test`、零依赖，决策 66）：只测纯函数，不启动 harness、不碰真仓库。
- 每个原子**可单独替换**：将来"转内置插件"（决策 97）只换适配层、`core` 一行不改——**原子化正是那条回退便宜的原因**。
- 组合关系**显式**：装配只发生在入口（CLI 子命令 / tool handler / hook），入口只做"取参数 → 调 `core` → 渲染输出"。

**依赖纪律（决策 108）**：`core` 不依赖宿主（决策 64），`plugin` **也不 import 宿主包**——它只声明自己需要的那点 ctx 形状。于是整包**零 host 依赖**，两台机器都能 `tsc` 构建、都能"拷贝式"离线安装；而"宿主漂移"由**真机集成测试**兜，不由编译器兜。

**形状示例（照这个写）**：

```text
// core：纯函数 + data class（无副作用、无隐藏状态）
type Issue = Readonly<{ key: IssueKey; status: Status; summary: string; revision: number /* … */ }>
function parseIssue(text: string): Result<Issue, ParseError>                                  // 解析 = 一个原子
function validateTransition(cfg: Vocab, from: Status, to: Status): Result<void, TransitionError>
function applyTransition(issue: Issue, to: Status, at: Timestamp, by: Identity): Issue         // 返回新对象
function renderIssue(issue: Issue, comments: readonly Comment[]): string

// 入口层才碰副作用
async function writeIssue(store: FileStore, issue: Issue): Promise<void>
```

**评审口径（以后 review 代码只问这三句）**：① 这个函数有隐藏状态吗？② 这段逻辑是在**组合**已有的原子，还是在**重写**一遍？③ 这个原子能**单独测**吗？ 天然满足"不依赖内部实现"。
> **给下一个人/agent 的工具注意（本轮踩了三次）**：用 PowerShell 批量改设计文档时，**`.Replace(@'...'@ -replace ..., ...)` 这种"把 here-string 直接当方法参数"的写法会失败**（PowerShell 会把它当 culture 参数）；而**在返回值函数里用 `Write-Output` 打日志会把日志行混进返回值**（本轮一度把 `src/plugin/index.ts` 写坏）。规矩：**先把 here-string 赋给变量再传**；**日志用 `Write-Host`**；每次批量改完**立刻 `tsc` + 跑测试 + 看文件首行**。

---

## 4. 数据模型（MVP，刻意做窄）

### 4.1 实体

```
Project:  schema: project/v1 · type: project · name · remotes[] · paths[]（纯缓存）· agent_write_policy · owner_machine?
          remotes[]              ← 身份锚点（规范化后的 git 远程地址，§4.10）
          paths[]                ← 本机路径，纯缓存，**不参与身份判定**
          agent_write_policy: 'shared' | 'owner-machine'   （§4.11）
          owner_machine?: <machine_id>
Issue:    key(DH-12)**（来自文件名！frontmatter 里不写 `key`，写了就报错——C3/决策 107）** · project · type: issue · issue_type（seed: task / bug）· status
          summary（一行，必填；渲染时当 OKF 的 title）· priority(S1–S5) · tags[]   （§4.2 / §4.14 / 决策 43）
          note?（自由文本，**可改写**：给下一个人/下一个会话留的当前提醒；与追加式 comment 分工不同，决策 51）
          resolution（**进入关闭集合内任一状态时必填**；决策 25）· resolution_note?（`limitation` 时必填）
          assignee: agent:<model>|<tool>|<machine_id>|<session_id> | human:<name> | null
          assignee_lease?: { claimed_at, lease_expires_at }            （§4.8）
          reporter: { model, tool, machine, session }              （§4.12）
          links[]   ← 固定闭集：related / duplicate / is_blocked_by / parent（§4.15）
          kb_refs[]  ← 引用到的知识条目 key（与 KB 的 `issues[]` 互为双向，§4.13／决策 75）
          revision（CAS 值；**初值 1，仅主体变更 +1**，§4.7）· conflicted?（真冲突标记，§5）
          created · updated
          # 正文（Markdown）= description，不设 frontmatter 字段（决策 43）
          # type      = OKF 文档种类（Issue / Config / Tag / 知识条目 type）——管"怎么校验"，强制小写
          # issue_type = 这是什么活（task / bug）——管"是什么"，强制小写（决策 45）
          # schema    = 本文件的格式版本，自描述：`issue/v1`（决策 46）。
          # 时间戳    = UTC + ISO-8601 到秒：`2026-10-15T08:30:00Z`（决策 47；工具与看板显示时转本地）
          #             各种类：project/v1 · comment/v1 · tag/v1 · machine/v1 · session/v1 · config/v1 · kb/v1
Comment:  id · author · body(md) · revision（**各自计数，初值 1**）· created_at   （append-only，可编辑不可删）
          # id 形如 `c-<machine 短码>-<n>`（短码 = machine_id 前 4 位 hex，n = 该机在此文件内的序号）——决策 68
Machine:  id = md5(os + currentUser + SN) · label? · first_seen · last_seen
Session:  id · machine_id · tool · tool_evidence · model · started_at · last_seen
Tag:      name（唯一 key）· description（必填）· aliases[] · created_by · created_at
```

> **注意：Issue 上没有 `parent` 字段**——层级走 `links` 里的 `parent`（§4.15）。
>
> **评论与事件怎么落盘（决策 42，已定案）**：Issue 上**没有** `comments[]` / `events[]` 两个字段—— 评论是**单独文件** `comments/<KEY>.md`（§4.4）；需要"记一条事件"的地方（租约过期、override 认领） **一律写成一条评论**；列表里的评论数**渲染时现算**，不落盘（读不写，决策 38）。 **MVP 不做 `events.jsonl`**（§4.5）。将来若真需要机器可查的审计流，形态必须是**每机一份** `events/<machine_id>.jsonl`——绝不能是一个全局文件，那又是一个共享可变文件、多机冲突热点。 **在 §11.6 的 A3 / A37 定案之前，不要照这一行实现。** **命名约定（决策 41）**：本文件以及所有落盘文件的**字段名一律 `snake_case`**； 代码内部用驼峰没关系，转换集中发生在 `core` 的编解码层。文档里仍出现的驼峰是**外部名字** （DSH 的 `deferLoading` / `PromptContext`、上游的 `writeScopes`、人的 `GitHub`），**不要改**。


### 4.2 状态机：单一全局 workflow，可配置流转

**两次结论修正（保留记录，避免以后绕回来）**

1. 早期版本写"一旦开始配置状态机，就是跑偏了"——**那是我个人的判断，不是文档结论**， 而且套错了位置：DSH 核心 surface 的最小化取向（`todo_write` 刻意最小、`goal` "intentionally absent"、 `plan` "soft guidance, not enforcement"）**不约束插件自己的领域模型**。
2. 我随后提出的"固定 category"**也不必要**。用户定下的前提是 **"暂时所有 project 共用一个状态机"**——而我要 category 的唯一理由是 "通用代码无法理解每个 project 各自的状态语义"，只有一个状态机时**这个理由自动消失**。 名字自由的风险也随之消失（单人操作，不会乱命名）。

**形态**

```
config.md                       # type: config（OKF Concept，store 内唯一共享可变文件）
  schema:      config/v1                          # 本文件格式版本（决策 46）
  issue_types: [ task, bug ]                      # 可配置，只增不删（**不是** OKF 的 `type`，决策 45）
  statuses:    [ { name, order, deprecated? } ]   # order = BOARD 分组顺序
  priorities:  [ S1, S2, S3, S4, S5 ]             # 严重程度，S1 最高；只增不删（§4.1 → 数据仓 config.md）
  transitions: [ [from, to], ... ]
  closed:      [ <name>, ... ]                    # 算作关闭的状态，驱动队列与归档
  resolutions: [ fixed, invalid, limitation, abandoned ]   # 关闭集合内一律必填（§4.16）
```

**所有"词表"集中在同一个文件**，因为它们性质相同：低频变更、只增不删、都由 git 版本化， 且都由同一套 CI 校验。将来若真要分而治之，`workflow: <name>` 字段已预留。

- **一个 `closed` 字段就替掉了整套 category**：`jira_list` 只显示不在 `closed` 里的， 归档只作用于 `closed` 里的。
- 所有 project **默认引用 `default`**；project 上的 `workflow: <name>` 是**可选**的—— 现在不用，将来想分而治之时零成本打开。

**演进模型（用户提出，关键收益）：只增不删 + 改边下线 ⇒ 零数据迁移**

- `statuses[]` **只增不删**——名字一旦从列表里删掉，老 issue 的 `status` 立刻变成非法值，CI 会红。
- **下线一个状态 = 摘掉指向它的边（+ 打 `deprecated: true`）**： 老数据仍然合法（CI 不红），新流转到不了它，BOARD 里单独归到"已下线"分组， 残留一眼可见、可手工处理。
- 因此**不需要任何数据迁移**——这直接消掉了 §2.4 里"storage-domain 无迁移"那类担忧。

**唯一一处"共享可变文件"的例外**

`config.md` 是全 store 共享且可变的，违反 §4.4「不设共享可变索引」原则。 **接受这个例外**，理由是：

- 工作流变更是**低频**的（与 tag / issue 的创建不同量级）
- 它**由 git 版本化**：冲突可见、可回退、可排查 （用户原话："反正你都是 commit 配置的，自己回退排查呗"）

**三条约束**

1. 必须存在 `default` workflow。
2. 非法流转**报错并列出当前状态的合法目标**，绝不静默接受。
3. **CI 校验**：出现不在 `statuses[]` 里的 `status`、或引用不存在的 workflow → 红灯。

**下线的表达方式（已确认）**：`statuses[]` 里的条目打 **`deprecated: true`** 并摘掉指向它的入边。
- 老数据**合法**（CI 不红）、新流转**到不了**、BOARD 单独归到"已下线"分组。
- 不采用"纯靠图结构推断不可达"（无法区分"故意下线"与"暂时没连边"）， 也不允许直接从 `statuses[]` 删除（那会把校验从严格降成警告，与 §5 的"写入侧严格"冲突）。

### 4.3 assignee 值域

```
agent:<model>|<tool>|<machine_id>|<session_id>   某个 DSH 会话（子代理记自己的 session_id）
human:<name>                                   人类（§4.9：git user.name，缺省用机器 label）
null                                           未认领
```

> **值域共用（决策 69）**：**`Comment.author` 与 `assignee` 用同一值域**——就是上面这三行的形式， 一个概念一套格式，解析 / 校验 / 渲染都只写一份。

Jira 里 assignee 是同事；这里 assignee 是 **agent 会话 / 子代理**。 这让"多 agent 认领"成为一等公民，而不是硬塞进评论里。

> **修正记录**：本节早期写的是 `agent:session:<id>` / `agent:role:<role>`， 那是引入 `tool` 与 `machine_id` 维度（§4.11、§4.12）**之前**的形式，已废弃。 **分隔符：用 `|`（决策 48）**。原形 `agent:<model>/<tool>/<machine_id>/<session_id>` 里的 `/` 与 模型名 / 工具名可能出现的分隔符冲突；改用 `|` 后**分量内禁止出现 `|`**（写入校验直接拒绝）， **因此不需要任何转义**，串仍然人可读。 ⚠️ 书写注意：`|` 出现在 **Markdown 表格**里必须写成 `\|`，否则会把表格切碎——本文档里的表格行已如此处理。 跨机器时只有 session_id 会撞，所以机器维度是必需的。

### 4.4 落地形态：**唯一权威的目录树**

```
<store-root>/                     ← 数据仓库的工作副本
├─ .gitattributes                 # ★第一个文件：* text=auto eol=lf + 评论文件 merge=union（§5）
├─ .gitignore                     # 派生数据（索引/缓存）不进版本（决策 37 已否掉向量）
├─ README.md                      # 人读的入门
├─ BOARD.md                       # 生成物：GitHub Action 在 push 时重写（§7.3）
├─ config.md                      # 词表：issue_types / statuses / transitions / closed / resolutions（§4.2）
├─ index.md                       # 生成物：根索引，列出所有 bundle（§4.13）
├─ projects/
│  └─ DH/                         # 一个 project = 一个 OKF Bundle
│     ├─ project.md               # 手写：name / remotes[] / agent_write_policy / owner_machine
│     ├─ index.md                 # 生成物：该 bundle 的 OKF 目录（渐进式披露入口）
│     ├─ log.md                   # 生成物：该 bundle 的变更史（由 git 生成）
│     ├─ issues/DH-12.md          # type: issue，frontmatter = 结构化字段，正文 = description
│     └─ comments/DH-12.md        # 追加式评论（声明 merge=union）
├─ knowledge/<domain>/            # 域名**小写 kebab**（决策 76）；每个域一个 Bundle（§4.13）
│  ├─ index.md                    # 生成物
│  ├─ log.md                      # 生成物
│  └─ KB-7.md                     # **文件名 = key**；`type` ∈ runbook / pitfall / howto / concept（决策 75）
├─ tags/
│  ├─ index.md                    # 生成物
│  └─ <name>.md                   # 一个 tag 一个文件（§4.14）
├─ machines/<machine_id>.md        # 一机一文件：label / first_seen（§4.11）
├─ sessions/<session_id>.md        # 一会话一文件：tool / model / 探测证据（§4.12）
├─ counters/<machine_id>.json      # ★每台机器只写自己这一份 → key 分配零冲突（§5）
├─ var/                        # 派生/缓存（**可重建**，已 gitignore；决策 73）
├─ _merge/                     # 归并映射表（`<UTC>-from-<machine_id>.md`；决策 94）
└─ .jira/                      # 本机锁目录（已 gitignore）
   ├─ lock                    # store 级短临界锁（决策 58）
   └─ locks/<KEY>.lock        # issue 级锁（决策 58）
```

生成文件的头部按**决策 79** 写统一 HTML 注释（`generated by dsh-jira | generated_at | source_tree | do not edit by hand`）——**"Action 或插件的本地生成路径"都可能产出**（决策 15/34）：

| 类别 | 文件 | 谁写 |
|---|---|---|
| **手写 / 工具写**（真相源） | `config.md`、`projects/*/project.md`、`projects/*/issues/*.md`、`comments/*.md`、`knowledge/**/*.md`、`tags/*.md`、`machines/*.md`、`sessions/*.md`、`counters/*.json` | 人、agent（经插件）、或 Action 的校验步骤 |
| **生成物**（可重建，别手改） | `BOARD.md`、`index.md`（根与各 bundle）、`log.md`、`tags/index.md` | GitHub Action / 工具 |

**关键结论：不设任何"共享且可变"的索引文件。**

> **生成物的头部与版式（决策 79）**
>
> 四个生成物统一头部（**HTML 注释**，渲染时不可见）：
>
> ```
> <!-- generated by dsh-jira | generated_at: 2026-10-15T08:30:00Z | source_tree: <hash> | do not edit by hand -->
> ```
>
> `source_tree` = 对"纳入生成的源文件集合"做**确定性哈希**（相对路径 + 内容 sha256，按路径排序后再哈希）—— **不依赖 git 命令**，因此离线可用，且能反映**未提交的工作区内容**。
>
> 版式（最小可用）：`BOARD.md` 按 `statuses[].order` 分节、行内标 `conflicted` 与"被阻塞"、已下线状态单独一节； **版式已细化（决策 87）**：`BOARD.md` 每状态一节（按 `statuses[].order`）、表列 `key\|summary\|priority\|assignee\|updated`、`conflicted` 标 ⚠️、被阻塞另起一节放最后、末尾计数行；`index.md` 只到"域/项目"层级、**不列单条**；`log.md` 最近 100 条带 key 的提交；`tags/index.md` 字母序 + 描述 + 次数；`jira board --html` 为 **P1**（共用同一份分组逻辑，不引模板引擎）。 `index.md` 列 projects 与 knowledge 域 + 计数 + 入口链接；`log.md` 只列**最近 100 条带 key 的提交**； `tags/index.md` 字母序 + `description` + 使用次数。
>
> 新鲜度断言两条：**CI 重跑生成后 `git diff` 必须为空**（决策 66）；`/jira` 体检比对 `source_tree`（决策 39）。

| 原本想放的索引 | 改为 |
|---|---|
| `projects.json` | 扫描 `projects/*/project.md` **派生** |
| `machines.json` | 扫描 `machines/*` **派生** |
| `sessions.json` | 扫描 `sessions/*` **派生** |
| `counters.json`（全局计数器） | **`counters/<machine_id>.json`——每台机器只写自己的文件** |

最后一条是重点：块分配（§5）如果把计数器放一个文件里，它立刻变成**唯一的 git 冲突热点**；

- `counters/<machine_id>.json` 的形态（决策 74）：`{ "schema": "counters/v1", "machine_id": "…", "next": 1, "blocks": [[1,100]] }`——**块大小 100**；`next` 是"已领到的上界"，`blocks` 记已领区间（便于审计与判断手里还剩多少号）；新 store 第一台机器从 **1** 开始，下一台机器从"全仓 counters 里最大块末尾 +1"继续（读全仓 counters + 拿 store 锁，毫秒级）。 拆成每机一份之后，**key 分配在 git 层面冲突面归零**，且完全支持离线创建。

**唯一真正的例外是 `config.md`**（全 store 共享且可变）——低频变更、git 版本化， 理由见 §4.2。

**为什么是"文件 + git"而不是别的**：git 友好（小 diff、可按 issue review）、 人可读可手改、**并行写不同 issue 天然不冲突**、GitHub 网页直接能看 diff 与历史。 （备选是纯 JSON，MD + frontmatter 胜在人能直接读改；真要严格 schema 时再由 CI 承担校验。）

**评论（已确认）**：单独文件 `comments/<KEY>.md`，**追加式**。收益有两层：

> **落盘格式（决策 68）**：每条评论由一行 **HTML 注释锚**开头，正文随后——
>
> ```markdown
> <!-- c-a1b2-1 | author=agent:deepseek-flash|dsh|<machine_id>|<session_id> | created_at=2026-10-15T08:30:00Z | revision=1 -->
> 正文（Markdown）
> ```
>
> - **id 带机器短码**（`machine_id` 前 4 位 hex）→ 两台机器离线各自追加，`merge=union` 后**零编号冲突**。
> - 注释锚在 GitHub 网页与编辑器里**都不显示**，人读到的就是干净正文；机器靠它寻址（编辑、`rev+1`）。
> - **可编辑不可删**：编辑 = 按 id 定位后改正文并 `rev+1`；删除会被写入侧校验拒绝（§4.4 定的语义）。
> - 极端情形（同一实例被离线复活后重号）：由 §11.5 的归并流程处理，不在这里发明机制。

1. 评论**不污染 issue 主体的 diff**——主体只承载标量字段，diff 干净好读。
2. 它是**专用的追加文件**，所以能在 `.gitattributes` 里单独声明 `merge=union`： **两台机器离线各自追加评论，git 自己就能合，零人工干预。** 若把评论塞进 issue 正文（同文件里既有标量又有追加），union 就用不上，冲突只能人工处理。

其余默认（如需改动请说）：评论**可编辑**（带 `revision`，学 feedback 的 `ifVersion` 协议）、 **不可删除**（append-only 才叫审计）。

### 4.5 审计轨迹：不自己实现，交给 git

每次变更一次 commit，message 结构化：

```
(agent:deepseek-flash|<tool>|<machine_id>|<session_id>)
DH-12: comment added
DH-15: created [task] 补齐 CLI 的 board 命令
```

于是（**已确认：把审计整体外包给 git，不自己造审计系统**）：

- `git log -p projects/DH/issues/DH-12.md` = 这条 issue 的完整变更史
- `git blame` = 追责视图：每一行是**哪台机器 / 哪个 tool / 哪次会话**改的
- `git show <sha>` = 某一次变更到底改了哪几行
- **`git revert <sha>` = 版本回退**（用户明确点出这是选 git 存储的关键收益之一）
- 人在 GitHub 网页改一次 → 自动成为一次 commit，进同一个历史

我们因此**不需要**实现：变更历史表、diff 算法、撤销逻辑、审计查询。

代价与边界（要认）：

- commit 数量多、粒度细（可接受，因为仓库是纯文本且小）
- 不能做 SQL 式复杂查询（"查我的待办"靠目录扫描，见 §4.4）
- **二进制/附件不适合进仓库**（见 §4.13 与 §11.1：只存引用，向量索引也是派生物）

**不做 `events.jsonl`（决策 42）**：需要事件时写成评论就够了。将来若真需要机器可查的审计流，形态必须是**每机一份** `events/<machine_id>.jsonl`（全局单文件 = 又一个共享可变文件），且只能出现在**写路径**上（决策 38）。

### 4.6 先例借鉴（逐子系统结论）

| 子系统 | 借鉴什么 | 不要借鉴什么 |
|---|---|---|
| **agent-team** | CAS `revision`、动词式 update、id 不复用、声明结果 schema、动词枚举的命名法 | 会话树作用域、广播完整看板、advisory writeScopes 当锁 |
| **goal** | **先读后改**：读回 `id + revision`，改时两者都要（`goal_id`, `revision`, `action`）；`blocked` 用"稳定错误码 + 自由文本说明"两段式；`/goal` 命令让人类操作**不消耗模型 token** | 单目标限制、"仅人类直连消息可创建/编辑"的权限收紧（对我们过严） |
| **schedule** | **唯一"宿主机级、跨会话、storage domain"先例**；也是唯一有**历史分页**的先例：`limit` 1–100、逆序、`before` 游标排他、`nextBefore` 仅在有更多时出现 | 它依赖 storage domain（我们已论证不用） |
| **todo** | 结果只回**计数**的低 token 渲染（`Updated todo list: N pending…`）；README 的 **Model Experience** 章节写法（What the model sees / Token effect / KV Cache effect） | **整体替换**语义——那是它"故意做窄"的结果，不是通用范式 |
| **plan** | 教训：把状态放进**文件**会被否决，理由是"会造出第二个持久化家园"（`.agents/notes/archived/simplification/2026-07-22-...:47-59`）——**反过来说，我们的整个卖点就是那个"第二个家园"，所以必须论证清楚为什么需要它** | — |
| **feedback** | 版本化评论协议：`ifVersion: null` 创建、用返回值版本编辑/删除、重复 put 视为 no-op、冲突返回 `version-conflict` + 当前项 | 它绑定到已定稿的 assistant 消息（我们的评论是 issue 级） |
| **workflow** | "选项拼错必须**大声杀掉脚本**，不能降解成一次普通的子代理失败" | — |
| **deliverables** | `present` 是**持久声明**，而 workspace-changes 只活在宿主进程内 —— 对照理解"什么该持久" | — |

**结果渲染建议**：声明完整 schema + 紧凑 JSON（学 agent-team）， 但"创建/更新单条"这类高频操作可只回计数式摘要（学 todo）以省 token。

### 4.7 并发控制：CAS（`revision`）

每条 issue 带 `revision: number`：**初值 1**（**不用 0**——JS 里 0 是 falsy，`if (rev)` 会直接踩坑），**只有"主体"变更才 +1**（frontmatter 与正文）。

**写入时 `revision` 是可选参数（已确认）**：

- 带了 `expected_revision` 而实际已变 → 返回类型化错误 `STALE_REVISION` **并附上当前值**， 让调用方重读重试，**绝不静默覆盖**。
- 不带 → 视为"接受当前状态"，直接写入（单人自用场景下这是常见路径）。

> **为什么仍必须保留 CAS**：文件锁只解决"同一时刻的写入交错"， **CAS 解决的是"两个 agent 基于同一份旧状态各自做决定"**——那才是并行 agent 真正的危险。

### 4.8 认领（assignee）必须有租约，不能永久持有

上游 `agent-team` 的明确教训："**No automatic ownership release** —— 不活动、被中断、进程退出都不会释放 owner"。 我们如果照抄，任务会永久卡在死掉的会话名下。所以：

- `assignee` 附 `claimed_at` + `lease_expires_at`（**不做心跳**，见决策 61 的参数）。 **参数（决策 61）**：默认 `lease_expires_at = claimed_at + 2 h`；**不另起心跳**，但**对该 issue 的任何写操作都顺带续租**（零额外写放大）； 过期只降级为"可重新认领" + 写一条评论，**不硬阻塞**。
  > **动作形态（决策 50）**：原 `claim` / `release` 两个动词**已合并成一个 `assignee`**—— 指向**自己**（`self`）= 认领并起租约；指向 **`null`** = 释放并清租约。
  >
  > **修正记录（用户订正）**：本节曾把认领说成"只有一个 agent 时它只是个标记"——**那个前提不成立**： 用户**确实会并行跑多个 agent**（多个会话、多个工具同时开工）。因此 `assignee` + 租约是**必需机制**， 不是可选装饰：它同时承担"别撞车"与"谁在做"两件事，而租约是为了避免任务永久卡在死掉的会话名下（上游教训）。
- 过期只**回给模型**"已过期、可重新认领"；**写成评论这件事只发生在写事务里**（决策 38/71 的规则：读路径不落盘，见 §5）。
- 但**不要**把 assignee 当互斥锁：上游的结论是"虚假的互斥比显式警告更危险" （`.agents/notes/implemented/feature/2026-08-05-agent-teams.md:67-79`）。 所以过期只是提示 + 可抢占，不做硬阻塞。

### 4.9 文档空白 → 我们必须自己定义（上游从未有过）

| 缺失 | 我们的定义 |
|---|---|
| 没有评论实体 | `Comment { id, author, body, revision, created_at }`，append-only、可编辑不可删 |
| 没有项目容器 | `Project { key, remotes[], paths[], agent_write_policy }`（§4.10、§4.11） |
| 没有人类可读 id 约定 | `<KEY>-<n>`（`agent-team` 的 `task-<n>` 是唯一近似） |
| **没有单实体历史回读** | git log 天然提供（决策 42：不另做 `events.jsonl`） |
| 没有跨会话查询 API | CLI 提供 `list / filter` |
| 没有 retention/归档策略 | **MVP 不做归档**：`archive/` 目录**不建**、阈值 N **不定**（决策 62）。理由：归档是"数据量大才需要"的优化，而目录树应当只反映**真实存在**的东西——建一个没有语义的空目录正是上游"写法与事实不符"的味道 |
| 没有跨进程协调 | 自建 lockfile，用跨平台原语（§5） |
| 没有认证/审计身份 | 单用户假设；`reporter` 记 `{ model, tool, machine, session }`（§4.12） |
| 没有知识库形态 | OKF Bundle + Concept（§4.13） |
| 没有结构关系词表 | 固定闭集 `link`（§4.15） |

### 4.10 项目识别：锚在 git 远程地址，不锚在路径

用户约定（已确认）：**一般每个工作区 = 一个 project**；但 project 会被复用， 尤其跨机器时"工作区内容没变，只是换了个位置"，**这种工作区必须有 GitHub / GitLab 之类的远程仓库**。

因此项目身份 = **规范化后的 git 远程地址**，不是本地路径：

```
规范化：git@github.com:uitstalie/dsh-jira.git
     →  github.com/uitstalie/dsh-jira
（统一小写、剥掉协议/认证信息/.git 后缀）
```

**解析算法**（**只在首次写入时登记新 project**；会话开启时只做只读解析，决策 38）：

1. 取该会话 `SessionHeader.cwd`（**创建时不可变的原始项目路径**，见 §2.5）下的 `git remote -v`。
2. 规范化 → 在**扫描 `projects/*/project.md` 派生的索引**（§4.4，不再有 `projects.json`）里按 `remotes[]` 查找。
3. 命中 → 复用该项目（**哪怕路径完全不同**，即用户说的跨机器/换位置场景）。
4. 未命中 → 用仓库名派生默认 key（大写、去非字母数字、截断），冲突则追加数字； 登记为一个新 project，并把当前路径 append 进 `paths[]`。
5. **没有远程仓库的工作区** → 无法跨机器识别。**已确认**降级为 `agent_write_policy: 'owner-machine'`（§4.11）：其他机器的 **agent 只读**，人类仍可改。

**key 派生**要稳：从仓库 basename 派生，不用路径、不用机器名。

> **`project.md` 的形状（决策 77）**：**`key` 只由目录名承载**（`projects/DH/`），frontmatter **不重复存**—— 两处不一致时"谁说了算"是只会出错不会加分的规定。字段：`schema: project/v1` · `type: project` · `name` · `remotes[]` · `paths[]`（纯缓存）· `agent_write_policy` · `owner_machine?`。
>
> **`remotes[]` 规范化完整规则**：**统一小写 + 去协议/认证/端口 + 剥 `.git` 后缀 + 保留 host 与完整 path** （GitLab 子组 `gitlab.x/group/sub/proj` 天然支持）；**多 remote 全部保留**（供 rebind 与镜像）， 但取**优先级最高**者作身份：**`upstream` > `origin` > 其它**——这条同时定下了原先挂着的 B21（fork 场景）。 `deepseek-harness` → `DH`；`dsh-jira` → `DJ`。允许多个 remote（GitHub + GitLab 镜像）都指向同一 project。

**多 remote 的取舍（fork 场景）**：一个 checkout 可能有 `origin`（你的 fork） 与 `upstream`（原项目）。**建议优先取 `upstream`**，这样"在 fork 里干活"和 "在原项目里干活"归到**同一个 project**；否则同一个代码库会分裂成两个 project。

> **状态（决策 77 已定案）**：`upstream` > `origin` > 其它作身份锚——原写"我的建议，尚未确认"，现已确认。 已核对：你当前 checkout **只有 `origin`、没有 `upstream`**，所以这条规则现在不影响任何东西（遇到 fork 再加）。

**remote 改名 / 迁移**：`remotes[]` 保留历史，另提供 `jira project rebind` 手动重绑。

**key 不可变**：创建后不可改（改了等于把 `DH-12` 全部重编号）；只允许改 display name。 派生撞车（`deepseek-harness` 与 `deep-harness` 都 → `DH`）时追加数字并打印提示。

> 附带好处：同一仓库在本机的两个 clone、或 `git worktree` 出来的副本，会**自动归到同一个 project**， 不需要任何手工配置。

> **修正记录（独立实例，§8 决策 35）**：本节的身份锚定（`remotes[]`）**只在"共享同一个 store 的机器"之间成立**。 若某台机器上是**从零建的空实例**，它看不到别处的 `projects/*/project.md`， 于是"同一个工作区"会在两台机器上各自登记成**两条独立记录**，`paths[]` / `remotes[]` 各写各的。 这不是缺陷，而是刻意接受的分叉；**代价是归并时没有可靠的自动依据**—— 只能靠两边是否写了同一个 `remotes[]`，或人工判断，才能把它们认成同一个 project。 因此归并必须人工，且两边都要保留来源机器（`machines/` + `reporter`）以便追溯。详见 §11.5。

### 4.11 机器身份与"仅本机可写"策略

**机器标识**（用户指定）：理论上有唯一 SN，但不便直接用，于是

```
machine_id = md5( os + '\0' + currentUser + '\0' + normalizedSN )
```

**存储与展示只用这个 hash，原始 SN / 用户名绝不写进仓库。**

> **归类**：`machines/` / `sessions/` / `counters/` / `tags/` / `knowledge/` 是**有意共享的审计数据**，留在 store 内（需要跨机可见）；只有"本机私有状态（machine-id）"与"可重建派生数据（索引/缓存）"才放到 store 之外或 `var/`。
>
> **规范化与文件位置（决策 73）** 取不到 SN 时的**回退身份文件固定在 `$DSH_HOME/dsh-jira/machine-id`——故意放在 store 之外**。 理由：store root 是可配置的（§5 决策 57 的 `root`），身份文件若跟着 store 走，**改一次 `root` 就变成"另一台机器"**， 而身份漂移会把自己的项目误判成"外来"→ 退化成只读（§4.11 早已警告过这条失败方向）。 同时确定两类派生数据的落点：**本机私有状态（不得随 store 走、不得进 git）→ `$DSH_HOME/dsh-jira/`**； **可重建的派生数据（索引 / 缓存）→ store 内的 `var/`（已 gitignore）**。 `machines/<machine_id>.md`（一机一文件，同样遵循 §4.4「不设共享可变索引」）登记 `{ id, label?, os?, first_seen, last_seen }`；`label` 由人写（"笔记本" / "工作站"），让看板可读。

**四个决定"稳定还是天天漂移"的工程细节：**

1. **`os` 只用平台，绝不带版本。** 用 `process.platform`（`linux` / `darwin` / `win32`）即可。 一旦把发行版或内核版本掺进 hash，**系统升级就会把这台机器变成"一台新机器"**。
2. **SN 在虚拟机 / 容器 / 受限权限下经常取不到。** 已确认不会跑在容器里， 但获取链仍要做全，按 **Fedora → Windows** 顺序： `/sys/class/dmi/id/product_serial`（Linux，常需 root）→ PowerShell `Get-CimInstance Win32_BIOS | Select SerialNumber`（Windows 10/11）→ **取不到就回退**为首次运行时生成并持久化的随机 id（`$DSH_HOME/dsh-jira/machine-id`）。 无 macOS，不需要 `system_profiler` / `ioreg`。
3. **首次算出后必须持久化。** 即使 SN 之后变得不可读、或用户名被改，id 也不该漂移。
4. **失败方向是安全的**：万一 id 变了，本机会把自己的机器级项目误判成"外来" → 退化为只读。 只是烦人，不会误放行。但**必须大声报出来**，否则用户会莫名其妙。

**写权限策略挂在 project 上：**

| 场景 | `agent_write_policy` | 其他机器的 agent |
|---|---|---|
| 有远程仓库（身份锚在 remote） | `shared` | 可写 |
| 无远程仓库（身份锚在本机） | `owner-machine` + `owner_machine` | **只读**，拒绝写入 |

拒绝时返回类型化错误（如 `FOREIGN_MACHINE_READ_ONLY`），并明确说明"该项目属于机器 X"， **同时给出如何改判的指引**（比如补一个远程仓库后重新识别）。

**这是工具策略，不是安全边界——而且我们接受这个边界。**（用户明确表态）

拦截点放在**工具层**，共三层：

1. **写入类工具 / CLI 命令直接拒绝**，返回类型化错误 `FOREIGN_MACHINE_READ_ONLY`， 并说明"该项目属于机器 X"。
2. **规则写进工具 `description`**，让模型事先知道有这么条规则。
3. **动态部分注入到读结果**：`jira_list` / `jira_issue` 的返回里带 `writable: false, reason: 'owner-machine:<label>'`。 工具 description 是**静态**的，而项目归属是**动态**的—— 所以"能不能写"必须在每次读的时候告诉模型，否则模型只能靠撞墙学会。

**bash 层绕过不防。** 用户原话："bash 层面那你非要绕过去我也没办法。" 插件是 Host 进程内代码、持有完整文件系统权限，任何能跑 bash 的 agent 都能直接改仓库文件。 这条规则防的是"agent 误改别的机器的项目"，不是"恶意 agent"。

**人类天然不受影响**：人走 GitHub 网页或本地编辑器，根本不经过插件， 所以"人类仍然可以改"自动成立，不需要任何额外机制。这正是把这条规则做在插件层而不是 git 层的理由。

**顺带增强审计**：有了 machine_id 与 tool，`assignee` 记为 `agent:<model>|<tool>|<machine_id>|<session_id>`，`reporter` 记为 `{ model, tool, machine, session }`。

> **在独立实例上（§8 决策 35）这条策略的形态不同**：那台机器上根本没有"别的机器的 project"， 所有 project 都是本机创建的，于是 `agent_write_policy` 实际恒为"本机可写"， 只读拦截在那台机器上**不生效**（也无害）。本节的作用域是**共享同一个 store 的多机**。 反过来，若将来把别处的 store 手工导入本机当参考，那些 project 才需要落到 `owner-machine` 只读。

### 4.12 `tool` 维度：谁在驱动这个 DSH

用户要求把"当前是什么工具在跑"记进身份：`agent:<model>|<tool>|<machine_id>|<session_id>`。

| 分量 | 取值 | 来源 |
|---|---|---|
| `model` | `deepseek-flash` 等 | agent 当前模型 |
| **`tool`** | `dsh` / `claude-code` / `trae` / `codex` / `cursor` / `unknown` | 探测链（见下） |
| `machine_id` | `md5(os + currentUser + SN)` | §4.11 |
| `session_id` | DSH 会话 id | `SessionHeader` |

**`tool` 探测链**（顺序即优先级）：

1. **显式配置 `config.tool`** —— 探测错了能人工纠正，这个口子必须留。
2. **外来工具的环境标记**： `CLAUDECODE` / `CLAUDE_CODE_ENTRYPOINT` → `claude-code`； `TRAE_*` → `trae`；`CODEX_*` → `codex`；`CURSOR_TRACE_ID` → `cursor`。
3. `DSH_*` → `dsh`。
4. 都没有 → `unknown`。

> **顺序很关键：`DSH_*` 必须放在外来标记之后判定。** DSH 自己的 bash 工具会给子进程注入 `DSH_*`；若先查自己， 被 Claude Code / Trae 拉起来的 DSH 会被统统误判成 `dsh`，这个维度就废了。

**三个实现要求：**

1. **每个会话只探测一次**，结果在**首次写事务时**持久化进 `sessions/<session_id>.md`（读路径只缓存内存，不落盘；决策 38）。否则后续 env 漂移会持续改写审计历史。
2. **同时记录原始证据**，如 `tool_evidence: "CLAUDECODE=1"`。探测错时这是唯一能定位原因的东西。
3. **身份串反规范化存储**（issue 里直接存完整串），这样 `sessions/` 被清理后审计串仍可读。 审计信息必须比会话记录活得久。

**已定（决策 56）**：`jira_list` 的返回里**一律**带上"我是谁"（`{ model, tool, machine, session }`）——不再是可选项。 让 agent 能自我解释"这条 issue 是谁在什么工具里改的"。成本几乎为零。

### 4.13 知识库（KB）与 OKF 规范

用户计划的知识库（原 `dsh-common-storage`）定位是**跨 OS 共享的 agent 经验知识** （"共享在不同 OS 上的经验知识"），采用 **OKF（Open Knowledge Format，Google）** 规范组织。 §5「跨平台硬约束」里那 12 条，就是这个知识库最自然的第一批条目。

**OKF 要点**（据规范与公开解读）：

- 一个知识点 = 一个 Markdown 文件（**Concept**）；一堆 Concept 放在一个目录里（**Bundle**）
- 正文纯 Markdown；顶部 YAML frontmatter，**唯一必填字段是 `type`**， 推荐 `title` / `description` / `resource`（外部资产 URI）/ `tags` / `timestamp`
- 两个保留文件：**`index.md`**（渐进式披露的目录）与 **`log.md`**（审计日志）
- **宽容消费模型**：消费方不得因缺可选字段、自定义 `type`、坏交叉链接而拒绝解析， 应退化为通用文档继续读取

**三处与既有设计的冲突及其解法：**

| 冲突 | 解法 |
|---|---|
| OKF 的 `index.md` 渐进式披露 vs 我们的 skill 机制 | **它们本来就是同一件事**：OKF"先读 index 再打开具体文件" ≈ DSH skill 目录只暴露 name + description、正文按需加载。**skill 不是额外要做的功能，而是 OKF 的 index 层在 DSH 里的天然实现** |
| OKF 的宽容消费 vs 我们"坏数据要吵" | **按侧分开**：写入侧 / CI **严格**（必填校验、CRLF/BOM、key 一致性 → 红灯）；读取侧 / 运行时 **宽容**（永不因一条坏记录让 agent 拿不到其余数据，坏记录单独标注）。这正是"严律守己，宽以待人" |
`log.md` 由 **Action 或插件的本地生成路径**从 git 历史生成（决策 15/34）

**KB 实体形态（已确认）**：

- 独立 key 空间（如 `KB-7`）；**无状态机、无 assignee/租约、无队列语义**——它不是任务
- 每条记录带**来源四件套**：`machine_id` / `os` / `tool` / `captured_at`（**必填**，决策 75）
- 与 issue **双向引用**：issue 解决时沉淀为 KB 条目；KB 条目被 issue 引用

> **加强（审计佐证，见 §11.1）**：来源字段**必填**——`machine_id` / `os` / `tool` / `captured_at`， 若来自文件再加 `source_sha256`。并且**禁止"事后猜来源"回填**：上游用启发式脚本给缺 来源字段的页面补来源，结果 **9 篇不同文档全部指向同一份 993 B 的 raw 文件**。 血缘是"跨 OS 经验"的核心资产，**它坏了这套系统的价值就坏了一半**。

> **为什么 Issue 用 `summary` 而 KB 用 `title`（刻意不统一）**：Issue 的 `summary` 是**任务摘要**（一行、给列表与看板， 渲染时当 OKF 的 `title` 用，决策 43）；KB 条目是**纯 OKF Concept**，`title` 就是 OKF 的推荐字段。 两者是不同实体、不同用途，**不要为了"看起来统一"而硬凑一个字段名**。

> **字段清单（决策 75）**
>
> ```yaml
> schema: kb/v1
> type: pitfall          # **闭集四值**：runbook / pitfall / howto / concept（进 config.md 的 kb_types，只增不删）
> # 没有 `key` 字段：**文件名就是 key**（`knowledge/<域>/KB-7.md`；C3/决策 107）
> title: 一行标题
> tags: [ … ]
> machine_id: …          # 来源四件套，**必填**（§11.1 审计：上游因缺这些而血缘不可信）
> os: linux
> tool: dsh
> captured_at: 2026-10-15T08:30:00Z
> source: raw/… | URL     # 可选
> source_sha256: …        # 来自文件时必填
> issues: [DH-12]         # 本条目由哪些 issue 沉淀而来
> ---
> 正文 = description（同决策 43）
> ```
>
> **双向引用**：KB 侧写 `issues: [DH-12]`；**issue 侧写 `kb_refs: [KB-7]`**（§4.1 的实体块已补该字段）。

> **域目录名（决策 76）**：**小写 kebab-case**（`^[a-z0-9][a-z0-9-]{0,31}$`），与 §4.14 的 tag 命名**同一套规则**， 禁中文 / 空格 / 大写——目录名同样受 §5 跨平台硬约束（大小写不敏感、需清洗）。 因为文件名跟 key 走（决策 75），原先要定的"concept slug 规则"**已经不需要了**。

> **写入侧校验的边界（决策 49）**：**未知 frontmatter 键 = 写入拒绝**（类型化错误 + 列出未知键），必填键缺失同理； **读取侧仍然宽容**（未知键不报错、降级继续读并标注）。这条把 §4.13 的两侧分工钉死： 写入侧严格是为了**不让拼错的字段名静默吃掉数据**，读取侧宽容是为了**一条坏记录不拖垮整库读取**。

**Bundle 边界（已确认）**：**方案一** —— 每个 project 一个 Bundle（含该项目的 issues）， KB 单独成 Bundle；且**全局 KB bundle 可能不止一个**（按知识域切分）。

**目录树以 §4.4 为唯一权威版本**，本节只补充 OKF 相关的部分： 每个 Bundle 都有 `index.md`（渐进式披露入口）与 `log.md`（由 git 生成）， `knowledge/<domain>/` 下每条知识是一个 Concept。

**由此推出一条必须遵守的设计原则：**

> **目录切分只有一个维度，而知识是多维的**（OS × 主题 × 类型）。 所以顶层 bundle 要**少而稳**——它决定渐进式披露的骨架； 多维分类交给 frontmatter 的 `type` + `tags`。 **目录只管"在哪找"，元数据管"是什么"。** 这是 OKF 的关键用法， 也是"分块做得好就易于扩展"的具体含义：新增一个域 = 新增一个目录 + 一个 `index.md`， 不动任何既有结构。

**issue 也是 OKF Concept**（`type: issue`）：OKF 只要求 `type` 必填、其余字段宽容， 所以我们的 `status` / `assignee` / `revision` 等字段可以自由叠加，两者不冲突。

### 4.14 标签注册表与"tag 爆炸"

用户明确指出：领域/主题靠**目录**切分，**跨域查询与关联靠 `tags`**； 但 tags 会**爆炸**，只能靠 agent 之间共用与复用。 所以 tag 必须是**带描述的注册表**（`name` 唯一 key + `description` 解释用途），而不是自由字符串。

**Tag 实体**（一个 tag 一个文件）：

```
Tag:  name（唯一 key，小写 kebab-case）
      description（必填：解释这个 tag 是干嘛用的）
      aliases[]（如 win → windows，供复用兜底）
      created_by: { machine, session } · created_at
```

存放 `tags/<name>.md`（`type: tag`），`tags/` 本身是一个 Bundle：

- **一个 tag 一个文件**，遵循 §4.4「不设共享可变索引」原则 → **两台机器离线各自新建 tag 也不会冲突**（若挤在一个 registry 文件里，必然冲突）。 `tags/index.md` 由 **Action 或插件的本地生成路径**生成（决策 15/34）

**关键简化：issue 的 `tags` 与 KB 的 `tags` 共用同一套命名空间，只有一份全局注册表。** 不要做两套机制——否则既难复用又难治理。

**为什么"必须有 description"能防爆炸**：描述是**复用判断的唯一依据**。 agent 要决定"用现成的还是新建"，只能看描述；没有描述它只能凭 name 猜， 于是宁可新建——**这正是爆炸的生成机制**。`aliases` 是第二道兜底。

**防爆炸的强制力放在工具层（已确认）**：

1. **`tag-create` 是独立动作，`description` 必填** —— 没描述的 tag 无法创建。
2. **打 tag 只接受已存在的 name**；未知 name → **报错**，并返回**最相似的 3 个候选**， 同时指引用 `tag-create`。多一步摩擦，但把爆炸遏制在源头。
3. `aliases[]` 作为第二道兜底（`win` → `windows`）。
4. **`/jira tags lint` 体检**：报告"只用过一次的 tag""没有 description 的""高度相似的一对"，
> **算法与阈值（决策 86）**：零依赖纯函数（alias 精确 → 前缀 → **Dice ≥ 0.5** 取前 3）；`tags lint` 三段报告，阈值 count ≤ 1 / Dice ≥ 0.7；**只报告不自动改**。 **只报告、不自动改** —— 合并决定权在人。

> 与 §4.11「只读策略放工具层」是同一个思路： **能在工具层便宜地拦住的事，不要指望靠纪律。**

### 4.15 关系：固定的 `link` 与开放的 `tag` 分工

用户提出的关键区分：

| 机制 | 性质 | 用途 |
|---|---|---|
| **`tag`** | **开放**（注册表 + 相似度提示 + 体检，§4.14） | **自定义聚合** OKF 概念；跨域查询与关联 |
| **`link`** | **固定闭集**（代码定义，不配置） | issue 之间的**结构化依赖与关联** |

**link 词表（固定 4 种；层级也走 link，不单设 `parent` 字段）：**

| link | 方向 | 是否存储 | 含义 |
|---|---|---|---|
| `related` | 对称 | 存（写任一侧即可，渲染时双向显示） | 有关联 |
| `duplicate` | 有向 | 存 | 与另一条是同**一根因** |
| `is_blocked_by` | 有向 | 存 | 被另一条阻塞 |
| `parent` | 有向 | 存（写在**子任务**上） | 指向父任务 |

**派生反侧**（不存、渲染时计算）：`children`（← `parent`）、`blocks`（← `is_blocked_by`）、 `duplicated by`（← `duplicate`）。

**这个分工同时解决两件事：**

1. **tag 不再承担结构语义** → 少一类爆炸源。结构关系数量有限， 而"关联/阻塞"这类词恰恰最容易被随手做成 tag。
2. **结构语义可被代码理解** → 队列、认领、看板能做真正的判断，而不是靠字符串猜。

**三条设计要点：**

- **只存单向，反向派生（关键规则）。** 有向 link 只写在语义的主侧，反侧在渲染/查询时派生：
  - `is_blocked_by` 只写在被阻塞方 → `blocks` 派生
- **`parent` 只写在子任务上 → `children` 派生（已确认）。** 子任务里写 `parent`；`children` 在 `BOARD.md` 与 `jira_issue get` 的输出里**渲染**出来。 机器层面保持单一真相源，多机离线零冲突；人该看到的地方（看板、工具输出）都看得到。

  两侧各存一份必然发散，且在多机下必然冲突。**具体冲突例**： 机器 1 把 B 挂到 A 下、机器 2 把 C 挂到 A 下——只存 `parent` 时改的是 B、C 两个文件， **零冲突**；两边都存则 A 的 `children` 必冲突。
- **`resolution` 仍然需要**（见 §4.16）。早期我判断"`duplicate` 变成 link 之后 `resolution` 就多余了"， **那是错的**：link 表达的是**关系**，resolution 表达的是**结论**，两者不是一回事。
- **落盘形状（决策 70）**：`links:` 是一个**数组**，每项 `{ type, target }`，例：`links: [{ type: is_blocked_by, target: DH-5 }, { type: parent, target: DH-1 }]`。形状统一、易校验、**保留顺序**；`type` 只能是闭集四种。**解除一条 = 删掉数组里那一项**（集合型冲突按 §5 走"并集 + 打 `conflicted`"）。
- **`link` 是闭集、加一种是代码改动**——刻意的摩擦，与"tag 开放"形成对照。

**`is_blocked_by` 是否拦认领（已确认，按使用者分）**：

- **对人类：只是一个标记。** 人直接改文件，插件拦不住也不该拦—— 与 §4.11「只读策略」完全同一个原则：**拦截只对走工具的那条路有意义**。
- **对 agent：显式拦截 + 显式覆盖。** `assignee`（认领到 `self`）默认**拒绝**并**点名缺哪一条**（哪个 key 还没关闭）； 提供显式 `override` 放行，并**写成一条评论**（审计"明知被阻塞仍认领"；决策 42）。 `jira_list` 把被阻塞的单独成组：可见、标 `not ready`。
- **CI 的职责界线**：只管**结构合法性**（`status` 不在 `statuses[]` 里 → 红）， **不管策略状态**（被阻塞却已认领 → 不报错）。否则 CI 会误报，慢慢就没人信它了。

### 4.16 `resolution`：完成时的结论（用户纠正后的形态）

**先记一次我的过度设计**：我最初把 `limitation` 理解成"原 issue 上的一个遗留事项记录"， 给它设计了 `status: open | resolved | wontfix` 生命周期、甚至"可提升为 issue"。 **用户纠正：`limitation` 是 issue/task 完成时的状态之一**，与 `fixed`、`invalid` 并列。 于是它回到最简形态——**一个 `resolution` 字段，不需要任何生命周期**。

```
resolution: fixed | invalid | limitation | abandoned   # 仅在进入关闭集合里的状态时才有意义（且必填）
```

| 值 | 含义 |
|---|---|
| `fixed` | 真正解决了 |
| `invalid` | **判断过了**：不是问题 / 不需要做（**重复 issue 也用这个 + `duplicate` link 表达**） |
| `limitation` | **有限地解决了**：技术债、缺依赖/权限/信息、明确遗留 |
| `abandoned` | **中止**：环境没了 / 不做了 / 优先级被砍——**与 `cancelled` 配对**（落地数据仓时按"关闭集合内一律必填"的读法新增，见本节修正记录） |

**为什么这个字段值得存在**：它是"**打折完成**"的唯一机器可读信号。 审计时能直接查出"哪些活是带着遗留关掉的"——这正是用户要的可发现性。 埋在评论里就只能靠人回忆，不是审计。

**`limitation` 不只是一个状态词**：它通常还需要一句**文字说明**留了什么尾巴。 所以 `resolution` 是"值 + 可选说明"，而 **`limitation` 时该说明应为必填**。

**取值可配置，关闭时必填（已确认）**：
>
> **重开时清空（决策 72）**：`switch_state` **离开关闭集合**时，把 `resolution` 与 `resolution_note` **清空**， 并**自动写一条评论**记下"重开前结论是 X"。理由：`resolution` 的语义是"这条关闭时的结论"， 带着它回到未关闭状态会让所有"未关闭"查询与看板**误读**；留痕交给评论 + git 历史。

- `resolutions[]` 与 `issue_types[]` / `statuses[]` **同源、同样只增不删**（用户：可配置，但基本固定）。 默认 `fixed | invalid | limitation`。
- **进入 `closed` 集合里任何状态时 `resolution` 必填**（读法 ①，见下方修正记录）， 必填是关键：不填就分不清"真解决"和"打折解决"，而审计价值全部落在那个区分上。

> **修正记录（2026-10，落地数据仓时定案）**：上面那句里的 "`closed`" 有两种读法—— ① §4.2 `closed[]` 那个**关闭集合**；② 名叫 `closed` 的**那一个状态**。 只有一个关闭状态时两者等价，所以一直没暴露；**加入 `cancelled` 之后才分开**。
>
> **用户裁定读法 ①：关闭集合内一律必填。** 理由：让**每一条关闭记录都统一带一个结论字段**， 查询与审计口径一致——"为什么关的"永远在同一个字段里，不必先看状态再决定去哪找。
>
> **配套（不可少）**：`resolutions[]` **新增取值 `abandoned`**（中止：环境没了 / 不做了 / 被砍）。 若不给它一个新取值，`cancelled` 只能借用 `invalid`——而 `invalid` 的语义是"**判断过了**、不是问题"， 于是"中止"与"结论"又糊在一起，加 `cancelled` 这个状态就白加了。
>
> **被否掉的读法 ②**：新增字段 `resolutionRequiredIn: [closed]`，把必填绑到具体状态上。 好处是 `cancelled` 不必编结论；否决原因是**它给 config 引入一个只为单个状态服务的字段**， 而"每个关闭记录都有结论"这个统一性更值钱。

> **`is_blocked_by` 拦认领的规则属于 §4.15**（它讲的是 link 的行为），不在这里重复。

---

## 5. 存储、并发与 git

| 决策 | 方案 | 理由 |
|---|---|---|
| 真相源 | 本地 git 仓库，路径由 `root` 配置，默认 `$DSH_HOME/jira` | 文件即数据，无二进制、无迁移 |
| 备份 | `origin` → GitHub **私有**仓库，best-effort push | 离线不阻塞 |
| 并发 | 跨进程 lockfile（`.jira/lock`）+ 临时文件 + fsync + 原子 `rename` | 并行 agent 串行化写入，毫秒级 |
| key 分配 | **块分配**：在 `counters/<machine_id>.json` 里认领一段号（见下节） | 每机只写自己那份 → **git 层面零冲突**，且可离线创建 |
| 多机 | 各自 commit；`git pull --rebase` 只在显式 sync 或会话启动时 | 冲突粒度 = issue 粒度，冲突面很小 |
| 推送时机 | 后台队列，**防抖自动推 + 会话结束推**（已确认） | 避免噪音历史与频繁网络往返，同时保证跨机器可见性 |

### 两条禁令

1. **绝不在写事务里 push。** 网络延迟会长时间持锁，把 harness 卡住。
2. **绝不隐式 pull。** push 走后台队列；pull 只在显式 `sync` 或会话启动时做。

### 并发实现细节

- 锁失败要**有界重试 + 超时**，超时报错而非静默丢写。
- commit 前若检测到工作树被外部改动（用户手工编辑），先提交为独立 commit 再继续，不要 `checkout --force` 覆盖用户的改动。
- **写路径常量（决策 60）**：推送**防抖 500 ms**（之后入队；会话结束必推）；**原子写重试 3 次**（50 ms 起指数退避，仍失败报 `WRITE_FAILED`，**绝不静默丢写**）；**长路径预警 240 字符**（Windows 260 上限留 20 余量，超限在启动时就明确报错）。三者是**代码常量、不进 Config**（决策 57 的"只加按环境要调的键"）。
- push 失败（离线/无权限）**不是错误**，降级为"本地已保存，待推送"，并在下次 sync 重试。
- **`fetch` / `pull --rebase` 失败（无网络）同样静默降级**（**超时 15 s**，决策 84）：会话启动时的那次拉取**不得阻塞会话**，离线机器必须照常开工（§8 决策 34）。

> **并发画像（用户澄清）**：**单个人 · 多个 agent · 甚至可能同时在多台机器上**； 但**主场景是"一个人在一台电脑上同时跑多个 project"**（dsh / claude-code / opencode / trae 都支持这么干）。
>
> **直接后果**：**同机多会话 / 多进程是高频路径，不是罕见路径**——于是"锁粒度"从"可以后写" **升级为必须先定**（原 §11.6 的 B2）。一把 store 级锁会让"多个 project 同时干活"互相等待，而那恰好是主场景。

> **两级锁（决策 58）**
>
> | 锁 | 路径 | 保护什么 |
> |---|---|---|
> | **issue 级** | `.jira/locks/<KEY>.lock` | 单条的"读-改-写"（同一条被两个 agent 改时排队；不同条目**零等待**） |
> | **store 级** | `.jira/lock` | **只**保护 `git add/commit`、`counters` 分配、`config.md` 写入——**毫秒级临界区** |
>
> 两条纪律：① **取锁顺序固定**——先 issue 锁、再 store 锁（防死锁）； ② **持 store 锁期间绝不跑 LLM、不联网、不做长 IO**——上游"握着锁去等另一个要锁的人"的死锁就是这么来的（§11.1 反面教训）。

> **原语与参数（决策 59）**：用 **`mkdir` 作原语**（两个平台都原子，且不受 Windows 杀软/索引器持句柄影响）， 锁目录里放一个 **owner 文件**记 `{ pid, host, machine_id, at }`，供 stale 判定与"谁拿着"诊断； 默认 **stale 60 s**、**获取超时 10 s**、**100 ms 退避 + 抖动**——三个数都走 Config（`lock.stale_ms` / `lock.timeout_ms`，决策 57）。

### 人类编辑是一等公民

已确认"人需要看板，也不排除人上去修改"。这让三件事从"可选"变成"必须"：

1. **绝不丢弃人的改动。** 写事务前若检测到工作树有未提交改动： **先把它们作为一个独立 commit 提交掉**（作者保留为人类），再继续自己的写入。 任何时候都**不允许** `checkout --force` / `reset --hard` / `clean`。这是红线。 **落地记录（2026-10-17）**：本条此前**只有文字、没有实现**（§11.6/§11.8 也没把它记为缺口）。 现在由 `core/store.ts` 的 `adoptHumanChanges` 实现：`transact` 在**写入之前**、`regenerateAndCommit` 在**重生成之前**先收编脏工作区，作者用 `--author` 保留为人类（决策 146 的回退兜底）。见**决策 147**。
2. **每次操作都从磁盘重读，不维护长驻内存索引。** 人在 GitHub 网页或本地编辑后， 进程内缓存必然过期。这个量级下重读几十上百个小文件是毫秒级的事，用简单换正确。
3. **格式必须手改友好且坏数据要吵。** 用 Markdown + YAML frontmatter（而非严格 JSON）： **落地形状（决策 80）**：读结果里带 **`rejected: [{ file, reason }]`**——**只报文件名与原因、不回坏内容**， 同时在 `message` 里说明"部分记录被跳过"；写路径遇到同类问题**直接报 `INVALID_INPUT` 拒绝**（决策 49）。 于是读取侧**宽容但不静默**、写入侧**严格**，两侧分工彻底钉死。 人能直接读懂、改得动，且 diff 极小。但"宽容"不等于"静默吞掉"—— 载入时校验不合法的记录要**大声报错并跳过**（学 `agent-team` 的 `failure` 字段： 把被拒绝的记录摆在最后一个有效状态旁边），而不是当它不存在。

### 多机并发与 key 分配（跨机器场景的核心难点）

已确认多机。真正的冲突不在同一台机器（有 lockfile 串行化），而在**两台机器各自离线创建了新 issue**。 `max(现有文件名)+1` 在离线时会撞号。三种方案：

| 方案 | 机制 | 代价 |
|---|---|---|
| **A. 块分配（推荐）** | 每台机器在仓库里认领一段号（**形态见决策 74**：`{ schema, machine_id, next, blocks }`，块大小 100） | 号有空洞（Jira 也有）；块耗尽时才需要联网；两机同时耗尽块的冲突极少 |
| B. 创建必须联网 | `create` 前强制 `fetch + rebase` | 完全离线不能建 issue；但创建本就是低频操作 |
| C. 随机后缀 | `DH-a3f2` | 永远不冲突、完全离线，**但人读起来痛苦**，失去 `<KEY>-<n>` 的价值 |

**已确认采用 A（块分配）。** 必要才联网更新 store。 另外，因为 store 本身托管在 GitHub 上，**提交本身就顺带成为版本回退工具**—— `git revert` / `git show` 直接就是 undo，不需要我们再实现撤销逻辑（见 §4.5）。 所以日常高频路径（改状态、加评论）可以完全离线，后续 rebase 推送即可。

**推送前一律 `pull --rebase`**：因为远程可能被人类或另一台机器改过。 文件粒度 = issue 粒度，冲突面很小；真冲突时**保留双方并标注**，绝不自动择一。

### 跨平台（Fedora KDE ↔ Windows 10/11）的硬约束

已确认目标平台是 **Fedora KDE + Windows 10/11，无 macOS**。这带来十二条必须处理的坑 （1–4 是骨架，5–11 同样致命），任何一条漏掉都会让"git 仓库当数据库"在双系统之间崩掉：

1. **行尾必须锁死 LF。** Windows 的 `core.autocrlf` 会把文件检出成 CRLF， 于是同一份数据在两台机器上"每次都是全文件改动"，diff 全废、rebase 必冲突。 → store 仓库根目录必须有 `.gitattributes`：`* text=auto eol=lf`。 **这是要加进仓库的第一个文件，优先于任何代码。**
2. **Windows 没有 `flock`。** 不能照抄 POSIX 文件锁。 → 用跨平台原子原语 **`mkdir`（唯一原语，决策 59）**，配合 stale 检测（owner 文件记 `{ pid, host, machine_id, at }`）。**不用第三方锁库。**
3. **Windows 上 `rename` 不是可靠的原子操作。** libuv 走 `MoveFileExW(REPLACE_EXISTING)`， 当目标被编辑器 / 杀毒软件 / 索引器持有句柄时会**失败**。 → 原子写必须带**重试退避**，最终失败时**明确报错**，而不是静默丢写。
4. **大小写不敏感 + 保留字。** Windows 上 `DH-12.md` 与 `dh-12.md` 是同一个文件； 文件名不能含 `: * ? " < > |`、不能以点或空格结尾、长路径有 260 限制。 → key 一律大写；slug 必须清洗；目录层级保持浅。

5. **绝不用人类可读的 `git log` 输出做解析。** Windows 控制台可能是 GBK/CP936， 捕获到的输出还带 `\r\n`，中文 commit message 会乱码，解析结果随之错。 → 改用 plumbing：`git rev-list` / `git cat-file` / `--format` 配 **NUL（`-z`）分隔**。
6. **统一 UTF-8 无 BOM。** Windows 编辑器很容易加 BOM，一加就污染 diff。CI 里检测并拒绝。
7. **评论文件声明 `merge=union`。** 追加型冲突（见下文裁决规则）可以靠 git 自身 **零人工自动解决**——在 `.gitattributes` 里给评论文件加 union 合并属性。 **这让最常见的冲突类型直接消失**，是收益最高的一条属性设置。
8. **绝不把 store 放进 OneDrive / Dropbox / 网盘同步目录。** 云同步会与 git 争抢文件， 制造大量伪冲突。用纯本地路径。
9. **仓库内固定编码与模式**：`i18n.commitEncoding=utf-8`；Windows 侧 `core.fileMode=false`（无 exec 位，否则产生无意义的 mode 变更）。 **由谁写（决策 81）**：**插件在初始化 store / 首次写事务前幂等写入**这两项——**只补缺失的键，绝不覆盖用户已设的值**； 并在 `/jira` 体检里报告当前值。理由："能在工具层便宜拦住的事不要靠纪律"（§4.14 同源），而 Windows 上这两项**默认可疑**。
10. **凭据只依赖系统 git 配置**（SSH key / Git Credential Manager），**插件不存任何 token**。
11. **长路径**：Windows 默认 260 上限。启动时检测 store 根路径深度，超限直接报明确错误， 而不是在后面某次 rename 时诡异失败。
12. **路径不得从 `URL.pathname` 推导。** `pathname` 保持**百分号编码**，所以包一旦位于非 ASCII 目录 （如 `~/桌面/…`）下，解析出的路径**根本不存在**，而失败方式是**静默跳过**——最难发现的一类。 一律用 **`fileURLToPath`**。
    > **Fedora 侧实测抓获（2026-10-15 夜）**：包根目录正是这么算的，于是三个随包技能**全部被跳过**， 而工具列表与界面上**没有任何提示**（内部只有一条 `skipped`）。 Windows 的 `D:\dqc\…` 是纯 ASCII，**永远测不到**；**CI 也测不到**（runner 的检出路径是 ASCII） ——只有"构造非 ASCII 路径"的测试能守住，见 `src/plugin/skills.test.ts`。

> 这十二条不是"优化"，是**能不能跑起来**的问题。 其中 **1 / 3 / 5 / 7 / 12 最容易漏，且症状最难回溯**（分别是全文件 diff、 偶发写入失败、乱码导致解析错、冲突爆炸、**非 ASCII 路径下静默跳过**）。
>
> **跨平台行为只能靠 CI 验证**：GitHub Actions 加 `windows-latest` 矩阵跑同一套测试—— 在 Fedora 上无法验证 Windows 行为，这是唯一手段。另外 Action 里做 **CRLF 与 BOM 检测**， 这是防止行尾/编码污染扩散的自动防线。
>
> **CI 的具体形态（决策 66）**：测试用 **`node:test`**（Node 内置、零依赖），覆盖 `core` 的纯函数—— 状态机、CAS、校验、key 分配、扫文本检索；CI 跑**两条 job**： ① **`ubuntu-latest` + `windows-latest` 矩阵**跑同一套测试（跨平台只能这么验）； ② **产物与文档检查**：BOM / CRLF 检测、frontmatter 校验、**生成物重跑后 `git diff` 必须为空** （这就是决策 39 要求的"新鲜度断言"——上游正是因为没有它，`index.md` 陈旧两个月无人发现）。
>
> **落地状态（2026-10-15）**：`.github/workflows/ci.yml` 已提交。 **job ①** = `ubuntu-latest` + `windows-latest` × Node **`22.19.0` / `24`**。 下限必须实测、不能从 DSH 抄：`node --test` 跑 `.ts` 依赖 Node 自带的类型剥离， 这比抄来的 engines 范围年轻——Fedora 上验过 **275/275**（22.19.0 与 25.9.0 各一次）。 **job ②** = `scripts/check-text.mjs`（只用 LF、无 BOM）与 `scripts/check-build.mjs` （构建产物必须包含 manifest 声明的每个路径——正是 2026-10-15"没构建就装不上"的直接守卫）。 两个脚本都做过**变异验证**：拿掉 `dist` → 报 4 个路径缺失；注入 CRLF → 精确定位到行号。
>
> **首次运行（2026-10-15）**：5 个 job **全部 success**。随后把三个 action 升到当前大版本 （`actions/checkout@v7` / `actions/setup-node@v7` / `pnpm/action-setup@v6`）—— 原用的 v4 跑在**已被弃用的 Node 20** 上（GitHub 已强制改跑 24 并告警）。
>
> **job ② 的状态（2026-10-16 更新）**：**frontmatter 校验**与**生成物新鲜度断言**（决策 39）**仍然缺**， 但原因已经不同了——生成器**已经接线**： ` jira generate ` / ` generate --check ` 会写出并核对四份工件 ✓，
>
` doctor ` 也会报 ` generated-stale ` ✓，真机实测 ` generate --check ` 退出码 0 ✓。
> 缺的是**这两项属于 store 仓库的 CI，而 store 仓库现在根本没有 ` .github/ ` ** ✗（决策 66 把 job ① ② 给了本包， frontmatter 与新鲜度断言点名给 store）→ 已记入 **C12**。

### 时间戳与历史不可变：git 当审计的两个前提

**前提一：先后与时间以 git 为准，不信本机时钟。** 多机时钟必然有偏移。
> **格式已定（决策 47）**：所有时间字段一律 **UTC + ISO-8601 到秒**（`2026-10-15T08:30:00Z`，不带毫秒）。 理由：无时区歧义、**字典序即时间序**（`BOARD.md` 与列表可直接排）、跨机租约判定不会因时差误判； 人能读的本地时间由工具与看板**在显示时转换**，不落盘。 issue 里仍然写 `updated`（本机时钟，给人看），但**排序、"谁先谁后"一律以 commit 的拓扑顺序与 `committer date` 为准**。

**前提二：git 当审计的前提是历史不可变，而 force-push 可以重写历史。** 这不是理论问题，一次误操作就能让整个"审计轨迹"失效。两道防线：

1. **GitHub 侧给 store 仓库默认分支开分支保护、禁止 force-push**（最有效）。
2. 插件侧**检测到历史分叉或远程历史被重写时大声告警**，而不是默默 `reset` 跟随。

### 真冲突的裁决规则

CAS（§4.7）只能挡住**在线**并发；两台机器各自离线改同一条 issue，冲突会在 rebase 时暴露。 裁决要按字段性质分开，不能一刀切：

| 字段性质 | 例子 | 规则 |
|---|---|---|
| **追加型** | 评论（事件也是评论） | **合并双方**，谁都不丢 |
| **标量型** | status、assignee、priority | 以**较新的 commit** 为准，但**必须在 issue 上打 `conflicted: true`** 并在 BOARD 高亮 |
| **集合型** | tags、links | **并集**，同样打冲突标记 |

> 底线是**绝不自动择一后不留痕迹**。你在 GitHub 上看到高亮后手工定夺。

> **修正记录（§8 决策 35：独立实例不适用本节）**：本节裁决规则的前提是**两台机器共享同一个 git 仓库** （有远程、能 rebase）。但离线机上是**空的独立实例**——它们的 `DH-12` 是**两条毫不相干的 issue**， 没有共同祖先，任何"取较新 commit / 取并集"都无从判断，git 也帮不上忙。 所以跨实例归并**是人工程序**：插件只应产出**差异报告**（哪些 key 撞了、哪些 project 疑似同一个、 哪些评论与链接需要改写），**绝不做自动合并**。归并工具形态见 §11.5。

> **`conflicted` 的生命周期（决策 71，同时解掉 A35）**
>
> - **检测时机**：**只在 `pull --rebase` 之后或写事务内**判定并打标记——**读路径绝不写**（决策 38）。 这条把原先 A35 指出的"打标记就是写"与决策 38 的冲突彻底划清。
> - **打上标记后**：**读照常**；**写需要显式确认**——`update` / `switch_state` 必须带 `ack_conflict: true` 才改得动， **改完自动清除标记**（写操作本身就是对冲突的显式选定）。
> - 于是"标记不清就不许静默改"，而且标记**不会永久粘住**（那正是 A10 原本担心的结局）。

---

## 6. Agent 接口设计

### 6.1 三条路径的取舍

| 方案 | 常驻 token | 模型易用性 | 人机共用 |
|---|---|---|---|
| A. 一堆 tool（create/update/list/…） | 高（十余个 tool 声明） | 最好，schema 校验、UI 卡片 | 否 |
| B. 单 tool + `action` 参数 | 低 | 中，校验弱、易错 | 否 |
| **C. CLI + skill** | **0** | 中，需写 shell | **是** |

**已确认：以 C（CLI + skill）为地基，A 保留一小而必要的一组，并用 `deferLoading` 扩展。**

> **`deferLoading: true` 改变了 A 与 C 的性价比。** 工具的 `ToolSchema` 带 `deferLoading` 字段： 注册后**不进入 prompt 装配**，直到被显式加载 （`docs/subsystems/llm-streaming.md:672-683`、`packages/core/tools/README.md:240`）。 于是"工具数量"与"常驻 token"不再互斥——冷门能力也可以做成 tool 并 defer， 不必为了省 token 把它们全塞进 CLI。

**常驻 tool（3 个，schema 精简）**

| tool | 覆盖 |
|---|---|
| `jira_issue` | 单条读 / 写内容 / **切状态** / 评论 / 关系 / **认领**（7 个动词：`get` / `create` / `update` / `switch_state` / `comment` / `link` / `assignee`）（`action` 参数驱动；`expected_revision` 可选，§4.7） |
| `jira_list` | 按 project / status / tags / assignee / link 查询；兼任"我该做什么"。**排序分组（决策 53）**：先 project → 再 status（按 `statuses[].order`），组内 `priority` 升序（S1 最先）→ 同级按 `updated` 倒序；**被阻塞的抽出单独一组放最后**；`limit` 默认 20、上限 100，超限只给"还有 N 条"的计数 |
| `jira_kb` | 知识条目的 get / create / update / search。**search 返回（决策 54）**：每条命中给 `{ key, title, file, line, snippet }`——**片段旁必须带 `file:line`**（可回溯引用），片段封顶约 200 字；`top_k` 默认 10、上限 50；排序"标题命中优先 → 命中次数 → `updated` 倒序"；**绝不回整篇正文**（§6.2 的体积约束） |

> **`jira_queue` 已改名为 `jira_list`**：单人自用没有"派工队列"语义， 而议程注入也已被否掉（§6.4）——"queue"这个名字会误导。

> **参数与输出 schema（决策 82）**
>
> 参数名一律 snake_case（决策 41）；**输出三者统一带决策 56 的外壳**（`writable` + `me`），列表额外带 `counts` / `truncated`。
>
> | tool | 参数 | 输出 |
> |---|---|---|
`comment?{body,id?}` · `ack_conflict?`（顶层参数，决策 71 要求 `update`/`switch_state`/`comment` 都可能需要）
> | `jira_list` | `project?` · `status?` · `tags?` · `assignee?` · `link?` · `limit?` · `include_closed?` | `{ items, groups, counts, truncated, writable, me }` | | `jira_kb` | `action`(get/create/update/search) · `key?` · `query?` · `top_k?` · `data?` | `{ hits?, item?, rejected?, writable, me }` |

**defer 的 tool**：`jira_sync`、`jira_tag`、`jira_project`、批量查询与看板、历史回读、导出。

**仍走 CLI 的部分**：人机共用的批量操作、脚本化、离线场景。**逻辑只在 `core` 写一次**，
> **命令集合已定（决策 83）**：CLI 与 tool 的七个动词**一一对应**（`jira issue …`），另加 `list` / `kb` / 运维类（`board` `lint` `tags lint` `doctor` `hooks` `sync` `verify-commit-msg`）；`/jira` 只暴露**给人看的只读**子命令（`board` / `list` / `show` / `tags lint` / `doctor`）。 另有管理域命令（决策 91/92 引出）：`jira machines [list|label]`、`jira project [list|bind|rebind]`。 CLI 与 tool 都只是它的薄包装。

### 6.2 Tool 契约（逐条对齐上游文档）

| 事项 | 规定 | 依据 |
|---|---|---|
| 注册 | `defineTool` from `@deepseek-ai/dsh-tools`，`inject = ['tools']` | `docs/user/develop/basic/tool.md:11-36` |
| 参数 DSL | 显式 object 节点必须声明 `additionalProperties`；**参数根是隐式开放对象**；`required: true` 挂在每个属性上 | `docs/subsystems/tools.md:108-160` |
| 参数手检 | DSL 表达不了的约束（非空字符串、正数、跨字段）**必须自己检** | `docs/cookbook/adding-a-tool.md:42` |
| 返回值 | 只返回 `output.schema` 声明的**唯一规范化值**；`output.render` 负责模型可见内容 | `adding-a-tool.md:45` |
| 失败 | 基础设施失败**抛异常**（模型只见 `Error: <message>`）；业务性拒绝（非法流转、CAS 失败）走类型化错误 | `adding-a-tool.md:46`、`packages/core/tools/README.md:215` |
| 并发 | **只有 `isConcurrencySafe` 返回 `true` 才算并发**，省略即独占 → 读操作声明 `true`，写操作保持独占 | `docs/subsystems/tools.md:71-80` |
| 超时 | `timeoutMs` **仅声明**，由 `tool-call-timeout-policy` 执行 | `docs/subsystems/tools.md:63-70` |
| UI 元数据 | `presentationMeta(args, value)` 产出**可重放** JSON，持久化进 `tool/result` | `adding-a-tool.md:48` |
| 结果体积 | **别返回长正文**：base 的 `spill-policy` 上限 `maxInlineTokens: 12500`；`standard` preset 还会把超 8192 字符的结果裁成 4096+1024 | `packages/bundle/base/cordis.patch.yml:418-422`、`presets/standard.patch.yml:93-99` |
| 权限 | tool **不声明**权限；需要审批就用 `sandbox_permissions` + `justification` 参数对 | `adding-a-tool.md:59`、`docs/subsystems/shell.md:169` |
| 配置 | `export const Config = Schema.object({...})`（**Schemastery**）；动态字段用 `.volatile()` + `loader/volatile-update` | `docs/user/develop/basic/config.md:11-45`、`adding-a-settings-card.md:9-30` |

> **可选宿主服务必须用 `ctx.get(name)` 读，绝不能写成 `ctx.<name>`。**（2026-10-15 Fedora 真机抓获） 宿主对"未在 `inject` 里声明的服务"做**属性读取**会直接抛 `cannot get property "<name>" without inject`；而把 `commands` / `skills` 声明成必需， 又会让**没有这两种注册表的 profile 连工具都装不上**。官方正解见 `docs/user/develop/framework/service.md:95` —— "Optional: omit inject and query with `ctx.get()` at the use site."
>
> **为什么单元测试当时抓不到它**：决策 108 让适配层用自声明的最小 ctx，而测试喂的是**普通对象 假 ctx**——属性读取不抛。于是"**274 测试全绿**"与"**真机装不上**"可以同时成立； 这正是决策 108 写下"宿主漂移只能靠真机集成测试暴露"的那笔代价，本次兑现了一次。
>
> **已补两道防线，让这一类不再只能靠真机抓**（2026-10-15，且都做了变异验证）： ① **类型**——不可达的服务**从 `JiraHostContext` 里删掉**，`tsc` 直接拒绝属性读取 （注入该写法 → `TS2339: Property 'commands' does not exist`）； ② **测试**——`index.test.ts` 的假 ctx 改为**代理式**，对未声明的服务属性读取抛与宿主**同样的错** （绕过类型强制转型后 → **20 个测试失败**，打印 `cannot get property "commands" without inject`）。

> 结果体积那条对本案有直接约束：**issue 的 description 不要整段回给模型**， 只回 summary + 计数式摘要（学 `todo_write` 只回 `N pending, M in progress`）。

**错误码的单一来源（决策 52）**：12 个错误码在 `core` 里**只定义一次**（一张常量表 + 统一形状 `{ code, message, context? }`）： `STALE_REVISION` · `INVALID_TRANSITION` · `RESOLUTION_REQUIRED` · `UNKNOWN_TAG` · `BLOCKED_BY_OPEN` · `FOREIGN_MACHINE_READ_ONLY` · `NOT_FOUND` · `LOCK_TIMEOUT` · `WRITE_FAILED`（= 任何 IO 失败；决策 111） · `KEY_EXHAUSTED` · `INVALID_INPUT` · `READ_ONLY_SESSION`。 tool / CLI / `/jira` 命令都从它取；并且**有一条测试断言"本文档列出的码集合 == 代码里的码集合"**—— 这正是 §11.1 从上游学来的做法（`params.py::FIELDS` 声明一次 + 测试守三处一致），避免"文档写了一套、代码是另一套"。

**输出语言（决策 55）**：**面向模型的一律英文**——tool description、工具返回值、错误 `message`、注入的存储意识行； **面向人的一律中文**——`BOARD.md`、CLI 帮助与输出、`/jira` 命令输出、README 与设计文档。 理由：与 DSH 生态（英文工具面）一致、错误码本就是英文、token 更省；而看板与帮助是给你自己看的。

**读结果的统一外壳（决策 56）**：每次读都带 **`writable`**（+ `reason?`，§4.11 要求"动态地在每次读里告诉模型"） 与 **`me`**（`{ model, tool, machine, session }`，§4.12 说其成本几乎为零）；**不重复 store 摘要**—— 那是 §6.4 注入行的职责，重复就是白花 token。

**插件 Config 的字段（决策 57）**：只保留五组"已经实现、且确实需要按环境调"的键——`root` · `tool` ·
> **体积与超时的常量（决策 84）**：`summary` ≤ **120 字符**（超长**写入侧拒绝**，不静默截）；正文不限长但**列表只回 summary**，`get` 超长时给"前 8 K 字符 + 共 N 字符"的显式标记；tool `timeoutMs` **读 5 s / 写 30 s**；`presentationMeta` 不做（P2）。 `push { enabled, debounce_ms }` · `lock { timeout_ms, stale_ms }` · `list { default_limit, max_limit }`。 **值还没定的键一律不加**：写了没人读的配置就是治理幻觉（§11.1 反面教训第 4 条）。

### 6.3 skill 决定采纳率

DSH 的 skill **按需加载、零常驻开销**，所以它同时是"零成本"和"决定一切"的。skill 正文必须明确回答 "**什么时候必须记一条 issue**"，否则再好的系统 agent 也没理由用。

**分发方式：让 bundle 自己带 `skills/` 目录**，用 `skill-filesystem` 的 `customSkillDirs` 挂载—— 这是上游 preset 自己用的做法（`packages/bundle/web-app/presets/cordis.patch.yml:145-148`： 用 `!!js` + `node:path.join` 指向包内 `skills/`）。

**不要覆盖 shipped 的 `skill-filesystem` 行**——按 id 覆盖会**整行替换 `config`**，必须重述别人的键。 **应该新插一行**：不同 `id`、`providerName` 自取、`includeDefaultRoots: false`、 `customSkillDirs: [<本包 skills 目录>]`。既不覆盖上游、又随包版本走，且在任何工作区都可用。

备选是程序化注册 `ctx.skills.register(...)` / 自建 `SkillProvider` （`docs/subsystems/skills.md:9-62,164-171`），但**文档没有任何第三方 provider 的示例**，所以 file-based 更稳。

### 6.4 注入的是"存储存在且可读"，不是待办议程

**用户明确否掉了"注入待办列表"这个做法**：把 agent 的待办排进上下文没有意义—— 会话通常是人为了某个明确目的开的，一份议程多半是噪声；而 Jira 是**记录**，不是调度器。 （本文档早期把"注入队列"称为"价值支点"，**那是错的**，已按此更正。）

**真正需要注入的是"意识"**：告诉 agent 这个 store 存在、有多大、能不能读。 它自己会在需要时去查——人问"上次那个 Windows git 的问题怎么解的"，它知道有 KB 可查。

拟注入的一行（用 `PromptContext`，cache-safe）：

```
`[store] 3 projects · 148 knowledge · 12 open issues | read-only: 1`（决策 78 的英文固定格式；下面 L1224 起的说明已是新形态）
```

- **只是索引，不是议程**——不含任何任务内容，token 几乎为零。
- 仍要报"未关闭 issue"的总数：让 agent 知道有活可领，**但不告诉它该做什么**。
- **只读项目数必须标出来**，否则 agent 会去写只读项目然后撞墙（§4.11）。
- **必须用 `PromptContext` 而非 `section()`**：计数会变，动态 section 每变一次就击穿一次 KV cache （依据 `docs/subsystems/system-prompt.md:44-76`）。

**落地形态（决策 78）**：格式固定为 `[store] {n} projects · {m} knowledge · {k} open issues`（英文，决策 55）， 只读项目非零时追加 ` | read-only: {r}`——**英文且可被测试断言**。计数口径：`projects/*/project.md` 个数、 `knowledge/**/KB-*.md` 个数、status 不在 `closed` 集合里的条数。**空 store 不注入**。 注册名 **`jira:store`**；5 s 内复用上次扫描结果（扫一次约 1.5 ms，节流只是避免每一步都做 IO）。

### 6.5 生命周期集成（分阶段）

| 阶段 | 内容 |
|---|---|
| **P0** | `core` + CLI + 2~3 个 tool + skill provider + git 层 |
| **P1** | `PromptContext` 注入**存储意识行**（不是议程，见 §6.4）；**会话收尾扫描本次会话的 `git log`，给相关 issue 追加评论**（§6.7；触发机制见 B20 spike）。~~subagent 完成回写~~ → **作废**：子代理只读（决策 89） |
| **P2** | **先用 GitHub 网页当 UI**（数据本就是文本）；Web 面板（client face）成本高，确认有需求再做 |
| ~~**P3**~~ | ~~与 `goal` / `todo` 打通~~ → **明确不做**（决策 90：goal/todo 是 agent 的执行计划，issue 是问题单台账，两者不能混合处理） |
| 可选 | declaration-merge `SessionEventMap` 记录关键操作，让 issue 变更随会话日志一起 resume/fork |
> **P1 的收尾 seam 已查明（决策 100）**：主路径是 **`agent/created` 时注册 `agent.ctx.effect(async dispose)`**（会话级、被 await、在写句柄关闭**之前**，能落盘）；`session/disposed` 只作兜底（不 await、在 close 之后、append 不落盘）；`agent/turn-stopping` 可做每轮节流。**并且必须幂等可重放**——GUI 下会话多在**宿主进程退出**时才收尾（硬编码 5 s 宽限），崩溃则什么都收不到。
>
> **推论（收尾路径里绝不联网）**：宿主给收尾的宽限是**硬编码 5 秒**且不可配置（`apps/cli/src/process-shutdown.ts:4`，rc.2）——而一次 `git log` + 若干本地文件写 + 一次本地 `git commit` 是**毫秒级**的，**联网才会吃掉这 5 秒**。所以：**disposer 里只做本地动作**（扫 `git log` → 写评论 → 本地 commit），**`git push` 仍交给既有的防抖队列**（决策 60）异步做——这与决策 58 的"持 store 锁期间绝不联网/跑 LLM/长 IO"**同源**。

### 6.6 人类界面：`/jira` 斜杠命令（零模型 token）

`ctx.commands.register({ name: 'jira', description, handler })` 的 handler **直接对 agent 执行、不产生模型消息**（`packages/interaction/commands/README.md:41`）， 所以看板、列表、状态这类"给人看"的输出**完全不消耗模型 token**—— 这正是上游 `/goal` 的做法（"Reading status, mutating a goal, or receiving a direct command error adds no model tokens"）。

于是人机分工变得很干净：

| 谁 | 入口 | token 成本 |
|---|---|---|
| agent | 常驻 tool（3 个）+ skill 教它用 CLI | 低 |
| 人 | `/jira` 命令 + CLI | **0** |
| 批量 / 脚本 / 离线 | CLI | agent 侧按 skill 加载 |

> 命令**没有磁盘布局要求**，只要插件行在该 agent 的 composition 里（`docs/subsystems/commands.md:11`）。

### 6.7 提交绑定：commit ⇄ issue（用户要求的硬约束）

**用户要求**：插件上线后，本地 git 的每次提交**都必须绑定到某个 task/issue**； 未绑定的提交视为大问题，**必须拦截**。

**三个可能的拦截位置（只有这三个）：**

| 位置 | 能拦住谁 | 漏洞与代价 |
|---|---|---|
| **`commit-msg` hook**（工作区 `.git/hooks/`） | agent **和**人（都走 git） | `--no-verify` 可绕；hooks 不入版本、每个 clone 要装；**merge/rebase 也会触发** |
| DSH 工具层（拦 `bash` 里的 `git commit`） | 只有 agent | 别名、脚本、`git -c` 容易绕；且弄脏 bash 工具 |
| 服务端 CI（项目仓库） | 所有人 **无法用 `--no-verify` 绕过** | 事后（要 amend / force-push）；每个项目仓库都要装 CI |

**推荐组合：**

1. **`commit-msg` hook 是主拦截点**——唯一能看到"最终提交信息"的地方， 且对 agent 与人是同一道门。实现为一个**薄脚本**，调用 `jira verify-commit-msg <msgfile>`，校验逻辑放在插件里（单点真相）。
2. **`prepare-commit-msg` hook 从分支名自动填 key**（`DH-12-fix-oauth` → 前缀 `DH-12: `）。 **这一步是关键**：它把"拦截"变成"几乎不会被触发"。 好的约束不该靠频繁拒绝体现，而该靠**默认路径就合规**。
3. **豁免规则**（否则会打断正常流程）：
   - **merge / rebase 产生的提交豁免**（`commit-msg` 对它们同样触发）
   - 未绑定时**要求显式 `[no-issue]` 标记**：不是放行，而是**必须声明意图**。 于是"未绑定"不可能悄悄发生，且 `[no-issue]` 提交**事后可检索审计**。
4. **校验 key 真实存在**，不只是格式匹配——否则打错一个字母就成了假绑定。

**必须诚实说明**：hook 是**速度障碍，不是墙**（`--no-verify` 可绕）， 与 §4.11 同一性质。真正的墙是服务端 CI（上表第三行）——那是第二阶段的事， 且会给每个项目仓库引入 CI。

**安装方式**：由 `jira hooks install / uninstall` **显式**写入工作区 `.git/hooks/`， **不偷偷改你的仓库**、可逆；若已存在同名 hook，**链式调用**而不是覆盖。

**拦截组合（已确认）**：**只做本地 hook 拦截**，暂不加服务端 CI 兜底。 即 `commit-msg` 拦截 + `prepare-commit-msg` 自动填 key + merge/rebase 豁免 + `[no-issue]` 显式声明。 服务端 CI 留作后续可选加固（每个项目仓库都要装，成本不低）。

**只拦未来，不追溯历史（已确认）**：hook 仅校验**安装之后的新提交**。 历史里已有的未绑定提交（或压根没有 issue 的仓库）**不予追究、不告警、不补录**。 因此不需要"扫描历史 commit"这类功能——省掉一大块工作量，也避免上线第一天就淹在存量告警里。

> **落地细则（决策 67）**
>
> - **key 正则**：`\b([A-Z][A-Z0-9]{1,5}-\d+)\b`（大写 key + 数字）。
> - **自动填前缀**：`prepare-commit-msg` 从分支名按 `^(KEY-\d+)-` 取**第一个** key，写成 `KEY-12: ` 前缀。
> - **多 key**：允许；`commit-msg` **每一个都要校验真实存在**，前缀只填第一个。
> - **豁免**：`merge` / `rebase` / `revert` 产生的提交（按 `commit-msg` 的 source 参数与 `.git` 下的状态文件判定）。
> - **`[no-issue]`**：必须出现在**提交信息首行**；建议但不强制写原因（写了就能事后检索）。
> - **hook 语言与结构**：用 **Node** 写、只做**薄壳**，校验逻辑一律调 `jira verify-commit-msg`（单点真相）。
> - **链式调用**：安装时若已存在同名 hook，**重命名为 `<name>.jira-backup` 并链式调用**（原 hook 失败则不继续），卸载时还原。
> - **store root 解析**：走 `root` 配置或 `JIRA_ROOT` 环境变量，**绝不硬编码路径**。

**会话结束时的自动挂载（已确认）**：扫描本次会话期间工作区的 `git log`， 用 `\b([A-Z][A-Z0-9]{1,5}-\d+)\b` 匹配出涉及的 issue（决策 67 的正则）
- 只要在分支名或 commit message 里顺手带上 key，台账就自动有了关联记录。
- **写进评论文件**（§4.4）而不是 issue 主体 → 直接复用 `merge=union`，**零冲突**。

---

## 7. 仓库方案

### 7.1 方案 A（你的方案）：源码仓库 + 私有数据仓库

**命名与归属（已确认）**

| 项 | 值 |
|---|---|
| 插件源码仓库 | `dsh-plugin-multidevice-jira` |
| 数据仓库 | `dsh-plugin-multidevice-jira-cloudstore` |
| License | MIT |
| npm 包名 | **已定**：`@uitstalie/dsh-jira`（profile 补丁与包 manifest 都用的这个名字；分发仍推后，但名字不再是待定项） |
| 可见性 | **两个仓库都是 private**（已确认）；只计划后续暴露 public 镜像 |

- **开发期**用 `link:` 挂本地 checkout，无需发布： `pnpm dsh plugin --profile web add <本仓库绝对路径>` （旧稿此处写 `/home/uitstalie/桌面/dsh/dsh-jira`：**那是从前的目录名，且只有 Fedora 那台的路径**； 两机实际路径不同，见 `HANDOVER.md` §5。目录改名后旧名已失效。）
- **无网络的机器必须装得上**（§8 决策 34）：npm 分发在离线机器上装不了， 所以离线路径是：**`tsc` 编译出的 `dist/` + `package.json` + `skills/` 整个包目录拷到目标机，再 `dsh plugin add <本地路径>`**（决策 65）。**不用 esbuild 打包**：peer 必须保持 external，否则会打出第二份 DSH 实例、破坏"共享实例"（§2.2）。
  > 之所以能这么简单：**我们用不到任何 native 依赖**（决策 37 的文本扫描，不引 sqlite / faiss），编译产物跨 Fedora / Windows 直接可用。
- **分发**：发 npm（预构建产物，用户无需授权构建脚本）。
- **不要走 git 安装**：git 安装拉的是源码，需要 `prepare` 脚本 + 用户 `allowBuilds` 授权， 等于让用户批准在本机执行代码，体验与安全都差。→ `docs/user/develop/basic/publish.md:159-184`
- 数据仓库**必须私有**。
- 备选：数据作为插件仓库的一个 orphan branch（少一个仓库，但权限/CI 混在一起）。

### 7.2 方案 B（值得先否掉再定）：直接用 GitHub Issues 当数据库

插件退化为薄适配层（`gh issue create/list/comment`）。

- **白送**：UI、评论、标签、搜索、权限、通知、历史、blame。
- **代价**：每次操作要联网；状态模型受限于 label/column；离线不可用；写入慢一个数量级； **硬依赖 `gh`（或等价的 GitHub API 客户端）**——而按 §8 决策 33，部署 / 使用电脑上不保证有它。

**判断标准**：若主要诉求是"给人看 + 可追溯"，B 用 1/10 成本拿到 80% 效果； 若 agent 需**高频、离线、批量**读写自身任务状态，则选 A。

> 环境已核实：`gh` 已登录 `uitstalie`（SSH 协议），SSH 密钥就位，自动 push 可行。

### 7.3 看板：人需要的界面，按成本从低到高

已确认"人需要看板"。但**"看"和"改"是两个量级的需求**，别为了后者付出前者的百倍成本：

| 优先级 | 形态 | 成本 | 能看 | 能改 |
|---|---|---|---|---|
| **P0** | **`BOARD.md` 由 GitHub Action 在 push 时生成**（同时做 frontmatter 校验） | 极低 | ✓（打开仓库首页就是看板） | 点进 issue 文件改 |
| **P0** | 每个 issue 就是一个 Markdown 文件，GitHub 原生渲染 | 零（数据形态本身） | ✓ | ✓（GitHub 网页直接编辑 = 一次 commit） |
| **P0** | `/jira` 斜杠命令 + CLI `board` 表格 | 低 | ✓（会话内） | ✗ |
| **P1** | `jira board --html` 生成静态 HTML，可本地打开或走 **GitHub Pages** | 低 | ✓✓（真看板布局） | ✗ |
| **P2** | 真 Web GUI 面板（client face 插件） | **高** | ✓✓ | ✓ |

**（原结论已被本节末尾的修正记录推翻，此处保留原文以示记录）：`BOARD.md` 由 GitHub Action 在 push 时生成**。 当初紧接着写的"**不是**插件在本地生成"——那半句在**离线机器上不成立**（决策 34）。 现在的要求是：**两层都要有**，且生成代码在 `core` 里**只写一次**。

> **（决策 15 已推翻另一半）** 原论证是"人在 GitHub 网页直接改也会触发 push，Action 随即重写看板， 于是**看板永远与数据一致**；而插件本地生成会滞后（人改完后插件可能根本没运行）。
- 于是**打开仓库首页就是看板**——零额外基础设施、零后端、零部署。
- 人类直接点进 issue 文件就能改（GitHub 网页编辑天然产生一次 commit，正好被 §5 接住）。
- 同一个 Action **顺便做校验**：检查 frontmatter 必填字段、key 与文件名一致、 状态值合法、key 大小写规范。**人手工建 issue 写错了，CI 立刻红**—— 这比让插件事后报错更早、更便宜。
- （**决策 15 已改写**）Action 用 `GITHUB_TOKEN` 提交不会再次触发工作流，**不会死循环**；
- （**决策 15 已推翻此句**）原写法是"插件因此**不需要**实现 BOARD 生成逻辑"——现在要求 **Action 与插件都能生成、生成代码在 `core` 里只写一次**。

**P2 的 Web 面板只有在确认"必须在不离开 GUI 的情况下改"时才做。** 在此之前， `BOARD.md` + GitHub 网页已经覆盖了"看"和"改"两个需求。

文件头按**决策 79** 写统一 HTML 注释（`generated by dsh-jira | generated_at | source_tree | do not edit hand`），并说明可能由 Action 或插件本地生成（决策 15/34/79）
> 插件不写它，所以不存在"与人改动纠缠"的问题——这正是选 Action 的额外好处。

> **修正记录（离线约束，§8 决策 34 推翻本节的一半）**：本节早期把 `BOARD.md` **只**交给 GitHub Action 生成（决策 15），理由是"人在网页改完，插件可能根本没运行"。 但目标机器**可能永远连不上云端**——那时 Action 永远不会跑，**看板就不存在了**， 与决策 34「离线可用是硬要求」直接冲突。同样只活在 Action 里的还有 `frontmatter 校验`、`index.md` / `log.md` / `tags/index.md` 的生成。 **修正方向：两层都保留，不二选一**——
> - Action 在 push 时生成（权威，且能接住"人在 GitHub 网页上的改动"）；
> - **插件 / CLI 也必须能本地生成**同样的文件（离线路径）， **生成代码在 `core` 里只写一次**，Action 与插件共用，避免两份实现漂移；
> - 校验同理：CI 是服务端兜底，本地也要有 `jira lint`（写入侧严格，§4.13）。
>
> **已定案（用户确认）**：决策 15 的表述正式改为"**Action 与插件都能生成，生成代码在 `core` 里只写一次**"。

> **修正记录（2026-10-17，用户裁定：定时生成不得脱离 DSH 进程）**：本轮把"Action 生成"实现成了 **GitHub Actions 的 `schedule`（每夜 cron）**——同一个 job 内、只在定时/手动时重生成并提交， 理由是"既落实决策 15，又不与 agent 的 push 抢跑"。**用户裁定这是失败改动**： 定时任务在 **DSH 进程之外**跑，**账本的生成权不交给脱钩的外部定时器**。 已用 `git revert` 回退（store 的 `ledger.yml` 回到**只检查、什么都不写**，权限回到 `contents: read`）。 **因此当前事实**：上面第 1534 行"Action 在 push 时生成（权威）"**并未实现**； store 的 CI 只做 `lint` / `generate --check` / 提交绑定，**没有任何一步写文件**； 生成只有 **DSH 进程内的那条路径**（`jira generate`，离线可用）。 **由此留下的缺口，以及它的答案（2026-10-17 用户裁定）**：人在 GitHub 网页上改了一个 issue 时 **没有 DSH 在跑**，服务器侧又不许生成，那么这一格只能由**下一次 DSH 运行**来接。 用户裁定：**在会话结束时重生**（而不是每次写入）——理由是频率低则**跨机冲突少** （生成物没有 `merge=union`，两台机器各自生成会在合并时冲突）。 **落地**：`src/plugin/index.ts` 的会话结束 effect 里，在 `queue.flushNow()` **之前**调用 `core/generateStore.ts` 的 `regenerateAndCommit`（core 只写一次，决策 15 的那半条）， **只读会话跳过**（决策 89/93——只读会话连这里也不写）。 放在 flush 之前是关键：**推出去的必须与源一致**，否则 store 的新鲜度门禁必红。 两个用例都做过变异验证（拿掉重生成 → 用例失败；拿掉只读门禁 → 只读用例失败）。

> **修正记录（2026-10-17 深夜，用户裁定：时机从"会话结束"改为"每次推送之前"——决策 148）**： 上一条修正记录把重生成定在**会话结束**，理由是"频率低则跨机冲突少"。当晚实测推翻了它的前提： **推送并不等到会话结束**——一次收编提交 5 秒内就被防抖队列推走。于是"有会话在跑"的整段时间里， 每次推送都带着**陈旧的生成物**（写一条 issue 就让 6 个生成物过期），store 的 `generate --check` 门禁基本常红——正是我们最不想要的那种"红了没人看"。 用户先裁定"折进**每次写入的那个提交**"，实施中撞到两件**实测**事实，使它要么不可能、要么代价过高： ① **写入提交自己带 keyed 主题（`DH-1: …`），而 `log.md` 列的就是 keyed 提交**，所以它一提交， `log.md` 立刻过期——文件不可能包含自己所在提交的哈希，"同一个提交里带刷新的生成物"对 `log.md` **不可能**（实测：一次写入之后，只剩 `log.md` 与 `projects/DH/log.md` 过期，其余四个已被折进去）。 可行形式只能是**每次写入两个提交**（写入提交 + 紧随一个 unkeyed 的生成物提交）。 ② 那样每个生成物提交都要参与跨机 rebase 合并，而**生成物必然两边不同**（头部带 `generated_at` 与 `source_tree`）→ `pull --rebase` 会停在生成物上（实测：旧用例"两边各改一处、应当干净合并" 的那次 pull 直接停住，报"无法应用 DH-1: update (rev 2)"）。 **用户改选方案 B**：重生成放到**推送的收口点**，顺序固定 `pull --rebase` → **重生成+提交** → push。 于是**推出去的每个 HEAD 都保证与自己的源一致**（生成物提交是 unkeyed 的，不会再让 `log.md` 过期）， 跨机冲突面回到"只有离线堆了生成物提交时"才出现，不比原来更大。 **代价（用户已知并接受）**：本地工作区在"写入之后、下次推送之前"仍可能过期；无 remote 或 `push.enabled: false` 的 store 不在每次防抖里重生成（会话结束那次照旧会）。 **落地**：`core/push.ts` 的 `settle` 钩子（排在 `pull` 之后、`push` 之前；失败**拦住推送**， 不把门禁必红的提交推出去），插件与 CLI `sync` 各接一处；`settle` 是**每次 flush 的参数**而不是队列属性， 因为"能不能写"是**调用者**的属性（决策 89/93）：防抖那条路必然可写（它只由已成功的写入武装）， 会话结束那条把 `writable` 原样传进来。 **同一夜 CI 又抓出第二个真 bug（决策 146 的适用范围）**：新写的端到端用例在**本机全绿、在 CI 四个 job 上全红**。 原因是 `git pull --rebase` 要**重放**提交，而重放会**创建**提交 → 它和 `git commit` 一样需要**提交者身份**； 决策 146 只给了 `git commit` 按次注入的回退，**没给 rebase**。于是在 git **猜不出**身份的环境（CI runner、 全新容器、`user.useConfigOnly=true`）上：rebase 以「提交者身份未知」停住、**把账本留在 rebase 中途** （HEAD 分离、被重放的改动停在暂存区）、推送**永远不发生**——本机之所以全绿，只是因为我这台机器的 git 能从 GECOS/主机名猜出身份。复现：`GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null git -c … pull --rebase`（本仓用 `user.useConfigOnly=true` 钉住这个条件，见 `plugin/index.test.ts` 顶部）。 **修法**：`core/git.ts` 导出 `identityArgs`，`core/rebase.ts` 的 `pull --rebase` 与提交走同一套按次注入 （**绝不写进仓库配置**，决策 81/146 的理由不变）。**这条在决策 148 之后才致命**：settle 排在 pull 之后， 所以 pull 一停，**连生成物也不会刷新、推送也不会发生**。 **顺带修掉一处从写下就是死代码的钩子**：插件推送队列的 `pull`（决策 134）注释与代码落在**同一行**， `//` 把整个钩子吞了（`db7743e` 起）——插件的推送**从来不 pull**，两台机器时会被拒为 non-fast-forward 并无限重试；只有 CLI 的 `sync` 有。已修，并**变异验证**：把钩子重新注释掉， 新端到端用例立刻失败（36/37）。

### 7.4 forge 可替换性：哪几处绑了 GitHub（用户已表态"可能要换"）

**先分清两层**：**Git 是本地工具**（不需要账号、不需要联网）；**GitHub / GitLab 是托管平台（forge）**。 它们之间没有技术互斥——同一仓库可以同时挂多个 remote（§4.10 已经利用这一点）。 所以设计必须分清"**只用 git 能力**"与"**依赖某家 forge 的产品功能**"，后者要可替换。

**只用 git、三家通吃（换平台零改动）**

| 能力 | 用在哪 |
|---|---|
| `git log` / `blame` / `show` / `revert` 当审计与回退 | §4.5 |
| `.gitattributes`（`eol=lf`、评论文件 `merge=union`） | §5 |
| plumbing + NUL 分隔，不解析人类可读输出 | §5 |
| 本地 `commit-msg` / `prepare-commit-msg` hook | §6.7 |
| 原子写、lockfile、CAS / `revision` | §5、§4.7 |
| 每机一份 `counters/<machine_id>.json` 的块分配 | §5 |
| `pull --rebase` 与人工冲突裁决 | §5 |

**绑定 GitHub 的六处（换平台时必须逐个替换）**

> **计数修正（2026-10-17）**：表头原写"四处"，实际列了 5 行；本轮补上第 6 行（store CI 读插件仓的凭据）。

| # | 现在（GitHub） | 换成 GitLab 时 | 代价 / 未知 |
|---|---|---|---|
| 1 | **`BOARD.md` 由 GitHub Action 在 push 时生成**（§7.3、决策 15） | 改为 **GitLab CI**（`.gitlab-ci.yml`）。生成代码本来就在 `core` 里只写一次（决策 34 的修正方向），CI 只是**调用方** | **runner 是否可用是未知数**——公司 GitLab 不一定给这种项目 runner。若没有，就退回**插件本地生成**（决策 34 已要求插件也能生成，正好兜底） |
| 2 | **`gh` CLI**（建仓、开分支保护、调 API） | 换 **`glab`**。`gh` 对 GitLab **完全无效**——实证：`gh auth login` 的 `read:org` 校验是 GitHub 独有的 | 自托管 GitLab 的 API / 权限模型另有差异；§7.2「用 Issues 当数据库」的方案在 GitLab 上要换成 Issues API，但**代价结论不变** |
| 3 | **分支保护 / 禁止 force-push**（§5「历史不可变」的防线） | GitLab **protected branches** 能力对等 | 自托管实例上得**有人有权限去设** |
| 4 | **"人在网页上改 = 一次 commit"**（§4.5、§7.3） | GitLab 网页编辑同样产出 commit ✅ | 无 |
| 6 | **数据仓 CI 要读插件仓**：`.github/workflows/ledger.yml` 检出并构建插件（决策 66 的 frontmatter 校验与新鲜度断言都要 CLI），私仓需要 secret `PLUGIN_TOKEN`（fine-grained PAT，**必须手动加 Contents: Read-only**——新建时是零权限，`GET /repos` 返回 200 只证明 Metadata） | 换 forge 时要重建这个**跨仓凭据**（GitLab 的 project access token / deploy token）；或者让插件仓公开、退回默认 token | 跨仓凭据是新的运维面：过期、被撤销、权限漏配都会让门禁**静默停在"读不到插件"**——因此 workflow 里那步预检是必须的 |
| 5 | **CI**（决策 66 的两条 job：双平台矩阵测试 + 产物/文档检查） | 改为 **GitLab CI**（`.gitlab-ci.yml`） | 未知同第 1 行：**自托管 GitLab 不一定给 runner**；没有就退回"本地跑同一套测试 + 提交前断言" |

**"私有"的含义不同（重要）**：GitHub 的 private = 数据在**微软云**上；公司自托管 GitLab = 数据在**公司内网**。 同一份内容放两处**性质不同**——`kb-llm` 审计里那些真实 JIRA 单号、员工姓名、未发布产品结论， 放内网 GitLab 属"访问控制内"，放 GitHub private 则是另一回事（§11.1 已记该警告）。 另有一条不属于技术范畴：把**个人项目**的数据放到**公司**内网 GitLab 上，涉及公司资产与合规边界。

**因此当前姿态**：store 先按 §7.1 放 **GitHub private**（决策 8 不变），但**把上表当替换清单**—— 真要换 GitLab，只需替换这四处 + 换用 `glab`，**其余设计不动**（决策 40）。

---

## 8. 决策清单

### 已确认（用户已拍板）

| # | 决策 | 结论 |
|---|---|---|
| 1 | 谁在用 | **agent 自用 + 人需要看板，且不排除人上去改** → 见 §7.3、§5「人类编辑是一等公民」 |
| 2 | 作用域 | **全局一个实例**（`$DSH_HOME/jira`），内含多个 project |
| 3 | project 语义 | **一般每个工作区 = 一个 project**；project 可复用；**身份锚在 git 远程地址**（§4.10） |
| 4 | 单机 / 多机 | **多机** → 需要 rebase、冲突处理、key 块分配（§5） |
| 5 | 无远程仓库的工作区 | **不拒绝**：降级为 `agent_write_policy: 'owner-machine'`。其他机器的 **agent 只读**、人类仍可改；机器身份见 §4.11。**作用域限定**：只适用于**共享同一个 store 的多机**——独立实例（决策 35）上不存在"别的机器的 project"，该拦截不生效（§4.11） |
| 6 | key 分配 | **块分配**，必要才联网；提交本身即版本回退工具（§5、§4.5） |
| 7 | 审计方式 | **文件即数据、git 即审计**，不自己造审计系统（§4.5） |
| 8 | 命名与 license | 仓库 `dsh-plugin-multidevice-jira` / `dsh-plugin-multidevice-jira-cloudstore`，MIT（§7.1） |
| 9 | 只读策略的执行层 | **工具策略**：写进工具 description + 工具层拒绝；bash 层不防（§4.11）。**作用域限定**：同决策 5——独立实例上该拦截不生效 |
| 10 | agent 身份维度 | `agent:<model>\|<tool>\|<machine_id>\|<session_id>`，新增 `tool` 维度（§4.12） |
| 11 | store 数量 | **单个 store**，定位就是"单人多设备"（笔记本、系统不同、工具不同） |
| 12 | 使用者 | **只有我一个人** → 不需要权限模型；`human:<name>` 可以简化 |
| 13 | 目标平台 | **Fedora KDE + Windows 10/11，无 macOS** → 见 §5「跨平台硬约束」 |
| 14 | 容器/VM | **不会**跑在容器里 → machine_id 稳定（回退链仍保留） |
| 15 | BOARD.md 生成方 | **Action 与插件都能生成，生成代码在 `core` 里只写一次**——原表述"只由 Action 生成"已被决策 34 推翻（离线机没有 Action=没有看板）；有网络时 Action 跑（能接住人在网页上的改动），离线机由插件本地生成（§7.3 修正记录）。**修正（2026-10-17）**：Action 那一半**不做**（用户裁定：生成不得脱离 DSH 进程，§7.3），当前只有 DSH 进程内这一条；**时机**由决策 148 定在**每次推送之前**（`pull` → 重生成+提交 → push），会话结束时再兜一次 |
| 16 | CAS 严格度 | **`revision` 可选；过期则拒绝并返回当前值**（§4.7） |
| 17 | 推送时机 | **防抖自动推 + 会话结束推**（§5） |
| 18 | 分发方式 | **暂不考虑**，先本地 `link:` 开发（§7.1） |
| 19 | 状态机 | 单一全局 `config.md`；status 可配置、只增不删、下线用 `deprecated` + 摘入边（§4.2） |
| 20 | issue 类型 | 可配置，seed `task` / `bug`（§4.2） |
| 21 | 评论 | 单独文件 `comments/<KEY>.md`，追加式 + `merge=union`（§4.4） |
| 22 | 层级 | 走 `link` 的 `parent`；`children` **派生不存**（§4.15） |
| 23 | 结构关系 | 固定闭集：`related` / `duplicate` / `is_blocked_by` / `parent`（§4.15） |
| 24 | 阻塞拦认领 | **只拦 agent**（人不受影响）；可显式 `override` 并记事件（§4.15） |
| 25 | resolution | 可配置，默认 `fixed` / `invalid` / `limitation`（落地数据仓时新增 `abandoned`，给"中止"一个不与 `invalid` 重叠的取值）；**关闭集合内一律必填**——含 `cancelled`（§4.16 修正记录） |
| 26 | tag 治理 | 注册表 + `description` 必填 + 相似度提示 + `/jira tags lint`（§4.14） |
| 27 | 知识库 | 独立实体、OKF 规范；每 project 一 Bundle，KB 按知识域分多个 Bundle（§4.13） |
| 28 | 注入内容 | **只注入"存储意识行"，不注入待办议程**（§6.4） |
| 29 | 工具面 | 常驻 `jira_issue` / `jira_list` / `jira_kb`，其余 `deferLoading`（§6.1）（决策 141：显式超时与并发声明已做 ✓，deferLoading 未做 ✗） |
| 30 | 提交绑定 | 本地 hook 拦截 + 自动填 key + `[no-issue]` 声明；**只拦未来**（§6.7） |
| 31 | 会话结束 | 扫描 `git log` 匹配 key → 自动追加评论（§6.7） |
| 32 | 机器粒度 | **双系统算两台机器**（`os` 留在 hash 里，§4.11） |
| 33 | `gh` 的定位 | **不是依赖，只是开发期便利**：clone / push 走 SSH 或凭据管理器，与 `gh` 无关；`gh` 仅用于建仓库、开分支保护、调 GitHub API。**部署到"使用电脑"时必须能在没有 `gh` 的环境下工作**（SSH / 网页兜底；§7.1、§7.2） |
| 34 | 离线可用 | **硬要求：每台机器上必须能完全本地工作。** 目标机器可能**没有 `gh`、没有 SSH、连不上云端、不保证同步**——此时建/改 issue、评论、tag、KB、锁、CAS、提交绑定、看板都必须照常可用；推送与跨机同步一律 best-effort，"连不上"不得阻塞任何操作（§5、§7.3、§11.1） |
| 35 | 离线机 = 独立空实例 | 那台机器上是**从零建的空本地 store**（默认 `$DSH_HOME/jira`）；与主 store **没有共享历史**，**合并需要人工单独归并**，不是 git 自动合并。因此 §5「真冲突裁决规则」只适用于**共享同一个 store 的多机**。**连带收窄决策 11**：「单个 store」指的是**共享主 store**这一层，离线实例不计入它（§4.10、§4.11、§5、§11.5） |
| 36 | 跨实例关系 | **默认不合并**：独立实例相当于一个"**新分支**"，key 空间各自从 `1` 开始，**不做预留号段、也不把机器维度编进 key**。两条例外都必须**显式发起**：**复写**（不需要保留对方细节时整体覆盖）或**归并**（需要保留双方时，做一次**人工重编号 + 数据重新编排**并留下旧→新映射表）。归并是**一次性操作，不是持续同步**（§11.5） |
| 37 | KB 检索形态 | **不做向量、不做 RAG、不引入本地 ML 模型**。关键字检索 = **直接遍历 store 里的 `.md` 做子串 / 正则匹配**（实测：上游正式库 59 文件 / 116 KB、单次全量扫描 **0.3 ms**；全仓 135 文件 / 351 KB、**1.5 ms**）。索引 / 向量留到**规模真正证明需要时**再谈，且届时必须满足"派生 + 可重建 + 进 `.gitignore`"（§11.1） |
| 38 | **读操作不得写** | 任何读（`jira_list` / `jira_issue get` / KB 检索 / 看板 / 注入的计数行）**不得修改 store 里的任何文件**；"热度 / 活力 / 代际"这类统计要么落在 `var/` 派生侧、要么干脆不做。上游"每次查询都写 `domains/*/_vitality.yaml`"（官方文档原话："同一句查询会改数据仓"）是**明令不抄的反面教材**（§11.1） |
| 39 | 生成物必须可验证新鲜 | 任何生成物（`BOARD.md` / `index.md` / `log.md` / `tags/index.md`）**单独成文件**，头部内嵌 `generated_at` + **源树 hash**，并有**断言新鲜度**的检查（提交前 / CI / `/jira` 体检）。生成物与手写内容**绝不同文件**、**绝不靠魔法字符串切分**。上游 `log.md`（上段手写 + 下段生成，靠 `## 事件流` 切分）与 `index.md`（**陈旧两个月、整域缺失无人发现**）是实证反面教材（§4.4、§7.3） |
| 40 | forge 可替换 | 设计**不锚定 GitHub**：只用 git 能力的部分（审计、hook、锁、CAS、块分配、`merge=union` …）三家 forge 通吃；**依赖 forge 产品功能的五处**（Action 生成 `BOARD.md`、`gh` CLI、分支保护、网页编辑、**CI**）必须保持**可逐个替换**。store 暂放 GitHub private（决策 8 不变），真要换 GitLab 时按 §7.4 的清单替换 + 换用 `glab`，**其余设计不动** |
| 41 | 落盘字段命名 | **一律 `snake_case`**：frontmatter / JSON 键与 tool 参数名统一用 snake（`agent_write_policy` / `lease_expires_at` / `expected_revision`）；**代码内部（TS）可自由用驼峰**，转换只发生在 `core` 的编解码层。DSH 与上游的既有名字（`deferLoading` / `writeScopes` …）**保持原样不动**（§4.1、§11.6 的 A1） |
| 42 | 评论与事件 | Issue 上**没有** `comments[]` / `events[]`；评论是**单独文件**（§4.4），**"事件"一律写成评论**（租约过期、override 认领…），评论数**渲染时现算**；**MVP 不做 `events.jsonl`**——将来若做，必须**每机一份** `events/<machine_id>.jsonl`，绝不一个全局文件（§4.1、§4.5） |
| 43 | `summary` / `description` / `title` | frontmatter 只放 **`summary`**（一行、必填，给列表与看板）；**正文 Markdown 就是 `description`**；**不另存 OKF 的 `title`**——渲染时把 `summary` 当 title 用。理由：避免两个写起来必然搞混的近似字段，且与 §6.2「别把 description 整段回给模型」天然契合（§4.1、§4.4） |
| 44 | `revision` 语义 | **初值 1**（不用 0——JS 里 falsy）；**只有主体变更（frontmatter / 正文）才 +1**；**评论各自计数、不推进主体的 revision**（评论是追加式、靠 `merge=union`，不需要 CAS）。于是"改描述"不会被别人的评论顶掉 CAS（§4.7、§4.1） |
| 45 | 两个 `type` 维度 | OKF 的 **`type`** 管**文档种类**（`issue` / `config` / `tag` / 知识条目各自的 type），**写入侧强制小写**；我们的"这是什么活"独立成 **`issue_type`**（`task` / `bug`，同样强制小写）。两者不再撞键。由来：§11.1 审计里上游正是因 `type: Architecture` 大写导致**整个结构校验被静默跳过**（§4.1、§4.2） |
| 46 | 格式版本字段 | **每个文件都带一个自描述字段 `schema: <kind>/v<N>`**（`issue/v1` · `project/v1` · `tag/v1` · `machine/v1` · `session/v1` · `config/v1` · `kb/v1` · `counters/v1`），取代原先只在 config.md 放 `format_version` 的做法。写入侧**严格校验版本**；读取侧**宽容**（未知版本降级只读并标注）。这是"零迁移"能落地的支点（§4.1、§9）。**评论文件是例外**（2026-10-19 裁定，见决策 179）：按决策 68 它是**锚制**——一个文件装多条评论、每条带自己的 `author`/`created_at`/`revision` 锚，frontmatter 只能描述整个文件，所以**没有 `comment/v1`**，原清单里的"九种"实为八种 |
| 47 | 时间戳格式 | **UTC + ISO-8601 到秒**（`2026-10-15T08:30:00Z`，无毫秒），所有时间字段统一（`created` / `updated` / `claimed_at` / `lease_expires_at` / `first_seen` / `last_seen` / `started_at` / `captured_at`）。好处：无时区歧义、字典序即时间序、租约跨机可判；**本地时间只在显示时转换**（§4.1、§5） |
| 48 | 身份串分隔符 | `agent:<model>\|<tool>\|<machine_id>\|<session_id>`（这行里的 `\|` 就是**分隔符 `\|` 在表格中的转义写法**）——分隔符是 `\|`，分量内**禁止出现它**（写入校验直接拒绝），**因此无须任何转义逻辑**；`human:<name>` 不变。原 `/` 分隔形式废弃（§4.3） |
| 49 | 写入侧校验边界 | **未知 frontmatter 键 = 写入直接拒绝**（返回类型化错误并列出未知键）；必填键缺失同理。**读取侧仍然宽容**：遇到未知键/坏记录不报错，降级继续读并标注（§4.13 的"严律守己、宽以待人"）。理由：手写把 `priority` 拼成 `priorty` 时，"忽略"模式会**静默丢数据**；而"能在工具层便宜拦住的事不该靠纪律"（§4.14 同源） |
| 50 | `jira_issue` 的动词集合 | **7 个**：`get` / `create` / `update` / `switch_state` / `comment` / `link` / `assignee`。三条分工——**`switch_state` 专管状态流转**（按 `transitions` 校验；进入关闭集合时校验 `resolution` 必填）；**`update` 严格限于内容修改与 note 记录**（改 `summary` / 正文 / `priority` / `tags`）；**`assignee` 合并了原 `claim` / `release`**，取 `self`（自己 → 认领并起租约）或 `null`（释放并清租约）（§6.1、§4.3、§4.8） |
| 51 | `note` 字段 | Issue 上**新增一个自由文本 `note?`**，**由 `update` 改写**、不参与状态机。与 `comment` 的分工：**comment 是带作者与时间的追加记录（永不删）**，**note 是会被覆盖的"当前提醒"**（给下一个人/下一个会话留句话）。改 note 属主体变更 → 推进 `revision`（决策 44）（§4.1、§6.1） |
| 52 | 错误码 | **12 个**：`STALE_REVISION` · `INVALID_TRANSITION` · `RESOLUTION_REQUIRED` · `UNKNOWN_TAG` · `BLOCKED_BY_OPEN` · `FOREIGN_MACHINE_READ_ONLY` · `NOT_FOUND` · `LOCK_TIMEOUT` · `WRITE_FAILED`（= **任何 IO 失败**，读写都算；决策 111） · `KEY_EXHAUSTED` · `INVALID_INPUT` · `READ_ONLY_SESSION`。**统一形状 `{ code, message, context? }`**；**单一来源**：在 `core` 里定义一张常量表，tool / CLI / 命令都从它取；**用测试守卫"文档里的码集合 == 代码里的码集合"**（抄上游 `params.py::FIELDS` 单点 + 测试守卫的做法，§11.1 要抄清单第 5 条）（§6.2） |
| 53 | `jira_list` 的排序与分组 | **先 project → 再 status（`statuses[].order`）**；组内 **`priority` 升序（S1 最先）**，同级按 **`updated` 倒序**；**被阻塞的（`is_blocked_by` 未关）抽出单独一组放最后**；`limit` **默认 20、上限 100**，超限只回"还有 N 条"的计数而不铺全量（§6.1、§6.2 的体积约束、§4.15） |
| 54 | `jira_kb` search 的返回 | 每条命中返回 **`{ key, title, file, line, snippet }`**——**必须带 `file:line`**（可回溯到真相源），片段封顶约 200 字；`top_k` 默认 10、上限 50；排序 **标题命中优先 → 命中次数 → `updated` 倒序**；**绝不回整篇正文**（§6.2 体积约束、决策 37 的"扫文本"）（§6.1） |
| 55 | 输出语言 | **模型面英文、人面中文**：tool description / 返回值 / 错误 `message` / 注入行走英文；`BOARD.md` / CLI 帮助与输出 / `/jira` 输出 / README 与设计文档走中文。代码注释与 commit message 随文档（中文）（§6.2） |
| 56 | 读结果的统一外壳 | 每条读结果都带 **`writable`**（+ `reason?`）与 **`me`**（`{ model, tool, machine, session }`）；**不重复 store 摘要**（那由 §6.4 的注入行负责）。理由：§4.11 要求"能不能写"必须每次读都告诉模型，否则模型只能靠撞墙学；而全局计数重复带就是白花 token（§6.2、§4.11、§4.12） |
| 57 | 插件 Config 字段 | **最小可用五组**：`root`（store 路径，默认 `$DSH_HOME/jira`）· `tool`（覆盖探测链，§4.12）· `push { enabled, debounce_ms }` · `lock { timeout_ms, stale_ms }` · `list { default_limit, max_limit }`。**规则：只加"已经实现、且确实需要按环境调"的键**——归档天数、日志级别、hooks 开关这些**值还没定的先不加**，否则就是上游那三处"死配置"（写了没人读 = 治理幻觉）（§5、§6.2） |
| 58 | 锁粒度 | **两级锁**：**issue 级** `.jira/locks/<KEY>.lock` 保护单条"读-改-写"（不同条目零等待）；**store 级** `.jira/lock` **只**保护 `git add/commit`、`counters` 分配与 `config.md` 写入（毫秒级临界区）。纪律：**先 issue 锁再 store 锁**（固定顺序防死锁）；**持 store 锁期间不跑 LLM / 不联网 / 不做长 IO**（§5） |
| 59 | 锁的原语与参数 | **`mkdir` 作原语**（两平台都原子、不受 Windows 杀软/索引器影响），锁目录内放 owner 文件 `{ pid, host, machine_id, at }`；默认 **stale 60 s / 获取超时 10 s / 退避 100 ms + 抖动**，均可用 `lock.stale_ms` / `lock.timeout_ms` 调（§5） |
| 60 | 写路径常量 | **推送防抖 500 ms**（会话结束必推）· **原子写重试 3 次**（50 ms 起指数退避，仍失败报 `WRITE_FAILED`，绝不静默丢写）· **长路径预警 240 字符**（Windows 260 留 20 余量，超限启动时报错）。**三者是代码常量、不进 Config**——决策 57 的原则是"只加确实需要按环境调的键"，这三个不随环境变（原先写"在 Config 里可调"是我自己造的矛盾，此处更正）（§5、决策 57） |
| 61 | 租约时长 | 默认 **2 小时**（`claimed_at + 2 h`）；**不另起心跳**，但**对该 issue 的任何写操作都顺带续租**；过期只降级为"可重新认领" + 写一条评论，**不硬阻塞**（§4.8：虚假的互斥比显式警告更危险）（§4.8） |
| 62 | 归档 | **MVP 不做**：`archive/` 目录不建、阈值 N 不定、无自动归档（§4.9 已标注）。将来真要做：只能在**写路径**触发（决策 38），且归档后读路径默认排除、可显式查（§4.9、§4.4） |
| 63 | peer / engines | peer 与 dev **同时钉宿主实际版本**（本机实测 `@deepseek-ai/dsh-tools@0.2.0-rc.2`）；`engines` **跟随 DSH**：实测 `node: "^22.19.0 \|\| >=24.0.0"`。**换机器必须重核版本**——部署机既不保证有 `gh`（决策 33），也不保证版本一致（§2.2、§11.2） |
| 64 | 包结构 | **单包多入口**：一个 npm 包、内部 `src/core`（纯逻辑、零 DSH 依赖）/ `src/cli` / `src/plugin`；`exports` 暴露 `.`（DSH 插件）与 `./cli`。边界靠**边界守卫脚本并进 CI**（`core` 不得 import DSH、`cli` 不得 import 插件层），而不是靠 monorepo 的包边界（§3、§11.1 要抄清单第 4 条）。**措辞修正（2026-10-19，DPMJ-104）**：原文写的是「AST 边界检查器」——实际交付的是 `scripts/check-boundaries.mjs` 的**语句级分词扫描 + 13 条形状表自检**（决策 164），不是 AST；目标（守住边界）达成，手段按实交付修正 |
| 65 | 构建与离线安装 | **`tsc` 编译到 `dist/`（ESM + `.d.ts`），不做打包**；**离线安装 = 拷贝构建好的包目录到目标机 + `dsh plugin add <本地路径>`**。不用 esbuild：peer 必须 external，否则会打出第二份 DSH 实例（破坏"共享实例"）。可行性依据：本插件**零 native 依赖**（决策 37 的文本扫描，不引 sqlite / faiss），产物跨 Fedora / Windows 直接可用（§7.1、决策 34） |
| 66 | 测试与 CI | 测试用 **`node:test`**（零依赖），覆盖 `core` 纯函数（状态机 / CAS / 校验 / key 分配 / 扫文本检索）；CI 两条 job：① **`ubuntu-latest` + `windows-latest` 矩阵**跑同一套测试；② **产物与文档检查**——BOM/CRLF 检测、frontmatter 校验、**生成物重跑后 `git diff` 必须为空**（决策 39 的新鲜度断言）（§5） |
| 67 | 提交绑定的细则 | key 正则 `\b([A-Z][A-Z0-9]{1,5}-\d+)\b`；`prepare-commit-msg` 从分支名 `^(KEY-\d+)-` 取第一个 key 当前缀；**多 key 全部校验存在**；`merge`/`rebase`/`revert` 豁免；`[no-issue]` 必须在**首行**；hook 用 **Node** 薄壳调 `jira verify-commit-msg`；已有同名 hook **改名 `*.jira-backup` 并链式调用**；store root 走配置 / `JIRA_ROOT`，**不硬编码**（§6.7） |
| 68 | 评论的文件格式与 id | 每条评论以 **HTML 注释锚**开头：`<!-- c-<machine 短码>-<n> \| author=… \| created_at=… \| revision=1 -->`，正文随后。**id 带机器短码**（`machine_id` 前 4 位）→ 多机离线追加 + `merge=union` **零编号冲突**；注释锚不显示，人读干净正文；编辑按 id 寻址并 `rev+1`；**不可删**（校验拒绝）（§4.4、§4.1） |
| 69 | `Comment.author` 的值域 | **与 `assignee` 共用同一值域**（§4.3）：`agent:<model>\|<tool>\|<machine_id>\|<session_id>` 或 `human:<name>`。一个概念一套格式，避免"身份串 vs 结构体"两套写法（§4.3、§4.4） |
| 70 | `links` 的落盘形状 | **数组**：`links: [{ type, target }]`（`type` ∈ 闭集四种）。方向规则不变：`is_blocked_by` 写被阻塞方、`parent` 写子任务、`duplicate` 新指旧、`related` 写任一侧。**解除 = 删数组项**；集合型冲突按 §5「并集 + 打 `conflicted`」（§4.15） |
| 71 | `conflicted` 的生命周期 | **只在 `pull --rebase` 之后或写事务内**检测并打标记（读路径绝不写，决策 38）——这条同时解掉 A35；打标记后**读照常**、**写需 `ack_conflict: true`**，**改完自动清除**标记（写本身就是显式选定）。于是标记不会永久粘住（§5） |
| 72 | 重开时的 `resolution` | `switch_state` **离开关闭集合**时**清空 `resolution` 与 `resolution_note`**，并**自动写一条评论**记下"重开前结论是 X"。留痕靠评论 + git 历史，不新增 history 字段（§4.16） |
| 73 | 机器身份与派生数据落点 | `normalized_sn` = **去空白 + 大写 + 只留字母数字**；`os` 只用 `process.platform`；**回退身份文件固定 `$DSH_HOME/dsh-jira/machine-id`（故意在 store 之外）**——否则改 `root` 就等于换了台机器。两类派生数据分工：**本机私有状态 → `$DSH_HOME/dsh-jira/`**（不随 store、不进 git）；**可重建索引/缓存 → store 内 `var/`**（已 gitignore）（§4.11、§4.4） |
| 74 | `counters/<machine_id>.json` | **`{ schema: "counters/v1", machine_id, next, blocks: [[start,end]] }`**，**块大小 100**；`next` = 已领到的上界，`blocks` 记已领区间；新 store 第一台机器从 **1** 起，下一台从"全仓最大块末尾 +1"续（需 store 锁，毫秒级）（§5） |
| 75 | KB 实体契约 | **文件名 = key**（`knowledge/<域>/KB-7.md`；**不写 `key` 字段**，C3/决策 107）；`type` **闭集四值**（`runbook` / `pitfall` / `howto` / `concept`，进 config.md 的 `kb_types`，只增不删，**同时就是 OKF 的 `type`**）；**来源四件套 `machine_id`/`os`/`tool`/`captured_at` 必填**，来自文件再加 `source_sha256`；双向引用 = KB 侧 `issues[]` ↔ issue 侧 `kb_refs[]`（§4.13、§4.1） |
| 76 | knowledge 域目录名 | **小写 kebab-case**（`^[a-z0-9][a-z0-9-]{0,31}$`），与 tag 命名同规则，禁中文/空格/大写；**concept 的 slug 规则已随决策 75 作废**（文件名 = key）（§4.13、§4.14） |
| 77 | `project.md` 与 `remotes[]` | **`key` 只由目录名承载**（不在 frontmatter 重复存）；`remotes[]` 规范化 = **小写 + 去协议/认证/端口 + 剥 `.git` + 保留 host 与完整 path**；**多 remote 全留**，取优先级最高者作身份：**`upstream` > `origin` > 其它**（同时定下 B21）（§4.10） |
| 78 | 注入行的形态 | 固定格式 **`[store] {n} projects · {m} knowledge · {k} open issues`**（只读项目非零时追加 ` \| read-only: {r}`）；**空 store 不注入**；注册名 **`jira:store`**；`PromptContext` + 5 s 复用（§6.4、决策 55） |
| 79 | 生成物的头部与版式 | 统一 HTML 注释头部：`generated_at`（UTC ISO-8601）+ **`source_tree`**（相对路径 + 内容 sha256，按路径排序后哈希——**不依赖 git 命令**，离线可用且反映未提交内容）+ `do not edit by hand`。版式最小可用：`BOARD.md` 按 `statuses[].order` 分节并标 `conflicted`/被阻塞/已下线；`index.md` 列 projects 与 knowledge 域 + 计数；`log.md` 只列最近 100 条带 key 的提交；`tags/index.md` 字母序 + description + 使用次数。新鲜度：CI 重跑后 `git diff` 为空 + `/jira` 体检比对 `source_tree`（§4.4、§7.3、决策 39/66） |
| 80 | 坏数据的标注形状 | 读结果带 **`rejected: [{ file, reason }]`**（**只报文件与原因、不回坏内容**）+ `message` 说明"部分被跳过"；写路径同类问题直接 `INVALID_INPUT` 拒绝（决策 49）。读取侧宽容但不静默、写入侧严格（§5、§4.13） |
| 81 | `git config` 由谁写 | **插件在初始化 store / 首次写事务前幂等写入** `core.fileMode=false` 与 `i18n.commitEncoding=utf-8`——**只补缺失键、绝不覆盖用户已设值**；`/jira` 体检报告当前值。依据："能在工具层便宜拦住的事不要靠纪律"（§5 第 9 条、§4.14） |
| 82 | 三个 tool 的参数与输出 schema | 参数名 snake_case；`jira_issue` 十个参数（`action`/`key?`/`data?`/`to?`/`resolution?`/`resolution_note?`/`assignee?`/`link?`/`comment?`/`expected_revision?`）→ `{ ok, issue?, comments?, rejected?, writable, me }`；`jira_list`（`project?`/`status?`/`tags?`/`assignee?`/`link?`/`limit?`/`include_closed?`）→ `{ items, groups, counts, truncated, writable, me }`；`jira_kb`（`action`/`key?`/`query?`/`top_k?`/`data?`）→ `{ hits?, item?, rejected?, writable, me }`（§6.1、§6.2） |
| 83 | CLI 与 `/jira` 的子命令集合 | **CLI = tool 的超集 + 运维类**：`jira issue get/create/update/state/comment/link/assignee`（对齐决策 50 的七动词）· `jira list` · `jira kb get/create/update/search` · `board` · `lint` · `tags lint` · `doctor` · `hooks install\|uninstall` · `sync` · `verify-commit-msg` · **`machines [list\|label]`**（决策 91）· **`project [list\|bind\|rebind]`**（决策 92）。**`/jira` 只暴露给人看的只读子命令**：`board` / `list` / `show <KEY>` / `tags lint` / `doctor`。**逻辑只在 `core` 写一次**，两边都是薄包装（§6.1、§6.3）。**修正记录（2026-10-16，C5/决策 128）**：实际发布的**不是** `jira issue <verb>` 分组式，而是**混合式**——issue 七动词平铺（`get`/`new`/`update`/`switch`/`comment`/`link`/`assignee`，其中 `create`→`new`、`state`→`switch` 是刻意的人话命名），多动作名词分组（`kb`/`tags`/`project`/`machines`/`hooks`），运维平铺（`init`/`generate`/`sync`/`doctor`/`lint`/`verify-commit-msg`）；tool↔CLI 的映射由 `src/surfaces.test.ts` 钉住 |
| 84 | tool `timeoutMs`（读 5 s / 写 30 s）+ 读操作 `isConcurrencySafe` | ✅ **已实现（决策 141）**：三个工具都声明了 `timeoutMs`（`jira_list` = 5 s ✓；两个混合工具 = 30 s，同一数字要覆盖写 ✓）；`jira_list` 恒可并行 ✓，`jira` 用**白名单**（只有 `get` 可并行 ✓，无法归类保持独占 = fail closed ✓，与宿主文档「非 true 即独占」一致 ✓）；声明 `timeoutMs` 即承诺转发 `exec.signal`（宿主原话 ✓）→ `RunOptions.signal` 已接上并传给 handler ✓（宿主 0.2.1-alpha.2） |
| 85 | 何时引入索引 | **不拍硬阈值，定可观测触发条件**：当 `jira_kb search` 的 **p95 > 200 ms** 或 store **文件数 > 5000** 时再评估 FTS5；两个量由 `jira doctor` **定期报出**（决策 83），于是"该不该上索引"永远有数据可依。当前实测全仓扫描 1.5 ms，余量约 5 个数量级（§11.1、§4.4） |
| 86 | tag 相似度与 `tags lint` | **零依赖纯函数**（约 30 行 + 测试）：① alias 精确命中 → ② 前缀关系（`win`/`windows`）→ ③ **Dice 双字母组系数 ≥ 0.5** 取前 3；两边先小写、去 `-`/`_`。**不引 `fuse.js` / `rapidfuzz`**。`tags lint` 固定三段：只用过一次（count ≤ 1）· 缺 `description` · 高度相似的一对（**Dice ≥ 0.7**）——**只报告、不自动改**（§4.14） |
| 87 | 四个生成物的版式 + `board --html` | **`BOARD.md`**：每个未关闭状态一节（按 `statuses[].order`），节内表 `key \| summary \| priority \| assignee \| updated`；`conflicted` 行首 ⚠️；**被阻塞单独一节放最后**；已下线状态单独一节；末尾计数行（`closed: 12 · cancelled: 3`）。**`index.md`**：projects（key/name/未关闭数）+ knowledge 域（域名/条数）+ 入口链接，**不列单条**。**`log.md`**：最近 **100 条带 key 的提交**。**`tags/index.md`**：字母序 `tag — description（N 次）`。**`jira board --html` = P1 做**（与 BOARD.md 共用同一份数据与分组逻辑，**不引模板引擎**）（§4.4、§7.3、决策 79） |
| 88 | skill 的拆分 | **三个**：`jira`（主：何时用哪个 tool / 合法流转 / `resolution` 必填 / 被阻塞处理 / `note` vs `comment` / 零 token 的 CLI 路径）· `jira-kb`（沉淀知识：来源四件套必填 / `type` 闭集 / 双向引用）· `jira-hooks`（提交绑定安装 + `[no-issue]`）。**正文英文**（决策 55），**示例用真实数据**（中文 summary / tag 原样出现，不翻译）。落点：插件内 `skills/`，由 skill provider 注册（§2.3）。**已接受的代价**：三个描述常驻 prompt（token 成本），换来职责清晰（§6.3）。**修正记录（2026-10-16，与实现对齐）**：实际发布的是 **`jira-work` / `jira-board` / `jira-triage`**——按"人要做的判断"切（干活 / 看盘 / 分诊），而不是按代码模块切；`jira_kb` 的用法（来源四件套 / `type` 闭集 / 双向引用）**并进 `jira-work`**，hook 的提交绑定尚未实现（C7），故 `jira-hooks` 暂不发布 |
| 89 | 谁可以写 | **主 agent 统一写，subagent 只读**（用户裁定）。子代理写请求一律拒绝：复用 **`READ_ONLY_SESSION`**（`context: { reason: "subagent" }`）；读结果按决策 56 带 `writable: false, reason: "subagent"`。**代价**：§6.5 原 P1 的"subagent 完成回写"作废。**判据**：`SessionHeader` 里有 `parentSession` / `delegationDepth` / `origin: "subagent"`（事实存在）；**插件侧读取 seam 待 spike 验证**（§4.3、§4.11、§6.5） |
| 90 | `goal` / `todo` 与 issue 的关系 | **两套东西，不做任何打通**（用户裁定："goal 和 todo 跟 issue 没有关系，这是 agent 的执行计划，不是问题单计划。这俩不能混合处理"）。**不自动建 issue、不自动关 issue、不互相注入、不互相引用为规则**；agent 因用户要求而建 issue 只是"用工具"，不是"两个系统的桥"。原 §6.5 的 P3 作废（§1、§6.5） |
| 91 | 机器 label 缺失时的显示 | 显示 `machine_id` 前 6 位（`m-a1b2c3`），**首次出现时附一次性提示**"用 `jira machines label <id> <name>` 命名"，之后不再提（§4.11、决策 79） |
| 92 | `paths[]` 与 `rebind` | `paths[]` 规范化 = **绝对路径 + Windows 下统一小写 + 斜杠统一为 `\`**，且**只作缓存、绝不参与身份**（身份只看 `remotes[]`，决策 77）；**`jira project rebind` = 手动把一个 checkout 重新绑到另一个 project key**（只改 `paths[]`，不碰任何 issue 数据）（§4.1、§4.10） |
| 93 | 只读会话**默认拒绝写** | ✅ **已实现（决策 134）**：spike 查明——原来认的环境变量**宿主从不设置** ✗，真正的可读信号是 `agent.options.agentPreset`（宿主自己的预设标签是 `preset.readOnly`/`preset.workspaceWrite`）；现在 `describeCaller` 把只读预设也判为只读（reason `dsh-read-only` ✓），读照常；测试断言只读会话写被拒、读成功、普通会话照写。**已知边界**：按预设**名字**匹配是启发式（名字由部署方定），且宿主文件沙箱**不约束**进程内插件（§2.5）——所以这是插件在**遵从会话意图**，不是沙箱在拦 |
| 94 | 归并工具 | **MVP 不做归并工具**（独立实例默认不合并，决策 36）——只给两块支撑：`jira lint` 报**悬空引用**（重编号后能查漏改）+ 一份 **key 集合对比清单**。§11.5 的 5 点定清：① 粒度 = **按 project 搬**（连带 issue / 评论 / `kb_refs`），tag 先合注册表、KB 撞号同样重编号 · ② **映射表进 store**（`_merge/<UTC>-from-<machine_id>.md`）——commit message 里的旧 key 永远改不了，只能靠它解释 · ③ 不另造"归并事件"，靠 `reporter` / `machines/` + 映射表头部说明来源 · ④ 差异报告四类（疑似同一 project / 同 key 不同内容 / tag 撞名或同义 / KB 撞号）· ⑤ **一次性搬迁，明确不做长期双向**（§11.5、§4.4） |
| 95 | peer 版本策略（修正 63） | **本机有两个宿主 checkout，版本不同**：`deepseek-harness-uitstalie`（**0.2.0-rc.2**，分支 master，**正在跑 3080 的 GUI**，`tsx apps/cli/src/bin.ts web` 直跑源码）与 `deepseek-harness-uitstalie-dev`（**0.2.1-alpha.2**，分支 cli-desktop，正在 build）；全局 npm 装的也是 0.2.0-rc.2。所以 peer **不能只钉一个精确版本**——改为**同时接受两个宿主的 range**（并留 `dsh plugin allow-version` 作兜底），**"换机器重核"仍然成立**（决策 63 的其余部分不变）**并且宿主会漂移**：`-dev`（最新魔改版）会不定期同步到跑 3080 的 checkout → **peer 的主目标版本是 dev 的**，master 的 `0.2.0-rc.2` 只是当前宿主**实现细节（必须照做）**：peer 范围要**显式枚举两个版本**（如 `"0.2.0-rc.2 || 0.2.1-alpha.2"`）——因为 semver 的 **prerelease 排除规则**会让 `>=0.2.0-rc.2 <0.2.2` **匹配不到 `0.2.1-alpha.2`**（带预发布的版本只有在**同一 [major,minor,patch] 元组**上有预发布比较符时才匹配），写成范围会导致 `compatibility-preflight` 静默把我们的行 `disabled: true`（§2.2、§11.2、HANDOVER §5）**修正（2026-10-17）**：本机现在**只有一个**宿主 checkout（`deepseek-harness-uitstalie`，**0.2.1-alpha.2**，提交「docs(goal): register the branch's known limitations (task39)」），`-dev` 那个已经不在；peer 范围仍按本条**显式枚举**（兼容旧机器），但「主目标」现在就是 alpha.2。（宿主 0.2.1-alpha.2） |
| 96 | `ctx.tools.guard`（全局**单调**拦截点） | ✅ **已实现（决策 141）**：查宿主源码确认 API 存在且语义正是设计要的——「任何 guard 都可以拒绝，**没有任何 guard 能强制放行**」（`ToolGuard` = (execution) => string | undefined ✓）；插件注册**恰好一个** guard：写动作 + 不可写会话（只读/子代理）→ 返回理由拒绝。handler 内仍各自拒绝（纵深防御 ✓）。测试断言：拒写 ✓、放读 ✓、放普通会话 ✓、不管别的工具 ✓（宿主 0.2.1-alpha.2） |
| 97 | spike ① 失败时的回退（用户裁定） | **若"插件"这条路实在不行，就转内置插件，然后看情况合并到 dev**：把 `dsh-jira` 放进 fork 仓库（`-dev`，分支 `cli-desktop`），走仓库自己的构建与加载，稳定后再决定是否并回 dev。**触发条件**：spike ① 得出"patch / `insert` 在 `dsh web` 里不可见或不可靠"，或"要可见就必须冻结 preset roster（每次 DSH 升级手工同步上百行）"。**之所以便宜**：`core`（纯逻辑、零 DSH 依赖）**两条路径共用**，外部插件与内置插件只是**薄适配层的两种宿主方式**——转内置不是重写。**连带变化**：决策 63/95 的 peer 版本问题**消失**（同仓构建）；决策 18/65 的"分发与离线安装"变成"连 fork 一起拷/用 fork 产物"；代价是插件与 fork **版本绑死**，且插件代码要提交进 fork 仓库（多一个落点）（§2.7、§7.1、§7.2） |
| 98 | 引用 DSH 源码的标注规则 | **凡在本文档/HANDOVER 里引用 DSH 源码位置，必须标版本**（`rc.2` = `deepseek-harness-uitstalie` / `alpha.2` = `-dev`）。理由：本机**两个宿主版本并存**（决策 95），且 `-dev` 会不定期同步到跑 3080 的那个 checkout——**不标版本的 `file:line` 会随宿主漂移而变成假证据**。已实测的差异例：`Session.header` 在 rc.2 是 `packages/core/session/src/index.ts:464`、在 alpha.2 是 `:540`；`ctx.subagents` 的方法名两版不同（`startContinuable` → `startActivation`，**breaking**，本项目当前不需要它）（§11.2、决策 95） |
| 99 | 安装单元 = **bundle 包** | `plugin_manager` 的 README 说清了它管理的单位：**bundle**——"A bundle toggle changes `package.json` 的 ordered `dsh.profile.bundles` list"、"Installation enables a new bundle by default"。而一个 bundle 的标志就是 `package.json` 里的 **`dsh.bundle.patch: ["./cordis.patch.yml", …]`**（例：`packages/bundle/web-app/package.json:41-51`，配 `exports` 里的 `"./cordis.patch.yml"`）。→ **`dsh-jira` 要按 bundle 包来做**（不是"裸插件"）：包内带 `cordis.patch.yml`，用 `insert` 把我们的行插进 profile 层；安装走 **`dsh plugin add <path>` / Web 侧边栏 Plugins 页**（官方路径，装完默认启用）。**安装器只认 bundle**：非 bundle 包会被装成**普通依赖、不成为 profile 层**（`packages/boot/plugin-manager/src/operations.ts:98-109` 的 warning："declares no dsh.bundle — installed as a plain dependency, not a profile layer"），Web 插件页的 `installBundle` 更是**直接拒绝**（`packages/boot/plugin-manager/src/index.ts:410` → `refusedBy("not-a-bundle", …)`）。这条把决策 65 的"拷贝包目录 + `dsh plugin add <path>`"具体化到可执行形态；**另外：若将来要带 browser 半边，必须已构建出 `./client`**（源码直跑不会替插件现场构建，`packages/client/modules/src/index.ts:847`）（§7.1、§7.2、决策 65/97/101）（宿主 0.2.1-alpha.2） |
| 100 | 会话收尾扫 `git log` 的落地形态（spike ② 的答案） | **不要把它设计成"会话结束钩子"**。主 seam = 在 **`agent/created` 时注册 `agent.ctx.effect(() => async () => …)`**——**会话级、被 await、且在 `handle.close()` 之前**，所以写能落盘（第一方先例：`packages/api/terminal-controller/src/index.ts:292`、`packages/deliverables/workspace-changes/src/index.ts:152-153`，均 rc.2）。`ctx.on("session/disposed")` 只作**兜底**：零成本、官方最后时刻，但**不 await**，且它在 `handle.close()` **之后** → `append` 只进内存**不落盘**（rc.2 `packages/core/session/src/index.ts:403-420` 的 `invokeContainedSessionObservers` 只 try/catch + `void …catch(log)`）。`agent/turn-stopping`（rc.2 `packages/core/agent/src/runtime-types.ts:381`，`@mode serial`，调用点 `packages/core/agent-loop/src/agent.ts:360`，早于 `:385` 的 `turn/end`）可做**每轮节流**收尾。**必须幂等可重放**：GUI 下会话**通常只在宿主进程退出时**才 dispose（`session-controller` 没有任何 close/delete Remote），而信号处理只有**硬编码 5 秒**宽限（`apps/cli/src/process-shutdown.ts:4`）→ 崩溃/SIGKILL **什么都收不到**；幂等判据 = **已存在的评论（含 commit sha）**，水位线放 **`$DSH_HOME/dsh-jira/`**（决策 73 的本机私有状态落点），不进 store。**已堵死的替代路**：Claude Code hook 桥**不支持 `SessionEnd`**；**无** idle 超时 seam；**归档不 dispose 会话**（`packages/workspace/workspace/src/index.ts:363-385` 只写 state + stopSessionActivity）。**推论：收尾路径里绝不联网**——5 s 宽限只够本地动作（`git log` + 写评论 + 本地 `git commit`），`git push` 交给防抖队列（决策 60），与决策 58 同源。行号按决策 98 标版本（§6.5、§6.7、决策 31、决策 58/60）（宿主 0.2.1-alpha.2） |
| 101 | **spike ① 结论：可见，走宿主平面 insert，且必须做成 bundle 包** | `dsh web` ≡ `dsh --profile web`，**与其它 profile 走完全同一套 loader/patch 流程，没有任何按 surface / kind / 包名的加载过滤**（`apps/cli/src/args.ts:202-204`、`bin.ts:31-42`、`profile-boot.ts:167-173`）。**条件**：包的 bare specifier **必须可解析**（安装锚点 `apps/cli/package.json` 的依赖闭包优先，其次 profile 的 `node_modules`；`packages/boot/app-boot/src/profile.ts:630-641`）——不可解析只是该行 inactive + **宿主行仅 warning**（`app-boot/src/index.ts:824-862,925-939`）。**层序关键**：profile 补丁在 web bundle 的 `disabled: true` **之后**应用（`profile-context.ts:63-70`）→ **profile 里 insert 一个全新 id 不会被那些 disable 影响**；注册进 **global 层** → `dsh web` 的**所有**会话（含 `minimal`）都可见，且**单行可按 id 单独 enable/disable**（Plugins 页写的就是 profile 补丁），坏行只 warning。**为什么不走 preset**：preset 行只在选中该 preset 的会话可见、**无法被 profile 补丁按 id 修改**（改它要重述整份 `config.plugins`），且**一个坏 row 会把整个 preset 打成 broken**（`mount.ts:263-267`、`agent-preset-registry/src/index.ts:102-118`）——只有"明确要按 preset 分配能力"时才值得（dev 的 `tool-schedule` / `time-context` 就是那类）。**"preset-plane gate"之谜解开**：它**不是运行时闸门**，而是**仓库级 CI 不变量** `scripts/verify-cordis-config.ts:139-166`——"一个 row 只能属于一个平面"，**只校验随仓库发布的 base / web overlay / 4 个 preset，不约束本机 profile 补丁**；将来若把 `dsh-jira` 提交进仓库组合层（决策 97 的内置路径），就**必须遵守它**。→ **决策 97 的回退暂不启用**（外部 bundle 路径成立）（§2.7、§7.1、决策 95/99）（宿主 0.2.1-alpha.2） |
| 102 | **编码原则（用户裁定）** | 三条：**① 原子化 + function 化**——`core` 里每个能力 = 纯函数（输入→输出、无隐藏状态），副作用只在 `core/io` / `src/cli` / `src/plugin`，时间与环境当参数传，一个函数只做一件事；**② 组合 + data class**——领域实体是不可变数据 + 工厂函数（不用继承，"改"= 返回新对象），小纯函数串管道，**不重复造轮子**、`core` 零运行时依赖，变体/词表数据驱动不硬编码分支；**③ 原子化换可控性**——每个原子可单独测试、可单独替换，装配只在入口。**评审三问**：有隐藏状态吗？在组合还是在重写？能单独测吗？（§3.1、决策 64/65/66/97） |
| 103 | 第一刀 = **竖切一条端到端（含插件层）** | 顺序：`Result`/错误码基础件 → `parseIssue` → `validateIssue` → `renderIssue` → 文件读写（原子写 + LF + 无 BOM）→ CLI `jira issue get <KEY>` → **同一个 `core` 接上插件的 bundle 包**（`dsh.bundle.patch` + `cordis.patch.yml` + 一个 `jira_issue` tool）。**一刀同时验证三件事**：编码原则跑得通、CLI 骨架对、**决策 101 的"可见"在真实 `dsh web` 里坐实**（残余不确定性归零）。理由：先把"能跑通的一条线"立起来，再横向铺原子（§3.1、§7.1、决策 101） |
| 104 | 组合的基础件 = **自写最小 `Result` / `pipe`** | 约 20–30 行自己写：`Result<T,E>`（`ok` / `err`）+ `pipe` / `map` / `andThen`——它们本身就是"原子"，且让 `core` 不因错误处理而背第三方依赖；错误值直接复用决策 52 的类型化 `{ code, message, context? }`，与 `Result` 天然契合（决策 102、§3.1） |
| 105 | frontmatter 解析 = **自写受限解析器** | 只支持我们写出的子集（顶层标量 / inline 数组 / `key:` + `- item` 块数组 / 带引号字符串 / `#` 注释）；**遇到子集外语法一律报错、绝不猜**；"支持的子集"写进文档 + **CI 断言全库文件都在子集内**。收益：零第三方依赖 → "拷贝包目录 + `dsh plugin add <路径>`"的离线安装（决策 65）不受影响，解析器本身又是一个可单测的原子。**可逆性**：它被 `parseFrontmatter` / `renderFrontmatter` 包住，将来要换成成熟解析器**只是换掉这两个函数**（这正是原子化买来的东西）（§3.1、§4.1、决策 65/103） |
| 106 | 受限子集**加一层 flow map**（C2 的答案） | inline array 内允许**一层** flow map：`links: [{ type: is_blocked_by, target: DH-5 }]`——**完全忠于决策 70 的 `[{type, target}]` 形状**，仍然"超集即报错"（不允许嵌套、不允许 flow map 出现在数组之外、不允许数组内的数组）。代价：解析器 +约 40 行 + 测试（§4.1、决策 70/105） |
| 107 | **`key` 不写进 frontmatter**（C3 的答案） | 文件名**就是**身份，issue / KB 一律**不存 `key`**；**读到 `key` 直接报错**（写入侧严格）。理由与决策 77 拒绝给 `project.md` 存重复 `key` 完全同源："两处不一致时谁说了算"是只会出错不会加分的规定。`codec.ts` 已按此实现并有测试（§4.1、§4.13、决策 77） |
| 108 | 适配层**不 import 宿主包** | `src/plugin` 只依赖**我们自己声明**的最小 ctx 接口（`JiraHostContext` / `JiraToolDefinition` / `JiraExec`），**不 import `@deepseek-ai/*`**。理由：① 宿主的 `defineTool` 只做"spec → JSON Schema + 校验"，而我们**本来就必须有自己的严格校验**（决策 49：未知键拒绝）——已由 `core/schema.ts` 承担；② 本机 checkout 的 `node_modules/@deepseek-ai/` 里**没有** `dsh-tools` / `cordis`（pnpm 只链了少量包），而把机器路径写进 `devDependencies` 会同时破坏另一台机器的构建与"拷贝式离线安装"（决策 65）；③ 于是包**零 host 依赖**，两台机器都能构建、都能拷着装。**代价**：适配层不与宿主类型做**编译期**校验 → 宿主漂移只能靠**真机集成测试**（`dsh plugin add` 后在 `dsh web` 里看到工具）来暴露；我们的适配面只有 4 个 seam（工具注册 / 输出渲染 / 调用者谱系 / Config），spike 已在两版上逐个验过。**若将来走内置路径（决策 97），本条自动作废**——那时直接 import 宿主类型最省事（§3、决策 64/65/96/97） |
| 109 | **不声明 `peerDependencies`** | 适配层零 host 依赖（决策 108）时，peer 声明不再是兼容性契约，而是**安装负担**：pnpm 默认 `auto-install-peers`，装的时候会去 registry 找宿主包——网络一断就失败。故**一律不声明 peer**（并由打包测试守住），宿主兼容性改由**真机集成测试**守卫。决策 63/95 的 peer 讨论收窄为："**若**将来 import 宿主包（内置路径，决策 97），按 95 的**显式枚举**写法声明 peer"（§2.2、决策 95/108） |
| 110 | 工具 schema 必须用**宿主运行时方言**（实测） | 宿主 `tools.register` 收的是**标准 JSON Schema**：`required` 是**属性名数组**、`additionalProperties` 是布尔、`enum` / `oneOf` / `const` 可用。而宿主 `defineTool` 的 **spec 方言**（每个属性上写 `required: true`）**不能**直接喂给它——实测报 `JsonSchemaError: unsupported JSON schema: schema.properties.ok.required is not supported on type "boolean"`。我们的 `objectSchema()` 因此改成输出标准形态（决策 108 自建 schema 的代价在此兑现一次）。**附带实测**：坏行只 `warning: 1 entry did not activate`、**不阻断启动**（决策 101 的"坏行只 warning"由此坐实）（§2.7、决策 101/108） |
| 111 | `WRITE_FAILED` 的语义 = **IO 失败**（C4 的答案） | 读或写失败都用它（**码字符串不变**，因为决策 52 的 12 个码是冻结契约）；改的是**语义与文档措辞**，代码里的 helper 叫 `ioFailed`。理由：为"读失败"单开第 13 个码会牵动文档 + 决策 + 那条"文档==代码"的测试，而"这次文件操作没成功"本就该由同一个码表达（决策 52、§5/§6.2） |
| 112 | 受限子集**加一层嵌套**（修正 105 的边界） | 数组元素可以是：**标量 / 一层 flow map / 一层标量数组**——因为**我们自己的 `config.md` 读不出来**：`statuses` 用 `- { name: todo, order: 10 }`、`transitions` 用 `- [todo, in_progress]`。而"**我们自己的手写文件必须读得出来**"是决策 105 的底线（文件是给人手改的）。**边界仍严**：两层嵌套、数组里放 map、map 里放 map、同数组混装 —— **一律报错**。**顺带修的真 bug**：块数组条目**没剥尾部注释**（`- [in_review, in_progress]   # 打回` 被当成数组内容）。**夹具**：`fixtures/config.md` 是词表的逐字副本（store 仍是真相源），并有测试断言"它必须能解析"（§4.2、决策 105） |
| 113 | 评论锚里的 **author 含 `|` 时要加引号**（112/48 的交叉） | 决策 68 用 `|` 分隔锚的字段，而决策 48 的身份串**本身就含 `|`**（`agent:<model>|<tool>|<machine_id>|<session_id>`）——两者直接撞车：不处理的话作者会被截成第一段。定：**渲染时若作者含 `|` 就加双引号**（`author="agent:x|dsh|m|s"`），解析器**按引号感知切分**；**手写的未加引号且含 `|` 的锚一律报错**（错误里提示"quote the author"），不猜。**这条是测试发现的，不是读文档能发现的**（§4.4、决策 48/68） |
| 114 | `counters` 形态**按 project 分桶**（细化 74） | key 是 `PROJECT-N`，编号是**每项目独立**的空间；而决策 74 的文件是"每机一份"——两者结合只能是"**每机一份、内含按 project 的桶**"：`{ schema: "counters/v1", machine_id, projects: { <PROJECT>: { next, blocks: [[start,end]] } } }`。块大小 100 不变，`next` = 已发到的下一个号，`blocks` = 已领区间。**离线不撞号**由测试钉住：机器 A 领了 DH-1 后，机器 B 的第一条是 **DH-101**（进不了 A 的块）。分配必须在 **store 级锁**里做（读全仓 counters + 写自己那份）（决策 6/58/74、§5） |
| 115 | git 层的落地 | ① **首次写入时自动 `git init`**（决策 5：`.gitattributes` + `.gitignore` 与**第一次写入同一个 commit**，所以属性文件在历史里先于任何数据文件）；② 决策 81 的两个 config 键**幂等补写、绝不覆盖**；③ 提交在 **store 级锁**里做、且此时**仍持有 issue 锁**（锁序 issue→store，决策 58）；④ **提交失败不撤销写入**（文件是真相源），但必须**响**——作为 `commitError` 回给模型（决策 80 的形状）；⑤ 推送 = **防抖 500 ms 的队列**（决策 60）：写成功只 `schedule()`，会话结束/显式 sync 才 `flushNow()`；**失败只计数、不算错**、下次 flush 重试；无 remote 或 `push.enabled=false` 时静默跳过；⑥ 骨架提交用 `[no-issue]`（决策 67 的显式豁免）。**推送队列的定时器与 git 都可注入**，所以测试不等待、不联网（决策 58/60/81、§5） |
| 116 | 真机验证抓到的三件（1/2/3 的收尾） | ① **首次为某 project 领号时，种子必须取自磁盘已有文件名**——store 可能早于 counters 存在（手工建的、CLI 建的、旧版本建的），否则第一次 `create` **必然撞号**（真机上正是 `DEMO-1` 已被手工占用而计数器从 1 开始；`create` 拒绝了、没造成损坏，但功能是死的）；② **提交按 "git 自己列出的已暂存文件" 来**，而不是我们拼的路径——空目录（如 `tags/`）能通过存在性检查，但 `git commit -- <dir>` 会报 `pathspec did not match any file(s) known to git`，**提交静默丢失**；③ **store 级数据必须随提交进版本**：`config.md`（词表就是规则）、`tags/`、`counters/`（不共享就无法避免两台机器领同一段号）——只提交 issue 文件会让它们永远停在未跟踪状态；④ **提交失败必须响**：写入落盘成功但提交失败时，作为 `rejected: [{file:"git", reason}]` 回给模型（决策 80/115④），不许静默；⑤ commit 主题用**真实动作名**（`switch_state` 不再被写成 `update`），方便审计与决策 67 的 hook。**① 与 ② 都是临时目录测试永远碰不到、只有真机/真仓库才会现形的**（§5、决策 6/60/67/74/80） |
| 117 | 锁的"废弃"只看**锁目录的 mtime** | owner 文件里的 `at` 是**写入方的时钟**，任何时钟偏差都会让**活锁**被判成废弃锁删掉 → **两个 writer 同时进临界区**（并发测试实测丢了一次更新：结果 3 而非 4）。定：**新鲜度一律以锁目录自身的 mtime 为准**（文件系统的事实），`at` 只作为诊断信息随 `LOCK_TIMEOUT` 返回；回收仍是"每次 acquire 最多回收一次"，避免两个 writer 互删。`isStale(owner,…)` 保留但**只用于诊断**（决策 58/59、§5） |
| 118 | 人机两侧的界面落地 | ① **`/jira` 命令**（`status`/`list`/`board`/`new`/`doctor`/`sync`），**复用 CLI 的解析器与 core 查询**，所以两个界面不会对同一句话有两种理解；② **三个技能随包发布**（`skills/*.md` → `ctx.skills.register({source:"runtime"})`），`apply` **改为 async 并 await 注册**——不 await 会与宿主首次读取技能目录抢跑（真机实测技能列表为空）；③ **CLI 十个子命令**（`init`/`get`/`list`/`board`/`new`/`comment`/`switch`/`sync`/`doctor`/`help`），决策 83 的"CLI 是工具超集"由此成立；④ **会话结束**用 `agent/created` + `agent.ctx.effect(...)`，且冲刷**有 3 s 上限**（宿主关闭宽限只有几秒）；没推上去不算丢——提交在本地，下次重试；⑤ `ack_conflict` **先确认再执行动作**：顺序反了，算出来的新 issue 仍带着 `conflicted: true`（测试抓到的）；⑥ doctor 的评论 id **只在同一文件内要求唯一**（决策 68 的编号是按 issue 文件的，跨文件重号正常——真机误报过）；⑦ 提交清单含 `README.md`（否则工作树永远脏）；⑧ board 默认隐藏已关闭，但**必须说明隐藏了几条**（否则人以为"没活了"）。**②⑥⑦⑧ 都是真机跑出来的，不是想出来的**（决策 55/83/88/100/101） |
| 119 | store = **共享云端数据仓的一个克隆**；机器身份在 store 之外 | ① **一台机器接入 = `jira init --remote <url>`**：目录不存在就 `git clone`（历史、词表、**别的机器已领的号段**一起到位）；已存在就接上 origin，`--pull` 时 `--ff-only` 快进（**分叉只报告 refused，绝不 force**）；无 remote 时退回本地自建（离线情形）。② **机器身份放 store 之外**（`\$DSH_HOME/dsh-jira/machine-id`，首次自动生成 `m-<8hex>`）：store 现在是克隆，身份放进去就会**跟着克隆跑到别的机器**，而两台机器共用一个 id 会共用 `counters/<id>.json` → **撞号**；解析顺序 = 配置 > `DSH_MACHINE_ID` > 文件 > 生成；**主机名故意不用**（重装系统会变、容器会重名）；**绝不以当前目录为回退**（曾因此在插件仓里造出一个 `.dsh/`）。③ **插件只做"指远端"这件本地事**（`ensureRemote`，幂等、不联网、不克隆不快进）——写路径任何时候都不依赖网络，克隆/快进属于 `jira init` 这种显式动作。④ profile 里只需 `config.remote`，`root` 走默认 `\$DSH_HOME/jira`。**多机验证**：第二台机器克隆云端仓后建出 `DEMO-101`（A 机器领的是 [1,100]），证明"离线不撞号"在真实云端数据上成立（决策 6/58/73/74、§5） |
| 120 | 第 11 个 CLI 子命令 `generate [--check]`（细化 118；生成器接线） | ① `generate` 写四个生成物（`BOARD.md`/`index.md`/`log.md`/`tags/index.md`，决策 87 的版式 + 决策 79 的头部）；`generate --check` **不写任何文件**、只报 stale 并以**退出码 1** 让 CI 判定（决策 39 要求「提交前 / CI / `/jira` 体检」三处可用）。② **幂等是契约**：内容未变时**保留原有 `generated_at`**、文件字节不变——否则 CI 的「重跑 + `git diff` 为空」每次都会失败，新鲜度断言就毫无意义。③ 每个头部都带 `source_tree`，所以**任一输入变化会让四个文件集体 stale**（决策 79 的本意：不许在输入已动时自称新鲜）；只有 `log.md` 的输入是**提交历史而非文件**，其头部哈希**无法自证**，只能靠「重跑 + diff」——`doctor` 对它只报「缺失/无头」、**不报过期**（否则永远告警）。④ `doctor` 新增三种告警 `generated-missing`/`generated-unmarked`/`generated-stale` + 摘要里的 `generatedStale` 计数。⑤ **落到实现时抓到的 bug**：`tags/index.md` 是生成物，而 `loadTags` 把 `tags/*.md` 全当注册表读 → 于是「生成了一个叫 `index` 的 tag」，第二次计划立刻认为内容变了、四个文件**永远 stale**；两处（`io.ts` 的 `isGeneratedInput`、`store.ts` 的 `loadTags`）都必须排除生成物（决策 39/79/87、§3.1） |
| 121 | 第 2 个常驻工具 `jira_list`（实现决策 53） | 参数 `project?/status?/tags?/assignee?/link?/limit?/include_closed?` → `{ items, groups, counts, truncated, limit, writable, me, rejected? }`。**顺序就是契约**：project → `statuses[].order` → priority 升序（S1 先）→ `updated` 倒序 → 同级按 key（**顺序必须是全序**，否则列表会自己抖）；**被阻塞的抽成一组放最后**，且 `items` 与 `groups` 读出同一个次序。② **阻塞判定只有一处**：复用 `core/generate` 的 `isBlocked`（`is_blocked_by` 目标未关闭**或找不到**都算被阻塞），所以看板与列表不会对"能不能做"有两种说法。③ `limit` 默认 20、上限 100（决策 53），**counts 描述的是过滤后的全部**而不仅是返回的那些（`matched/returned/remaining/byStatus/blocked`），截断时模型必须被告知还剩多少。④ `tags` 是**全部命中**（收窄语义）；`assignee: "me"` 由调用方解析成会话身份（无身份则报错，不猜）。⑤ **只读**，所以子代理也能用（决策 38/89）。⑥ CLI 的 `list` 走同一套排序与收窄参数（决策 83 的超集），两个界面不会对同一句话有两种理解（决策 53/89、§6.1） |
| 122 | **测试也必须被类型检查**（补 `tsconfig.test.json`） | `tsconfig.json` 为让 `dist/` 只含交付代码而 `exclude` 了 `**/*.test.ts`，副作用是**测试从未被类型检查**：本轮就有一个"用了没 import 的名字"（`LIST_TOOL_NAME`）顺利通过 `pnpm check`、直到运行时才炸。定：新增 `tsconfig.test.json`（extends 构建配置、`noEmit`、只排除 `dist/node_modules`），`pnpm check96 两个配置都跑；开启后**当场暴露 18 个潜伏类型错误**（品牌类型 `IssueKey`、`exactOptionalPropertyTypes`、只读数组 `.sort()`），已全部修掉。**教训：排除某个目录/文件集合时要问一句"那谁在检查它们"**（决策 66） |
| 123 | 宿主的两条运营事实（真机实测，2026-10-16） | ① **`dsh` 不导出 `DSH_HOME`**：它按 `~/.dsh` 推自己的 home，所以插件的根目录解析必须有**用户目录回退**（否则工具只在终端里能用、在 GUI 里全报 `cannot resolve the store root`——真机就是这么发现的）。② **web profile 的 hmr 只监视配置、不监视模块文件**：base bundle 给它的配置是 `root: []`（原话 *"Module watch roots; an empty list leaves only explicit configuration watches"*），默认值本是 `['.']`。所以**改配置/patch 是热的，改插件代码必须换进程**——刷新页面/新开标签/新开会话都没用（工具注册在宿主*进程*里，那些动作只换浏览器那一侧）；判据是"报错点名的行号在新构建里对不上"。**正解：把本包根目录纳入 `hmr.root`**（写在 profile 的 `cordis.patch.yml`，配置变更本身即热生效），纳入后**实测 3 秒内热重载**、新工具无需重启即可用。**验证手法**（不依赖 GUI）：把 store 的 origin 故意改错 → 重新构建并触碰 `dist` 里的文件 → 若几秒内 origin 被插件自动纠正，就说明模块被重载、`apply` 重新执行了。③ 配套事实：宿主拒绝 schema 时**静默不激活整行**（只 warn），所以"工具没出现"要先看有没有 `did not activate`（决策 101/108/110、HANDOVER §6） |
| 124 | `jira_kb` 的落地（实现 54/75/82） | ① **key 与域互相独立**：文件是 `knowledge/<域>/KB-<n>.md`，key 是**全局 `KB-<n>` 编号**（走 counters 的 `KB` 号段），域只是目录——所以**按 key 读要扫各域**（库本就该小，决策 85 的索引触发条件不变）。② **来源四件套由 store 记录、不由模型填**：`machine_id` 取自会话身份（**`human:` 身份没有机器 → 回退到 store 的机器 id，绝不拿人名当机器**）、`os` 取 `process.platform`、`tool` 固定 `dsh`、`captured_at` 取写入时刻——这正是审计结论（血缘不可信）的对策。③ **读宽容/写严格**（决策 49）照旧：缺字段→警告并降级；未知键/非法 `type`/源是文件却没 `source_sha256` → **拒绝且一个字节都不写**。④ search 的 `counts`（`matched/returned/remaining`）与 `jira_list` 对齐，让"被 top_k 截断"永远可见；命中给 `file:line` + ≤200 字片段，**绝不回整篇**。⑤ `notFound` 支持类别（KB 说 "knowledge entry" 而不是 "issue"）。⑥ 排序末位 tiebreak 用 **key**（同分不抖动）；recency 用 `captured_at`（实体里没有 `updated` 字段）。⑦ `knowledge/<域>/index.md` 是**生成物**，绝不当作条目读（与 `tags/index.md` 同一课，决策 120 ⑤）。⑧ `create` **不要 key**（key 是分配来的），`update` 才要——写成"凡写都要 key"会让 create 一开始就死（测试抓到）（§4.13、§6.1、决策 29/54/75/82） |
| 125 | CLI 增加 `update` 与 `kb`（决策 83 的"超集"兑现）；`/jira` 的写命令**保留** | ① `jira update <KEY> --summary/--priority/--tags/--note/--body/--kb-refs`：补上七个动词里缺的一个（此前 CLI 只有 `comment`/`switch`）；`--kb-refs` 是决策 75 双向引用的 **issue 侧**（KB 侧 `issues[]` 早在 124 已可写）。② `jira kb get/search/create/update`：决策 83 点名的 `kb` 命令，与工具共用 `core`。③ **知识 key 的判据是"号段"而不是形状**：`DH-1` 与 `KB-1` 形状相同，所以 `asKnowledgeKey` 现在要求 `KB-` 前缀（一处定义、三处复用），否则 `kb_refs: [DH-1]` 会被当成合法引用（测试抓到）。④ `kb_refs` 写侧**只校验形状**：悬空引用由决策 94 的 `jira lint` 报，不在写路径上拦（记入 C8）。⑤ `/jira` 仍是**写**命令（`new`/`sync`）：与决策 83 的"只读"表述有出入，**明确选择保留**——`/jira` 是人在自己的账本上操作，与 CLI 同级；改成只读会让人少一条捷径，而"零模型 token"这个原始理由并未被违反（§6.1） |
| 126 | `jira lint` / `jira machines` / `doctor` 的两个量（实现 C7/C8/C9 的一部分） | ① **`jira lint` 只管结构合法性**（决策 94 与 §11.6 的界线）：词表成员（`status`/`issue_type`/`priority`/`tags`/`kb_types`）、**悬空引用**（issue→issue link、issue→`kb_refs`、KB→`issues[]`）、读不出来的文件；**明确不管策略**——"被阻塞却已认领"与"关闭却没有 resolution"都**不报**（两条都有测试钉住，因为一个乱报的 CI 会失去信任）。输出给 `path` + `code` + 退出码 1，供 CI 与提交前用。② **`jira machines list|label`**（决策 91）：`machines/<machine_id>.md`（`schema: machine/v1` + `label`/`os`/`first_seen`/`note?`），`first_seen` 只在首次写入、**重新登记不移动**；显示规则只有一处（**有 label 用 label，否则 id 前 6 位**）；未登记时 `doctor` 提示一条（决策 91 的"一次性提示"）。③ **`doctor` 补上决策 85 的两个量**：KB 扫描的 p95（5 次取最慢，且**明说这是温度计不是基准**）+ store 文件数，对照 **200 ms / 5000** 的阈值直接给 `scan is fine` / `evaluate an index` 的判定——这是"该不该上索引"的**唯一依据**，此前是空的。真机实测 **p95 ~1–3 ms、文件 22**（余量约两个数量级）。④ **C8 随本条消解**；C7 剩 `project`/`hooks`/`verify-commit-msg` 与 `tags lint`（后者三段报告属决策 86，未做）；C9 剩 `kb_refs`↔`issues` 一致性（§4.13、§6.1、决策 85/86/91/94） |
| 127 | 提交绑定落地（`verify-commit-msg` / `hooks`）、`tags lint`、`project`、以及 C9 的一致性检查 | ① **提交绑定**（决策 67 落地）：key 正则同前；**"存在"的判据是整个账本**——issue key **并上知识 key**（`KB-1: kb create` 正是 KB 写入的提交，只认 issue 会把自己的提交拦下来）；`[no-issue]` 必须在**首行**；`Merge`/`Revert`/`fixup!`/`squash!` 豁免；`prepare-commit-msg` 从分支 `DH-12-…` 取 key 前缀（作者已写 key 或有 `[no-issue]` 时不动）。② **hook 是 Node 薄壳**（决策 67），三条实现要点：**在运行期**判断是否存在被保留的 hook（安装时判断的话，"之后才出现的 backup"就永远不会被链式调用——测试抓到）；按 **shebang 选解释器**（Windows 上被保留的 hook 多半是 `#!/bin/sh`，直接交给 node 会 EFTYPE，那会让"本来就有 hook"的仓库**每次提交都失败**——回归测试钉住）；解释器在**安装时解析好并嵌进 shim**，因为 Windows 的 PATH 里没有 `sh`、而它的 `bash.exe` 往往是 **WSL**（跑不了 Windows 路径的脚本），真正的 shell 在 `git --exec-path` 上溯三层的 `bin/sh.exe`。跑不起来的 backup → **告警但不拦人**。③ `tags lint`（决策 86 落地）：固定三段（≤1 次使用 / 缺 description / **Dice ≥ 0.7** 的相似对，对**内部按字典序固定**），**只报告不自动改**；0.5 是"建议 tag"的阈值、0.7 是"词汇重复"的阈值，两者不同（测试对比着钉住）。④ `project`（决策 77/92 落地）：`project.md` **不存 key**（目录名即 key）；remote 规范化把五种写法折成一种（小写/去协议认证端口/剥 `.git`），身份取 `upstream > origin > 字典序`；`paths[]` 只是缓存（绝对 + Windows 小写 + 反斜杠），`rebind` **只动 paths**。⑤ **C9 收口**：`doctor` 增加一致性检查——`kb_refs`↔`issues` **单边引用**（决策 75 的两面只写了一面）与**被引用却没登记的机器**（决策 91）；悬空引用仍归 `lint`（分工不重叠）。⑥ 真机：hook 已装进 store 仓库，`machines label` 提交成功、无 key 的提交被拒且 HEAD 不动、未知 key 被拒（§6.7、决策 67/77/86/92/94/126） |
| 128 | CLI 的命令形状（C5 收口）：**混合式**，并补齐缺的两个动词 | ① **实际形状**：issue 的七个动词做**顶层动词**（`get` / `new` / `update` / `switch` / `comment` / `link` / `assignee`），多动作的名词做**分组命令**（`kb get|create|update|search`、`tags lint`、`project list|bind|rebind`、`machines list|label`、`hooks …`），运维类平铺（`init` / `generate` / `sync` / `doctor` / `lint` / `verify-commit-msg` / `help`）——即决策 83 的"超集"目标不变，只是拼写不同。② **命名差异是刻意的**（决策 55：人面可以舒服）：tool 的 `create` 在 CLI 是 `new`、`switch_state` 是 `switch`、`assignee: self|none` 是 `--set self|none`、`link {type,target,op}` 是 `--type/--target/--remove`。③ **这次比对抓到一个真缺口**：CLI 一直**没有 `link` 与 `assignee`**，而决策 83 要求 CLI 是七动词的超集 → 已补齐（现在七个动词齐了）。④ **漂移防护**：新增 `src/surfaces.test.ts` 把**已注册 tool 的 action 枚举**与 `COMMAND_NAMES` 对比——映射必须**穷尽**、每个命令必须出现在 usage、命令清单本身也被钉住（以后加命令就是一次会影响文档的动作，这正是 C5 要的机制）（§6.1、决策 50/55/83/125） |
| 129 | `lint --keys`（决策 94 的第二块支撑）与 `board --html`（决策 87 的 P1）；并把烟测变成可重复的脚本 | ① **`jira lint --keys [--compare <root>]`**：按 project+key 列出**本仓的 key 清单**；带 `--compare` 时给出归并真正需要看的四组——**同 key 但 summary 不同（真冲突）**、同 key 且 summary 相同（大概率是同一条记了两次）、只在此处、只在彼处。**归并工具本身仍不做**（决策 94：MVP 不做），映射表依旧是人写在 `_merge/` 里的文件 ✓。② **`jira board --html [--out FILE]`**：**自包含**静态文件——内联 CSS、**没有 script、没有任何外链**（因此能离线双击打开、能提交进仓、能走 GitHub Pages ✓）；分节与 Markdown 看板同源（每个未关闭状态一节按 `order`、被阻塞单独一节、已关闭最后、每节带计数 ✓）；**store 里的文本一律转义**（summary 里的 `<b>` 只会是文本 ✓，有测试钉住）；默认打到 stdout，`--out` 才写文件——**刻意不做成 store 的生成物**，于是决策 39/120 的"四份生成物"契约不变。③ **`scripts/smoke.mjs` + `pnpm smoke`**：对着**真实 store** 走三层（人类面只读 → 克隆里的完整写入生命周期 → 提交纪律只看装 hook 之后的新提交），**28/30 步全绿**（真机实测 28/28 + get 一步）→ 以后"插件到底还能不能用"有一条可重复的答案，而不是靠回忆（§6.1、决策 39/67/87/94/120） |
| 130 | 注入行落地（决策 78）；并**修正其计数口径** | ① **实现**：`PromptContext`（**不是** prompt section——计数会变，动态 section 每变一次击穿一次 KV cache ✓）、注册名 `jira:store`、`order 40`、**空 store 注入空串**（宿主视空文本为"不贡献" ✓）、**5 秒复用**（扫一次约 1.5 ms，节流只为别每步都做 IO ✓）。宿主给的 provider 是**同步**的，所以文本来自缓存、后台刷新——代价是**落后一步**，收益是模型循环里零 IO。通过 `ctx.get('systemPrompt')?.context(...)` 注册（**可选服务**：宿主没有它也能正常加载 ✓）。② **修正口径（本次真机暴露）**：§6.4 原文是数 `projects/*/project.md`，但真 store 的 `DEMO` 是 `jira new` 建的、**从没 bind 过**，于是那行会显示 "0 projects" ✗——**一行与读者所见相矛盾的提示比不提示更糟** ✓ → 改为"有 `project.md` **或**至少一条 issue 的目录才算一个项目"；`readOnlyProjects` = **没有 remote** 的项目（§4.11 ✓，缺 `project.md` 同样按"无 remote"算 ✓）。③ 真机：修正后本机那行是 `[store] 1 projects · 1 knowledge · 0 open issues | read-only: 1`（1 个项目 ✓ 1 条知识 ✓ 0 个未关闭 ✓；`read-only: 1` 因为 DEMO 没有 remote ✓），且**当场就在会话的 runtime context 里生效**（hmr 热重载 ✓ 没重启 ✓）（§6.4、决策 4/9/55/78） |
| 131 | 注入行补上"**哪个账本 + 这个工作区与它的关系**"，并落地 §4.10 的只读解析 | ① 触发原因（用户指出）：只告诉模型"有个账本、多大"不够——**还要做账本与工作区的对应，工作区要能声明自己的账本是谁**。② 新格式仍**一行**：`[store] <账本名> · workspace → <项目> (<by remote|by path>) · {n} projects · {m} knowledge · {k} open issues[ | read-only: {r}]`；无法判定工作区时（全局 assembly）**只省略中间那段** ✓。③ **怎么知道工作区**：`AssembleContext.scope` **就是 agent**（宿主自己的测试是 `assemble({ agent, scope: agent })` ✓），于是 `callerCwd(scope)` 读 `session.header.cwd`（§2.5：创建时不可变的原始项目路径，设计称它是"自动归属 project 的可靠依据" ✓）；**缓存按 cwd 键控**——两个会话在两个 checkout 里必须被告知两件不同的事 ✓。④ **§4.10 的解析（只读、绝不登记）**：remote（`upstream > origin` ✓）→ 规范化 → 按 `remotes[]` 命中（**路径完全不同也算命中**，即换机器场景 ✓）；否则按 `paths[]` ✓；否则**派生** key ✓；无 remote → `by: none` + `agentReadOnly: true`（§4.10 第 5 步 / §4.11 的 owner-machine ✓）。⑤ **key 派生方向被测试纠正过**：§4.10 说"从**仓库** basename 派生，不用路径、不用机器名" ✓，我第一版从本地目录名派生 ✗ → 现在用规范化 remote 的 basename ✓，于是同一 checkout 在每台机器上派生出**同一个 key** ✓（`dsh-jira` → `DJ`、单字 `oneword` → `ON`、无字母数字 → `WS` ✓）。⑥ 真机：本会话那行 = `[store] jira · workspace → new project DPMJ on first write · 1 projects · 1 knowledge · 0 open issues | read-only: 1`，**热重载当场生效** ✓（无重启 ✓）；provider 同步 → 首次 assembly 为空、随后填充（一步延迟，已在 HANDOVER 写明 ✓）（§2.5、§4.10、§6.4、决策 38/77/78/92/130） |
| 132 | 写侧的"该拒就拒"（决策 49/46/44/48 的写入半边） | ① **未知 frontmatter 键**：解码结果带 `unknownKeys`，写事务拒绝并在错误里点名（此前是读时警告、写时**静默销毁** ✗）。② **未知/未来 `schema`**：解码结果带实际 `schema`，写事务拒绝覆写（此前只警告，下一个写入者就把 v2 覆写成 v1 ✗）。③ **CAS 类型化**：`transact` 新增 `expectedRevision` 选项，比较**在锁内**做（此前工具在锁外比 ✗、CLI 根本没有该 flag ✗），不符时返回 `staleRevision(expected, actual)`（`STALE_REVISION` 从死代码变成可达 ✓）；CLI 的 `--expected-revision` 放在 **GLOBAL**，五个写命令都生效。④ **身份校验**：`validateIdentity` 由"只看前缀"变严格（`agent:` 必须四段非空、`human:` 不得含分隔符），并在每个写事务里校验 acting identity——一处覆盖工具与 CLI。⑤ 两条实体（issue / knowledge）走同一套规则与同一句错误文案。⑥ 真机：CLI 的 `--expected-revision 99`（陈旧）→ 退出 1 且文件不变、`--expected-revision 1` → 成功；492 测试全绿（§4.7、§4.13、决策 44/46/48/49/52/69/71） |
| 133 | §4.10 后半段落地（首次写入登记项目）+ §4.11 的拦截（C10/C11 收口） | ① **登记**：`ensureWorkspaceProject` 在**写入**时把"未命中"的工作区登记成新 project——派生 key（重名追加数字，`brand-new` 与另一个 `brand-new` → `BN` / `BN2` ✓）、规范化 remote 入 `remotes[]`、当前路径入 `paths[]`、并按有无 remote 定 `agent_write_policy`（`shared` / `owner-machine` + `owner_machine`）✓；读取会话**仍然只读**（决策 38 ✓）。② **写入侧的 project 变成可选**：CLI 的 `new` 与工具的 `create` 不给 `project` 时，从**会话的 checkout**（`SessionHeader.cwd` ✓）推——于是注入行那句 "new project DPMJ on first write" 从承诺变成事实 ✓。③ **拦截**（§4.11/C10）：`assertProjectWritable(store, projectKey, by)` —— 项目的 policy 是 `owner-machine`、owner 不是本机、且调用者是 **agent** → `FOREIGN_MACHINE_READ_ONLY`，消息**点名归属机器**；**人类照写**、**本机自己的 agent 照写**（规则针对身份元组，不是不信任）✓。④ 接入点：工具的写路径（`transact` 调用前）与 CLI 的五个写命令（`writeIssue` 包装）——**各一处**，两个界面同规则 ✓。⑤ `project.md` 的读取对旧文件**兼容**（没有 policy 字段时按有无 remote 推 ✓）。⑥ 真机/测试：496 测试全绿，烟测 33/33；`workspace.ts` 里那个**算出来没人用**的 `agentReadOnly` 现在有了消费者 ✓（§4.10、§4.11、决策 2/5/9/77/92/119/130） |
| 134 | `pull --rebase` + 冲突标记（71/119）+ 只读会话的真信号（93）+ git 超时 | ① **冲突检测**：`core/rebase.ts` —— `fetch`（有界）→ 记下 local/upstream 与 merge base → `pull --rebase`（15 s ✓）→ **两边都动过**的 key 走正常写事务打 `conflicted: true` + 一条评论 ✓；**rebase 停住 = 只报告**（红线 1：绝不 force ✓），并且**不推**（不把未解决的 rebase 叠上去 ✓）。② `runGit` 支持超时（决策 84 的 15 s 需要它 ✓）；工具自身的 `timeoutMs` 仍未声明 ✗（留在 §11.8）。③ **只读会话的 spike 结论**：环境变量是**不存在的信号** ✗；可读的是 `agent.options.agentPreset`（宿主自己的预设标签 `preset.readOnly` ✓）→ 只读预设现在也判只读 ✓（读照常 ✓）。④ 接线：推送队列的 `pull` 钩子（CLI `sync` + 插件各一处 ✓）。⑤ 测试：真 git 双克隆三例（不同字段干净合并但打标记 ✓ / 只一边动过不打 ✓ / 同一行 → stopped 且不推 ✓）+ 只读预设三断言 ✓；503 测试全绿、烟测 33/33（§4.15、§4.16、§5、决策 4/70/71/84/93/119/132） |
| 135 | 认领租约落地（决策 25/61/§4.8） | ① 实体与磁盘：`claimedAt`/`leaseExpiresAt` ↔ `claimed_at`/`lease_expires_at`（**两个平铺标量**：frontmatter 子集不接受顶层 flow map ✓）。② 规则：认领起租（`+2 h`）、释放清租、**活跃租约挡他人**（点名持有者与到期时刻）、**过期可接管并留评论**（评论只在写事务里 ✓）。③ **续租**：`transact` 里对"本就会被写入"的 issue 续租——只延长、不缩短、**不动 revision**（租约是元数据不是主体 ✓ 决策 44），因此**零额外写放大** ✓。④ 边界：`leaseIsActive` 用定宽 UTC 串比较，**到期时刻本身算过期** ✓。⑤ 仍未做：把"已过期、可重新认领"**显式渲染给模型**（现在模型能读到 `lease_expires_at` 但要看时刻自己判断 ✗）与 `doctor` 的过期租约报告 ✗（留在 §11.8）；508 测试全绿、烟测 33/33（§4.8、决策 25/44/50/61） → ✅ **已实现（决策 140）**：`leaseNote` 把租约说出口（活跃 → lease until …；过期 → lease expired at … — reclaimable ✓），人面与模型面渲染都带上；`doctor` 也把过期认领报成 warning（`lease-expired` ✓，时钟可选所以检查仍是纯函数 ✓） |
| 136 | 认领阻塞规则落地（决策 24/25） | ① `blockersOf(store, key)` 放 `inspect.ts`（回答它需要整张 issue 表，而写事务**故意不读表** ✓）→ 结果经 `TransactOptions.blockers` 进 `ChangeContext` ✓。② 规则只在 `applyAssignee` 一处：**agent** 且未 `override` → `BLOCKED_BY_OPEN`（点名每个未关闭的 key ✓）；**人类**永不被拦 ✓；`override` 放行并附一条评论（"在仍被阻塞时认领了，显式 override"）✓。③ 两个界面都暴露了 override（工具参数 `override` / CLI `--override` ✓）。④ 512 测试全绿（§4.15、决策 24/25） |
| 137 | 会话块落地（决策 10/31/100/119） | ① `sessions/<session_id>.md`（`session/v1` + tool/model/machine/started_at/**tool_evidence**）+ 首次写入落盘、幂等、失败不影响写入 ✓。② **收尾扫描**：会话创建时记下 HEAD → 收尾时 `git log` 出本次提交 → 每个 issue 一条评论（含短 sha）→ 走正常写事务 ✓；水位线在 `$DSH_HOME/dsh-jira/session-scan/` ✓；整段有界（与推送共用收尾窗口 ✓）且异常被吞 ✓。③ **跳过纯评论提交**——否则扫描会把自己的评论提交再报一遍（测试抓到的自我循环 ✓）。④ 519 测试全绿、烟测 33/33（§4.12、决策 10/31/38/44/67/100/119） |
| 138 | tag 注册表写入路径（决策 26/76/87） | 读取半边（`loadTags` 遍历 `tags/*.md`、`lintTags` 报缺描述、`tags/index.md` 渲染成对）早就有了，**唯独没有创建入口** ✗ —— 于是注册表只能手写，而"没描述的 tag"正是决策 26 要防的。现在：`createTag` 写 `tags/<name>.md`（`tag/v1` ✓），名字小写归一 + `lower-kebab` 校验 ✓，description 必填（空/纯空白 → 拒绝且**不落盘** ✓），重名拒绝并引用已有描述 ✓，别名折叠去空 ✓；写盘后 `commitStoreWrite` 以 `tag <name> [no-issue]` 提交 ✓。CLI 命令 `tag-create` 进 `COMMANDS` 表与 USAGE ✓（surfaces 测试会盯着这两处 ✓）。测试断言的不只是"文件在"，更是**既有读取方看到的样子**（`loadTags` 的深比较 + `lintTags` 不再报缺描述 ✓）。525 测试全绿 |
| 139 | 每个 Bundle 的 index.md/log.md（决策 79 后半） | ① **动态生成集**：路径不再来自固定四个 ✗，而是 `Object.keys(render)` ✓ —— `planGenerated`/`writeGenerated`/`checkGenerated` 与 `GeneratedPlanEntry.path` 一并放宽为 `string` ✓。② **两个潜伏的"把生成物当输入"缺陷被顺手修掉**：`isGeneratedInput` 现在排除 `index.md`/`log.md`（此前 `tags/index.md` 一直被算进**源树哈希** ✗——一个由输入算出来的文件又去参与输入哈希 ✗），知识域列举也不再只挡 `index.md`（烟测抓到：lint 把 `knowledge/<域>/log.md` 当条目解析 → `file-unreadable` ✗）。③ 根 `log.md` 的条数 50 → **100**（决策 79 原文 ✓）。④ 语义确认：**每个提交日志在提交后都会 stale**（它的输入是历史而非源树 ✓ 决策 120 的不对称性 ✓）——测试与烟测都按这条改 ✓。⑤ 525 测试全绿、烟测 33/33（§4.7、决策 39/79/87/120） |
| 140 | 租约的两个尾巴：模型可见性 + doctor 报告 | ① §4.8 明写「过期只回给模型：已过期、可重新认领」——现在 `leaseNote(issue, now?)` 就是那句话 ✓：无持有者 → 不提 ✓；活跃 → `lease until <到期时刻>` ✓；**到期时刻本身算过期**（与 `leaseIsActive` 同一判据 ✓）→ `lease expired at <…> — reclaimable` ✓。人面（CLI get）与模型面（工具 render）都带上，且不传时钟时仍显示到期时刻（只是不判过期 ✓ 保持纯函数 ✓）。② `doctor`：`checkStore(snapshot, now?)` 可选传时钟 → 过期认领报 `lease-expired` warning（点名持有者与到期时刻 ✓）；不传时钟则什么都不报（纯 ✓ 决策 102）。③ 530 测试全绿、烟测 33/33 |
| 141 | 工具声明与单调 guard（决策 84/96） | ① 先**读宿主源码**确认 API 而不是猜：`timeoutMs?: number`（协作式超时预算；声明它即断言会把 exec.signal 转发给可协作实现 ✓）、`isConcurrencySafe?(args)`（只有返回 true 才并行；省略/抛错/非 true/参数非法都是独占 ✓）、`guard(guard: ToolGuard)`（任何匹配的 guard 都可拒绝，**没有 guard 能强制放行** ✓）——三条与设计意图逐字对上 ✓。② 声明：`jira_list` 5 s + 恒可并行 ✓；`jira` 30 s + 白名单并行（`get` ✓，不可归类 → 独占 ✓）；`jira_kb` 30 s（保守，不声明并行 ✓）。③ **单调 guard** 恰好一个：拦「写动作 × 不可写会话」→ 返回理由；handler 仍各自拒绝（纵深防御 ✓）。④ 因为声明超时=承诺信号，`RunOptions` 新增 `signal` 并从 `exec.signal` 传入 ✓。⑤ 测试：surfaces 新增两例（声明值 + 分类器 fail-closed ✓；guard 拒写/放读/放普通会话/不管别的工具 ✓）。532 测试全绿、烟测 33/33（宿主 0.2.1-alpha.2） |
| 142 | 第 3 档开工：CLI 帮助面中文（决策 55） | ① 范围按设计原文：**人面**中文（CLI 的 usage/帮助/人面报告、生成物、doctor/lint 人面输出），**模型面**保持英文（工具描述、错误码、JSON 键）✓。② 本片做了 CLI 的帮助面：`USAGE` 整体重写（命令语法保持原样——那是人要敲的东西 ✓，说明改中文 ✓）+ **56 条 flag 说明**（60 处出现）全部中文 ✓。③ 做法：`scripts/i18n-human.mjs` 逐条**断言命中**（找不到就报错退出 ✗，静默漏改不可能发生 ✓），先 `--dry` 看数量再真跑 ✓。④ 测试只挂了一处（断言旧英文标题 ✓），其余（含 surfaces 的「每个命令都出现在 usage 里」✓）天然通过 ✓。532 测试全绿、烟测 33/33 |
| 143 | 第 3 档第二片：CLI 运行时人面消息中文（决策 55） | ① 把 CLI 的**结果行**与**用法错误**共 35 处翻成中文（created / updated / commented / linked / unlinked / assigned / released / written / registered / restored / push 等），数据部分（key、状态名、路径、类型名）保持原样 ✓。② 新增 `scripts/i18n-tests.mjs`：把断言旧英文输出的测试**同样逐条断言**地改过来（找不到就报错 ✗）——13 处失败全部落在『测试断言英文』上，没有一处是行为错 ✓。③ **修正（决策 144）**：本片声称「CLI 运行时消息已全中文」是**说过头了** ✗ —— 还有 `unknown command/flag`、`jira init` 四行、`jira generate`、`jira hooks` 详情、`KB-1 created`、`N comment(s)`、`--limit` 提示、`/jira` 自身消息等仍是英文 ✗，已列入第 3 档第四片。④ 过程中脚本两次**按设计报错拦截**：一次是表里写了不存在的写法 ✗，一次是中文不该在全角括号前留空格 ✗（CLI 输出没有空格，测试也必须去掉 ✓）。④ 532 测试全绿、烟测 33/33 |
| 144 | 第 3 档第三片：渲染器 + 生成物中文，以及两处**共享渲染器**的 locale 拆分 | ① 渲染器（doctor / lint / perf / tagsLint / keyset / machines / project / boardHtml）与生成物（BOARD / README / index / log / tags/index / 每 Bundle 的 index+log）的人面散文中文化 ✓；**诊断载荷**（Problem.message / lint finding / JiraError.message）**保持英文** ✓ —— 它们同时出现在 `--json` 与工具返回值里，属机器面 ✓；生成物的数据、表头、`generated by dsh-jira … do not edit by hand`、`generated_at/source_tree` **一字未动** ✓。② **关键结构**：`renderIssueHuman` 与 `renderKbSearch` **同时服务人面与模型面** ✗ → 拆成 `locale: 'en' | 'zh'`（**默认 en** ✓）：插件调用点一字未改（仍英文 ✓，并有脚本守卫断言 `src/plugin` 里不含 `zh` ✓），只有 CLI 传 zh ✓；数据（key/状态/优先级/身份/时刻/链接类型）两种语言完全一致 ✓。③ 脚本纪律升级：能替换的走断言表 ✓；**必须留下的英文**改用 `LOCALE_PAIRS` **成对校验**（英中缺一即报错 ✓）+ `MUST_STAY_ENGLISH` 数据守卫 ✓；脚本两次按设计拦住实施者。④ 测试 532 → **536**（+4 用例），8 个测试文件 47 处断言改写 ✓；其中一处 `findIndex` 断言不改形状会**恒真** ✗，已修正并补进表 ✓ —— 这正是逐条断言的价值 ✓。⑤ 烟测 33/33、build 0、真机 doctor 输出「没有发现问题／账本：1 个项目，2 条 issue…／结果：正常（0 个错误，0 个警告）」✓ |
| 145 | 第 3 档第四片收尾 + 分层守卫 | ① 补完上一片漏掉的 53 处人面文案：` cli/args.ts ` 的解析器消息、` jira init/generate/hooks ` 的散文、` N 条评论 `、` --limit ` 提示、五个「未知的 … 动作」、` 读不到 file `、` ! machines-unlabelled `、以及 ` /jira ` 的 21 处。② ` args.ts ` 连同测试从 ` cli/ ` 搬进 ` core/ ` —— ` /jira ` 复用 CLI 的参数解析器，方向是 plugin 到 cli 的反向依赖，被新写的**边界守卫当场抓到**，现在两个适配层都从 core 拿。③ 新增 ` scripts/check-boundaries.mjs ` 并接进 ` pnpm check `：决策 108（绝不导入宿主包，只允许 ` node: ` 与相对路径）+ 分层（core 不依赖适配层、cli 与 plugin 互不依赖）+ §3.1 ①（只有 git 钩子 shim 与两个入口可直写 ` console `）。它是**源码扫描而非解析器**，脚本头写明取舍与何时该升级为真解析。④ ` scripts/i18n-tests.mjs ` 加**重复键守卫**：JS 对象字面量会静默保留同名键的后一个，会让同一文件的第二张表悄悄取代第一张。⑤ 536 测试全绿、build 0、烟测 33/33、` boundaries: 52 source file(s), no violation ` |
| 146 | store 的提交身份 | **缺失时按次注入** `-c user.name=dsh-jira -c user.email=jira@local`，**绝不写进仓库配置**。CI runner / 全新机器 / 容器上没有可用身份，`git commit` 报 `Author identity unknown`；而**文件写入是成功的**，于是台账看起来健康、**git 里却什么都没有**（无审计、无 `git revert`、无跨机同步，`log.md` 永远拿不到提交）。不写入仓库配置是因为 `user.name` 同时是 §4.9 `human:<name>` 的来源，写进去会把人名静默换成 bot；机器已有身份时**保持不动**（决策 81 的"只补缺失"）。由插件自己的 CI 发现（2026-10-16），复现条件 `user.useConfigOnly=true`（§5、§4.9、决策 79/81/115/87）。**补记（2026-10-17）**：§4.13 规则 1 的"收编"提交也走这条回退——有身份时 `--author` 把人类保留为作者，无身份时作者即 `dsh-jira`（决策 147）。**补记二（2026-10-17 深夜，CI 抓出）**：适用范围**不止提交**——`git pull --rebase` 重放提交时会**创建**提交，同样需要身份，否则以「提交者身份未知」停住并把账本留在 rebase 中途（本机因 git 能猜出身份而全绿）。`core/rebase.ts` 现在用同一个 `identityArgs`（决策 119/148） |
| 147 | §4.13 规则 1 的落地（收编人的未提交改动） | 写事务前与会话结束重生成前，先 `git add -A` + 把脏工作区作为一个**独立提交**提交掉，**作者保留为人类**（`git config user.name`/`user.email` → `--author`），主题 `chore: 收编工作区里未提交的人工改动 [no-issue]`；**收编失败则拒绝该次写入**，不在未落定的工作区上继续写。理由：决策 79 的 `source_tree` 哈希的是**工作区内容**（刻意如此），所以"提交了生成物、却没提交它据以生成的改动"会断言一个自己提交里并不存在的 `source_tree` —— store 的 `generate --check` 会在下次推送时拒绝（2026-10-17 用全新检出实验证实）。这条红线此前一直没实现，是我在自检里发现的（§5、§4.13） |
| 148 | **重生成的时机 = 每次推送之前**（`pull --rebase` → 重生成+提交 → push） | 推送队列的 `settle` 钩子（`core/push.ts`，排在 `pull` 之后、`push` 之前；**失败则拦住推送**）、插件的会话结束 effect（把 `writable` 作为 `flushNow({ settle })` 传进来）与 CLI 的 `sync`、`regenerateAndCommit`（core 只写一次）、决策 15/34（生成权在 DSH 进程内）、决策 39/66/79（新鲜度断言与 `source_tree`）、决策 119/134（先 pull 后 push）、决策 60（防抖推送）、决策 89/93（只读会话不写）、决策 147（收编先于一切）。**被否掉的两个方案也记在这里**：① "折进每次写入的那个提交"——对 `log.md` **不可能**（写入提交是 keyed 的，`log.md` 一提交就过期，文件不能含自己提交的哈希）；② "每次写入两个提交"（多一个 unkeyed 生成物提交）——可行，但让**每个**生成物提交都参与跨机 rebase 合并，而生成物必然两边不同（`generated_at`/`source_tree`），实测旧用例的"干净合并"直接变 stopped。**代价（已接受）**：本地工作区在两次推送之间仍可能过期；无 remote / `push.enabled: false` 不在此路径重生成。**落地当晚 CI 又抓出一条**：settle 排在 `pull` 之后，所以 pull 一停则**整条链都不发生**——而 `pull --rebase` 在猜不出 git 身份的环境上会停（决策 146 的补记二） |
| 149 | **结果信封统一**：失败也带 `me`（56/82）；部分读取带 `message`（80）；`rejected.file` 是真的路径 | ① **失败也带 `me`**：`plugin/index.ts` 的 `failure()` 原来只有 `ok:false/error/writable/reason?` —— 而「我是谁、为什么不能写」恰恰是失败要回答的事（§4.9/§4.12 的身份四元组），模型不该只能从成功的调用里学到自己是谁；`me` 因此进了三个工具输出 schema 的 **required**（`['ok','writable','me']`），那条测试也从「只比对 required 数组」改成**真的检查取值**（读、拒读、拒写三种形状都查）。② **部分读取带 `message`**：决策 80 要求「`rejected` + 一句话说明被跳过了」——原来只有 `rejected`，于是「丢了一半 issue 的看板」看起来是完整的。现在 `skipped(rejected, 'read'|'write')` 一个收口产出两者，读与写（写了但提交失败）各说各的英文句子（模型面英文，决策 55）。③ `jira_list` 的 `rejected.file` 由字面量 `'issues'` 改成**真的路径**（`listIssues` 的 broken 行本来就是 `<path>: <reason>`，在这里拆回两半，没有为它改 `core/inspect` 的返回类型）。④ 测试 552 → **553**，两处变异验证（拿掉那句话 → 部分读取用例失败；拿掉失败里的 `me` → 信封用例失败）。（决策 55/56/80/82/115、§6.1/§6.2） |
| 150 | **机器显示规则接线 + 一次性提示**（决策 91 的落地） | ① `machineDisplayName` 不再是死代码：`renderMachines` 的第二列改用这条规则（有 label 用 label，没有就用前 6 位 id），`（无 label）` 不再出现——它本来读了等于没读。② 提示改成**每台机器一次**：句子由纯函数 `machinesHint(records, self)` 给出（`core` 不持状态，§3.1），「只出现一次」由 **CLI 的标记文件**负责：`<机器状态目录>/notices/machines-label-<id>.seen`；`--json` 永不带散文（stdout 要可解析）。③ 机器状态目录的算法收进 `core/machine.ts` 的 `machineStateDir`（原来插件里有一份私有实现），插件与 CLI 共用一处。④ 测试 553 → **555**；变异验证：让标记永远不抑制 → 用例失败。（决策 73/91、§4.11、§3.1） |
| 151 | **SystemAdapter**：跨平台行为只许出现在一个适配器里 | ① 起因：同一天里「Fedora 绿 / Windows 红」，修完 Windows 又「Fedora 红」——三次都是**平台事实漏进调用点**：`node:os.devNull`（Windows 上是 `nul`）被当成「空配置文件」，于是 Windows 的 git 之后每条命令都 `fatal: unable to access '//./nul'`（本次两条红测试的真因）；路径规则按**宿主**而不是**记录该路径的机器**选；测试清理目录的退避策略按平台表现不同。② 规则：**凡是行为依赖 OS，就只能是适配器的成员**，调用点问适配器、不问 `process`。`core/system.ts` 暴露：`facts`（platform / isWindows / devNull / gitConfig）、`normalizePath(input, fromPlatform)`、`samePath`（Windows 大小写不敏感、POSIX 敏感）、`gitEnv(base)`（**剥掉** `GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE / GIT_OBJECT_DIRECTORY / GIT_ALTERNATE_OBJECT_DIRECTORIES / GIT_COMMON_DIR` —— `-C root` 是唯一权威，钩子 / CI / 用户 shell 里的残留会悄悄把台账的写指向别的仓库；**保留** `GIT_CONFIG_*`，因为故意配置 git 是正当需求）、`removeRetries / removeDelayMs`。③ **刻意不是上帝类**：只放**事实**与**纯派生**，不持有 store、不做文件 IO、不自己跑 git ✓；因此 `systemFor('win32')` 与 `systemFor('linux')` 能在**一台机器上同时跑两个平台的规则** ✓ —— 这才是终结两边来回试的关键 ✓。④ 已收编：`runGit` 的子进程环境、`initializeRepository` 的配置表、`normalizePath` 默认平台、`kbstore` 的 os、插件 origin、钩子解释器选择、三个测试文件的清理退避。⑤ 同一提交修掉两个**真 bug**：`regenerateAndCommit` 把 `commitStoreWrite` 的**软失败**（`ok({committed:false})`）当成功 ✗（决策 148 要的正是推出去的与源一致），并加**跨平台可复现**的回归用例（`.git` 是个普通文件 → `git init` 必失败）；测试里的空配置从设备路径改成**真空文件** + `GIT_CONFIG_NOSYSTEM=1`。⑥ 刻意保留：钩子**脚本内部**仍读 `process.platform`（那是钩子运行时读自己所在机器 ✓）。⑦ 565 测试全绿（556 → 565，新增 9 条适配器用例 ✓）、build 0、烟测 33/33、`boundaries: 53 source file(s), no violation`。 |
| 152 | **同一段用例在两个平台规则下各跑一次**（配合决策 151） | ① 只把平台事实收进适配器还不够 ✗ —— 还得让**平台敏感的用例**能在同一台机器上两种规则都跑 ✓。新增 `src/testing/bothPlatforms.ts`：`bothPlatforms(name, async (system, platform) => …)` 把同一段 body 跑两遍（`systemFor('win32')` 与 `systemFor('linux')`），用例名带平台 ✓。② 平台敏感的函数改成**可注入平台** ✓：`bindProject/rebindProject/renderProjects` 的 input 增加 `platform?` ✓、`resolveWorkspace(..., platform)` ✓。③ 比较逻辑从**字符串相等**改成 `samePath` ✓：`paths[]` 是**在一台机器写、可能在另一台比**的缓存 ✓ —— Windows 上 `d:/Work/Repo` 与 `d:\\work\\repo` 是同一个工作区 ✓，POSIX 上 `/work/Repo` 与 `/work/repo` 是两个目录 ✓。④ **夹具第一次跑就抓到一个真 bug** ✓：`bindProject` 里用了**模块级** `system`（= 宿主平台 ✗）而不是按 `input.platform` 造的那个 ✗ → Windows 规则被错误地用到 POSIX 输入上 ✓；已修 ✓（这也是这套夹具价值的直接证据 ✓）。⑤ 569 测试全绿（565 → 569，新增 4 条双平台用例 ✓）、build 0、烟测 33/33、`boundaries: 54 source file(s), no violation`。 |
| 153 | **System 模块化 + 范围扩大**（路径 / 平台 / 参数 / 目录 / git / 策略） | ① 从单文件 `src/core/system.ts` 拆成模块 `src/core/system/{types,paths,env,git,policy,index}.ts` —— 下一处平台意外有明确的落脚处 ✓。② 范围扩大到"跨平台公共类"：`normalizePath`（按**记录平台**）✓、`toPosix` ✓、`resolvePath`（按**本地平台**解析，`--root` 这类参数走它）✓、`samePath` ✓、`safeFileName` ✓、`exceedsPathLimit`/`approachesPathLimit`（240 警告 / 平台硬上限 ✓ 决策 60）✓、`homeDir`/`stateDir`/`defaultStoreRoot` ✓、`gitEnv` ✓、写/删重试策略 ✓。③ **消掉一处已经漂移的重复** ✗：库根优先级原先有**两份**实现（`core/config` 与 CLI）✓，而 CLI 那份**丢了 `~/.dsh` 兜底** ✗ —— 现在只有 `core/config` 一处 ✓，CLI 只把失败翻成中文 ✓；同时加启动长路径提示 ✓。④ **收编过程中又抓到一个真错** ✓：`homeDir` 我一开始定义成"用户目录" ✗，而 dsh 的家是 `<profile>/.dsh` ✓（`DSH_HOME` 未设时 ✓）—— 路由测试当场红 ✓ 已修 ✓。⑤ 全仓**只剩** `hooks.ts` 里**钩子脚本内部**读 `process.platform` ✓（那是钩子运行时读自己所在机器 ✓ 正确 ✓）。⑥ 577 测试全绿（569 → 577 ✓）、build 0、烟测 33/33、`boundaries: 59 source file(s), no violation` ✓、真机 `init` 正常 ✓。 |
| 154 | **第 4 档第三片：三个潜伏项收口**（注释转义 / union 属性反向断言 / `_merge/` 的边界） | ① `core/frontmatter.ts` 的注释里那个 `\t` 曾被渲染成**真 TAB**（读出来是 `	ransitions:`）——改成纯散文，不再靠转义。② `.gitattributes` 的 `merge=union` **只属于评论文件**：原测试只正向断言「评论文件是 union」，现在**反向**断言 issue / `config.md` / `BOARD.md` 都是 `unspecified` —— 给 issue 加 union 会把两台机器的改动拼成一份不可读的 frontmatter，正是决策 5 要防的事（变异验证：把模式改成 `*.md merge=union` → 用例失败）。③ `_merge/` 是**归并时由人自建的约定目录**（决策 94 明说 MVP 不做归并工具，工具不得替人建），所以把 `keyset` 报告那句「映射表写在 _merge/」改成**精确的约定**（`_merge/<UTC>-from-<machine_id>.md`，并写明目录自建），三处断言同步更新。④ 测试仍 **577** 全绿。（决策 5/70/94/105、§11.5） |
| 155 | **`/jira` 补 `show <KEY>` 与 `tags lint`**（决策 83 的只读集合补齐） | ① 两个子命令都**只读**（决策 38）：`show` = `readIssue` + `readComments` + `renderIssueHuman(…, 'zh')`（人面中文，工具面仍英文，决策 55）；`tags lint` = `lintTags` + `renderTagsLint`，输出自带「只报告，绝不改写」。② 顺带修掉一处**参数面**的结构问题：`/jira` 一直是「子命令 + 0 个位置参数」，所以 `show DH-1` 会被解析器拒绝；现在 `show`/`tags` 各允许**一个**位置参数，其它子命令仍是 0（多写的词继续报错，不被静默忽略）。③ 用例断言两件事：非 key 报错、以及**读不写**——而且不只看 `git status`（提交型写入会让它变干净！），还比较 `HEAD` 是否前进；变异验证：让 `show` 打一个空提交 → 用例失败。④ 测试 577 → **579**。（决策 38/55/83、§6.1） |
| 156 | **长路径：启动时报错那一半落地**（决策 60/240 的收口） | ① 原来只有 `io.writeTextAtomic` 里的一句 `process.emitWarning`，加上一条只按平台硬上限告警的启动提示 —— 而设计要的是「**超限启动时报错**」。现在判据落在 `core/config.resolveStoreRoot`（**一处**，CLI 与插件共用）：根路径 ≥ 平台上限（`exceedsPathLimit`：win32 260 / darwin 1024 / linux 4096）→ `INVALID_INPUT`，点名长度、上限与平台。② 两级阈值的分工写清了：**≥240 是警告**（`approachesPathLimit`，CLI 启动时提醒，路径本身还能用），**≥平台上限是拒绝**（`resolveStoreRoot`）。③ 新建 `core/config.test.ts`（文件此前**零测试**）：优先级三档、无配置时的错误、超限被拒（并断言同一条字符串在 linux 上合法——规则不是固定数字）、以及「接近但未超限」必须放行。④ 测试 579 → **583**；变异验证：去掉长度检查 → 用例失败。（决策 60/153/240、§5 第 11 条） |
| 157 | **凡引用宿主必须标版本**（决策 98 的落地） | ① §2 开头加**核对基线**一行：本节与下文所有引用宿主源码/文档/告警原文的地方，核对于 **`@deepseek-ai/dsh-root@0.2.1-alpha.2`**（提交「docs(goal): register the branch's known limitations (task39)」）。② §8 里**点名宿主源码/文档/平面**的 7 条（84/95/96/99/100/101/141）就地补上「（宿主 0.2.1-alpha.2）」。③ 顺手修掉一处会自相矛盾的事实：决策 95 说「本机有两个宿主 checkout，一个 rc.2 一个 alpha.2」，实际现在只剩一个、版本是 **alpha.2** —— 已在该行留修正记录（peer 范围仍显式枚举两个版本以兼容旧机器）。④ 这是**文档纪律**不是行为改动，但它是审计点名的 S2 类（决策 98 的原话：凡引用必须标版本，否则过一版没人知道还成不成立）。（决策 95/98/153） |
| 158 | **号段有上限，`KEY_EXHAUSTED` 因此可达**（决策 52 的收口） | ① 起因：`counters.ts` 的 `claimKey` 永远能领到新块，所以决策 52 那 12 个错误码里的 `KEY_EXHAUSTED` **永远不可能发生** —— 一条永不发生的码是分类表里的小谎（审计点名的行）。② 现在一个 project 的号到 **9999** 为止（`MAX_KEY_NUMBER`）：再往下走 `claimKey` 返回 `KEY_EXHAUSTED`，点名 project、上限与"本会给到几号"。选有限空间而不是无限，还有第二个好处：**counters 被写坏时**不会造出 `DEMO-999999999` 这种没人想敲的号。③ 判据放在**发号前**（`start`/`next` 与上限比），不是放在块的末尾 —— 块是提前领的，否则一个块会悄悄跨过上限。④ 测试 583 → **586**（单元：超限被拒并点名三个事实、最后一个号照发；集成：磁盘上已有 `DEMO-9999` 时 `allocateKey` 返回 `KEY_EXHAUSTED`，不造 `DEMO-10000`）；变异验证：去掉上限 → 两条用例都失败。（决策 6/52/74/114、§5） |
| 159 | **JSON / 工具返回键一律 snake_case**（决策 41 的落地） | ① 一个转换点：`core/render.ts` 的 `toWire` **递归**把键改成 snake_case（只改键、**绝不改值** —— summary、身份串、路径里出现 camelCase 是内容，不是结构）。② 三个出口都走它：`renderIssueJson`、三个 tool 的**返回值边界**（`plugin/index.ts` 的 `wire`，包在 `execute` 的返回上而不是每个 builder 上 —— 新字段/新工具因此不可能漏网）、CLI 的 `--json`（`say` 的对象分支一处收口）。③ 实体内部**仍是 camelCase**（决策 41 原话：代码内部可自由用驼峰，转换发生在边界），所以 CLI 的人面文本没有一处要改。④ 三份 skill 文档**不需要改**：它们写的是**参数名**，本来就已是 snake。⑤ 测试 586 → **589**：`toWire` 的单元用例（含"值不被改写"）+ `renderIssueJson` 的键断言 + **一条走真实取值的守卫**（get / 拒读 / list / kb 四种形状，逐个键断言 `^[a-z0-9_]+$`）。⑥ 两处变异验证：把 list 工具的 `wire` 拿掉、把 `renderIssueJson` 的 `toWire` 拿掉 → 相应用例各自失败。⑥ **修正（2026-10-17 20:50，活体当场炸了）**：`wire` 把值变成 snake_case 之后，**宿主的 `output.render` 仍然按实体（camelCase）读** —— `renderIssueHuman` 读 `issue.kbRefs.length` 拿到 `undefined`，于是**每一次 `jira_issue get` 都失败**（`tool "jira_issue" returned invalid output: output.render failed: Cannot read properties of undefined (reading 'length')`），而 589 个测试全绿：**没有任何一个测试渲染过"已经 wire 过的值"**。修法：`fromWire`（对称的反变换）在三个 render 的开头还原成实体再渲染；并补上那条缺失的守卫——**对真实取值调用 `output.render`**（get / 拒读 / list / kb 四种形状），变异验证：把 render 里的 `fromWire` 拿掉 → 用例报出与活体一字不差的错误。590 测试全绿。**教训**：边界变换必须**两个方向都存在**，而且守卫要打在"宿主真正走的那条路"上，不是打在数据形状上。（决策 41/55/56/82/149） |
| 160 | **锁回收是安全的，持锁者有心跳**（DPMJ-2 / S1 的落地） | ① 问题（审计发现）：`acquireLock` 原来是「`stat` 判 stale → `rm -rf` 按路径删」，中间可以换手 —— 原持有者释放、别人刚拿到新锁，回收者的 rm 就把**新锁**删了，两个写者同时进临界区（静默丢更新；`expected_revision` 只在调用方传了才兜底）。② 现在回收**先拿 `<lock>.reclaim` 这个 mkdir 标记**（序列化回收者），拿到后**再读一次 `owner.json` 并比对**，只删「我判为 stale 的那一份」；标记若因回收者崩溃而留下，按 stale 清理并**在同一次调用内重试一次**（只在下次调用再试，会让中间所有写者超时）。③ **心跳**：`withLock` 持锁期间每 `staleMs/3` 写一次 `<lock>/heartbeat`，`staleSince` 取「目录 mtime 与心跳 mtime 的**较新者**」—— 临界区含多次 git 子进程，Windows+杀软下可能超过 60 s，以前会被误判为遗弃（这正是丢更新的根因）。心跳**只在本锁仍属于自己时**才写（丢了锁的进程不能替新主人续命），定时器 `unref` 并在 `finally` 清理（不能因为握着锁就让进程活着）。④ 顺手（审计的 S3）：`owner.json` 写失败时把刚 `mkdir` 的目录删掉 —— 否则留下一个「新鲜但无主」的锁，没人会回收它，所有写者只能超时。⑤ 测试 590 → **592**（标记被占时不得删锁 + 崩溃遗留的标记可清理并重试；心跳让慢临界区不被回收，含"目录很旧但心跳新鲜"）；两处变异验证：改回按路径删 → 标记用例失败；忽略心跳 → 心跳用例失败。（决策 58/59/61、§5、账本 DPMJ-2） |
| 161 | **会话结束的收尾扫描也要过写权限**（DPMJ-3 / S1 的落地） | ① 问题（审计发现）：会话结束 effect 里 `mayWrite` 只守住了 `regenerateAndCommit`，`closeOutSession` **无条件执行** —— 而它会 `transact` 追加评论并提交（`sessionScan`），与它上方那段"只读会话连这里也不写"的注释**直接矛盾**。② 触发不是理论上的：只读/子代理会话存活期间若有人（主会话、CLI、另一台机器）提交了提及某 issue 的 commit，该会话结束时就会越权写账本，评论还被标成那个只读会话的 id。③ 修法：把 `closeOutSession` **并入 `mayWrite` 分支**（连同 `regenerateAndCommit` 一起，只有在"可写 + store 可解析 + 有 sessionId"时才跑）；只读会话因此连扫描和 watermark 都不碰。④ 测试：**成对**用例 —— 只读会话结束时「没有 BOARD.md、历史条数不变、评论文件不存在、连 watermark 都没有」，可写会话则**确实**写下评论与 watermark（正例是让负例有意义的那一半）。⑤ 顺带修正测试夹具：`effectHost` 拆出 `deliver()`，因为 `headAtStart` 是在 `agent/created` **送达时**捕获的 —— 先送达、再落一条提及 issue 的提交、最后结束会话，才真正复现"会话存活期间有人提交"这个条件（否则扫描本来就没东西可扫，负例是假绿）。⑥ 变异验证：把扫描移出 `mayWrite` → 只读用例失败。测试 592 → **594**。（决策 31/89/93/100、§4.12） |
| 162 | **项目键是路径片段，因此先校验再拼路径**（DPMJ-4 / S1 的落地） | ① 问题（审计发现）：`/jira new --project ../../tmp/x` 与 CLI `new` 只做 `toUpperCase`，没有校验，而下游 `store.ts` 的 `highestExistingKey`/`storePaths.issue` 直接把这个字符串 `join` 进路径 —— 于是可以在**账本之外**写文件。工具面其实早就有 `/^[A-Z][A-Z0-9]{1,5}$/` 的校验，命令面与 CLI 漏了。② 修法（**下沉到 core，谁漏都不行**）：`core/entity` 新增 `PROJECT_KEY_PATTERN`/`isProjectKey`，`store.ts` 的 `createInStore` 与 `allocateKey` 在**任何路径或 counters 条目被拼出来之前**校验（`allocateKeyLocked` 承接原逻辑）；CLI 与 `/jira` 的 `new` 用同一个 `isProjectKey` 给出人话错误（本地化消息在面上，英文消息在 core 兜底）。③ 一条模式同时挡住 `..`、`/`、小写、`A-B`、超长 —— 这正是 `projects/<key>/` 能安全当目录名的充分条件。④ 测试 594 → **597**：core 用例对五个坏键逐一断言**拒绝 + 账本外什么都不多**（父目录条目仍是 `[store]`）；CLI 与 `/jira` 各一条（退出码 2 / 人类消息）；⑤ 两处变异验证：去掉 core 的校验 → core 用例失败；去掉 CLI 的校验 → CLI 用例失败（core 兜底仍在，所以 exit code 与消息的形状也会变——这正说明两层都在起作用）。（决策 6/44/48/50/133、§4.10） |
| 163 | **CLI 命令表加载即自检**（DPMJ-5 / S1 的落地） | ① 问题（审计发现）：`assignee` 的 spec 把 `override` 写成了 `flags` 的**兄弟键**，而 `parseArgs` 只合并 `spec.flags` —— 于是 `jira assignee KEY --override` 报「未知的 flag」，决策 24 的「仍被阻塞时也认领」从 CLI **完全不可达**，而 USAGE 一直在宣传它。② **为什么 `tsc` 没抓到**：这张表的值类型是 `Record`，索引签名下不触发多余属性检查 —— 这是一个类型系统看不见的错位。③ 修法两条：把 `override` 移进 `flags`；并给 `COMMANDS` 加**加载即自检**（只允许 `maxPositionals`/`flags` 两键，多一个键就 `throw`），于是这类错位在 **import 时**就炸——每个入口和整个测试套件都会立刻撞上。④ 测试：`--override` 现在能被解析并认领成功（未阻塞时该 flag 无副作用，正好用来证明它存在）。⑤ 变异验证：把 `override` 挪回 `flags` 外 → 测试文件在 import 阶段直接失败，错误消息点名 `command "assignee" has unexpected key(s) override`。（决策 24/52/55/83） |
| 164 | **边界守卫改成按语句扫描，并自带自检**（DPMJ-6 / S1 的落地） | ① 问题（审计发现）：`check-boundaries.mjs` 是**逐行正则 + 行首锚定**，于是 ①**多行 import 完全漏检** —— 而本仓自己就在用（`codec.ts` / `generateStore.ts` / `kbstore.ts` / `mutate.ts` / `plugin/index.ts` 的 `} from '…'` 尾行），换个说明符就能把宿主包或跨层路径带进来而守卫不报；②**动态 import 不检**（`cli/main.ts` 里真有 `await import(...)`）；③`console['log']` 可绕。也就是说决策 64/108 的防线是**半失效**的。② 修法：加一个**极小分词器**（注释与字符串内容都不进匹配器），按**语句**判定 —— `from 'x'`（import/export-from，不管跨几行）、`import 'x'`、`import('x')`、`require('x')`、`console.`/`console[`；跨层判定改为**把相对路径解析成 `src/` 下的落点**再比（`core` 里的 `../../cli/x` 因此也对得上），而不是看字面前缀。③ 这个分词器第一次跑就抓出**三条假阳性**（`from "${from}"` 在模板字符串里被当成 import）—— 正是"按语句"与"按正则"的分界，字符串内容不进匹配器之后消失。④ **自检**：`--self-test` 用 13 条形状表（含多行、动态、跨层、注释掉的、模板字符串、`https://`）钉住匹配器，而且**每次 `pnpm check` 都跑**（一个悄悄失灵的守卫比没有守卫更坏：绿字看着像证明）。⑤ 真文件探针：往 `core/entity.ts` 注入多行宿主 import / 动态宿主 import → 守卫各报一条并点名行号，撤回后复绿。（决策 64/108、§3.1 ①、§11.8 F 组） |
| 165 | **git 写路径一批**（DPMJ-7 / S2 的落地） | ① **收编不再吞别人的在途写入**：`adoptHumanChanges` 改用 `stageAllExceptAndCommit`，排除**有活跃 issue 锁**的 issue/comment 文件（锁目录名就是 key）—— 否则 A 的写入会被 B 以「人工改动」名义提交，A 自己随后得到 `committed:false` 且无 error。`transact` 自己持锁，所以传 `ownLock` 把自己的锁排除在外（那个文件正是要收编的人类改动）。② **原子写的临时文件不进仓库**：`GITIGNORE` 加 `*.tmp-*`，并且收编的 pathspec **再排除一次**（顾到 `.gitignore` 早于本行的老 store）。③ **plan→write 的竞态**：`commitStoreWrite` 新增 `beforeCommit` 钩子（在**锁内**、提交前运行，返回的路径一并提交）；`regenerateAndCommit` 用它**在锁内重算 source_tree**，若输入在锁外那段时间里动过就重渲染 —— 否则头部的 `source_tree` 与提交内容不一致，正是 §4.13 的红线、`generate --check` 会误红。④ **push 有超时**：`push(root, run, timeoutMs)`，推送队列传 15 s（决策 84 的同一条界），网络挂起不再把防抖队列永久卡死。⑤ **`runGit` 两处**：超时时**保留已收集的 stderr**（否则只剩一句 timed-out，没法判断是什么卡住）、`error` 分支也 `clearTimeout`（`close` 不会来）。⑥ 测试 597 → **600**：在途写入不被收编（含「人类改动仍被收编」的正向断言）、`beforeCommit` 的路径被提交、钩子失败不提交半套。变异验证：去掉在途排除 → 用例失败。（决策 58/60/84/147、§4.13、§5） |
| 166 | **插件生命周期：`apply` 可撤销 + 一个 machine 身份 + `/jira sync` 走队列**（DPMJ-8 / S2 的落地） | ① **`apply` 返回 disposer**：三条 `tools.register`、`guard`、`agent/created` 订阅、`command` 与三个 `skills` 的注销句柄全部收集，`apply` 结束时按**逆序**调用（一个抛错不影响其余），最后 `queue.dispose()`。理由：宿主为一次**配置热重载**会重跑 `apply` —— 没有这一步，每次重载都会多一个会话结束监听（结束时 N 次重生成）、多一套工具注册、多一个持有旧闭包的防抖定时器。② **machine 身份收敛为一个**：命令面原来用 `dsh-<env>`，store 用 `resolveMachineId`（文件/生成 id）—— 而 counters 按 machine id 分块，于是一台机器两个号段、两条审计身份。现在 `commandOptions` 收 `machineId`/`identity: human:<id>` 都用**解析后的那个**。③ **`/jira sync` 复用插件队列**（`CommandOptions.queue`）：拉 + 结算 + 推三步齐了，也顺带取消上一次写入武装的定时器；没有队列时自建一个等价队列（pull+settle）。④ 顺手三条 S3：`jira_kb` 声明 `isConcurrencySafe`（只有 get/search 可并行，其余 fail closed）；删掉 `runKbTool` 里重复的 `pickKnownKeys` 死代码；`agent/created` 在 store 根未解析时**不再 spawn git**（`git -C ''` 不仅无意义，还会去读进程 cwd 的仓库）。⑤ 测试 597 → **603**：dispose 真的把注册项移除（假宿主给了会真删的注销句柄）、二次 dispose 不抛、命令面用解析后的 id、`/jira sync` 的 flush 带 `settle: true`。变异验证：让 dispose 什么都不撤销 → 用例失败。（决策 55/60/96/119/148/160、§6.1） |
| 167 | **System/CLI 一批：环境变量、长路径口径、文件名消毒**（DPMJ-9 / S2 的落地） | ① **`gitEnv` 大小写不敏感**：Windows 的环境变量名不分大小写，`git_dir` 就是 `GIT_DIR` —— 原来按大写精确匹配，`git_dir` 会被保留并把 store 的 git 写重定向到别的仓库（正是该函数要防的事故）；顺手补上 `GIT_NAMESPACE`。② **长路径按"root + 内部最长路径"算**：原来只量 root，而 store 还会接 `projects/<6>/comments/<KEY>.md`（约 40 字符）；现在两者相加再与 240 预警比，并且 `io.ts` 不再自己造一份 `PATH_LENGTH_WARN`（`system/paths` 一处定义）。③ **`safeFileName` 补齐合同并真的被用上**：NFC 规范化、Windows 保留名（`CON`/`NUL`/`COM1-9`/`LPT1-9`，带扩展名也算）、尾随点与尾随空格（Windows 上 `name.` 与 `name` 是同一个文件，所以在字符替换**之前**剥掉，否则会多出第三种拼法）、超长截断 + 原始名的哈希后缀（两种长名共享前缀时仍可区分）、fallback 也递归消毒（`safeFileName('','..')` 不能再返回 `..`）；**并且** `sessionPath` 与 CLI 的 `claimNotice` 改用同一实现（它们各自内联过同一段正则 —— 只是同一个"一个路径片段"规则的两次漂移）。④ **`sessionPath` 消毒 session id**：`../x` 形 id 不能再写出 `sessions/`。⑤ **`$DSH_HOME` 相对路径绝对化、`~` 展开**：否则 machine id 会落在命令运行目录里 —— 正是决策 73 要防的"每个 cwd 一个身份"。绝对路径保持用户写的原样（不做 `C:/x` → `C:\x` 的改写）。⑥ 测试 603 → **607**：大小写变体与 `GIT_NAMESPACE`、消毒合同的九种形状（含"只由点组成的名字不算名字"与"两种长名不撞"）、相对/`~` 的 DSH_HOME、`../x` 形 session id。三处变异验证。（决策 60/73/146/153/240、§3.1） |
| 168 | **`log.md` 的窗口只数"带 key 的提交"**（CI 抓到的一个真 bug） | ① 现象：账本 CI 在 settle 提交（`chore: 重生成派生工件 [no-issue]`）之后报 `log.md（stale）` 与 `projects/DEMO/log.md（stale）`——本地 `generate --check` 也能复现。② 根因：`readCommitRows` 用 `git log -n 100` 取最近 100 条**再**过滤掉无 key 的，于是无 key 的 settle 提交**也占一个窗口位**；它一旦因为改了 `projects/<p>/log.md` 而出现在 `git log -- projects/` 里，就把最老的一条带 key 的行挤出窗口 —— 刚写下的 `log.md` 在提交的那一刻就已经过期。③ 修法：把过滤交给 git（`--grep` + `--extended-regexp`），`-n` 只数**带 key 的**提交；代码里的 `KEYED_SUBJECT` 过滤保留作双保险。④ 于是 `log.md` 成为**带 key 历史**的纯函数：无 key 的提交（包括 settle 自己）不会改变它 —— 这同时让"写操作让 log 立即过期"这个自引用问题在窗口层面彻底消失（`source_tree` 层面仍需要 settle 的无 key 规则，决策 148）。⑤ 测试 607 → **608**：先落一条带 key 的提交、再落一条无 key 的，窗口为 1 时后者不得把前者挤出去。变异验证：拿掉 `--grep` → 用例失败。（决策 60/87/148、§4.13） |
| 169 | **io 的错误契约与 args 的边界**（DPMJ-10 / S2 的落地） | ① **`sourceTreeEntries` 从"跳过读不了的"改成 `Result`**：它喂的是每个派生文件头上的 `source_tree` 哈希 —— 旧的 `readdir` catch 一律 `return`、`readFile` 干脆没 catch，于是 ⑴ 缺子树与「没权限」不可区分、⑵ 文件在 walk 中途消失会**抛异常**逃出 Result 契约、⑶ 最坏情况下哈希的是**残缺的树**，而那会让过期文件看起来新鲜。现在：`ENOENT`（子树还没建）照旧放过，其它错误带路径与 `code` 返回 `err(ioFailed)`；`currentSourceTree` 也随之变 `Result`，`inspect` 读不到树时**不填** `sourceTree`（doctor 已有 `!== undefined` 的判断）。② **args 的四条静默边界**：`--limit=` 空串不再被 `Number('')=0` 当成合法数字（`--expected-revision=` 尤其坑，会让 CAS 对着修订 0 必然失败）；重复 flag 不再「最后一条赢」而是报错；单个 `-h` 不再当位置参数（`jira list -h` 原来报的是"最多接受 0 个位置参数"，答非所问）；`splitTokens` 的未闭合引号不再静默吞掉后半行，而是 `Result` + 「引号未闭合」。③ **`--root` / `JIRA_ROOT` 先 trim** 再当路径（`--root ' D:\x '` 曾把空格一路带到 `git -C`）。④ 测试 608 → **611**：不可读的树（拿一个**文件**当 root）报错、缺子树仍放过、空值/重复 flag/单横线/未闭合引号、root 前后空格被 trim。三处变异验证。（决策 39/52/60、§3.1 ①） |
| 170 | **测试面补齐：直接测 inspect/validate、恰等边界、写重试、临时目录不再泄漏**（DPMJ-11 / S2 的落地） | ① **`inspect`/`validate` 的直接测试**：新增 `inspect.test.ts`（`queryIssues` 的六个过滤分支、无词表时**不按关闭集隐藏**、多条件组合；`blockersOf` 只算**开着的**阻塞、忽略已关闭与不存在的目标、未知 key 回 `[]`）与 `validate.test.ts`（9 个 `validate*` 的非法输入分支：空/多行/超长 summary、agent 四段与非空、human 不得带 `|`、key 形态、闭集成员、未注册/畸形 tag、关闭态必须带 resolution、开着不得带、`limitation` 必须带 note）。**期望值从 fixture 派生**（`vocab.closed[0]`、`SUMMARY_MAX_CHARS`），不再把词表当前的值钉死 —— 否则改一条词表就要改一堆测试。② **恰等边界**：`isStale` 在**恰好** `staleMs` 时仍算活着（`>` 不是 `>=`），差 1 ms 才算过期；`acquireLock` 在 `timeoutMs: 0` 时**不先睡退避**就放弃。③ **写重试**：拿一个**已存在的目录**当目标（rename 必失败）让 `writeTextAtomic` 走完整个重试循环，断言错误里带尝试次数、且**每次尝试都清掉自己的临时文件**（Windows 的 EPERM/EBUSY 路径此前零覆盖）。④ **临时目录**：`main.test.ts` 的 6 个、`store.test.ts` 的 1 个、外加审计没列到的 2 个（`inject-empty`、`empty-gitconfig`）全部登记并在 `after` 里删除 —— 实测一轮测试的临时目录增量从 **+2 变成 0**（那 7 个带 `.git` 的目录不再堆在 `%TEMP%` 里）。⑤ 三条 S3：`bothPlatforms` 用到新文件（`samePath` 的分隔符/大小写、`safeFileName` 两平台逐字符一致 —— "同一份 store 能被两台机器共享"这条才真正被测）；`machines.test.ts` 的永真断言换成"整毫秒"（能失败）；`main.test.ts` 的 `join('\\n')` 笔误。⑥ 测试 614 → **631**；变异验证：把 `isStale` 的 `>` 改成 `>=`、让 `queryIssues` 永不隐藏关闭项 —— 三条用例分别失败。（决策 85/152、§5、§11.8） |
| 171 | **网络步骤也要互斥，被拒可重试，落后要出声**（DPMJ-103 的落地） | ① **机理**：`jira sync` 当场报出 `pull --rebase stopped: 警告：fetch 更新了当前的分支。快进您的工作区` —— 这是两个进程在**同一份克隆**上抢同一次 fetch/rebase。而 store 锁只串行化**提交**，`pull --rebase`/`push` 在锁外（而且 settle 自己就要拿 store 锁，`withLock` 不可重入，所以不能共用一个锁）。于是写者的 settle 被拒 → 决策 148 拦住 push → 提交留在本地、origin 落后、派生文件 stale，**而且完全静默**（`schedule()` 里是 `void flushNow(...)`，返回值没人看）。② **修法 1（互斥）**：新增 `networkLockPath`（`.jira/network.lock`），`pullRebase` 整个包在它里面 —— 网络步骤永远不与自己嵌套，也不与 store 锁嵌套。③ **修法 2（可重试）**：`pull --rebase` 因「分支已被 fetch 更新」而失败时**重试一次**（这是别人抢了，不是真冲突），仍失败才报 `stopped`；红线上"绝不 force"不变。④ **修法 3（出声）**：`jira sync` 失败时打印 `本地领先 origin N 个提交（未推送）` / `origin 领先本地 N 个提交（未拉取）`（`--json` 也带上 `ahead`/`behind`）—— 这是之前缺的报警器。⑤ 测试 631 → **632**：被拒的 pull 会被重试一次并成功（变异：去掉重试 → 用例失败）。⑥ 一条过程记录：`pullRebase` 加了锁之后，用假 root（`/store`）的既有用例先失败（锁建不出来）—— 这不是回归，而是"假 store 本来就不是 store"的暴露；已改成真的临时目录。（决策 58/60/84/119/148/160、§4.13） |
| 172 | **文档纪律一批：重复键守卫、决策表排序、错引用、两处"说做了没做"**（DPMJ-12 的落地） | ① **i18n 表的重复键守卫**：`scripts/i18n-tests.mjs` 与 `scripts/i18n-human.mjs` 的 `ASSERTIONS`/`RENDERERS`/`CLI_PROSE` 都是**按文件路径做键的对象字面量**，重复键会被 JavaScript 静默保留最后一个 —— 整张表的翻译就此消失而没有任何输出。新增 `assertNoDuplicateKeys`（扫描字面量的顶层键，重复即 `throw`），**每次运行脚本都会检查**，并带 `--selftest`（构造一个重复键，断言守卫会抛）；`pnpm check:text` 现在也跑两个 `--selftest`。② **决策表排序**：三条被追加在 153 之后的行（149/146/124）移回各自的数字位置 —— 现在 1..171 **严格升序、无缺号无重号**（脚本核验）。③ **错引用**：决策 153 里写的「决策 240」实际是决策 60 的 240 字符长路径警告。④ **决策 88 说"`jira_kb` 用法并进 `jira-work`"而实际没并**：`skills/jira-work.md` 补了 `jira_kb` 的完整用法段（search/get/create/update、`kb_types` 是闭集、**不要自己造 key**、血缘由 store 记录、只读会话不能写）。⑤ **决策 9 要求拦截规则写进工具 description，而它没有**：`jira_issue` 的描述现在明说"写操作会被拒（`ok:false` + `writable:false` + `reason`），宿主 guard 在执行前就拦下，先读一次看 `writable` 再决定"。⑥ 测试 632（无行为变化，除 description 文案）；`check:text`、`check-boundaries`、烟测全过。⑦ **没做完的部分已拆出**：§11.8 里十余行"已实现但仍标 ❌/⚠️"的翻状态没有塞进这个提交（那是逐行核对，混在代码提交里会看不清）—— 单独登记为 DPMJ-104。（决策 9/55/88/145/152、§11.8） |
| 173 | **守卫质量一批：smoke 不再空串可绿、dist 不新鲜就拒绝跑、CI 查全 range**（DPMJ-13 的落地） | ① **smoke 的注入行断言**原来写的是 `injected === '' || 正则` —— 只要插件**完全没注入**也算绿（对真实非空 store 来说，这是断言了"什么都没有"）。现在：store 里有 `projects/` 条目时**必须**匹配注入行，只有空 store 才允许沉默。② **dist 新鲜度**：smoke 驱动的是 `dist/`，陈旧构建会让每一步都变成谎话（此前有一次就是这样白绿的）。跑之前比较 `src/**/*.ts` 的最新 mtime 与 `dist/cli/index.js`，源新则直接拒绝并提示 `pnpm build` —— 实测：`touch` 一个源文件后 smoke 立刻拒绝。③ **账本 CI 的提交绑定**：`pull_request` 与"新分支"事件原来只查 `-n 1`（只看最后一个提交），多个提交的 PR 里前面的提交可以绕过绑定；现在 push 用 `before..sha`、PR 用 `base.sha..sha`、其余用默认分支..HEAD，都没有时用"首个提交..HEAD"（**永远查全 range**）。`[no-issue]` 的豁免仍是决策 67 的设计内旁路。④ **`board.html` 的 "self-contained"** 原来只看了长度；现在真的检查没有外链（`src`/`href` 指向 `//` 或 `http(s):`），不干净就把那一步判失败。⑤ 测试 632（脚本改动由 smoke 自身与 CI 覆盖）；烟测 33/33。⑥ 账本仓的 `ledger.yml` 改动走一条 `[no-issue]` 的基础设施提交。（决策 67/87、§5） |
| 174 | **零碎 S3 清扫：一个 `projectOf`、过期注释、二进制判定、`--root` 兜底链、文件地图**（DPMJ-14 的落地） | ① **`projectOf` 曾有两份**（`store.ts` 与 `io.ts` 的 `projectOfKey`）——「键 → 项目」是**实体规则**，移到 `core/entity.ts` 一处；`store.ts` 保留 `export { projectOf }`、`io.ts` 保留 `projectOfKey = projectOf` 两个别名，既有调用点一个都不用改（也就不会有人为了"统一"再去写第三份）。② **`ci.yml` 的过期注释**：矩阵注释里写着「275/275 实测」，实际早已 632；另一段说"生成物校验还没有生成器，将来再做"——而它**早就有**（`generate --check`），账本仓的 `ledger.yml` 一直在跑；改为指向账本仓的流程，不再留着一条会误导人的"将来"。③ **`check-text` 的二进制判定**：原来只看 NUL 字节，一个 Latin-1 文件没有 NUL 却也不是 UTF-8，会被当源码文本检查行尾/BOM；现在再加一道 `TextDecoder('utf-8', {fatal:true})`，解码失败即跳过。④ **USAGE 的 `--root` 兜底链**漏了最后一档：代码注释与实现都是 `--root > $JIRA_ROOT > $DSH_HOME/jira > <home>/.dsh/jira`，帮助文本只写到第三档。⑤ **HANDOVER 文件地图里的 `src/bin` 不存在**（`bin` 是 `package.json` 的字段，指向 `src/cli/index.ts`）——清单型文档最容易这样"长"出一条不存在的路径。⑥ 两条**没做**并说明原因：`frontmatter.ts` 的"真 TAB"实测 0 个（此前已修）；账本仓 `_merge/` 空目录的卫生问题涉及"`_merge/` 该不该被 git 跟踪"的设计判断，不在这条 S3 里顺手拍。（决策 55/77/153、§5） |
| 175 | **`.jira/` 下的任何东西都不许入库，且 `.gitignore` 要能升级**（DPMJ-171 的网络锁自己踩的坑） | ① **现象**：账本仓里出现了被跟踪的 `.jira/network.lock/owner.json`，随后它被删除——那个「已暂存的删除」让**每一次 `pull --rebase` 都拒绝执行**（"您有未暂存的变更"），于是 settle 永远失败、账本永远落后、派生文件永远 stale。② **两条成因**：⑴ 决策 171 的网络锁放在 `.jira/network.lock/`，而**账本仓的 `.gitignore` 是旧版**（逐条列 `.jira/lock`、`.jira/locks/`，没有这一条）；⑵ `GITIGNORE` 只在仓库**还不存在时**写一次，所以"新增的模式"永远到不了已有账本 —— 这正是"写过一次就不管"的典型漏。③ **修法**：⑴ `commitStoreWrite` 的路径列表**显式过滤 `.jira/` 前缀**（不依赖 ignore 文件，因为 ignore 可以被 --force、可以被旧版本漏）；⑵ `initializeRepository` 在"已是仓库"的分支里**补写缺失的 ignore 模式**（只追加缺失项，不改写已有内容）；⑶ `GITIGNORE` 补 `.jira/network.lock/` 与 `.jira/*.lock/`；⑷ 账本仓本身做一次一次性修复：`git rm --cached .jira/network.lock/owner.json` + `.gitignore` 追加一行。④ 验证：修复后 `jira sync` 成功、`generate --check` 新鲜、账本 `local=origin`、干净。⑤ 教训：**把运行时状态放进仓库目录时，必须先问一句"ignore 覆盖到它了吗"**——而且 ignore 文件本身也是一种需要迁移的派生数据。（决策 73/171、§5） |
| 176 | **分配号要看盘上实际有什么；`git init` 进锁**（DPMJ-101 的落地） | ① **审计的担心是真的，但根因与描述不同**：`claimKey` 的 `seed`（盘上最高号）原来只在"要开新块"时用，**块内推进时被忽略** —— 于是盘上出现一个"计数器不知道的号"（种子、手抄、被重置的机器写过的号）时，分配会**发一个已存在的号**，创建随即失败。修法：块内推进也取 `max(next, seed + 1)`；种子把号顶出自己的块时**从该点开新块**（`claimedNewBlock`），而不是跨块边界。测试用一个"计数器不知道的 DH-7"证明下一次分配是 **DH-8** 而不是撞上去；变异验证（忽略 seed）→ 用例失败。② **`git init` 进锁**：`initializeRepository` 原来在 `commitStoreWrite` 拿到 store 锁**之前**跑，两个首次写者会同时 `git init`，输的那个错误被当成软失败吞掉；现在它在锁内、在 `beforeCommit` 之前。③ **`generateStore` 的"每路径重复全量渲染"没改**：那是纯性能问题（生成物数量 × 全量渲染常数），没有可复现的用户可见故障，改它要重写 `planGenerated` 的渲染流程 —— 记在这里而不是顺手改，避免为了一个常数把已验证的生成逻辑动一遍。④ 测试 632 → **633**。（决策 6/74/158、§4.13） |
| 177 | **插件层的三个口径：会话记录会重试、`/jira status` 问调用者、读超时认了**（DPMJ-102 的落地） | ① **会话记录**原来"失败一次就标记成做过"——一个瞬时 IO 错误让**整个会话**都没有 `sessions/<id>.md`。现在按会话累计失败次数，**最多试 3 次**才放弃；"试过"不再是"记下了"，而且记录本身的失败永远不影响触发它的那次写入（问题才是任务）。② **`/jira status` 硬编码"本会话可以写"**：命令面根本不知道调用者，只读会话会读到一句假话。现在 `CommandOptions.writable`（插件注入，因为它知道 caller）提供那一行；**没有这个回调就干脆不提**，绝不默认说"能写"。③ **读操作挂 30 s 写超时**：`jira_issue`/`jira_kb` 是混合工具而 `timeoutMs` 是静态声明，所以读也拿 30 s（决策 84 的读是 5 s）。拆工具要重新评估决策 82，代价大于收益 —— 这个取舍**写在工具声明旁边的注释里**，而不是留成一个没人知道的惊喜。④ 测试 633 → **634**：`/jira status` 的三种形态（能写 / 不能写+原因 / 无回调则不出现该行）。⑤ **一件没做到的，写明**：会话记录的重试**没有单元测试** —— `recordSessionOnce` 是模块内私有，要测它得先把工具调用链搭起来；这一轮我写了一版但依赖了不存在的测试夹具名字，改到一半判断"在没有夹具的情况下硬搭"风险更高，于是撤回，并在 issue 里把它列为未测项。（决策 55/82/84/100、§6.1） |
| 178 | **测试加固一批：四个"决策已落地但零测试"的模块补上守卫，`removeTree` 收编成一份**（DPMJ-201 的落地，源自 DPMJ-105 的逐行精读） | ① **四个零测试的已落地行为**（都是审计精读发现，不是新功能）：⑴ `push.ts` 的 `queue.dispose()`（决策 166 防热重载后旧定时器重复推送）——定时器清掉、fire 不推、`flushNow` 被拒、不再武装、不计失败，五条断言；⑵ `doctor.ts` 的 generated 新鲜度整块（决策 39/79/120）——`generated-missing`/`unmarked`/`stale` 三码 + `log.md` 例外 + 无 `sourceTree` 时跳过，另补 `key-shape`/`counters-next-behind`/`comments-invalid`；⑶ `git.ts` 的 `migrateGitignore`（决策 175）——缺 pattern 追加（带日期标记、原内容不动、被 stage）、齐全时字节级 no-op、外来 repo 不新建 `.gitignore`；⑷ `render.ts` 的 `fromWire`（决策 159 的逆变换，注释自述曾线上崩溃）——四种真实形状往返逐键还原、缺字段不臆造。② **`removeTree` 收成一份**：`src/testing/removeTree.ts` 取代三处本地副本（`plugin/index`、`project`、`rebase` 测试），并把七个文件的裸 `rm` 全换掉（`main`/`command`/`git`/`session`/`injection`/`kbstore`/`machines`，另加 `lock`）——决策 170 只做了"把临时目录清掉"，这一条补的是"用同一个能重试的助手清"。③ **十处 `it` 内 `mkdtemp` 的清理**从"末尾手动 rm"改成**登记进 `emptyStores`、由 `after` 统一清**（断言失败时也不会泄漏，比 `try/finally` 更少样板）。④ **三处"声称 > 实际"改说真话**：`main.test.ts` 的 "never rewrites it" 补 `HEAD` + `git status --porcelain` 双证据；`skills.test.ts` 头注释删掉不属于它的 session-end flush 声称；`index.test.ts` 的 "Ready first, blocked last" 原来被 `if (firstBlocked !== -1)` 静默跳过——现在**真的建一个 blocked issue**（`link` 动作）再断言排序。⑤ **一处更严重的**：`kbstore.test.ts` 里有个断言**整段被包在注释里**（字面 `\n`），即"index.md 不进 broken"从来没被检查过——移出后立刻证明它能失败（变异去掉过滤 → fail=1）。⑥ **新发现、不在本轮修**：`kbsearch.hitFor` 的 `line` 数的是**正文**行，而决策 54 要求 `file:line` 可回溯——打开 `knowledge/x/KB-1.md:N` 会落进 frontmatter，偏差 = frontmatter 行数。修它要动 `kbsearch`/实体（把偏移带进命中），超出"只改测试"的范围，登记为 **DPMJ-202**，测试暂按正文断言行并注释说明偏差。⑦ 测试 634 → **650**（+16）；每一条新守卫都做了变异验证（dispose 置 false → fail=1、关掉 generated 块 → fail=2、不调 migrate → fail=1、`fromWire` 直接返回入参 → fail=2、lint 里写文件 → fail=1、去掉 index.md 过滤 → fail=1）。（决策 39/54/79/120/159/166/170/175、§11.8） |
| 179 | **三条用户裁定：`file:line` 数文件绝对行；`comment/v1` 从 schema 清单去掉；手工 push 只报警、不装钩子**（DPMJ-202 的落地） | ① **行号必须是文件绝对行**：`jira_kb search` 的 `line` 原来只数正文，打开 `file:line` 会落进 frontmatter（偏差 = frontmatter 行数，实测 11 行）。修法：`parseFrontmatter` 返回 **`bodyLine`**（正文起始行，把 fence 与空行分隔都数进去），`KnowledgeEntry` 带上它，`hitFor` 算 `bodyLine + 正文行 - 1`；`createKnowledge` 写完再做一次 encode→decode 往返，让返回的实体带**真实** `bodyLine`（写出的文件与读回的值一致）。**只有标题命中**的 `line` 仍是 1（标题在 frontmatter，字段行号没有跟踪——写在注释里，不假装精确）。② **`comment/v1` 不存在是设计**：评论按决策 68 是锚制（一个文件装多条评论、每条带 author/created_at/revision），frontmatter 只能描述整个文件 → 从决策 46 的清单**去掉**，九种实为八种。③ **不装 `pre-push` 钩子**（生成必须留在 DSH 进程内，决策 15），改为**报警**：`doctor` 的 `generated-stale` 文案点名 `jira sync`（"a manual git push will not regenerate it"），CLI 的 `jira doctor` 在人面输出多一条 `! 派生文件已过期：推送前先 jira sync…`（仅当 `generatedStale > 0`）。④ 测试 650 → **652**；变异验证：把 `line` 改回正文相对 → kbsearch 两条失败；删掉警告行 → main.test 一条失败。（决策 15/46/54/68/148、§11.8） |
| 180 | **副作用收敛落地：`io` 补齐目录/存在性原子，14 处散落的 fs 调用全部下沉**（DPMJ-203 的落地，源自 2026-10-19 架构审查） | ① 审查发现决策 102① 宣称的「副作用只在 io/cli/plugin」**从未是事实**：17 个 core 文件直接 import `node:fs/promises`，根因是 `io.ts` 只暴露 `readText/writeTextAtomic`——没有目录与存在性原子，9 个模块只能各自裸 `readdir`。② **io 新增四个原子**（Result 风格、jsdoc 写明 ENOENT 语义）：`exists`（永不抛）、`listDir`（只给名字，missing → `err kind:'missing'` 由调用方决定"缺失=空"）、`listDirEntries`（冻结的 `{name,isFile,isDirectory}`，不泄漏 Dirent）、`mkdirp`（幂等）。③ **13 个文件逐个下沉**（行为保持：容忍缺失、排序、过滤语义原样）；`hooks.ts` 保留 fs 但文件头写明它属 git 边界（`.git/hooks` 域）。④ **校验旁路封堵**：`machine.ts`/`session.ts` 的裸 `writeFile` 原来绕过 `writeTextAtomic` 的 BOM/CR 拒绝——现在走它；`session.writeWatermark` 顺带从"抛异常"改成返回 `Result`。⑤ 验收口径：core 生产代码里 `node:fs` 只剩 **io / git / lock / hooks** 四个正当边界（grep 可证）；测试 652 → **657**；两处变异验证（`listDir` 静默吞 missing → 红；`writeWatermark` 回退裸写 → 红）。（决策 60/102、§11.8 G 组 102 行） |
| 181 | **锁语义单点化：`lockOwnerOf`/`lockOptionsOf`/`networkLockPath` 收敛进 lock.ts，`host` 恢复 OS 主机名语义**（DPMJ-204 的落地） | ① 审查发现锁 owner 构造**五份发散**：store.ts 用 `store.host`、kbstore 用 `origin.tool`、machines/project 硬编码 `'dsh'`、transact 里还有一份遮蔽导出的内联副本；`{timeoutMs, staleMs, env}` 包也手拼五遍。审计字段（谁拿的锁）因此实际有三种取值。② lock.ts 现在提供三个原子（结构化入参，避免与 store.ts 循环依赖）：`lockOwnerOf({host, machineId}, at)`、`lockOptionsOf({lock, env})`、`networkLockPath(root)`；五处调用点全部归一，三个旧导出删除。③ **更深的发现**：`store.host` 本意是 OS 主机名，但此前只有插件在传（`COMPUTERNAME ?? HOSTNAME`），CLI 与 `/jira` 命令面没传 → 落进 `'unknown'`。新增 `system.hostName(env)`，三处入口都接线。④ 测试 657 → **662**；变异验证：machines 改回硬编码 `'dsh'` → 红；transact 丢 env → 红。⑤ 顺带修掉 6 处注释/测试里的「决策 240」错引用（应为决策 60）。（决策 58/59/102、§5） |
| 182 | **路径规则单点化：实体相对路径只有 entity.ts 三条规则，拼 root 只有 io.ts 一处**（DPMJ-205 的落地） | ① 审查发现 issue 文件路径规则有 **4 份**（`io.issuePath`/`storePaths.issue`/commitWrite 裸 join/lint 模板字面量）、`projectPath` **同名两义**（io 版返回绝对、project 版返回相对——错 import 即 bug）、lint 手写 `knowledge/…` 模板。② 收编：`entity.ts` 持有三条 **posix 相对**规则（`issueRelPath`/`commentRelPath`/`projectRelPath`——选 entity 因为它零依赖、人人可引）；`io.ts` 是唯一允许 `join(root, …)` 出绝对形式的地方；相对版改名 `projectRelPath`，`projectPath` 之名独占绝对版。③ **附带收益**：喂 `git add --` 的 pathspec 原来在 Windows 上是反斜杠，现在统一是 posix（Git for Windows 实测可接受，但规范形式消除了"碰巧能用"）。④ 守卫：新 `pathRules.test.ts` 钉规则字面量（不许反斜杠）+ 绝对↔相对互推一致 + 同名唯一；lint 用例改为对照共享规则断言。⑤ 测试 662 → **666**；两处变异验证（规则漂移 → 2 红；调用点改回手拼 → 1 红）。⑥ 诚实边界：目录级前缀（`projects/<P>/issues/` 这层）与文案里的路径字样未收编（枚举/建目录/消息，非实体文件路径）——要收也是同一套路，记在 issue 里。（决策 102/174、§4.4） |
| 183 | **插件生命周期收口：会话记录状态进闭包、注册项无一漏网、injection 不 throw**（DPMJ-206 的落地） | ① **模块级会话状态收进闭包**：`recordedSessions`/`sessionFailures` 原来是进程级模块状态且键只含 sessionId——live reload 换 root 后旧键让新 store 永远跳过记录。现在由 `createSessionRecorder()` 工厂造在 apply 闭包里，键 = `root\|sessionId` 双保险。② `systemPrompt.context(...)` 的返回值过 `keep()`——宿主返回 disposer 时随 apply 撤销，决策 166 至此无漏网。③ **injection 不再 throw**：read 回调的 `if (!made.ok) throw` 改成返回空注入（决策 149 的信封语义），`refresh` 的 catch 只兜底真异常；与同处注释的矛盾消除。④ 项目键校验改用 core 的 `isProjectKey`（此前 index.ts 手写同一条正则，双实现）。⑤ **复核修正**：文档里「index.ts 零汉字有守卫」的说法已不成立（决策 177 的人面回调合法带中文，守卫也没有汉字规则），HANDOVER 与 §11.8 同批改说真话。⑥ 测试 666 → **671**；三处变异验证（状态回模块级 → 2 红；context 不过 keep → 1 红）。（决策 102/149/166/177、§6.1） |
| 184 | **人面文案单一出处：命令级中文消息收敛进 `core/messages.ts`**（DPMJ-207 的落地） | ① 审查发现 command.ts 与 main.ts **各持一份中文命令级消息且已漂移**（「看板需要可读的 config.md」两面 wording 已不一致；「已创建…并已提交」一式四份）。② 新建 `core/messages.ts`：9 条两面共有的消息收敛为常量/带参小函数，两面 13 处替换点全部改引用（messages 在 core，cli 与 plugin 都向下 import，分层合规）。③ **取舍写明**：「看板需要可读的 config.md 词表」以 CLI 的更准版为准；「tags 只支持 lint」统一成能回显打错词的版本；情境不同的（USAGE、`new 需要 --project`、未知命令的层级差异）判定不收并写明理由。④ **守卫**：`messages.test.ts` 三条——导出全覆盖、两个面零字面量副本（变异：塞一份「推送：」副本立刻红并点名）、两面必须 import。⑤ 顺带修了 3 处 i18n 断言表的既有过期条目（决策 154/155/177 改文案时没同步表）。⑥ 测试 671 → **674**。（决策 55/102/145、§6.2） |
| 185 | **拆 store.ts：626 行的集成模块 → 329 行装配点 + commit.ts + counters.ts 各归其位**（DPMJ-208 的落地） | ① store.ts 曾有 23 个导出、9 类职责（配置/路径/词表/读模型/锁管道/提交编排/事务引擎/键分配/创建）。② 拆分：**`commit.ts`**（173 行）拿走提交编排（`commitStoreWrite`/`adoptHumanChanges`/`commitWrite`，锁序 issue→store 与 `.jira/` 过滤两条规则写在文件头）；**`counters.ts`**（179→243）并入分配的 IO 半（`readAllCounters`/`highestExistingKey`/`allocateKey`）；**`assertProjectKey`** 落到 entity.ts（与决策 182 的路径规则同址）；store.ts 剩 329 行 = 配置构造 + 读模型 + `transact` + `createInStore` + re-export 兼容层。③ **调用方零改动**：7 个 `commitStoreWrite`、2 个 `allocateKey` 使用点全部经 store.ts re-export（沿用决策 174 的 projectOf 先例）；commit/counters 对 store 只用 `import type`（运行时方向单向，不成环）。④ 守卫：store.test.ts 新增「re-export 与实现是**同一函数对象**」——有人在 store.ts 里重新手写一份会立刻红。⑤ 测试 674 → **675**。⑥ 顺手清掉一个死 import（`isRepository`）。（决策 58/102/174/181/182、§3.1） |
| 186 | **拆 plugin/index.ts：1230 行七职责 → 464 行接线层 + 六个原子文件，apply 变成命名步骤的组合**（DPMJ-209 的落地） | ① index.ts 曾扛宿主声明/信封/三个工具/会话记录/会话收尾/apply 接线七件事，apply 372 行一坨顺序代码。② 拆分：**`host.ts`**（宿主鸭子类型）、**`envelope.ts`**（ToolValue/信封/RunOptions）、**`toolIssue.ts`/`toolList.ts`/`toolKb.ts`**（三个工具的 schema+run 各一个文件）、**`sessionRecord.ts`**（会话记录+收尾）；index.ts 只剩 apply+注册+guard+injection。③ **apply 现在是自顶向下的组合**：`registerSlashCommand → registerPluginSkills → installWriteGuard → subscribeSessionEnd → registerAwarenessLine → registerTools`，三个工具的注册由 `registerTool` 组合子收敛（callContext→wire→keep 只写一遍）。④ **调用方零改动**：index.ts re-export 全部旧导出，两个测试文件（1028 行）零改动全绿即证明。⑤ 守卫（bundle.test.ts）：index.ts ≤560 行 + 六个拆分文件必须存在 + 入口不得定义 run*Tool/*_PARAMETERS——变异（阈值改 50 / 塞假 ISSUE_PARAMETERS）都会红。⑥ 测试 675 → **677**。（决策 102/166/183、§3.1） |
| 187 | **runCli 原子化：626 行 switch → `cli/commands/` 每命令一个 handler + 组合子消灭样板**（DPMJ-210 的落地，用户裁定"状态机式原子化"） | ① `runCli` 曾是全仓唯一显著超长函数（~700 行：21 个分支各自内联校验+渲染+报错，kb/project/hooks 还内嵌二级 dispatch）。② 拆分：**`cli/runtime.ts`**（227 行：CliRequest 新增注入的 `cwd`、CommandContext、buildContext、组合子）；**`cli/commands/`**：21 个命令各一个文件（17–100 行）+ 注册表 index.ts；main.ts 1080 → **280 行**（只剩 USAGE/COMMANDS 表/决策 163 自检/preflight/dispatch）。③ **组合子**：`writeCommand(ctx, command, prepare)` 吃掉写命令五胞胎（key 校验→actor→writeIssue 含 CAS→report→say）；`optFlags<T>`（进 core/args.ts）吃掉 37 处条件 spread。④ **下沉 4 处 CLI 滞留的 core 逻辑**：commit-msg 注释过滤→`core/commitmsg.uncommentGitMessage`、knownKeys→`core/inspect.collectKnownKeys`、sync 的 ahead/behind→`core/git.aheadBehind`、claimNotice marker→`core/machine.claimNoticeOnce`；`process.cwd()` 3 处并入 `CliRequest.cwd`。⑤ **行为保真**：CLI 中文输出逐字节不变（679 测试全绿即证），kb 的错误顺序、hooks shim 的相对路径都有注释钉住。⑥ 守卫：`cli/commands.test.ts`——COMMANDS 表每个命令都有 handler、commands/ 每个文件恰好对应一个命令。⑦ 测试 677 → **679**；依赖方向 core ← cli/runtime ← cli/commands ← cli/main，无环。（决策 83/102/163、§3.1） |
| 188 | **S3 杂项清扫：broken 条目结构化、`renderKbEntry` 归位——以及四条"核实后不修"的诚实记录**（DPMJ-211 的落地） | ① **修了**：`inspect.listIssues` 的 `broken` 从拼串（`"<path>: <reason>"`）改成结构化 `BrokenFile{path,reason}`——plugin 里的"字符串考古"（split 回去）删除，两个 CLI 打印点同步（输出格式不变）；`renderKbEntry` 落到 core/kbsearch.ts，CLI 的手拼数组删除；args.ts 的 `'../core/errors.ts'` 父目录绕回改 `./errors.ts`；hooks shim 的 win32 判断补上「为什么在字符串里」的注释。② **核实后不修，理由留档**：io.ts 的 `emitWarning` 直用（启动检查已是人面入口，穿注入回调代价大于价值）；system/git.ts 读 env 的指控**不成立**（它是纯函数，读点在指定的子进程边界）；`process.pid` 无散布（io/lock 各一处正当）；checkStore 不再拆（族间零共享的合理长 dispatch）；cli/plugin 的字段装配对照后判定**非语义重复**（两种方言同一契约，都收敛到 core 原子）。③ 测试 679 → **681**；两处变异验证（broken 改回拼串 → 红；renderKbEntry 去掉 issues 行 → 红）。（决策 102、§3.1） |
| 189 | **试用反馈的四条裁定：词表不加、关闭必须先 in_progress、时间阻塞用约定、KB 撞车按原则分开**（2026-10-19 一位 DeepSeek Flash agent 的真实试用反馈，8 issue + 3 知识条目 + 31 次写） | ① **issue_types 不加**：`task` 涵盖功能增项（task 比 feature 更普遍），`bug` 是问题——config.md 的 TODO 结案。② **关闭必须先经过 `in_progress`**：`transitions` 摘掉 `[todo, closed]` 边（词表驱动，零代码）；理由——未认领就关闭让审计说不清「谁做的」；快捷路径由复合动作承担（DPMJ-214 的 close 一次提交里含 claim+开工+关闭）。fixtures/config.md 与账本逐字同步（这条此前是未复核的漂移源）。③ **时间性等待不加字段**：约定是 comment 写明等什么+到点继续，状态留 in_progress/todo，不设 `hold_until`。④ **KB 撞车按原则分开**：知识键与项目 issue 是**两个键空间**——「锁定 KB 项目=知识库」不解耦数字冲突，所以知识键换前缀（落地在 DPMJ-215，决策号届时分配），现有 4 条知识条目给迁移。⑤ 实证：反馈当天 KB-14 的悬空引用（把知识条目 KB-12 写进 issues）让账本 CI 连红三次——CI 是对的，数据错了；已修（issues 只留真 issue，关联知识写正文）。⑥ 测试适配：7 条用 todo→closed 旧路径的测试改走 in_progress，其中一条改写成「todo→closed 现在被拒且列出合法目标」的正向守卫。（决策 45/50/136、§4.2/§4.16） |
| 190 | **先校验、后分配：create 被拒不再烧号**（DPMJ-212 的落地，试用反馈 P0-1） | ① 实证：试用者的 KB 项目断号 KB-1/2/6——`createInStore`/`createKnowledge` 都先 `allocateKey`（计数器已推进）后校验，tags/type 被拒时编号已消耗，审计上像「丢了的工单」。② 修法：拆出 key 无关的纯校验 `validateNewIssue`/`validateKnowledgeDraft`（summary/type/priority/status/tags/resolution/domain/title），加载词表+校验挪到 `allocateKey` **之前**；分配仍在写锁内，锁序不变（读无锁 → store 锁分配即放 → issue 锁写）。③ **回执带机器可读标记**：被拒时 `context.keyAllocated === false`（英文 message 纪律不变），人/agent 都能确认「这次没烧号」。④ 测试 +2（五种拒绝各断言计数器未建 + 下个号紧跟）；变异验证：校验挪回分配后 → 两侧用例都红。⑤ 断号历史（KB-1/2/6）不改数据，新行为从此生效。（决策 44/58/74/176、§4.7） |
| 191 | **失败的 settle 要重试，失败了要有人看得见**（CI 两次在无辜的提交上变红的根因） | ① **现象**：2026-10-19 账本 CI 在 `7b7fef9`（`DPMJ-213: assignee`）上红，原因是"派生文件 stale"——提交序列是 `settle → comment → assignee`，后两条写入都没有 settle。**不是"忘了 schedule"**（`toolIssue.ts` 的 create/update 两条路径都调了 `onWrote`，插件两个工具入口都传了 `queue.schedule()`），而是 **`void flushNow({...})` 把结果丢掉了**：settle 失败（两台机器同时推时 `pull --rebase` 被拒、或 push 非快进）→ 决策 148 拦住 push → 提交留本地、派生文件 stale，**而且没有任何输出**。② **修法 A（重试）**：`scheduleRetry`——失败后按 `debounce × 2^n` 重排，**最多 3 次**，成功即清零；**"`pull --rebase` stopped" 不重试**（红线上真冲突必须人看），只重试能靠等待自愈的（push 被拒、锁超时、pull 跑不起来）。③ **修法 B（可见）**：`onOutcome` 把结果写进机器本地 `<stateDir>/push/last-failure.json`（成功则删除），`/jira status` 多一行"上次推送失败（时间）：原因"；**永远不进账本**。④ 测试 684 → **688**：重试三次后成功、封顶后不再重试、stopped rebase 不重试、status 的三态；变异验证（去掉 `.then(scheduleRetry)`）→ 两条用例红。⑤ 这也回答了 DPMJ-103 里"失败可见"那条建议——它当时只做到了 CLI 的 `sync` 打印领先/落后，**插件那条路今天才补上**。（决策 60/84/119/148/177、§4.13、§5） |
| 192 | **工具面能建标签了，`UNKNOWN_TAG` 也会说人话**（DPMJ-213 / 试用反馈 P0-2） | ① **现象**：只走工具面的 agent 拿到 `UNKNOWN_TAG` 且 `suggestions: []` —— 而工具面**根本没有创建标签的动作**（`tag-create` 只有 CLI，决策 138），于是它 8 条 issue 全部无标签，标签体系对 agent 形同不存在。② **修法一（可达）**：`jira_issue` 新增 `tag_create` action（`data: { name, description, alias? }`），走**与 CLI 同一条** core 路径（`tagstore.createTag`）；`description` 必填（注册表存在的意义就是解释这个标签，决策 26）；建完照旧 `onWrote()`，所以下面的 settle/推送与其它写一致。**工具数与动词数都变了**（七动词 → 八），`surfaces.test.ts` 的"CLI 覆盖工具面"映射表当场要求补 `tag_create → tag-create` —— 这条守卫正是为这种"只加了一侧"准备的。③ **修法二（有话说）**：`unknownTag` 现在带 `registered`（**全量注册表**，不再只有"相似建议"），注册表为空时 message 明说"还没有注册任何标签"并给 `hint` 指向两条创建途径。④ 技能：`jira-work` 加"标签必须先存在"一节，`jira-triage` 加"标签是词汇不是自由文本"。⑤ 测试 688 → **689**：一个**纯工具面**的闭环（`tag_create` → 带标签的 `create` → 未注册时错误里带全量 `registered`）；变异验证（把 action 名改掉）→ 用例与 surfaces 一起红。⑥ 没有另开 `jira_tag` 工具：那是新工具、新 schema、新超时口径，而"给 issue 打标签"的入口本来就是 `jira_issue`，`tag_create` 放这里最省且可发现。（决策 26/55/82/83/138、§6.1） |
| 193 | **`close` = 状态迁移 + 收尾评论，一次事务**（DPMJ-214 / 试用反馈 P0-3 的一半） | ① **现象**：试用 agent 走完 8 条 issue 的生命周期用了 **31 次写、31 个 commit**；关一条最短也要 `comment` + `switch_state` 两次写——agent 场景下这是上下文与出错面各翻一倍。② **修法**：`core/mutate.applyClose` —— 先按普通规则做迁移（`applyTransition`，含 resolution 必填、迁移合法性），再把评论用 `applyComment` 追加到**同一个 `Change`** 里，于是它是**一次 `transact`、一个提交**。**不是旁路**：两条规则都照跑，任何一半失败都整笔不落地。③ 两个面都加了：工具 `jira_issue` 的 `close` 动词（`{ key, resolution, resolution_note?, comment? }`），CLI `jira close <KEY> --resolution … [--comment …] [--to …]`；`surfaces.test.ts` 的"CLI 覆盖工具面"映射与"命令清单"两处都要同步（守卫把两侧钉在一起）。④ **状态机不变**：`todo → closed` 仍被决策 189 拒绝（测试里专门断言 `INVALID_TRANSITION`，先走到 `in_progress` 再关）——复合动作只是组合，不是特权。⑤ 收尾文案进了 `core/messages.ts`（决策 184 的"一句一处"守卫要求登记，测试当场逼我加）。⑥ 测试 689 → **690**：一次 `close` 只多**一个**提交、评论与 resolution 同时落地、`todo → closed` 仍被拒。⑦ **`batch` 那一半没做**：多键一次提交的"部分成功"语义（全成或全不成？失败时已成功的要不要回滚？）是设计决定，已单独开 DPMJ-219 并附两个方案请人拍板。（决策 44/72/82/83/125/189、§6.1） |
| 194 | **两套 key 空间不许混淆：`KB` 不能当新项目名，知识条目不能引用知识条目**（DPMJ-215 / 试用反馈 P1-3） | ① **现象**：知识键是全局 `KB-<n>`，issue 键是 `<PROJECT>-<n>`；试用 agent 把项目取名 `KB`，于是 `KB-12` 既可能是知识条目也可能是 issue。**它真的咬过人**：知识条目 KB-14 写 `issues: [KB-11, KB-12]`（本意是 issue），而 KB-12 是另一条知识条目 —— `lint` 报 `kb-issue-dangling`，但那是**写完之后**，账本 CI 因此连红三次。② **对症一（新项目占不到这个名字）**：`RESERVED_PROJECT_KEYS = ['KB']` + `assertProjectNameFree`——**只拒绝"新建"**，已存在的 `projects/KB` 照旧可用（本账本就有；追溯拒绝会把现有数据变成错误）。接在两条创建路径上：`bindProject`（工作区登记）与 `createInStore`（`create --project KB` 会隐式建目录，所以也要挡，且**在分配号之前**，与决策 190 同一条纪律）。③ **对症二（把悬空提前到写入时）**：知识条目的 `issues` 现在会校验——**引用一个已存在的知识条目的键**会被拒（"那是知识条目，不是 issue"）。只拒**可证**的错：引用一个**还不存在**的 issue 仍然允许，因为两台机器常常先合并引用再合并 issue（`lint` 的 `kb-issue-dangling` 仍然负责报告那种情况）。④ 测试 690 → **693**：`bindProject('KB')` 被拒但已存在的 KB 可登记、引用知识条目被拒且错误里带 `confused`、引用未来 issue 仍放行。两处变异验证（去掉保留字 / 去掉引用校验 → 对应用例红）。⑤ 记一笔：**CI 额度紧张，两个仓库的 workflow 已 `disabled_manually`**，本轮推送不触发 Actions；恢复时 `gh workflow enable ci.yml`（插件仓）/ `ledger.yml`（账本仓）。（决策 26/74/190、§4.7、§5） |
| 195 | **体验批：本地时间、项目隐式创建可见、列表短身份、空结果计数、kb 回执带路径、何时 sync**（DPMJ-217 + DPMJ-218 的落地） | ① **人面给本地时间**（P2-1）：`withLocalTime` 把 `…Z` 打印成 `…Z（本地 2026-10-19 19:37 +08:00）` —— 落盘仍 UTC（决策 47），只是展示；带偏移是为了贴到别的机器也读得懂。② **隐式建项目不再无声**（P2-2）：`create` 前看 `projects/<P>/` 是否已存在，不存在则在回执里带 `project_created: true`（常见情况不出现这个键）。③ **列表用短身份**（P2-4）：`agent:unknown|dsh|m-357504ff|session-a9beb0bc` → `agent:357504ff/a9beb0bc`；`human:` 与人造畸形串原样，**全文留在 `get`**（那里它是主体，不是装饰）。④ **空结果说个数**（P3-1）：`no issues match` → `no issues match (0 matched)`，与"坏了"区分开。⑤ **`kb create` 回执带 `file`**（P3-2）：`knowledge/<domain>/KB-<n>.md`，不用再靠约定猜目录。⑥ **skill 写明何时 sync**（P3-4）：`jira-work` 新增一节——要停手时、刚 pull 完、以及 **`/jira status` 说"本地领先 origin N 个提交"** 时；并说明 `sync` 也是推送被拒后的修复路径。⑦ **两项没做，写明理由**：**写返回紧凑化**（P2-3）要动输出 schema 与 surfaces 契约测试，且与 DPMJ-214 的复合动作返回体耦合，值得单开一条而不是在体验批里顺手动；**相似度提示**（P3-3）成本在"拿什么算相似"上没有公认口径，收益不明确，先不做。③④⑤ 都有测试（696 = 693 + 3）。⑤（决策 47/55/82、§6.1） |
| 196 | **`batch_close`：一个调用关多条，全成或全不成**（DPMJ-301，用户裁定 A） | ① **语义（用户选 A）**：先对所有键做**只读预验**，任何一条被拒就**一条都不写**，错误里列出每个被拒的键与原因（一次调用就能把所有要修的都告诉调用者）；全部通过才逐条事务写。② **预验与写入共用同一套规则**：预验是拿解码后的 issue 直接跑 `applyClose`（状态机、决策 189 的"必经 in_progress"、resolution 必填、项目可写），**不是复述一遍规则** —— 复述出来的第二份实现第一次改规则就会漂。③ **诚实说明一处残留**：git 这边没有多文件事务，所以"验证通过之后、写入途中"的失败（锁超时、竞态）仍可能留下部分结果；这种情况**显式**返回 `{ closed, partial: { closed, failed: { key, error } } }`，CLI 以退出码 1 报出来——不粉饰。④ 两个面：工具 `jira_issue { action: "batch_close", keys: [...], resolution, to?, resolution_note?, comment? }`，CLI `jira batch <KEY…> --resolution R`；`surfaces.test.ts` 的映射与命令清单、`index.test.ts` 的动词表（十动词）都同步。⑤ 测试 696 → **698**：一条 `todo` 的键让整批**一个字节都不写**（并断言另一条仍是 `in_progress` —— 证明拒绝发生在任何事务之前）、全通过时逐条关闭并带评论。⑥ 记一笔：`maxPositionals: 50` 是**一次调用的上限**，不是键空间的上限。（决策 44/58/82/189/193、§6.1） |
| 197 | **doctor 说真话：已关闭 issue 的历史租约不再报、`summary.tags` 不再是硬编码 0**（DPMJ-401 的落地，2026-10-23 数据体检） | ① 体检实测：37 条 `lease-expired` 警告**逐条核状态后未关闭的 0 条**——已关闭 issue 的 `claimed_at`/`lease_expires_at` 是历史，不存在"可重新认领"，噪音随账本年龄线性增长、会盖住真正需要认领的开放 issue。② 修法：租约检查挪到词表解析之后，用 `vocab.closed` 过滤（区分"关闭集合"与"关闭状态"，与决策 189 一致）；没有词表时退回 `['closed','cancelled']`。③ `summary.tags` 从 `doctor.ts` 的硬编码 0 改成 `snapshot.tags`——snapshot 读取器数 `tags/*.md`（排除生成的 index），人面摘要行也把标签数说出来（此前渲染里根本不出现）。④ 测试 698 → **700**：关闭态历史租约静默、开放态照报、tags 计数与渲染。⑤ 顺带把「账本：N 个项目，M 条 issue，K 条评论，**X 个标签**，Y 条 conflicted」的模板固定下来。（决策 61/120/140/189、§4.8） |
| 198 | **引用要成对：知识条目引用 issue 时，自动把知识键回填进该 issue 的 `kb_refs`**（DPMJ-402 的落地，2026-10-23 数据体检） | ① 体检实测 6 条 `kb-issue-one-sided`：KB-12→KB-4/9/10、KB-13→KB-10/11、KB-14→KB-11 只在知识侧写了引用——决策 75 说两边是同一件事的两面，实际只落了一面。② 修法：`kbstore.mirrorKnowledgeRefs` 在 create/update 成功之后逐个 issue 补 `kb_refs`（**幂等**：已有则跳过）；每个 issue 走自己的 `transact`（git 没有跨文件事务），**部分失败显式放进 `mirror.failed`** 而不是藏起来。③ 数据修复走新代码本身：对 KB-12/13/14 重跑 `kb update`，镜像把 4 条 issue 的 `kb_refs` 补齐（同一个写事务链，不是手改文件）。④ 两个面都看得见：工具返回 `mirror`、CLI 在人面输出「已回填 kb_refs：… / 未能回填 …」。⑤ 测试 700 → **702**；变异验证：去掉镜像调用 → 2 条红。（决策 75/194、§4.13） |
| 199 | **把「副作用边界」从约定变成守卫：`check-boundaries` 新增 IO 白名单规则**（架构复查的落地，2026-10-23） | ① 复查发现决策 180 的不变量**没有守卫**：`core/` 里除了 io/git/lock/hooks 不许直接 import `node:fs`/`node:child_process`，但这条只写在决策里——于是 `project.ts` 悄悄长回了 `import { access } from 'node:fs/promises'`（决策 194 的 `assertProjectNameFree` 用了裸 `access`），而 `pnpm check` 照样全绿。② 修法：`scripts/check-boundaries.mjs` 加 **IO 白名单**（`core/io.ts` 文件 IO、`core/git.ts` 子进程、`core/lock.ts` 的 mkdir 原语、`core/hooks.ts` 的 git shim），规则只在 `core/` 生效（决策 102① 把副作用放在 adapters）；自检从 13 条加到 **20 条**（新口径本身被测，含"plugin 允许、testing 允许、project.ts 必须被拒"）。③ 真回归修复：`project.ts` 改走 `io.exists`。④ 教训：**任何"只写在决策里"的不变量都会回退**——守卫脚本才是事实。（决策 64/102/180、§3.1） |

### 历史：曾经待确认的项（**已全部结清**）

| # | 原待定项 | 结论 |
|---|---|---|
| 1 | ~~`machine_id` 的 `os` 只用平台~~ | ✅ **已定案**（决策 73：`os` 用 `process.platform`） |
| 2 | ~~SN 取不到时回退为持久化随机 id~~ | ✅ **已定案**（决策 73：文件固定 `$DSH_HOME/dsh-jira/machine-id`，故意在 store 之外） |
| 3 | ~~fork 场景优先取 `upstream`~~ | ✅ **已定案**：`upstream` > `origin` > 其它（决策 77、§4.10） |
| 4 | ~~CLI / `/jira` 子命令集合~~ | ✅ **已定案**（决策 83：CLI = tool 超集 + 运维类；`/jira` 只读五命令） |
| 5 | ~~KB 检索方案~~ | ✅ **已定案**（决策 37、§11.1） |

### 待验证（不是决策，是事实）

- ~~§2.7 的 spike~~ → ✅ **已结案（决策 101）**：宿主平面 `insert` 可见、安装单元是 bundle 包。 方案 ④（`preset:` patch）因出处不存在（§11.2）**不入方案**；若当初不行则转内置插件（决策 97）。
- ~~插件能否读当前会话的 `SessionHeader`~~ → ✅ **已查明（决策 96）**：`exec.agent.session.header` 直接可读（`origin` / `parentSession` / `delegationDepth`）。
- ~~DSH 有没有会话级 seam~~ → ✅ **已查明（决策 100）**：有——`agent/created` 时注册的 `agent.ctx.effect(async)`（被 await、在写句柄关闭前）；`session/disposed` 只是不 await 的兜底。

---

## 9. 已知风险与文档空白

**技术风险**

1. **~~tool 是否被 agent preset 白名单拦截~~ → 已定性，见 §2.7。** 结论：`dsh web` 里由 preset roster 决定可见性，但宿主层注册的 tool 属于全局 scope、理论上沿父链可见。 **建议做 spike 验证（① 宿主层 insert / ④ `preset:` patch）**——但它**只影响分发方式、非阻塞**（§11.2 已据此重新定性）。
2. **多机离线创建撞号**（§5）。用**每机一份** `counters/<machine_id>.json` 的块分配化解—— 连计数器文件都不冲突；真正可能冲突的只剩低频的 `config.md`。
3. **人类编辑与自动提交纠缠**。红线：永不 `checkout --force` / `reset --hard` / `clean`； 检测到脏工作树就先作为独立 commit 提交掉。这条要有测试覆盖，不能只靠自觉。
4. storage 相关 seam 对第三方插件**未授权也未禁止**（`appendPluginRecord` 是唯一明确禁止项）。 → 本案不用它们，规避。
5. 插件绕过 workspace 文件沙箱在进程内执行（Host 插件语义）。写自有数据目录是合理的， 但**写用户工作区需谨慎**，且只读会话下 `.dsh` 不可写。

**文档空白（需我们在自己 README 里定义并写清）**

1. 无"插件数据目录"约定 → 自定 `root`，默认 `$DSH_HOME/jira`。
2. 无非会话 JSONL 的 schema/迁移策略 → **每个文件都带 `schema: <kind>/v<N>`**（决策 46，含 `config.md` 的 `schema: config/v1`）； 并靠"只增不删 + `deprecated`"策略**从根上避免数据迁移**（§4.2）。
3. 无公开的原子写/fsync 助手 → 自己实现（temp + fsync + rename）。
4. 无 Workspace 扩展点 → 自存映射。
5. 无 per-user 分区模型 → 单用户假设，多用户暂不支持。

---

## 10. 参考

- `docs/user/develop/basic/publish.md` — 打包与安装 bundle
- `docs/user/develop/basic/tool.md` / `docs/cookbook/adding-a-tool.md` — tool 编写
- `packages/boot/plugin-manager/README.md` — 安装、版本兼容、豁免
- `docs/subsystems/skills.md` — skill provider 与发现顺序
- `docs/subsystems/system-prompt.md` — prompt section 与 PromptContext
- `docs/subsystems/storage.md` / `packages/storage/*/README.md` — 存储 seam 及其限制
- `docs/subsystems/persistence.md` / `docs/subsystems/session.md` — 会话日志契约
- `packages/uitstalie/tool-dsh-store/README.md` — 本 fork 的 `.dsh` 约定

---

## 11. 未决与待办（可跨会话恢复）

### 11.1 KB 检索：审计定案（本节已不再暂停）

**审计对象**：`D:\dqc\kb-llm` —— 公司 GitLab 上的两个仓：`KB-LLM-Deploy`（Python / FastAPI / systemd 引擎，多用户内网服务）+ `KB-LLM-WIKI`（知识内容仓，OKF 风格：`index.md` / `log.md` / `domains/<域>/六层`）。

**四条定案（决策 37）**

1. **关键字检索：要，但不要索引——直接扫真相源文本。** 实测（Node 24，本机，`domains/` = 上游正式库）：

   | 语料 | 文件数 | 体量 | 全量读入 | 单次全量扫描 |
   |---|---|---|---|---|
   | `KB-LLM-WIKI/domains/` | 59 | 116 KB | 13 ms | **0.3 ms** |
   | `KB-LLM-WIKI/`（全仓含 raw/staging） | 135 | 351 KB | 26 ms | **1.5 ms** |
   | 外推 3000 个同类文件 | 3000 | ~8 MB | ~0.6–1 s | 数十 ms |

   → 本插件的 store 只会更小。**检索 = 遍历 store 里的 `.md` 做子串 / 正则匹配**， 不建索引、不引数据库。收益：**永远与真相源一致**（不存在"索引过期"）、零依赖、 离线天然可用（决策 34）、Fedora / Windows 行为一致、实现量近乎为零。

2. **向量检索：不做。** 上游实测体量是**全部 30 篇知识 = 430 个 chunk**，为此付出 **458 MB 模型 + faiss**、全量重建 4.6–5.7 s、冷启动 6–8 s（上游 `README.md` §B/§C）。 而且 V1 的向量腿本身带两个已确认缺陷：**512 字符定长切片 → 96.8% 的 chunk 被模型 128 token 窗口静默截断**（`task/0028` R7，评级"高"）；`IndexFlatIP` 打在**未归一化**向量上 （语义上不是余弦），且排序里**相似度根本不参与**。再加上**离线机下不了模型** （内网到不了 huggingface.co，只能走镜像）——与决策 34 直接冲突。

3. **RAG 管线：不做。** 本插件的 KB 是"给人 / agent 找到条目"，不是"生成答案"。 上游 V2 的 `rerank` 插槽至今是 `_NotImplementedStage`（一调用就抛错）、没有生成环节， 且 `expand` 未做文档级配额 → 实测 top-10 里 **76% 是同一篇文档的不同块**（`task/0040`）， 所以它自己都还没上生产（生产配置里没有 `enginev2:` 段）。

4. **本地 CPU 模型做辅助预测：明确不做。** 上游在"域 / 项目检测、图片语义"这些辅助预测上 **全部是启发式规则、零 ML 模型**（`utils/project_detector.py:1-13` 明写"不调用 LLM， 纯 keyword 匹配保证速度"）；唯一引入的本地神经模型是 embedding，而 `Qwen3-Embedding-0.6B` 在无 GPU 机器上 1.6 块/秒被**淘汰出局**（`task/0038:160-166`）。 这是别人用实测换来的结论，不必再交一遍学费。

   > **修正记录**：本节上一版写着"'用本地 CPU 模型辅助预测'与离线要求天然契合——选型时应给它加分"。 **那个加分是错的**：离线要求只说"必须本地"，不说明"必须用模型"。上游的实测结论是 **辅助预测用规则就够，模型反而是纯粹的负担**。结论按上表改为"不做"。

**关键字检索的做法（唯一还需要定的技术细节）**

- **首选纯文本扫描**；规模真的上千条以上再谈 SQLite FTS5。
> **何时该换**（决策 85）：**p95 > 200 ms** 或 **文件数 > 5000** —— 由 `jira doctor` 报告这两个量，**不拍硬阈值**。
- 若将来上 FTS5：实测本机 Node 24（SQLite 3.50.4）**支持 `fts5(tokenize='trigram')`**， 中文**无需分词器**、零外部依赖。但它的边界必须写进设计：
  - 3 字及以上才命中，且是**子串匹配不是语义匹配**（"充电状态"在文中不连续出现就不命中）；
  - **2 字查询必然不命中**（实测 `"耗电"` / `"帧率"` / `"充电"` 全部 0 命中）——而中文技术词 大量是两个字。上游把这条写成已知边界（`enginev2/store/db.py:9-11`）。 → **即使将来上 FTS5，也必须保留短查询的子串兜底**。这也再次说明"直接扫文本"才是本场景正解。
- 排序可用 bm25（`bm25()` 返回**负值**，越负越相关——上游 `store/db.py:213-222` 的做法）。

**要抄的工程做法（来自上游 `enginev2/`，按价值排序）**

| 做法 | 出处 | 为什么抄 |
|---|---|---|
| **结构感知切块 + token 口径单点收敛 + 往返校验** | `enginev2/index/chunker.py`（507 行纯函数，42 项不变量测试）、`enginev2/index/tokenizer.py` | 若将来真要切块：按 Markdown **显式结构**切（标题 / 围栏代码 / 表格 / 列表 / 段落），按 **token** 定档而非字符；`encode→decode` 必须还原，专防"吞中文"。上游正是"512 字符当成 512 token"翻的车 |
| **派生数据自描述 + sha256 对账 + 对不上直接抛错** | `build.py:156-175`、`store/db.py:242-256` | 派生物必须能自证与真相源一致，**不猜兼容** |
| **先写 `.tmp/` 再整体 rename** | `build.py:103-107,180` | 与 §5 的原子写规则互补 |
| **AST 边界检查器进 CI** | `scripts/enginev2_boundary_check.py` | 用机器守卫"只有 X 可以 import Y"这类架构规则，不靠自觉 |
| **协议参数单一事实来源 + 测试守三处一致** | `enginev2/params.py::FIELDS` | 我们的 tool / CLI / 斜杠命令同理 |
| **"没命中"与"索引坏了"分开报；范围校验抛错、不静默夹值** | `store/db.py:194-203`、`params.py:23,51-64` | 与 §4.13「写入侧严格」同源 |
| **评测必须只读防污染**（打桩 no-op 掉写路径 + 前后 `git status` 与 sha256 比对） | `scripts/eval_retrieval.py:28-35` | 检索评测不得改真相源 |

**明确不抄（反面教训，每条都有实测代价）**

1. **查询会写真相源**：上游**每次查询**都起后台线程写 `domains/*/_vitality.yaml` （`engines/query.py:284-302`；`MCP.md:489` 把它列为已知限制："同一句查询会改数据仓， 所以'昨天能查到、今天排序变了'是正常现象"）。→ 我们**读操作绝不写任何文件**（决策 38）。
2. **知识代际 / 活力分（G0–G3 + `_vitality.yaml`）**：自造复杂度，实测**已停摆** （cron 缺 `PYTHONPATH`、多数文档恒 G0），并被迫退化为"默认不过滤" （`query.py:105-110` 注释：旧行为"等于一个只降不升、慢慢把知识变成查不到的系统"）。 单人单用户**不需要知识老化**，最多用 `updated` 做排序微调。
3. **`pickle` 存索引**（V1 的 `chunks.pkl`，反序列化即任意代码执行）→ 派生数据只用 JSON / JSONL。
4. **死配置**：`#POLICY.yaml` 的 `similarity_threshold` / `max_raw_text_chars` / `require_human_confirm` **三处没有任何代码读取**，其中 `require_human_confirm: true` 与 `auto_promote` 默认 `True` 并存 → "看起来有人工批准，实际全自动"。 **声明式配置必须有代码引用 + 测试，否则就是治理幻觉。**
5. **"跳过 = 通过"**：上游专门为此让 `schema_found` 参与阻断判据 （`okf_validator.py:298-307`）——**契约文件找不到时，绝不能把"没有报错"读成"合规"**。
6. **只报告、无人消费的 lint**：上游六项 lint 质量不低，但 CLI 恒 `return 0`、无 CI、无 hook， cron 写的报告在仓里根本不存在。→ **要么做成门禁，要么别做**（与 §4.14 的 `/jira tags lint` "只报告不改"有区别：那是**有意让人定夺**，上游那条是**没人看**）。
7. **以 IP 当用户身份**（`utils/client_identity.py`；实测同一个人两块网卡被拆成两行统计） → 身份必须稳定（§4.11 / §4.12 的 machine_id + tool 正是为此）。
8. **生成物与手写物同文件、靠魔法字符串分段**（`log.md` 的 `## 事件流` 段由引擎重写） → 我们的生成物必须单独成文件（§4.4 已如此）。
9. **key 事后反查兜底**（`promotion_service.py:52-88` 三级模糊匹配）→ key 必须在创建时固定 （§4.10「key 不可变」已覆盖，此处是外部佐证）。

> **架构约束不变**：万一将来真要引入向量 / 索引，**它必须是可重建的派生物、进 `.gitignore`， 绝不能是真相源**（OKF 文本才是）。这一条与上面"不做"并不矛盾——那是引入的前置条件。

**数据与派生层的实况（同一审计的第二条线）**

- **真相源 = Markdown**：上游数据仓里**只有文本**；9 个 SQLite（SAG / 任务状态机 / LLM 作业队列 / 公共总线 / 打点 / token 用量 / 建域申请 …）与 2 组文件型索引（faiss+pickle、enginev2 四件套） **全部落在仓库之外的 `<install>/var/`**，`.gitignore` 的原话是"**可重建，不入 review**"。 → 与 §4.4 的做法一致，**我们的方向是对的**。
- **体量确认**：数据仓 **5.54 MB / 178 文件**，其中正文文本只有 **261 KB / 8.5k 行** （`domains/` 正式库 59 文件 / 116 KB，内容 33 篇 / 4 个域 / CJK 占 36%）。 → 再次印证决策 37：这个量级不需要索引。
- **反面教材（V1 的"位置即身份"）**：faiss 第 i 行 == `chunks.pkl` 第 i 项，**两个独立文件、 没有任何跨文件校验和**，只靠"维度相等"当护栏；版本一旦错配就**静默返回错的文本**。 → 派生数据必须像 V2 那样**自描述 + 对账（sha256）**，对不上**直接抛错**。
- **上游没有迁移框架**：索引"对不上账就丢弃重建"；SQLite 用 `CREATE IF NOT EXISTS` + `ALTER TABLE ADD COLUMN` 吞异常。→ 我们的"只增不删 + 改边下线 ⇒ 零迁移"（§4.2）更省事，保持。
- **生成物会悄悄腐烂（实证）**：上游 `index.md` / `log.md` 由 **ingest 进程内的 hook** 重写， 而这条链被 `except Exception: warning` 包着 → `index.md` 的生成日期停在 **2026-08-04**， 而 `systemui` 域是 **2026-10-09** 才加的，**整域缺失两个月无人发现**。→ 由此得到决策 39。
- **`log.md` 是"上段手写 + 下段生成"**，切分点是一个魔法字符串 `## 事件流`： **人一旦改了这个标题，整段手写历史就会被当成事件流覆盖掉**。→ 生成物与手写物**必须分文件** （§4.4 已经如此）。
- **血缘字段过窄的代价（实证）**：上游的来源字段只有 `file / page / section`， **没有来源机器 / OS / 工具 / 采集时间 / 原文哈希**；缺口靠一个"猜来源"脚本回填 （标题关键词命中 → 日期就近匹配），结果 **power 域 9 篇不同文档全部指向同一份 993 B 的 raw 文件** ——覆盖率数字好看，**血缘分辨率不可信**。→ 我们的 KB 条目必须把 `machine_id / os / tool / captured_at`（必要时 `source_sha256`）**做成必填**， 且**禁止事后启发式回填**（§4.13 已定，此处是外部佐证）。
- **一份可直接用的检查清单**：上游 `.gitignore` 只挡了 `*.sqlite`、**没挡 `*.db`** （`sag.db` 靠单独一行才被挡住）；数据仓**根本没有 `.gitattributes`**，而 `#POLICY.yaml` 的注释却声称"git 跟踪需要在仓根配 .gitattributes"。→ 我们的 `.gitignore` / `.gitattributes` 必须**按模式覆盖全部扩展名**，且**注释不得与事实不符**。
- **敏感内容警告**：那份审计对象在**公司内网 GitLab** 上，里面含真实 JIRA 单号（`BERYLV-*`）、 员工姓名、内部项目代号与未发布产品的功耗结论。`D:\dqc\kb-llm` 现在是一份 **纯文本、可整体复制的内部数据快照**——**本插件若要拿它做测试或演示，必须先脱敏。** （密钥没有泄漏：`config.yaml` / `tokens.yaml` 都被 gitignore，模板里只有 `@PLACEHOLDER@`。）

### 11.2 tool 可见性 spike：**已结案**（§2.7 / 决策 101）

> **两个宿主版本的已实测差异（本轮，源于 spike ③ 的对比核查）**
>
> - **判据本身两版逐字相同**：`SessionHeader.parentSession` / `origin`（**取值集合只有 `"subagent"`**）/ `delegationDepth`、`SESSION_FORMAT_VERSION = 4`、`delegationDepthOf`（`packages/subagent/subagent/src/depth.ts:28-36`，两版 byte-identical）。
> - **行号会漂移**：`Session.header` rc.2 `packages/core/session/src/index.ts:464` vs alpha.2 `:540`；`SessionStore.get` rc.2 `:1227` vs alpha.2 `:1351`。→ **引用必须标版本（决策 98）**。
> - **alpha.2 的 breaking 改名**：`ctx.subagents` 的 `startContinuable` → `startActivation`、`drainContinuable*` → `drainDescendants`/`drainChildren`。**本项目不用它**，但将来若用要按版本写。
> - **`mode: "external"`**：alpha.2 的 `SubagentCatalogEntry.mode` 多了 `"external"`，且这类条目**不能打开子会话**——所以"进程外子代理不受 `origin`/`delegationDepth` 判定约束"这条限定**在 alpha.2 更明确**。

**✅ 已结案（决策 101）**：`dsh web` 里**宿主平面 `insert` 可见**；安装单元必须是 **bundle 包** （声明 `dsh.bundle.patch`），且实测 `dsh plugin add <路径>` **自己就会把包加进 `dsh.profile.bundles`**—— **手工再 insert 一遍是重复来源**（实测无害，但违反单一来源，已清理）。 方案 ④（`preset:` patch）**不入方案**：其唯一出处 `docs/architecture.md:25` 在本版本不存在（见下）。

> **待核（Windows 机实测，DSH `0.2.0-rc.2`）**：本机 checkout 的 `package.json` 与 `$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh` **都是 `0.2.0-rc.2`**， 而 §2.2 与本文抬头记录的是 `0.2.1-alpha.2`。逐条核对设计所依赖的 seam：
>
> | 依据 | 本机结果 |
> |---|---|
> | `deferLoading` | ✅ 存在（`docs/subsystems/llm-streaming.md:678`；本文引 672-683，命中区间） |
> | `isConcurrencySafe` | ✅ 存在（`docs/subsystems/tools.md:84`；本文引 71-80，漂移 4 行） |
> | `PromptContext` | ✅ 存在（`docs/subsystems/system-prompt.md:76-135`；本文引 44-76，漂移约 30 行） |
> | `customSkillDirs` | ✅ 存在（`packages/bundle/web-app/presets/cordis.patch.yml:146`，逐行命中） |
> | preset scope 可见性判据 | ✅ 逐字命中（`packages/preset/agent-preset-registry/README.md:56`） |
> | **§2.7 方案 ④ 的出处** | ❌ **`docs/architecture.md:25` 不存在**，且 `docs/**` 与 `.agents/**` 搜不到 `preset patch` / `` `preset:` `` |
>
> **✅ 已核实（2026-10-16，本机把两个 checkout 都查了）——是版本差，不是文档搬走**： `docs/architecture.md` **两版都存在**（rc.2 166 行 / alpha.2 165 行），但**第 25 行的内容不同**：
> * `0.2.0-rc.2` 的第 25 行讲 `dsh-base` 与各 bundle 的层叠，**没有** preset patch；
> * `0.2.1-alpha.2` 的第 25 行**明确写着** preset patch：*"A `preset` patch applies these operations inside that declaration's `config.plugins`, with the same layer precedence."*
>
> 而 preset 机制的**文件**（`packages/bundle/web-app/presets/cordis.patch.yml`）**两版都在**—— 所以机制两版都有，只是 rc.2 的文档没写它。**方案 ④ 仍按决策 101 不入方案**（① 已实测可用）， 这条"待核"就此结案。 另：**peer 版本与豁免（§2.2）已经与本文无关**——决策 109 之后本包**不声明任何 peer**， 所以"按部署机的版本写 peer"这个待办自动消失（`engines` 仍跟 DSH 的 Node 范围）。

### 11.3 尚未问完的设计点（**已全部结清**）

> 本节曾挂 4 项，现均已定案；保留此处仅作索引：
>
> - **CLI 子命令集合、`/jira` 子命令集合**（原 §11.6 的 B30） → ✅ **决策 118**（CLI 十个子命令；`/jira` 六个）
> - **subagent 是否有写权限**（B16） → ✅ **决策 89 / 96**（主 agent 可写、subagent 只读）
> - **`goal` / `todo` 是否与 issue 打通**（B17） → ✅ **决策 90**（明确**不打通**）
> - **skill 的最终拆分** → ✅ **决策 88**（三个技能，正文英文、示例用真实数据）
>
> 另：**包结构 → 决策 64**、**工具链与测试框架 → 决策 66**、**CI 矩阵 → 决策 66**、**KB 检索 → 决策 37**。

### 11.4 正确性红线（实现时不可忘）

1. **绝不** `checkout --force` / `reset --hard` / `clean`；脏工作树先作为独立 commit 提交掉（§5）
2. **`.gitattributes` 是仓库的第一个文件**：`* text=auto eol=lf`；评论文件 `merge=union`（§5） 锁用 **`mkdir`（唯一原语，决策 59）**，**不用 `flock`，也不引第三方锁库**
4. **不解析人类可读的 `git log` 输出**，用 plumbing + NUL 分隔（§5）
5. 写事务里**绝不 push**；**绝不隐式 pull**（§5）
6. 提交绑定要**校验 key 真实存在**，不只看格式（§6.7）
7. **CI 只管结构合法性，不管策略状态**（§4.15）

### 11.5 独立实例的归并（由决策 35 / 36 推出）

离线机是**空的本地实例**，与主 store 之间**没有共享历史、也没有共同祖先**。 **默认状态下两者不合并**——独立实例相当于一个"新分支"，key 空间各自从 `1` 开始， 所以**不需要预留号段，也不需要把机器维度编进 key**（决策 36）。

只有两种例外，且都必须**显式发起**：

| 情形 | 做法 | 要点 |
|---|---|---|
| **复写**（不需要保留对方细节） | 用一份数据**整体覆盖**另一份 | 等价于换掉数据源；仍受 §5 红线约束——**绝不静默覆盖**：覆盖前要确认/备份，且不得丢掉未提交的人类改动 |
| **归并**（需要保留双方） | 一次**人工重编号 + 数据重新编排** | 重新分配 key；`links[]` 与评论正文里的 key **全部改写**；产出**旧 key → 新 key 映射表**。`commit message` 里的旧 key **改不了**，只能靠映射表解释 |

**归并的落地形态（决策 94 已定清）**

| # | 待定 | 说明 |
|---|---|---|
| 1 | 归并的粒度与顺序 | 按 project 还是按 issue？被引用的 tag / KB 条目要不要一起搬 |
| 2 | 映射表的存放 | 进 store（可审计、可被工具读取）还是临时产物？悬空引用要靠它解释 |
| 3 | 归并后的审计 | `reporter` / `machines/` 必须保留来源机器；是否需要一条"由 X 机归并入"的事件 |
| 4 | 差异报告的内容 | 怀疑同一个 project、同 key 不同内容、同 tag 不同 `description`（§4.14 的 `aliases[]` 正好可用于吸收同义 tag） |
| 5 | 频率与方向 | 一次性搬迁，还是长期双向？**长期双向等于自建一套同步协议，应尽量避免**（与 §4.5「不自己造审计系统」同一取舍） |


> **结论（决策 94）**：① 粒度 **按 project**（连带 issue / 评论 / `kb_refs`；tag 先合注册表、KB 撞号同样重编号）· ② 映射表**进 store**：`_merge/<UTC>-from-<machine_id>.md`（**不是临时产物**——commit message 里的旧 key 改不了，只能靠它解释）· ③ **不另造归并事件**，靠 `reporter` / `machines/` + 映射表头部 · ④ 差异报告四类 · ⑤ **一次性搬迁，不做长期双向**。**工具：MVP 不做**（只给 `jira lint` 的悬空引用检查 + 一份 key 集合对比清单）。
### 11.6 实现前的未决清单（穷尽清点）

> **起因**：我曾说"只差 §11.3 那批就能开写"——**用户当场否掉：" 你确定？应该还差一堆问题吧"。**他是对的，而且差得比我以为的多得多。** 本节是第一轮逐节重扫 + 一路**独立复核**（另一 agent 通读全文）合并后的完整清单。
>
> **这里的数字是数出来的，不是估出来的**：A 类 **42 条**（✅ **全部定案** → 0 条待定）／B 类 **30 条**（已定 10 → **20 条待定**）／ 已定 22 条，**待定 48 条**（A17 收窄后仍挂着参数与输出 schema）。
>
> **使用规则**：每定掉一条，写进 §8 决策表或对应章节，**同时删掉这里的那一行并挪进下面的"已定"表**， 于是"还剩多少没定"永远可以数出来。

#### 已定（从清单移出）

| 原编号 | 结论 | 落点 |
|---|---|---|
| A1 字段命名风格 | **落盘一律 `snake_case`**（代码内部 TS 可自由用驼峰，转换只发生在 `core` 的编解码层） | 决策 41、§4.1 |
| A2 `priority` 取值 | **`S1`–`S5`（S1 最高）**，写进数据仓 `config.md` 的 `priorities`，同样只增不删；新建未指定默认 `S3`（**已确认**） | 数据仓 `config.md`、§4.2 |
| A3 `comments[]` / `events[]` | Issue 上**没有**这两个字段；评论单独文件（§4.4），**事件一律写成评论**，评论数渲染时现算 | 决策 42、§4.1 |
| A37 `events.jsonl` | **MVP 不做**；将来若做必须每机一份 `events/<machine_id>.jsonl`，且只在写路径上 | 决策 42、§4.5 |
| A4 `description` / `summary` / `title` | frontmatter 只放 `summary`（一行、必填）；**正文即 `description`**；不另存 `title`，渲染时用 `summary` 当 title | 决策 43、§4.1 |
| A5 `revision` 语义 | **初值 1**；只有主体变更 +1；评论各自计数、不推进主体 | 决策 44、§4.7 |
| A12 `type` 与 `issue_type` | OKF 的 `type` = 文档种类（强制小写）；issue 类型改名 `issue_type`（`task`/`bug`，强制小写） | 决策 45、§4.1 |
| A13 版本字段 | 每个文件带 `schema: <kind>/v<N>`（含 config.md）；写入侧严格、读取侧宽容 | 决策 46、§4.1 |
| A14 时间戳格式 | **UTC + ISO-8601 到秒**（`...Z`，无毫秒），本地时间仅显示时转 | 决策 47、§4.1 |
| A40 身份串分隔符 | 身份串用 `\|` 作分隔符（表格里写作 `\|`），分量内禁止含分隔符，**无须转义**；`human:<name>` 不变 | 决策 48、§4.3 |
| A41 写入侧校验边界 | **未知键 = 写入拒绝**（列出未知键）；**读取侧宽容** | 决策 49、§4.13 |
| A42 `note` 字段 | Issue 上新增自由文本 `note?`，由 `update` 改写；与追加式 `comment` 分工不同 | 决策 51、§4.1 |
| A18 错误码闭集 | **12 个码**，统一形状，`core` 单一定义 + 测试守卫文档与代码一致 | 决策 52、§6.2 |
| A19 `jira_list` 排序分组 | project → status → priority 升序 → updated 倒序；被阻塞单独一组；limit 默认 20/上限 100 | 决策 53、§6.1 |
| A20 `jira_kb` 返回 | 片段 + `file:line`，片段封顶 200 字，top_k 默认 10/上限 50；不回整篇 | 决策 54、§6.1 |
| A21 输出语言 | 模型面英文（tool 描述/返回值/错误 message/注入行）；人面中文（看板/CLI/命令输出/文档） | 决策 55、§6.2 |
| A22 读结果外壳 | 统一带 `writable`（+`reason?`）与 `me`；不重复 store 摘要 | 决策 56、§6.2 |
| A23 插件 Config 字段 | 五组：`root` / `tool` / `push` / `lock` / `list`；**值未定的键不加** | 决策 57、§6.2 |
| B2 锁粒度 | **两级锁**：issue 级 + 极短的 store 级；取锁顺序固定，持 store 锁不长 IO | 决策 58、§5 |
| B1 锁原语与参数 | `mkdir` + owner 文件；stale 60 s、获取超时 10 s、退避 100 ms + 抖动 | 决策 59、§5 |
| B3/B4/B5 写路径常量 | 防抖 500 ms；原子写重试 3 次（50 ms 起指数退避）失败报 `WRITE_FAILED`；长路径预警 240 字符 | 决策 60、§5 |
| B6 租约时长 | 默认 2 h；写时续租、不另起心跳；过期只提示不阻塞 | 决策 61、§4.8 |
| A34/B7 归档 | **MVP 不做**（目录不建、N 不定）；将来只在写路径触发、读路径默认排除 | 决策 62、§4.9 |
| A24 Node/engines/peer | peer+dev 钉宿主实际版本（`0.2.0-rc.2`）；`engines` 跟 DSH（`^22.19.0 \|\| >=24.0.0`）；换机器重核 | 决策 63、§2.2 |
| A25 包结构 | **单包多入口**（`src/core` / `src/cli` / `src/plugin`），边界靠 AST 检查器 + CI | 决策 64、§3 |
| A26 构建与离线安装 | `tsc` → `dist/`（不打包）；拷贝包目录 + `dsh plugin add <路径>`；零 native 依赖 | 决策 65、§7.1 |
| A27 测试与 CI | `node:test` 零依赖；CI 两 job：双平台矩阵测试 + 产物/文档检查（含生成物新鲜度断言） | 决策 66、§5 |
| A28 提交绑定细则 | 正则 / 多 key 全校验 / merge·rebase·revert 豁免 / `[no-issue]` 首行 / Node 薄壳 / 链式调用 / root 不硬编码 | 决策 67、§6.7 |
| A6/A7 评论格式与 id | HTML 注释锚 + `c-<machine 短码>-<n>`；多机 union 零冲突；可编辑不可删 | 决策 68、§4.4 |
| A8 `Comment.author` | 与 `assignee` 共用值域（身份串或 `human:<name>`） | 决策 69、§4.3 |
| A9 `links` 形状 | 数组 `[{ type, target }]`；解除 = 删项；集合型冲突走并集 + `conflicted` | 决策 70、§4.15 |
| A10/A35 `conflicted` 生命周期 | 只在 pull/写事务内检测（读不写）；写需 `ack_conflict: true`，改完自动清 | 决策 71、§5 |
| A11 重开时的 resolution | 离开关闭集合即清空 `resolution` / `resolution_note`，并自动写一条评论留痕 | 决策 72、§4.16 |
| A15/A36 machine_id 与派生数据落点 | `normalized_sn` 规则 + `os` 用 platform；身份文件固定 `$DSH_HOME/dsh-jira/machine-id`（store 之外）；派生索引放 store 的 `var/` | 决策 73、§4.11 |
| A16 counters 形态 | `{ schema, machine_id, next, blocks }`，块大小 100，首机从 1 起 | 决策 74、§5 |
| A29 KB 实体契约 | 文件名=key；`type` 闭集四值（= OKF type）；来源四件套必填；双向引用 `issues[]` ↔ `kb_refs[]` | 决策 75、§4.13 |
| A30 knowledge 域名 | 小写 kebab（与 tag 同规则）；slug 规则已作废 | 决策 76、§4.13 |
| A31/B21 project.md 与 remotes | key 靠目录名；remotes 规范化规则 + 多留 + `upstream > origin > 其它` | 决策 77、§4.10 |
| A32 注入行 | 固定英文格式、空 store 不注、注册名 `jira:store`、5 s 复用 | 决策 78、§6.4 |
| A33 生成物头部与版式 | HTML 注释头部（`generated_at` + `source_tree` 确定性哈希）+ 四个文件的最小版式；两条新鲜度断言 | 决策 79、§4.4 |
| A38 坏数据标注 | `rejected: [{file, reason}]`（不回坏内容）+ `message` 说明；写侧直接拒绝 | 决策 80、§5 |
| A39 git config 谁写 | 插件幂等补写 `core.fileMode=false` / `i18n.commitEncoding=utf-8`（不覆盖已设值）+ 体检报告 | 决策 81、§5 |
| B22 `os` 只用平台 / SN 回退随机 id | **已随决策 73 定案**（`os` 用 `process.platform`；SN 取不到回退随机 id，文件固定 `$DSH_HOME/dsh-jira/machine-id`） | 决策 73、§4.11 |
| A17 三个 tool 的 schema | 7 个动词 + 参数全 snake_case + 输出统一外壳；三张表见 §6.1 | 决策 50、决策 82 |
| B30 CLI / `/jira` 命令集合 | CLI = tool 超集 + 运维类；`/jira` 只读五命令；逻辑只在 `core` 写一次 | 决策 83、§6.1 |
| B13/B14/B29 工程常量 | summary ≤120 字符（超长拒绝）；tool 超时读 5 s / 写 30 s；pull 15 s 超时；`presentationMeta` 不做 | 决策 84、§6.2 |
| B24 索引触发条件 | p95 > 200 ms 或文件数 > 5000 时评估 FTS5；两个量由 `doctor` 报出 | 决策 85、§11.1 |
| B8/B9 tag 治理 | 纯函数 Dice（alias→前缀→Dice≥0.5 取 3）；lint 三段报告，阈值 1 / 0.7；不自动改 | 决策 86、§4.14 |
| B10/B11/B12 生成物版式 | BOARD 每状态一节 + 表列五栏 + 被阻塞/已下线单独节 + 计数行；index 不列单条；log 100 条；tags 字母序；`board --html` = P1 | 决策 87、§4.4 |
| B15 skill 拆分 | **三个**，正文英文、示例真实；落点插件内 `skills/`。**实际名称**：`jira-work` / `jira-board` / `jira-triage`（见决策 88 的修正记录） | 决策 88、§6.3 |
| B16 subagent 写权限 | **主 agent 统一写、subagent 只读**；写拒绝复用 `READ_ONLY_SESSION`（`reason: subagent`）；判据事实存在、插件侧 seam 待 spike | 决策 89 |
| B25 KB 排序与 top_k | **已被决策 54 覆盖**（标题命中 → 命中次数 → `updated` 倒序；top_k 10/50；bm25 只在 FTS5 下存在，而决策 37 已否 FTS5） | 决策 54 |
| B17 goal/todo 与 issue | **明确不打通**（两套东西）；不自动建 / 关 / 注入 / 引用 | 决策 90、§6.5 |
| B23 label 缺失显示 | 显示 `machine_id` 前 6 位 + 一次性提示 `jira machines label` | 决策 91、§4.11 |
| B28 hook 链式安装 | 已被决策 67 覆盖（改名 `*.jira-backup` 后链式调用，卸载还原） | 决策 67 |
| B26 `paths[]` 与 rebind | 规范化（绝对/小写/`\`）+ 只作缓存；`project rebind` = 手动重绑 | 决策 92、§4.10 |

| B27 只读会话 | 拒绝写（`READ_ONLY_SESSION`，reason `dsh-read-only`），读照常，**无降级写** | 决策 93、§9 | | B19 归并/复写工具 | **MVP 不做工具**；5 点定清（按 project 搬、映射表进 `_merge/`、不造归并事件、四类差异报告、只做一次性） | 决策 94、§11.5 | | B20 spike 三项 | ① **可见**（宿主平面 insert + bundle 包；"gate"其实是仓库 CI 不变量）② **有**会话级 seam（`agent/created` + `agent.ctx.effect`）③ **能**读 `SessionHeader`（`exec.agent.session.header`） | 决策 101 / 100 / 96（+98 引用标版本） |
#### D 类：文档自相矛盾 / 过期（**不修就会各按一半实现**）

| # | 位置 | 问题 | 状态 |
|---|---|---|---|
| D1 | §8「仍需你确认」#5 | 仍写"KB 检索方案**已暂停**，等你拿实现回来"，而 §11.1 已定案（决策 37） | 本轮已修 |
| D2 | §4.16 取值表 | 表里仍只有 `fixed/invalid/limitation`，**缺 `abandoned`**；且"invalid"的说明与数据仓 `config.md` 的语义分工不一致 | 本轮已修 |
| D3 | §4.1 vs §4.4 | §4.1 把 `comments[]` / `events[]` 列为 Issue 字段，§4.4 又说"评论是单独文件" | 本轮已修（决策 42） |
| D4 | §4.9 vs §4.4 | §4.9 说归档到 `archive/`，但权威目录树与数据仓 README **都没有这个目录** | 本轮已修（决策 62：MVP 不做归档、目录也不建） |
| D5 | §7.3 正文 vs 其修正记录 | 正文仍写"**已确认**：`BOARD.md` 由 Action 生成（**不是**插件本地生成）"，与修正记录并存 | **本轮已彻底定案**：决策 15 已改写为"Action 与插件都能生成"（决策 34 的推论） |
| D6 | 文首抬头 | 仍写"唯一暂停的话题：KB 检索方案" | 本轮已修 |
| D7 | §11.3 | "skill 拆分……部分依赖 §11.1 的结论"——11.1 已定案，**依赖已解除** | 本轮已修 |
| D8 | §9 风险 1 vs §11.2 | §9 说"**必须先做 spike**"，§11.2 说"**非阻塞**、可以等" | 本轮已修（统一为"影响分发方式，非阻塞"） |
| D9 | §4.11 vs §8 决策 5/9 | `FOREIGN_MACHINE_READ_ONLY` 在独立实例上不生效（§4.11 已补），但决策 5/9 没跟着限定作用域 | 本轮已修（补作用域限定） |

#### A 类：不定就没法动手（**A1–A42 全部定案**）

> 42 条已全部结清——逐条见上面的「已定」表与 §8 决策 **41–82**。原先按五个子组列出的空表已删除： 自检发现"表头计数（16/7/5/6/5=39）与实际编号（A1–A42）对不上"，索性不留会再次失准的空壳。

#### B 类：可以先写、迟早要定（30 条，**已全部结清**）

#### C 类：实现期的新取舍（本轮新增）

| # | 待定 | 背景 |
|---|---|---|
| C1 | ~~frontmatter / YAML 解析：自写受限解析器 vs 引第三方纯 JS 库~~ | ✅ **已定案（决策 105）**：**自写受限解析器 + 超集即报错**；零第三方依赖、离线安装不受影响；将来换成熟解析器的成本 = 换掉 `parseFrontmatter` / `renderFrontmatter` 两个函数 |
| C2 | ~~决策 70 的 links 形状与受限子集冲突~~ | ✅ **已定案（决策 106）**：给子集**加一层 flow map**（`links: [{ type: is_blocked_by, target: DH-5 }]`），忠实于决策 70；嵌套仍然报错 |
| C3 | ~~`key` 要不要写进 frontmatter~~ | ✅ **已定案（决策 107）**：issue / KB **一律不存 `key`**（文件名即身份），**读到 `key` 直接报错**；与决策 77 对 `project.md` 的理由同源 |
| C4 | ~~"读文件失败"在 12 个错误码里没有对应项~~ | ✅ **已定案（决策 111）**：把 `WRITE_FAILED` 的语义正式定义为"**IO 失败**"（读写都算），码集不动；代码 helper 改名 `ioFailed` |

| # | 待定 | 出处 |
|---|---|---|
| C5 | ~~CLI 的命令形状（扁平分命令 vs 决策 83 的 `jira issue <verb>`）~~ | ✅ **已定案（决策 128）**：混合式（issue 动词平铺 + 多动作名词分组 + 运维平铺），命名差异刻意保留并被测试钉住；**顺带补上一直缺失的 `link` / `assignee`** | 决策 50/55/83/125/128 |
| C7 | ~~运维命令未实现~~ | ✅ **已全部实现（决策 126/127）**：`machines [list\|label]`、`lint`、`tags lint`、`project [list\|bind\|rebind]`、`hooks [status\|install\|uninstall]`、`verify-commit-msg` | 决策 83/86/91/92/94、126、127 |
| C8 | ~~悬空引用检查~~ | ✅ **已消解（决策 126 ①）**：`jira lint` 检查三类悬空引用（issue→link、issue→`kb_refs`、KB→`issues[]`），写路径仍只校验形状 | 决策 75/94/125/126 |
| C9 | ~~`doctor` 未查的几项~~ | ✅ **已实现（决策 126/127）**：决策 85 的 p95 与文件数、`kb_refs`↔`issues` 单边引用、被引用却未登记的机器；**仍不查**（按设计）：策略状态、悬空引用（归 `lint`） | 决策 39/85/91/94、126、127 |
| C10 | ~~§4.11 的"无 remote ⇒ 只读"只有错误码与提示，写路径不拦~~ | ✅ **已实现（决策 133）**：`assertProjectWritable` 接进工具的写路径与 CLI 的五个写命令；人类不受影响，本机自己的 agent 不受影响 | 决策 4/9/78/130/133 |
| C11 | ~~§4.10 后半段：解析出"未命中"后只在提示里说，首次写入并不登记~~ | ✅ **已实现（决策 133）**：首次写入即登记（派生 key、remote、`paths[]`、policy/owner），注入行那句 "on first write" 现在**是事实** | 决策 77/92/131/133 |
| C12 | ~~**store 仓库没有 CI**~~ ✅ **已结（2026-10-16）**：`.github/workflows/ledger.yml` 现在跑 `lint`（**含 frontmatter 校验**——解码失败即 `file-unreadable` 报错，已实测：删掉必填 `priority` → exit 1）、`generate --check`（**新鲜度断言**）与提交信息绑定（决策 67）。**踩过的三个坑都记在 workflow 注释里**：① `github:` 依赖走 ssh 且插件无 `prepare`，git 安装拿不到 `dist/`→ 改为检出插件后构建；② 默认 `GITHUB_TOKEN` 读不了另一个私仓 → 需要 secret `PLUGIN_TOKEN`（fine-grained PAT **必须手动加 Contents: Read-only**，新建时是零权限；`GET /repos` 返回 200 只证明 Metadata，不证明能 clone）；③ `verify-commit-msg` 必须带 `--root`，否则 CLI 报"无法确定账本根目录"而把每条合规消息判成不合规。**首个全绿 run：38925421455** | 决策 39/66/120 |

> **C 类已结案的四条**（C1–C4）见上表历史；**C6 已并入决策 125 ⑤**（`/jira` 保留写命令）。 **C9 里的两个量**（p95 与文件数）是决策 85 明确要求 `doctor` 报出的，属于"该不该上索引"的唯一依据， 实现 `doctor` 时不要漏。

#### 过题顺序（**已执行完毕**）

| 轮次 | 内容 | 状态 |
|---|---|---|
| 第 0 步 | 先修 D1–D9 那 9 处矛盾 | ✅ 7 处已修、2 处随决策定案 |
| 第 1 轮 | 落盘地基：命名 / 词表 / 实体字段 / `revision` / 版本字段 / 时间戳 / 转义 / 校验边界 | ✅ 决策 41–49 |
| 第 2 轮 | 工具契约：动词集合 / 错误码 / 列表排序 / KB 返回 / 语言 / 结果外壳 / Config | ✅ 决策 50–57 |
| 第 3 轮 | 工程骨架：peer / 包结构 / 构建与离线装 / 测试与 CI / 提交绑定 | ✅ 决策 63–67 |
| 第 4 轮 | 写入核心之前：评论 / 作者 / links / `conflicted` / 重开 / 身份与 counters | ✅ 决策 68–74 |
| 第 5 轮 | 收尾与边界：KB 契约 / 域名 / project.md / 注入行 / 生成物 / 坏数据 / git config | ✅ 决策 75–81 |
| 尾轮 | 三个 tool 的完整 schema（原 A17） | ✅ 决策 82 |
| **剩余** | ~~B 类 20 条~~ → **B 类 30 条已全部结清**（见上表；该计数是早期快照，已过期） | ✅ 本条于 2026-10-16 修正 |

**诚实结论（已更新）**：A 类已清零，B 类 20 条都是"可以先写、迟早要定"的性质。 当初"只剩 §11.3"的判断**漏了 55+ 条**——这条记录保留在此，提醒下次不要把"我扫到的"当成"全部"。

> **改动前先查影响面**：高扇出的决策（命名 / schema / 读不写 / 身份 / 锁 / 评论 / tool schema …） 在 **§11.7** 有一张"改了会牵动谁"的索引——**常例：以后每条新决策都要在那里留一行**。


### 11.7 改动影响面索引（高扇出的决策）

> **为什么有这一节**（用户原话，本轮）：「多问是好事，能尽量想清楚设计目标是好的，**即使后面改变了 也知道谁会被影响到**，而不是现在这种拍脑袋处理。」
>
> **用法**：改下面任何一条之前，先看它的"会牵动谁"，**别只看它自己那一节**。
>
> **常例（已定）**：**以后每新增一条决策，都要在这里留一行**——哪怕只写"仅本节"。

| 决策 | 一句话 | **改了会牵动谁** |
|---|---|---|
| **38** | 读操作不得写 | **所有读路径**（`jira_list` / `jira_issue get` / `jira_kb search` / 看板 / 注入行 / `/jira`）；决策 71（conflicted 何时检测）、决策 73（sessions 何时落盘）、§4.8 租约过期、§4.10 新 project 登记、§4.12 探测持久化、决策 74（counters 只能在写事务里分配） |
| **41** | 落盘一律 snake_case | **所有文件的键**、所有 tool 参数（决策 82）、`core` 编解码层、校验器、生成物模板、**数据仓已落盘的数据（= 全库迁移）**、本文档全部示例、HANDOVER 速查 |
| **46** | `schema: <kind>/vN` | 八种文件的版本声明（issue/project/comment/tag/machine/session/config/kb + counters）、写入侧严格 / 读取侧宽容、**以后所有格式演进都要走它**、CI 校验 |
| **42** | 事件 = 评论；不做 `events.jsonl` | §4.1 实体、§4.8 租约过期留痕、§4.15 override 留痕、§5 追加型冲突规则、§4.5/§4.9 历史回读、§11.5 **归并时事件怎么搬** |
| **43** | `summary` 在头、正文即 `description`、不另存 `title` | §4.1 实体、§6.2 结果体积、§4.13 KB（**刻意的 `title` 不对称**）、决策 82 输出渲染、决策 79 看板列 |
| **44** | `revision` 初值 1、仅主体变更 +1、评论各自计数 | §4.7 CAS、决策 71（`ack_conflict` 与 revision 的关系）、决策 68（评论自己的 revision）、§5 冲突裁决、决策 82 的 `expected_revision`、决策 52 的 `STALE_REVISION` |
| **45** | OKF `type`（文档种类）vs `issue_type`（是什么活） | §4.1 实体、§4.2 `config.md` 的 `issue_types`、§4.13 KB 的 `type`、数据仓 `config.md`、**校验器的大小写规则**、schema 文件名、上游"大写导致校验静默跳过"的教训 |
| **48** | 身份串用 `\|` 分隔 | §4.1 / §4.3 值域、评论 `author`（决策 69）、§4.12 探测、决策 50 的 `assignee` 动作、决策 82 参数、**所有文档示例**、**Markdown 表格里必须写 `\|`** |
| **58 / 59** | 两级锁（issue + 极短 store）、`mkdir` 唯一原语 | §5 并发、决策 74 counters 分配、§5 两条禁令（写事务里不 push）、多机协作（**跨机靠 CAS 不靠锁**）、决策 57 的 `lock.*` Config、数据仓 `.gitignore`、并发测试 |
| **50** | `jira_issue` 七个动词 | 决策 82 参数表、决策 52 错误码、§4.15 阻塞拦认领（落在 `assignee`）、§4.8 租约（`assignee=self`）、§4.16 关闭（`switch_state`）、**CLI / `/jira` 子命令（B30）必须与动词对齐**、skill 正文（B15） |
| **68** | 评论 = HTML 注释锚 + 机器短码 id | §4.4 评论文件、`.gitattributes` 的 `merge=union`、决策 69（author 值域）、决策 44（评论 revision）、§5 冲突裁决、**决策 36 归并时评论怎么搬**、决策 50/82 的 `comment` 动作 |
| **71** | `conflicted` 只在 pull/写事务检测；写需 `ack_conflict` | §5 裁决规则、决策 38（读不写）、决策 82 的顶层 `ack_conflict`、决策 79（看板高亮）、决策 52 错误码 |
| **73** | 身份文件在 store 之外；派生数据两类落点 | §4.11、`$DSH_HOME/dsh-jira/machine-id`、决策 74 counters、`var/`、数据仓 `.gitignore`、**决策 35/36（独立实例的身份）**、决策 5/9（跨机只读作用域） |
| **75** | KB 实体契约（文件名 = key、`type` 闭集、来源四件套必填、双向引用） | §4.13、`knowledge/` 结构、`kb_types`（数据仓 config.md）、决策 76（域名）、决策 54（search 返回 `file:line`）、决策 82（`jira_kb` schema）、§11.1（扫文本的实现） |
| **79** | 生成物统一头部（`generated_at` + `source_tree`）+ 四种版式 | §4.4 生成物、§7.3（谁生成）、**决策 15 / 34 / 40（Action 还是插件）**、决策 66（CI 的新鲜度断言）、决策 39（要求来源） |
| **82** | 三个 tool 的参数与输出 schema | §6.1、决策 50/53/54/56（动词 / 排序 / 返回 / 外壳）、决策 52 错误码、决策 55 输出语言、决策 57 Config、skill 正文（B15）、契约测试、**§11.1 要抄的"参数单点 + 测试守卫"** |
| **83** | CLI = tool 超集 + 运维类；`/jira` 只读 | skill 正文与触发方式（B15）、决策 82 的 tool schema（两处要一致）、决策 67 的 hook 安装命令、决策 79/81 的体检项（`doctor` 要报告它们）、`/jira` 的命令注册与零 token 约束（§6.1）、CLI 的退出码与错误码（决策 52） |
| **84** | summary ≤120 字符、tool 超时、pull 超时 | 决策 82 的输出渲染（列表只回 summary、`get` 的截断标记）、决策 79 的看板列宽、决策 52 的 `INVALID_INPUT`、测试（超长输入要用例） |
| **85** | 引入索引的触发条件 | §11.1 的实现选择、`jira doctor` 的报告项（决策 83）、决策 37 的前置条件（真引入时必须"派生 + 可重建 + 进 `.gitignore`"） |
| **86** | tag 相似度与 tags lint | §4.14 的"未知 tag 报错并给 3 个候选"与"体检报告"、`/jira tags lint` 的输出（决策 83）、`doctor` 是否汇总它、测试（Dice 的边界用例） |
| **87** | 四个生成物的版式 | §4.4/§7.3 的生成物、决策 79 的头部与新鲜度断言、决策 53 的列表分组（**两处口径要一致**）、决策 84 的截断（summary 120 字符影响列宽）、`board --html`（P1） |
| **88** | skill = 三个（jira / jira-kb / jira-hooks） | 决策 83 的 CLI 命令集合（skill 要教它）、决策 82 的 tool schema、决策 86 的 tag 治理、决策 67 的 hook 细则、**三个描述常驻 prompt 的 token 成本**、§6.3 的采纳率目标 |
| **89** | 主 agent 写、subagent 只读 | **写权限判据**（怎么识别子代理会话——spike 项）、决策 52 的 `READ_ONLY_SESSION`、决策 56 的 `writable/reason` 外壳、§6.5 的 P1 行、§4.11 的只读策略作用域、决策 83 的 CLI（CLI 由人/主 agent 跑，子代理同样只读） |
| **35 / 36** | 离线机 = 独立实例；跨实例默认不合并 | §4.10（身份锚定的作用域）、§4.11（只读拦截的作用域）、§5（裁决规则的作用域）、§11.5（归并 5 个未决点）、**决策 8 / 11（store 数量）** |
| **90** | goal / todo 与 issue 不打通 | §6.5 的 P1/P3 行、§11.3 的遗留项、§1 的动机表述（"已有能力为什么不够"要与之相容）、skill 正文（**不要教 agent 去做桥**） |
| **91** | label 缺失时显示短 id | §4.11 的 machines 文件、决策 79 的看板列宽、决策 83 的 CLI（新增 `machines label`）、工具输出（决策 82） |

| **92** | `paths[]` 规范化 + 手动 rebind | §4.1/§4.10 的 paths、决策 77（**身份只看 remotes**）、决策 83 的 CLI（新增 `project rebind`）、决策 8/9（只读策略与该缓存的关系） |
> **不在索引里的决策**：影响面就是它自己那一节（例如 §4.9 归档推迟、§4.14 tag 相似度算法、 | **93** | 只读会话拒绝写（无降级路径） | 决策 52 的 `READ_ONLY_SESSION`、决策 56 的 `writable/reason`、决策 89（子代理只读——**同一错误码、不同 reason**）、§9 风险 5、skill 正文（要告诉 agent"读到只读就别试写"） | | **94** | 归并：不做工具 + 5 点定清 | §11.5 的 5 个未决点、§4.4 目录树（新增 `_merge/`）、决策 83 的 CLI（`lint` 要含悬空引用检查）、决策 36（复写 vs 归并）、决策 39（`_merge/` 里的映射表是**人写**的，不是生成物，不受新鲜度断言约束） | | **95** | peer 版本 range（两个宿主） | 决策 63（原"钉精确版本"）、§2.2 的 peer 说明、CI 矩阵（两个宿主版本都要跑）、`dsh plugin allow-version` 豁免机制、HANDOVER §5 的环境事实 | | **96** | subagent 只读的判据（`exec.agent.session.header`） | 决策 89（它才让这条落地）、决策 5/9 的作用域限定、决策 52 的 `READ_ONLY_SESSION`、决策 56 的 `writable/reason`、§2.2 的 peer/dev 依赖清单（新增两个宿主包）、tool 层 guard 与 `restrict` 的相互作用 | | **97** | 转内置插件的回退 | §2.7（① 的结论）、**决策 18/63/64/65/95**（peer 与分发在内置路径下消失或变形）、§7.1/§7.2（安装方式）、§3（分层：`core` 必须保持零 DSH 依赖，否则回退就要重写）、HANDOVER §5（多一个代码落点：fork 仓）、CI（内置则跟 fork 的 CI 一起跑） | | **98** | 引用 DSH 源码必须标版本 | 全文所有 DSH `file:line` 引用、§11.2 的差异表、§2.7 的 patch 引述、未来的所有证据链（**不标版本 = 宿主一同步就可能变成假证据**） | | **99** | 安装单元 = bundle 包 | §7.1/§7.2（安装方式）、决策 65（离线安装）、决策 97（内置回退时这条作废）、§2.7（patch 可见性）、包的 `exports`/`files` 字段（要带 `cordis.patch.yml`）、CI（bundle 结构校验） | | **100** | 会话收尾 seam（`agent.ctx.effect`） | 决策 31（会话结束扫 `git log`）、§6.5 的 P1 行、决策 73（水位线放 `$DSH_HOME/dsh-jira/`）、决策 38（读不写——收尾是写事务，不冲突）、决策 52 的错误码（收尾失败要有码）、幂等设计（重复评论的判据） | | **101** | spike ① 结论：宿主平面 insert / bundle 包 / 不走 preset | **§2.7（风险已消）**、决策 99（bundle 形态与安装器）、决策 97（内置回退的触发条件不再成立，但保留）、决策 95（两个 checkout 与 peer range）、§7.1/§7.2（安装与离线）、**仓库 CI 的"一个 row 只属于一个平面"不变量**（走内置路径时才受约束） | | **102** | 编码原则（原子化 / 组合 / data class） | **§3 的全部实现**、决策 64（分层 + AST 边界检查）、决策 65（零运行时依赖）、决策 66（`node:test` 只测纯函数）、**决策 97（转内置之所以便宜，正因为 `core` 是原子化纯逻辑）**、以及以后每一次 code review 的口径 | | **103/104** | 第一刀竖切 + 自写最小 Result | §3.1 的实现顺序、§7.1/§7.2（bundle 包与安装）、决策 101（可见性实测）、决策 52（错误码形状）、决策 65（离线安装与依赖取舍 → C1） | | **105** | frontmatter 自写受限解析器 | §4.1 的 frontmatter 形态、`config.md` 的读取、决策 65（离线安装不受影响）、决策 49/80（写入严格 / 读取宽容）、CI 的"全库在子集内"断言、以及**将来换成成熟解析器的成本 = 一个函数** | | **106/107** | 子集加一层 flow map；`key` 不落盘 | §4.1 与 §4.13 的实体写法、决策 70（links 形状）、决策 75（KB 示例）、决策 77（同一套"不存重复身份"的理由）、决策 105（子集边界）、`codec.ts`/`frontmatter.ts` 的实现与测试 | | **108** | 适配层零 host 依赖 | §3 的分层、决策 64（AST 边界检查要放行 plugin 的"零宿主 import"）、决策 65（离线安装与 devDeps）、决策 96（谱系 seam 用 duck-typing）、决策 97（内置路径下本条作废）、**集成测试是唯一守卫** | | **109/110** | 不声明 peer；工具 schema 用标准方言 | 决策 95（peer 写法收窄）、决策 99（bundle 安装）、决策 108（自建 schema 的代价）、§2.7 的实测记录、`core/schema.ts` 与 `plugin/index.ts` 的输出形态、打包测试（不得出现 peerDependencies） | | **111** | `WRITE_FAILED` = IO 失败 | 决策 52 的码清单与"文档==代码"测试（不变）、§6.2 的码清单说明、`core/errors.ts` 的 `ioFailed`、`core/io.ts` 的两处调用、新加的 C4 断言 | | **112** | 子集加一层嵌套（因为 config.md 读不出来） | 决策 105/106 的子集边界、`fixtures/config.md`（真实词表的夹具，store 仍是真相源）、`core/frontmatter.ts` 的 parse/render 对称性、未来任何手写文件的形状 | | **113** | 评论锚 author 含 `|` 要加引号 | 决策 48（身份串分隔符）与 68（锚字段分隔符）的交叉、`core/comments.ts` 的渲染与解析、以及所有"两个冻结格式互相嵌套"的地方（以后遇到先想分隔符） | | **114/115** | counters 按 project 分桶；git 层（自动 init + 提交在 store 锁里 + 失败要响 + 防抖推送队列） | 决策 74/58/60/81 的落地、`core/counters.ts`/`core/git.ts`/`core/push.ts`、`core/store.ts` 的事务尾部、§5 的常量说明、以及"以后要碰"git" 或"计号"时先看这两条" | | **116** | 首次领号的种子取自磁盘；提交按 git 的清单；store 级数据进版本；提交失败要响 | `core/store.ts`（`highestExistingKey`/`commitWrite`）、`core/git.ts`（`stageAndCommit`）、`core/counters.ts`（`seed`）、插件把 `commitError` 映射成 `rejected`；以后任何"我们要提交什么"的改动都先看这条 | | **117/118** | 锁按 mtime 判废；/jira 命令 + 三技能 + CLI 十命令 + 会话结束有界冲刷 + ack 顺序 + doctor 评论 id 作用域 | `core/lock.ts`（`staleSince`）、`src/cli/*`、`src/plugin/command.ts`/`skills.ts`、`skills/*.md`、`core/doctor.ts`、`core/store.ts` 的提交清单；以后改"人看到的界面"或"锁的判定"都先看这两条 | | **119** | store 是云端仓的克隆；机器身份在 store 之外；插件只指远端 | `core/machine.ts`、`core/provision.ts`、`cli/main.ts` 的 `init --remote`、插件 `config.remote`、profile 的 `cordis.patch.yml`；以后任何"新机器怎么加入"、"身份放哪"、"要不要联网"的问题都先看这条 | | **120** | 第 11 个 CLI 子命令 `generate`（幂等 + `--check` + doctor 新鲜度）；生成物必须被两处排除；**知识域计数必须从 `listKnowledge` 的同一份 listing 派生**（第三处排除，2026-10-16） | `core/generateStore.ts`、`cli/main.ts`、`core/doctor.ts`/`inspect.ts`、`core/store.ts` 的 `loadTags`、`core/io.ts` 的 `isGeneratedInput`、`core/kbstore.ts` 的 `KnowledgeListing.domains`；以后**任何枚举 store 文件的代码**（读注册表、算哈希、做统计）都要先问一句「生成物排除干净了吗」——**这条预测在 2026-10-16 兑现了**：`domainRows` 自己扫 `knowledge/<域>/` 递归数 `.md`，把生成的 `index.md`/`log.md` 数成知识条目 → 根索引对只有 1 条条目的域报 **3 条**，且那个数字只在第一次生成**之后**才出现，于是**单次 `generate` 不是不动点**（CI 的"重跑后 diff 为空"会挂）。教训：坑不在排除本身，而在**同一件事的第二份实现**——让计数跟着已经排除干净的那份数据走 | | **121** | `jira_list` 的实现契约（排序全序 / 阻塞复用 / counts 描述全集 / tags 收窄 / 只读） | `core/list.ts`、`plugin/index.ts` 的第二个注册、`cli/main.ts` 的 `list`、`core/inspect.ts` 的 `IssueQuery` 扩展；以后加过滤条件时先想"它属于收窄还是放宽" | | **124** | `jira_kb` 落地（key/域独立、来源由 store 记录、读宽容写严格、counts 对齐、生成物不当条目） | `core/kb.ts`/`kbsearch.ts`/`kbstore.ts`、`plugin/index.ts` 的第三个注册、`core/errors.ts` 的 `notFound`、`core/store.ts` 泛化出的 `commitStoreWrite`；以后加实体时先想"key 与目录是否一一对应"、"哪些字段该由 store 记录而不是让模型填" | | **123** | 宿主不导出 DSH_HOME；link 进来的包缓存在进程里（配置热、代码要换进程） | 决策 57 的 `root` 解析、决策 119 的 `init --remote`、决策 101/110 的"静默不激活"排查、HANDOVER §5/§6、以及以后所有"为什么 GUI 里没生效"的问题 | | **125** | CLI 的 `update`/`kb`；知识 key 按号段判；`/jira` 保留写命令 | 决策 83 的命令集合与"只读"表述、决策 82 的 tool 参数（两处要一致）、决策 75 的双向引用、决策 94 的悬空引用检查（C8）、决策 124 的 `asKnowledgeKey` 语义 | | **126** | lint 只管结构 / machines 注册表与显示规则 / doctor 报出索引触发条件 | 决策 94 的"CI 只管结构"、决策 86 的 `tags lint`（未做）、决策 85 的两个阈值、决策 91 的 label 与短 id 显示、决策 73 的 `machines/` 落点、以及所有"人看到的机器名"与"CI 该不该红"的地方 | | **127** | 提交绑定（hook 薄壳 + shebang/嵌入 shell）、tags lint、project、doctor 的一致性检查 | 决策 67 的 §6.7、决策 86 的 tag 治理、决策 77/92 的 `project.md`、决策 75 的双向引用、决策 91 的机器登记；**以后任何"改提交消息格式"或"加 hook"的改动**都要同时看 `core/commitmsg.ts`、`core/hooks.ts` 与 store 仓库里已装的那份 shim（重装一次即更新） | | **128** | CLI 的混合式命令形状、tool↔CLI 的命名映射、缺的两个动词已补 | 决策 83 的"超集"表述、§6.1 的命令清单、决策 50/82 的 tool schema（两边要能一一对上）、`src/surfaces.test.ts` 的漂移防护；**以后加/改命令**先跑一次那个测试 | | **129** | `lint --keys` 的 key 清单与冲突分类、`board --html` 的自包含与转义、`pnpm smoke` 这条可重复的端到端检查 | 决策 94 的归并支撑、决策 87 的生成物版式（HTML 刻意不在"四份生成物"里）、决策 38 的"读不写"（烟测第一段只读 ✓）、决策 67 的提交绑定（第三段 ✓）；**以后任何改动**都可以先跑 `pnpm smoke` 再谈别的 | | **130** | 注入行的实现与计数口径修正；`jira:store` 的注册与 5 s 缓存 | §6.4 的原文（口径已按本条修正）、决策 78、决策 55（英文固定格式）、决策 38（注入只读）、以及**任何改计数口径或改注册名**的改动 | | **131** | 注入行含"账本名 + 工作区→项目"；§4.10 的只读解析与 key 派生 | `core/workspace.ts`、`core/injection.ts` 的格式与按 cwd 缓存、`plugin/caller.ts` 的 `callerCwd`、`scripts/smoke.mjs` 的工作区步骤；**以后任何改注入行格式、改 key 派生、或让工作区自动登记项目**的改动都要同时看这三处（以及 C11） | | **148** | 重生成的时机 = **每次推送之前**（pull → 重生成+提交 → push） | `core/push.ts` 的推送队列（`settle` 钩子与它前面的 `pull`）、插件 `index.ts` 的队列接线与会话结束 flush、CLI 的 `sync`、`core/generateStore.ts` 的 `regenerateAndCommit`、决策 15/34/39/60/66/79/119/134/147，以及**以后任何"什么时候生成"的问题**；**它同时是一条红线**：门禁必红的提交宁可**不推**（settle 失败即拦）。**又因为它把 pull 变成每次写入的必经之路**，决策 146 的身份回退也必须覆盖 `git pull --rebase`（`core/rebase.ts`）——否则身份缺失的机器上整条链静默停住 | | **199** | 不变量要进守卫：`core/` 的 fs/子进程只有 io/git/lock/hooks 的 IO 白名单，`check-boundaries` 每次 check 都查 | `scripts/check-boundaries.mjs` 的 `IO_ALLOWED` 与 20 条自检、`core/project.ts` 的 `io.exists`；**以后定任何"只写在文档里"的边界**：当天就把它写进守卫脚本，否则它只是愿望 | | **198** | 引用必须成对：知识条目引用 issue → 自动回填该 issue 的 `kb_refs`（幂等，部分失败显式上报） | `core/kbstore.ts` 的 `mirrorKnowledgeRefs` 与 create/update 的接线、`plugin/toolKb.ts` 的 `mirror` 字段、`cli/commands/kb.ts` 的回填提示；**以后任何"双向引用"的字段**：写入侧自动补另一面，补不了就说出来（doctor 的 one-sided 检查是兜底，不是设计） | | **197** | doctor 只说事实：关闭态的历史租约不算"可认领"，summary 的计数来自磁盘而不是常量 | `core/doctor.ts` 的租约过滤与 `summary.tags`、`core/inspect.ts` 的 tags 计数、人面摘要行模板；**以后往 doctor 里加检查**：先问"这条对什么状态才成立"，并按快照里真实有的数据计数（不许写死） | | **196** | `batch_close`：多键关闭，全成或全不成；预验复用写入规则；部分结果显式上报 | `core/batch.ts` 的 `closeMany`/`refusalFor`、`plugin/toolIssue.ts` 的 `batch_close` 与 `keys` 参数、`cli/commands/batch.ts` 与命令表/USAGE、`surfaces.test.ts`/`index.test.ts` 的清单、`core/batch.test.ts`；**以后做"批量"**：预验先行、规则不复述、部分结果必须显式上报 | | **195** | 体验批：本地时间、`project_created`、短身份、空结果计数、kb 回执路径、何时 sync | `core/render.ts` 的 `withLocalTime`/空列表、`core/list.ts` 的 `shortIdentity`/空结果、`plugin/toolIssue.ts` 的 `project_created`、`plugin/toolKb.ts` 的 `file`、`skills/jira-work.md`；**以后人面输出与机器面输出的分界**：人面可以本地化/缩短，机器面（JSON、`get`）保持全量与 UTC | | **194** | 知识键空间 `KB-` 与项目键空间不许撞车；悬空引用提前到写入时 | `core/project.ts` 的 `RESERVED_PROJECT_KEYS`/`assertProjectNameFree`、`core/store.ts` 的 `createInStore` 前置校验、`core/kbstore.ts` 的 `assertIssueReferences`（只拒"引用知识条目"）、`project.test.ts`/`kbstore.test.ts`；**以后新增一套 key 空间先问"会不会和项目键同形"** | | **193** | 复合动作 `close`：迁移 + 评论一次事务，状态机与 resolution 规则照跑 | `core/mutate.ts` 的 `applyClose`、`plugin/toolIssue.ts` 的 `close` 动词、`cli/commands/close.ts` 与 `cli/main.ts` 的命令表/USAGE、`core/messages.ts` 的 `CLOSE_NEEDS_RESOLUTION`、`surfaces.test.ts` 的两张清单；**以后做复合动作**：组合已有原子操作、不绕过它们，且测试要断言"只多一个提交" | | **192** | 工具面必须能创建标签；`UNKNOWN_TAG` 要带全量注册表与创建途径 | `plugin/toolIssue.ts` 的 `tag_create`/`TAG_CREATE_FIELDS`/描述、`core/errors.ts` 的 `unknownTag`（`registered`+`hint`）、`core/validate.ts` 的传参、`surfaces.test.ts` 的映射表、`skills/jira-{work,triage}.md`；**以后工具面新增动词：先问"CLI 有没有对应命令"（surfaces 会替你问），并检查错误消息是否给出了下一步** | | **191** | 失败的 flush 必须重试（有上限）且必须留痕 | `core/push.ts` 的 `scheduleRetry`/`MAX_PUSH_RETRIES`/`retryDelayMs`、`plugin/sessionRecord.ts` 的 `recordPushOutcome`/`readPushFailure`/`pushFailurePath`、`plugin/index.ts` 的 `onOutcome`/`pushStatus`、`plugin/command.ts` 的 status 输出；**以后凡是"发出去之后没人看返回值"的异步步骤，要么重试到成功，要么把结果写到人能看到的地方** | | **190** | 先校验、后分配：被拒的 create 不烧号，回执带 `keyAllocated: false` | `core/mutate.ts` 的 `validateNewIssue`、`core/kb.ts` 的 `validateKnowledgeDraft`、`store.ts` 的 `createInStore` 与 `kbstore.ts` 的 `createKnowledge` 的顺序、`core/errors.ts` 的 `withContext`；**以后任何"发号"的地方**：校验永远排在分配前面（决策 158 的空间有限 + 这条的断号审计） | | **189** | 关闭必须经过 in_progress（todo→closed 边不存在）；词表只增不删的 TODO 裁定；知识与 issue 是两个键空间 | 账本仓 `config.md` 的 transitions/状态机表/TODO、`fixtures/config.md`（必须与账本逐字一致——它是测试里的词表）、DPMJ-214 的复合 close（内部要完成 claim+in_progress+closed）；**以后改词表两件事一起改**：账本 config.md + 插件仓 fixture | | **188** | 审查发现要分类：该修的修（broken 结构化、renderKbEntry、import 风格），核实后不修的写明理由（emitWarning、pid、checkStore、字段装配） | `core/inspect.ts` 的 `BrokenFile`、`core/kbsearch.ts` 的 `renderKbEntry`、`core/args.ts` 的 `./` import、`plugin/toolList.ts` 删掉考古；**以后审查清单的每一项只有两种结局：修，或写下不修的理由**——不许挂着 | | **187** | CLI 是状态机表不是 switch：每命令一个 handler 文件，写命令走 writeCommand、可选旗走 optFlags | `cli/runtime.ts`、`cli/commands/`（21 个文件 + 注册表）、`core/args.ts` 的 `optFlags`、`commands.test.ts` 的表↔文件一致性守卫；**以后加 CLI 命令 = commands/ 加一个文件 + COMMANDS 表加一行**——不碰 main.ts | | **186** | plugin/index.ts 是接线层：宿主声明在 host.ts、信封在 envelope.ts、三个工具各一个文件、会话在 sessionRecord.ts；apply 由命名步骤组合 | `plugin/` 的六个新文件、index.ts 的 re-export 兼容层与 `registerTool` 组合子、bundle.test.ts 的行数/结构守卫；**以后给插件加能力**：新工具开新文件（照 toolIssue.ts），新注册项进 apply 的一个命名步骤并过 `keep` | | **185** | store.ts 是装配点不是仓库：提交编排在 commit.ts、键分配在 counters.ts、store.ts 只剩配置/读模型/transact/创建 | `core/commit.ts`、`core/counters.ts`、`core/store.ts` 的 re-export 兼容层、`entity.ts` 的 `assertProjectKey`、store.test.ts 的「同一函数对象」守卫；**以后给 store 加职责时先问它属于哪个话题**——提交去 commit.ts、计数去 counters.ts，store.ts 只做装配 | | **184** | 人面文案单一出处：命令级中文消息在 `core/messages.ts`，两面只引用 | `core/messages.ts` 的 9 条消息、`cli/main.ts` 与 `plugin/command.ts` 的 13 处替换点、`messages.test.ts` 的零副本守卫；**以后给人看的命令级消息都进这张表**——字面量出现在 CLI/插件源码里守卫会红 | | **183** | 插件注册项无一漏网：会话状态进闭包（键含 root）、context 过 keep、injection 不 throw | `plugin/index.ts` 的 `createSessionRecorder`/`keep`/injection read 回调、`core/entity.ts` 的 `isProjectKey` 复用；**以后 apply 里出现的任何状态都必须属于某次 apply 的闭包**——模块级可变状态 = 热重载后的幽灵 | | **182** | 路径规则只有一个出处：实体相对路径在 `entity.ts`（posix），拼 root 只在 `io.ts` | `entity.ts` 的 `issueRelPath`/`commentRelPath`/`projectRelPath`、`io.ts` 的 `issuePath`/`commentsPath`/`projectPath`、`pathRules.test.ts` 的守卫；**以后任何"拼出账本里某个文件的路径"都先用这三条规则**——手拼在守卫测试下会红 | | **181** | 锁语义只有一个出处：`lockOwnerOf`/`lockOptionsOf`/`networkLockPath` 在 lock.ts；`host` = OS 主机名（三处入口都接线） | `core/lock.ts` 的三个原子、`core/system/env.ts` 的 `hostName`、store/kbstore/machines/project/rebase 的调用点、`cli/main.ts` 与 `plugin/command.ts` 的 createStore 传参；**以后任何"拿锁"的地方都用这两个原子**——owner 的 host 字段只剩一个来源，审计字段才可信 | | **180** | 副作用收敛是真的：文件 IO 只有 `io` 一个口（`exists`/`listDir`/`listDirEntries`/`mkdirp`/`readText`/`writeTextAtomic`） | `core/io.ts` 的四个新原子、13 个下沉文件（store/generateStore/injection/inspect/kbstore/machine/machines/perf/project/provision/scaffold/session/tagstore）、`hooks.ts` 的边界注释；**以后任何读目录/探存在/建目录的需求都先用 io 的原子**——没有就加，不许裸 `readdir`（裸写还会绕过 BOM/CR 校验） | | **179** | 引用必须能真的打开：`file:line` 数**文件绝对行**；评论没有 `comment/v1`；手工 push 只报警、不装钩子 | `core/frontmatter.ts` 的 `ParsedDocument.bodyLine`、`core/kb.ts` 的 `KnowledgeEntry.bodyLine`、`core/kbsearch.ts` 的 `hitFor`、`core/kbstore.ts` 的 create 往返、`core/doctor.ts` 的 stale 文案、`cli/main.ts` 的 doctor 提示；**以后任何"产出 file:line"的地方都数绝对行**，任何"派生文件会陈旧"的路径都要有一条人看得见的警告（装钩子这条路已被决策 15 关掉） | | **178** | 已落地行为必须有测试；临时目录用同一份 `removeTree`；"声称>实际"要改真 | `src/testing/removeTree.ts`（唯一实现）、`core/push.test.ts`/`core/doctor.test.ts`/`core/git.test.ts`/`core/render.test.ts` 的新用例、`plugin/index.test.ts` 的 blocked-last 与 `kbstore.test.ts` 的注释断言、`main.test.ts`/`skills.test.ts` 的措辞；**以后写测试**：先问"这段在测试里能不能失败"（变异验证），清理一律 `removeTree`，注释里不写没断言的事 | | **177** | 会话记录失败要重试（而不是标记成做过）；`/jira status` 的可写性由调用者提供 | `plugin/index.ts` 的 `recordSessionOnce`/`SESSION_RECORD_ATTEMPTS`/`sessionFailures`、`plugin/command.ts` 的 `CommandOptions.writable` 与 status 输出、工具超时的说明注释；**以后任何"只试一次就记成已完成"的簿记都要区分"试过"与"成了"** | | **176** | 分配号必须看盘上实际有什么（种子/手抄/重置的机器）；`git init` 在锁内 | `core/counters.ts` 的 `claimKey`（块内也取 `max(next, seed+1)`、顶出块时开新块）、`core/store.ts` 的 `commitStoreWrite`（`initializeRepository` 进锁）、`store-create.test.ts` 的种子用例；**以后任何"号/序号"分配都要以持久化状态为准，不能只信计数器** | | **175** | `.jira/` 下的运行时状态不许入库；`.gitignore` 需要迁移 | `core/git.ts` 的 `GITIGNORE`/`migrateGitignore`/`initializeRepository`、`core/store.ts` 的 `commitStoreWrite` 路径过滤、账本仓的 `.gitignore` 与一次 `git rm --cached`；**以后往仓库目录里放锁/缓存/临时状态前，先确认 ignore 模式已存在且旧账本能升级** | | **174** | 零碎 S3：一条规则一个定义、过期注释要改、二进制判定、兜底链与文件地图 | `core/entity.ts` 的 `projectOf`（`store.ts`/`io.ts` 只做别名）、`.github/workflows/ci.yml`、`scripts/check-text.mjs`、`src/cli/main.ts` 的 USAGE、`HANDOVER.md` 的文件地图；**以后"同一规则第二份实现"要当场并掉**，**"将来再做"的注释要么删要么变成一条 issue** | | **173** | 守卫质量：smoke 的"空串可绿"、陈旧 dist、CI 只查最后一个提交 | `scripts/smoke.mjs`（注入行断言、dist 新鲜度、board.html 外链）、账本仓 `.github/workflows/ledger.yml` 的 range 选择；**以后写"守卫"时的自检**：断言要能失败（空值/陈旧输入必须红），探测范围要覆盖全部输入而不是末一个 | | **172** | 文档纪律：i18n 重复键守卫、决策表严格升序、错引用、skill 与工具描述补齐 | `scripts/i18n-{tests,human}.mjs` 的重复键守卫与 `--selftest`、`package.json` 的 `check:text`、`DESIGN.md` 的决策 153/149/146/124 行、`skills/jira-work.md` 的 `jira_kb` 段、`plugin/index.ts` 的 `ISSUE_DESCRIPTION`；**以后往 i18n 表里加键**：重复键会在脚本运行时立刻报错，不再静默 | | **171** | 网络步骤（pull/push）与提交分开互斥；被拒可重试；落后要出声 | `core/store.ts` 的 `networkLockPath`、`core/rebase.ts` 的 `pullRebase`（锁 + 重试）、`cli/main.ts` 的 `sync` 漂移报告；**以后任何"会碰远端"的步骤都要走这把网络锁**，任何"看起来只是慢"的失败都要有可见出口 | | **170** | 测试面：inspect/validate 直接测试、恰等边界、写重试、临时目录清零 | 新增 `core/inspect.test.ts`/`core/validate.test.ts`/`core/inspect-paths.test.ts`、`core/io.test.ts`/`core/lock.test.ts`/`cli/main.test.ts`/`core/store.test.ts`/`plugin/index.test.ts` 的清理钩子；**以后写测试**：边界要测"恰好等于"、期望值从数据派生、临时资源登记后清理、`bothPlatforms` 用于任何平台相关的规则 | | **169** | io 的错误契约：喂哈希的树读不全就报错；args 的空值/重复/单横线/未闭合引号不再静默 | `core/io.ts` 的 `sourceTreeEntries`（`Result` + ENOENT 例外）、`core/generateStore.ts` 的 `currentSourceTree`/`planGenerated`、`core/inspect.ts` 的 `sourceTree` 条件填充、`core/args.ts` 的 `parseArgs`/`splitTokens`、`core/config.ts` 的 trim；**以后"喂哈希/喂判断的读操作"不许静默跳过**——跳过的部分正是判断会错的地方 | | **168** | `log.md` 的提交窗口只数带 key 的提交（无 key 提交不占位） | `core/generateStore.ts` 的 `readCommitRows`（`--grep` 先过滤再 `-n`）、`LOG_COMMIT_LIMIT`；**以后任何"取最近 N 条再过滤"的地方都要先过滤再取**，否则无 key 的提交会悄悄改变派生文件 | | **167** | System/CLI：环境变量大小写、长路径口径、文件名消毒（一个实现） | `core/system/git.ts` 的 `gitEnvFor`、`core/system/env.ts` 的 `homeDir`、`core/system/paths.ts` 的 `safeFileName`、`core/session.ts` 的 `sessionPath`、`core/io.ts` 的 240 常量、CLI 的长路径提示与 `claimNotice`；**以后任何"把 id 变成文件名"的地方都用 `safeFileName`**，任何"路径多长算太长"的判断都看 `system.facts` | | **166** | 插件生命周期：`apply` 的注册项全部可撤销、机器身份只有一个、`/jira sync` 走插件队列 | `plugin/index.ts` 的 `apply`/`keep`/dispose、`plugin/command.ts` 的 `registerCommand`/`CommandOptions.queue`/sync、`plugin/skills.ts` 的 `unregister`、`core/push.ts` 的 `dispose`；**以后在 `apply` 里注册任何东西都必须 `keep(...)`**，否则热重载会叠加 | | **165** | git 写路径：收编排除在途写入与临时文件、锁内校验 source_tree、push 有超时 | `core/git.ts` 的 `stageAllExceptAndCommit`/`GITIGNORE`/`push`/`runGit`、`core/store.ts` 的 `adoptHumanChanges`/`inFlightPaths`/`commitStoreWrite` 的 `beforeCommit`、`core/generateStore.ts` 的 `regenerateAndCommit`；**以后任何"扫全部未提交文件"的动作都要先排除在途写入与临时文件** | | **164** | 边界守卫按语句扫描 + 自带自检（多行/动态 import 都能抓） | `scripts/check-boundaries.mjs` 的分词器 / `specifiersIn` / `resolveShort` / `SELF_TEST`、`pnpm check`；**以后新增任何"源码扫描"类守卫都照这个模式**：按语句而不是按行，并带一张形状表每次一起跑 | | **163** | `COMMANDS` 命令表加载即自检（多一个键就炸） | `cli/main.ts` 的 `COMMANDS` 与它下面的自检循环、`parseArgs` 的两条入口（CLI 与 `/jira` 共用）、以及每一个 spec；**以后往命令表里加键之前先看这条**——只允许 `maxPositionals` 与 `flags`，任何"想加个新维度"的念头都要先改这个自检 | | **162** | 项目键是路径片段：先校验，再拼任何路径 | `core/entity` 的 `PROJECT_KEY_PATTERN`/`isProjectKey`、`core/store` 的 `createInStore`/`allocateKey`、CLI 与 `/jira` 的 `new`、`project.ts` 的派生（派生出来的键也必须过同一模式）；**以后任何"把用户输入当目录名"的地方都照这条办**（校验放在拼路径之前，且放在 core） | | **161** | 会话结束时"收尾扫描"必须和"重生成"用同一个写权限 | `plugin/index.ts` 的会话结束 effect（`mayWrite` 分支）、`core/session.ts` 的 `sessionScan`/watermark、`index.test.ts` 的成对用例与 `effectHost.deliver()`；**以后任何"会话结束时顺手做点什么"的副作用都要先问一句它写不写盘** | | **160** | 锁回收安全（标记 + 再比对）与心跳 | `core/lock.ts` 的 `reclaimLock`/`tryCreate`/`staleSince`/`withLock`；**以后任何"删别人的东西"的重放路径都要先拿标记再比对**，任何"可能超过 stale 窗口"的临界区都要心跳 | | **159** | 线上 JSON 一律 snake_case，转换只在边界（`toWire`） | `core/render.ts` 的 `toWire`/`renderIssueJson`、`plugin/index.ts` 的 `wire` 与三个 `execute` 出口、`cli/main.ts` 的 `say`、以及那两处"逐个键"的守卫；**以后新增实体字段或新工具时，不需要在 builder 里手动改名——但必须确认自己走的是边界转换**（漏了就有专门用例报错） | | **158** | 一个 project 的号到 9999 为止，超了 `KEY_EXHAUSTED` | `core/counters.ts` 的 `MAX_KEY_NUMBER`/`claimKey`、`core/errors.ts` 的 `keyExhausted`、`allocateKey` 的种子路径（`highestExistingKey`）、决策 52 的错误码分类表；**以后任何"发号"的地方都要记住空间是有限的** | | **157** | 凡引用宿主必须标版本（基线在 §2 开头） | `DESIGN.md` §2 的核对基线行、§8 里点名宿主的 7 条、决策 95 的修正记录；**以后任何对宿主的断言（API、行为、告警原文）都要就地标版本**，否则过一版无法判断还成不成立 | | **156** | 长路径：≥240 警告、≥平台上限拒绝，判据在 `core/config` 一处 | `core/config.ts` 的 `resolveStoreRoot`/`acceptRoot`、CLI 启动处的警告、`core/system/paths.ts` 的两个阈值、`config.test.ts`；**以后任何「路径太长会炸」的问题都先看这条**（根路径只是代理，真正受限的是它下面拼出来的文件） | | **155** | `/jira` 的只读子命令补 `show` / `tags lint`，且子命令可带一个位置参数 | `src/plugin/command.ts` 的 `USAGE` 与分发、`parseArgs` 的 `maxPositionals`（**以后新增带参数的子命令必须改这里**）、`command.test.ts` 的「读不写」断言（同时看 `git status` 与 `HEAD`）；`/jira` 与 CLI 的**只读集合**要对齐（决策 83） | | **154** | `merge=union` 只属于评论文件；`_merge/` 是人的约定而不是工具建的目录 | `core/git.ts` 的 `GITATTRIBUTES`、`git.test.ts` 的正反两向断言、`keyset` 的四类差异报告与它的三处断言、§11.5 的归并约定；**以后任何 `merge=union` 的扩张都要先问「两份改动被拼起来还可读吗」** | | **150** | 机器显示规则接线 + 一次性提示 | `core/machines.ts` 的 `renderMachines`/`machinesHint`/`machineDisplayName`、`core/machine.ts` 的 `machineStateDir`、CLI 的 `machines list`、插件里那份被删掉的私有 `stateDirOf`；**以后任何"给机器起名字/显示机器"的地方**都要走这条规则，任何"只提示一次"的提示都照这个标记模式 | | **149** | 结果信封统一：失败带 `me`、部分读取带 `message`、`rejected.file` 是真路径 | 三个 tool 的**所有**返回值构造点（`okValue` / `failure` / `jira_list` / `jira_kb` ×3）、三个输出 schema 的 `required`、`plugin/index.test.ts` 的信封用例、以及**以后任何新增 tool**：新工具必须走同一套信封（失败也要 `me`，跳过文件也要 `message`） | | **147** | 收编人的未提交改动（§4.13 规则 1 的落地） | 所有写路径（`transact`、`regenerateAndCommit`）、`core/git.ts` 的 `stageAllAndCommit`/`humanAuthorOf`、决策 79/39 的新鲜度断言、决策 15/34 的会话结束重生成、决策 146（作者回退）、`git-dirty` 警告与 `sync` 的 dirty 报告；**以后任何"先写文件再提交"的路径**都要先问一句"工作区干净吗" | | **146** | store 的提交身份在缺失时按次注入，不进仓库配置 | 所有写路径（`core/git.ts` 的 `stageAndCommit`）、决策 81 的"只补缺失键"、§4.9 的 `human:<name>`（因此**不能**写进仓库配置）、决策 115④ 的"提交失败必须响"、决策 79/87 的 `log.md`（它靠提交列表）、以及 CI 的四个测试 job | | **15** | 生成权必须在 **DSH 进程内**（2026-10-17 用户裁定：脱离 DSH 的定时生成 = 失败改动）；时机 = **会话结束时、flush 之前** | `ledger.yml` 只检查不生成、决策 15/34、§7.3 的两条修正记录、§4.4 的树注释与 §7.3 P0 表（"Action 在 push 时生成"这两处**尚未实现**）、`src/plugin/index.ts` 的 `pushFlush` effect + `core/generateStore.regenerateAndCommit`、决策 89/93 的只读跳过；以及以后**任何想做自动生成**的人——先确认它在 DSH 进程内、且**在 flush 之前**，否则就是失败改动 | 各种阈值常量）——改它们只需确认对应章节自己的表述。

### 11.8 实现覆盖清点（第二轮独立审计，2026-10-16）

> **为什么有这一节**：用户说"检查一下吧，估计还有不少漏掉的"，于是派了 **5 个独立 subagent** 分块审计 （数据模型 / 写路径 / 界面 / 决策 1–65 / 决策 66–131），每条都要给出 `file:line` 证据与设计原文。 **结论：漏得不少**——而且**根因是我自己的流程错误**：§11.6 的三张表清的是"**决定已定**"， 我却把它当成"**已经实现**"，于是一度报出"开放项 0"。这两件事从来不是一回事。
>
> 用法同 §11.6：**每补掉一条，就把状态改成 ✅ 并写上落点**，于是"还剩多少没做"永远可以数出来。 状态：✅ 已实现 · ⚠️ 部分 · ❌ 未实现。
>
> **2026-10-19 批量翻状态（DPMJ-104）**：十余行"已实现但仍标 ❌/⚠️"逐行对着代码复核后翻转， 每条都写了落点决策号；仍属实的缺口（57/59 的 Config 组、58 锁内长 IO、81 已存在 clone 的幂等写、 82 的 `comment.id`、29 的 deferLoading、102 的副作用收敛、46/49 的残余、67 的 rebase 豁免、 73/119 的回退位置）保持 ❌/⚠️ 并更新了证据。决策 64 的"AST"措辞同批修正（见 §8 该行）。

#### A. 正确性与写入纪律（最优先，属 §11.4 红线精神）

| 决策 | 要求 | 状态 | 证据 |
|---|---|---|---|
| 71 | conflicted **检测**（pull --rebase 之后或写事务内打标记） | ✅ **已实现（决策 134）**：`core/rebase.ts` 在显式 sync / 推送前先 `fetch`（有界）再 `pull --rebase`；**两边都动过**的 issue 由正常写事务打上 `conflicted: true` 并写一条评论（加锁/提交/审计都走原路径 ✓）。rebase 停住时**只报告、绝不强制**（红线 1 ✓）。测试用真 git 演了两台机器：不同字段 → 干净合并**但仍打标记**；同一行 → stopped 且不推 |
| 49 | **未知 frontmatter 键 = 写入拒绝**（列出未知键） | ✅ **已实现（决策 132）**：解码结果带上 `unknownKeys`，写事务一律先拒（`store.ts` 的 `transact` 与 `kbstore.ts` 的 `updateKnowledge` 各一处，两种实体一致）；读侧仍宽容但仍标注 |
| 49 | 读取侧降级必须**标注** | ⚠️ | 块数组形式的 `tags` 被静默读成 `[]`（`codec.ts:66-74,172`），警告数为 0 |
| 46 | 未知 `schema` 版本 → **降级只读**并标注 | ✅ **已实现（决策 132）**：解码结果带上实际 `schema`，写事务拒绝覆写（读仍宽容并标注） |
| 44 | `expected_revision` 不符 → 类型化 **`STALE_REVISION`**（附当前值） | ✅ **已实现（决策 132）**：工具改用 `staleRevision(expected, actual)`；CLI 的 `--expected-revision` 是**全局 flag**，CAS 在**锁内**做（`transact` 的 `expectedRevision` 选项）；真机验过陈旧=1/退出 1、当前=0；**同批（决策 132/134）**：CAS 已入锁、CLI 有全局 `--expected-revision` ✓ |
| 93 | 只读会话**默认拒绝写** | ✅ **已实现（决策 134）**：spike 查明——原来认的环境变量**宿主从不设置** ✗，真正的可读信号是 `agent.options.agentPreset`（宿主自己的预设标签是 `preset.readOnly`/`preset.workspaceWrite`）；现在 `describeCaller` 把只读预设也判为只读（reason `dsh-read-only` ✓），读照常；测试断言只读会话写被拒、读成功、普通会话照写。**已知边界**：按预设**名字**匹配是启发式（名字由部署方定），且宿主文件沙箱**不约束**进程内插件（§2.5）——所以这是插件在**遵从会话意图**，不是沙箱在拦 |
| 69/113 | 身份串**四段 + 分量内禁止分隔符**，写入即拒 | ✅ **已实现（决策 132）**：`validateIdentity` 变严格（agent 必须四段非空、human 不得含 `|`），并在**每个写事务**里校验 acting identity（一处覆盖两个界面） |

#### B. 设计里点名、但完全没做的功能

| 决策 | 要求 | 状态 | 证据 |
|---|---|---|---|
| 25/61 | **认领租约**：`claimed_at` + `lease_expires_at`（默认 2 h）、写时续租、过期只降级为"可重新认领"+ 一条评论 | ✅ **已实现（决策 135）**：认领起租（+2 h，到秒）、释放清租、**活跃租约被他人拒绝**（错误里点名持有者与到期时刻）、**过期可接管并写一条评论**（评论只在写事务里产生 ✓ 决策 38）；任何**会改动 issue 的写入**顺带续租（只延长、不缩短、**不推进 revision** ✓ 决策 44/61，零额外写放大 ✓）。字段是**两个平铺标量**——frontmatter 子集**故意不允许顶层 flow map**，而设计原文也正是两个字段 ✓ |
| 25 | 认领被未关闭的阻塞项拦下（`BLOCKED_BY_OPEN` + 点名 key + `override` + 写评论） | ✅ **已实现（决策 136）**：`blockersOf`（在 `inspect.ts`，因为要整张 issue 表）算"还没关闭的 is_blocked_by 目标"→ 经 `transact` 的 `blockers` 选项进 `ChangeContext` → `applyAssignee` 里执行规则：**agent 被拒**（错误点名 key ✓）、**人类不受影响** ✓、显式 `override` 放行**并写成一条评论** ✓（工具与 CLI 各有 `override`/`--override` ✓） |
| 5/9/92 | `agent_write_policy` / `owner_machine` 落盘 + `FOREIGN_MACHINE_READ_ONLY` 真正拦截 | ✅ **已实现（决策 133）**：`project.md` 落 `agent_write_policy`（有 remote=shared、无 remote=owner-machine）与 `owner_machine`；`assertProjectWritable` 在工具与 CLI 的写路径上拦"别的机器的 agent"（人类照写 ✓），错误点名归属机器 |
| 2/5/9/92 | **首次写入时登记新 project**（派生 key + append `paths[]`） | ✅ **已实现（决策 133）**：`ensureWorkspaceProject` = 派生 key（重名追加数字）+ 规范化 remote + 当前路径入 `paths[]` + 写 policy/owner；工具的 `create` 与 CLI 的 `new` 都**可以不给 project**，从工作区推（§4.10 step 4） |
| 130/10/119 | `sessions/<session_id>.md`：一会话一文件 + `tool_evidence` 原始证据 | ✅ **已实现（决策 137）**：`core/session.ts` 落 `session/v1`（`SESSION_SCHEMA`，含 `tool_evidence` 透传原始证据，`session.test.ts` 断言证据原样落盘 ✓）；DPMJ-9 已顺手把 `sessionPath` 的 id 消毒补上（决策 167） |
| 100/118 | **会话收尾扫描本次 git log**，给相关 issue 补评论（幂等 + 水位线在 `$DSH_HOME/dsh-jira/`） | ✅ **已实现（决策 137，写权限边界由决策 161 收口）**：`sessionScan` 扫本次 git log、给提及的 issue 补评论、水位线幂等；插件侧 `closeOutSession` 过 `mayWrite`（只读/子代理会话不再越权写 ✓ DPMJ-3） |
| 26 | `tag-create` 独立动作（`description` 必填）+ `tags/<name>.md`（`tag/v1`、`created_by`、`created_at`） | ✅ **已实现（决策 138）**：`core/tagstore.ts`（`TAG_SCHEMA = 'tag/v1'`、`created_by`/`created_at` 齐全）+ CLI `jira tag-create NAME --description TEXT`（缺 description 即拒并说明原因 ✓ `main.ts:1000-1004`） |
| 79 | **每个 Bundle** 也有 `index.md` + `log.md`（projects/*、knowledge/*） | ✅ **已实现（决策 139）**：`generateStore` 为每个 project 与每个 knowledge 域各生成 `index.md`（成员 + 计数）与 `log.md`（该 bundle 的带 key 提交 ✓ 与根日志同一规则）；生成的路径集**变成动态**（来自一次渲染 ✓），`plan/write/check` 都跟着走 ✓；同时把根 `log.md` 的条数由 50 改成设计写的 **100** ✓ |

#### C. 常量、配置与报告（便宜但要改对）

| 决策 | 要求 | 状态 | 证据 |
|---|---|---|---|
| 87 | `log.md` = 最近 **100** 条带 key 的提交 | ✅ **已实现（决策 139/168）**：`generateStore.ts:47` `LOG_COMMIT_LIMIT = 100` ✓；决策 168 又修正了窗口语义——只数**带 key** 的提交（此前把 chore 提交也数进去，账本 CI 因此误红过） |
| 59 | `lock.timeout_ms` / `lock.stale_ms` 可配置（决策 57 的 `lock` 组） | ❌ | `JiraConfig` 无 `lock` 组；`index.ts:665-669` 调 `createStore` 时没传 |
| 60 | 长路径超 240 字符 → **启动时报错** | ✅ **已实现（决策 156）**：判据收进 `core/config.resolveStoreRoot`（CLI 与插件共用）——**超平台上限直接拒绝**并点名长度/上限/平台，**≥240 只警告**（路径还能用）；`config.test.ts` 覆盖四种情形，变异验证过 |
| 58 | store 锁内**不做长 IO**、毫秒级临界区 | ⚠️ | `store.ts:220-225` 持锁跨 3 个 git 子进程；`highestExistingKey`（`store.ts:366-381`）在锁内 readdir |
| 81 | 幂等写 `core.fileMode` / `i18n.commitEncoding`（**含已存在的 clone**）+ 体检报告 | ⚠️ | `git.ts:83` 对已存在仓库直接早返回 → 决策 119 的常态路径拿不到这两个键；doctor 也不报 |
| 119 | 推送前一律 `pull --rebase` | ⚠️ **修正（2026-10-17）**：CLI 的 `sync` 一直有；**插件那处从写下起就是死代码**——注释与代码落在**同一行**（`db7743e`），`//` 把整个 `pull:` 钩子吞了，于是插件的推送队列**从来不 pull**，两台机器时 push 被拒为 non-fast-forward 并无限重试（本行的 ✅ 因此是错的）。已修，并做**变异验证**：把钩子重新注释掉，新写的端到端用例（写 → 防抖 → pull → settle → push → 检出跑 `generate --check`）立刻失败（36/37）。**新增**：推送前还多一步"重生成+提交"（决策 148），顺序是 pull → settle → push |
| 41 | 落盘 **与 JSON 键** 一律 snake_case | ✅ **已实现（决策 159）**：`toWire` 一个转换点，`renderIssueJson` / 三个 tool 的返回边界 / CLI 的 `--json` 都走它；实体内部仍 camelCase；守卫逐个键断言四种真实取值，两处变异验证 |
| 25/75 | 机器注册表：`os` 默认用 `process.platform`、要有 `last_seen` | ⚠️ | `machines.ts:123-130` 的 `os` 由调用方决定（CLI 标志可选）；`Machine.lastSeen` 从未写 |
| 5 | 评论文件的 union 合并属性 | ✅ **已收口（决策 154）**：属性本来就只覆盖 `projects/*/comments/*.md`（对），现在**反向**也断言了——issue / `config.md` / `BOARD.md` 必须是 `unspecified`，变异验证过（改成 `*.md merge=union` → 用例失败） |
| 94 | `_merge/` 目录 | ✅ **已收口（决策 154）**：结论是**工具不该建**它——决策 94 明说 MVP 不做归并工具，`_merge/` 是**归并时由人自建**的约定位置；因此把提示文案改成精确约定（`_merge/<UTC>-from-<machine_id>.md`，并写明目录自建），三处断言同步更新 |
| 105 | 解析器注释里的转义 | ✅ **已收口（决策 154）**：`frontmatter.ts` 的注释里那个 `\t` 曾被渲染成真 TAB（`ransitions:`），已改写成散文，不再依赖转义 |

#### D. 本轮新记的开放项

| # | 内容 |
|---|---|
| C10 | ~~§4.11 的"无 remote ⇒ 只读"只有错误码与提示，写路径不拦~~ | ✅ **已实现（决策 133）**：`assertProjectWritable` 接进工具的写路径与 CLI 的五个写命令；人类不受影响，本机自己的 agent 不受影响 | 决策 4/9/78/130/133 |
| C11 | ~~§4.10 后半段：解析出"未命中"后只在提示里说，首次写入并不登记~~ | ✅ **已实现（决策 133）**：首次写入即登记（派生 key、remote、`paths[]`、policy/owner），注入行那句 "on first write" 现在**是事实** | 决策 77/92/131/133 |
| C12 | ~~store 仓库没有 CI~~ ✅ **已结（2026-10-16）**：lint + `generate --check` + 提交绑定都进了门禁（见 §11.6 的 C12 行） |

> ~~**待补**：界面层审计与逐条决策覆盖三份报告仍在跑~~ → **已落定**：即下方的 E / F / G 三组。 "已实现"清单也已在各组内以 ✅ 行列出。

#### E. 界面层（第三份审计：tools / CLI / /jira / 技能 / 守卫 / 消息）

| 决策 | 要求 | 状态 | 证据 |
|---|---|---|---|
| 93 | 只读会话**默认拒绝写** | ✅ **已实现（决策 134）**：spike 查明——原来认的环境变量**宿主从不设置** ✗，真正的可读信号是 `agent.options.agentPreset`（宿主自己的预设标签是 `preset.readOnly`/`preset.workspaceWrite`）；现在 `describeCaller` 把只读预设也判为只读（reason `dsh-read-only` ✓），读照常；测试断言只读会话写被拒、读成功、普通会话照写。**已知边界**：按预设**名字**匹配是启发式（名字由部署方定），且宿主文件沙箱**不约束**进程内插件（§2.5）——所以这是插件在**遵从会话意图**，不是沙箱在拦 |
| 9 | `FOREIGN_MACHINE_READ_ONLY` 真正拦截 | ✅ **已实现（决策 133）**：同 D 组 C10 行——`assertProjectWritable` 接进工具与 CLI 写路径，异机 agent 被拒、人类照写（本行此前与 C10 自相矛盾，2026-10-19 复核对齐） |
| 9 | 规则写进工具 description + 读结果带 `writable:false, reason:'owner-machine:…'` | ✅ **已实现（决策 133/172）**：读结果带 `writable` + `me`（三个输出 schema 均 required ✓）；`jira_issue` 的 description 明说"写操作会被拒（`ok:false` + `writable:false` + `reason`），宿主 guard 在执行前就拦下"（决策 172 ⑤，`plugin/index.ts:204-205` ✓） |
| 55 | **人面一律中文**（CLI 帮助与输出、/jira 输出、README、生成的 BOARD/index/log/tags、doctor/lint/tags 报告） | ✅ **已实现（决策 142/143/144/145）**：CLI、/jira、渲染器与生成物散文全部中文；字符串迁移走 `scripts/i18n-human.mjs` / `i18n-tests.mjs`（断言命中、幂等、决策 172 补了重复键守卫）。**2026-10-19 复核修正**：「`plugin/index.ts` 零汉字有守卫」已不成立——决策 177 的 `/jira status` 可写性行是人面回调、合法带中文，守卫也没有汉字规则；真实不变量是「工具描述/错误码/JSON 键/schema/`JiraError.message` 保持英文」 |
| 84 | tool `timeoutMs`（读 5 s / 写 30 s）+ 读操作 `isConcurrencySafe` | ✅ **已实现（决策 141）**：三个工具都声明了 `timeoutMs`（`jira_list` = 5 s ✓；两个混合工具 = 30 s，同一数字要覆盖写 ✓）；`jira_list` 恒可并行 ✓，`jira` 用**白名单**（只有 `get` 可并行 ✓，无法归类保持独占 = fail closed ✓，与宿主文档「非 true 即独占」一致 ✓）；声明 `timeoutMs` 即承诺转发 `exec.signal`（宿主原话 ✓）→ `RunOptions.signal` 已接上并传给 handler ✓ |
| §6.2 | 读操作声明 `isConcurrencySafe: true` | ✅ **已实现（决策 141）**：`jira_list` 恒可并行、`jira` 白名单内 `get` 可并行（`plugin/index.ts` 有声明 ✓）；此行此前与上一行（84）自相矛盾，2026-10-19 复核对齐 |
| 89/93 | CLI 与 `/jira new` 也要查可写性；`/jira status` 不该无条件说"可写" | ✅ **已实现（决策 133/177）**：写路径统一过 `assertProjectWritable`（133）；`/jira status` 的「可写：…」改由 `options.writable()` 实时回答（177，`command.ts:132` + 测试断言 read-only 情形 ✓），硬编码"可写"已不存在 |
| 88 | `jira-work` 要讲 `jira_kb` 的用法 | ✅ **已实现（决策 172 ④）**：`skills/jira-work.md` 有完整的 `jira_kb` 用法段（search/get/create/update、kb_types 闭集、不要自造 key、只读会话不能写 ✓） |
| 44/52 | `STALE_REVISION` 可达 | ✅ **已实现（决策 132）**：同 A 组——工具返回类型化 `STALE_REVISION`（附 expected/actual），CLI 有全局 `--expected-revision`，CAS 在锁内（此行此前与 A 组矛盾，2026-10-19 复核对齐） |
| 57 | Config 五组（`root`/`tool`/`push`/`lock`/`list`） | ❌ | 只有 root/push（+machine_id/host/remote）；`lock.*` 与 `list.*` 调不了 |
| 100 | 会话收尾扫描 | ✅ **已实现（决策 137/161）**：同 B 组——`sessionScan` + 水位线幂等，且过写权限（DPMJ-3） |
| 83 | `/jira` 的只读集合含 `show <KEY>` 与 `tags lint` | ✅ **已实现（决策 155）**：两个子命令都加了且都只读（`show` 用 `renderIssueHuman(…, 'zh')`、`tags lint` 自带「只报告，绝不改写」）；顺手修掉「子命令不接受位置参数」的结构问题（`show DH-1` 原会被拒）；用例同时断言 `git status` 与 `HEAD` 不变，变异验证过 |
| 96 | `ctx.tools.guard`（全局**单调**拦截点） | ✅ **已实现（决策 141）**：查宿主源码确认 API 存在且语义正是设计要的——「任何 guard 都可以拒绝，**没有任何 guard 能强制放行**」（`ToolGuard` = (execution) => string | undefined ✓）；插件注册**恰好一个** guard：写动作 + 不可写会话（只读/子代理）→ 返回理由拒绝。handler 内仍各自拒绝（纵深防御 ✓）。测试断言：拒写 ✓、放读 ✓、放普通会话 ✓、不管别的工具 ✓ |
| 56 | 失败结果也带 `me` | ✅ **已实现（决策 149）**：`failure(error, caller, me)` 现在带回 `me`，三个输出 schema 把它列为 required；用例真的检查取值（读/拒读/拒写三种形状），变异验证过（拿掉 `me` → 用例失败） |
| 82 | `comment?{body,id?}` | ⚠️ | 只认 `body`，传 `id` 会被当未知字段拒掉（`index.ts:346`） |
| 52 | 12 个错误码都可达 | ✅ **已收口**：`BLOCKED_BY_OPEN` 由决策 136 产出（`mutate.ts` 的认领规则）；`KEY_EXHAUSTED` 由决策 158 产出（一个 project 的号到 9999 为止）；集成用例证明后者能从磁盘上已有的 `DEMO-9999` 走到 |
| 91 | 缺 label 的提示**只出现一次** | ✅ **已实现（决策 150）**：句子是纯函数，"只出现一次"由 CLI 的标记文件负责（`<机器状态目录>/notices/machines-label-<id>.seen`）；显示规则也真的接线了；用例 + 变异验证 |

> **界面层审计也确认了 A/B/C 组的多条**（STALE_REVISION、会话收尾、Config 分组、只读与异机拦截）， 三份报告互相印证。逐条覆盖（F/G 组）也已落定；2026-10-19 复核（DPMJ-104）后各组状态见表内。

#### F. 逐条覆盖：决策 1–65（第四份审计）

> **65 行里 20 行有缺口**（2026-10-19 复核后：**剩 6 行**，见下表 ⚠️/❌）。四份审计**独立**指向同一批（租约 61、认领阻塞 24、会话收尾 31、 异机降级 5、人面语言 55、Config 57、锁配置 59、未知键/版本 46/49、JSON 命名 41、锁临界区 58、 长路径 60、`STALE_REVISION` 16），互相印证——这批**已全部落地**（决策 132-164）。

| 决策 | 缺口 | 状态 |
|---|---|---|
| 4 | ~~多机缺 rebase 与冲突处理路径（同 71）~~ | ✅ **已实现（决策 134/148）**：`core/rebase.ts` fetch→pull --rebase→冲突打标；推送队列 pull→settle→push |
| 5 | ~~owner-machine 降级不落盘也不拦截（= **C10**）~~ | ✅ **已实现（决策 133）**：policy/owner 落盘 + `assertProjectWritable` 拦截 |
| 8 | ~~**仓库里没有 LICENSE 文件**~~ | ✅ **已补（2026-10-16）**：仓库根有 `LICENSE`（MIT），与 package.json 一致 |
| 16 | ~~过期 `revision` 用 `INVALID_INPUT` 而非 `STALE_REVISION`，CLI 无 `--expected-revision`~~ | ✅ **已实现（决策 132）**：类型化 `STALE_REVISION`（附 expected/actual）+ CLI 全局 `--expected-revision`，CAS 在锁内 |
| 24 | ~~agent 认领被阻塞项不拦、无 `override`、不记事件~~ | ✅ **已实现（决策 136）**：`BLOCKED_BY_OPEN` 点名 key、人类不受影响、`override` 放行并写评论；CLI `--override` 的 spec 错位由决策 163 修复（加载即自检，DPMJ-5） |
| 26 | ~~tag 注册表没有写入路径~~ | ✅ **已实现（决策 138）**：`tagstore.ts` + CLI `tag-create`（description 必填） |
| 29 | 除三个常驻工具外，`deferLoading` 的延迟工具一个都没注册（只作为 CLI 命令存在） | ⚠️（决策 141：显式超时与并发声明已做 ✓，deferLoading 未做 ✗） |
| 31 | ~~会话收尾**不扫 git log、不自动评论**~~ | ✅ **已实现（决策 137/161）**：`sessionScan` + 水位线幂等 + 过写权限 |
| 39 | 新鲜度断言没有进 CI、也没进已装的 hook（= **C12**） | ✅ store 仓库 CI 自 2026-10-16 起断言（`generate --check`）；**已装的 hook 仍不断言**——那是提交前的本地便利，不是门禁 |
| 41 | ~~`--json` 输出驼峰，违反"JSON 键也是 snake"~~ | ✅ **已实现（决策 159）**：`toWire` 一个转换点，三个出口都走它 |
| 46 | 九种 `schema` 里 `comment/v1` **不存在——已裁定为设计而非缺口**（2026-10-19）：评论按决策 68 是锚制、一个文件装多条评论，frontmatter 只能描述文件，所以八种足够；其余已收口：`tag/v1`（138）/`session/v1`（137）已存在，未知版本降级只读（132） | ✅ 已澄清（决策 179 修订决策 46 的措辞） |
| 48 | ~~身份串四段与"分量内禁分隔符"**没有校验**~~ | ✅ **已实现（决策 132）**：`validateIdentity` 在每个写事务里校验 |
| 49 | 写侧不拒未知键 ~~（读时警告、写时静默丢弃）~~；块数组 `tags` 仍被静默读成 `[]` | ⚠️ 写侧已拒（决策 132 ✓）；块数组 tags 静默读 `[]` 仍属实（A 组 49 行同步 ⚠️） |
| 55 | ~~**人面全英文**~~ | ✅ **已实现（决策 142-145）**：见 E 组 55 行 |
| 57 | Config 缺 `tool` / `lock` / `list` 三组 | ❌ |
| 58 | store 锁跨 3 个 git 子进程 + 一次 readdir | ⚠️ |
| 59 | `lock.stale_ms` / `lock.timeout_ms` 没有任何来源可配 | ❌ |
| 60 | ~~超 240 字符只在写入时 warn，没有启动报错~~ | ✅ **已实现（决策 156）**：判据在 `core/config.resolveStoreRoot`——超平台上限拒绝、≥240 警告 |
| 61 | ~~**认领租约完全不存在**~~ | ✅ **已实现（决策 135）**：起租/续租/过期可接管全链路，见 B 组 |
| 64 | ~~**没有 AST 边界检查器**，CI 也没这一步~~ | ✅ **已实现（决策 164，措辞已修）**：`scripts/check-boundaries.mjs` 按**语句**扫描（多行/动态 import/`console[` 都抓得住）+ 13 条形状表自检，每次 `pnpm check` 都跑——原行写的「AST」是设计意图，交付物是语句级分词扫描，见 §8 决策 64 的修正 |

> 该审计明确排除的（不是缺口）：**18** 分发暂不考虑 · **62** 归档 MVP 不做 · **32** 身份机制已被决策 73 的固定外部身份文件取代 · **63** peer 已被决策 108/109 撤回且由 `bundle.test.ts` 守着 · **15** 生成 BOARD 的 Action 属于另一个仓库（本包这半边 `jira generate` 已在）。

#### G. 逐条覆盖：决策 66–131（第五份审计）

> **66 行里 21 行有缺口**（2026-10-19 复核后：**剩 4 行**——102/73·119/82/67 四处 ⚠️，见下表）。这一份**抓到一个会破坏 git 操作的真 bug**（下面第一条），并且已经在同一轮修掉 ✓。

| 决策 | 缺口 | 状态 |
|---|---|---|
| 67 | **`prepare-commit-msg` 把 git 的第三个参数原样转发** → `git commit -C <ref>` 报"参数过多"并**中止提交**（真 git 复现 ✓；已修：`hooks` 放宽到 4、`verify-commit-msg` 到 2，并改用 `source` 参数判 `merge`/`squash` 豁免 ✓，带回归测试） | ✅ 已修 |
| 93 | 只读会话**默认拒绝写** | ✅ **已实现（决策 134）**：spike 查明——原来认的环境变量**宿主从不设置** ✗，真正的可读信号是 `agent.options.agentPreset`（宿主自己的预设标签是 `preset.readOnly`/`preset.workspaceWrite`）；现在 `describeCaller` 把只读预设也判为只读（reason `dsh-read-only` ✓），读照常；测试断言只读会话写被拒、读成功、普通会话照写。**已知边界**：按预设**名字**匹配是启发式（名字由部署方定），且宿主文件沙箱**不约束**进程内插件（§2.5）——所以这是插件在**遵从会话意图**，不是沙箱在拦 |
| 66/105 | CI 第二条 job 只有文本卫生与打包，**没有 frontmatter 校验、没有"重跑生成物后 git diff 为空"**（= C12） | ✅ **两半都补上了（2026-10-16）**，但落在 **store 仓库**的 CI：frontmatter 走 `lint`（`file-unreadable`），新鲜度走 `generate --check`。插件仓那条 job 仍只管文本卫生与打包，**这是刻意的分工**——它验的是代码，数据的新鲜度不是它能断言的 |
| 71 | ~~没有任何代码把 `conflicted` 置 true（同 A 组）~~ | ✅ **已实现（决策 134）**：写事务对两边都动过的 key 打 `conflicted: true` + 评论 |
| 79/87 | ~~`log.md` 取 50 条而非 100~~ | ✅ **已实现（决策 139/168）**：`LOG_COMMIT_LIMIT = 100`，窗口只数带 key 的提交 |
| 84 | tool `timeoutMs`（读 5 s / 写 30 s）+ 读操作 `isConcurrencySafe` | ✅ **已实现（决策 141）**：三个工具都声明了 `timeoutMs`（`jira_list` = 5 s ✓；两个混合工具 = 30 s，同一数字要覆盖写 ✓）；`jira_list` 恒可并行 ✓，`jira` 用**白名单**（只有 `get` 可并行 ✓，无法归类保持独占 = fail closed ✓，与宿主文档「非 true 即独占」一致 ✓）；声明 `timeoutMs` 即承诺转发 `exec.signal`（宿主原话 ✓）→ `RunOptions.signal` 已接上并传给 handler ✓ |
| 88 | ~~技能里从未提到 `jira_kb`；`jira-work` 也没有被阻塞的处理~~ | ✅ **已实现（决策 172 ④）**：`skills/jira-work.md` 有 `jira_kb` 用法段；被阻塞处理走 `BLOCKED_BY_OPEN` 的 override 流程（决策 136） |
| 91 | 短 id 显示规则是**死代码**（没人调 `machineDisplayName`），提示也不是一次性的 | ✅ **已实现（决策 150）**：`renderMachines` 现在调用它（第二列），提示每台机器一次 |
| 100 | ~~会话收尾只冲刷推送队列（同 B 组）~~ | ✅ **已实现（决策 137/161）**：`sessionScan` + 水位线 + 过写权限 |
| 102 | ~~副作用**没有收敛在** `core/io`/`cli`/`plugin`：十个 core 模块直接做 fs/子进程 IO~~ | ✅ **已实现（决策 180）**：`io` 补齐 `exists`/`listDir`/`listDirEntries`/`mkdirp`，14 处散落调用全部下沉；core 里 `node:fs` 只剩 io/git/lock/hooks 四个正当边界（grep 可证）；顺带堵掉 machine/session 绕过 BOM/CR 校验的裸写 |
| 73/119 | 既无 `DSH_HOME` 又无用户目录时，机器身份回退到 **store 内部** | ⚠️ 回退仍在（`machine.ts`），但落点是 **gitignore 覆盖的 `.jira/`**（决策 119/175：绝不进版本 ✓），两台机器共号的风险已消除；剩下的只是"位置与该行字面不符"，属有意的文档化偏离 |
| 84/119 | ~~没有会话启动/推送前的 `pull --rebase`，也没有 15 s 超时~~ | ✅ **已实现（决策 134/148/165）**：推送队列 pull→settle→push，网络步骤互斥且有超时（push 也有，决策 165） |
| 82 | 注册的参数是 12 个而非该行的 10 个；`comment` 只收 `{body}` | ⚠️ |
| 82 | 三个工具的**失败分支都不带 `me`** | ✅ **已实现（决策 149）**：同上一行——`failure()` 带 `me`，`required` 里也有它 |
| 80 | 部分读取带 `rejected` 但**没有 `message`** 说明"有文件被跳过" | ✅ **已实现（决策 149）**：`skipped()` 同时产出 `rejected` 与一句英文 `message`（读=回答是部分的；写=数据在盘上但提交失败）；`jira_list` 的 `rejected.file` 也从 `'issues'` 改成真路径；用例 + 变异验证都有 |
| 96 | `ctx.tools.guard`（全局**单调**拦截点） | ✅ **已实现（决策 141）**：查宿主源码确认 API 存在且语义正是设计要的——「任何 guard 都可以拒绝，**没有任何 guard 能强制放行**」（`ToolGuard` = (execution) => string | undefined ✓）；插件注册**恰好一个** guard：写动作 + 不可写会话（只读/子代理）→ 返回理由拒绝。handler 内仍各自拒绝（纵深防御 ✓）。测试断言：拒写 ✓、放读 ✓、放普通会话 ✓、不管别的工具 ✓ |
| 98 | 决策 99/101 引用的宿主源码位置**没有标版本**（该行要求凡引用必须标 rc.2/alpha.2） | ✅ **已实现（决策 157）**：§2 开头有核对基线（`0.2.1-alpha.2` @ 提交「docs(goal): register the branch's known limitations (task39)」），§8 里点名宿主的 7 条就地标了版本；顺带修正决策 95 的过期事实（本机现在只有一个宿主 checkout） |
| 87 | ~~`tags/index.md` 渲染 `（N）` 而非 `（N 次）`~~ | ✅ **已实现**：`generate.ts` 渲染 `（N 次）`（`generate.test.ts` 有断言 ✓） |
| 131 | ~~无 remote 的绑定算出来了、也注入了，但**没有任何写路径消费它**（= C10）~~ | ✅ **已实现（决策 133）**：`assertProjectWritable` 消费它，工具与 CLI 写路径都拦 |
| 83 | ~~`/jira` 缺 `show <KEY>` 与 `tags lint`（同 E 组）~~ | ✅ **已实现（决策 155）**：两个只读子命令都已落地 |
| 69 | ~~身份值域未强制（`validateIdentity` 是死代码）~~ | ✅ **已实现（决策 132）**：每个写事务校验 acting identity |
| 67 | 豁免只看首行正则：没有 `rebase` 分支，也不看 `source`/`.git` 状态（**`source` 部分已随上面的修复落地 ✓**） | ⚠️ |

#### H. 五份审计的合计

| 覆盖 | 结果 |
|---|---|
| 决策 1–65 逐条 | ~~20 条缺口~~ → 2026-10-19 复核（DPMJ-104）：**剩 6 行**（29 deferLoading、46 `comment/v1`、49 块数组 tags、57 Config 组、58 锁内长 IO、59 锁配置） |
| 决策 66–131 逐条 | ~~21 条缺口~~ → 复核后：**剩 4 行**（102 副作用收敛、73/119 回退位置、82 `comment.id`、67 rebase 豁免分支） |
| 数据模型 / 写路径 / 界面三份专项 | 32 + 20 条发现，与上面逐条覆盖**互相印证**；2026-10-17 第三轮审计（DPMJ-2~15）又补了一批并已全部落地或登记 |
| 合计 | 当初去重后约 45 个决策行有缺口；**截至 2026-10-19 剩 10 行**（均 ⚠️/❌ 如实标注）。当初"正在坏事"的两条（93 只读可写、9/C10 异机未拦）均已修复（决策 133/134/161） |

**优先级建议**（改一条就划掉一条）：

1. **安全与正确性**：93 只读会话识别（需要查宿主的 sandbox/会话状态真信号）· 9/C10 异机只读拦截（依赖 C11 的 `owner_machine`）· 49 未知键写入拒绝 · 46 未知版本降级只读 · 44 `STALE_REVISION` + CLI `--expected-revision` · 48/69 身份校验 · 71 `conflicted` 检测 + `pull --rebase`
2. **缺的功能**：25/61 认领租约 · 24 认领阻塞 · 31/100 会话收尾扫描 · 26 tag 注册写入 · 2/5/9/92 = C11 首次写入登记 · 79 每 Bundle 的 index/log · 29 延迟工具 · 96 `tools.guard`
3. **面广但机械**：55 人面中文（CLI/README/看板/报告）· 41 `--json` 与工具返回值改 snake
4. **便宜**：87 `log.md` 100 条 · 84 `timeoutMs` + `isConcurrencySafe` · 57 Config 三组 · 59 锁配置 · 119 `sync` 前 `pull --rebase` + 15 s · 60 启动长路径检查 · 8 LICENSE · 64 AST 边界检查器 · 39/C12 store CI · 102 副作用收敛
