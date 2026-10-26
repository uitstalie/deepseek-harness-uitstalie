# MIGRATION.md — dsh-jira 的三层拆分与 dsfeiyu 归并

> **读者**：负责这次迁移的 agent 与维护者。这份文档假设你没有读过 `DESIGN.md` 与 `HANDOVER.md`，但它不替代它们——**决策与理由是 `DESIGN.md` 的职责，这里只讲"迁移成什么、怎么迁、别动什么"**。
>
> **状态**：迁移设计，**已执行**。本文针对外部仓库 `uitstalie/dsh-plugin-multidevice-jira` 的 `38b0e91`（2026-10-23，数据体检之后：doctor 零告警、决策 199 条）编写；迁移已按本文完成，包路径现在位于 `packages/jira/`，落地的包名是 `@deepseek-ai/dsh-*`（下文 §2.1 保留设计时的 `@uitstalie/*` 原名作为计划记录）。
>
> **数据**：账本数据仓 `uitstalie/dsh-plugin-multidevice-jira-cloudstore` 未迁移、未改格式。

---

## 0. 先读这一段（30 秒版）

- 现在的插件是**一个包、三层目录**：`src/core`（原子）/ `src/cli` + `src/plugin`（提供者）/ 没有 UI。
- 目标是把这三个目录**升格成包边界**，并把"能力"收成**一个显式服务**（`ctx.get('jira')`），让 tool / command / CLI / UI 四种表面都只依赖这个服务。
- **不要**做成三个独立插件（三个 row）。DSH 的 row 是**安装单位**，包才是依赖单位；三层应落成 **一个 bundle + 一组包**（先例：`packages/goal/` + `client/ui-goal`）。
- 数据（账本仓）**不迁移、不改格式**。它本来就是一个独立的 git 仓库（cloudstore），迁移只动代码与打包。

---

## 1. 当前状态（迁移的起点，全部实测）

### 1.1 仓库与包

| 项 | 值 |
|---|---|
| 代码仓 | `D:\dqc\dsh-plugin-multidevice-jira`（GitHub `uitstalie/dsh-plugin-multidevice-jira`，private） |
| 数据仓 | `C:\Users\TS\.dsh\jira`（GitHub `uitstalie/dsh-plugin-multidevice-jira-cloudstore`，private） |
| 包名 | `@uitstalie/dsh-jira` version `0.1.0`，`private: true`，零运行时依赖 |
| 入口 | `exports["."]` → `dist/plugin/index.js`（DSH 插件）；`exports["./cli"]` → `dist/cli/index.js`；`bin.jira` |
| 打包 | `dsh.bundle.patch = ["./cordis.patch.yml"]`；`cordis.patch.yml` 里 `insert` 一行 `id: dsh-jira` |
| 技能 | `skills/` 三个 md（jira-work / jira-board / jira-triage），随 `files` 发布 |

### 1.2 代码规模（非测试源码）

| 目录 | 文件 | 行数 | 角色 |
|---|---|---|---|
| `src/core/` | 55 | 9,602 | 纯逻辑：实体/编解码/账本/git/锁/生成/渲染/doctor/kb |
| `src/cli/` | 27 | 1,422 | `commands/` 23 个命令各一文件 + `main.ts`（301 行：表 + 装配）+ `runtime.ts` |
| `src/plugin/` | 10 | 1,831 | `index`（474 行接线）、三个工具各一文件、`envelope/host/sessionRecord/caller/skills/command` |
| `src/testing/` | 2 | 50 | `bothPlatforms`（双平台夹具）、`removeTree`（退避删除） |

### 1.3 表面（迁移时**必须保持**的外部契约）

