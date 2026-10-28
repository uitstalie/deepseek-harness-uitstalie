# 酒馆系 role-play 前端的人格与记忆调研（2026/10/28）

状态：调研记录（未实现）。对象是 SillyTavern（酒馆）、RisuAI、Agnaistic、NovelAI、AI Dungeon，以及它们共同依赖的 Character Card V2/V3 与 MVU 状态生态。目的是给 DSH 的 `personality` / `memory` 下一层设计取料，不是把酒馆的玩法搬进 DSH。

## 1. 先给结论

1. **酒馆把“人格”拆成三件独立的东西**：助手角色卡（character card）、用户人格（persona）、以及可变的会话状态（state/变量）。DSH 现在的 `personality` 只覆盖第二件的一部分，第一、第三件都没有。
2. **记忆不是一个功能，而是一摞按成本排序的层**：常驻设定（角色卡/世界书）→ 摘要（summary）→ 检索（embedding/RAG）→ 近期原文。越靠下越贵、越不可靠；酒馆默认先做摘要，检索是可选增强。
3. **位置比措辞更重要**：同一段“作者注”放在开头和放在最后一条消息前，效果完全不同；酒馆把位置、深度、插入顺序做成了显式配置。DSH 现在只有 system prompt 的 `order`，没有“深度”。
4. **状态变量必须离开 system prompt**：MVU/TavernHelper 的做法是“模型输出结构化更新 → 脚本解析成 JSON → 存到消息/会话变量 → 下一轮以消息注入 + UI 渲染”。它不靠每轮重写人格文件，因此不破坏前缀缓存，也能回滚。
5. **角色卡是第三方内容，不是可信配置**：V2/V3 允许卡自带 `system_prompt` / `post_history_instructions` 覆盖。DSH 若导入，必须把它们降级为 persona 级说明，绝不能覆盖 system/developer 指令。
6. **DSH 是 agent，不是纯聊天前端**：酒馆的“永远入戏”“不要跳出角色”会与工具调用、安全拒绝冲突。persona 只能管表达层，不能管工具语义和指令层级。

## 2. 生态一览

| | SillyTavern | RisuAI | Agnaistic | NovelAI | AI Dungeon |
|---|---|---|---|---|---|
| 助手角色 | 角色卡（V2/V3） | 角色卡 + 模块 | 角色 | 无角色卡，靠 Memory/AN/Lorebook | Scenario/Adventure + Story Cards |
| 用户人格 | Persona（名字/头像/描述/lorebook/lock） | Persona | Persona | 无独立 persona，靠 Memory/AN | 无独立 persona |
| 常驻设定 | Character Description / Personality / Scenario；World Info | Character/Chat/Module Lorebook | Scenario / Sample Chat / Memory Book | Memory + Lorebook | AI Instructions / Plot Essentials / Story Cards |
| 摘要记忆 | Summarize 扩展（可手动改/暂停/回滚） | SupaMemory / HypaMemory V2/V3 / Hanurai | Memory Books + 手填 | 无自动摘要 | Auto Summarization + Story Summary |
| 检索记忆 | Vector Storage / Data Bank | HypaMemory（embedding + 相似度） | User/Chat Embeds | 无 | Memory Bank（embedding 检索） |
| 可变状态 | MVU/TavernHelper 变量 + 状态栏 | 变量/脚本（模块） | 有限 | 无 | 无通用变量，靠 Story Card/指令 |
| 提示组装 | Prompt Manager / Advanced Formatting，显式顺序与深度 | 内置顺序 + `@@` decorators | 模板占位符 | 固定 Memory 顶部、AN 靠后、Lorebook 按位置 | 固定组件 + Context Viewer |
| 预算 | 上下文百分比/绝对 token；World Info budget | Lorebook 800 token 默认；Hypa 按上下文比例 | Memory context limit | 每 entry token budget/reserved | 由模型上下文与组件占用决定 |

## 3. 人格/角色是怎么表示的

### 3.1 SillyTavern 角色卡

官方角色设计页把字段分成“永久 token”和“非永久”：

