---
description: "The role-play character card format: a pure persona/v1 validator and renderer plus a safe Character Card V2/V3 JSON importer. Distinct from the deployment-persona preset package @deepseek-ai/dsh-persona."
kind: "package-reference"
---

# @deepseek-ai/dsh-persona-card

English | [中文](README.zh.md)

## Summary

`persona-card` owns the stable assistant-side character for a role-play conversation: the `persona/v1` card format, a dependency-free validator and prompt renderer, and a safe importer for Character Card V2/V3 JSON.

It is not the deployment persona. `@deepseek-ai/dsh-persona` (under `packages/preset/persona`) is the preset row that gives one agent a deployment prefix/suffix; this package is the data format and import path for a role-play character card that a future capability mounts. It does not register a service, a tool or a system-prompt section yet.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Dev Note](#dev-note)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use this package

Parse an untrusted `persona/v1` object, render it, or import a SillyTavern-style card:

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

The package is pure: no filesystem, no Cordis context, no network. Hosts own where cards live and when the rendered text enters a prompt.

### Card shape

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

`name` and `schema` are required; every other field is optional. The default injection budget is 4096 UTF-8 bytes. `{{char}}` becomes `name`; `{{user}}` becomes the caller's display name when supplied.

## Understand the implementation

- `src/card.ts` validates the top-level schema, string fields, greetings, `state_schema` (a JSON Schema subset without `$ref`), `lorebook` placeholders and metadata, then renders the stable prompt text. Unknown top-level fields are rejected; importer-only data goes under `metadata.import_extra`.
- `src/import.ts` accepts `chara_card_v2` and `chara_card_v3` JSON. It maps `name`/`nickname`, `description`, `personality`, `scenario`, `mes_example` (with `<START>` separators removed), `first_mes` plus `alternate_greetings`, tags/creator/version/extensions and the character book.
- `system_prompt` and `post_history_instructions` are **quarantined** into `metadata.quarantined`; they are reported in `warnings` and never rendered. Assets and group-only greetings are preserved in metadata and reported as unused.
- The renderer emits the fixed priority preamble (role stays below system/developer instructions, tool calls and safety), then the card's sections and optional body.

## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The tests cover parsing, budget, state-schema rejection, V2/V3 import mapping, quarantine and unknown-field preservation. The format design lives in [goal/persona.md](../../../goal/persona.md); the broader tavern survey is [goal/roleplay-research.md](../../../goal/roleplay-research.md).

</details>

## Known Limitations and Deferred Work

- No runtime capability yet: no `ctx` service, no system-prompt section, no per-session selection, no command or settings page.
- No PNG/APNG `chara`/`ccv3` chunks or CHARX assets; JSON only.
- No lorebook activation, `state_schema` enforcement or state injection; the fields are parsed for the follow-up tasks DH-402/DH-403.
- No group chats, multiple personas per session, or macro expansion beyond `{{char}}`/`{{user}}`.
