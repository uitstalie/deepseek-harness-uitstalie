# rules：工作区规则与交付前自检（设计）

本文件定义 rules 的语义、可用的 hook 点、自检的两种模式、规则文件规格与复用面，服务于 [task15](mission/task15.md)。任务单只登记需求与范围，设计细节在这里。

## 语义

rules 是**工作区级**的强制约定：在执行本工作区的项目时，必须遵守的规则（做什么、不做什么）与必须执行的动作（验证命令、交付前检查）。核心诉求是**每个 turn 交还给用户之前做一次自检**——没做到就不算交付。

因此 rules 需要两件事，缺一不可：
1. **常驻注入**：规则内容进入上下文，模型在干活时就看得见；
2. **交付前自检**：turn 结束前自动执行检查，未通过则强制再做一步。

## 可用的 hook 点（均已实测）

| 用途 | 事件 | 语义 | 证据 |
|---|---|---|---|
| 常驻注入规则 | `agent/pre-step` | waterfall，监听器返回 `PreStepDecision.messages` 即注入上下文；`agent-instructions`、`tool-skill`、`repeat-tool-reminder` 都挂在这里 | [core.md:337](../docs/subsystems/core.md:337)；[agent-instructions/src/index.ts:315](../packages/context/agent-instructions/src/index.ts:315) |
| **交付前自检（核心）** | `agent/turn-stopping` | **serial、被 await、没有 `next()`**；hook 全部返回后 loop **重新检查** `inbox.nextStep`，非空就不结束、直接跑下一步 | [agent-loop/src/agent.ts:359](../packages/core/agent-loop/src/agent.ts:359)；[architecture.md:155](../docs/architecture.md:155)；[core.md:1029](../docs/subsystems/core.md:1029) |
| 由自检**强制续跑** | `Agent.steer(userMessage)` | 把消息排进 next-step 队列，效果就是"拦住交还" | [agent-loop/src/agent.ts:167](../packages/core/agent-loop/src/agent.ts:167) |
| 约束工具动作 | `tools/pre-execute` / `tools/post-execute` | waterfall；pre 可 `{ kind: 'deny', reason }`，也可 `{ kind: 'accept', additionalContexts }`；post 可替换结果并附加上下文 | [core/tools/src/index.ts:153](../packages/core/tools/src/index.ts:153)、[:176](../packages/core/tools/src/index.ts:176)、[:609](../packages/core/tools/src/index.ts:609) |
| 约束模型请求 | `agent/request` | waterfall over the LLM call | [architecture.md:109](../docs/architecture.md:109) |
| 生命周期 | `agent/created` / `agent/disposed` / `agent/status` / `subagent/start` / `subagent/end` | 挂载与观测 | [event-producer-consumer.md:24](../docs/event-producer-consumer.md:24) |

### 关键语义澄清

- `agent/turn-stopping` **不是否决权**：它不能取消 `turn/end`。唯一的"拦住"手段是把消息排进 next-step（`agent.steer`），loop 看到队列非空就继续跑。这正是"自检未过 → 再做一步"需要的语义。
- 触发条件：turn 没有待执行工具、且 next-step 队列为空时才触发；**用户中止（abort）的 turn 不会走到这里**，所以自检不会在取消路径上乱跑。
- **没有内建的自续跑上限**。本仓库自己在桥接里留了 `TODO(stop-loop-guard): cap consecutive forced continuations; hooks must self-limit meanwhile`（[hooks-claude-code/src/index.ts:275](../packages/hooks/hooks-claude-code/src/index.ts:275)）。所以 rules 插件**必须自限**连续强制续跑次数，否则自检不过就会死循环。

### 现成先例（可直接照抄形状）

- `hooks-claude-code` 的 blocking `Stop` hook = `agent/turn-stopping` + `agent.steer`，注释写明"makes the machine observe pending input and run another step"（[index.ts:276](../packages/hooks/hooks-claude-code/src/index.ts:276)）；`hooks-codex` 同（[:266](../packages/hooks/hooks-codex/src/index.ts:266)）。
- `workspace-changes` 在同一个边界做交付前的变更快照（[src/index.ts:153](../packages/deliverables/workspace-changes/src/index.ts:153)）——证明"交付前做宿主侧工作"是被认可的模式。
- `dsh-hook-protocol` + hooks.json 是现成的"配置 → 监听器"协议层。

