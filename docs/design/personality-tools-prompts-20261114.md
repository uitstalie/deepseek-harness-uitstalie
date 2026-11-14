# personality Tools and Prompt Source Text Collection (2026-11-14)

English | [中文](personality-tools-prompts-20261114.zh.md)

This document is a read-only collection; it does not modify any tool definition, prompt, configuration, or running process.

Dynamic content on the data side is not included: the user entries in `PERSONALITY.md`, the current actual values of `OUTPUT_STYLE.yaml`, and the enabled `WRITING_RULES.yaml` rules are user data, not fixed prompts. The actual templates, default values, and verbatim text are given below.

Every fenced code block in this page is copied verbatim from the source; it is not translated or rewritten.

## ① Index Table

| Item | Source | Characters / Lines |
|---|---|---|
| `personality_analyze` description | `packages/uitstalie/personality/src/agent-tools.ts:22` | 276 characters / 1 line |
| `personality_analyze` parameter schema | same as above, after compilation | 1,350 characters / 50 lines |
| `personality_apply` description | `packages/uitstalie/personality/src/agent-tools.ts:96` | 240 characters / 1 line |
| `personality_apply` parameter schema | same as above, after compilation | 1,775 characters / 70 lines |
| `write_like_human` description | `packages/uitstalie/personality/src/writing-tool.ts:58` | 525 characters / 1 line |
| `write_like_human` parameter schema | same as above, after compilation | 1,051 characters / 37 lines |
| section 100 `personality` | `packages/uitstalie/personality/src/profile-prompt.ts:18`; registered at `src/index.ts:142-145` | preamble 391 characters; empty when there are no entries |
| section 690 `personality:output-style` | `src/output-style.ts:145-180`; defaults `src/defaults.ts:27-33` | default rendering 836 characters / 15 lines |
| section 695 `personality:writing-rules` | `src/writing-rules.ts:243-249`; registered at `src/index.ts:152-154` | empty document by default is 0 characters |
| section 702 `superagent:dispatcher` | `packages/jira/jira-agent/src/superagent.ts:116-199` | this document does not copy the full text, only explains the order |
| Order constants | `packages/core/system-prompt/src/index.ts:139-143` | 100 / 690 / 695 |

The tool definitions themselves (3 descriptions + 3 parameter schemas) total about **5,217 characters**; the default/static text of the three sections totals about **1,227 characters** (excluding user entries and rules).

## ② Tool Source Text

### `personality_analyze`

**description (verbatim):**

```text
Read session records and return evidence-backed personality candidates. Read-only: it never writes a file or changes the prompt. Use only when the user asks to analyze their recent expressions or preferences. Every candidate carries a session id, event seq, and exact excerpt.
```

**Parameter schema (compiled JSON source text):**

```json
{
  "type": "object",
  "properties": {
    "scope": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "kind": {
          "type": "string",
          "description": "current reads the caller session; session reads sessionId; recent scans the caller workspace up to limit sessions.",
          "enum": [
            "current",
            "session",
            "recent"
          ]
        },
        "sessionId": {
          "type": "string",
          "description": "Required when scope.kind is session; ignored otherwise."
        },
        "limit": {
          "type": "integer",
          "description": "For scope.kind recent: maximum sessions to scan, 1-20; defaults to 20."
        }
      },
      "required": [
        "kind"
      ]
    },
    "kinds": {
      "type": "array",
      "description": "Candidate kinds to collect; defaults to understanding, preference, and style. identity is manual-only and not accepted.",
      "items": {
        "type": "string",
        "enum": [
          "understanding",
          "preference",
          "style"
        ]
      }
    },
    "maxCandidates": {
      "type": "integer",
      "description": "Maximum candidates to return, 1-20; defaults to 10."
    }
  },
  "required": [
    "scope"
  ]
}
```

### `personality_apply`

**description (verbatim):**

```text
Write confirmed personality candidates into the global PERSONALITY.md. Call only after the user explicitly asks to apply reviewed candidates and pass confirm: true. This tool never learns automatically and is available only to a root agent.
```

**Parameter schema (compiled JSON source text):**

