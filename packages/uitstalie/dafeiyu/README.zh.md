---
description: "宿主侧能力组织者：为能力提供者维护注册表、启用门、按 agent 接线、完成 turn 分发、失败隔离与卸载。"
kind: "package-reference"
---

# @deepseek-ai/dsh-dafeiyu

[English](README.md) | 中文

## 概述

`dafeiyu` 是 memory、personality 这类可选能力的宿主侧组织者。它持有能力注册表、启用门、按 agent 接线、完成 turn 的分发、失败隔离与卸载，因此 provider 只需要声明自己贡献什么。provider 不订阅生命周期事件、不注册工具、也不自己改 system prompt；组织者在同一处完成这些步骤，对子 agent 与取消的 turn 只有一份判断。

组织者提供 `ctx.dafeiyu`，自身没有模型面。在 v1 组合里它由 `web-app` 分支层挂在 provider 行之前，provider 用 `inject: ['dafeiyu']` 声明依赖。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

## 使用本包

在挂载组织者的同一个 profile patch 里配置它的门：

```yaml
- id: dafeiyu
  name: '@deepseek-ai/dsh-dafeiyu'
  config:
    capabilities:
      memory: { enabled: true }
      personality: { enabled: false }
```

没有出现在 `capabilities` 里的 id 视为启用。这个门是组织者的运行态开关，而不是卸载包的方式：关掉 provider 的 Loader 行会让 provider 完全不存在，`status()` 把该 id 报为 `missing`；关掉组织者门则保留 provider，但从不调用它的 `create()`。骨架在 provider 注册时读取这个门，因此改门后需要下一次 profile 启动才生效。

provider 在自己的 `apply()` 里注册，并把返回的 disposer 作为 effect 保留：

```ts
const off = ctx.dafeiyu.register({
  id: 'memory',
  contractVersion: 1,
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

`register()` 拒绝重复 id 和非 `1` 的 `contractVersion`，错误信息包含能力 id。服务只有两个方法：`register(provider)` 返回撤销该注册及其贡献的 disposer；`status()` 为每个已注册 provider 返回一条 `CapabilityStatus`，随后列出配置里出现但没有 provider 的 id。`status()` 是同步快照，不会重新执行 `create()`，也不读文件系统。

| 门层 | 事实来源 | 关闭时 |
|---|---|---|
| Loader 行 | profile patch / 插件开关 | provider 不存在；`status()` 报 `missing` |
| 组织者门 | `config.capabilities.<id>.enabled` | provider 存在，但不调用 `create()`，能力保持 `disabled` |
| provider 配置 | provider 自己那一行 | 只由 provider 解释；组织者从不读取 |

## 理解实现

`src/index.ts` 是 `Dafeiyu` 服务；`src/types.ts` 存放 provider、贡献、turn 与状态类型。服务为每个 provider 保留一条注册记录，内容包括 provider 声明、解析后的门、一个 `AbortController`、缓存的贡献、最近一次失败摘要，以及按 agent 保存的 disposer。

注册表按注册顺序校验并保存 provider。启用状态下，`register()` 被调用后立即执行一次 `create()`；返回的 promise 尚未 settle 时该注册没有贡献，`agent/created` 会等待它，`status()` 报 `disabled`。`create()` resolve 后注册变为 `active`；reject 时记录只占一行的失败摘要并变为 `failed`，不自动重试。

收到 `agent/created` 时，组织者等待所有尚未 settle 的注册，然后给 scope 匹配的每个 active 能力接线。`scope: 'root'` 跳过子 agent；由于运行态 `Agent` 句柄不暴露父 agent 字段，这里通过 live agent 注册表（`ctx.agents.roots()`）判断。工具用 `agent.ctx.tools.register` 注册，prompt 段用 `agent.ctx.systemPrompt.section` 注册，disposer 全部保留；`onAgentCreated` 最后调用。接线过程中某个 provider 失败时，只回滚该能力给这个 agent 添加的内容并把该能力标记为 failed，不影响其他能力。

收到 `session/event` 中 `reason.kind === 'completed'` 的 `turn/end` 时，组织者用 `ctx.agents.get(session.id)` 取得 live agent，套用同样的 scope 过滤，并在同一 session 内串行调用各 `onTurnEnd`；不同 session 并行分发。取消、报错、blocked、max-token、interrupted 与 forked 的 turn 一律跳过。每个钩子失败都会被捕获、摘要并记为 `failed`，后续能力照常执行。

卸载时先 dispose 各贡献，再执行保留的 agent 级 disposer，最后清空注册表。调用单个 `register()` 的 disposer 也走同一套卸载流程；两者都先 abort 注册的 `AbortController`，让在途的 `create()` 与钩子工作可以停止。

## 模型体验

### v1 没有模型面

#### 模型看到什么

没有直接内容。组织者不注册工具、prompt 段、context source 或会话消息；只有 provider 通过 `tools` 或 `promptSections` 提供贡献时才出现，且这些文本与 schema 归 provider 所有。

#### Token 影响

直接 Token 影响为零。接上的能力只增加它自己 provider 声明的内容；组织者不添加任何包装文本、schema 或消息。

#### KV 缓存影响

自身没有影响。贡献稳定 prompt 段或工具 schema 的 provider 自己负责由此产生的前缀行为，组织者从不改写已有贡献。

## 已知限制与延期工作

- **没有设置面或命令** — v1 只提供 `status()`；配置写在 profile patch 里，`/capabilities` 等到设置页一起做。
- **暂不处理配置重载** — 骨架没有 `app-boot/config-reload` 监听，修改 `capabilities` 需要重启 profile；设计里的 dispose 后重建留到设置步骤。
- **settle 中的注册报 `disabled`** — 四态状态契约没有 pending 值，`create()` 的 promise 尚未 settle 时注册报 `enabled: true` 与 `state: 'disabled'`，直到变为 `active` 或 `failed`。
- **不追溯接线** — 组织者只监听 `agent/created`；能力注册时已经存在的 agent 不会收到它的贡献。
- **同名冲突落到后注册的能力** — 两个能力注册同一个工具名或 prompt 段名时组织者不做仲裁；后注册的抛错并变为 `failed`，先注册的保留。
- **dispose 按契约是同步的** — `CapabilityContribution.dispose` 返回 `void`；provider 若返回 promise，其拒绝只会被记录，没有调用方等待它。

### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

本开发备注是非权威的工作上下文：尚未决定的问题与方向。已发布行为与已确认的理由在上文各节与包内代码里。

- **settle 中的注册是否需要独立状态值** — 当前四态契约在 `create()` 未 settle 时报 `disabled`；增加 `pending` 会改变 wire 可见状态，需要先有消费者。

</details>
