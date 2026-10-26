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

## jira 迁移（下一个大任务）

目标：把现有 jira 插件按三层拆分，并接入 dafeiyu 列表；数据与工具行为保持兼容。

1. **atom `jira-ledger`**：读/写现有 `$DSH_HOME/jira` git 台账（issue、KB、comments、counters、machines、派生工件），提供 issue/KB 的 CRUD 与检索；不直接暴露工具。
2. **atom `jira-cloud`**：多设备同步（push/pull、冲突合并、待推送队列）；与 `jira-ledger` 共享 store 根与版本守卫。
3. **provider `jira`**：把 ledger/cloud 组装成模型可见能力（`jira_issue`、`jira_kb` 等工具、KB 注入策略），拥有自己的设置页（项目映射、同步开关、状态）。
4. **dafeiyu 列表**：出现 “Jira” 行，开关 + 打开 Jira 设置。
5. **兼容期**：旧 jira 插件行保留为 shim，内部改为调用 `jira-ledger`/`jira-cloud`；dafeiyu 检测到同一 id 的旧/新注册时只认 provider，冲突记 warning。
6. **数据兼容**：台账路径不变（`$DSH_HOME/jira`）；版本守卫与现有 git 提交行为一致；迁移不重写历史。

## 迁移顺序

1. 本文 + `dafeiyu.md` 定稿（契约 v2、atom 接口、配置归属）。
2. atom：`.dsh` scoped store 抽包，`tool-dsh-store` 改消费者；memory/personality 改用 atom（行为不变，测试保持绿）。
3. provider 描述符 v2 + `dsh-client-ui-dafeiyu` 设置段（先接 memory/personality）。
4. jira：`jira-ledger` → `jira-cloud` → `jira` provider → 设置页 → shim。
5. 清理：旧路径/重复配置、升级说明、README 与 goal 文档同步。

## 风险与未决

1. `global` scope 与 `workspace` scope 的权限语义不同（global 写不依赖会话），需要 provider 明确传 session 并承担审计。
2. atom 抽包会产生一次跨包接口变更（`ctx.dshStore` 的 scope 参数），需一次性改完 memory/personality/tool-dsh-store，避免双接口并存。
3. provider 设置页的 sectionId 命名与 order 需要注册约定，否则 dafeiyu 的“打开设置”链接会漂移。
4. jira 的 git 台账写入与 atom 版本守卫如何共存（git commit 不是文件系统版本）需要在迁移设计里单独定。
5. 旧 jira 插件 shim 的退出条件与时间点。

## 落地状态（2026-10-26，DH-12）

- **目录落点改为 `packages/uitstalie/store-atom/`**：仓库的包门禁（`verify-package-meta`、`verify-package-dependencies`、`package-graph`、`gen-tsconfig-paths` 等）只枚举 `packages/*/*`，`atoms/<name>/` 会落在所有包级检查的盲区；包名仍是 `@deepseek-ai/dsh-store-atom`。后续 atom 沿用这个两层目录约定。
- 首个 atom 已抽出：`tool-dsh-store` 不再提供 `ctx.dshStore`，改为 `inject: ['dshStore']` 后消费；memory/personality 的 workspace 读写随之走 atom（行为不变，160 个相关测试通过）。
- **`global` scope 未实现**：personality 的 `globalPath` 允许指向 `$DSH_HOME` 之外（见 [personality.md](personality.md) 的存储决定），与“global 根 = `$DSH_HOME`”冲突；在拍板这条契约前，personality 的全局档案继续走 `ctx.fs`，atom 只承载 workspace scope。
- 接口暂未加 `scope` 参数：先完成抽包、保持 `DshStore` 形状不变，避免一次跨包接口变更与抽包同时发生（对应上面的风险 2）；`scope` 与 `global` 一起作为下一步。