## 自检的两种模式

| 模式 | 做什么 | 适用 | 失败时 |
|---|---|---|---|
| `model` | turn-stopping 时 `steer` 一条 `<system-reminder>` 自检清单，要求模型逐条核对 | 主观规则（"交付前必须说明跑了哪些验证"） | 强制再做一步，让模型回答/改正 |
| `command` | 跑规则声明的命令（经 `ctx.shell`，受沙盒与权限策略约束），只在失败时 steer，把失败输出尾部作为上下文 | 客观门禁（typecheck / lint / test / 自定义脚本） | 同上，且失败证据直接进上下文 |

两种模式共用一个**连续强制续跑上限**（配置项，建议默认 2）：达到上限后不再 steer，改为在结果里标注"自检未通过且已达续跑上限"，把决定权交回用户——避免死循环，也让失败可见。

## 规则文件规格（`.dsh/rules/**/*.md`）

```yaml
---
description: 一行摘要，进注入头部与目录
alwaysApply: true          # 默认 true：每轮常驻；false 时按 globs 触发
globs: ["packages/**"]     # 可选；只在会话触碰这些路径后注入
check:                     # 可选：交付前自检
  mode: command            # command | model
  command: pnpm run typecheck
  timeoutMs: 120000
  message: 交付前必须让 typecheck 通过
---
正文：规则与必须执行的动作
```

- 目录形式、多文件、可 glob 作用域——这是相对单文件 `AGENTS.md` 的主要收益，也是必须新写加载器（`agent-instructions` 的候选只支持同目录文件名）的原因。
- 规则文件本身经 `dsh` 工具写入（那个工具负责 front-matter 与 YAML 校验），保证 `.dsh/` 内容始终可被消费。

## 复用面（尽量不新造）

| 需要 | 复用 |
|---|---|
| 注入渲染（`<system-reminder>` 框架、预算、去重、转义） | `renderAgentInstructions` @ `@deepseek-ai/dsh-agent-instructions` |
| 注入生命周期（baseline 身份、变更/移除通知、digest 缓存） | 照 `agent-instructions` 的 pre-step + `createUserMessage` + `MessageSourceMap` 声明合并（其 `state.ts` 未导出，需重写这一层） |
| 强制续跑 | `Agent.steer`，不要自己碰 inbox |
| 命令执行（含沙盒与策略） | `ctx.shell` |
| 变更信号（规则文件被改/被删） | `.dsh/` store 的 `fs/observed` 与文件触达 |
| 规则文件写入与校验 | task14 的 `dsh` 工具 |
| 项目根/用户级路径 | `findProjectRoot` 语义与 `@deepseek-ai/dsh-home-paths` |
| 配置 → 设置表单 | 导出 schemastery `Config` |

## 待定（需拍板）

1. **自检的默认开关**：规则自带 `check` 才跑（推荐），还是工作区级总开关 + 每条规则可关？
2. **常驻策略默认值**：全部常驻（简单、token 高）还是默认按 `globs` 触发（省 token，依赖 fs 触达信号）？
3. **连续强制续跑上限**默认值（我建议 2），以及达到上限后的呈现（模型可见提示 + 交付可见标注）。
4. **是否也约束工具动作**：用 `tools/pre-execute` 做"必须动作"的拒绝（例如禁止直接编辑 `.dsh/`、或要求先跑某命令），还是本期只做注入 + 交付自检？
5. **命令模式的执行面**：只允许规则里声明的命令（安全），还是允许任意 shell（灵活但危险，且受沙盒限制）。
6. **是否复用 hooks.json 协议**：让 rules 复用 `dsh-hook-protocol` 的配置形状，还是自成一套（我倾向自成一套，语义更贴 rules，但可以让用户级/项目级两层沿用同一发现规则）。
