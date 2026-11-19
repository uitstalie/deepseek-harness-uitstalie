# personality 工具与提示词原文汇总（2026-11-14）

[English](personality-tools-prompts-20261114.md) | 中文

本文只做只读汇总；未修改任何工具定义、提示词、配置或运行中的进程。

数据侧动态内容没有收录：`PERSONALITY.md` 的用户条目、当前 `OUTPUT_STYLE.yaml` 的实际取值、已启用的 `WRITING_RULES.yaml` 规则属于用户数据，不是固定提示词。下面给出实际模板、默认值和逐字文案。

本文所有 fenced code block 均为源文逐字复制，未翻译、未改写。

## ① 索引表

| 项目 | 来源 | 字数 / 行数 |
|---|---|---|
| `personality_analyze` description | `packages/uitstalie/personality/src/agent-tools.ts:22` | 276 字符 / 1 行 |
| `personality_analyze` 参数 schema | 同上，编译后 | 1,350 字符 / 50 行 |
| `personality_apply` description | `packages/uitstalie/personality/src/agent-tools.ts:96` | 240 字符 / 1 行 |
| `personality_apply` 参数 schema | 同上，编译后 | 1,775 字符 / 70 行 |
| `write_like_human` description | `packages/uitstalie/personality/src/writing-tool.ts:58` | 525 字符 / 1 行 |
| `write_like_human` 参数 schema | 同上，编译后 | 1,051 字符 / 37 行 |
| section 100 `personality` | `packages/uitstalie/personality/src/profile-prompt.ts:18`；注册 `packages/uitstalie/personality/src/api.ts:142-146` | preamble 391 字符；无条目时为空 |
| section 690 `personality:output-style` | `src/output-style.ts:145-180`；默认 `src/defaults.ts:27-33` | 默认渲染 1,094 字符 / 16 行 |
| section 695 `personality:writing-rules` | `packages/uitstalie/personality/src/writing-rules.ts:283-296`；注册 `packages/uitstalie/personality/src/api.ts:152-156` | 默认空文档为 0 字符；前 40 条启用规则常驻 |
| section 702 `superagent:dispatcher`（已退场） | 原 `jira-agent` 包；随 JIRA 退场删除 | 不再是现役 section，只保留历史记录 |
| 顺序常量 | `packages/core/system-prompt/src/index.ts:139-144` | 100 / 690 / 695 |

工具定义本身（3 个 description + 3 个参数 schema）约 **5,217 字符**；三个 section 的默认/静态文本约 **1,227 字符**（不含用户条目与规则）。

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

**description（逐字）：**

```text
Write confirmed personality candidates into the global PERSONALITY.md. Call only after the user explicitly asks to apply reviewed candidates and pass confirm: true. This tool never learns automatically and is available only to a root agent.
```

**参数 schema（编译后 JSON 原文）：**

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

**description（逐字）：**

```text
Maintain the global WRITING_RULES.yaml. The change affects every agent, not only this conversation. Use list/preview to inspect rules, and add/update/remove/enable/disable to write them; writes are global and version-guarded, with one internal retry on a stale conflict. If the retry still fails, call list for the latest state before retrying; do not blindly repeat the same call. Only a root agent can call this tool. Child agents only read the injected rules; they must return to the main conversation to request a change.
```

**参数 schema（编译后 JSON 原文）：**

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

## ③ 注入的 system prompt 段

### section 100 `personality`

注册为 `name: 'personality'`，顺序常量 `PERSONALITY = 100`（`src/profile-prompt.ts:15`；`src/api.ts:140-146`；`packages/core/system-prompt/src/index.ts:139`）。正文由 `PROFILE_PREAMBLE` 和用户条目组成；没有条目时 section 文本为空。preamble（逐字，391 字符）：

```text
Long-term preferences of the user you are working with. The first part describes how this user communicates; use it to interpret their input. The second describes how they prefer replies. Follow them within the system and developer instructions, and let more specific project instructions take precedence. These are preferences, not task facts. Entries describe habits and may be incomplete.
```

