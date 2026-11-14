# personality 风格范围与长期风格库评估（2026-11-14）

[English](personality-style-scope-20261114.md) | 中文

状态：**仅评估；本轮未修改任何代码、额度或 section。**

本文回答三个产品方向：按 agent 类型门控、长期风格库，以及 section 690 与 section 702 之间的边界。它还记录了版本冲突决定：#5 remains description-only。

## A. 长期风格库的额度

### 当前限额

`WRITING_RULES_MAX_RULES = 32`、`WRITING_RULES_MAX_TEXT_CHARS = 240` 与 `WRITING_RULES_MAX_TEXT_BYTES = 4096`（`packages/uitstalie/personality/src/writing-rules.ts:27-33`）。在当前的单条规则长度下，英文文本会先触及字节上限，再触及条数上限：4 KiB 大约能容纳 17 条规则。因此当前的库是一个硬规则列表，而不是长期风格库。

### Token 成本估算

假设每条已启用的规则渲染为一行常驻文本，约 240 字符，而分词器对一个 242 字符的样本计数为 44 tokens。token 数随语言和措辞而变化；该表是估算，不是对当前用户数据的测量。

| 规则条数 | 规则字符数 | 约合 tokens | 占 128k 上下文的比例 |
|---:|---:|---:|---:|
| 10 | 2,400 | 440 | 0.34% |
| 30 | 7,200 | 1,320 | 1.01% |
| 100 | 24,000 | 4,400 | 3.36% |
| 300 | 72,000 | 13,200 | 10.08% |

300 条规则的情形会在对话开始前消耗约十分之一个 128k 上下文。因此，无上限的常驻累积不是好的长期设计。

### 两条路线

1. **全量常驻 + 提高额度。** 简单：每次请求都注入所有已启用规则。代价正好是表中所示的线性增长。在 100 条左右（每条 240 字符时约占 128k 的 3.4%）可以接受，到 300 条则不可取。
2. **分层：小的常驻核心 + 按需检索。** 让精挑的核心常驻（例如 20 条规则，约 880 tokens，0.69%），其余规则通过显式的检索工具可查。代价是引入一个检索面：模型可能漏掉某条规则，检索会增加一次工具调用和延迟，并且库需要稳定的 id/tag。

**建议：分层。** 把硬性存储上限设为 **100 条规则 / 每条 240 字符 / 总计 32 KiB**，但默认只常驻约 **20 条规则** 的核心，其余按需检索。32 KiB 的字节上限仍然约束多语言内容；100 条中文规则可能先触及字节上限，而不是条数上限。对小库来说，全量常驻仍是有效的简单模式；不建议常驻 300 条规则。

## B. 按 agent 类型门控

### 当前行为

Section 690 注册给 **所有** agent：该 capability 声明 `scope: 'all'`，且 `promptSections` 返回同样的三个 section，不带 agent 类型过滤（`packages/uitstalie/personality/src/index.ts:116-154`）。dispatch 标志只改变渲染出的 `Dispatch voice` 一行，并不对该 section 做门控（`index.ts:112`、`output-style.ts:145-164`）。

`isRootAgent` 是当前唯一的分类（`index.ts:231-235`）：它要求 `origin !== 'subagent'`、没有 `parentSession`，且 `delegationDepth === 0`。这能把被委派的 subagent 与 root 区分开，但**不能区分普通 root 与 super agent**；两者都满足它。super agent 是 cwd 为所配置 super 工作区的 root Session（`packages/jira/jira-agent/src/index.ts:174-186`），其工作区标题为 `Super agent`（`superagent.ts:100`）。personality 本身收不到任何 super agent 角色标志；目前 `AgentHeader.origin` 只被类型化为 `'subagent'`（`packages/core/agent/src/index.ts:82-85`），而不是 super/ordinary 角色。

**当前普通/super 的差异：一行。** 两者使用同一份 `OUTPUT_STYLE.yaml` 和同一个 `renderOutputStyleSection`；super agent 会得到 `- Dispatch voice: terse.`，而普通 agent 没有 dispatch 行。`Hard boundary:` 与 `Status reporting discipline:` 目前**两者**都会收到；下面的产品决策改变的正是这个差异。

