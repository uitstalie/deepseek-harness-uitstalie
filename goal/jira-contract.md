# jira 能力契约（设计）

状态：**定稿**（2026/10/23，DH-13）。输入：`D:\dqc\dsh-plugin-multidevice-jira\{MIGRATION,DESIGN,HANDOVER}.md`、[capability-layers.md](capability-layers.md)、[dafeiyu.md](dafeiyu.md)。契约定稿后，阶段 0 可在外仓开工。

## 1. 包与依赖边界

```
packages/jira/
  jira-core/     @deepseek-ai/dsh-jira-core      原子能力：领域逻辑、io/git/锁/事务、渲染、doctor、kb；零 @deepseek-ai 依赖，只 node:*
  jira-service/  @deepseek-ai/dsh-jira-service   能力提供者的宿主部分：持有 Store、注册 ctx 服务 'jira'、独占 sync、volatile 配置、remote
  jira-agent/    @deepseek-ai/dsh-jira-agent     模型面：三工具、/jira、skills、guard、会话收尾、注入段
  jira-cli/      @deepseek-ai/dsh-jira-cli       人面 CLI（bin: jira），不依赖宿主，直接使用 jira-core
  ui-jira/       @deepseek-ai/dsh-client-ui-jira 浏览器面：看板/详情/KB/设置
packages/bundle/web-app/cordis.patch.uitstalie.yml  分支层单一组合：jira-service / jira-agent / ui-jira 三行（jira-app 已按 DH-203 移除）
```

依赖方向单向：`jira-core ← jira-service ← jira-agent`；`ui-jira → remote`；`jira-cli → jira-core`。`jira-agent` 只能 import `jira-core` 的类型与 `jira-service` 的注入类型，不碰内部模块。

## 2. `ctx.get('jira')` 服务 API

```ts
interface JiraService {
  readonly root: string
  readonly machineId: string
  status(): JiraStatus

  list(query: ListQuery): Promise<Result<IssueList, JiraError>>
  get(key: IssueKey): Promise<Result<Issue, JiraError>>
  board(): Promise<Result<Board, JiraError>>
  doctor(now?: Timestamp): Promise<Result<DoctorReport, JiraError>>
  searchKnowledge(query: string, topK?: number): Promise<Result<KbSearch, JiraError>>

  create(project: ProjectKey, input: NewIssueInput, actor: Actor): Promise<Result<Created, JiraError>>
  transact(key: IssueKey, mutate: Mutation, what: string, actor: Actor, options?: TransactOptions): Promise<Result<Transaction, JiraError>>
  kbCreate(input: NewKnowledge, actor: Actor): Promise<Result<WrittenKnowledge, JiraError>>
  kbUpdate(key: KnowledgeKey, patch: KnowledgePatch, actor: Actor): Promise<Result<WrittenKnowledge, JiraError>>

  sync(): Promise<Result<PushOutcome, JiraError>>
  settle(): Promise<Result<SettleOutcome, JiraError>>   // 收尾扫描 + 重生成 + 提交；不 push

  on(event: 'changed', listener: (change: ChangeNotice) => void): () => void
}
```

规则：

- 全部返回 `Result`，**不抛异常**；错误是 `JiraError`（code ∈ `not-found` / `conflict` / `invalid` / `lock-timeout` / `git` / `sync` / `io`，带 context）。
- 写方法内部负责：两级锁（`mkdir` 原语）、校验、CAS（`expectedRevision` 可选，过期拒绝并返回当前 revision）、审计身份、提交；**写事务不 push、不隐式 pull**。
- `Actor` = `{ kind: 'agent'; id: string } | { kind: 'human'; id: string }`；权限（只读会话、子代理）**不在服务判**，由 jira-agent 的 guard 拒绝。
- 服务不产生人面文案；渲染/文案在 `jira-core/messages` 与渲染器。
- 单写者：一个账本根只允许一个 `jira-service` 实例（进程内由 ctx 服务唯一性保证；跨进程靠文件锁）。CLI 是独立进程，自带锁，不共享宿主队列。
- `changed` 是 UI 与 dafeiyu 状态行的唯一刷新源；不做文件 watch 轮询。

`JiraStatus`：`{ root, machineId, pushEnabled, lastSync: { at, outcome: 'ok'|'failed', error? } | null, pending: number }`。

## 3. Provider 描述符（dafeiyu 契约 v2）

```ts
ctx.dafeiyu.register({
  id: 'jira',
  contractVersion: 2,
  label: 'Jira',
  description: 'Workspace issue ledger and knowledge base',
  enabledByDefault: false,
  settings: { sectionId: 'jira', order: 200 },
  create: (runtime) => ({
    scope: 'root',                       // 子代理不注入工具与提示段
    tools: agent => jiraTools(agent),
    promptSections: agent => [storageAwarenessSection(service.status())],
    onAgentCreated: agent => { /* 注入段数据源订阅 changed */ },
    onTurnEnd: input => service.settle(), // 失败只记录，不阻断
    dispose: () => { /* 取消 changed 订阅、停止 effect */ },
  }),
})
```

