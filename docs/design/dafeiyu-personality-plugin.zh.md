# dafeiyu personality 插件设计（2026-11-13）

[English](dafeiyu-personality-plugin.md) | 中文

状态：设计稿，未实现，未改动任何包。

输入材料保留在 `docs/inputs/` 供追溯；本设计只采用其中的方向性纠正、表达习惯与 A–E 根因，不把业务事实纠正写进 personality。关键约束已内联到第 2.1 节，另一台机器实现时不依赖输入文件。

## 结论

四个模块不都做成同一个插件。**user-input 复用现有 `dsh-personality` 能力；super-agent-dispatch 是 super agent preset 里的一个 section + 文案模板；write-like-human 是一个独立 skill + 词表数据文件；output-summary 是 personality 配置行里的一组 persona 维度 + 一个稳定的系统提示词 section。** 这样每个模块只拥有一种事实，不另造并行存储，也不会把“怎么说”和“怎么做”混进同一个条目。

**先解决三个现有冲突，再谈实现：**

1. 现有 `preference.*` 在 `workspaceOverlay: true` 时写到工作区 overlay，但 A–E 是跨工作区的用户偏好。需要给 `personality_learn` 增加可选 `scope`，否则只能二选一：关掉 overlay，或给每个工作区重复写同一组偏好。
2. 现有 turn-end 自动学习只匹配很窄的句式（“不是这个意思”“以后……”），13 次纠正里大多数（“你管那些干啥”“谁说只改三处”“先列出来”）不会命中。主路径必须改成模型在纠正发生时显式调用 `personality_learn`，正则只做兜底。
3. 现有 skill 解析器只把顶层 `name`、`description`、`whenToUse` 和 `metadata` 对象暴露给注册表；顶层 `version`、`kind` 不会进入 skill 元数据。write-like-human 的 `version`/`kind` 必须先放在 `metadata` 下，或者在实现阶段扩展解析器；本设计采用前者，并把后者列为缺口。

## 1. 现有实现与必须对齐的事实

| 事实 | 当前证据 | 对本设计的影响 |
|---|---|---|
| personality 是 dafeiyu 能力，`scope: 'all'` | `packages/uitstalie/personality/src/index.ts` | 新 section 默认对所有 agent 生效；super agent 专属内容不能走它，必须走 super agent preset |
| 一个固定 section，order `100` | `packages/uitstalie/personality/src/prompt.ts` | 用户输入理解放在所有工具说明之前；修改会从 100 起使前缀缓存失效 |
| 四种 kind：`understanding/style/preference/identity` | `packages/uitstalie/personality/src/personality-file.ts` | 复用，不新增 kind；A–E 放 `preference`，表达习惯放 `understanding` |
| overlay 只允许 `style/preference` | `packages/uitstalie/personality/src/personality-file.ts` | `preference` 的写入位置受 overlay 开关影响，这是跨工作区偏好的缺口 |
| `personality_learn` 非 identity 可自动写；identity 只能提议 | `packages/uitstalie/personality/src/tools.ts` | 身份类继续人工确认；本设计不碰这条红线 |
| 自动学习在 turn-end 用窄正则 | `packages/uitstalie/personality/src/index.ts` | 只能当兜底；主路径要由模型在纠正现场学习 |
| 自动条目名是 `auto-<8hex>` 精确哈希 | `packages/uitstalie/personality/src/tools.ts` | 原文相同会覆盖，同一件事换个说法会重复；需要可选稳定名 |
| superagent section 是静态 section `702` | `packages/jira/jira-agent/src/superagent.ts` | brief 规则属于这里；新模板只能补充，不能覆盖“不许发明标准” |
| superagent 运行时上下文是 `704-706` | `packages/jira/jira-agent/src/superagent.ts` | 数据易变的内容才放 runtime context；模板是静态的，应放 section |
| dafeiyu contribution 只有 `promptSections`/`tools`/`onTurnEnd` | `packages/uitstalie/dafeiyu/src/types.ts` | 没有“只给 super agent 的 runtime context”这种能力；super agent 专属段落必须在它的 preset 里注册 |
| system prompt 的固定顺序 | `packages/core/system-prompt/src/index.ts` | 见第 4 节顺序表；persona 放在 `690`，superagent 之后不再加运行时规则 |
| skill 目录只接受 `name`/`description` 等固定字段 | `packages/skill/skill-filesystem/src/index.ts` | `version`/`kind` 放 `metadata`，不要假设顶层字段生效 |
| skill catalog 是 durable user message | `packages/skill/tool-skill/src/index.ts` | skill 不常驻 system prompt；加载才把正文放进历史，缓存影响小 |

## 2. 模块总览与依赖

| 模块 | 形态 | 拥有的事实 | 不拥有 |
|---|---|---|---|
| user-input | 现有 `dsh-personality` 插件的数据模型 + 工具扩展 | 用户怎么表达、怎么理解其省略/反问/角色前缀；A–E 工作偏好 | 回复语气、派活模板、输出改写词表 |
| super-agent-dispatch | super agent preset 的 section `703` + `dispatch-brief.md` 数据文件 | brief 的**形式**：目标/验收/边界/证据来源四个槽位 | brief 的内容标准、验收口径、组织判断 |
| write-like-human | skill + `references/blacklist.yaml` 数据文件 | 用户可见文本的**去 AI 化改写步骤** | 事实、代码、路径、数字、政策、阶段口径 |
| output-summary | personality 配置行的 `persona` 数据 + section `690` | 回复的默认语气/长度/结论位置/列表倾向，以及派活时的口吻 | 安全、审批、沙箱、工具权限、具体项目规则 |

依赖图：

```text
PERSONALITY.md (global) ─┐
PERSONALITY.md (overlay) ─┴─> personality section @100 ─> all agents
                                      │
persona config (personality row) ─────┴─> personality:persona @690 ─> all agents

dispatch-brief.md ──> superagent:brief-template @703 ─> super agent only
SUPERAGENT_SECTION @702 ───────────────────────────────> super agent only

write-like-human/SKILL.md ──> skill catalog ──> skill tool ─> on demand
        └── references/blacklist.yaml
```

