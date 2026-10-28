# 能力分层：原子能力 → 能力提供者 → dafeiyu（设计）

状态：设计草案（jira `DH-7` 后续架构，2026/10/23）。本文定义三层架构与迁移方向；`dafeiyu` 的既有契约见 [dafeiyu.md](dafeiyu.md)，memory/personality 见 [memory.md](memory.md)、[personality.md](personality.md)。**本文定稿前不写代码。**

## 一句话

插件按三层组织：**原子能力（atom）**只提供可复用、无 UI、无模型面的读写与操作；**能力提供者（provider）**把 atom 组合成用户可感知的能力，并拥有自己的配置页；**dafeiyu** 只做能力注册表、全局 enable/disable 与 UI 总入口，不拥有具体配置。

## L1 原子能力

- 形态：Cordis 服务（`ctx.<name>`），无模型工具、无 system prompt 段、无 client 包。
- 职责：单一事项的读写/操作与拒绝规则；返回数据与版本，不解释业务语义。
- 目录：`packages/uitstalie/atoms/<name>/`；包名 `@deepseek-ai/dsh-<name>-atom`（避免与既有工具包重名）。
- 复用目标：同一件事只实现一次。第一个 atom 是 **`.dsh` scoped store**：memory、personality、jira 以及后续 credential/state 都通过它读写，不再各自拼路径、版本守卫与拒绝矩阵。

### `.dsh` scoped store（atom）

统一 `scope: 'workspace' | 'global'`：

| scope | 根 | 典型内容 |
|---|---|---|
| `workspace` | `<projectRoot>/.dsh` | `memory/`、`personality/` 覆盖、项目级 rules/skills |
| `global` | `$DSH_HOME`（即 `~/.dsh`，经 `resolveDshHome()`） | `personality/PERSONALITY.md`、`jira/` 台账、全局配置 |

API（沿用现有 `ctx.dshStore` 形状并扩 scope）：

```ts
interface ScopedStore {
  root(scope, session?): Promise<string>
  readFile(scope, path, opts?): Promise<{ path, text?, version? }>
  writeFile(scope, path, content, opts?: { expected?: string; signal? }): Promise<{ path, version }>
  stat(scope, path, opts?): Promise<{ kind, version, size? } | undefined>
  list(scope, path, opts?): Promise<Entry[]>
  remove(scope, path, opts?): Promise<void>
}
```

- 路径一律相对 store 根，拒绝矩阵（绝对路径、`..`、盘符、保留设备名等）与现有实现一致；错误类型沿用 `FsError` 与共享拒绝标记。
- 版本守卫：`writeFile` 的 `expected` 映射到 `replaceIfVersion`；省略即无条件原子写。读回 `stat`/`readFile` 的 version 可直接作为 `expected`。
- 保留命名空间按 scope 声明：`workspace` 下 `memory/**`、`rules/**`、`skills/**`；`global` 下 `jira/**`、`personality/**`。保留只约束**模型工具**，atom 本身可写；表放在 atom 导出的数据里，工具层消费。
- 权限：写操作过会话策略门（`sandboxPolicy`），读不过门；global scope 的写不依赖会话，但调用方需显式传入 session 或 `undefined`，由调用方决定是否要求会话。
- 并发：同一进程内按 store 根串行；跨进程靠文件版本守卫（冲突重读一次，再失败报错）。
- 迁移：现有 `@deepseek-ai/dsh-tool-dsh-store` 的 `ctx.dshStore` 抽到 atom 包；工具包保留 `tool-dsh-store` 工具与侧边栏 Remote，改为注入 atom；`workspace` 行为不变，`global` 是新增 scope。

## L2 能力提供者

- 形态：function plugin（`name`/`inject`/`Config`/`apply`），`inject: ['dafeiyu', 'dshStore', ...]`；不直接订阅 `session/event` 等全局事件（由 dafeiyu 转发）。
- 组合：一个 provider 可依赖多个 atom（memory = store + sessionQuery + jobs + llm；personality = store + fs.watch；jira = store + jira-ledger atom + jira-cloud atom）。
- 配置：**provider 拥有自己的配置 schema 与设置页**（client 包注册到 settings seat）；dafeiyu 不读、不解释这些字段。
- 描述符 v2（dafeiyu 用于列表/开关/跳转，不用于配置）：

```ts
interface CapabilityProvider {
  id: string
  contractVersion: 2
  label: string                 // 列表显示名
  description: string           // 一句话
  enabledByDefault?: boolean
  settings?: { sectionId: string; order: number }  // 指向 provider 自己的设置页
  create(runtime): CapabilityContribution | Promise<...>
}
```

- 生命周期与失败语义沿用 [dafeiyu.md](dafeiyu.md)：`agent/created` 接线、completed `turn/end` 派发、同 session 串行、失败隔离。

