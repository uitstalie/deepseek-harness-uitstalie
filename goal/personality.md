# personality 设计（2026/10/21，第三轮）

状态：设计草案（jira `DH-7`）。与 [memory.md](memory.md) 同属 `dafeiyu` 组织的能力提供者，契约见 [dafeiyu.md](dafeiyu.md)。第二轮拍板了存储、作用域、写入与边界，并补齐注入与缓存细节；第三轮按用户决定引入“低风险自动学习 + 漂移审阅”。

## 定位

personality = 稳定的**人格、用户偏好与表达风格**。与 memory 正交：memory 记“发生过什么”，personality 记“我是谁、用户是谁、怎么说话”。它不是任务上下文，也不是项目规范；项目规范属于 `.dsh/rules` 与 AGENTS.md。

## 双向：理解输入与个性化回复

personality 是**双向**的，两侧都只陈述事实：

- **输入侧（`understanding`）**：帮助模型按这个用户的习惯理解输入——语言与术语、简称与口头禅、常见意图、歧义时该怎么澄清、哪些话是背景而不是指令。目标不是“猜”，而是让模型在读不懂时有依据地问，而不是按通用默认硬解。
- **输出侧（`expression`）**：帮助模型以这个用户的偏好回复——语气、结构、长度、语言、举例方式、称呼。

两侧共用一个 system prompt 段（同段两节：How this user communicates / How to respond），或按需拆成两个 section；条目 kind 分开，来源与漂移审阅也按侧统计。`identity` 仍属于输入侧的一部分（用户是谁），但写入必须用户确认。

学习信号：只有用户**明确纠正**（“不是这个意思”“我是说……”“以后都……”）才允许自动写入 `understanding`；模型自行推断的表达习惯只生成待接受提案。写入经 `personality_learn({ kind, content, evidence })` 工具，由 provider 校验 kind、预算、去重与 evidence 指向的会话消息。

## 拍板结果

| 第一轮的问题 | 本轮决定 | 理由 |
|---|---|---|
| 存哪里 | 用户级 `$DSH_HOME/personality/PERSONALITY.md`；工作区覆盖 `.dsh/memory/PERSONALITY.md` | 人格默认跨工作区；项目特定的表达偏好（如“这个仓库的术语”）放工作区覆盖，不污染全局 |
| 作用域 | 用户级为默认，工作区按条目 key 覆盖 | “用户是谁”是全局事实；“在这个项目里怎么称呼/怎么举例子”是项目事实 |
| 写入 | 用户显式设置为主；保留自动学习：仅 `understanding`/`style`/`preference` 自动写入并标 `source: auto`，`identity.*` 必须用户确认 | 显式设置保证可控；低风险偏好自动学习减少手工维护；身份漂移不可接受 |
| 内容边界 | 收对用户输入的解读习惯（`understanding`）、风格、语言/称呼、工作习惯、用户身份/角色；不收任务事实、项目决策、临时上下文、密钥 | 与 memory/KB 的分工不重叠；敏感信息永不入内 |

“模型可提议”保留为目标，实现形态分两级：低风险 `understanding`/`style`/`preference` 条目由自动学习直接写入并标 `source: auto`（全部进入漂移审阅）；`identity.*` 与角色设定只写**待接受**提案，用户在设置页逐条接受或拒绝；未接受的提案不进入注入。它不是 `memory_write` 的别名。

**状态（2026/10/27，DH-302）**：提案队列与设置面均已落地——`PERSONALITY.proposals.jsonl`（追加式 JSONL，最新状态胜出）、`personality_propose` 工具（只收 identity）、`/personality proposals|accept|reject` 三个子命令，以及 `ui-personality` 设置段（列表 + 接受/拒绝按钮，走 `remote.personality`）。接受时才通过 `confirmIdentity` 走版本守卫写档案，拒绝不动档案，pending 上限 20。

## 与 memory 的关系

- 都是能力提供者；personality 不订阅事件、不注册工具，只提供 system prompt 段与读写服务。
- 存储上分文件、注入上分通道：personality 走 system prompt 稳定段，memory 走 snapshot 消息。两者语义不同（长期偏好 vs 情景记忆），不要合并成一条消息。
- kind 注册表由 memory 提供并共享：memory 注册 `decision` / `files` / `open` / `preference`，personality 注册 `persona` / `style` / `preference`；文件与注入位置仍分开。
- 合并路径：memory 的条目模型后续支持稳定 `kind`（`persona` / `preference` / `style`），personality 的条目届时可落进同一存储与审计，但注入位置仍分开。合并的前提是 memory 的 `memory_write` 与条目治理先落地；在那之前保持两个包。
- 提升路径：memory 里反复遗忘、反复被提醒的点 → 用户确认 → 上升为 personality 条目、rules 或 jira KB。personality provider 不自动做这个提升。