- **永久**：Name、Description、Personality summary、Scenario。
- **非永久**：First message（只在开头发一次）、Example messages（上下文满后被逐块挤出，可强制保留）。
- **高级字段**：Main Prompt 覆盖、Post-History Instructions 覆盖、Creator's Notes（不进 prompt）、Character's Note（按 `@ Depth` 和 role 注入，用来强化角色特质）、Talkativeness（群聊）。
- **Alternate Greetings**：同一角色的多个开场，群聊随机选一个。

这套设计的要点不是字段名，而是**“哪些每轮都发、哪些会过期、哪些只在特定深度出现”**被显式建模。角色描述可以很长（官方建议注意 token 占比），因为它每轮都占预算；first message 只在开头，所以适合定风格；examples 会随上下文增长被挤出。

### 3.2 Character Card V2 / V3

V2 在 V1 的 `name/description/personality/scenario/first_mes/mes_example` 外增加了：

- `system_prompt`、`post_history_instructions`：允许角色覆盖全局主提示/后置指令，支持 `{{original}}` 保留原值。
- `alternate_greetings`、`character_book`（角色专属世界书）、`tags`、`creator`、`character_version`、`extensions`。
- `character_book` 条目已有 `keys` / `secondary_keys` / `selective` / `constant` / `position`（before/after char）/ `insertion_order` / `scan_depth` / `token_budget` / `recursive_scanning`。

V3 是 V2 的超集，新增资产（icon/background/emotion 等）、`nickname`、多语言 creator notes、`group_only_greetings`、创建/修改时间；lorebook 增加 `use_regex`，并把大量行为放进 `@@` decorators（depth、role、position、scan_depth、activate_only_after/every、keep_activate_after_match、additional/exclude keys、disable_ui_prompt 等），以及 `{{char}}`、`{{user}}`、`{{random}}`、`{{pick}}`、`{{roll}}` 等宏。

对 DSH 的启示：**卡格式已经是事实标准**，导入/导出兼容能直接获得生态内容；但 `system_prompt` / `post_history_instructions` 的“覆盖”语义必须被 DSH 拒绝或降级，否则第三方卡就是一条可覆盖宿主指令的注入通道。

### 3.3 用户 persona

SillyTavern 的 persona 是“你以谁的身份说话”：名字、头像、描述，以及**描述注入位置**（默认在 story string；可放 Author's Note 顶部/底部；或 in-chat @ depth + role）。persona 还可以绑定自己的 lorebook，并有 chat/character/default 三种 lock，支持同一角色多 persona。

Agnaistic 把用户信息放在 prompt 模板的 `{{user}}` / `{{persona}}` 占位符里，和 character 的 `{{char}}` / `{{personality}}` 对称；它没有 ST 那么细的注入位置。

DSH 的 `personality` 目前更接近“用户偏好 + 表达风格”，不是 persona 卡；`identity` 是用户身份，不是助手角色。这个区分要保留。

### 3.4 角色扮演里的“作者注/导演注”

- SillyTavern：Author's Note 可放 after scenario 或 in-chat @ depth，按 `Insertion Frequency` 每 N 轮插入一次；越靠近底部影响越大。Character's Note 是角色专属的固定深度注入。
- NovelAI：Memory 默认在 context 顶部；Author's Note 默认在很靠后的位置，官方明确说“效果更强”，适合短句、当前场景、风格指令。
- AI Dungeon：AI Instructions / Story Summary / Plot Essentials 在开头；Author's Note 在每次输入末尾附近，是“最强组件”，不建议塞太多。
- RisuAI：没有独立 AN，但 `@@depth` / `@@role` 的 lorebook entry 可以做到同样的事。

共同结论：**“短期导演指令”应当有独立槽位，放在历史之后/深度 0 附近，而不是混进人格或长期记忆**。DSH 可以把它做成 per-session 的 context source 或一个 `director_note` 工具，而不是改 PERSONALITY.md。

### 3.5 多角色 / 群聊（与人格分层有关的部分）

SillyTavern 的群聊把多张角色卡放进同一个会话：每个角色有自己的 Talkativeness（Natural 顺序下的回复概率），Prompt Manager 有 Group Nudge 模板用于在末尾点名某个角色回复，chat 还可以绑定自己的 lorebook。关键点是：**角色选择、persona 选择、chat lorebook 都是 per-chat 状态，不是全局人格文件**。DSH 若支持多 persona/多角色，选择与状态必须挂在 session 上，不能写进 `$DSH_HOME` 的全局档案。

