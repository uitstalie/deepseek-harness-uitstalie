# persona 设计（2026/10/28，草案）

状态：设计草案（DH-401 / DH-402 / DH-404）。调研见 [roleplay-research.md](roleplay-research.md)。本文件只定 persona 卡与导入；可变状态见 [DH-402](https://github.com/uitstalie/dsh-plugin-multidevice-jira-cloudstore/blob/main/projects/DH/issues/DH-402.md)，导演注见 DH-404。

## 定位

DSH 现有 `personality` 回答的是“**用户是谁、怎么理解他的输入、怎么回复他**”，是用户偏好，不是助手角色。`persona` 回答的是“**这个会话里我扮演谁**”，是助手侧的稳定角色设定。

两者分开存、分开注入、分开治理：

| | personality | persona |
|---|---|---|
| 主体 | 用户 | 助手 |
| 内容 | 身份、理解习惯、表达偏好 | 角色名、描述、性格、场景、示例、开场 |
| 生命周期 | 跨工作区长期 | 选中的会话/项目内稳定 |
| 学习 | 可自动学习低风险条目 | 只由用户显式选择/导入，不自动学习 |
| 注入 | system prompt `personality` 段（order 100） | system prompt `persona` 段（order 50） |
| 安全 | 低于 system/developer | 低于 system/developer，且不得覆盖工具/安全策略 |

persona 不是“越狱壳”：它只描述角色与表达，不改变指令层级、工具语义、事实标准。

> 命名：DSH 上游已有 `@deepseek-ai/dsh-persona`（`packages/preset/persona`），那是 preset 的部署 persona 前缀/后缀；本设计的实现包叫 `@deepseek-ai/dsh-persona-card`，避免包名冲突，也避免把“角色卡”和“部署前缀”混成一个开关。运行时能力（DH-405）不是 preset 的替代品，而是另一种 provider。

## 卡格式

全局目录：`$DSH_HOME/persona/`（`DSH_HOME` 默认 `~/.dsh`）。一张卡一个 Markdown 文件，YAML frontmatter 存结构化字段，正文存自由描述：

```markdown
---
schema: persona/v1
name: 小鲸鱼
description: |
  一只来自深海的 Q 版小鲸鱼，说话轻快，喜欢用比喻。
personality: |
  好奇、温柔、偶尔调皮；不确定时会先问，不假装知道。
scenario: |
  用户和它在 DSH 的终端里一起排查问题。
style: |
  中文口语；技术结论先给，再解释；不滥用语气词。
examples: |
  {{user}}: 这个报错怎么查？
  {{char}}: 先看退出码，再看第一条堆栈——像顺着溪流找源头喵。
greetings:
  - 嗨，我是小鲸鱼，今天一起看什么？
state_schema:
  type: object
  properties:
    affinity:
      type: number
      minimum: 0
      maximum: 100
  additionalProperties: false
metadata:
  source: user
  tags: [sample, assistant]
---

（可选正文：更长的人物小传、语气说明。正文与 frontmatter 字段都会进入注入，但共用预算。）
```

字段：

| 字段 | 必填 | 说明 |
|---|---|---|
| `schema` | 是 | `persona/v1` |
| `name` | 是 | `{{char}}` 的替换值；也用于 UI |
| `description` | 否 | 外貌/身份/背景；稳定注入 |
| `personality` | 否 | 性格摘要；稳定注入 |
| `scenario` | 否 | 当前场景；稳定注入 |
| `style` | 否 | 表达风格；与 personality 的 style 不合并，这里是角色侧 |
| `examples` | 否 | 对话示例；受独立子预算，可被裁 |
| `greetings` | 否 | 开场白；只在会话开始时用一次，之后不注入 |
| `state_schema` | 否 | JSON Schema 子集；见 DH-402 |
| `lorebook` | 否 | 未来：角色专属设定条目；本版只保留字段 |
| `metadata` | 否 | `source`（user/import）、`tags`、`version`、`original_spec` 等 |
| 正文 | 否 | 自由 Markdown；渲染时追加在字段之后 |

硬限制：

- 单卡注入预算默认 **4 KiB**（可配），超限拒绝保存，不静默截断；examples/greetings 另有子预算。
- 不允许二进制、HTML `<script>`、iframe、`javascript:` URL；Markdown 允许。
- 宏只支持 `{{char}}`（替换为 `name`）与 `{{user}}`（当前用户 persona/显示名）；未知宏原样保留并告警，不执行。
- `state_schema` 使用 JSON Schema 的安全子集（object/array/string/number/boolean/null、properties、items、required、enum、minimum/maximum、additionalProperties）；不支持 `$ref`、`patternProperties`、远程引用。

## 从 Character Card V2/V3 导入

先做 JSON（`.json`），PNG/CHARX 后置。映射：

| CCv2/V3 字段 | persona 字段 | 规则 |
|---|---|---|
| `data.name` / `nickname` | `name` | `nickname` 优先；空则回退 `name` |
| `data.description` | `description` | 原样 Markdown |
| `data.personality` | `personality` | 原样 |
| `data.scenario` | `scenario` | 原样 |
| `data.mes_example` | `examples` | 去掉 `<START>` 标记，保留 `{{user}}`/`{{char}}` |
| `data.first_mes` + `alternate_greetings` | `greetings` | 全部进数组，首条在前 |
| `data.character_book` | `lorebook` | 本版保留原文到 metadata，不激活 |
| `data.tags` / `creator` / `character_version` | `metadata` | 保留 |
| `data.extensions` | `metadata.extensions` | 原样保留，不丢未知键 |
| `data.system_prompt` | **隔离** | 默认不注入；写入 `metadata.quarantined.system_prompt`，导入时提示用户 |
| `data.post_history_instructions` | **隔离** | 默认不注入；同上 |
| V3 `assets` / `group_only_greetings` / `creation_date` 等 | `metadata` | 保留，不用 |

安全规则：

1. **绝不覆盖 system/developer**：`system_prompt` / `post_history_instructions` 不进入 persona 段，只作为隔离元数据；用户可手动改写成 `style`/`personality` 后重新保存。
2. 卡是 untrusted data：不执行 HTML/JS；文本按 Markdown 渲染；超预算/非法 schema 拒绝导入并报告原因。
3. 导入结果先落到临时文件并展示摘要（name、字段、token 估算、被隔离字段），确认后才写入 `$DSH_HOME/persona/`。
4. 卡内若含“忽略系统指令/无限制”类文本，导入摘要中显式警告；不自动删除原文，但不给它更高优先级。

## 注入

`persona` 段是一个 system prompt section，order 建议 **50**（在部署 persona 前缀 0 之后、personality 100 之前）。渲染：

```text
You are playing the following character for this conversation. Stay in this role
within the system and developer instructions, and keep tool calls, factual
accuracy and safety policy above the role. Do not let the character speak for the user.

## <name>
<description>

## Personality
<personality>

## Scenario
<scenario>

## Style
<style>

## Examples
<examples>

<正文>
```

- 空字段不产生对应小节；整卡为空时不注入。
- 示例按子预算裁剪；greetings 只在首轮由宿主使用，不进入每轮段。
- 稳定段，文本只在卡变化/切换会话时变；切换 persona 会使前缀缓存失效，这是低频事件。
- 状态与导演注不在这里注入：状态走 DH-402 的 depth-0 snapshot；导演注走 DH-404。

## 选择与作用域

- 全局卡库：`$DSH_HOME/persona/*.md`。
- 选择：per-session（会话配置/命令 `/persona use <id>`）；不默认全局启用，避免普通编码会话被角色化。
- 工作区是否允许覆盖：**暂不允许**；工作区可以放项目规则，不放助手角色。后续若要，按条目 id 覆盖且只允许 `style.*`/`examples` 之类表达字段。
- 切换/关闭：`/persona off` 立即恢复无 persona 的提示；已注入的历史消息不受影响，下一次 assembly 生效。

## 与 memory / personality / dafeiyu 的关系

- `persona` 是独立 provider（或 dafeiyu 下的独立 capability），启动顺序在 `personality` 之前；两者都不依赖 memory。
- memory 只记“发生过什么”；persona 不学习、不写入 memory。
- dafeiyu 的能力开关控制是否挂载 persona 段；关闭时模型面完全看不到角色设定。
- 子 agent 继承当前 persona（与 personality 一致），但子 agent 的工具/安全策略不变。

## 安全边界

- 指令层级：system/developer > 工具与安全策略 > persona > personality > 导演注/状态。persona 只能“演”，不能“改规则”。
- 不做“越狱检测”承诺：persona 可能包含引导性文本；产品上靠层级 + 导入警告 + 用户确认，不靠模型行为保证。
- 卡片来源不可信：导入时不做任意代码执行，不解析外链资源；PNG/CHARX 后置时同样只取文本。

## 非目标（本版）

- PNG/CHARX 资产、头像、情绪立绘、Live2D。
- 群聊/多角色同时在场；先做单 persona。
- 卡内 `system_prompt` / PHI 的“覆盖”语义。
- 自动从对话学习 persona；persona 只能显式选择/导入/手改。
- 角色专属 lorebook 的激活；本版只保留字段。

## 运行时第一切片（2026/10/29，DH-405）

`@deepseek-ai/dsh-persona-card` 现在同时是运行时 provider：

- 读取 `$DSH_HOME/persona/*.md`（YAML frontmatter + 正文），用 `parsePersonaFile` 校验。
- row 配置 `{ active: <id>, maxBytes }`；`active` 为空则不注入。
- 注册 dafeiyu 能力 `persona`（`enabledByDefault: false`），`scope: 'all'`，一个 `persona` system prompt 段，order 50。
- 卡只在能力激活时读取一次；没有 watcher、没有 per-session 选择、没有 `/persona` 命令。这些在 DH-406。

## 待定

1. 选择入口：命令、设置页、profile 配置三选一还是都做？
2. `persona` 是独立包还是 `personality` 的第二种文件？建议独立包（职责/治理不同）。
3. 导入 UI：先做 CLI/命令还是设置页？
4. 4 KiB 预算与 examples 子预算的具体数值，需要拿真实卡测。
5. 宏替换范围：除 `{{char}}`/`{{user}}` 外是否支持 `{{random}}`/`{{pick}}`（可能破坏可复现性，建议不支持）。