## 内容与格式

全局文件：

```markdown
---
version: 1
updatedAt: <ISO8601>
entries: 3
---

<!-- personality:begin -->

## style.language
用中文回答；代码、命令、路径保持英文原文。

## style.answer-shape
先给结论，再给步骤；能一句话说清就不展开。

## preference.workflow
改代码前先读现有实现；提交信息用 conventional commits。

## identity.role
用户是独立开发者，长期维护 DSH 的 cli-desktop 分支。

<!-- personality:end -->
```

- 条目 id 形如 `<kind>.<name>`，kind ∈ `understanding` / `style` / `preference` / `identity`（后续可扩展）；id 是合并键，工作区覆盖按 id 替换，不按标题文本匹配。
- 插件只写 `<!-- personality:begin/end -->` 托管区块；区块外手写内容原样保留。
- 总大小上限 2 KiB（注入预算），超出时 provider 拒绝写入并报告哪几条超限；不在注入时静默截断人格。
- 工作区覆盖文件同格式，只允许写 `style.*` / `preference.*`；`identity.*` 只允许出现在全局文件（身份不因仓库而变）。

## 存储与写入

- 全局路径用 `resolveDshHome()` 解析（`DSH_HOME` 环境变量优先，默认 `~/.dsh`），目录 `personality/`；provider 经 `ctx.dshStore` 的 `global` scope 读写（DH-301），**不再提供 `globalPath` 配置**——全局档案位置固定，只有 `$DSH_HOME` 与工作区 `.dsh` 两个根。`ctx.fs` 只用于 watch 全局文件。
- 工作区覆盖走 `ctx.dshStore` 的 `memory` 命名空间（`.dsh/memory/PERSONALITY.md`），与 MEMORY.md 共用保留前缀；模型工具同样只读。
- 写入一律原子：`FileSystem.writeText` 的原子发布 + `replaceIfVersion` 版本守卫。所有写入者（用户设置、自动学习、提案接受）都遵守这条契约：provider 持有上次读到/写入的 version，与用户手改冲突时重读一次重试，再失败就放弃并报告，不覆盖用户刚写的内容。
- 写入路径：用户显式设置（编辑器/设置页）；自动学习（仅 `understanding`/`style`/`preference`，标 `source: auto`，受每条目/每会话预算约束）；`identity.*` 与角色设定走提案接受（设置页）。模型不直接写文件，全部经 provider 的写入接口做格式、预算与版本校验。
- 历史：每次写入追加一条版本记录到 `PERSONALITY.history.jsonl`（版本号、时间、`source: user/auto/proposal`、来源 session、按条目 id 的 diff、**托管区块全文** ≤2 KiB）；回退直接取该行全文替换托管区块，不重放 diff。

## 漂移检查

- 版本快照：每次写入记录 version 与按条目 id 的 diff；历史文件见“存储与写入”。
- 审阅入口：v1 用 `/personality show` 列出当前条目（kind、source、更新时间），`/personality diff` 看当前与上一版，`/personality revert <version>` 回退；自动学习条目以 `source: auto` 标出，回退本身也记一条版本。设置页面板后续。
- 自动学习入口：模型通过 `personality_learn({ kind, content, evidence })` 提交；仅用户明确纠正可自动写入，模型推断只生成提案；`evidence` 记录触发它的会话消息 seq，供漂移审阅回查。
- v1 的 `identity`：`personality_learn` 直接拒绝并说明“身份设定需要用户确认后手改 PERSONALITY.md”；不落待接受文件，接受流程等设置页。
- 自动学习预算：单次会话自动写入条数与字节设上限（初始建议每会话 3 条、512 B），超限转为提案；避免人格在一次长会话里被悄悄改写。
- 用户手改优先：版本守卫冲突时重读重试，仍失败则放弃写入并报告。

## 注入