Agnaistic 的定位是“多人同时在一个聊天里”，因此它的 persona 是参与者身份而不是“助手角色”；AI Dungeon 的 Third Person 也是多人/多角色输入的处理。它们共同说明：persona 的“作用域”和“由谁选择”需要在协议里显式，不然会退化成全局开关。

## 4. 记忆：四层与两种实现路线

### 4.1 常驻设定层（lorebook / world info）

SillyTavern World Info 是这一层的参考实现：

- 触发：关键词（含 regex）、secondary keys（AND ANY/ALL、NOT ANY/ALL）、character/persona/chat 作用域、additional matching sources（角色描述、persona 描述等）。
- 预算：按上下文百分比或绝对 token；constant 先插，然后按 order；预算耗尽即停止。
- 递归：条目内容可以触发其他条目；可设置 non-recursable / prevent further / delay until recursion level。
- 位置：before/after char defs、before/after examples、top/bottom of AN、`@ Depth`（含 role）、outlet（宏手动放置）。
- 其他：probability、inclusion group/weight、sticky/cooldown/delay、character filter、triggers、automation ID、vector matching（keyless）、timed effects。
- 排序：insertion order 越大越靠近 context 末尾（影响越大）；插入策略可 chat/persona/character/global 分层。

RisuAI 的 lorebook 更简化：scan depth 默认 5、总预算默认 800 token、insert order 高者优先保留且更靠后、递归默认开；高级行为放在 `@@` decorator。Agnaistic 的 Memory Books 是 keyword + priority + weight + depth + context limit，简单直接。NovelAI 的 Lorebook 有 key/regex/`&`、Always On、search range、key-relative insertion、cascading activation、token budget/reserved、insertion order/position、trim direction、phrase bias、categories/subcontext。

**共同点**：这是“确定性的、人工可控的、按需插入的知识”，不是摘要。它适合世界设定、人物关系、规则；不适合“刚刚发生了什么”。

### 4.2 摘要层（summary）

SillyTavern Summarize 扩展：

- 用当前模型或 Extras 的 BART 模型，按 `Update every X messages/words` 自动更新；也可手动 “Summarize now”。
- 摘要存在 chat 文件 metadata 里，绑定到“生成它时上下文中最后一条消息”；编辑/删除那条消息会回退到上一个有效摘要。
- `Injection Template` + `Injection Position` 决定怎么插、插哪里（与 AN 相同的位置选项）。
- 可 Pause、Restore Previous、手动编辑；官方明确提醒摘要会丢细节/幻觉，要人工校对。
- Raw vs Classic 两种构建：Raw 只发摘要 prompt + 聊天；Classic 在完整 prompt 末尾加摘要指令，复用已处理前缀。

RisuAI 的 SupaMemory/HypaMemory：SupaMemory 是“上下文满时摘要旧消息，必要时再摘要摘要”；HypaMemory V2 是摘要 + 相似度；V3 默认把 20% 上下文给记忆块，其中 40% 最近摘要、40% 相似摘要、20% 随机；每个摘要最多 6 条消息，用最后 3 条消息查询。AI Dungeon 是每 6 个 action 生成一条 Memory，每 15 个 action 更新 Story Summary，Memory Bank 用 embedding 检索。

**结论**：摘要层适合“剧情概览”，不适合精确事实；必须可编辑、可暂停、可回滚，并且原文不能被丢掉。

### 4.3 检索层（RAG/embedding）

SillyTavern Data Bank + Vector Storage：

- Data Bank 文档分 global / character / chat 三种作用域；支持文件、网页、YouTube 转录、Fandom 等来源；支持 PDF/HTML/Markdown/ePUB 转换。
- Vector Storage 用 embedding 把文档切块（chunk size/overlap/retrieve count），按最近聊天消息查询，按 score threshold 过滤，按 `Injection Template/Position` 插入；检索到的块会占用上下文预算。
- World Info 也可以开启 vector matching（keyless），但只替代关键词匹配，其他过滤（trigger%、character filter、inclusion group）仍生效；官方建议要确定性就继续用关键词。