- **模型面**：三个工具 —— `jira_issue`（10 个动词：get/create/update/switch_state/comment/assignee/link/tag_create/close/batch_close）、`jira_list`、`jira_kb`（get/search/create/update）。
- **人类面**：CLI `jira`（23 个命令：assignee, batch, board, close, comment, doctor, generate, get, hooks, init, kb, link, lint, list, machines, new, project, switch, sync, tag-create, tags, update, verify-commit-msg）；`/jira` 只读命令（status/list/board/show/tags lint）。
- **自动行为**：写前 guard（只读/子代理拒绝）、会话结束的收尾扫描 + 重生成 + 推送、注入行（`[store] jira · …`）。

### 1.4 守卫与测试（迁移后**必须继续存在**）

| 守卫 | 现在检查什么 |
|---|---|
| `scripts/check-boundaries.mjs` | 零宿主 import（只允许 `node:*` 与相对路径）、分层方向（core↛cli/plugin、plugin↛cli、cli↛plugin）、`console` 白名单、**IO 白名单**（`core/` 里只有 io/git/lock/hooks 可 import `node:fs`/`child_process`）；**20 条自检**，每次 `pnpm check` 都跑 |
| `scripts/check-text.mjs` | LF、无 BOM（175 个跟踪文件） |
| `scripts/i18n-tests.mjs` / `i18n-human.mjs` | 字符串迁移表的命中断言、幂等、重复键自检 |
| `src/core/messages.test.ts` | 命令级文案单一出处（两面零字面量副本） |
| `src/cli/commands.test.ts` | COMMANDS 表 ↔ `commands/` 文件一一对应 |
| `src/plugin/bundle.test.ts` | 入口行数预算、拆分文件存在 |
| `src/core/pathRules.test.ts` | 路径规则单点（entity 三条 posix 相对规则 + io 拼 root） |
| `src/core/store.test.ts` | re-export 与实现是同一函数对象 |

- 测试：`node --test "src/**/*.test.ts"` → **702 全绿**。
- 烟测：`node scripts/smoke.mjs`（跑 `dist/`，用真账本的临时 clone）→ **33/33**；注入行采用**轮询**等待（账本变大后固定 700ms 不够）。

### 1.5 关键决策（迁移时不能推翻，只能引用）

| 决策 | 一句话 |
|---|---|
| 64 | 单包多入口 + 分层 + 边界守卫 |
| 99 / 101 | 安装单元是 **bundle 包**；profile patch 用 `insert` 新行 |
| 102 | 原子化 + 组合 + 数据类；副作用只在 io/cli/plugin |
| 108 | 适配层零宿主依赖（**这是"独立插件"的打包约束**，见 §3.2） |
| 180 | 副作用边界：`core/` 只有 io/git/lock/hooks |
| 186 / 187 | 插件层与 CLI 拆成"接线 + 原子文件"；每命令一个 handler |
| 189 / 194 | 关闭必经 in_progress；知识键与项目键是两个空间（KB 不能当新项目名） |
| 196 / 198 | `batch_close` 全成或全不成；知识引用自动回填 `kb_refs` |
| 199 | 不变量要进守卫脚本（IO 白名单就是这条的产物） |

---

## 2. 目标形状

### 2.1 三层 → 五个包 + 一个 bundle

```
packages/jira/
  jira-core/        @uitstalie/dsh-jira-core      原子能力（纯逻辑，零宿主依赖）
  jira-service/     @uitstalie/dsh-jira-service   能力组织者：持有 Store、注册 ctx 服务 'jira'、独占 sync
  jira-agent/       @uitstalie/dsh-jira-agent     模型面 + /jira + skills + guard + 会话收尾 + 注入行
  jira-cli/         @uitstalie/dsh-jira-cli       人类面 CLI（bin: jira），不依赖宿主
  ui-jira/          @uitstalie/dsh-jira-ui        浏览器面（client 插件：看板/详情/KB/设置）
packages/bundle/
  jira-app/         @uitstalie/dsh-jira-app       一个 bundle patch：插入上面需要成行的包
```

依赖方向（**单向**）：

