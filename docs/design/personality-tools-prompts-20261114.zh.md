# personality 工具与提示词原文汇总（2026-11-14）

[English](personality-tools-prompts-20261114.md) | 中文

本文只做只读汇总；未修改任何工具定义、提示词、配置或运行中的进程。

数据侧动态内容没有收录：`PERSONALITY.md` 的用户条目、当前 `OUTPUT_STYLE.yaml` 的实际取值、已启用的 `WRITING_RULES.yaml` 规则属于用户数据，不是固定提示词。下面给出实际模板、默认值和逐字文案。

本文所有 fenced code block 均为源文逐字复制，未翻译、未改写。

## ① 索引表

| 项目 | 来源 | 字数 / 行数 |
|---|---|---|
| `personality_analyze` description | `packages/uitstalie/personality/src/agent-tools.ts:22` | 276 字符 / 1 行 |
| `personality_analyze` 参数 schema | 同上，编译后 | 822 字符 / 46 行 |
| `personality_apply` description | `packages/uitstalie/personality/src/agent-tools.ts:96` | 274 字符 / 1 行 |
| `personality_apply` 参数 schema | 同上，编译后 | 1,469 字符 / 67 行 |
| `write_like_human` description | `packages/uitstalie/personality/src/writing-tool.ts:58` | 369 字符 / 1 行 |
| `write_like_human` 参数 schema | 同上，编译后 | 482 字符 / 32 行 |
| section 100 `personality` | `packages/uitstalie/personality/src/profile-prompt.ts:18`；注册 `src/index.ts:142-145` | preamble 391 字符；无条目时为空 |
| section 690 `personality:output-style` | `src/output-style.ts:145-180`；默认 `src/defaults.ts:27-33` | 默认渲染 888 字符 / 15 行 |
| section 695 `personality:writing-rules` | `src/writing-rules.ts:243-249`；注册 `src/index.ts:152-154` | 默认空文档为 0 字符 |
| section 702 `superagent:dispatcher` | `packages/jira/jira-agent/src/superagent.ts:116-199` | 本文不复制全文，只说明顺序 |
| 顺序常量 | `packages/core/system-prompt/src/index.ts:139-143` | 100 / 690 / 695 |

工具定义本身（3 个 description + 3 个参数 schema）约 **3,692 字符**；三个 section 的默认/静态文本约 **1,279 字符**（不含用户条目与规则）。

## ② 工具原文

### `personality_analyze`

**description（逐字）：**

```text
Read session records and return evidence-backed personality candidates. Read-only: it never writes a file or changes the prompt. Use only when the user asks to analyze their recent expressions or preferences. Every candidate carries a session id, event seq, and exact excerpt.
```

**参数 schema（编译后 JSON 原文）：**

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
          "enum": [
            "current",
            "session",
            "recent"
          ]
        },
        "sessionId": {
          "type": "string"
        },
        "limit": {
          "type": "integer"
        }
      },
      "required": [
        "kind"
      ]
    },
    "kinds": {
      "type": "array",
      "items": {
        "type": "string",
        "enum": [
          "understanding",
          "preference",
          "style",
          "identity"
        ]
      }
    },
    "maxCandidates": {
      "type": "integer"
    }
  },
  "required": [
    "scope"
  ]
}
```

### `personality_apply`

**description（逐字）：**

```text
Write confirmed personality candidates into the global PERSONALITY.md. Call only after the user explicitly asks to apply reviewed candidates and pass confirm: true. identity candidates are rejected; this tool never learns automatically and is available only to a root agent.
```

**参数 schema（编译后 JSON 原文）：**

```json
{
  "type": "object",
  "properties": {
    "candidates": {
      "type": "array",
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
      "type": "boolean"
    }
  },
  "required": [
    "candidates",
    "confirm"
  ]
}
```

### `write_like_human`

**description（逐字）：**

```text
Maintain the global WRITING_RULES.yaml. The change affects every agent, not only this conversation. Use list/preview to inspect rules, and add/update/remove/enable/disable to write them; writes are global and version-guarded. Only a root agent can call this tool. Child agents only read the injected rules; they must return to the main conversation to request a change.
```

**参数 schema（编译后 JSON 原文）：**

```json
{
  "type": "object",
  "properties": {
    "action": {
      "type": "string",
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
      "type": "string"
    },
    "text": {
      "type": "string"
    },
    "order": {
      "type": "integer"
    },
    "enabled": {
      "type": "boolean"
    }
  },
  "required": [
    "action"
  ]
}
```

## ③ 注入的 system prompt 段

### section 100 `personality`

注册为 `name: 'personality'`，顺序常量 `PERSONALITY = 100`（`src/profile-prompt.ts:15`；`src/index.ts:140-145`；`packages/core/system-prompt/src/index.ts:139`）。正文由 `PROFILE_PREAMBLE` 和用户条目组成；没有条目时 section 文本为空。preamble（逐字，391 字符）：

```text
Long-term preferences of the user you are working with. The first part describes how this user communicates; use it to interpret their input. The second describes how they prefer replies. Follow them within the system and developer instructions, and let more specific project instructions take precedence. These are preferences, not task facts. Entries describe habits and may be incomplete.
```

有条目时追加（模板，逐字）：

```text
How this user communicates:
- {text}
```

以及：

```text
How to respond:
- {text}
```

条目的 `text` 会折叠连续空白并 trim；排序为 `identity`、`understanding`、`preference`、`style`，同类按 id（`profile-prompt.ts:30-50`）。条目文本未在本文件复制。

### section 690 `personality:output-style`

注册为 `name: 'personality:output-style'`，顺序常量 `PERSONALITY_OUTPUT_STYLE = 690`（`src/output-style.ts:19`；`src/index.ts:147-150`；`packages/core/system-prompt/src/index.ts:142`）。默认渲染（`DEFAULT_OUTPUT_STYLE`）逐字如下，888 字符 / 15 行：

```text
Output style defaults:
- Tone: direct.
- Length: terse.
- Lead with the conclusion: yes.
- Lists: comparisons.
- Dispatch voice: terse (super agent only; other agents ignore it).