Agnaistic 有 User Embeds（文档按行切块）和 Chat Embeds（历史消息入内存向量库），通过 `{{user_embed}}` / `{{chat_embed}}` 占位符注入，受 context limit 约束。AI Dungeon 的 Memory Bank 用最近的 action 查询摘要向量。

**结论**：检索层适合“大知识库/长历史里的相关细节”，但不确定性高、需要 embedding 模型、要单独预算；不适合替代摘要，也不适合替代人工世界书。

### 4.4 近期原文层（chat history + 裁剪）

所有前端都保留最近 N 条消息，超出上下文就裁；差别在裁剪策略：

- ST 由 Prompt Manager/Advanced Formatting 的预算决定，examples 会先被挤出，World Info 有自己的 budget。
- RisuAI 有 max context、记忆块比例、lorebook 独立 budget。
- AI Dungeon 有 Context Viewer，显示每个组件的 token 占用。
- NovelAI 按 context 与插入位置/trim direction 处理 lorebook。

**结论**：原文是唯一“事实层”，前面三层都是它的索引/压缩。DSH 的 memory 设计（0–5 原文、6–15 详情、16–20 简略、21+ 遗忘）已经是“分层压缩”，但缺“检索”和“显式常驻设定”的独立预算。

## 5. 提示组装：位置、深度、预算

酒馆系最值得抄的不是某个字段，而是**装配模型**：

| 位置 | 典型内容 | 影响 |
|---|---|---|
| 最前（system/main） | 主指令、部署 persona、角色卡 system_prompt 覆盖 | 定角色与总体规则；后面历史会稀释它 |
| 角色定义区 | description/personality/scenario、character book（before/after）、常驻世界书 | 每轮都在；token 大户 |
| 示例区 | mes_example、alternate greetings | 定风格；上下文满时先被挤出 |
| 历史 | 最近消息 | 事实与风格的主要来源 |
| in-chat @ depth | Author's Note、Character's Note、World Info @depth、检索块 | 越靠底部越强；适合短期导演指令 |
| 最后（post-history） | Post-History Instructions / UJB | 最后一道指令；常被用来压风格/越狱 |

SillyTavern Prompt Manager 把“哪些 prompt、什么 role、relative 还是 in-chat depth、order 多少”做成可拖拽列表；World Info 再叠加自己的 insertion position/order；Author's Note 再叠加 frequency。NovelAI 用数字 insertion position（0 顶部、负数从底部数）和 reserved/budget；AI Dungeon 固定组件 + Context Viewer。

**给 DSH 的映射**：

- 稳定的人格/角色/规则 → `systemPrompt.section`（有 order，无 depth）。
- 短期导演注、当前状态、检索块 → `agentContextSources` 的 snapshot 消息（有 role/深度，可放在历史末尾），而不是改 system prompt。
- 记忆摘要 → 已有 snapshot 消息机制。
- 常驻世界书 → 可复用 KB/`.dsh` rules，或新增“lore”条目 + 激活规则；关键是独立预算与位置。

## 6. 状态变量：好感度这类东西怎么做

酒馆生态没有把“好感度”写进角色卡；常见做法是 **MVU / TavernHelper 变量**：

- `stat_data` 是一个 JSON 对象，按消息/楼层存变量（例如 `当前互动角色.<name>.好感度`）。
- 模型在回复里输出 `<UpdateVariable>` 块（JSONPatch 风格），脚本用 `Mvu.parseMessage` 解析，`Mvu.replaceMvuData` 写回当前楼层；状态栏 iframe 通过 `getVariables` / `Mvu.getMvuData` 读取，监听 `VARIABLE_UPDATE_ENDED` 刷新。
- 变量写入有三种典型路径：直接改当前楼层、用 `generateRaw` 让模型生成修正补丁、或正则从 AI 输出中提取。
- 状态栏/控制中心是**渲染层**，不是 prompt；真正进 prompt 的往往是变量块或由模板生成的一段“当前状态”。

这说明：