```
jira-core  ←  jira-service  ←  jira-agent
     ↑             ↑              ↑
  jira-cli      ui-jira        （bundle 只负责组合，不含逻辑）
```

### 2.2 谁成"行"（row）

| 行 | 包 | 说明 |
|---|---|---|
| `jira-service` | `jira-service` | 必须成行：它注册 `jira` 服务并持有 sync 队列 |
| `jira-agent` | `jira-agent` | 必须成行：注册工具/命令/技能/guard/effect |
| `jira-ui` | `ui-jira` | 浏览器侧行（client 插件） |
| `jira-cli` | `jira-cli` | **不成行**：`bin` 即可，用户脚本调用 |

bundle 的 `cordis.patch.yml` 形如（照 `packages/bundle/web-app/cordis.patch.yml` 的写法）：

```yaml
- insert:
    - id: jira-service
      name: '@uitstalie/dsh-jira-service'
    - id: jira-agent
      name: '@uitstalie/dsh-jira-agent'
    - id: jira-ui
      name: '@uitstalie/dsh-jira-ui'
```

> **为什么不拆成三个插件**：row 是安装/启用单位。三行 = 三种部分安装状态（有工具没服务、有 UI 没数据），而且行之间没有依赖系统，只能靠 `ctx.get` 运行时探测。包边界能表达依赖，也能被编译期与测试抓住；DSH 自己的 `packages/goal/` 就是这么做的。

---

## 3. 包拆分细则

### 3.1 `jira-core`（原子能力 / 领域层）

**来源**：整个 `src/core/`（含 `system/`、`messages.ts`、`entity.ts`、`result.ts`、`errors.ts`）。

- 入口 `index.ts` 只做**受控再导出**：`entities`、`codec`、`store` 工厂与 `transact`、`repo`（git/rebase/push/lock）、`generate`、`doctor`、`kb`、`system`、`messages`。内部模块保持深路径可测。
- **不 import 任何宿主包**；只 `node:*`。
- 文件 IO 仍然只经 `core/io.ts`（IO 白名单在守卫里）。
- 测试随包迁走；`fixtures/config.md` 要跟着 `jira-core` 走（它是测试里的词表副本，**必须与账本仓 `config.md` 逐字一致**，决策 189）。

### 3.2 `jira-service`（能力组织者）

**来源**：现在散在 `plugin/index.ts`（makeStore / machine id / push queue / session effect 的接线）与 `cli/runtime.ts`（buildContext）里的"装配"部分。

职责：

1. **解析 store 根**（唯一实现：`core/config.resolveStoreRoot`，优先级 `row config.root > $JIRA_ROOT > $DSH_HOME/jira > <profile>/.dsh/jira`）。
2. 创建并持有 `Store`（`createStore({ root, machineId, host, now })`），机器 id 来自 `$DSH_HOME/dsh-jira/machine-id`（**不进账本**，决策 73/119）。
3. 注册 **ctx 服务 `jira`**（见 §4）。
4. **独占 sync**：push 队列、`pull --rebase`、settle（重生成 + 提交）、网络锁（`.jira/network.lock`）、失败重试与可见性。
5. 发出 `changed` 事件（每次提交之后），供 UI 与其它消费者订阅。

> **重要约束**：一个 store 只允许**一个** sync 所有者。若 dsfeiyu 里再嵌入一份 jira，必须复用本服务，不能第二个包自己 push（否则同一账本两个队列会各自推、各自提交）。

### 3.3 `jira-agent`（模型面 + /jira + 技能 + 自动行为）

**来源**：`src/plugin/` 全部（`toolIssue/toolList/toolKb`、`envelope`、`host`、`caller`、`sessionRecord`、`command`、`skills`）+ `skills/` 三个 md。