### 决定更新（2026-11-14）：两个独立槽位

- 普通风格与 super 风格**可以从一开始就不同**；不要为了让两者相同而压住任一个槽位。super 槽位负责派发/汇报纪律；普通槽位保持干净。
- 两个槽位有各自独立的来源、默认值与写入路径。super 文件缺失时不得回退到普通文件（反之亦然）；目前只有一个文件和一个 section 实现。
- 两个槽位仍使用位于 690 的 section 名/顺序 `personality:output-style`，按 agent 选择。只有两段文本必须占据不同位置时才需要单独的 order；独立内容并不要求这一点。
- subagent 完全收不到 output-style 槽位。section 100 与 695 不属于本决定。

### subagent 工具：禁用，不提供只读变体

当前的注册已经对 subagent 排除了两条写入路径：`tools: agent => isRootAgent(agent) ? [analyzeTool, applyTool, rulesTool] : [analyzeTool]`（`index.ts:119-121`）。因此 subagent 只看到 `personality_analyze`，不存在只读的 `write_like_human` 或 `personality_apply` 变体。这在模型可见层已经满足了“ban the tools”决定。

若实施有变，可选方案：

| 选项 | 代价 | 效果 |
|---|---|---|
| 仅注册过滤（当前） | 一个谓词；已实现 | 工具不出现在 subagent 的 schema 中，因而无法调用；运行时零分支。 |
| 仅运行时拒绝 | 保持工具可见，在 `execute` 中拒绝 | 不节省上下文，且模型体验更差；还会把写入工具暴露给模型。不推荐。 |
| 两者都做 | 过滤加 `execute` 内的 root/角色检查 | 对直接服务调用做纵深防御；增加代码/测试，无上下文成本。仅当绕过注册表的直接调用构成真实边界时才推荐。 |

不要增加只读变体。为 subagent 节省的上下文是它收不到的两个工具定义：它们的 description 合计 **765 字符 ≈ 158 tokens**（240 + 525 字符；同一样本上 43 + 115 tokens）。参数 schema 还会增加更多；确切的节省量是整份定义，而不只是 description。当前过滤器已经带来这一节省。

### 建议的形态

- subagent：完全省略 section 690；保留现有的工具禁用。section 100 与 695 保持不变，除非另有决定认为 subagent 完全不需要 profile/writing rules。
- 普通 root：一个干净的 output-style 槽位。
- super agent root：一个独立的 output-style 槽位，包含派发/汇报纪律。
- 不要从 cwd、工作区标题、是否出现 `superagent_control` 或 preset 名推断角色。这些都是可变/附属信息，会让 personality 依赖 jira 内部实现。应在创建 Session 的地方加入显式的 agent 角色信号，或暴露一个两个 capability 都能查询的小型角色服务。这是设计前提，不是可以藏在路径比较里的实现细节。

低改动的结构是：把 section 名/顺序 `personality:output-style` 保持在 690，并在 `sectionsFor` 内按角色选择来源：subagent → 不产出 section；普通 → `OUTPUT_STYLE.yaml`；super → 第二个存储，例如 `SUPERAGENT_OUTPUT_STYLE.yaml`。这样不新增 section 编号就能得到两个槽位。如果两段文本在组装后的提示词中必须处于不同位置，替代方案是单独的 order（例如 691），但这会改变 order 映射和所有顺序断言。

### 未来的内容差异

两个槽位预计会立即分化。super 槽位从 dispatch 行和状态汇报纪律开始；普通槽位从干净状态开始。当二者进一步分化时，只有来源选择、各存储的 seed/默认值以及角色信号会变化。section 名与 order 可以保持 690；subagent 省略和工具禁用各仍是一个分支。渲染、section 顺序、角色选择以及提示词来源内容的测试必须覆盖两个来源；提示词参考文档必须同时展示两者。

## C. Section 702 的边界

