---
description: "宿主侧能力组织者：为能力提供者维护注册表、运行态启用门、能力列表元数据、完成 turn 分发、失败隔离与只读状态 Remote。"
kind: "package-reference"
---

# @deepseek-ai/dsh-dafeiyu

[English](README.md) | 中文

## 概述

`dafeiyu` 是 memory、personality、jira 这类可选能力的宿主侧组织者。它持有能力注册表、运行态启用门、按 agent 接线、完成 turn 的分发、失败隔离、卸载，以及只读的 `remote.dafeiyu` 状态面，因此 provider 只需要声明自己贡献什么。provider 不订阅生命周期事件、不注册工具、也不自己改 system prompt；组织者在同一处完成这些步骤，对子 agent 与取消的 turn 只有一份判断。

组织者提供 `ctx.dafeiyu`，自身没有模型面。分支组合把它挂在 `web-app` 层、位于 provider 行之前，provider 用 `inject: ['dafeiyu']` 声明依赖。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>

## 使用本包

在挂载组织者的同一个 profile patch 里配置它的门：

```yaml
- id: dafeiyu
  name: '@deepseek-ai/dsh-dafeiyu'
  config:
    capabilities:
      memory: { enabled: true }
      personality: { enabled: false }
      jira: { enabled: true }
```

没有出现在 `capabilities` 里的 id 跟随 provider 自己的默认值：v2 描述符的 `enabledByDefault`，v1 provider 一律视为 `true`。这个门是组织者的运行态开关，而不是卸载包的方式：关掉 provider 的 Loader 行会让 provider 完全不存在，`status()` 把该 id 报为 `missing`；关掉组织者门则保留 provider，但销毁它的贡献，并且不再给新 agent 接线。

`capabilities` 是 volatile 配置引用：对 `capabilities.<id>.enabled` 的设置写入会替换快照并触发 Loader 的 `loader/volatile-update`，组织者因此销毁该能力或重新调用 `create()`，不重挂任何插件行。其他配置变化仍然照常重挂这一行。

v2 provider 把贡献与能力列表要渲染的元数据一起注册：

```ts
const off = ctx.dafeiyu.register({
  id: 'memory',
  contractVersion: 2,
  label: 'Memory',
  description: 'Session summaries, searchable history, and tiered forgetting',
  enabledByDefault: true,
  settings: { sectionId: 'memory', order: 180 },
  config: resolvedProviderConfig,
  async create(runtime) {
    return {
      scope: 'root',
      tools: agent => memoryTools(runtime.ctx, agent),
      promptSections: () => [MEMORY_PROMPT_SECTION],
      onTurnEnd: input => queueMemoryJob(runtime.ctx, input),
      dispose: () => releaseProviderResources(),
    }
  },
})
```

契约版本 2 要求 `label` 与 `description`，它们承载列表文案；`enabledByDefault` 与 `settings` 可选，`settings.sectionId` 指向 provider 自己的设置页。v1 描述符继续可用，只是没有 UI 元数据，能力列表只显示它的 id 与状态。

`register()` 拒绝重复 id、非 `1` 或 `2` 的 `contractVersion`、以及缺少 label 或 description 的 v2 描述符，错误信息都包含能力 id。服务有两个方法：`register(provider)` 返回撤销该注册及其贡献的 disposer；`status()` 为每个已注册 provider 返回一条 `CapabilityStatus`，随后列出配置里出现但没有 provider 的 id。`status()` 是同步快照，不会重新执行 `create()`，也不读文件系统。

浏览器通过只读的 Remote 命名空间读取同一份快照：

```ts
const statuses = await ctx.remote.dafeiyu.status()
```

| 门层 | 事实来源 | 关闭时 |
|---|---|---|
| Loader 行 | profile patch / 插件开关 | provider 不存在；`status()` 报 `missing` |
| 组织者门 | `config.capabilities.<id>.enabled`（volatile） | provider 存在，但贡献被销毁、新 agent 不再接线；`status()` 报 `disabled` |
| provider 配置 | provider 自己那一行 | 只由 provider 解释；组织者从不读取 |

<a id="understand-the-implementation"></a>

## 理解实现

`src/index.ts` 是 `Dafeiyu` 服务，`src/types.ts` 存放 provider、贡献、turn 与状态类型，`src/remote.ts` 是只读 Remote 面。服务为每个 provider 保留一条注册记录，内容包括 provider 声明、解析后的门、一个 `AbortController`、缓存的贡献、最近一次失败摘要、最近一次 turn 时间，以及按 agent 保存的 disposer。

