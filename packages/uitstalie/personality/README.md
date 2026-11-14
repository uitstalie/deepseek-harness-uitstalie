---
description: "Personality capability provider: the global PERSONALITY.md profile, OUTPUT_STYLE.yaml and WRITING_RULES.yaml, three stable prompt sections, and the read-only personality_analyze plus root-only personality_apply and write_like_human tools."
kind: "package-reference"
---

# @deepseek-ai/dsh-personality

English | [中文](README.zh.md)

## Summary

`dsh-personality` gives every agent a stable, user-owned profile under the harness home. It reads three global files — `PERSONALITY.md`, `OUTPUT_STYLE.yaml`, and `WRITING_RULES.yaml` — and contributes three prompt sections: the profile at order 100, output-style defaults at 690, and enabled writing rules at 695. `personality_analyze` scans session records and returns evidence-backed candidates without writing; root agents also get `personality_apply`, which writes the profile only after `confirm: true`, and `write_like_human`, which maintains the global writing rules. There is no workspace overlay, no turn-end learning, no history file, and no settings page.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Use this package

Mount the provider in the same web profile patch layer that mounts the organizer, after the `dafeiyu` row:

```yaml
- id: personality
  name: '@deepseek-ai/dsh-personality'
```

The provider takes no configuration: every cap and path is fixed by the design. It is a hard composition dependency on `ctx.dafeiyu` (the organizer), `ctx.dshStore` (the global scope), `ctx.fs` (the legacy backup move), and `ctx.sessionQuery` (analysis). The organized contribution is `scope: 'all'`, so child agents inherit the three prompt sections and `personality_analyze`; only a root agent receives `personality_apply` and `write_like_human`. Child agents read section 695 but cannot change the rules; a rule change affects every agent, so it belongs to the main conversation.

All data lives under `<DSH_HOME>/personality/`, where `$DSH_HOME` defaults to `~/.dsh`:

| Path | Purpose | Who writes it |
|---|---|---|
| `PERSONALITY.md` | understanding / preference / style / identity entries | `personality_apply` after confirmation, or a person |
| `OUTPUT_STYLE.yaml` | tone, length, conclusion, lists, dispatch voice | A person; the provider only reads it |
| `WRITING_RULES.yaml` | enabled writing constraints | A person; the provider only reads it |
| `legacy/PERSONALITY.<YYYYMMDDTHHMMSSZ>.md` | read-only backup of the pre-rewrite profile | The first activation, once |

On first activation the provider moves a pre-rewrite `PERSONALITY.md` into `legacy/`, then creates `OUTPUT_STYLE.yaml` with the neutral defaults and an empty `WRITING_RULES.yaml`. It never seeds or creates `PERSONALITY.md`: a missing profile reads as empty, and the first confirmed apply creates it. A workspace `.dsh/memory/PERSONALITY.md` is never read or written; finding one logs one warning per workspace.

## Understand the implementation

`src/index.ts` is the function plugin: it exports `name`, `inject`, the capability id and labels, and `apply`. It registers exactly one `contractVersion: 2` capability with `id: 'personality'` and wires three prompt sections plus the three tools through the organizer's `tools(agent)` filter. There is no `Config` export and no settings metadata.