Output style never overrides safety, approval, sandbox, tool permission, or workspace rules. When they conflict, the rule wins.

Status rules:
- State done / blocked / failed / unverified only from tool receipts; without a receipt, write "report delivery unconfirmed".
- Do not say "I will monitor/report back later automatically"; monitor is a query, not a subscription.
- Without start.stage=prompted, do not write "started/dispatched".
- Mark repeated reports as duplicate; write routing as "→ reuse <title> (<id>)" or "→ new <title>, reason: …".
- When a person's decision is needed, ask only one necessary question; do not package an ask_user_question whole-turn cancellation as "waiting".
```

super agent 的同一 section 把 `Dispatch voice` 行渲染为 `- Dispatch voice: terse.`（去掉 “super agent only” 后缀）；其他行相同。具体字段值由 `OUTPUT_STYLE.yaml` 改变；模板和固定边界见 `output-style.ts:145-180`。

### section 695 `personality:writing-rules`

注册为 `name: 'personality:writing-rules'`，顺序常量 `PERSONALITY_WRITING_RULES = 695`（`src/writing-rules.ts:20`；`src/index.ts:152-155`；`packages/core/system-prompt/src/index.ts:143`）。正文是已启用规则的逐行列表（`writing-rules.ts:243-249`）：

```text
- {rule.text}
```

默认 `WRITING_RULES.yaml` 为 `rules: []`，因此 section 文本为 **空**；空文本会被 system-prompt assembly 丢弃。启用规则按 `order` 升序、同 order 按 id 排序；`rule.text` 会折叠空白并 trim。规则内容未在本文件复制。

### 与 702 的顺序

`SUPERAGENT_SECTION` 的 `name` 是 `superagent:dispatcher`，`order` 是 **702**，只注册给 super agent（`packages/jira/jira-agent/src/superagent.ts:116-118`）。顺序为 **100 → 690 → 695 → 702**；702 之后是既有 runtime contexts 704（workspaces）、705（conventions）、706（running）。没有 703。

702 本身不是 personality section，且约 80 行；本文只记录顺序，不复制全文，避免把 super agent 的完整常驻规则混入 personality 汇总。

## ④ 结果 / 错误 / 约束原文

结果渲染模板（`analyze.ts:161-174`、`apply.ts:95-101`、`writing-tool.ts:143-153`）：

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

关键拒答/约束句（逐字，来源如括号）：

```text
identity is manual-only and cannot be analyzed as a candidate kind
```
（`analyze.ts:181`）

```text
identity entries are manual-only; edit PERSONALITY.md directly because the new apply path never writes identity.*
```
（`global-store.ts:378`）

```text
maxCandidates must be an integer from 1 to 20
```
（`analyze.ts:188`）

```text
recent.limit must be an integer from 1 to 20
```
（`analyze.ts:222`）

```text
evidence must contain at least one excerpt
```
（`apply.ts:77`）

```text
writing rule text must not be empty
```
（`writing-rules.ts:256`）

```text
writing rule text is ${String(Array.from(normalized).length)} characters, over the ${String(WRITING_RULES_MAX_TEXT_CHARS)}-character limit
```
（`writing-rules.ts:259`）

```text
WRITING_RULES.yaml holds ${String(record.rules.length)} rules, over the ${String(WRITING_RULES_MAX_RULES)}-rule limit
```
（`writing-rules.ts:122`）

常量表：

| 常量 | 值 | 来源 |
|---|---:|---|
| `PERSONALITY_MAX_ENTRY_CHARS` | 400 | `global-store.ts:116` |
| `PERSONALITY_MAX_BODY_BYTES` | 32 × 1024 = 32,768 | `global-store.ts:119` |
| `ANALYZE_DEFAULT_MAX_CANDIDATES` | 10（允许 1–20） | `analyze.ts:123`、`:188` |
| `WRITING_RULES_MAX_RULES` | 32 | `writing-rules.ts:27` |
| `WRITING_RULES_MAX_TEXT_CHARS` | 240 | `writing-rules.ts:30` |
| `WRITING_RULES_MAX_TEXT_BYTES` | 4,096 | `writing-rules.ts:33` |

## ⑤ 未收录内容

- `memory_forget` / `memory_resolve`：属于 memory 包（`packages/uitstalie/memory/src/tools.ts:243`、`:327`），不是 personality 设计范围，未收录。
- section 702 全文：只收录顺序与来源，不复制 super agent 的完整 dispatcher 规则。
- 用户数据：`PERSONALITY.md` 的实际条目、`OUTPUT_STYLE.yaml` 的实际值、`WRITING_RULES.yaml` 的启用规则均未复制；只给出模板、默认值和空 section 行为。
- 工具 output schema：本任务要求参数 schema；输出 schema 未逐字展开，只收录模型可见的结果渲染模板。

## ⑥ 确认

**我没有改任何提示词、工具定义或配置。** 本文是只读汇总；未运行 build、未重启进程。