- 只经 `ctx.get('jira')` 访问账本（**不直接 import `jira-core` 之外的任何东西**，实际只 import 类型）。
- guard（只读/子代理拒绝）、工具注册、`/jira` 命令、技能注册、会话结束 effect、注入行都在这里。
- `host.ts` 里的宿主鸭子类型可以删掉：在仓内直接用 `@deepseek-ai/dsh-*` 的类型（见 §8「零宿主依赖的边界」）。

### 3.4 `jira-cli`（人类面）

**来源**：`src/cli/` 全部（`main` + `runtime` + `commands/` 23 个文件 + `index`）。

- 依赖 `jira-core`（+ 需要 sync 时用 `jira-service` 的**纯函数部分**，不要起一个宿主 ctx）。
- 保留 `bin.jira`、退出码语义（0/1/2）、中文输出逐字节不变。
- 它是账本仓 CI 的构建目标（见 §5.3）。

### 3.5 `ui-jira`（UI 与配置）

**全新**，没有现成代码。参考 `packages/client/ui-goal` 的形状：

- 入口 `client/index.ts`，通过 `ctx.clientModules` / slots 挂载：
  - **看板面板**：读 `jira.board()`，按 status 分组（复用 `core/generate` 的版式，不要另写一套渲染）。
  - **issue 详情**：`jira.get(key)` + 评论；只读（写回模型面，人类要改走 CLI 或工具）。
  - **KB 搜索**：`jira.searchKnowledge(query)`，显示 `file:line`（决策 179 的绝对行）。
  - **设置页**：见 §6。
- 只依赖 `ctx.get('jira')` 与宿主 UI 包，**不 import `jira-core`**（除类型）。

---

## 4. 服务门面契约（`ctx.get('jira')`）

这是迁移的**核心契约**。建议接口（TypeScript，示意）：

```ts
interface JiraService {
  /** 解析后的账本根（绝对路径） */
  readonly root: string
  readonly machineId: string

  // 读
  list(query: ListQuery): Promise<Result<IssueList, JiraError>>
  get(key: IssueKey): Promise<Result<Issue, JiraError>>
  board(): Promise<Result<Board, JiraError>>
  doctor(now?: Timestamp): Promise<Result<DoctorReport, JiraError>>
  searchKnowledge(query: string, topK?: number): Promise<Result<KbSearch, JiraError>>

  // 写（全部走带锁事务；调用方不直接碰文件）
  create(project: string, input: NewIssueInput): Promise<Result<Created, JiraError>>
  transact(key: IssueKey, mutate: Mutation, what: string, options?: TransactOptions): Promise<Result<Transaction, JiraError>>
  kbCreate(input: NewKnowledge): Promise<Result<WrittenKnowledge, JiraError>>
  kbUpdate(key: KnowledgeKey, patch: KnowledgePatch): Promise<Result<WrittenKnowledge, JiraError>>

  // 同步（唯一所有者）
  sync(): Promise<Result<PushOutcome, JiraError>>

  // 事件：每次提交之后；返回取消订阅
  on(event: 'changed', listener: (change: ChangeNotice) => void): () => void
}
```

规则：

- 所有方法返回 `Result`，**不抛异常**（今天全仓生产代码只有 1 处 throw，是命令表的加载期自检——保持这样）。
- 写方法内部负责：锁、校验、CAS（`expectedRevision`）、提交、审计身份。
- 权限（只读会话/子代理）**不在服务里判**：它属于 agent 面（guard + caller），服务只认 `Actor`。
- 服务不产生人面文案；中文文案在 `messages` / 渲染器里。

---

## 5. 云能力（账本仓 + 同步机制）怎么迁

**结论：数据仓原地不动，迁的是代码。**

### 5.1 数据仓是什么

