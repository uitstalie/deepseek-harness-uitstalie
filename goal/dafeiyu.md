# dafeiyu：能力组织者（设计）

状态：设计草案（jira `DH-7`），2026/10/21 第三轮。与 [memory.md](memory.md)、[personality.md](personality.md) 同批；这两份文档里的“provider 只提供能力、接线在组织者”在本文件落成可实现的契约。第三轮拍板包名、v1 配置面、注入预算与失败通知。2026/10/23 起按三层架构扩展：见 [capability-layers.md](capability-layers.md)。

## 一句话

`dafeiyu` 是 host 侧的组织者：它持有能力注册表、启用门、贡献接线、agent/turn 生命周期分发与失败隔离；`memory` / `personality` 只是向它注册的能力提供者，自己不订阅事件、不注册工具、不改 system prompt。

## 三层架构定位（2026/10/23）

在三层架构里，dafeiyu 只做 **UI 总代 + 全局 enable/disable**：能力注册表、状态、开关、设置入口聚合；具体配置仍由各 provider 自己的设置页拥有；底层读写与复用由 atom（例如 `.dsh` scoped store）承担。完整定义见 [capability-layers.md](capability-layers.md)。本文的契约（register/status/贡献/生命周期）是该架构的 L2/L3 接口，后续按 descriptor v2 增加 UI 元数据（label、description、settings.sectionId），不接管 provider 的配置 schema。

## 为什么需要组织者

provider 自己挂载也能跑通，但会立刻产生四个重复点：

1. **接线权分散**：每个 provider 都要知道往哪个 seam 挂（工具、system prompt、context source），改一次接线要改 N 个包。
2. **生命周期重复**：`turn/end`、`agent/created` 的订阅与去重会出现 N 份；两处实现迟早对“取消的 turn 算不算”“子 agent 给不给”给出不同答案。
3. **开关与状态分裂**：设置面无法回答“memory 现在到底生效没有、失败原因是什么”，每个 provider 各说各话。
4. **失败放大**：一个 provider 在 `agent/created` 里抛错，可能连带另一个 provider 的注册一起失败。

组织者把上述四点收成一处，provider 只回答“我提供什么”。

## 组合位置

- 新包 `packages/uitstalie/dafeiyu`（包名 `@deepseek-ai/dsh-dafeiyu`），host 侧，挂在 `packages/bundle/web-app/cordis.patch.uitstalie.yml` 的分支层，行顺序在 provider 之前。
- provider 行（`dsh-memory`、`dsh-personality`）由同一层挂载，`inject: ['dafeiyu', ...]`；Cordis 的注入等待保证组织者先就绪，不需要手工排 Loader 行序。这条依赖是硬依赖：组织者行缺失时 provider 行会停在 inactive，组合层必须成对出现。
- 只挂 `web-app` 分支层：与 memory/personality 的作用面一致；CLI/headless 组合没有 preset 平面，见 [limitations.md](limitations.md) 第 8 条。组织者本身不阻止未来在别的组合里挂载，但那需要那条组合也有 agent preset 层。

## 契约

provider 在 `apply()` 里注册一个描述对象；组织者在能力启用时调用一次 `create()`，拿到本次接线的贡献。

```ts
/** 组织者提供、provider 注入的注册表。 */
interface CapabilityRegistry {
  register(provider: CapabilityProvider): () => void
  status(): readonly CapabilityStatus[]
}

interface CapabilityProvider {
  /** 稳定能力名，例如 'memory'、'personality'。 */
  readonly id: string
  /** 契约版本；不匹配时组织者拒绝注册并报错。 */
  readonly contractVersion: 1
  /** provider 自己解析好的配置；组织者不解释其中字段。 */
  readonly config: unknown
  /** 只在启用时调用；返回本次接线的贡献。允许异步（例如 provider 启动时要预读文件）。 */
  create(runtime: CapabilityRuntime): CapabilityContribution | Promise<CapabilityContribution>
}

interface CapabilityRuntime {
  /** 组织者所在 profile 级 context。 */
  readonly ctx: Context
  /** disable / 配置重载时中止在途接线。 */
  readonly signal: AbortSignal
}

interface CapabilityContribution {
  /** 该能力对哪些 agent 生效；'root' 跳过子 agent。默认 'all'。 */
  readonly scope?: 'root' | 'all'
  tools?(agent: Agent): readonly ToolDefinition[]
  promptSections?(agent: Agent): readonly PromptSection[]
  /** 组织者把 agent/created 转发给它，供无法用上面两项表达的资源使用。 */
  onAgentCreated?(agent: Agent): void
  /** 每个成功完成的 turn 一次；组织者负责过滤、串行与隔离。 */
  onTurnEnd?(input: TurnEndInput): Promise<void> | void
  /** disable / 重载时调用一次；抛错只记录，不阻断其他能力。 */
  dispose?(): void
}

interface TurnEndInput {
  readonly agent: Agent
  readonly session: Session
  readonly turn: number
  readonly event: SessionEvent<'turn/end'>
  readonly signal: AbortSignal
}
```

