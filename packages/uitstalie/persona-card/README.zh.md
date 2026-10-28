---
description: "角色扮演角色卡格式：persona/v1 的纯校验器与渲染器，以及安全的 Character Card V2/V3 JSON 导入器。与部署 persona 预设包 @deepseek-ai/dsh-persona 不同。"
kind: "package-reference"
---

# @deepseek-ai/dsh-persona-card

[English](README.md) | 中文

## Summary

`persona-card` 持有角色扮演会话中稳定的助手侧角色：`persona/v1` 卡格式、无依赖的校验器与提示渲染器，以及 Character Card V2/V3 JSON 的安全导入器。

它不是部署 persona。`@deepseek-ai/dsh-persona`（位于 `packages/preset/persona`）是给单个 agent 部署前缀/后缀的预设行；本包是角色扮演角色卡的数据格式与导入路径，供未来的能力挂载。它目前不注册服务、工具或 system-prompt 段。

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

本包是纯的：不碰文件系统、不依赖 Cordis 上下文、不联网。卡存在哪里、渲染文本何时进入提示，由宿主决定。

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

## Known Limitations and Deferred Work

- 还没有运行时能力：没有 `ctx` 服务、没有 system-prompt 段、没有 per-session 选择、没有命令或设置页。
- 不支持 PNG/APNG 的 `chara`/`ccv3` 块或 CHARX 资产；只做 JSON。
- 没有 lorebook 激活、`state_schema` 强制执行或状态注入；字段为后续 DH-402/DH-403 保留。
- 不支持群聊、单会话多 persona，或 `{{char}}`/`{{user}}` 之外的宏。