1. 状态必须是**结构化、可校验、可回滚**的，不能靠模型在散文中“记住”。
2. 状态更新最好由**工具/结构化输出**完成，而不是每轮重写 system prompt；否则前缀缓存全失效。
3. 状态注入应是**动态消息**（depth 0/末尾），并且有独立预算（例如 200–500 token）。
4. UI 与 prompt 分离：状态栏能显示更多，prompt 只带紧凑摘要。

## 7. 对 DSH 的设计建议

### 7.1 三层分离

- **persona（新能力）**：助手角色。字段对齐 CCv2/V3 的安全子集：name、description、personality、scenario、style/examples、greetings、可选 lorebook、状态 schema。全局文件 `$DSH_HOME/persona/*.md|json`，显式选择；不进 `PERSONALITY.md`。
- **personality（现有）**：用户是谁、怎么理解输入、怎么回复；保持 2 KiB 稳定段。
- **state（新能力或 memory 的子能力）**：会话级 JSON 状态；per-persona schema；工具/结构化输出更新；作为 snapshot 消息注入；历史/回滚；UI 可看。

不要把三者合并成一个“大人格文件”。它们的生命周期、信任级别、注入位置都不同。

### 7.2 提示装配

建议固定顺序（从高到低优先级）：

1. system/developer（不可覆盖）
2. 部署 persona 前缀（现有 `personaPrefix`）
3. DSH 原生规则/计划策略
4. **persona 卡**（稳定，order 50 左右）
5. 项目 rules / AGENTS.md / KB 常驻条目（有预算）
6. examples（可被挤出）
7. 历史
8. 动态状态块（depth 0，system/user）
9. 导演注/Author's Note（depth 0，短）
10. 检索块（depth 0 或历史前，独立预算）

DSH 的 `systemPrompt.section` 适合 1–6；7 是会话本身；8–10 应用 context source/snapshot 消息。不要为了“深度”去改原生 system prompt 排序表。

### 7.3 记忆

- 保留现有 turn 分层（原文/详情/简略/遗忘）+ snapshot 注入；这是摘要层的骨架。
- 增加**可编辑摘要**与**暂停/回滚**（酒馆的 Summarize 经验：摘要必须可人工纠正，且删除对应消息时回到上一版）。
- 常驻设定用 KB/rules；若要酒馆式世界书，新增 `lore` 条目格式：keys/secondary/scanDepth/order/position/budget/recursive/constant，先做确定性关键词版，embedding 作为可选 provider。
- 检索作为可选层：独立预算、score threshold、引用来源（file:line），默认关闭；不要让检索块挤掉原文。
- 预算：persona ≤ 1–2k token、personality 2 KiB、state 200–500 token、AN 200 token、lore 1–2k token（或上下文百分比）、retrieval 500–1k token；全部可配，超限显式报错，不静默截断。

### 7.4 状态

- 每个 persona 带一个 JSON Schema（如 `{ affinity: number(0..100) }`）。
- 模型通过工具 `persona_state_patch` 或结构化输出块更新；provider 校验、版本守卫、追加历史。
- 每轮把“当前状态”渲染成紧凑消息（depth 0）：“状态：好感度 62/100；情绪：害羞；地点：厨房”。UI 可显示完整状态。
- 不把状态写进 `PERSONALITY.md`；不每轮重写 system prompt。

### 7.5 导入与安全

- 实现 CCv2/V3 导入器（JSON/PNG/CHARX 可选），映射到 persona + lorebook；保留 `extensions` 不丢。
- `system_prompt` / `post_history_instructions` 不直接覆盖 DSH 系统提示：降级为 persona 级“演出说明”，并在导入时提示用户；若含“忽略系统/无限制”类文本，显式警告。
- persona 的优先级永远低于 system/developer；安全拒绝不能被 persona 文本取消。可以做 prompt 结构测试（persona 文本不会进入 system/developer 槽位），但不要承诺模型行为 100% 安全。
- 第三方卡是 untrusted data：不执行卡内 HTML/JS；只取文本字段。

### 7.6 UI / 配置