当前 702 的文本有 31 行（`packages/jira/jira-agent/src/superagent.ts:116-199`）。下表按各 slot/契约行的实际角色分组。这里的“Output style”指的是关于 super agent 自己如何向人汇报或推理的规则，而不是关于被派发 worker 必须产出什么的规则。

| 702 行号 / 前 20 个字符 | 分类 | 迁移影响 |
|---|---|---|
| L1 `You are the super ag` | 派发/角色 | 保留 702；移动它会改变该 section 所描述的对象。 |
| L3 `The [superagent works` | 派发/上下文 | 保留 702；依赖运行时工作区上下文。 |
| L4 `` `superagent_control` `` | 派发/安全 | 保留 702；action 顺序与写入警告。 |
| L5 `A workspace brief has` | 派发 | 保留 702；brief 来源规则。 |
| L7 `Brief slots (fill ev` | 派发模板 | 保留 702；移动它会拆散 brief 契约。 |
| L13 `Result contract:` | 派发契约 | 保留 702；它描述被派发任务的输出，而不是 super agent 的行文。 |
| L14 `First line: status:` | 派发契约 | 保留 702；与 result contract 耦合。 |
| L15 `Last line: artifacts` | 派发契约 | 保留 702；与 result contract 耦合。 |
| L16 `No report or no arti` | 安全/派发 | 保留 702；“not done”是正确性规则。 |
| L17 `Do not use interacti` | 安全 | 保留 702；工具策略约束。 |
| L18 `Do not require memor` | 安全 | 保留 702；ACL/系统约束。 |
| L19 `Make dimension-by-di` | **Output style** | super 风格槽位的候选；`superagent-brief.test.ts` 与提示词参考断言了它。移动它会改变哪个 section 承载验收措辞，而不改变行为。 |
| L21 `One brief carries one` | 派发 | 保留 702；范围控制。 |
| L22 `Policies and organiz` | 安全 | 保留 702；由人拥有的策略边界。 |
| L23 `Route deliberately, n` | 派发 | 保留 702；Session 路由。 |
| L24 `While a Session runs` | 派发 | 保留 702；投递/中断语义。 |
| L25 `A [superagent monito` | 派发/安全 | 保留 702；monitor/stop/abort 语义。 |
| L26 `Reports are evidence:` | **Output style** | super 风格槽位的候选；它管辖 super agent 如何转述报告。提示词参考记录了它；`superagent-brief.test.ts` 并未断言这句。 |
| L27 `Ask before you decide` | 安全 | 保留 702；审批边界。 |
| L28 `Use subagent only for` | 派发 | 保留 702；委派策略。 |
| L29 `When a file must be h` | 派发 | 保留 702；交接工作流。 |
| L30 `Use superagent_permis` | 安全 | 保留 702；权限语义。 |

### 合并还是保持分开

**建议：702 大体保持分开；只把两条 output-style 规则（L19 与 L26）抽到 super agent 风格槽位。** 702 是 dispatcher 的角色/brief/安全契约；其中大部分不是风格库。被抽出的两条规则关于 super agent 如何总结和比较，因此属于 super 风格；抽取之后，702 应指向风格 section，而不是重复措辞。不要把 result contract、monitor 语义、权限或工作区角色并入风格库。

这是一次**部分合并**：仅 super 使用的风格槽位负责行文/汇报纪律，而 702 保留派发工作流、角色与安全。普通风格库不得接收仅属 super 的纪律。

## D. 工具结果与错误信息的本地化

### 需要本地化的字符串

| 来源 | 字符串 | 说明 |
|---|---|---|
| `analyze.ts:164-174` | `Scanned …`、候选项行、`warning:` | 模型可见的结果文本；evidence 的 id/seq 必须保持稳定。 |
| `apply.ts:96-100` | `Applied …`、被拒绝的行 | 模型可见的结果；`applied`/`rejected` 键保持英文。 |
| `writing-tool.ts:169-178` | `write_like_human failed…`、成功行、规则行、`Injected text:` | 模型可见的结果；`ok`、`action`、`rules` 键保持英文。 |
| `analyze.ts:143,181,188,222` | 会话读取警告、identity、`maxCandidates`、`recent.limit` | 错误/降级文案。 |
| `apply.ts:68,70,77` | 确认提示、候选项计数、evidence | 错误文案；稳定字段/id 不变。 |
| `writing-rules.ts:122,256,259,339` | 规则条数/文本/字节数 | 错误文案。 |
| `global-store.ts:378,395,405,408,413,450` | identity、空/空白文本、字符/正文上限 | 错误文案；`kind`/`code` 保持稳定。 |