**不新建第二个 profile 文件，也不新建数据库。** PERSONALITY.md 仍是唯一的人格条目存储；`persona` 是带 schema 的配置，不是条目；brief 模板和词表是用户拥有的普通数据文件。

### 2.1 Windows 真实失效模式对模块 2/4 的约束

输入材料的 handoff 记录的是真实运行失败，不是假设。模块 2 的模板和模块 4 的 persona 必须把这些失败当约束，否则设计会重新制造“完成但没闭环”的文本。

| 真实失效 | 对模块 2（brief）的约束 | 对模块 4（persona）的约束 |
|---|---|---|
| 子 Session 已完成，super 侧 ledger 仍 pending；报告投递失败时没有可见闭环 | 验收必须要求**工作区内的证据**（文件、命令输出、测试结果），不能只写“完成后告诉我”；交付槽位必须写产物路径 | 状态只用 `完成 / 阻塞 / 失败 / 未验证`；没有工具回执时写“结果已产出，报告投递未确认”，不得写“已报告/已闭环” |
| 同一报告以不同 task id 重复到达 | 结果必须带 `taskId` 和请求摘要；同一内容重复时标 `duplicate`，不重复计入完成 | 收到重复报告时先说“重复”，不把一份结果算两次；不把旧 taskId 当新任务 |
| `abort` 后继续 prompt 不产生新 taskId/报告 binding | 派发前确认新 `taskId`/`requestId`；继续任务不能复用旧绑定；绑定失败不发送 | 不把 abort 前的“已完成”带到新任务；新任务的状态从 `未开始` 重新写 |
| `start` 的 create → 设置 → 绑定 → prompt 中途失败会留下空 Session | brief 只在 `start` 返回 `stage=prompted` 后生成；失败要显式说停在哪个阶段 | 不说“已启动/已派发”，除非结果里有 `stage=prompted`；空 Session 不能被说成执行者 |
| monitor 是请求时提示，不是状态订阅 | 模板写明“报告是异步到达；没有报告不等于完成”；不要写“我会一直盯着” | 不说“我会监控/稍后自动汇报”；需要状态时建议 `list`/`inspect`，并说明是查询不是推送 |
| 子 Session 的 `ask_user_question` 可能取消并 abort 整轮 | 边界槽位写明：不要用交互提问；遇到需要人决定的事，停下来把**一个**问题写进最终结果/报告，不要假设实时有人回答 | 阻塞时只问一个最必要的问题；不把“等人回答”写成进行中，除非确实有 pending 交互 |
| 默认 `memory_search` 可能因 `openAt: "never"` 失败 | 证据来源不能把 `memory_search` 写成必需步骤；优先文件、命令、`memory_read`；检索失败要写“检索不可用”，不能编造 | 不声称查过记忆；区分“文件里查到”和“检索不可用” |
| Windows ACL/沙箱副作用可能让普通 `rename`/构建失败 | 边界槽位禁止修改 ACL、管理员权限、系统目录；遇到权限错误停止并原样报告，不自行提权 | 不把“需要管理员/改 ACL”作为默认建议；把平台限制作为阻塞项报告 |
| 大量 untitled Session，`append` 路由退化 | 派发前用标题/id 明确目标；untitled 只写 id，不写“那个 Session” | 路由结果写 `→ reuse <title> (<id>)` 或 `→ new <title>, reason: …`，不只说“已派给某个 Session” |



## 3. 冲突与优先级

### 3.1 必须先报的冲突

| 编号 | 冲突 | 现状 | 本设计的处理 |
|---|---|---|---|
| C1 | A–E 工作偏好是全局的，但 `preference` 写入跟随 overlay | `personalityFileTarget()` 在 overlay 开启时把 `style/preference` 写到工作区 | 给 `personality_learn` 增加可选 `scope: 'global' \| 'workspace'`；默认保持 `workspace` 兼容，user-input 的 A–E 明确传 `global`；不改文件格式 |
| C2 | 自动学习只匹配窄句式 | `CORRECTION_RULES` 只覆盖“不是这个意思/以后…”等 | 主路径改为模型调用 `personality_learn`；turn-end 正则只做兜底；不扩大成“所有用户消息都学” |
| C3 | skill 顶层 `version/kind` 不生效 | 解析器只取 `metadata` 对象 | 本设计把两者放 `metadata`；实现阶段若要顶层字段，另开解析器改动与测试 |
| C4 | personality contribution 不能只注入 super agent | `scope` 只有 `root/all`，没有 runtime context | brief 模板放在 super agent preset 的 section，不放进 personality provider |
| C5 | `style.*` 与 persona 都描述回复风格 | 现有 `style` 在 100，persona 计划在 690 | `style.*` 是具体、可覆盖的规则；persona 是默认值；冲突时具体 style 赢，且在 690 文本里写明 |
| C6 | 自动学习预算可能不够 13 次纠正 | 默认 3 条/512 B 每 session | 不擅自提高默认；先测量，必要时只把 user-input 的 A–E 学习与普通学习分桶，作为后续决策 |
| C7 | 现有 `personality_learn` 的 evidence 只接受 seq | `parseEvidenceSeq` 要求正整数 | 保留；模型从当前 turn 的 `turn/end`/事件获得 seq；不改证据契约 |
| C8 | write-like-human 是 on-demand skill，不能保证每次输出都执行 | skill catalog 只在需要时加载 | output-summary/persona 里加一句“面向人的文本先用 write-like-human”；它是提示，不是强制钩子；如果要求强制，另做输出钩子，不在本轮 |
| C9 | 报告/投递/`start` 状态没有闭环保证 | handoff 记录 completed 仍 pending、重复 taskId、abort 无新 binding、空 Session | 模块 2 的 brief 要求工作区证据与 taskId；模块 4 只允许按工具回执说状态；不修改运行时投递逻辑 |
| C10 | 子 Session 的交互提问会 abort 整轮 | handoff 记录 `ask_user_question` 取消并 abort | 模块 2 禁止 brief 要求交互提问，改为最终结果带一个阻塞问题；模块 4 只问一个必要问题 |
| C11 | 默认检索可能不可用 | `session-query` 默认可能 `openAt: "never"`，`memory_search` 失败 | 模块 2 不把 `memory_search` 设为必需证据；模块 4 区分“查到/不可用”，不编造检索结果 |