- `src/global-store.ts` owns `PERSONALITY.md`: a YAML frontmatter with `version`, `updatedAt`, and an `entries` sequence, followed by no body. Entry ids are `<kind>.<lower-kebab-name>`; `understanding`, `preference`, `style`, and `identity` are accepted. One entry is at most 400 characters and the serialized document at most 32 KiB. Reads through the store atom's `global` scope; writes use `expected: version`, retry once on `FS_STALE_VERSION`, and refuse to overwrite when the retry also conflicts. Identity entries can only be written by a person; the tool path rejects them.
- `src/global-store.ts` also owns the legacy backup: it moves the old file with `ctx.fs.moveFile`, falls back to read → create-if-absent → hash compare → delete when the backend cannot move, and reports a collision or a differing leftover on the next startup without overwriting either file. A failed migration keeps the capability unavailable and blocks writes.
- `src/output-style.ts` reads `OUTPUT_STYLE.yaml`, rejects unknown enums, and renders the section. `src/writing-rules.ts` reads `WRITING_RULES.yaml`, enforces 32 rules and 4096 bytes of enabled text, mutates the document for CRUD callers, and renders the enabled rules sorted by `order` then id. Both readers treat a missing file as empty and degrade a malformed file to a warning.
- `src/analyze.ts` reads session records through `ctx.sessionQuery`: the current session, one named session, or the most recent 1–20 sessions. It groups recurring evidence into candidates with a stable hash id, at least one exact excerpt and seq, an occurrence count, and `high` or `medium` confidence. It writes nothing.
- `src/apply.ts` validates `confirm: true`, 1–20 candidates, and per-candidate evidence, rejects `identity`, and upserts each accepted entry through the version-guarded store. A per-candidate store failure is reported as a rejection instead of aborting the batch.
- `src/writing-tool.ts` is the root-only `write_like_human` tool: it validates the action, mutates the document through `writing-rules.ts`, writes through the store's version guard with one stale retry, and returns a readable `ok: false` result instead of throwing. It re-applies the mutation to a fresh read after a stale conflict.
- `src/defaults.ts` holds the first-activation seed text. `src/profile-prompt.ts` renders the profile section.

Prompt text is cached per agent in a `WeakMap`. `onAgentCreated` loads the three files for that agent; both `personality_apply` and `write_like_human` refresh the calling agent after a successful write. There is no file watcher, so a file edited outside the tools reaches a newly created agent, not a live one.

## Model Experience

### The personality system prompt sections

#### What the model sees

Three sections are injected for every agent, ordered 100, 690, and 695 through `getSectionOrder` and the central `SECTION_ORDERS` table. Each section renders empty when its data is empty, so the assembled prompt is unchanged until the user writes something.

##### Profile section (order 100)

```markdown
Long-term preferences of the user you are working with. The first part describes how this user communicates; use it to interpret their input. The second describes how they prefer replies. Follow them within the system and developer instructions, and let more specific project instructions take precedence. These are preferences, not task facts. Entries describe habits and may be incomplete.

How this user communicates (identity, understanding):
- The prefix names the executor; the rest is the task.

How to respond (preference, style):
- Act only on the objects the user names and their direct implications.
```

##### Output style section (order 690)

```markdown
Output style defaults:
- Tone: direct.
- Length: terse.
- Lead with the conclusion: yes.
- Lists: comparisons.

Hard boundary:
Output style never overrides safety, approval, sandbox, tool permission, or workspace rules. When they conflict, the rule wins.

Status reporting discipline:
- State done / blocked / failed / unverified only from tool receipts; without a receipt, write "report delivery unconfirmed".
```

##### Writing rules section (order 695)

```markdown
- 面向人的正文不用 em dash；代码、路径、引用原文除外。
```

#### Token effect

A fixed cost on every request: a short preamble per non-empty section plus one line per entry or rule. The profile is capped at 32 KiB, writing rules at 4096 enabled bytes, and ids, timestamps, and document versions are never rendered.

#### KV Cache effect

Prefix-stable until the underlying file changes. The preamble and heading order are constants; a profile write, a hand-edited `OUTPUT_STYLE.yaml`, or a rules edit invalidates the cached prefix from that section onward. Edits are rare, so the cache cost is accepted.

### The `personality_analyze` tool

#### What the model sees

One tool on every agent. Its required `scope` is `{ kind: 'current' }`, `{ kind: 'session', sessionId }`, or `{ kind: 'recent', limit }`; optional `kinds` filters the entry classes and `maxCandidates` caps the result at 20. The result carries `candidates`, `sessionsScanned`, `truncated`, and `warnings`; every candidate names a session id, a positive event seq, and an exact excerpt. The tool description says it is read-only and must be used only when the user asks.