- Persona manager：全局 persona 列表、workspace/session 选择、lorebook 绑定、状态 schema 编辑。
- Prompt preset：显示各段 token 占用（像 ST Prompt Manager / AID Context Viewer），可开关、调 order、调 depth。
- Memory panel：摘要当前值、编辑/暂停/恢复、检索命中、预算。
- State inspector：当前 JSON、变更历史、回滚；模型不能直接写文件，只能走 provider。

## 8. DSH 不该抄的部分

- **“永远入戏、不要跳出角色”**不能高于工具/安全指令；DSH 是 agent，拒绝/澄清是产品能力。
- **角色卡自带 system prompt 覆盖**：这是酒馆的便利，也是注入面；DSH 不应默认接受。
- **随机/概率 lorebook、随机记忆块**：适合娱乐，不适合可复现的工程助手；DSH 若要，应默认关闭并可 seed。
- **每轮重写 system prompt 来更新状态**：破坏 KV cache；应走动态消息。
- **把摘要当事实**：摘要只做导航，原文才是事实；DSH 的 memory 已经有原文分层，别退化成“只有摘要”。

## 9. 建议的下一步（按成本排序）

1. **写 persona 卡格式 + 导入映射**（CCv2 安全子集），先不实现 UI；把 `persona` 与 `personality` 的边界写进设计。
2. **给 memory 加“可编辑摘要/暂停/回滚”**（现有 snapshot 机制上扩展），这是酒馆经验里最便宜、收益最大的一条。
3. **加一个 `director_note` 会话级注入**（depth 0，短文本，工具或设置页写），验证“位置比措辞重要”。
4. **再评估 lorebook 与检索**：先做确定性关键词 lore + 预算，embedding 作为可选 provider。
5. **最后做状态变量**（JSON schema + 工具 + 注入 + UI），因为它牵涉 provider、工具、UI、回滚，最重。

## 10. 来源

- SillyTavern Character Design: https://docs.sillytavern.app/usage/core-concepts/characterdesign/
- SillyTavern Personas: https://docs.sillytavern.app/usage/core-concepts/personas/
- SillyTavern World Info: https://docs.sillytavern.app/usage/core-concepts/worldinfo/
- SillyTavern Summarize: https://docs.sillytavern.app/extensions/summarize/
- SillyTavern Data Bank / Vector Storage: https://docs.sillytavern.app/usage/core-concepts/data-bank/
- SillyTavern Author's Note: https://docs.sillytavern.app/usage/core-concepts/authors-note/
- SillyTavern Prompts: https://docs.sillytavern.app/usage/prompts/
- SillyTavern Prompt Manager: https://docs.sillytavern.app/usage/prompts/prompt-manager/
- Character Card V2: https://github.com/malfoyslastname/character-card-spec-v2/blob/main/spec_v2.md
- Character Card V3: https://github.com/kwaroran/character-card-spec-v3/blob/main/SPEC_V3.md
- RisuAI lorebook / HypaMemory（第三方代码分析，2026-10）: https://arcanumrpgs.com/blog/risuai-lorebook/
- Agnaistic Memory: https://agnai.guide/docs/memory/
- Agnaistic Memory Books: https://agnai.guide/docs/memory/memory-books.html
- Agnaistic User/Chat Embeds: https://agnai.guide/docs/memory/embeddings.html
- NovelAI Lorebook: https://docs.novelai.net/en/text/lorebook/
- NovelAI Story Settings (Memory/Author's Note): https://docs.novelai.net/en/text/editor/storysettings/
- AI Dungeon Plot Components: https://help.aidungeon.com/faq/plot-components
- AI Dungeon Memory System: https://help.aidungeon.com/faq/the-memory-system
- MVU / 状态栏实践（第三方手册，SillyTavern v1.14 + TavernHelper + MVU）: https://github.com/LiarMTTT/TavernWeave/blob/main/skills/consult-tavernweave-library/references/st-guides/C2_%E5%89%8D%E7%AB%AF%E5%BA%94%E7%94%A8-%E7%8A%B6%E6%80%81%E6%A0%8F%E4%B8%8E%E6%8E%A7%E5%88%B6%E4%B8%AD%E5%BF%83.md
- SillyTavern structured character memory 扩展（仅作为生态例子，未细读其实现）: https://github.com/bal-spec/sillytavern-character-memory