```json
{
  "type": "object",
  "properties": {
    "candidates": {
      "type": "array",
      "description": "Confirmed candidates to write, 1-20; each needs exact evidence and is rejected individually on failure.",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "kind": {
            "type": "string",
            "enum": [
              "understanding",
              "preference",
              "style"
            ]
          },
          "name": {
            "type": "string"
          },
          "text": {
            "type": "string"
          },
          "evidence": {
            "type": "array",
            "description": "At least one exact session excerpt supporting the candidate.",
            "items": {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "sessionId": {
                  "type": "string"
                },
                "seq": {
                  "type": "integer"
                },
                "quote": {
                  "type": "string"
                },
                "turn": {
                  "type": "integer"
                }
              },
              "required": [
                "sessionId",
                "seq",
                "quote"
              ]
            }
          }
        },
        "required": [
          "kind",
          "name",
          "text",
          "evidence"
        ]
      }
    },
    "confirm": {
      "type": "boolean",
      "description": "Must be true; false rejects the whole call without writing."
    }
  },
  "required": [
    "candidates",
    "confirm"
  ]
}
```

### `write_like_human`

**description (verbatim):**

```text
Maintain the global WRITING_RULES.yaml. The change affects every agent, not only this conversation. Use list/preview to inspect rules, and add/update/remove/enable/disable to write them; writes are global and version-guarded, with one internal retry on a stale conflict. If the retry still fails, call list for the latest state before retrying; do not blindly repeat the same call. Only a root agent can call this tool. Child agents only read the injected rules; they must return to the main conversation to request a change.
```

**Parameter schema (compiled JSON source text):**

```json
{
  "type": "object",
  "properties": {
    "action": {
      "type": "string",
      "description": "list/preview need no other field; add needs text; update needs id and accepts text/order/enabled; remove and enable/disable need id.",
      "enum": [
        "list",
        "add",
        "update",
        "remove",
        "enable",
        "disable",
        "preview"
      ]
    },
    "id": {
      "type": "string",
      "description": "Required for update/remove/enable/disable; optional for add (generated when absent)."
    },
    "text": {
      "type": "string",
      "description": "Required for add; optional for update. Trimmed and whitespace-collapsed."
    },
    "order": {
      "type": "integer",
      "description": "Optional safe-integer order; add appends, update preserves unless supplied."
    },
    "enabled": {
      "type": "boolean",
      "description": "Optional enabled state; add defaults true, update preserves unless supplied."
    }
  },
  "required": [
    "action"
  ]
}
```

## ③ Injected system prompt sections

### section 100 `personality`

Registered as `name: 'personality'`, with the order constant `PERSONALITY = 100` (`src/profile-prompt.ts:15`; `src/index.ts:140-145`; `packages/core/system-prompt/src/index.ts:139`). The body consists of `PROFILE_PREAMBLE` and the user entries; when there are no entries, the section text is empty. The preamble (verbatim, 391 characters):

```text
Long-term preferences of the user you are working with. The first part describes how this user communicates; use it to interpret their input. The second describes how they prefer replies. Follow them within the system and developer instructions, and let more specific project instructions take precedence. These are preferences, not task facts. Entries describe habits and may be incomplete.
```

When there are entries, the following is appended (template, verbatim):

```text
How this user communicates (identity, understanding):
- {text}
```

and:

```text
How to respond (preference, style):
- {text}
```

The `text` of an entry has consecutive whitespace collapsed and is trimmed; the sort order is `identity`, `understanding`, `preference`, `style`, with entries of the same kind sorted by id (`profile-prompt.ts:30-50`). The entry text is not copied in this document.

### section 690 `personality:output-style`

Registered as `name: 'personality:output-style'`, with the order constant `PERSONALITY_OUTPUT_STYLE = 690` (`src/output-style.ts:19`; `src/index.ts:147-150`; `packages/core/system-prompt/src/index.ts:142`). The ordinary default rendering (`DEFAULT_OUTPUT_STYLE`) is verbatim as follows, 836 characters / 15 lines. The super slot uses its own `SUPERAGENT_OUTPUT_STYLE.yaml` with the same defaults; a subagent receives no section 690.