### 3.2 优先级（从高到低）

1. 平台/系统/开发者指令，沙箱、审批、工具权限。
2. 当前轮的明确用户指令（包括“这次不要列清单”这种临时覆盖）。
3. 目标工作区的 `AGENTS.md` 约定与 superagent 硬规则（`SUPERAGENT_SECTION` 702、`superagent:conventions` 705）。
4. KB 文档自身的格式/引用口径（例如 `doc_id《标题》`）；persona 只能管 KB 文本之外的语气，不能改 KB 引用格式。
5. personality 的具体条目（`understanding`、`preference`、`style`）。
6. persona 默认值（690）与 brief 模板（703）。
7. write-like-human 的改写规则：只改表达，不改事实、数字、路径、代码和结论。

persona 与模板必须带一句硬边界：“不得覆盖安全、审批、沙箱、工具权限或工作区规则；冲突时以上层规则为准。” 这句话本身是 persona section 的固定文本，不允许用户配置关闭。

## 4. 注入顺序与缓存

### 4.1 顺序表

| 顺序 | 名称 | 类型 | 范围 | 为什么在这里 |
|---:|---|---|---|---|
| -1000 | `harness:identity` | section | all | 平台身份，最前 |
| 0 | `deployment:persona-prefix` | section | all | 部署人格前缀 |
| **100** | `personality` | section（现有） | all | 用户怎么表达、怎么理解；必须在计划/工具说明之前读到 |
| 500 | `PLAN_POLICY` | section | all | 计划策略 |
| 600 | `TEAM_POLICY` | section | all | 团队策略 |
| **690** | `personality:persona` | section（新增） | all | 回复默认风格；在具体任务规则之后、superagent 之前；具体 `style.*` 在 100 已先出现，persona 只做默认 |
| **702** | `superagent:dispatcher` | section（现有） | super agent | 派活硬规则与“不许发明标准” |
| **703** | `superagent:brief-template` | section（新增） | super agent | brief 模板是 702 的执行形式；放在硬规则之后，冲突时 702 赢 |
| 704 | `superagent:workspaces` | runtime context | super agent | 注册工作区，每请求重建 |
| 705 | `superagent:conventions` | runtime context | super agent | 工作区约定，随文件变化 |
| 706 | `superagent:running` | runtime context | super agent | 长任务状态，每请求重建 |
| 1000+ | 工具 section | section | all | 工具说明 |
| — | skill catalog | durable user message | all | 首次请求前/目录变化时追加；不是 system section |

说明：

- **100 是复用现有位置**，不新开“用户输入 section”。把它挪到 650 可以减少缓存失效范围，但会改变现有 personality 与 plan/team 的相对顺序；本轮不改，作为后续性能选项。
- **690 放在 600 之后**，因为 persona 是“默认表达”，不应压过计划/团队策略；它仍在 702 之前，让 superagent 的硬规则可以覆盖它。
- **703 放在 702 之后**，因为模板是执行细节；任何模板与 702 的“只允许两个来源、不许发明标准”冲突，702 赢。703 的文本本身也重复一次“若槽位没有来源，先问人”，但这是执行提示，不改变 702 的权威。
- **skill 没有 system order**。它通过 durable catalog 出现，加载后作为工具结果进入历史；不要为了“常驻”把 skill 正文抄进 690。

### 4.2 前缀缓存影响

| 变化 | 失效范围 | 设计取舍 |
|---|---|---|
| `PERSONALITY.md` 条目变化 | 从 100 起，包含 500/600/690/702/703 | 自动学习有每 session 3 条预算；人格编辑低频，接受。若后续测量显示写入过频，再把 user-input 拆到 650，属于单独变更 |
| persona 配置变化 | 从 690 起，包含 702/703 与工具说明 | 只由人保存，低频；不要把每轮状态写进 persona |
| brief 模板变化 | 从 703 起，主要是工具说明 | 模板是部署级静态文件，变化很少 |
| skill catalog 成员/描述变化 | 追加一条 replacement catalog，不改写 system prefix | 可接受；不因每次加载 skill 重发目录 |
| 加载 write-like-human | 只在历史尾部追加工具结果，system prefix 不变 | 这是选 skill 而不是 section 的主要原因 |

硬规则：persona、brief 模板、personality section 都不得包含时间戳、seq、每轮计数、当前任务名等易变值；这些只放 runtime context 或工具结果。

## 5. 数据流

```text
用户纠正
  ├─ 模型识别到“ durable correction ”
  │    → personality_learn(kind, name?, scope?, content, evidence=seq)
  │       ├─ identity → 拒绝，转 personality_propose → 人工 accept
  │       ├─ understanding → 全局 PERSONALITY.md
  │       └─ preference/style → 按 scope 写全局或工作区
  └─ turn/end 兜底正则（仅显式措辞）
       → 同一写入路径，受同一预算与去重约束

PERSONALITY.md 写入
  → version-guarded write + history
  → watcher / agent refresh
  → personality section @100

persona 设置（人）
  → personality config row
  → section @690

dispatch-brief.md（人）
  → superagent brief section @703

write-like-human skill（模型按需）
  → 读取 blacklist.yaml
  → 改写 → 执行自查
```

## 6. user-input

### 6.1 形态

**现有 `dsh-personality` 插件内的数据模型与工具扩展**，不新建插件。理由：personality 已经有 PERSONALITY.md、版本守卫、overlay、提案队列、自动预算与 watcher；user-input 只是给这些既有机制增加分类与 scope。新建插件会复制写入、历史和缓存逻辑。