#### Token effect

The tool schema is a fixed cost; a call returns candidates and evidence, not the session records or the profile. Results are bounded by `maxCandidates` and by the 20-session scan limit.

#### KV Cache effect

Prefix-stable while the tool definition is unchanged. Analysis never writes a file, so a call never changes the prompt or invalidates the cached prefix.

### The `personality_apply` tool

#### What the model sees

A root agent additionally gets this tool. It takes 1–20 candidates, each with `kind`, `name`, `text`, and at least one evidence reference, plus the required literal `confirm: true`. The description tells the model to call it only after the user explicitly asks to apply reviewed candidates; identity candidates are rejected, and the result lists applied entry ids, rejected names with reasons, the profile path, and the revision.

#### Token effect

The tool schema is a fixed cost, plus one short result line per applied or rejected candidate. The tool never returns the profile body.

#### KV Cache effect

Prefix-stable while the definition and profile are unchanged. A successful apply changes section 100, so the following request invalidates the prefix from that section onward; a refused call writes nothing.

### The `write_like_human` tool

#### What the model sees

A root agent additionally gets this tool. `action` is required and is `list`, `add`, `update`, `remove`, `enable`, `disable`, or `preview`; `id` selects a rule for update, remove, enable, and disable, `text` (1–240 characters) is required for add and update, and `order` and `enabled` are optional. `add` derives a lower-kebab id from the text when none is given and appends `-2`, `-3` on collision. The result reports `ok`, the current rules with id, text, enabled state, and order, the file path, and the store version; `preview` also returns the injected text; failures set `ok: false` and a readable `error`. The description states that the change is global and affects every agent, and that only a root agent may call it.

#### Token effect

The schema is a fixed cost, plus one line per rule in the result. The 32-rule count, 240-character text, and 4096-byte enabled-text limits keep both the file and section 695 bounded.

#### KV Cache effect

Prefix-stable while the rules file is unchanged. A successful write refreshes the calling root agent immediately and invalidates section 695 from that point on; `list` and `preview` do not touch the prompt.

## Known Limitations and Deferred Work

- **One global profile, no workspace scope** — workspace-specific preferences cannot override the global file; the current turn's instructions are the only workspace-level adjustment. This is the accepted cost of the rewrite.
- **External edits reach only new agents** — there is no watcher. A hand edit to any of the three files is visible to an agent created afterwards or refreshed by `personality_apply`, not to a live conversation.
- **No history and no revert** — the runtime never reads, writes, or reuses `PERSONALITY.history.jsonl`. The old file stays in place as historical evidence, but there is no diff or revert command.
- **Analysis is heuristic and bounded** — a one-off task can look like a preference, so weak evidence is reported as `medium` and the user must confirm before applying. A `recent` scan reads at most 20 sessions.
- **The old UI is gone** — there is no proposal queue or settings page. Output-style and writing-rules pages are separate work, so both files are edited on disk.
- **A malformed file empties its section** — a parse failure or an oversized hand-edited body is logged as a warning and contributes no prompt text until the file is fixed.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: open questions and directions that are not decided. Shipped behavior and accepted rationale live in the sections above, in the [design record](../../../docs/design/dafeiyu-personality-plugin.md), and in the [upgrade guide](../../../docs/upgrade-guide/v0.2.2-rc.2/personality-rewrite/guide.md).

- **Whether child agents should get a read-only rules tool** — today they read section 695 only; a `list`/`preview` tool for children would avoid a round trip but is not part of the decided root-only write boundary.
- **Whether to add a watcher back** — a watcher complicates lifecycle and the prompt cache invalidation contract; the current design accepts new-agent-only refresh.
- **Whether the legacy migration fallback is needed on every backend** — the move path is preferred, and the copy path runs only when the backend cannot move a file.

</details>