现有的 `.i18n.yaml` 加 `verify-translation-pairing` 机制**只用于文档翻译**，不提供运行时字符串。`packages/core/tools/src/contracts.ts:379` 中的 `displayReason` 是一种本地化的 UI/ask 形态，不是通用的工具结果本地化服务。目前 `AgentHeader` 中没有服务端会话 locale。

### 语言的来源

- **推荐：显式的 personality 语言设置**（全局 personality 配置或 Session 元数据），在创建 Session/agent 时选定一次。稳定、可测试，且与 UI 外壳无关。
- 仅用全局配置：简单，但即使一个人切换对话语言，所有 Session 也共享同一种语言。
- 从最新用户消息检测：没有稳定来源，会在轮次中途变化，且难以测试；不推荐作为主要机制。
- 不要复用浏览器/UI 的 locale：它属于客户端关注点，服务端工具执行路径拿不到。

### 模型可见的后果

这些字符串是工具的**返回值**，不是 UI 文案。模型会读取渲染后的文本，并倾向于沿用该语言，因此即使 system prompt 是英文，中文结果也可能把回答引向中文。只本地化行文；机器稳定的键、id、code 与状态 token 保持英文（`ok`、`action`、`applied`/`rejected`、`error.code`、dispatch `status: done|blocked|failed|unverified`、`task_id`、`artifacts`、`checks`）。JSON 字段应保持语言中立；只有 render/message 文本应当变化。除非显式选定某个 locale，测试必须断言结构与 token，而不是精确的本地化文案。

## E. 实施后的影响

| 方面 | 文件 / 测试 / 文档 | 重建/重启 |
|---|---|---|
| 额度 | `writing-rules.ts` 常量；`writing-rules.spec` 与提示词参考中的计数 | 代码变更：是 |
| 分层检索 | 新的检索工具/服务、提示词词汇、工具测试；文档与提示词参考 | 代码变更：是 |
| 按 agent 类型门控 | `personality/src/index.ts`（`sectionsFor`、`loadBundle`）、`output-style.ts`/`defaults.ts`、Session 元数据或角色服务中的角色信号；`provider.spec`、`output-style.spec`、section 顺序测试 | 代码变更：是 |
| 两个风格槽位 | 第二个全局存储的路径/seed；`index.ts` 的来源选择；角色选择测试；README 与提示词参考 | 代码变更：是 |
| 702 抽取 | `superagent.ts` 文本；`superagent-brief.test.ts`；提示词参考与设计 §6 | 代码变更：是 |
| 本地化 | `analyze.ts`、`apply.ts`、`writing-tool.ts`、`writing-rules.ts`、`global-store.ts`；新的 locale 来源；结果/错误测试；提示词参考 | 代码变更：是 |
| 仅文档 | design/prompt 文档；无运行时影响 | 否 |

所有代码或提示词变更都需要重建并重启运行中的 harness。仅文档变更不需要。

## 非目标与待定决策

- 本轮不修改额度、不拆分 section、不新增角色字段、不新增检索，也不移动 702 文本。
- 普通与 super 槽位相互独立，且可以从一开始就不同；不计划为 subagent 提供只读的 `personality_apply`/`write_like_human` 变体。
- super agent 角色信号是明确的前提；基于 cwd/标题/工具是否存在的启发式被否决。
- The version-conflict item remains description-only: writes retry once internally and the model is told to `list` before a second attempt (`0d3fcb3ef0`).
- 仍需产品决策：本地化结果语言的运行时来源；subagent 是否保留 profile 100 与 writing rules 695；始终在线的核心集合是 20 还是其他数字；两个槽位是否需要不同的提示词 order。