- 一个独立的 git 仓库（`uitstalie/dsh-plugin-multidevice-jira-cloudstore`），一 issue 一 Markdown；
- 目录：`projects/<KEY>/{issues,comments,project.md}`、`knowledge/<domain>/KB-<n>.md`、`counters/<machine>.json`、`machines/`、`sessions/`、`tags/`、`config.md`、派生的 `BOARD.md/index.md/log.md`；
- 机器身份在 **`$DSH_HOME/dsh-jira/machine-id`**（不在仓里）；号段按机器分块（当前两台机器块不重叠）；
- 仓内 CI：`.github/workflows/ledger.yml` —— `jira lint` + `jira generate --check` + 提交信息绑定（`verify-commit-msg`），只读。

### 5.2 迁移动作

1. **不改格式**：schema（`issue/v1` 等）、key 空间、计数器、`.gitattributes`（评论 `merge=union`）、`.gitignore`（`.jira/`、`machine-id`）一律不动。
2. **sync 归 `jira-service` 独占**：push 队列、`pull --rebase`、settle（重生成 + 提交）、`network.lock`、超时、失败重试与可见性。`jira-agent` / `jira-cli` 只调用 `sync()`。
3. **提交身份**：沿用 `identityArgs`（按调用注入 `-c user.name/user.email`，不写 repo 配置）。
4. **CI 跟着 CLI 走**：`ledger.yml` 现在 checkout 插件仓、`npm install && npm run build`，然后跑 `node .dsh-jira-plugin/dist/cli/index.js …`。拆包后改成构建 `jira-cli` 包（或直接 `npx` 构建产物），**命令不变**。注意 CI 里那条 `PLUGIN_TOKEN` 检查的路径与仓库名也要改。
5. **账本仓的 `.gitignore` 迁移逻辑**（`migrateGitignore`）保留：旧账本靠它补齐新 pattern。
6. **CI 目前被手动禁用**（两仓 `disabled_manually`）。迁移不动它，但要记着：本地门禁是 `lint` + `generate --check`。

### 5.3 "云端能力"在代码里的落点（拆包后）

| 能力 | 现在 | 迁移后 |
|---|---|---|
| 锁（issue/store/counter/network） | `core/lock.ts` | `jira-core` |
| git 子进程、身份、超时 | `core/git.ts` | `jira-core` |
| 提交编排、收编人工改动 | `core/commit.ts` | `jira-core` |
| rebase/冲突标记 | `core/rebase.ts` | `jira-core` |
| push 队列（防抖、重试、可见性） | `core/push.ts` + 插件接线 | **`jira-service`**（唯一所有者） |
| 重生成 + 提交（settle） | `core/generateStore.ts` | `jira-core`（`jira-service` 调用） |
| 会话结束的收尾扫描 | `core/session.ts` + 插件 effect | 扫描在 `jira-core`，effect 在 `jira-agent` |

---

## 6. UI 与配置（`ui-jira`）

### 6.1 配置的三种东西（不要混）

| 配置 | 位置 | 谁改 | 迁移后 |
|---|---|---|---|
| **账本词表**（statuses/transitions/priorities/issue_types/kb_types/resolutions） | 账本仓 `config.md`（版本化、人可读） | 人或 agent 提交 | **留在数据里**，UI 只读展示（改动走 git，不走设置页） |
| **行列配置**（root、host、push 开关、目录权限） | profile 的 Cordis patch（`cordis.patch.yml` 的 row `config`） | `dsh settings` / settings UI | 拆包后用 **`.volatile()`** 声明，settings 页编辑 |
| 机器身份 | `$DSH_HOME/dsh-jira/machine-id` | 自动 | 不动 |

**契约**：`jira-service` 的 row config 只放"在哪、以谁的身份、要不要推"，绝不放词表。词表必须有唯一真相（`config.md`），否则两份会漂。

### 6.2 设置页字段（建议）

```ts
// jira-service 的 Config
static Config = z.object({
  root: z.string().optional(),          // 账本根；空 = 按优先级自动解析
  host: z.string().optional(),          // 只影响审计字段 owner.host
  push: z.object({ enabled: z.boolean().default(false) }).default({ enabled: false }),
})
```