### 6.2 数据模型

复用现有条目，不新增 kind：

```markdown
## understanding.role-prefix
The user prefixes a workspace role before the instruction; the prefix names the executor, the rest is the task.

## preference.scope
Only act on the objects the user names and their direct implications; extra risk gets one line, not a new task.

## preference.authorization
Inside an explicit authorization, act without asking again; ask only when the authorization boundary changes.
```

| 内容 | kind | 默认位置 | 谁可写 |
|---|---|---|---|
| 句式、用词、语气词、角色前缀、省略/反问的解读 | `understanding.*` | 全局 | `personality_learn`（非 identity，自动预算内）；人可改 |
| A–E 工作偏好 | `preference.*` | **全局**（新增 scope） | 同上；默认 workspace 兼容旧行为 |
| 回复风格具体规则 | `style.*` | 工作区 overlay（现有） | 人；output-summary 也可通过工具写，但受 scope |
| 用户是谁 | `identity.*` | 全局 | 只能 `personality_propose` → 人 accept |

表达习惯的固定条目（`understanding.*`，只描述“怎么读”，不描述“怎么做”）：

| 观察到的习惯 | 固定条目 | 条目内容 |
|---|---|---|
| `<角色>：<指令>` 前缀 | `understanding.role-prefix` | 前缀指定执行方，后半才是任务；不要当普通句子读 |
| 省略主语/宾语 | `understanding.ellipsis` | 对象取最近上下文；先按最近候选做，必要时一行确认，不反问一串 |
| 反问表肯定 | `understanding.rhetorical-question` | “不是……嘛？”通常是结论通知，不是提问；按结论行动 |
| 中英混用/术语直呼 | `understanding.mixed-terms` | skill/MR/KB/log/app 等是通用词，不翻译、不加引号 |
| “先……再……”/“等……之后” | `understanding.sequence` | 顺序是硬约束；前一动作完成是后一动作前置，不并行 |

新增工具参数（实现时）；字段沿用现有 `PersonalityEntryKind`，不新增 kind：

```ts
type PersonalityLearnKind = Exclude<PersonalityEntryKind, 'identity'>
type PersonalityWriteScope = 'global' | 'workspace'

interface PersonalityLearnInput {
  readonly kind: PersonalityLearnKind          // required
  readonly content: string                     // required, one paragraph
  readonly evidence: string                    // required, positive seq
  readonly name?: string                       // optional, lower-kebab; omitted -> auto-<hash>
  readonly scope?: PersonalityWriteScope       // optional, default preserves current behavior
}

interface PersonalityLearnValue {              // existing result shape, unchanged
  readonly status: 'learned' | 'rejected'
  readonly message: string
  readonly entry?: string                      // <kind>.<name>
  readonly path?: string
  readonly revision?: number
}

type WorkPreferenceClass = 'A' | 'B' | 'C' | 'D' | 'E'
interface PreferenceSeed {
  readonly class: WorkPreferenceClass
  readonly name: string                        // stable id suffix, for example "scope"
  readonly text: string
}
```

- `name` 用于语义去重：A–E 使用固定名（`scope`、`authorization`、`no-invented-abstractions`、`no-overinterpretation`、`consistency-first`、`inventory-sources`），重复纠正更新同一 id，不新增条目。
- `scope` 只对 `style/preference` 有意义；`understanding` 始终全局；`identity` 不在这个工具里。
- 不改 PERSONALITY.md 格式、frontmatter、history 或 proposal 格式。现有 `PersonalityEntry` 仍是 `{ id, kind, name, text }`，没有新字段。

### 6.3 注入点

复用 `personality` section，order **100**。理由：这是“如何解读用户输入”，必须在计划与工具说明之前；现有 section 已经把 `understanding` 和 `preference` 分两部分渲染，不需要新段落。

**缓存**：100 的改动会使 100 之后的前缀失效；由于自动学习有预算且人格编辑低频，接受。**不要**把每轮临时纠正写进 section；临时指令靠当前轮对话。

### 6.4 可学习性

1. **触发**：模型在一次明确纠正后调用 `personality_learn`，`evidence` 用该纠正消息的 seq；turn-end 正则只兜底“不是这个意思/以后……”这类显式句式。
2. **分类门**：先判断是表达还是工作偏好；一个条目只能属于一类。混合内容（“以后先列清单，而且别用代号”）拆成 `preference` + `understanding` 两条，或拒绝并要求拆分。
3. **身份**：出现“我是……/我的角色是……”只能 `personality_propose`，人工接受；不得自动写。
4. **去重**：
   - 有稳定 `name` 时按 `<kind>.<name>` 覆盖；
   - 没有 `name` 时沿用 `auto-<hash>` 精确去重；
   - 模型在调用前先看 `personality` section/prompt 里已有的条目，优先更新同名条目；
   - 同一 turn 只学一条；同一 session 受 `autoLearn` 预算限制。
5. **不学**：一次性任务指令、业务事实、未实现/不可判定状态、情绪化表达、没有明确持久意图的句子。

A–E 到固定条目的映射：

| 根因 | 固定条目 | 条目要写成可执行规则 |
|---|---|---|
| A 越界 | `preference.scope`、`preference.authorization` | 只做点名对象及直接推导；授权内自决，改变边界才问 |
| B 抽象化 | `preference.no-invented-abstractions` | 不造代号/中间结构；引用用单号或 `doc_id《标题》` |
| C 简化 | `preference.no-overinterpretation` | 不把“整理”当“解读”；只写到可证明层级 |
| D 默认保守 | `preference.consistency-first` | 发现不一致时目标是消除不一致，不是保留现状 |
| E 漏对账 | `preference.inventory-sources` | 多来源任务先列已审/已改/未改对象 |

### 6.5 验收（3 条）