- `capabilities.jira.enabled` 只控制**模型面/提示段/UI 列表**；`jira-service` 行随 bundle 安装即运行（供 CLI、UI 与 remote 使用），两者不互相卸载。
- 注入段是“存储意识”一行（`[store] jira · …`，含存储存在与统计），**不是待办议程**；文案与数据在 jira-agent，随 `changed` 更新。
- `onTurnEnd` 只做 settle（扫描 + 重生成 + 提交）；push 由 `sync()` 显式触发（或由服务按 `push.enabled` 在 settle 后排队），失败在 `status()` 与 UI 可见。

## 4. 配置契约

| 配置 | 位置 | 归属 |
|---|---|---|
| 词表（statuses/transitions/priorities/issue_types/kb_types/resolutions） | 账本仓 `config.md` | 数据，唯一真相；UI 只读；改动走 git |
| `root` / `host` / `push.enabled` | `jira-service` 行配置（`.volatile()`） | `jira-service` schema；`ui-jira` 设置页写回 profile；立即生效 |
| `enabled` | dafeiyu `capabilities.jira.enabled` | dafeiyu |
| 机器身份 | `$DSH_HOME/dsh-jira/machine-id` | 自动，不进账本、不进配置 |

`root` 解析优先级沿用现状：row config → `$JIRA_ROOT` → `$DSH_HOME/jira` → `<profile>/.dsh/jira`；只允许一个解析实现（`jira-core/config`）。

## 5. UI 契约（ui-jira）

- settings section：`id: 'jira'`、`order: 200`；字段 `root`、`host`、`push.enabled`；展示 `status()`（root、push、pending、lastSync、错误）。
- 看板/详情/KB 只读，数据来自 `remote.jira`（`board` / `list` / `get` / `kbSearch` / `status`），不读文件、不写账本。
- 写操作只经模型工具（受 guard 约束）；设置页只改行列配置。
- dafeiyu 的 Capabilities 列表显示 `Jira` 行（label、状态、开关、“打开设置”跳 `sectionId: 'jira'`）。

## 6. 守卫与不可动契约

- guard（只读会话、子代理拒绝写）在 `jira-agent`，检查 session 模式与 `Actor`；服务不自判权限。
- `/jira` 人类命令面与模型工具走同一个 `ctx.jira`（DH-205）：命令层只做参数解析与文案渲染，不打开 store、不跑 git；`agent-boundary` 的 PENDING 已清空。
- 工具名与动词、`/jira` 子命令名、CLI 23 个命令名与退出码、人面文案出处、数据格式/key 空间/计数器分块、`.gitattributes`/`.gitignore` 语义——**全部不变**。
- 提交绑定、tag 校验、关闭规则（先 `in_progress`）、KB 键空间、`batch_close` 全成或全不成：沿用 `jira-core`，迁移只搬文件。

## 7. 阶段与验收

- **阶段 0（外仓）**：`jira-core/service.ts` seam；plugin/cli 只经服务访问账本；边界守卫加“不得直接 import core 内部模块”；验收 702 测试 + smoke 33/33 + 守卫。
- **阶段 1（进仓）**：五包 + bundle；包名 `@deepseek-ai/dsh-jira-*`；跨包边界规则；每包测试；干净 profile 装 bundle 后工具/命令/技能/UI 全出现。
- **阶段 2（dafeiyu）**：descriptor 注册、设置段、enable 门、单一组合（web-app 分支层，不再有 jira-app 重复 insert）；旧插件 shim 只调用新包。

## 8. 已定决策（2026/10/23 定稿）

1. **一个能力、两个包**：`jira-service` 与 `jira-agent` 同属 provider `jira`；dafeiyu 只看到 `jira` 一个能力，两个包是边界手段，不是两个能力。
2. **settle 与 push**：`onTurnEnd` 只做 settle（扫描 + 重生成 + 提交）；settle 成功后按 `push.enabled` 排队 push，失败写入 `status().lastSync` 并在 UI 可见；显式 `sync()` 与 CLI 仍可手动触发。
3. **remote 形态**：`remote.jira` 用 `TypertRemoteService`，与现有 UI remote 一致；只读方法（board/list/get/kbSearch/status），不暴露写。
4. **dafeiyu 关闭 enabled**：模型面（工具/提示段）隐藏；看板与详情仍可只读访问（`jira-service` 随 bundle 运行）。
5. **旧插件 shim 退出条件**：阶段 2 验收通过（新 bundle 在干净 profile 安装后工具/命令/技能/UI 全出现、702 测试与 smoke 33/33、账本数据未改）后，移除旧插件行并归档旧仓；退出前 shim 只做兼容转发，不持有第二份 sync。