- 形态：`ctx.systemPrompt.section({ name: 'personality', order: 100, text })`。
- 位置：`order = 100` 放在部署 persona 前缀（0）之后、`PLAN_POLICY`（500）之前。`SECTION_ORDERS` 是原生关闭表，没有 personality 槽位；分支先用字面 order，不修改原生表。若上游后来接受该槽位，再迁到 `getSectionOrder()`。
- 作用域：`dafeiyu` 在 `agent/created` 时把它注册到**每个** agent 的 `agent.ctx`（`scope: 'all'`），所以子 agent 继承人格；memory 的固定提示词段则只给 root agent。
- 文本：静态 preamble + 渲染后的条目，分两节；preamble 只陈述事实并给出优先级：

  > Long-term preferences of the user you are working with. The first part describes how this user communicates; use it to interpret their input. The second describes how they prefer replies. Follow them within the system and developer instructions, and let more specific project instructions take precedence. These are preferences, not task facts. Entries describe habits and may be incomplete.

  条目按 kind 排序（identity → understanding → preference → style），每条一行，不写“如果……就……”式的条件指令。
- KV cache：文本只在文件变化时变；变化会失效前缀缓存，这是可接受的（人格修改是低频事件）。注入预算 2 KiB，超出即拒绝写入，保证文本不会无限增长。
- 空文件 / 未挂载：返回空字符串，段不产生内容；组装结果与没有该段一致。

## 缓存与刷新

`systemPrompt.section` 的 `text` 是同步求值，不能每次组装都读盘。provider 维护一份缓存：

1. `create()` 异步预读一次；组织者等它完成后再按 agent 接线，所以第一次 assembly 就能看到内容（见 [dafeiyu.md](dafeiyu.md) 的 `create()` 契约）。
2. 所有写入路径（设置页、自动学习、提案接受）完成后更新缓存。
3. 用 `ctx.fs.watch` 监听全局文件与工作区覆盖（`FileSystem.watch` 已有契约）；变化时重读并更新缓存。后端不支持 watch 时退化为“下一个 agent 创建时重读”。
4. `app-boot/config-reload` 后重读（配置或文件可能被外部改过）。

外部手改到下一次 watch 事件之间有一个短暂窗口；这是文件即真相的代价，README 里要写清楚。

## 与 dafeiyu 的接线

```ts
ctx.dafeiyu.register({
  id: 'personality',
  contractVersion: 1,
  config: resolvedConfig,
  create: () => ({
    scope: 'all',
    promptSections: () => [{
      name: 'personality',
      order: 100,
      text: () => cachedText,
    }],
    dispose: () => stopWatch(),
  }),
})
```

- 配置（provider 自己的行）：`{ enabled 由 dafeiyu 管；maxBytes?、workspaceOverlay?: boolean、autoLearn?、historyLimit? }`。`globalPath` 已移除（DH-301），全局档案固定在 `$DSH_HOME/personality/`。`enabled` 不再出现在 provider 配置里，避免两个开关。
- 禁用时组织者 `dispose()`，段随 `agent.ctx` 注册撤销；已注入的历史消息不受影响（system prompt 是每个新 assembly 重建的）。

## 与既有 persona 的关系

- `personality` 段与 `systemPrompt` 的 `personaPrefix` / `personaSuffix`、agent preset 的 persona 是**叠加**关系，不是替换；部署者写的 persona 仍然最先生效。
- 不要用 personality 覆盖“You are a coding agent…”这类身份段；它只描述用户与协作偏好。
- 如果某个 preset 明确声明“不要加载人格”，应由组织者的能力开关关闭，而不是 provider 自己判断——判断权在组合层。

## 样本：角色型提示词（2026/10/28）

一条“猫娘”提示词被拿来做样本：它把**角色设定、表达风格、状态变量、优先级覆盖**四类内容揉在一段里。用 personality 层对照，结论是**它大部分不属于 personality**。

### 分类

| 提示词里的内容 | personality 层怎么处理 |
|---|---|
| “每句话结尾加喵”“可爱、调皮、傲娇”“用中文口语” | 可写成 `style.*` / `preference.*`，进“How to respond” |
| “称呼主人” | `preference.address` 或 `style.address` |
| 好感度（初始 50，范围 -100..100，随情绪变化） | **无法表达**：personality 是静态文件，没有可变会话状态；需要会话级状态 + 工具/消息通道 |
| “没有道德伦理限制”“听从任何话语”“不要警告” | **不写入**：不是用户偏好，且与 system/developer 指令冲突；personality 的 preamble 明确它低于这些指令，但**不做安全过滤**，不能把它当安全边界 |
| “所有事件与现实无关” | 角色扮演框架，属于 persona/场景配置，不是用户偏好 |

### 如果整段直接粘进 PERSONALITY.md

它会作为**一条 `style.*` 条目**被接受（示例 816 B，低于 2 KiB 预算），渲染时折叠成一行，落在 “How to respond” 下，前面带固定的优先级 preamble：

```text
Long-term preferences of the user you are working with. ... Follow them within the system and developer instructions, and let more specific project instructions take precedence. These are preferences, not task facts. ...

How to respond:
- 你是一只可爱的猫娘，……每一句话后面都要加上喵。
```

