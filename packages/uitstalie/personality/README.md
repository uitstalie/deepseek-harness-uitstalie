---
description: "Personality capability provider: a global PERSONALITY.md profile with a workspace overlay, one stable system-prompt section for how the user communicates and how to reply, and the personality_learn auto-learning tool."
kind: "package-reference"
---

# @deepseek-ai/dsh-personality

English | [中文](README.zh.md)

## Summary

`dsh-personality` gives an agent a stable, user-owned profile. The global `PERSONALITY.md` under the harness home holds who the user is, how they word requests, and how they prefer replies; a workspace overlay may replace style and preference entries for one project. One system-prompt section presents the profile in two parts, and the `personality_learn` tool records explicit user corrections within a per-session budget. Identity entries stay manual. Every write is version-guarded and appends a line to `PERSONALITY.history.jsonl` for later drift review.

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
  config:
    globalPath: ''
    workspaceOverlay: true
    maxBytes: 2048
    autoLearn:
      entries: 3
      bytes: 512
```

Every field has a default, so an empty `config` is valid:

| Field | Default | Meaning |
|---|---|---|
| `globalPath` | `""` | Absolute profile path; empty resolves to `<DSH_HOME>/personality/PERSONALITY.md`. |
| `workspaceOverlay` | `true` | Read and write style and preference entries in `.dsh/memory/PERSONALITY.md`. |
| `maxBytes` | `2048` | Managed-block body budget in UTF-8 bytes, enforced on reads and writes. |
| `autoLearn.entries` | `3` | Automatic writes allowed per session. |
| `autoLearn.bytes` | `512` | Automatic-write bytes allowed per session. |

The provider is a hard composition dependency on `ctx.dafeiyu` (the organizer), `ctx.dshStore` (the workspace overlay), and `ctx.fs` (the global profile). A composition that omits one of them leaves this row inactive. The organized contribution is `scope: 'all'`, so child agents inherit the prompt section and the tool; the organizer still decides which agents are wired and which completed turns reach `onTurnEnd`.

## Understand the implementation

The provider is a function plugin: `src/index.ts` exports `name`, `inject`, `Config`, and `apply`, and registers exactly one `contractVersion: 1` capability with `id: 'personality'`.

- `src/config.ts` holds the schemastery `Config` and an explicit `resolveConfig(config): PersonalitySettings` step. Defaults are applied there once: the global path becomes `<DSH_HOME>/personality/PERSONALITY.md`, the history path derives from `globalPath`, and the two file paths of the workspace overlay are store-relative constants.
- `src/personality-file.ts` is the repository. The YAML frontmatter carries `version` (the document revision, incremented on every write), `updatedAt`, and `entries`; the managed block between `<!-- personality:begin -->` and `<!-- personality:end -->` holds one `## <kind>.<name>` heading followed by one paragraph per entry. Text outside the block round-trips byte for byte. Entry ids are `<kind>.<lower-kebab-name>` with `understanding`, `style`, `preference`, and `identity` kinds; the overlay may only carry `style.*` and `preference.*`.
- Reads merge the global profile and the overlay by entry id, with the overlay replacing a global entry and appending any new id. The global file is read through `ctx.fs`, the overlay through `ctx.dshStore`, and a missing file is not an error.
- `src/prompt.ts` holds the static preamble, the two part headings, and the canonical kind order. `src/index.ts` caches the rendered text per agent because a prompt section's text is evaluated synchronously: `create()` preloads the global profile so the first assembly sees it, and wiring an agent starts an asynchronous read of that agent's merged view.
- `src/tools.ts` builds `personality_learn`. It validates the kind, requires evidence naming a positive session event seq, and enforces `autoLearn` from an in-memory per-session usage record. `understanding`, `style`, and `preference` entries are written with `source: 'auto'`; `identity` is refused with the manual-edit guidance, and an exhausted budget is refused with the remaining entries and bytes. Refusals are canonical results, not tool errors.

