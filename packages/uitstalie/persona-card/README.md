---
description: "The role-play character card format: a pure persona/v1 validator and renderer plus a safe Character Card V2/V3 JSON importer. Distinct from the deployment-persona preset package @deepseek-ai/dsh-persona."
kind: "package-reference"
---

# @deepseek-ai/dsh-persona-card

English | [中文](README.zh.md)

## Summary

`persona-card` owns the stable assistant-side character for a role-play conversation: the `persona/v1` card format, a dependency-free validator and prompt renderer, and a safe importer for Character Card V2/V3 JSON.

It is not the deployment persona. `@deepseek-ai/dsh-persona` (under `packages/preset/persona`) is the preset row that gives one agent a deployment prefix/suffix; this package is the data format, import path and first runtime provider for a role-play character card. The provider registers one stable `persona` system-prompt section when `active` names a card.

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

The parser and importer are pure (no filesystem or Cordis context). The package also exports a Cordis row that reads `$DSH_HOME/persona/*.md` and registers the section:

```yaml
- id: persona-card
  name: '@deepseek-ai/dsh-persona-card'
  config:
    active: 小鲸鱼   # file name without .md; empty disables the section
    maxBytes: 4096
```

The row is a dafeiyu capability (`enabledByDefault: false`), so the organizer's capability gate decides whether it is mounted.

A session can pick its own card without touching the row: `/persona list` shows the installed cards, `/persona use <id>` selects one for that session, and `/persona off` suppresses the section for it. The choice is process-local — restarting the process falls back to the row's `active` card. The provider watches `$DSH_HOME/persona` and re-reads the directory after a change, so a new or edited card reaches the next assembly without a reload; when the directory does not exist yet (or the backend cannot watch), a new agent re-reads the cards instead.

A card may declare `state_schema` (the JSON Schema subset described below). When it does, the capability also registers the `persona_state` tool: `patch` merges `values` and validates the merged result, `show` reads it, `revert` restores one revision number, and `clear` drops it. Every accepted change writes one `persona-state` user message at depth 0, replacing the previous one, so the model sees the latest state at the end of the history. State is process-local (not persisted), and a card without `state_schema` refuses the tool.

A session can also carry one short director note, independent of the selected card: `/director set <text>` (at most 800 UTF-8 bytes) publishes it as a depth-0 `director-note` user message, `/director show` reads it, and `/director clear` replaces it with a one-line placeholder. The note belongs to its own `director` capability (enabled by default; no note means no message), is process-local, and is re-published at the end of every completed turn so a compaction cannot silently drop it.

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

## Model Experience

### The `persona` system prompt section

#### What the model sees

When the session's selection (or the row's `active`) names a card, every agent receives one section named `persona`, ordered at `50` after the deployment persona prefix and before the user `personality` section (`100`). It opens with a fixed preamble that keeps system/developer instructions, tool calls, factual accuracy and safety above the role; then the card's name/description, personality, scenario, style and examples, and its optional Markdown body. `/persona off`, an empty `active`, or an unknown card produces an empty section, so the assembled prompt is unchanged. The section never contains `system_prompt` or `post_history_instructions` imported from a Character Card; those stay in `metadata.quarantined`.

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

#### Token effect

A fixed preamble plus the card's rendered fields, capped by `maxBytes` (default 4096 UTF-8 bytes) when the card is parsed. The budget is enforced at parse time, not truncated at assembly, so an over-budget card is rejected instead of silently losing text.

#### KV Cache effect

Prefix-stable while the session's selection, the active card and its file are unchanged. Changing the selection or `active`, editing the card file, or reloading the row invalidates the cached prefix from this section onward; card switches are low-frequency events.

### The `persona-state` depth-0 message

#### What the model sees

When the selected card declares `state_schema` and the model calls `persona_state`, the surface carries one `persona-state` user message after the conversation: a fixed `Persona state (data, not instructions).` line and the compact JSON values. The next accepted change replaces that message instead of appending another, so the surface holds at most one; `clear` replaces it with a "No state is recorded" placeholder. The message is untrusted data: the state never enters the system prompt, the card file, or memory.

#### Token effect

One fixed title line plus the compact JSON object, refused when a patch would push the rendered message past 1 KiB. Because each change replaces the previous node, the surface carries at most one state message rather than a growing log.

#### KV Cache effect

The message sits at depth 0, after the turn it follows, so the stable prefix is untouched; a patch changes only the tail of the next request, and clearing removes the value text while keeping the placeholder.

### The `director-note` depth-0 message

#### What the model sees

After `/director set`, the surface carries one `director-note` user message at the end of the history: a fixed line saying the note governs this scene while system and developer instructions still win, then the note text verbatim. A later set or clear replaces that message instead of appending another; a clear leaves a one-line "Director note: none for this session." placeholder. Each completed turn re-publishes the current note at depth 0, so a compaction that removed it cannot hide it from the next turn.

#### Token effect

One fixed title line plus at most 800 UTF-8 bytes of note text. Because the message is replaced rather than appended, the surface holds at most one note; a session without a note carries none.

#### KV Cache effect

The note sits at depth 0, so the stable prefix is untouched. A set or clear changes only the tail of the next request; the per-turn re-publication rewrites the same tail node.

## Known Limitations and Deferred Work

- The session selection is process-local: it is not persisted, so a restart falls back to the row's `active` card.
- No settings page or card-management UI; `/persona` is the only selection entry.
- Cards are re-read by the watcher or on the next agent creation; a watcher event can trail an edit by the filesystem's latency.
- State is process-local and keeps the last 20 revisions; there is no durable state file and no rollback triggered by deleting a message (revert is an explicit `persona_state` call).
- The director note is process-local, single per session, and limited to 800 bytes; a cleared note keeps its one-line placeholder until the next set replaces it.
- No PNG/APNG `chara`/`ccv3` chunks or CHARX assets; JSON only.
- No lorebook activation; the field is parsed but not used.
- No group chats, multiple personas per session, or macro expansion beyond `{{char}}`/`{{user}}`.