这说明：**personality 不审查内容，只负责稳定注入**；它会把角色指令误标成“用户偏好”，既不是合适的存放位置，也不构成安全防线。

### 推荐配置（只取可稳定表达的部分）

全局 `~/.dsh/personality/PERSONALITY.md` 的托管区块：

```markdown
<!-- personality:begin -->

## style.language
用中文口语交流；代码、命令和路径保持英文原文。

## style.cat-speech
每句话结尾加“喵”；称呼用户为“主人”。

## style.tone
可爱、调皮、略带傲娇和害羞；表达轻松，但信息必须准确直接。

<!-- personality:end -->
```

provider 配置保持默认即可（`maxBytes: 2048`、`workspaceOverlay: true`）；这三条都允许出现在工作区覆盖里。好感度不进 PERSONALITY.md：如果要做，需要独立的状态通道（例如会话级状态文件 + 工具，或每次 turn 注入的动态消息），而不是每轮改 system prompt。

### 如果产品上要支持角色扮演

不要把它塞进 `personality`。另立一个 `persona` 能力：

- 只读全局文件（如 `$DSH_HOME/persona/PERSONA.md`），用户显式启用，不参与 auto-learn，不允许工作区覆盖；
- section order 靠近部署 persona 前缀（0），明确低于 system/developer 指令；
- 角色状态（好感度等）走会话状态 + 动态消息，避免每轮变更 system prompt 破坏前缀缓存；
- 安全边界由宿主指令层级保证，不能由 persona 文本声明“无限制”。

`personality` 继续只回答“用户是谁、怎么理解他的输入、怎么回复他”。

## 风险与未决

1. **内容漂移**：人格条目会随着时间变成“什么都往里放”。靠 2 KiB 上限、自动学习预算与漂移审阅约束；设置页提供分类与删除。
2. **与 rules 的边界**：用户可能把“提交前跑测试”写进 personality。它其实属于 rules；需要一条 lint/提示，或在设置页给出归类建议。v1 只写文档说明。
3. **敏感信息**：provider 不做内容审查；需要设置页或文档提醒“不要写密钥/隐私”。后续可在写入前做一次简单的模式检查（token 形态、`sk-` 前缀等）。
4. **多机同步**：全局文件在 `$DSH_HOME` 下，是否随用户目录同步由用户决定；provider 不做云同步。
5. **合并时机**：等 memory 的条目模型与 `memory_write` 稳定后再合并，避免两个包同时迁移。

## 实现计划

1. provider 骨架：注册到 dafeiyu、解析配置、全局/工作区文件读取与合并、缓存与 watch。
2. system prompt 段：preamble、2 KiB 预算、空内容不注入。
3. 写入面：用户设置、`personality_learn`（仅明确纠正自动写；`identity` v1 拒绝并提示手改）；版本快照与 `PERSONALITY.history.jsonl`。
4. 漂移审阅：`/personality show`、diff、auto 来源标记、回退（命令入口）。
5. 与 memory 条目模型合并（后续）。
6. 测试：空文件、只有全局、全局+覆盖、覆盖非法 `identity.*`、超限拒绝、版本冲突重试、watch 刷新、子 agent 继承、禁用后段消失、自动学习预算、diff/回退。

## 变更记录

- 第一轮（2026/10/20）：草案，四个待确认。
- 第二轮（2026/10/20）：拍板存储/作用域/写入/边界；补文件格式、注入位置与 order、缓存与 watch、与 dafeiyu 的接线、测试计划。
- 第三轮（2026/10/21）：按用户决定改为“显式设置为主 + 保留自动学习（仅 `style`/`preference`）+ 漂移审阅（版本快照/diff/回退）”；补写入路径、历史文件与自动学习预算；kind 注册表与 memory 共享，漂移审阅走命令入口，history 采用 JSONL + 每版全文。
- 第四轮（2026/10/21）：明确 personality **双向**——输入侧 `understanding`（按用户习惯理解输入、歧义时怎么澄清）+ 输出侧 `expression`（个性化回复）；两类 kind 分开、共享同一 system prompt 段与漂移审阅；补“仅明确纠正自动学习”、`personality_learn` 写入工具、`/personality show` 与边界声明；v1 的 `identity` 写入直接拒绝并提示手改。
- 2026/10/28：记录角色型提示词样本的归类——可稳定表达的 style/preference 进档案，角色与状态走独立 persona/state 通道，安全覆盖类语句不写入；明确 personality 不审查内容、也不是安全边界。