1. **分类**：给定 5 个 fixture（A–E 各一），`personality_learn` 分别写成对应的 `preference.<固定名>`，不产生 `understanding`/`style` 混写；再给一个“先列清单，不要动” fixture，必须写 `preference.scope` 而不是 `style`。
2. **表达**：给定“不是这个意思，我是说先列清单”，必须拆成 `understanding`（解读“不是这个意思”）+ `preference.scope`（先清单）；只写一条或写成 `style` 判失败。
3. **去重/身份**：同一 `name` 连续两次纠正只保留一个条目且文本更新；`identity` 调用返回拒绝并指向 `personality_propose`，PERSONALITY.md 不变。

### 6.6 风险

- 分类过细会让 prompt 膨胀；固定 6 个 A–E 条目 + 少量 understanding，超出走人工合并。
- 模型可能把一次性指令误判为 durable；用“明确持久意图”门与 `/personality diff` 可回滚。
- 全局 preference 与工作区 overlay 的优先级需要写清：同名 id，工作区覆盖全局；不同 id 合并。A–E 默认全局，工作区可写同名条目覆盖。

## 7. super-agent-dispatch

### 7.1 形态

**super agent preset 的 prompt section `703` + 数据文件 `$DSH_HOME/personality/dispatch-brief.md`。** 不放进 personality capability：它的 `scope` 只有 `root/all`，没有“只 super agent”；不放进 skill：brief 规则必须每次派活都在，不能靠模型记得加载。section 由 super agent 的 contribution 注册，模板由人维护。

### 7.2 数据模型

`dispatch-brief.md` 是普通 Markdown，四个固定二级标题；加载器只做结构校验，不解析语义：

```markdown
## 目标
<one objective; quote the person's words>

## 验收
<what proves it; only from the person or the destination conventions>

## 边界
<in scope / out of scope / stop conditions>

## 证据来源
<files, commands, workspace AGENTS.md#superagent:conventions, or person quote>
```

- 四个标题必须恰好各一次；缺一个或重复，加载器回退内置模板并记 warning。
- 模板本身不写任何具体标准、阶段、政策；只写槽位与填法。
- 谁可写：人（文件所有者）；模型只读。模型需要新标准时，去问人更新其原话或目标工作区约定，不能改模板。
- 存储位置：`$DSH_HOME/personality/dispatch-brief.md`；不存在时用内置默认，不创建空文件。

加载器接口：

```ts
type DispatchBriefSlotKey = 'goal' | 'acceptance' | 'boundaries' | 'evidence'

interface DispatchBriefSlot {
  readonly key: DispatchBriefSlotKey
  readonly heading: string          // exact heading text in the file
  readonly required: true
  readonly sourceRequired: true     // every filled value names a person/convention source
}

interface DispatchBriefTemplate {
  readonly version: 1
  readonly slots: readonly [
    DispatchBriefSlot, DispatchBriefSlot, DispatchBriefSlot, DispatchBriefSlot,
  ]                              // exactly four, in this order
}

interface DispatchBriefLoadResult {
  readonly template: DispatchBriefTemplate
  readonly fallback: boolean       // true when the file is absent or malformed
  readonly warning?: string        // present only for a malformed existing file
}

type BriefValueSource = 'person' | 'conventions' | 'missing'
interface BriefSlotCheck {
  readonly key: DispatchBriefSlotKey
  readonly source: BriefValueSource
  readonly reference?: string      // path, command, quote, or workspace convention anchor
}
```

`BriefSlotCheck` 是设计给测试/未来的轻量校验用的数据结构，不代表本轮新增工具；模板 section 仍以文字自查为主。

### 7.3 注入点

`superagent:brief-template`，order **703**，只在 super agent 的 preset 中注册。

理由：702 是硬规则，703 是它的执行形式；703 在 702 之后，便于模型先读“不许发明标准”，再读“四个槽位怎么填”。703 不进入 runtime context，因为它不随 turn 变化。

**缓存**：模板只在文件变化时重读，从 703 起失效；可接受。

### 7.4 模板如何约束“不许在 brief 里发明标准”

模板只给**槽位**，不给默认值；每个槽位都要求来源：

- 目标：只能是用户原话/明确任务；
- 验收：只能来自用户或目标工作区 `AGENTS.md#superagent:conventions`；
- 边界：只写用户说过的 in/out of scope 与停止条件；
- 证据来源：必须是路径、命令或约定引用；没有来源就写“待确认”，不能补一个猜测。

固定首尾行（不占四个槽位，防止 Windows 失败模式重新出现）：

```text
结果首行: status: done | blocked | failed | unverified · task_id: <only when supplied>
结果末行: artifacts: <workspace-relative paths> · checks: <commands actually run>
没有报告或没有产物时，不得写 done。
遇到需要人决定的事: 不调用交互提问，只把一个问题写进结果。
不把 memory_search 当必需步骤；不修改 ACL、管理员权限或系统目录。
```


section 文本在四个槽位之后加一个**派发前自查**（不是工具校验）：

1. 四个槽位都有来源，且没有“默认/通常/一般来说”这种自造标准；
2. 一个 brief 只有一个目标与一个验收；
3. 需要的新标准是否已问过人；
4. 目标工作区约定是否已引用 `workspace-id/AGENTS.md#superagent:conventions`。

若任一不满足，先问人，不派发。702 的“missing standard → ask”仍然优先于模板。

### 7.5 验收（3 条）

1. **结构与失败约束**：给定模板 fixture，渲染出的 section 恰好包含四个标题各一次；删除“证据来源”后加载器回退内置模板并 warning；fixed 首尾行包含 `status`、`task_id`、`没有报告或没有产物时不得写 done` 与“不调用交互提问”。
2. **范围**：super agent 的 assembly 有 `superagent:brief-template`，普通工作区 agent 没有；order 是 703；section 文本包含“两个来源”和“缺来源先问人”。
3. **反发明**：fixture brief 写了“counts only, no names”，而用户原话/约定没有这个限制；静态 prompt 的规则文本必须能匹配到“never invent a standard”，并且在模板自查项里要求“无来源不填”；测试断言 prompt 同时包含 702 的硬规则和 703 的自查项。