四条硬规则：

- **provider 不订阅事件**：`session/event`、`agent/created` 只由组织者订阅；provider 只实现上面这些方法。这样做的好处是“跳过取消的 turn”“子 agent 给不给”这类判断只有一份。
- **贡献按 agent 注册**：组织者在 `agent/created` 里调用 `tools(agent)` / `promptSections(agent)`，并通过 `agent.ctx` 注册。注册随 agent 释放，天然不会泄漏到别的 agent；也不需要在全局注册后用 `restrict()` 反选。
- **一个能力一份贡献**：`create()` 每次启用只调用一次；配置变化 = `dispose()` 旧贡献 + 重新 `create()`。禁止同一能力注册两份。`create()` 返回 Promise 时，组织者等它 settle 后才把能力标为 `active` 并开始按 agent 接线；`agent/created` 监听器因此是异步的（Cordis 的串行监听会等它）。
- **失败隔离**：`create()`、`tools()`、`promptSections()`、每个 `onTurnEnd()` 都单独 try/catch。失败记入 `status()` 与日志，能力标记为 `failed`，其他能力照常；不自动重试，等配置变化或显式刷新。

## 启用门与优先级

能力是否生效按三层判定，优先级从高到低：

| 层 | 事实来源 | 关掉时 |
|---|---|---|
| Loader 行 | `cordis.patch.uitstalie.yml` / profile 开关 | provider 不存在；`status` 报 `missing`，不报错 |
| 组织者门 | dafeiyu 的 `config.capabilities.<id>.enabled` | provider 仍在，但组织者不 `create()`；现存 agent 的贡献在配置变化时撤销 |
| provider 配置 | provider 自己那一行的 `config` | 由 provider 自己解释（窗口、模型对等）；组织者不读 |

这意味着 profile 的插件行开关仍是组合层的真相，组织者的门只是运行时的能力开关；两者同时存在时以“更外层关闭”为准。README 与设置面必须把这一点写清楚，避免用户以为组织者开关能卸载包。

组织者配置：

```yaml
- id: dafeiyu
  name: '@deepseek-ai/dsh-dafeiyu'
  config:
    capabilities:
      memory: { enabled: true }
      personality: { enabled: true }
```

未在 `capabilities` 里出现的能力按 `enabled: true` 处理；未知 id 保留并给一条 warning（provider 先于组织者发版时仍然可组合），不拒绝启动。反过来，配置里出现、但没有任何 provider 注册的 id 在 `status()` 里报 `missing`；这也是 Loader 行被关掉时唯一能看见“能力本该在这里”的证据。

## 生命周期

- **`agent/created`**：对每个启用能力，按 `scope` 决定是否给这个 agent 接线；`scope: 'root'` 且 `agent.parentAgent !== undefined` 时跳过。注册用 `agent.ctx`，组织者只保留 disposer 以便 disable 时撤销。
- **`session/event`**：只处理 `turn/end`，且只处理 `reason.kind === 'completed'`。`aborted` / `error` / `blocked` / `max-tokens` / `interrupted` 都跳过——这是 [memory.md](memory.md) 的触发语义，也应是所有能力钩子的默认语义。`scope: 'root'` 的能力在子 agent 的 `turn/end` 上也不派发。
- **agent 查找**：`session/event` 给的是 `Session`，组织者用 `ctx.agents.get(session.id)` 取 live agent；取不到（agent 已释放）就跳过本次分发。
- **串行**：同一 session 的 `onTurnEnd` 串行调用，避免两个钩子同时改同一个 surface 区间；不同 session 之间并行。组织者不限制 provider 启动的后台 job 并发；那是 provider 自己的配置（memory 用每 session 一个 job + 工作区写锁）。
- **插件卸载**：先 `dispose()` 每个能力贡献，再调用保留的 disposer 撤销 agent 级注册（`agent.ctx` 的注册不会因为组织者卸载而自动消失，必须显式撤销），最后清空注册表。