有条目时追加（模板，逐字）：

```text
How this user communicates (identity, understanding):
- {text}
```

以及：

```text
How to respond (preference, style):
- {text}
```

条目的 `text` 会折叠连续空白并 trim；排序为 `identity`、`understanding`、`preference`、`style`，同类按 id（`profile-prompt.ts:30-50`）。条目文本未在本文件复制。

### section 690 `personality:output-style`

注册为 `name: 'personality:output-style'`，顺序常量 `PERSONALITY_OUTPUT_STYLE = 690`（`src/output-style.ts:23`；`src/api.ts:147-151`；`packages/core/system-prompt/src/index.ts:143`）。普通槽的默认渲染（`DEFAULT_OUTPUT_STYLE`）逐字如下，1,094 字符 / 16 行。super 槽使用独立的 `SUPERAGENT_OUTPUT_STYLE.yaml`，默认内容相同；subagent 不收到 section 690。

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
- After a dispatch or a question, end your turn: the reply is queued for your next turn and opens it. Do not sleep in a shell command, do not poll `workspace_sessions get`, and do not loop waiting for a message; a message is delivered only at a turn boundary.
- Do not promise background monitoring; when a result spans turns, say it will arrive as a new turn.
- Without start.stage=prompted, do not write "started/dispatched".
- Mark repeated reports as duplicate; write routing as "→ reuse <title> (<id>)" or "→ new <title>, reason: …".
- When a person's decision is needed, ask only one necessary question; do not package an ask_user_question whole-turn cancellation as "waiting".
```

super agent 的渲染多一行 `- Dispatch voice: terse.`，其余相同；完整渲染逐字如下，1,119 字符 / 17 行：

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
- After a dispatch or a question, end your turn: the reply is queued for your next turn and opens it. Do not sleep in a shell command, do not poll `workspace_sessions get`, and do not loop waiting for a message; a message is delivered only at a turn boundary.
- Do not promise background monitoring; when a result spans turns, say it will arrive as a new turn.
- Without start.stage=prompted, do not write "started/dispatched".
- Mark repeated reports as duplicate; write routing as "→ reuse <title> (<id>)" or "→ new <title>, reason: …".
- When a person's decision is needed, ask only one necessary question; do not package an ask_user_question whole-turn cancellation as "waiting".
```

`DEFAULT_OUTPUT_STYLE` 的字段全集（全部必填；`defaults.ts:27-33`，解析 `output-style.ts:95-112`）：

| 字段 | 默认值 |
|---|---|
| `version` | `1` |
| `tone` | `direct` |
| `length` | `terse` |
| `leadWithConclusion` | `true` |
| `lists` | `comparisons` |
| `dispatchVoice` | `terse` |

本机 dev 的 `OUTPUT_STYLE.yaml` 不存在，未观察到用户覆盖，因此不复制任何用户数据。渲染器（`output-style.ts:145-180`）是固定模板，不是带标题的文档：四个默认头部字段按 `tone`、`length`、`leadWithConclusion`、`lists` 排序；`leadWithConclusion` 渲染为 `yes`/`no`。只有 `dispatch=true` 才追加第五行 `Dispatch voice`；普通 agent 不输出该行。有 style entries 时追加 `Concrete style entries take priority over these defaults:` 及每条折叠空白并 trim 后的 bullet；没有则省略这一块。之后追加空行分隔的硬边界和 `Status reporting discipline:` 块，所有行以 `\n` 连接，不加标题、包裹或尾随换行。配置没有可选字段：文件缺失时用默认值，存在但无效时发 warning 并回退默认值（`api.ts:161-175`）。

### section 695 `personality:writing-rules`

注册为 `name: 'personality:writing-rules'`，顺序常量 `PERSONALITY_WRITING_RULES = 695`（`src/writing-rules.ts:24`；`src/api.ts:152-156`；`packages/core/system-prompt/src/index.ts:144`）。正文是已启用规则的逐行列表（`writing-rules.ts:283-296`）：