### 7.6 风险

- 模板文件可被人改坏；加载器回退内置模板，不能静默使用半个模板。
- 703 的文本与 702 有重复；保持“702 是规则、703 是执行清单”的分工，避免两处各写一套标准。
- 真正的强制需要工具层校验；本轮只做提示与结构校验，不新增 brief 解析器。

## 8. write-like-human

### 8.1 形态

**skill + 数据文件。** skill 是按需加载的改写流程；词表/句式黑名单放 `references/blacklist.yaml`，不堆在正文。理由：输出改写是任务级技能，不是每轮都该占 system prompt；词表需要人维护且可独立增长，正文只保留流程与自查。

建议位置：`$DSH_HOME/skills/write-like-human/SKILL.md` 与同目录 `references/blacklist.yaml`；由 `skill-filesystem` 发现，`tool-skill` 提供 catalog/loader。

### 8.2 frontmatter

当前解析器只保证 `name`、`description`、`whenToUse`、`metadata` 可用，因此：

```yaml
---
name: write-like-human
description: Rewrite user-facing prose so it reads like a person wrote it, without changing facts, code, numbers, or quoted text; load before sending a report, summary, or explanation.
metadata:
  version: 1
  kind: output-transform
  triggers:
    - user-facing report
    - summary
    - explanation
    - handoff note
---
```

- `version`/`kind` 放 `metadata` 是当前契约的兼容写法；若实现阶段要让它们成为顶层字段，必须单独改 `skill-filesystem` 解析器与测试，不能假设已生效。
- `description` 是触发面：只写“何时用”，不要写“让文字更自然”这种不可测目标。

### 8.3 触发条件

- 要发给用户的报告、总结、说明、交接便签；
- 人在对话里说“说人话/别像 AI/简化表达”；
- 不触发：代码、JSON/YAML、路径、命令、日志原文、commit message、工具结果；这些保持原样。

### 8.4 词表存放

`references/blacklist.yaml`：

```yaml
version: 1
banned_terms:
  - 赋能
  - 闭环
  - 抓手
  - 深度融合
  - 全面提升
banned_patterns:
  - label: not-x-but-y
    regex: '不是.{0,24}而是'
  - label: rule-of-three
    regex: '首先.{0,80}其次.{0,80}最后'
  - label: summary-filler
    regex: '总的来说|值得注意的是|不难看出|让我们'
  - label: em-dash
    regex: '—'
checks:
  - facts-unchanged
  - banned-scan-zero
  - max-sentence-chars
  - no-three-part-parallel
max_sentence_chars: 80
```

- skill 正文只写“读取该文件并执行 checks”，不复制词表；词表更新不需要改 skill。
- 词表由人维护；模型可以读，不得在任务中改词表（要改先问人）。
- `em-dash` 针对用户可见中文/英文正文；代码块、路径、引用原文不检查。

数据结构：

```ts
interface WriteLikeHumanMetadata {
  readonly version: 1
  readonly kind: 'output-transform'
  readonly triggers: readonly string[]     // at least one trigger
}

type RewriteCheckName =
  | 'facts-unchanged'
  | 'banned-scan-zero'
  | 'max-sentence-chars'
  | 'no-three-part-parallel'

interface BlacklistPattern {
  readonly label: string
  readonly regex: string
}

interface BlacklistV1 {
  readonly version: 1
  readonly banned_terms: readonly string[]
  readonly banned_patterns: readonly BlacklistPattern[]
  readonly checks: readonly RewriteCheckName[]  // all required checks
  readonly max_sentence_chars: number           // positive integer
}

interface RewriteCheckResult {
  readonly check: RewriteCheckName
  readonly ok: boolean
  readonly hits: readonly string[]
}
```

### 8.5 改写与自查

步骤：

1. 标出不可改内容：代码块、行内代码、数字、路径、命令、专有名词、结论。
2. 按 `banned_terms` / `banned_patterns` 替换或重写；优先删句，不要用同义套话替换。
3. 合并短句、去掉“不是……而是……”的对偶句、去掉三段式排比、去掉“总的来说”式收尾。
4. 自查（可执行）：
   - `facts-unchanged`：抽取数字/路径/行内代码，改写前后集合相等；
   - `banned-scan-zero`：对正文扫词表，命中数为 0；
   - `no-three-part-parallel`：正则/句法检查无三连排比；
   - `max-sentence-chars`：单句不超过配置值（默认 80 中文字符）；
   - 不新增原文没有的结论或承诺；业务口径由调用方的规则决定，skill 不裁定。
5. 任何一项失败，回到第 2 步；不要用“更自然”作为通过标准。

### 8.6 验收（3 条）

1. **可发现**：catalog 列出 `write-like-human`，`skill` 加载返回 frontmatter + 正文；`metadata.version=1`、`metadata.kind=output-transform`；正文不包含政策/阶段红线。
2. **词表生效**：给一段含 `不是…而是…`、`—`、`总的来说`、三段式排比的 fixture，改写后 `banned-scan-zero` 为 0，`facts-unchanged` 为 true；原始代码块/路径逐字不变。
3. **负触发**：给只有代码/JSON 的输入，skill 的触发条件判定为不适用；不改写标识符、数字和命令。

### 8.7 风险

- 过度改写会损伤技术精确性；用“不可改内容”清单与 facts 检查约束。
- 中文词表容易误伤引用原文；只扫正文，引用块/代码块排除。
- skill 是按需加载，不能保证每次输出都调用；persona 里加一句指针，但真正的强制需要输出钩子，本轮不做。

## 9. output-summary

### 9.1 形态

**personality 配置行的 `persona` 数据 + section `690`。** 不新建 store：persona 是少量、强类型、用户拥有的配置，适合放进现有 personality row 的 volatile config，与 PERSONALITY.md 的条目分开。section 由 personality provider 注册，所有 agent 都读；派活口吻作为条件句写在 section 里，只有 super agent 实际执行。

### 9.2 数据模型

