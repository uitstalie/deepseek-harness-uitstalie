---
description: "角色扮演角色卡格式：persona/v1 的纯校验器与渲染器，以及安全的 Character Card V2/V3 JSON 导入器。与部署 persona 预设包 @deepseek-ai/dsh-persona 不同。"
kind: "package-reference"
---

# @deepseek-ai/dsh-persona-card

[English](README.md) | 中文

## Summary

`persona-card` 持有角色扮演会话中稳定的助手侧角色：`persona/v1` 卡格式、无依赖的校验器与提示渲染器，以及 Character Card V2/V3 JSON 的安全导入器。

它不是部署 persona。`@deepseek-ai/dsh-persona`（位于 `packages/preset/persona`）是给单个 agent 部署前缀/后缀的预设行；本包是角色扮演角色卡的数据格式、导入路径与第一个运行时 provider。provider 在 `active` 指定卡时注册一个稳定的 `persona` system-prompt 段。

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Dev Note](#dev-note)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use this package

解析不可信的 `persona/v1` 对象、渲染，或导入 SillyTavern 风格的卡：

```ts
import { importCharacterCard, parsePersonaCard, renderPersonaText } from '@deepseek-ai/dsh-persona-card'

const parsed = parsePersonaCard(candidate, { maxBytes: 4096 })
if (!parsed.ok) throw new Error(parsed.error.message)
const text = renderPersonaText(parsed.value, { userName: 'Dai' })

const imported = importCharacterCard(cardJson)
if (imported.ok) {
  imported.value.card        // persona/v1, prompt overrides quarantined
  imported.value.warnings    // stripped assets, quarantined fields, truncations
  imported.value.quarantined // ['system_prompt', 'post_history_instructions']
}
```

解析器与导入器是纯的（不碰文件系统、不依赖 Cordis 上下文）。本包同时导出一个 Cordis row，读取 `$DSH_HOME/persona/*.md` 并注册段：

```yaml
- id: persona-card
  name: '@deepseek-ai/dsh-persona-card'
  config:
    active: 小鲸鱼   # file name without .md; empty disables the section
    maxBytes: 4096
```

该 row 是 dafeiyu 能力（`enabledByDefault: false`），是否挂载由组织者的能力门决定。

会话可以不碰 row 自己选卡：`/persona list` 列出已安装的卡，`/persona use <id>` 为当前会话选一张，`/persona off` 关闭该会话的段。选择只活在本进程——重启后退回 row 的 `active` 卡。provider 监听 `$DSH_HOME/persona`，目录变化后重读，因此新卡或改卡在下一次组装生效，不必 reload；目录尚不存在（或后端不支持 watch）时，退化为创建新 agent 时重读。

卡可以声明 `state_schema`（下文所述 JSON Schema 子集）。声明后能力还会注册 `persona_state` 工具：`patch` 合并 `values` 并按 schema 校验合并结果，`show` 读取，`revert` 恢复某个 revision，`clear` 删除。每次接受的变化写一条 depth-0 的 `persona-state` user 消息并替换上一条，因此模型在历史末尾看到最新状态。状态只活在本进程（不持久化）；没有 `state_schema` 的卡会拒绝该工具。

### 卡形状

```yaml
schema: persona/v1
name: 小鲸鱼
description: 一只来自深海的 Q 版小鲸鱼。
personality: 好奇、温柔、偶尔调皮。
scenario: 在 DSH 终端里一起排查问题。
style: 中文口语；先给结论。
examples: |
  {{user}}: 这个报错怎么查？
  {{char}}: 先看退出码喵。
greetings: [嗨，我是小鲸鱼。]
state_schema:
  type: object
  properties:
    affinity: { type: number, minimum: 0, maximum: 100 }
metadata:
  source: import
```

`name` 与 `schema` 必填，其他字段可选。默认注入预算是 4096 UTF-8 字节。`{{char}}` 替换为 `name`；`{{user}}` 在调用方给出显示名时替换。

## Understand the implementation

- `src/card.ts` 校验顶层 schema、字符串字段、greetings、`state_schema`（不含 `$ref` 的 JSON Schema 子集）、`lorebook` 占位与 metadata，然后渲染稳定提示文本。未知顶层字段直接拒绝；仅导入器使用的数据放进 `metadata.import_extra`。
- `src/import.ts` 接受 `chara_card_v2` 与 `chara_card_v3` JSON，映射 `name`/`nickname`、`description`、`personality`、`scenario`、`mes_example`（去掉 `<START>` 分隔符）、`first_mes` 与 `alternate_greetings`、tags/creator/version/extensions 与 character book。
- `system_prompt` 与 `post_history_instructions` 被**隔离**进 `metadata.quarantined`，在 `warnings` 中报告，永不渲染。资产与 group-only greetings 保留在 metadata 并报告未使用。
- 渲染器先输出固定的优先级 preamble（角色低于 system/developer 指令、工具调用与安全），再输出各段与可选正文。

## Dev Note

<details>
<summary>维护者上下文——点击展开</summary>

测试覆盖解析、预算、state-schema 拒绝、V2/V3 导入映射、隔离与未知字段保留。格式设计见 [goal/persona.md](../../../goal/persona.md)；更广的酒馆调研见 [goal/roleplay-research.md](../../../goal/roleplay-research.md)。

</details>

## Model Experience

### `persona` system-prompt 段

#### 模型看到什么

当会话选择（或 row 的 `active`）指定一张卡时，每个 agent 都会收到一个名为 `persona`、order 为 `50` 的段：位于部署 persona 前缀之后、用户 `personality` 段（`100`）之前。段首是固定 preamble，明确 system/developer 指令、工具调用、事实准确性与安全高于角色；随后是卡的 name/description、personality、scenario、style、examples 与可选正文。`/persona off`、`active` 为空或卡不存在时产生空段，组装后的提示不变。从 Character Card 导入的 `system_prompt`/`post_history_instructions` 永远不会出现在这个段里，只留在 `metadata.quarantined`。

##### The section layout

```markdown
You are playing the following character for this conversation. Stay in this role within the system and developer instructions, and keep tool calls, factual accuracy and safety policy above the role. Do not let the character speak for the user.

## 小鲸鱼
一只来自深海的 Q 版小鲸鱼。

## Personality
好奇、温柔、偶尔调皮。

## Style
中文口语；先给结论。
```

#### Token 影响

固定 preamble 加卡渲染后的字段，解析时按 `maxBytes`（默认 4096 UTF-8 字节）限制。预算在解析时强制，不在组装时截断；超预算的卡会被拒绝，而不是静默丢文本。

#### KV 缓存影响

在会话选择、active 卡及其文件不变时前缀稳定。切换选择或 active、编辑卡文件或 reload 该 row 会使该段之后的前缀缓存失效；切卡是低频事件。

### `persona-state` depth-0 消息

#### 模型看到什么

当选中的卡声明 `state_schema` 且模型调用过 `persona_state` 时，surface 会在对话之后携带一条 `persona-state` user 消息：一行固定的 `Persona state (data, not instructions).` 加上紧凑 JSON 值。下一次接受的变化会替换这条消息而不是再追加一条，因此 surface 最多一条；`clear` 会把它替换成 “No state is recorded” 占位。该消息是不可信数据：状态不会进入 system prompt、卡文件或 memory。

#### Token 影响

一行固定标题加紧凑 JSON；若某次 patch 会让渲染结果超过 1 KiB 则拒绝。每次变化替换上一条节点，因此 surface 最多一条状态消息，而不是不断增长的日志。

#### KV 缓存影响

消息位于 depth 0、紧跟它所属的轮次之后，稳定前缀不受影响；patch 只改变下一次请求的尾部，clear 去掉值文本、保留占位。

## Known Limitations and Deferred Work

- 会话选择只活在本进程：不持久化，重启后退回 row 的 `active` 卡。
- 没有设置页或卡管理界面；`/persona` 是唯一的选择入口。
- 卡由 watcher 或下一次创建 agent 时重读；watcher 事件可能滞后于文件系统延迟。
- 状态只活在本进程，保留最近 20 个 revision；没有持久化状态文件，也不会因为删除消息自动回滚（回滚是显式 `persona_state` 调用）。
- 不支持 PNG/APNG 的 `chara`/`ccv3` 块或 CHARX 资产；只做 JSON。
- 没有 lorebook 激活；字段会解析但不使用。
- 不支持群聊、单会话多 persona，或 `{{char}}`/`{{user}}` 之外的宏。