注册表按注册顺序校验并保存 provider。启用状态下，`register()` 被调用后立即执行一次 `create()`；返回的 promise 尚未 settle 时该注册没有贡献，`agent/created` 会等待它，`status()` 报 `disabled`。`create()` resolve 后注册变为 `active`；reject 时记录只占一行的失败摘要并变为 `failed`，不自动重试。

收到 `loader/volatile-update` 时，组织者为每条注册重新读取门，只协调值发生变化的 id：关门会 abort 该注册的 `AbortController`、销毁贡献，并撤销它已加到 agent 上的工具与 prompt 段；开门会安装新的 controller 并重新调用 `create()`。其他能力保留自己的贡献与 agent。能力在 agent 已存在之后才启用不会追溯接线——只有此后创建的 agent 才会收到贡献。

收到 `agent/created` 时，组织者等待所有尚未 settle 的注册，然后给 scope 匹配的每个 active 能力接线。`scope: 'root'` 跳过子 agent；由于运行态 `Agent` 句柄不暴露父 agent 字段，这里通过 live agent 注册表（`ctx.agents.roots()`）判断。工具用 `agent.ctx.tools.register` 注册，prompt 段用 `agent.ctx.systemPrompt.section` 注册，disposer 全部保留；`onAgentCreated` 最后调用。接线过程中某个 provider 失败时，只回滚该能力给这个 agent 添加的内容并把该能力标记为 failed，不影响其他能力。

收到 `session/event` 中 `reason.kind === 'completed'` 的 `turn/end` 时，组织者用 `ctx.agents.get(session.id)` 取得 live agent，套用同样的 scope 过滤，并在同一 session 内串行调用各 `onTurnEnd`；不同 session 并行分发。取消、报错、blocked、max-token、interrupted 与 forked 的 turn 一律跳过。每个钩子失败都会被捕获、摘要并记为 `failed`，后续能力照常执行。

卸载时先 dispose 各贡献，再执行保留的 agent 级 disposer，最后清空注册表。调用单个 `register()` 的 disposer 也走同一套卸载流程；两者都先 abort 注册的 `AbortController`，让在途的 `create()` 与钩子工作可以停止。

Remote 面与服务同行走在 `remote.dafeiyu` 命名空间下，只发布一个方法（`status`）且从不写入：门是组织者自己的 profile 配置，经 `dafeiyu` 行的设置命名空间写入，而不是经过这个面。

<a id="model-experience"></a>

## 模型体验

### 没有模型面

#### 模型看到什么

没有直接内容。组织者不注册工具、prompt 段、context source 或会话消息；只有 provider 通过 `tools` 或 `promptSections` 提供贡献时才出现，且这些文本与 schema 归 provider 所有。

#### Token 影响

直接 Token 影响为零。接上的能力只增加它自己 provider 声明的内容；组织者不添加任何包装文本、schema 或消息。

#### KV 缓存影响

自身没有影响。贡献稳定 prompt 段或工具 schema 的 provider 自己负责由此产生的前缀行为，组织者从不改写已有贡献。

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与延期工作

- **本包不含设置页** — 浏览器里的能力列表在它自己的 client 包里，按 v2 provider 的 `settings.sectionId` 跳转；本包只提供它背后的只读状态。
- **启用不追溯接线** — 关闭会立刻从 agent 上撤销能力，但启用只影响此后创建的 agent。
- **settle 中的注册报 `disabled`** — 四态状态契约没有 pending 值，`create()` 的 promise 尚未 settle 时注册报 `enabled: true` 与 `state: 'disabled'`，直到变为 `active` 或 `failed`。
- **`missing` 的 id 不知道 provider 默认值** — 配置里出现但没有 provider 的 id 按配置里的门值报出并标为 `state: 'missing'`；没有描述符可以询问 `enabledByDefault`。
- **同名冲突落到后注册的能力** — 两个能力注册同一个工具名或 prompt 段名时组织者不做仲裁；后注册的抛错并变为 `failed`，先注册的保留。
- **dispose 按契约是同步的** — `CapabilityContribution.dispose` 返回 `void`；provider 若返回 promise，其拒绝只会被记录，没有调用方等待它。

<a id="dev-note"></a>

### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

本开发备注是非权威的工作上下文：尚未决定的问题与方向。已发布行为与已确认的理由在上文各节与包内代码里。

- **settle 中的注册是否需要独立状态值** — 当前四态契约在 `create()` 未 settle 时报 `disabled`；增加 `pending` 会改变 wire 可见状态，需要先有消费者。

</details>