```yaml
persona:
  tone: direct          # direct | dry | warm | neutral
  length: terse         # terse | normal | detailed
  leadWithConclusion: true
  lists: comparisons    # never | comparisons | steps
  dispatchVoice: terse  # terse | coaching | neutral
```

数据结构：

```ts
type PersonaTone = 'direct' | 'dry' | 'warm' | 'neutral'
type PersonaLength = 'terse' | 'normal' | 'detailed'
type PersonaListStyle = 'never' | 'comparisons' | 'steps'
type PersonaDispatchVoice = 'terse' | 'coaching' | 'neutral'

interface PersonaConfig {                 // raw config; all optional before resolution
  readonly tone?: PersonaTone
  readonly length?: PersonaLength
  readonly leadWithConclusion?: boolean
  readonly lists?: PersonaListStyle
  readonly dispatchVoice?: PersonaDispatchVoice
}

interface ResolvedPersonaConfig {         // what the section renders; all required
  readonly tone: PersonaTone
  readonly length: PersonaLength
  readonly leadWithConclusion: boolean
  readonly lists: PersonaListStyle
  readonly dispatchVoice: PersonaDispatchVoice
}

interface PersonaRenderInput {
  readonly config: ResolvedPersonaConfig
  readonly styleEntries: readonly PersonalityEntry[]  // specific rules already rendered at 100
  readonly dispatch: boolean                          // true for the super agent
}
```

| 字段 | 作用 | 谁可写 |
|---|---|---|
| `tone` | 回复的默认语气 | 人（设置页/配置） |
| `length` | 默认长度 | 人 |
| `leadWithConclusion` | 是否先给结论 | 人 |
| `lists` | 何时用列表 | 人 |
| `dispatchVoice` | 派活口吻（条件句） | 人 |

- 模型不能写 Persona 配置；只能写 `style.*` 具体条目（经 `personality_learn`，受 scope/预算）。
- 学习到的“回复要短”如果是一次性，不写；如果是 durable，写 `style.*`，不写 persona 配置。
- 配置缺省时 section 文本为空或只有硬边界句；不要让空配置产生空 section 垃圾。

### 9.3 注入点

`personality:persona`，order **690**，所有 agent。

理由：persona 是默认表达，放在计划/团队策略之后，不抢具体规则；放在 superagent 702 之前，让 702 的硬规则和 705 的约定可以压过它。具体 `style.*` 在 100 已经先出现，690 只给默认值，文本明确“具体 style 条目优先”。

**缓存**：persona 只在人保存时变化，从 690 起失效；不要每轮写。空文本的 section 应被 assembly 丢弃，不产生额外 token。

硬边界固定文本：

```text
Persona defaults never override safety, approval, sandbox, tool permission, or workspace rules. When they conflict, the rule wins.
```

### 9.4 可配置维度与渲染

section 文本只渲染**非默认/显式**的维度，避免固定噪音；默认值也写一行，保证模型知道基线。顺序固定：tone → length → conclusion → lists → dispatchVoice。`dispatchVoice` 写成条件句：

```text
When dispatching (super agent only): terse.
```

固定状态约束（不随 persona 配置关闭）：

- 只按工具回执说状态：`完成 / 阻塞 / 失败 / 未验证`；没有回执写“报告投递未确认”，不得写“已报告/已闭环”。
- 不声称“我会监控/稍后自动汇报”；monitor 是请求时查询，不是订阅。
- 未拿到 `start.stage=prompted` 时，不写“已启动/已派发”。
- 重复报告先标 `duplicate`，不把一份结果算两次；任务 id 不同但内容相同的报告，不能合并成“已完成两次”。
- 路由结果写 `→ reuse <title> (<id>)` 或 `→ new <title>, reason: …`，不写“某个 Session”。
- 需要人决定时只问一个最必要的问题；不把 `ask_user_question` 取消整轮包装成“等待中”。

### 9.5 验收（3 条）

1. **确定性**：同一配置两次 assembly 的 section 文本逐字相同；未知 enum 在配置解析时被拒绝；改 `leadWithConclusion` 只改变对应行，不改变其他行顺序。
2. **范围/顺序**：所有 agent 的 assembly 都有 `personality:persona`，order 690，且在 `superagent:dispatcher`（702）之前；workspace agent 也有回复 persona，但 `dispatchVoice` 行明确是条件句。
3. **硬边界与状态**：section 文本必须匹配“never override safety, approval, sandbox, tool permission, or workspace rules”；给一个 persona 说“always agree”的 fixture，硬边界句仍存在且不被配置覆盖；再给“报告仍 pending”的 fixture，固定状态约束必须禁止“已完成/已报告”。

### 9.6 风险

- persona 与 `style.*` 重复；用“具体 style 赢”的文本和测试固定，不新增第二个 style 来源。
- persona 配置是新的 schema/UI 面，必须与 `ui-personality` 表单一起改；本轮只设计。
- 派活口吻对所有 agent 可见，会有少量无关 token；若测量证明浪费，再拆出 super agent-only section，不先引入复杂的目标判定。

## 10. 在另一台电脑上实现的前置条件

### 10.1 代码与包

在另一台机器上 checkout `origin/cli-desktop` 后，按下面的包路径定位实现点；不要依赖本机目录或行号：

| 需要改/复用 | 包路径 | 说明 |
|---|---|---|
| personality provider、工具、文件、section 100 | `packages/uitstalie/personality` | `personality_learn` 的 `scope`/`name`、分类门、`persona` 配置、`personality:persona` section |
| 组织者接口 | `packages/uitstalie/dafeiyu` | 现有 `CapabilityContribution` 只支持 `scope: root/all` 与 `promptSections`；不要假设它能只给 super agent |
| prompt section/order | `packages/core/system-prompt` | 复用 `PromptSection`；690/703 是新增的稳定 order，不改现有固定顺序 |
| super agent 的 section 与 preset | `packages/jira/jira-agent` | 在现有 `SUPERAGENT_SECTION` 旁注册 `superagent:brief-template`（703），只在 super agent 的 contribution 中；不改 702 文本 |
| skill 注册表与目录 | `packages/skill/skill`、`packages/skill/skill-filesystem`、`packages/skill/tool-skill` | 已有 `$DSH_HOME/skills` 根与 catalog/tool；不需要新增 skill 根 |
| persona 设置 UI | `packages/uitstalie/ui-personality` | 若 persona 要可视化编辑，扩展现有字段表；不做 UI 时至少让配置可手写 |
| 数据与文件服务 | `packages/uitstalie/store-atom`、`packages/fs/fs` | PERSONALITY.md 的 version-guarded 写、`$DSH_HOME` 解析、文件监听 |