```text
- {rule.text}
```

默认 `WRITING_RULES.yaml` 为 `rules: []`，因此 section 文本为 **空**；空文本会被 system-prompt assembly 丢弃。启用规则按 `order` 升序、同 order 按 id 排序；`rule.text` 会折叠空白并 trim。规则内容未在本文件复制。

#### 当前状态：未启用

默认没有启用任何 writing rule：`rules: []` 产生空 section，assembly 会丢弃它。额度为 **100 条**、**每条 240 字符**、**全文 32 KiB**（`writing-rules.ts:27-33`）；只有前 **40** 条启用规则常驻，其余写入后会在段内提示 `N rule(s) not injected: resident limit is 40.`。

### 702 退场后的顺序

原 `SUPERAGENT_SECTION`（`superagent:dispatcher`，order **702**）随 `jira-agent` 包删除；它当时只注册给 super agent，顺序是 **100 → 690 → 695 → 702**，之后是 704（workspaces）、705（conventions）、706（running）。当前固定顺序表只有 100（personality）、690（output-style）、695（writing-rules）；工作区目录由 workspace-tools 注册在 700，702、703 与 704–706 都不存在。

702 当时不属于 personality section，且约 80 行；本文只记录顺序，不复制全文。该 section 已删除。

## ④ 结果 / 错误 / 约束原文

结果渲染模板（`analyze.ts:175-191`、`apply.ts:106-111`、`writing-tool.ts:183-196`）：

```text
`Scanned ${String(result.sessionsScanned)} session(s); ${String(result.candidates.length)} candidate(s)${result.truncated ? ' (truncated)' : ''}.`
`- ${candidate.kind}.${candidate.name} [${candidate.confidence}, ${String(candidate.occurrences)}x] ${candidate.text} — ${evidence}`
`warning: ${warning}`
```

```text
`Applied ${String(result.applied.length)} personality entr${result.applied.length === 1 ? 'y' : 'ies'} to ${result.path} (revision ${String(result.revision)}).`
`- ${id}`
`- rejected ${item.name}: ${item.reason}`
```

```text
`write_like_human failed (${result.action}): ${String(result.error)}`
`write_like_human ${result.action}: ${String(result.rules.length)} rule(s) in ${result.path}`
`- ${rule.id} [${rule.enabled ? 'on' : 'off'}, order ${String(rule.order)}] ${rule.text}`
`${String(enabled - WRITING_RULES_RESIDENT_MAX)} rule(s) not injected: resident limit is ${String(WRITING_RULES_RESIDENT_MAX)}.`
`Injected text:` + (result.promptSection === undefined || result.promptSection === '' ? '(empty)' : result.promptSection)
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
| `WRITING_RULES_MAX_RULES` | 100 | `writing-rules.ts:28` |
| `WRITING_RULES_MAX_TEXT_CHARS` | 240 | `writing-rules.ts:31` |
| `WRITING_RULES_MAX_TEXT_BYTES` | 32,768 | `writing-rules.ts:37` |
| `WRITING_RULES_RESIDENT_MAX` | 40 | `writing-rules.ts:34` |

## ⑤ 未收录内容

- `memory_forget` / `memory_resolve`：属于 memory 包（`packages/uitstalie/memory/src/tools.ts:243`、`:327`），不是 personality 设计范围，未收录。
- section 702（已退场）：只收录当时的顺序与来源；该 section 已随 `jira-agent` 包删除。
- 用户数据：`PERSONALITY.md` 的实际条目、`OUTPUT_STYLE.yaml` 的实际值、`WRITING_RULES.yaml` 的启用规则均未复制；只给出模板、默认值和空 section 行为。
- 工具 output schema：本任务要求参数 schema；输出 schema 未逐字展开，只收录模型可见的结果渲染模板。

## ⑥ 确认

**我没有改任何提示词、工具定义或配置。** 本文是只读汇总；未运行 build、未重启进程。