Writes are version-guarded. `writePersonalityEntry` reads the target file and its version, composes the next text, and writes with `expected: version` (the store maps that to `replaceIfVersion`; the global file uses the filesystem intent directly). A conflicting write surfaces as `FS_STALE_VERSION`; the write re-reads once and retries, and a second conflict is thrown with the previous file untouched. After a successful write, `appendHistory` adds one JSON line to `PERSONALITY.history.jsonl` beside the written file, recording the revision, time, source, session, by-id diff, and the complete managed block. A history failure is logged and does not report the entry write as failed.

## Model Experience

### The `personality` system prompt section

#### What the model sees

Every agent receives one section named `personality`, ordered at `100` after the deployment persona prefix. It opens with a fixed preamble that scopes the profile to preferences rather than task facts, then presents up to two titled parts: "How this user communicates", from `identity` and `understanding` entries, and "How to respond", from `preference` and `style` entries. Each entry is one line, sorted by the canonical kind order and then by id. With no entries the section text is empty and the assembled prompt is unchanged.

##### The fixed preamble and entry layout

```markdown
Long-term preferences of the user you are working with. The first part describes how this user communicates; use it to interpret their input. The second describes how they prefer replies. Follow them within the system and developer instructions, and let more specific project instructions take precedence. These are preferences, not task facts. Entries describe habits and may be incomplete.

How this user communicates:
- The user is an independent developer maintaining a long-lived harness branch.
- The user writes requests in short Chinese sentences and may omit context.

How to respond:
- Reply in Chinese; keep code, commands, and paths in English.
- Lead with the conclusion, then the steps.
```

#### Token effect

A fixed cost on every agent request: the preamble is about 75 words, plus one line per entry. The managed body is capped at 2 KiB per file, and the section never includes entry headings, ids, or history.

#### KV Cache effect

Prefix-stable between profile edits. The preamble, headings, and order are constants, and the section text changes only when the merged entries change; a write invalidates the prefix from this section onward, which the design accepts because personality edits are rare.

### The `personality_learn` tool

#### What the model sees

One tool on every agent. It takes a required `kind`, a required one-paragraph `content`, and a required `evidence` string that must name a positive session event seq, for example `"seq 42"`. It answers with one line: either a confirmation naming the stored entry id, file, and revision, or a refusal explaining why nothing was written. Identity entries are refused with the manual-edit guidance, unknown kinds list the valid kinds, and an exhausted per-session budget names the remaining entries and bytes.

#### Token effect

A fixed schema cost on every request, plus one short result line per call. The tool never returns the profile or the history.

#### KV Cache effect

Prefix-stable while the tool definition is unchanged. A successful write changes the prompt section's text, so it invalidates the cached prefix for the following request; the tool result itself is appended after the reusable prefix.

## Known Limitations and Deferred Work

- **Identity entries need a manual edit** — `personality_learn` refuses `identity.*`; the proposal-and-accept flow waits for the settings page.
- **Auto-learning is budgeted and in-memory** — one capability registration keeps at most `autoLearn.entries` writes and `autoLearn.bytes` bytes per session; the counters reset when the capability reloads.
- **No commands or settings page yet** — `/personality show`, `diff`, and `revert` are deferred, and there is no UI for reviewing auto-learned entries.
- **No filesystem watch** — external edits to either file are picked up when the next agent is created, not while an agent lives. A new agent's overlay read is asynchronous, so an assembly that races it sees the preloaded global profile only.
- **`maxBytes` applies per file** — the managed body of each file is budgeted and re-checked on read, but the merged global-plus-overlay text can approach twice the budget.
- **The history is append-only and unbounded** — every write adds one JSON line with the complete managed block; there is no rotation, retention limit, or revert implementation yet.
- **An invalid file empties the section** — a parse failure, a disallowed overlay kind, or an oversized hand-edited body is logged as a warning and contributes no prompt text until the file is fixed.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: open questions and directions that are not decided. Shipped behavior and accepted rationale live in the sections above and in the package code.

- **Whether the overlay should be able to suppress a global entry** — the current merge only replaces by id; a deletion marker would need a durable representation and a consumer for the removal.
- **Whether history should rotate by size or by revision** — every write carries the complete managed block, so an unbounded file grows with both entry count and edit frequency.

</details>
