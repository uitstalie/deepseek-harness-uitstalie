# rules：工作区规则与交付前自检（设计）

本文件定义 rules 的语义、可用的 hook 点、自检的两种模式、规则文件规格与复用面，服务于 [task15](mission/task15.md)。任务单只登记需求与范围，设计细节在这里。

## 语义：约定，不是强制

rules 是**工作区级的约定**，本质上就是**目录形式的扩展 AGENTS.md**：把"做这个项目时要遵守什么"写进上下文。必须先把保证边界说清楚：

- **能保证的是投递，不是遵从。** 注入机制能保证每个适用的规则文件都按优先级进了上下文，且预算与去重是确定的——这与 AGENTS.md 今天得到的保证完全相同；它**不能**保证模型运行时按规则行动。任何"必须执行"的措辞都只是给模型的强指令，不是门禁。
- **因此 rules 的第一性是注入（约定）**，不是自检。自检属于"少数可机检规则"的附加层。
- 唯一"硬"的一点：对可机检的少数规则（typecheck / lint / test 这类），宿主侧能在 turn 结束前真的把命令跑掉并强制再做一步。对主观规则没有对应机制，只有提醒。

所以 rules 分成两层，**默认只启用第一层**：

1. **约定层（默认）**：常驻或按 glob 注入规则内容，语义与 AGENTS.md 的注入契约一致（优先级、预算、去重、变更通知）。
2. **机检层（可选，逐条声明）**：对声明了 `check` 的规则，交付前由宿主执行验证命令，未通过则强制再做一步。它既不是"每条规则的自检"，也不是必须项。

## 业界定义（2026/09 查询）

以 Cursor 的 rules 文档为基准（最完整的一份），其余工具收敛到同一套形状：