```text
Output style defaults:
- Tone: direct.
- Length: terse.
- Lead with the conclusion: yes.
- Lists: comparisons.

Hard boundary:
Output style never overrides safety, approval, sandbox, tool permission, or workspace rules. When they conflict, the rule wins.

Status reporting discipline:
- State done / blocked / failed / unverified only from tool receipts; without a receipt, write "report delivery unconfirmed".
- Do not say "I will monitor/report back later automatically"; monitor is a query, not a subscription.
- Without start.stage=prompted, do not write "started/dispatched".
- Mark repeated reports as duplicate; write routing as "→ reuse <title> (<id>)" or "→ new <title>, reason: …".
- When a person's decision is needed, ask only one necessary question; do not package an ask_user_question whole-turn cancellation as "waiting".
```

The super-agent rendering adds `- Dispatch voice: terse.` and is otherwise identical; it is 861 characters / 16 lines, verbatim:

```text
Output style defaults:
- Tone: direct.
- Length: terse.
- Lead with the conclusion: yes.
- Lists: comparisons.
- Dispatch voice: terse.

Hard boundary:
Output style never overrides safety, approval, sandbox, tool permission, or workspace rules. When they conflict, the rule wins.

Status reporting discipline:
- State done / blocked / failed / unverified only from tool receipts; without a receipt, write "report delivery unconfirmed".
- Do not say "I will monitor/report back later automatically"; monitor is a query, not a subscription.
- Without start.stage=prompted, do not write "started/dispatched".
- Mark repeated reports as duplicate; write routing as "→ reuse <title> (<id>)" or "→ new <title>, reason: …".
- When a person's decision is needed, ask only one necessary question; do not package an ask_user_question whole-turn cancellation as "waiting".
```

`DEFAULT_OUTPUT_STYLE` fields (all required; `defaults.ts:27-33`, parsed at `output-style.ts:95-112`):

| Field | Default |
|---|---|
| `version` | `1` |
| `tone` | `direct` |
| `length` | `terse` |
| `leadWithConclusion` | `true` |
| `lists` | `comparisons` |
| `dispatchVoice` | `terse` |

On this dev checkout, `OUTPUT_STYLE.yaml` is absent; no user override is observed, so no user data is copied. The renderer (`output-style.ts:145-180`) is a fixed template, not a wrapped document: four default header fields in the order `tone`, `length`, `leadWithConclusion`, `lists`; `leadWithConclusion` becomes `yes`/`no`. A fifth `Dispatch voice` line is added only when `dispatch=true`; ordinary agents do not receive it. If style entries exist, it adds `Concrete style entries take priority over these defaults:` and one collapsed, trimmed bullet per entry; with none, that block is omitted. It then appends the blank-line-separated hard boundary and `Status reporting discipline:` block, joins all lines with `\n`, and adds no title, wrapper, or trailing newline. The config has no optional fields: an absent file uses these defaults, while an invalid present file is warned about and falls back to them (`index.ts:162-175`).

### section 695 `personality:writing-rules`

Registered as `name: 'personality:writing-rules'`, with the order constant `PERSONALITY_WRITING_RULES = 695` (`src/writing-rules.ts:20`; `src/index.ts:152-155`; `packages/core/system-prompt/src/index.ts:143`). The body is a line-by-line list of enabled rules (`writing-rules.ts:243-249`):

```text
- {rule.text}
```

The default `WRITING_RULES.yaml` is `rules: []`, so the section text is **empty**; empty text is discarded by system-prompt assembly. Enabled rules are sorted by `order` ascending, with the same order sorted by id; `rule.text` has whitespace collapsed and is trimmed. The rule content is not copied in this document.

#### Current status: not enabled

No writing rules are enabled by default: `rules: []` produces an empty section, which assembly drops. The limits are **100 rules**, **240 characters per rule**, and **32 KiB total** (`writing-rules.ts:27-33`); only the first **40** enabled rules are resident. A longer set is stored but emits a `N rule(s) not injected: resident limit is 40.` line.

### Order with 702

The `name` of `SUPERAGENT_SECTION` is `superagent:dispatcher`, and its `order` is **702**; it is registered only for the super agent (`packages/jira/jira-agent/src/superagent.ts:116-118`). The order is **100 → 690 → 695 → 702**; after 702 come the existing runtime contexts 704 (workspaces), 705 (conventions), and 706 (running). There is no 703.