## L3 dafeiyu：UI 总代 + 全局开关

- **注册表/状态**：`register` / `status`（present/enabled/state/failure/lastTurnAt）。
- **全局 enable/disable**：`capabilities.<id>.enabled`（dafeiyu 自己的行配置），provider 不存在时报 `missing`。
- **UI 总入口**：client 包 `@deepseek-ai/dsh-client-ui-dafeiyu` 注册一个设置段 “Capabilities”，列出每个 provider 的 label、状态、开关和“打开设置”链接（按 `settings.sectionId` 跳转到 provider 自己的设置段）。
- **不拥有具体配置**：不渲染 provider 的表单，不校验其 schema；provider 设置页负责自己的保存与生效。
- 契约版本：v2 起 descriptor 带 UI 元数据；v1 provider 仍可注册（无 UI 元数据，只显示 id/状态）。

### 宿主环境 atom（`systemEnvironment`）

`packages/uitstalie/system-environment/`（`@deepseek-ai/dsh-system-environment`）提供 `ctx.systemEnvironment`：平台与路径方言、分隔符、大小写规则、环境变量查找（Windows 大小写不敏感）、用户 home 与 `resolveDshHome()`。两套规则在任意宿主都可测（`platform: 'win32' | 'posix'`），因此 Windows 行为能在 Linux 上验证。分支层把它挂在 `store-atom` 之后。

现有消费者仍各自拼自己的路径比较（sandbox 诊断、home-backup、store-atom）；迁移到本服务另行跟踪，且不得改变行为。

## jira：采用 Core-as-atom（DH-309 定稿）

2026-10-27 决定：**不**再拆 `jira-ledger` / `jira-cloud` 两个 atom，正式采用 [jira-contract.md](jira-contract.md) 的 Core-as-atom。

- `jira-core` 是原子能力：领域逻辑、io/git/锁/事务、渲染、doctor、kb；零 `@deepseek-ai` 依赖，只 `node:*`。它已经满足 atom 的定位（无 UI、无模型面、无 provider 配置）。
- `jira-service` 是**能力提供者的宿主部分**：持有 Store、注册 `ctx.jira`、独占 sync、volatile 配置与 `remote.jira`；`jira-agent` 是模型面；`ui-jira` 是浏览器面；`jira-cli` 是人面。
- **不再引入 ledger/cloud 包**：那会把已经零依赖的 core 拆成两个互相依赖的包，只增加跨包版本与接口面，不减少职责；git 提交与文件 version 的语义冲突也不会因此消失。
- dafeiyu 列表与设置页已由 `jira-agent` 的 descriptor（`settings.sectionId = 'jira'`）加 `ui-jira` 完成；旧插件 shim 没有存在必要。
- 数据兼容不变：台账路径 `$DSH_HOME/jira`、issue 锁、CAS、审计、数据格式与 Git 语义都保持。
- 退出/延期：`jira-ledger` / `jira-cloud` 的拆分**不实施**；将来若出现第二个只读消费者或独立同步进程，再按当时真实的 consumer 重开，而不是现在按行数预拆。

## 迁移顺序

1. 本文 + `dafeiyu.md` 定稿（契约 v2、atom 接口、配置归属）。
2. atom：`.dsh` scoped store 抽包，`tool-dsh-store` 改消费者；memory/personality 改用 atom（行为不变，测试保持绿）。
3. provider 描述符 v2 + `dsh-client-ui-dafeiyu` 设置段（先接 memory/personality）。
4. jira：已按 Core-as-atom（DH-309）完成——没有 ledger/cloud 拆分；`jira-service`/`jira-agent`/`ui-jira`/`jira-cli` 的边界见 jira-contract.md。
5. 清理：旧路径/重复配置、升级说明、README 与 goal 文档同步。

**状态（2026-10-27，DH-301）**：`global` scope 已落地——根固定为 `resolveDshHome()`，`workspace` 根为 `<projectRoot>/.dsh`，没有第三个根；personality 的 `globalPath` 配置已移除，全局档案/历史/提案都走 `ctx.dshStore` 的 `global` scope，`ctx.fs` 只负责 watch。全局写不过会话策略门，由调用方承担审计。

## 风险与未决

1. `global` scope 与 `workspace` scope 的权限语义不同（global 写不依赖会话），需要 provider 明确传 session 并承担审计。
2. atom 抽包会产生一次跨包接口变更（`ctx.dshStore` 的 scope 参数），需一次性改完 memory/personality/tool-dsh-store，避免双接口并存。
3. provider 设置页的 sectionId 命名与 order 需要注册约定，否则 dafeiyu 的“打开设置”链接会漂移。
4. jira 的 git 台账写入与 atom 版本守卫如何共存：**已解决（DH-309）**——不套用 store CAS。git commit 是审计日志，文件 version 仍由 `jira-core` 的 CAS 负责，两者保持现状；core 作为 atom 没有第二个版本体系。
5. 旧 jira 插件 shim 的退出条件与时间点：**不适用**——Core-as-atom 决定不引入 ledger/cloud 包，因此没有需要兼容的旧行。