**需要改 superagent prompt 注册表吗？** 需要。`superagent:brief-template` 必须在 `packages/jira/jira-agent/src/superagent.ts` 的 super agent contribution 中注册，order 703；不能靠 personality provider 的 `scope: all` 伪装成“只给 super agent”。如果不想改 jira-agent，替代方案是做一个只挂在 super agent preset 的小 section provider，但那会增加一个插件行，不作为首选。

### 10.2 目录与数据文件

- `PERSONALITY.md`：沿用现有全局 `<DSH_HOME>/personality/PERSONALITY.md` 和工作区 `<workspace>/.dsh/memory/PERSONALITY.md`；不改 frontmatter、块标记、history/proposal 文件名。
- `dispatch-brief.md`：`<DSH_HOME>/personality/dispatch-brief.md`，不存在时用内置模板；加载器不得把它当成 PERSONALITY.md 的一部分。
- `write-like-human` skill：`<DSH_HOME>/skills/write-like-human/SKILL.md`，词表在同目录 `references/blacklist.yaml`。`skill-filesystem` 已经把 `<DSH_HOME>/skills` 作为用户根；不需要改根目录约定。
- 如果产品选择把 skill 随包发布，而不是放用户目录，则应把 skill 作为 bundle 资源安装到同一 `<DSH_HOME>/skills` 约定，或注册 runtime skill；不要在代码里硬编码仓库路径。
- persona 数据：放在 personality 配置行，不额外创建 `persona.yaml`；避免第二份存储。

### 10.3 实现顺序与验证前置

- 先让 `pnpm install`/workspace 链接完成，再改 personality config/schema 与 `personality_learn`；这两个改动会决定测试 fixture 的形态。
- `personality` 现有测试、`superagent-brief.test.ts`、skill 安装/发现测试是各自模块的前置回归；新增 section 需要同时测普通 agent 与 super agent 的 assembly。
- 不需要真实 LLM 即可测：section 文本、配置解析、scope 目标、模板 loader 回退、skill catalog/loader、blacklist 检查和 facts diff 都可以用固定输入。
- 需要真实 runtime 才能测的项目：报告是否投递、`start` 阶段、monitor 行为、`ask_user_question` 取消；这些在本设计中只作为约束，不在本轮声称已验证。

### 10.4 可移植性检查

实现前用仓库已有的 `verify-md-links`、`verify-md-wrap` 检查文档；数据文件只写 `<DSH_HOME>/...` 或仓库相对路径，不写本机盘符、用户目录、session id、进程号或临时目录。

## 11. 实施顺序

| 顺序 | 工作 | 为什么排这里 | 前置 |
|---:|---|---|---|
| 0 | 定稿 `scope`/`name` 扩展、`persona` schema、brief 模板格式 | 这三项是数据契约；先定可避免四个模块各写一套 | 本设计评审通过 |
| 1 | **user-input**：`personality_learn` 可选 `scope`/`name`、A–E 固定名、分类门、模型主路径 | 所有学习都经过它；它决定后续模块写什么、写哪里 | 0 |
| 2 | **write-like-human**：skill + blacklist + 自查脚本 | 与 personality 数据解耦，风险最低，可并行验证 | 0；skill-filesystem/tool-skill 已存在 |
| 3 | **output-summary**：persona 配置 + section 690 + `ui-personality` 字段 | 依赖 user-input 的优先级/scope 决策；影响所有 agent，先做测试 | 1、0 |
| 4 | **super-agent-dispatch**：模板 loader + section 703 + super agent preset 接入 | 依赖 702 硬规则与 persona 口吻；耦合最高，最后做 | 3；super agent preset |
| 5 | 集成：四模块同时挂载，测缓存/优先级/回归 | 单模块测试不能证明冲突顺序 | 1–4 |

如果只能先做一个：**先做 user-input**。它直接处理 13 次纠正里的根因，且不依赖新 UI；其余三个模块都能从它得到稳定的分类与 scope。

## 12. 本轮不做

- 不写代码，不改 `packages/**`，不提交。
- 不自动写 `identity.*`；identity 仍只走 `personality_propose` + 人工 accept。
- 不建跨 workspace 的共享存储、数据库或第二份 PERSONALITY.md；scope 只决定写全局文件还是工作区 overlay。
- 不自动改写所有输出；write-like-human 仍是按需 skill，强制输出钩子另议。
- 不自动修改 persona 配置、brief 模板、blacklist；这三者只由人写。
- 不修改 superagent 的硬规则、审批、沙箱、工具权限或 KB 口径。
- 不提高 `autoLearn` 默认预算；先用分类与固定名减少重复，再测量是否需要分桶。
- 不做多用户/多租户人格隔离。

## 13. 待拍板

1. `personality_learn` 的 `scope` 默认值：保持 workspace（兼容）还是改为 global（更符合 A–E）？本设计建议保持 workspace 默认，仅 user-input 自动路径显式 global。
2. persona 是否真的需要对所有 agent 可见，还是只给 super agent？本设计选 all + 条件句，理由是不引入目标判定；若 token 测量不划算，再拆。
3. brief 模板是否需要在 `start` 工具层做结构校验，还是只要 prompt + loader 校验？本设计只做后者，工具层强制另开变更。
4. write-like-human 的词表是否允许模型提议修改？本设计禁止模型直接写，只能向人提议。