`root`/`push.enabled` 用 `.volatile()`：settings 页改完写回 profile patch，立即生效，无需重启。

---

## 7. 阶段计划（每阶段独立可验收、可回退）

### 阶段 0 —— 单包内做 seam（**建议先做这个**，1~2 天）

不动打包、不动 UI。目标：把"20 个 core import"收成一条接口。

1. 新建 `src/core/service.ts`：`createJiraService({ store, now })` 实现 §4 的接口（内部调用现有函数）。
2. `src/plugin/*` 与 `src/cli/*` 改成**只经服务**访问账本（类型上仍然可以 import `jira-core` 的类型）。
3. `check-boundaries.mjs` 加一条：`src/plugin/`、`src/cli/` 不得直接 import `core/` 下除 `service.ts` 与类型之外的模块。
4. 验收：702 测试全绿（可微调 import）、smoke 33/33、守卫通过、`plugin/index.ts` 行数下降。
5. 收益（即使永不拆包）：插件层测试变简单；拆包时不用再理这些 import。

### 阶段 1 —— 进 DSH 仓库后拆包（1~2 周）

1. 按 §2.1 建 5 个包 + 1 个 bundle；`pnpm-workspace.yaml` 里加 `packages/jira/*`。
2. 用 workspace 依赖（`workspace:*`）连接；每个包单独 `tsconfig`、单独测试。
3. 守卫按包跑：**跨包规则**（`jira-agent` 不得 import `jira-core` 的内部模块，只能 import 类型与 `jira-service` 的注入类型）。
4. `smoke.mjs` 改成"构建 `jira-cli` + `jira-agent`，对真账本跑 33 步"。
5. 验收：一个干净 profile 里 `dsh plugin add` bundle → 工具/命令/技能/UI 全部出现；702 测试（按包分布）全绿；`tree` 里没有反向依赖。

### 阶段 2 —— 归并 dsfeiyu

1. `packages/jira/` 变成 dsfeiyu 的一个包组；bundle 由 dsfeiyu 的总 bundle 组合（不要两个 bundle 都 insert 同一行）。
2. **工具名前缀**：`jira_*` 已经带命名空间，保留；若 dsfeiyu 有自己的 issue 概念，先定谁负责什么，不要出现两套"账本"。
3. **prompt 预算**：三个工具常驻上下文；合并后按 dsfeiyu 的预算决定是否 `deferLoading`（决策 29 的悬案）。
4. **配置命名空间**：dsfeiyu 的 settings 里给 jira 一个分组，row id 用 `jira-service` / `jira-agent`。

---

## 8. 必须先定的五个契约（否则会返工）

1. **服务 API 面**：§4 的接口就是契约。先写类型、再写实现；`jira-service` 之外的人只能看这些方法。
2. **零宿主依赖的边界**：决策 108 是**独立插件**的打包约束。进仓后，`jira-service`/`jira-agent` 可以 import `@deepseek-ai/dsh-*`；`jira-core` **永远不**（它是纯逻辑，要能被 CLI 与测试直接跑）。
3. **配置真相**：词表在 `config.md`，行列配置在 profile patch。**不许两边都存 root 之外的同一件事**。
4. **事件/刷新**：`changed` 事件是 UI 唯一刷新源（不要文件 watch 轮询；账本在别的进程里也会变）。
5. **single writer**：一个账本只有一个 `jira-service` 实例持有 sync。谁要第二个消费者，共享服务，不另起队列。

---

## 9. 不可动的清单（数据与外部契约）