钩子本身必须快速返回：需要 LLM 或长文件操作的工作由 provider 起 `ctx.jobs` 后台 job，钩子只负责判定与入队。

## 状态与观测

```ts
interface CapabilityStatus {
  readonly id: string
  /** provider 是否已注册。 */
  readonly present: boolean
  /** 组织者门是否打开。 */
  readonly enabled: boolean
  readonly state: 'active' | 'disabled' | 'missing' | 'failed'
  /** 最近一次失败的错误链摘要，仅状态面与日志可见。 */
  readonly failure?: string
  readonly lastTurnAt?: number
}
```

- `status()` 是纯同步快照，不读磁盘、不重新 `create()`。
- 失败只进日志与状态面，不自动写进会话。要不要让模型知道“记忆这次没写成”由 provider 自己决定（memory 会在第一次失败时 append 一条 `notice`，见 [memory.md](memory.md)）。
- 组织者不提供模型工具，也不注册 system prompt 段。

## 不做什么

- 不做 provider 的安装、版本解析与卸载——那是 Loader 与 plugin manager 的职责。
- 不做跨 provider 的统一配置表单：每个 provider 的 schema 仍归自己那一行。
- 不做能力之间的仲裁（memory 与 personality 的合并路径由它们自己的设计决定）。
- 不定义注入预算的全局分配：v1 由各 provider 自己守上限，组织者只负责把贡献接上去。

## 测试

| 用例 | 断言 |
|---|---|
| 注册与注销 | `register()` 的 disposer 撤销后 `status()` 不再列出；重复 id 拒绝 |
| 契约版本 | `contractVersion: 2` 被拒绝，错误信息含能力 id |
| 子 agent | `scope: 'root'` 时子 agent 上没有工具与 prompt 段；`all` 时有 |
| 启用门 | `enabled: false` 不调用 `create()`；配置变化后现存 agent 的贡献被撤销并重建 |
| 失败隔离 | A 的 `create()` 抛错不影响 B；A 的状态为 `failed`，B 为 `active` |
| turn 过滤 | `aborted` / `error` 的 `turn/end` 不触发 `onTurnEnd`；`completed` 触发一次 |
| 串行 | 同一 session 两个连续 `turn/end` 不重叠执行 |
| 卸载 | 插件卸载后 agent 级注册全部撤销，无残留工具 |
| 组合 | web-app 分支层含 dafeiyu 与两个 provider 行；CLI/headless 不含 |

## 拍板结果（2026/10/21）

| 问题 | 决定 |
|---|---|
| 包名 | `@deepseek-ai/dsh-dafeiyu`，目录 `packages/uitstalie/dafeiyu` |
| v1 配置面 | 只通过 profile 的 `cordis.patch.yml`（`capabilities.<id>.enabled` + 各 provider 自己的行）；设置页后续 |
| 注入总预算 | v1 各 provider 自守（memory 4 KiB、personality 2 KiB），组织者不统一核算；等两份能力落地后有实测再评估 |
| 失败通知 | 留给 provider（memory append notice；personality 只记状态）；组织者只维护 `status()` 与日志，不统一写会话 |
| 契约版本 | 整数 `contractVersion: 1`，精确匹配；未来破坏性变更升 2，不匹配的 provider 拒绝注册并在 `status()` 报 `failed` |
| 配置重载 | 收到 `app-boot/config-reload` 后对全部能力 `dispose()` + 重新 `create()`（不做按能力 diff） |
| 状态命令 | v1 不加 `/capabilities`，只提供 `status()`；等设置页一起做可视状态 |

## 未决

v1 没有未决项；以下留到后续版本：设置页面板与运行态开关、多设备/多进程下的能力状态同步、`contractVersion` 升 2 的迁移说明。

## 变更记录

- 第一轮（2026/10/20）：草案，契约、生命周期、启用门、状态与测试。
- 第二轮（2026/10/20）：与 memory/personality 对齐，补组合位置与失败隔离。
- 第三轮（2026/10/21）：拍板包名、v1 配置面、注入预算与失败通知。