702 itself is not a personality section and is about 80 lines; this document only records the order and does not copy the full text, to avoid mixing the super agent's complete always-on rules into the personality collection.

## ④ Result / Error / Constraint Source Text

Result rendering templates (`analyze.ts:161-174`, `apply.ts:95-101`, `writing-tool.ts:143-153`):

```ts
`Scanned ${String(result.sessionsScanned)} session(s); ${String(result.candidates.length)} candidate(s)${result.truncated ? ' (truncated)' : ''}.`
`- ${candidate.kind}.${candidate.name} [${candidate.confidence}, ${String(candidate.occurrences)}x] ${candidate.text} — ${evidence}`
`warning: ${warning}`
```

```ts
`Applied ${String(result.applied.length)} personality entr${result.applied.length === 1 ? 'y' : 'ies'} to ${result.path} (revision ${String(result.revision)}).`
`- ${id}`
`- rejected ${item.name}: ${item.reason}`
```

```ts
`write_like_human failed (${result.action}): ${String(result.error)}`
`write_like_human ${result.action}: ${String(result.rules.length)} rule(s) in ${result.path}`
`- ${rule.id} [${rule.enabled ? 'on' : 'off'}, order ${String(rule.order)}] ${rule.text}`
`Injected text:` + promptSection
```

Key rejection/constraint sentences (verbatim, sources in parentheses):

```text
identity is manual-only and cannot be analyzed as a candidate kind
```
(`analyze.ts:181`)

```text
identity entries are manual-only; edit PERSONALITY.md directly because the new apply path never writes identity.*
```
(`global-store.ts:378`)

```text
maxCandidates must be an integer from 1 to 20
```
(`analyze.ts:188`)

```text
recent.limit must be an integer from 1 to 20
```
(`analyze.ts:222`)

```text
evidence must contain at least one excerpt
```
(`apply.ts:77`)

```text
writing rule text must not be empty
```
(`writing-rules.ts:256`)

```text
writing rule text is ${String(Array.from(normalized).length)} characters, over the ${String(WRITING_RULES_MAX_TEXT_CHARS)}-character limit
```
(`writing-rules.ts:259`)

```text
WRITING_RULES.yaml holds ${String(record.rules.length)} rules, over the ${String(WRITING_RULES_MAX_RULES)}-rule limit
```
(`writing-rules.ts:122`)

Constants table:

| Constant | Value | Source |
|---|---:|---|
| `PERSONALITY_MAX_ENTRY_CHARS` | 400 | `global-store.ts:116` |
| `PERSONALITY_MAX_BODY_BYTES` | 32 × 1024 = 32,768 | `global-store.ts:119` |
| `ANALYZE_DEFAULT_MAX_CANDIDATES` | 10 (allowed 1–20) | `analyze.ts:123`, `:188` |
| `WRITING_RULES_MAX_RULES` | 100 | `writing-rules.ts:27` |
| `WRITING_RULES_MAX_TEXT_CHARS` | 240 | `writing-rules.ts:30` |
| `WRITING_RULES_MAX_TEXT_BYTES` | 32,768 | `writing-rules.ts:33` |
| `WRITING_RULES_RESIDENT_MAX` | 40 | `writing-rules.ts:33` |

## ⑤ Content Not Included

- `memory_forget` / `memory_resolve`: belong to the memory package (`packages/uitstalie/memory/src/tools.ts:243`, `:327`), are not within the personality design scope, and are not included.
- Full text of section 702: only the order and source are included; the super agent's complete dispatcher rules are not copied.
- User data: the actual entries of `PERSONALITY.md`, the actual values of `OUTPUT_STYLE.yaml`, and the enabled rules of `WRITING_RULES.yaml` are not copied; only templates, default values, and empty-section behavior are given.
- Tool output schema: this task requires parameter schemas; the output schemas are not expanded verbatim, and only the model-visible result rendering templates are included.

## ⑥ Confirmation

**I did not change any prompt, tool definition, or configuration.** This document is a read-only collection; no build was run and no process was restarted.