- **位置**：工作区隐藏目录 + 用户级全局目录。Cursor 是 `.cursor/rules/*.mdc`（项目级、随版本控制）+ 用户级 Rules；Cline 识别 `.clinerules/`、`.cline/rules/`，并兼容 `.cursorrules`、`.windsurfrules`、`AGENTS.md`（[Cline rules](https://docs.cline.bot/customization/cline-rules)）。
- **单元**：markdown，**且带 front-matter 才算 rules**。Cursor 明说：`.cursor/rules` 下的纯 `.md` 没有 frontmatter，会被 rules 系统忽略；"如果你偏好纯 markdown，就用 AGENTS.md"（[Cursor rules](https://cursor.com/docs/rules)）。
- **元数据与四种激活模式**（Cursor 原文表）：`alwaysApply: true` → 每个会话都注入；`alwaysApply: false` + `globs` → 上下文里出现匹配文件时自动附着；`alwaysApply: false` + `description` → 模型按描述自己决定是否拉入；两者都缺 → 只能手动 `@` 引用。
- **语义**：原文是 "persistent, reusable context at the prompt level"，被应用时 "rule contents are included at the start of the model context"。注意它的措辞是"给模型一致的指导"，**不是保证执行**——与上面的判断一致。
- **生态收敛**：Cline 直接把 `AGENTS.md` 列为可识别规则源并称其为跨工具标准格式（[AGENTS.md 标准](https://agents.md/)）。也就是说 "rules 目录" 与 "AGENTS.md" 是同一件事的两种载体：前者带元数据、可条件激活，后者是纯 Markdown 常驻。

### 我们要沿用的与要改的

| 维度 | 业界 | 我们 | 理由 |
|---|---|---|---|
| 元数据 | `description` / `globs` / `alwaysApply` 决定四种激活模式 | **不用元数据**：`rules/**` 全量常驻、纯 Markdown 逐字注入 | 规则是"每次交互过程的规范"，条件激活对本用途没有价值；去掉元数据后加载器退化成"发现 + 去重 + 预算" |
| 扩展名 | `.mdc`（Cursor）/ `.md`（Cline） | **`.md`** | 与 AGENTS.md 同源，内容逐字注入 |
| 位置 | 工作区 + 用户级 | `.dsh/rules/**`（二期可加 `~/.dsh/rules/**`） | 与既有 `.dsh/skills`、`~/.dsh/AGENTS.md` 层级一致 |
| 与 AGENTS.md | Cursor 称 AGENTS.md 为"简单替代" | **同一条链的补充**（用户已定） | AGENTS.md 管仓库知识，rules 管交互过程规范 |

## 可用的 hook 点（均已实测）

| 用途 | 事件 | 语义 | 证据 |
|---|---|---|---|
| **常驻注入规则（主体）** | `agent/pre-step` | waterfall，监听器返回 `PreStepDecision.messages` 即注入上下文；`agent-instructions`、`tool-skill`、`repeat-tool-reminder` 都挂在这里 | [core.md:337](../docs/subsystems/core.md:337)；[agent-instructions/src/index.ts:315](../packages/context/agent-instructions/src/index.ts:315) |
| 机检层（可选） | `agent/turn-stopping` | **serial、被 await、没有 `next()`**；hook 全部返回后 loop **重新检查** `inbox.nextStep`，非空就不结束、直接跑下一步 | [agent-loop/src/agent.ts:359](../packages/core/agent-loop/src/agent.ts:359)；[architecture.md:155](../docs/architecture.md:155)；[core.md:1029](../docs/subsystems/core.md:1029) |
| 由机检层**强制续跑** | `Agent.steer(userMessage)` | 把消息排进 next-step 队列，效果就是"拦住交还" | [agent-loop/src/agent.ts:167](../packages/core/agent-loop/src/agent.ts:167) |
| 约束工具动作（可选） | `tools/pre-execute` / `tools/post-execute` | waterfall；pre 可 `{ kind: 'deny', reason }`，也可 `{ kind: 'accept', additionalContexts }`；post 可替换结果并附加上下文 | [core/tools/src/index.ts:153](../packages/core/tools/src/index.ts:153)、[:176](../packages/core/tools/src/index.ts:176)、[:609](../packages/core/tools/src/index.ts:609) |
| 约束模型请求（可选） | `agent/request` | waterfall over the LLM call | [architecture.md:109](../docs/architecture.md:109) |
| 生命周期 | `agent/created` / `agent/disposed` / `agent/status` / `subagent/start` / `subagent/end` | 挂载与观测 | [event-producer-consumer.md:24](../docs/event-producer-consumer.md:24) |

### 关键语义澄清

- `agent/turn-stopping` **不是否决权**：它不能取消 `turn/end`。唯一的"拦住"手段是把消息排进 next-step（`agent.steer`），loop 看到队列非空就继续跑。这正是"自检未过 → 再做一步"需要的语义。
- 触发条件：turn 没有待执行工具、且 next-step 队列为空时才触发；**用户中止（abort）的 turn 不会走到这里**，所以自检不会在取消路径上乱跑。
- **没有内建的自续跑上限**。本仓库自己在桥接里留了 `TODO(stop-loop-guard): cap consecutive forced continuations; hooks must self-limit meanwhile`（[hooks-claude-code/src/index.ts:275](../packages/hooks/hooks-claude-code/src/index.ts:275)）。所以 rules 插件**必须自限**连续强制续跑次数，否则自检不过就会死循环。

### 现成先例（可直接照抄形状）

- `hooks-claude-code` 的 blocking `Stop` hook = `agent/turn-stopping` + `agent.steer`，注释写明"makes the machine observe pending input and run another step"（[index.ts:276](../packages/hooks/hooks-claude-code/src/index.ts:276)）；`hooks-codex` 同（[:266](../packages/hooks/hooks-codex/src/index.ts:266)）。
- `workspace-changes` 在同一个边界做交付前的变更快照（[src/index.ts:153](../packages/deliverables/workspace-changes/src/index.ts:153)）——证明"交付前做宿主侧工作"是被认可的模式。
- `dsh-hook-protocol` + hooks.json 是现成的"配置 → 监听器"协议层。

## 机检层的两种模式（可选启用）

| 模式 | 做什么 | 适用 | 失败时 |
|---|---|---|---|
| `command`（硬） | 宿主在 turn-stopping 跑规则声明的命令（经 `ctx.shell`，受沙盒与权限策略约束），只在失败时 steer，把失败输出尾部作为上下文 | 客观门禁（typecheck / lint / test / 自定义脚本） | 强制再做一步；这是整套机制里唯一"模型绕不过去"的部分 |
| `model`（软） | turn-stopping 时 steer 一条 `<system-reminder>` 检查清单，请模型逐条核对 | 主观规则（"交付前说明跑了哪些验证"） | 只是**再提醒一次**，不构成保证——本质上仍属约定层 |

两种模式共用**连续强制续跑上限**（配置项，建议默认 2）：达到上限后不再 steer，改为在结果里标注"机检未通过且已达续跑上限"，把决定权交回用户——避免死循环，也让失败可见。

因为机检层默认关闭，README 与任务单都要明确：**开启 `check` 的规则才付费**（时间成本与安全面），其余规则永远只是约定。

## 规则文件规格（`.dsh/rules/**/*.md`）——已定：纯 Markdown，无激活元数据

用户已定：**不用 front-matter 控制激活，`rules/**` 下的每个 `.md` 默认全部注入**。

- **格式**：纯 Markdown，与 AGENTS.md 完全同源；内容**逐字注入**（写了 front-matter 也只当正文文本，不解析）。
- **激活**：全量常驻。不做 `alwaysApply` / `globs` / 模型自选，也不做"目录编码作用域"——目录层级只用于组织与排序（宽 → 具体）。
- **去重**：加载器按"trim 后内容"去重，**在整个 rules 集合内**生效（同一份规则写进两个文件时只留排序靠前的那份），作者不必手工比对。
- **预算**：独立 `maxBytes`（与 AGENTS.md 的那份互不挤占），沿用同一策略：先丢更宽的整文件、再截断最具体的文件、并输出预算通知。
- **变更**：沿用 AGENTS.md 的 `Updated instructions from:` / `Instructions removed:` 通知语义。
- **写作纪律**（写进 README 与 `tool-dsh-store` 工具描述，因为机器只能兜底）：规则要写成短句、祈使句；不重复已存在的规则（重复会被静默去重，等于白写）；一条规则只讲一件事。
- **写入侧兜底**：`tool-dsh-store` 在写 `rules/**` 时比对新内容与现有规则的 trim 后内容，命中重复就返回提示（让"去重"这条纪律在写入时就被提醒，而不是等注入时静默消失）。

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

1. ~~与 AGENTS.md 的关系~~ **已定**：同一条链的**补充**；rules 的本质是"**每次交互过程的规范**"（用户原话）。
2. ~~激活语义~~ **已定**：`rules/**` 全量常驻、无激活元数据、纯 Markdown 逐字注入。
3. ~~作用域表达~~ **已定**：不用 `globs`、不用目录编码作用域；目录层级只用于组织与排序。
4. **注入形态（唯一待定）**：
   - **推荐：原生小改**——给 `agent-instructions` 加一个 `instructionDirs` 配置（例 `['.dsh/rules']`）：每层祖先目录除了现成的候选文件名，再多走一遍这些目录里的 `*.md`。去掉元数据之后这个扩展只是"多发现一类文件"，而收益是**整套 baseline 身份、去重、预算、变更/移除通知、会话日志可重建全部复用**；自建加载器必须重写那套状态机（`state.ts` 未导出，几百行 + 测试）。代价是规则加载从此与 upstream 那个包耦合，冲突面限于新增行。
   - 备选：自建 `rules` 插件输出独立一块（零原生改动），但要重写状态机，且模型看到两块指令。
5. **预算**：随第 4 条一起定——走原生扩展就与 AGENTS.md 共用一份 `maxBytes`（可调大）；走备选则 rules 独立一份（倾向 16 KiB）。
6. **层级**：本期只做工作区级；用户级 `~/.dsh/rules/**` 留二期。
7. **机检层**：是否整体移到独立任务单（倾向**是**——它面向"可机检门禁"，与约定语义是两件事）。
8. **触发方式**：会话首次注入 baseline + 之后靠变更通知（与 AGENTS.md 完全一致），不做每轮重复注入。