## 落地状态（2026-10-27，DH-12）

- **目录落点改为 `packages/uitstalie/store-atom/`**：仓库的包门禁（`verify-package-meta`、`verify-package-dependencies`、`package-graph`、`gen-tsconfig-paths` 等）只枚举 `packages/*/*`，`atoms/<name>/` 会落在所有包级检查的盲区；包名仍是 `@deepseek-ai/dsh-store-atom`。后续 atom 沿用这个两层目录约定。
- 首个 atom 已抽出：`tool-dsh-store` 不再提供 `ctx.dshStore`，改为 `inject: ['dshStore']` 后消费；memory/personality 的 workspace 读写随之走 atom（行为不变，160 个相关测试通过）。
- **`global` scope 已实现（DH-301）**：`DshStore` 的每个方法都接受 `scope: 'global' | 'workspace'`（默认 workspace）；global 根固定为 `resolveDshHome()`，workspace 根为 `<projectRoot>/.dsh`，没有第三个根。personality 的 `globalPath` 配置已移除，全局档案/历史/提案都走 atom 的 global scope；`ctx.fs` 只用于 watch。全局写不过会话策略门，审计由调用方承担。
- **接口的 `scope` 参数已加**：`rootFor`/`prepare` 首个参数改为 scope（global 可不传 session）；读写方法保持 session 在首位、允许 `undefined`（仅 global）。memory 与 tool-dsh-store 只走默认 workspace，行为不变。

## 落地状态（2026-10-27，DH-309）

- **依赖方向修正**：`.dsh/rules` 的扫描从 `agent-instructions-plus` 移入 `store-atom`（`src/rules.ts`），atom 不再依赖指令 provider；`agent-instructions-plus` 与 `tool-dsh-store` 改为消费 atom 的导出。store-atom 的独立 Loader 组合测试只挂 `fs-local` + `store-atom`，证明提供存储不需要任何指令/provider。
- **宿主环境 atom 已落地**：新增 `packages/uitstalie/system-environment/`（`ctx.systemEnvironment`），分支层挂在 `store-atom` 之后；本单只提供服务与验收，sandbox/home-backup/store-atom 的迁移另行跟踪。
- **jira 合同收敛**：采用 Core-as-atom（见上节），`goal/jira-contract.md` 与 DH-12/DH-13 的完成边界据此对齐；`jira-ledger`/`jira-cloud` 不实施。
- **仍延期的**：把 sandbox 诊断、home-backup、store-atom 的路径/环境判断迁到 `systemEnvironment`；这是行为保持的迁移，改动前先补各自的对照测试。

## 落地状态（2026-10-28，DH-309 复审收口）

- **`tool-dsh-store` 已进 dafeiyu**：模型面改为 capability `store`（contract v2，默认启用）。工具经 organizer 按 agent 接线，`capabilities.store.enabled=false` 只关模型面，`remote.dshStore` 与存储 atom 不受影响；组合测试改为断言 agent 作用域工具 + 首次变更建根。
- **`store-atom` 不再进 Agent 生命周期**：删除 `agent/pre-step` 初始化。`createFile`/`writeFile`/`createFolder` 在写路径按需 `prepare`，首个变更才创建根；读路径保持 `rootFor`，不会为一个查询建目录。
- **明确不收拢的三处（always-on 边界）**：
  1. `agent-instructions-plus`：贡献是 `agent/pre-step` 上有序的 baseline/inbox 改写，v2 贡献只能表达 tools / promptSections / onAgentCreated / onTurnEnd，无法表达这条 waterfall；指令装配是每个 agent 的基础设施，关掉等于删基线。
  2. `jira-agent` 的 write guard、`/jira` 与三个技能：安全与人工面。guard 是台账不变量，`/jira`/技能是人工管理入口；如果跟 capability 开关绑定，关掉模型面会同时关掉 guard。
  3. `personality` 的 `/personality` 与提案 Remote：人工管理面与用户数据面；开关只停 prompt section、学习工具与 auto-learn，`/personality` 的 revert 仍是一次显式人工操作。
- **测试修正**：`agent-instructions-plus` 的组合测试改判“preset 不挂分支插件行”，允许 `uitstalie-` 溯源注释（DH-311 的标记块），不再把标记字符串当成分支挂载。
- **仍延期**：`systemEnvironment` 迁移（sandbox 诊断、home-backup、store-atom 的路径判断）仍是行为保持改造，另行跟踪。