- 账本仓的数据格式、目录、schema、key 空间、计数器分块、`.gitattributes`（union 只给评论）、`.gitignore` 语义。
- 工具名与动词（`jira_issue` 的 10 个 action、`jira_list`、`jira_kb` 的 4 个）、`/jira` 子命令名、CLI 23 个命令名与退出码。
- 中文人面文案的**出处**（`core/messages.ts` + 渲染器）；迁移只许搬文件，不许重写文案。
- 决策 189 的关闭规则（必须先 `in_progress`）、决策 194 的键空间（`KB` 不能当新项目名）、决策 196 的批量语义。
- `fixtures/config.md` 与账本仓 `config.md` 的逐字一致（改一边必须改另一边）。

---

## 10. dev 工作区的操作清单

```powershell
# 代码仓
cd D:\dqc\dsh-plugin-multidevice-jira
.\node_modules\.bin\tsc.cmd -p tsconfig.test.json     # 类型（含测试）
node --test "src/**/*.test.ts"                        # 702 个测试
.\node_modules\.bin\tsc.cmd -p tsconfig.json          # 构建 dist/（smoke 跑 dist）
node scripts/smoke.mjs                                # 33 步，用真账本的临时 clone
node scripts/check-boundaries.mjs                     # 分层/宿主/console/IO 白名单（20 条自检）
node scripts/check-text.mjs                           # LF / BOM

# 账本仓（只读检查）
node D:\dqc\dsh-plugin-multidevice-jira\dist\cli\index.js lint --root C:\Users\TS\.dsh\jira
node D:\dqc\dsh-plugin-multidevice-jira\dist\cli\index.js generate --root C:\Users\TS\.dsh\jira --check
```

- **CI 状态**：两个仓库的 GitHub Actions 都是 `disabled_manually`（用户手动关的）。本地门禁以上面的命令为准；不要擅自 `gh workflow enable`。
- 改任何行为 = 一条新决策行（`DESIGN.md` §8，**下一条编号 200**）+ `HANDOVER.md` 一段 + 相关守卫测试。
- 迁移期间**不要**同时改数据格式与包结构（一次只动一件事）。

---

## 附录 A：文件映射（阶段 1 用）

| 现在 | 迁移后 |
|---|---|
| `src/core/**`（含 `system/`、`messages.ts`、`entity.ts`、`result.ts`、`errors.ts`） | `jira-core/src/**` |
| `src/core/io.ts` / `git.ts` / `lock.ts` / `hooks.ts` | `jira-core/src/**`（IO 白名单不变） |
| `src/plugin/index.ts` 的装配部分（makeStore、machine id、push 队列、effect 接线） | `jira-service/src/**` |
| `src/plugin/toolIssue.ts` / `toolList.ts` / `toolKb.ts` / `envelope.ts` / `host.ts` / `caller.ts` / `sessionRecord.ts` / `command.ts` / `skills.ts` | `jira-agent/src/**` |
| `src/cli/**` + `src/cli/commands/**` | `jira-cli/src/**` |
| `skills/*.md` | `jira-agent/skills/` |
| `cordis.patch.yml` | `packages/bundle/jira-app/cordis.patch.yml` |
| `scripts/check-boundaries.mjs` | 仓根 `scripts/`（改成按包 + 跨包规则） |
| `scripts/smoke.mjs` | 仓根 `scripts/`（构建 `jira-cli` + `jira-agent` 后跑） |
| `fixtures/config.md` | `jira-core/fixtures/config.md` |
| `DESIGN.md` / `HANDOVER.md` | 仓根（或 `packages/jira/` 下的设计文档，二选一，不要两处） |

## 附录 B：现有 `plugin/` 与 `cli/` 的文件清单（迁移时逐个确认）

- `plugin/`: `index.ts`（474 行，接线 + re-export）、`envelope.ts`、`host.ts`、`caller.ts`、`sessionRecord.ts`、`command.ts`、`skills.ts`、`toolIssue.ts`、`toolKb.ts`、`toolList.ts`
- `cli/`: `index.ts`（bin shim）、`main.ts`（301 行，USAGE/COMMANDS 表/preflight/dispatch）、`runtime.ts`（CommandContext + 组合子）、`commands/` 23 个文件
