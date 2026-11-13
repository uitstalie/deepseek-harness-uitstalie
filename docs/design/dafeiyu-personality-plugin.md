# dafeiyu personality plugin design (2026-11-13)

English | [中文](dafeiyu-personality-plugin.zh.md)

Status: design draft; not implemented; no package has been changed.

The raw input material is retained under `docs/inputs/` for traceability; this design adopts only its directional corrections, expression habits, and A–E root causes, and does not write business-fact corrections into personality. The key constraints are inlined in section 2.1, so implementation on another machine does not depend on the input files.

## Conclusion

Not all four modules become the same plugin. **user-input reuses the existing `dsh-personality` capability; super-agent-dispatch is a section plus a wording template in the super agent preset; write-like-human is a standalone skill plus a vocabulary data file; output-summary is a set of persona dimensions in the personality config row plus a stable system-prompt section.** This way each module owns exactly one kind of fact, no parallel store is created, and "how to say it" and "what to do" do not mix into the same entry.

**Resolve the three existing conflicts before discussing implementation:**

1. The existing `preference.*` writes to the workspace overlay when `workspaceOverlay: true`, but A–E are cross-workspace user preferences. `personality_learn` needs an optional `scope`; otherwise the only options are binary: turn off the overlay, or write the same set of preferences repeatedly for every workspace.
2. The existing turn-end automatic learning matches only a narrow set of phrasings ("not what I meant", "from now on..."), and most of the 13 corrections ("why are you worrying about that", "who said only change three places", "list them first") do not match. The primary path must change to the model explicitly calling `personality_learn` when the correction happens, with the regex as a fallback only.
3. The existing skill parser exposes only the top-level `name`, `description`, `whenToUse`, and `metadata` object to the registry; top-level `version` and `kind` do not enter the skill metadata. write-like-human's `version`/`kind` must first be placed under `metadata`, or the parser must be extended during implementation; this design takes the former approach and records the latter as a gap.

## 1. Existing implementation and facts this design must align with

| Fact | Current evidence | Impact on this design |
|---|---|---|
| personality is a dafeiyu capability, `scope: 'all'` | `packages/uitstalie/personality/src/index.ts` | A new section applies to all agents by default; super-agent-only content cannot go through it and must use the super agent preset |
| One fixed section, order `100` | `packages/uitstalie/personality/src/prompt.ts` | User-input interpretation is placed before all tool descriptions; a change invalidates the prefix cache from 100 onward |
| Four kinds: `understanding/style/preference/identity` | `packages/uitstalie/personality/src/personality-file.ts` | Reuse them, add no kind; A–E go into `preference`, expression habits go into `understanding` |
| overlay allows only `style/preference` | `packages/uitstalie/personality/src/personality-file.ts` | Where `preference` is written is affected by the overlay switch; this is the cross-workspace preference gap |
| `personality_learn` can auto-write non-identity kinds; identity can only be proposed | `packages/uitstalie/personality/src/tools.ts` | Identity stays manually confirmed; this design does not touch that red line |
| Automatic learning uses a narrow regex at turn-end | `packages/uitstalie/personality/src/index.ts` | Fallback only; the primary path must have the model learn at the correction site |
| Automatic entry names are exact `auto-<8hex>` hashes | `packages/uitstalie/personality/src/tools.ts` | Identical text overwrites; the same thing phrased differently duplicates; an optional stable name is needed |
| superagent section is the static section `702` | `packages/jira/jira-agent/src/superagent.ts` | The brief rules belong here; a new template can only supplement, not override "do not invent standards" |
| superagent runtime context is `704-706` | `packages/jira/jira-agent/src/superagent.ts` | Only volatile data belongs in runtime context; the template is static and should be a section |
| dafeiyu contribution has only `promptSections`/`tools`/`onTurnEnd` | `packages/uitstalie/dafeiyu/src/types.ts` | There is no "super-agent-only runtime context" capability; super-agent-only paragraphs must be registered in its preset |
| Fixed order of the system prompt | `packages/core/system-prompt/src/index.ts` | See the order table in section 4; persona goes at `690`, and no runtime rules are added after superagent |
| skill directory accepts only fixed fields such as `name`/`description` | `packages/skill/skill-filesystem/src/index.ts` | Put `version`/`kind` under `metadata`; do not assume top-level fields take effect |
| skill catalog is a durable user message | `packages/skill/tool-skill/src/index.ts` | Skills do not stay in the system prompt; only loading puts the body into history, so the cache impact is small |

## 2. Module overview and dependencies

| Module | Form | Facts it owns | Does not own |
|---|---|---|---|
| user-input | Data model plus tool extension inside the existing `dsh-personality` plugin | How the user expresses things and how to read their ellipsis/rhetorical questions/role prefixes; A–E work preferences | Reply tone, dispatch template, output rewrite vocabulary |
| super-agent-dispatch | Section `703` in the super agent preset plus the `dispatch-brief.md` data file | The **form** of a brief: the four slots goal/acceptance/boundaries/evidence source | Brief content standards, acceptance criteria, organizational judgment |
| write-like-human | skill plus the `references/blacklist.yaml` data file | The **de-AI rewrite steps** for user-visible text | Facts, code, paths, numbers, policy, phase criteria |
| output-summary | `persona` data in the personality config row plus section `690` | Default reply tone/length/conclusion position/list tendency, and the voice used when dispatching | Safety, approval, sandbox, tool permissions, project-specific rules |

Dependency graph:

```text
PERSONALITY.md (global) ─┐
PERSONALITY.md (overlay) ─┴─> personality section @100 ─> all agents
                                      │
persona config (personality row) ─────┴─> personality:persona @690 ─> all agents

dispatch-brief.md ──> superagent:brief-template @703 ─> super agent only
SUPERAGENT_SECTION @702 ───────────────────────────────> super agent only

write-like-human/SKILL.md ──> skill catalog ──> skill tool ─> on demand
        └── references/blacklist.yaml
```

**No second profile file and no new database are created.** PERSONALITY.md remains the only store of personality entries; `persona` is schema-bearing configuration, not an entry; the brief template and the vocabulary are ordinary user-owned data files.

### 2.1 Constraints on modules 2/4 from real Windows failure modes

The handoff in the input material records real runtime failures, not assumptions. The template for module 2 and the persona for module 4 must treat these failures as constraints, or the design will recreate "done but not closed" text.

| Real failure | Constraint on module 2 (brief) | Constraint on module 4 (persona) |
|---|---|---|
| A child Session is complete while the super-side ledger is still pending; there is no visible closure when report delivery fails | Acceptance must require **in-workspace evidence** (files, command output, test results), not just "tell me when done"; the delivery slot must name artifact paths | Status uses only `完成 / 阻塞 / 失败 / 未验证`; without a tool receipt, write "the result was produced, report delivery is unconfirmed", never "reported/closed" |
| The same report arrives repeatedly under different task ids | The result must carry `taskId` and a request summary; when the content repeats, mark it `duplicate` and do not count it as complete again | On a repeated report, say "duplicate" first and do not count one result twice; do not treat an old taskId as a new task |
| Continuing a prompt after `abort` produces no new taskId/report binding | Confirm the new `taskId`/`requestId` before dispatching; a continued task cannot reuse the old binding; if binding fails, do not send | Do not carry a "complete" status from before the abort into the new task; write the new task's status from `未开始` again |
| A failure in the middle of `start`'s create → configure → bind → prompt leaves an empty Session | Generate the brief only after `start` returns `stage=prompted`; on failure, state explicitly which stage it stopped at | Do not say "started/dispatched" unless the result contains `stage=prompted`; an empty Session cannot be described as the executor |
| monitor is a request-time hint, not a status subscription | State in the template that "reports arrive asynchronously; no report does not mean complete"; do not write "I will keep watching" | Do not say "I will monitor/report back later automatically"; when status is needed, suggest `list`/`inspect` and explain that it is a query, not a push |
| A child Session's `ask_user_question` may cancel and abort the whole turn | Write in the boundaries slot: do not use interactive questions; when something needs a human decision, stop and write **one** question into the final result/report; do not assume someone answers in real time | When blocked, ask only the one most necessary question; do not describe "waiting for a human answer" as in progress unless there is indeed a pending interaction |
| The default `memory_search` may fail because of `openAt: "never"` | The evidence-source slot cannot make `memory_search` a required step; prefer files, commands, and `memory_read`; when retrieval fails, write "retrieval unavailable", never fabricate | Do not claim to have searched memory; distinguish "found in a file" from "retrieval unavailable" |
| Windows ACL/sandbox side effects may make ordinary `rename`/builds fail | The boundaries slot forbids changing ACLs, administrator permissions, or system directories; on a permission error, stop and report it verbatim, without self-elevating | Do not make "needs administrator/change ACL" a default recommendation; report platform limitations as a blocking item |
| Many untitled Sessions degrade `append` routing | Identify the target by title/id before dispatching; for untitled Sessions, write only the id, not "that Session" | Write the routing result as `→ reuse <title> (<id>)` or `→ new <title>, reason: …`, not only "dispatched to some Session" |



## 3. Conflicts and priorities

### 3.1 Conflicts that must be raised first

| ID | Conflict | Current state | Treatment in this design |
|---|---|---|---|
| C1 | A–E work preferences are global, but `preference` writes follow the overlay | `personalityFileTarget()` writes `style/preference` to the workspace when the overlay is enabled | Add an optional `scope: 'global' \| 'workspace'` to `personality_learn`; keep `workspace` as the compatible default, and make user-input's A–E explicitly pass `global`; do not change the file format |
| C2 | Automatic learning matches only narrow phrasings | `CORRECTION_RULES` covers only Chinese phrasings such as "不是这个意思/以后…" ("not what I meant/from now on…") | Change the primary path to the model calling `personality_learn`; keep the turn-end regex as a fallback only; do not expand it to "learn from every user message" |
| C3 | Top-level `version/kind` in a skill does not take effect | The parser reads only the `metadata` object | This design puts both under `metadata`; if top-level fields are required during implementation, open a separate parser change with tests |
| C4 | A personality contribution cannot inject only into the super agent | `scope` has only `root/all`, with no runtime context | Put the brief template in the super agent preset's section, not in the personality provider |
| C5 | `style.*` and persona both describe reply style | The existing `style` is at 100, and persona is planned for 690 | `style.*` is concrete, overridable rules; persona is defaults; on conflict the concrete style wins, and the 690 text says so |
| C6 | The automatic-learning budget may not cover 13 corrections | Default 3 entries/512 B per session | Do not raise the default on your own; measure first, and if needed split user-input's A–E learning from ordinary learning into separate buckets as a later decision |
| C7 | The existing `personality_learn` evidence accepts only a seq | `parseEvidenceSeq` requires a positive integer | Keep it; the model gets the seq from the current turn's `turn/end`/events; do not change the evidence contract |
| C8 | write-like-human is an on-demand skill and cannot be guaranteed to run for every output | The skill catalog is loaded only when needed | Add one line to output-summary/persona: "for human-facing text, use write-like-human first"; it is a hint, not an enforcement hook; if enforcement is required, build an output hook separately, not in this round |
| C9 | Report/delivery/`start` status has no closure guarantee | The handoff records completed-yet-pending, duplicate taskIds, abort without a new binding, and empty Sessions | Module 2's brief requires in-workspace evidence and taskId; module 4 allows status statements only from tool receipts; do not change runtime delivery logic |
| C10 | A child Session's interactive question aborts the whole turn | The handoff records `ask_user_question` cancelling and aborting | Module 2 forbids briefs from requiring interactive questions and moves to one blocking question in the final result; module 4 asks only one necessary question |
| C11 | Default retrieval may be unavailable | `session-query` may default to `openAt: "never"`, and `memory_search` fails | Module 2 does not make `memory_search` required evidence; module 4 distinguishes "found/unavailable" and does not fabricate retrieval results |

### 3.2 Priority (highest to lowest)

1. Platform/system/developer instructions, sandbox, approval, tool permissions.
2. Explicit user instructions in the current turn (including temporary overrides such as "do not list items this time").
3. The target workspace's `AGENTS.md` conventions and superagent hard rules (`SUPERAGENT_SECTION` 702, `superagent:conventions` 705).
4. The KB document's own format/citation criteria (for example `doc_id《标题》`); persona can govern only tone outside KB text and cannot change KB citation format.
5. Specific personality entries (`understanding`, `preference`, `style`).
6. persona defaults (690) and the brief template (703).
7. write-like-human rewrite rules: change expression only, not facts, numbers, paths, code, or conclusions.

persona and the template must carry a hard boundary: "do not override safety, approval, sandbox, tool permissions, or workspace rules; on conflict, the higher layer's rules prevail." This sentence is fixed persona-section text; user configuration cannot turn it off.

## 4. Injection order and caching

### 4.1 Order table

| Order | Name | Type | Scope | Why here |
|---:|---|---|---|---|
| -1000 | `harness:identity` | section | all | Platform identity, first |
| 0 | `deployment:persona-prefix` | section | all | Deployment persona prefix |
| **100** | `personality` | section (existing) | all | How the user expresses things and how to read them; must be read before plan/tool descriptions |
| 500 | `PLAN_POLICY` | section | all | Plan policy |
| 600 | `TEAM_POLICY` | section | all | Team policy |
| **690** | `personality:persona` | section (new) | all | Default reply style; after concrete task rules and before superagent; concrete `style.*` already appears at 100, so persona only supplies defaults |
| **702** | `superagent:dispatcher` | section (existing) | super agent | Dispatch hard rules and "do not invent standards" |
| **703** | `superagent:brief-template` | section (new) | super agent | The brief template is 702's execution form; placed after the hard rules, so 702 wins on conflict |
| 704 | `superagent:workspaces` | runtime context | super agent | Registered workspaces, rebuilt per request |
| 705 | `superagent:conventions` | runtime context | super agent | Workspace conventions, which change as files change |
| 706 | `superagent:running` | runtime context | super agent | Long-task status, rebuilt per request |
| 1000+ | Tool sections | section | all | Tool descriptions |
| — | skill catalog | durable user message | all | Appended before the first request/when the directory changes; not a system section |

Notes:

- **100 reuses the existing position**; do not open a new "user-input section". Moving it to 650 would reduce the cache-invalidation scope but would change the relative order of the existing personality and plan/team; this round does not change it, and it remains a later performance option.
- **690 goes after 600** because persona is "default expression" and must not override plan/team policy; it is still before 702, so superagent's hard rules can override it.
- **703 goes after 702** because the template is execution detail; if any template conflicts with 702's "only two sources allowed, do not invent standards", 702 wins. 703's own text also repeats once "if a slot has no source, ask the person first", but that is an execution hint and does not change 702's authority.
- **skill has no system order**. It appears through the durable catalog, and after loading it enters history as a tool result; do not copy the skill body into 690 just to keep it "resident".

### 4.2 Prefix-cache impact

| Change | Invalidated range | Design tradeoff |
|---|---|---|
| `PERSONALITY.md` entry changes | From 100 onward, including 500/600/690/702/703 | Automatic learning has a budget of 3 entries per session; personality edits are infrequent, so accepted. If later measurement shows writes are too frequent, split user-input to 650 as a separate change |
| persona config changes | From 690 onward, including 702/703 and tool descriptions | Saved only by a person and infrequent; do not write per-turn state into persona |
| brief template changes | From 703 onward, mainly tool descriptions | The template is a deployment-level static file and changes rarely |
| skill catalog member/description changes | Append a replacement catalog; do not rewrite the system prefix | Acceptable; do not resend the directory every time a skill is loaded |
| Loading write-like-human | Append a tool result only at the end of history; the system prefix stays unchanged | This is the main reason to choose a skill instead of a section |

Hard rule: persona, the brief template, and the personality section must not contain volatile values such as timestamps, seqs, per-turn counts, or the current task name; these go only in runtime context or tool results.

## 5. Data flow

```text
用户纠正
  ├─ 模型识别到“ durable correction ”
  │    → personality_learn(kind, name?, scope?, content, evidence=seq)
  │       ├─ identity → 拒绝，转 personality_propose → 人工 accept
  │       ├─ understanding → 全局 PERSONALITY.md
  │       └─ preference/style → 按 scope 写全局或工作区
  └─ turn/end 兜底正则（仅显式措辞）
       → 同一写入路径，受同一预算与去重约束

PERSONALITY.md 写入
  → version-guarded write + history
  → watcher / agent refresh
  → personality section @100

persona 设置（人）
  → personality config row
  → section @690

dispatch-brief.md（人）
  → superagent brief section @703

write-like-human skill（模型按需）
  → 读取 blacklist.yaml
  → 改写 → 执行自查
```

## 6. user-input

### 6.1 Form

**A data model and tool extension inside the existing `dsh-personality` plugin**, not a new plugin. Reason: personality already has PERSONALITY.md, version guards, the overlay, the proposal queue, the automatic budget, and the watcher; user-input only adds classification and scope to these existing mechanisms. A new plugin would duplicate write, history, and cache logic.

### 6.2 Data model

Reuse existing entries; add no kind:

```markdown
## understanding.role-prefix
The user prefixes a workspace role before the instruction; the prefix names the executor, the rest is the task.

## preference.scope
Only act on the objects the user names and their direct implications; extra risk gets one line, not a new task.

## preference.authorization
Inside an explicit authorization, act without asking again; ask only when the authorization boundary changes.
```

| Content | kind | Default location | Who can write |
|---|---|---|---|
| Interpretation of sentence patterns, word choice, modal particles, role prefixes, ellipsis/rhetorical questions | `understanding.*` | Global | `personality_learn` (non-identity, within the automatic budget); a person may edit |
| A–E work preferences | `preference.*` | **Global** (new scope) | Same as above; default workspace preserves old behavior |
| Concrete reply-style rules | `style.*` | Workspace overlay (existing) | A person; output-summary may also write through the tool, subject to scope |
| Who the user is | `identity.*` | Global | Only `personality_propose` → a person accepts |

Fixed entries for expression habits (`understanding.*`, describing only "how to read", not "what to do"):

| Observed habit | Fixed entry | Entry content |
|---|---|---|
| `<角色>：<指令>` prefix | `understanding.role-prefix` | The prefix names the executor; only the latter half is the task; do not read it as an ordinary sentence |
| Omitted subject/object | `understanding.ellipsis` | Take the object from the nearest context; act on the nearest candidate first, confirm in one line when necessary, and do not ask a string of questions |
| Rhetorical question expressing affirmation | `understanding.rhetorical-question` | "不是……嘛？" ("isn't it...?") is usually a conclusion notification, not a question; act on the conclusion |
| Mixed Chinese/English and direct terms | `understanding.mixed-terms` | skill/MR/KB/log/app and similar are common terms; do not translate them or add quotes |
| "先……再……"/"等……之后" | `understanding.sequence` | Order is a hard constraint; completing the previous action is a prerequisite for the next; do not parallelize |

New tool parameters (at implementation time); fields reuse the existing `PersonalityEntryKind`, and no kind is added:

```ts
type PersonalityLearnKind = Exclude<PersonalityEntryKind, 'identity'>
type PersonalityWriteScope = 'global' | 'workspace'

interface PersonalityLearnInput {
  readonly kind: PersonalityLearnKind          // required
  readonly content: string                     // required, one paragraph
  readonly evidence: string                    // required, positive seq
  readonly name?: string                       // optional, lower-kebab; omitted -> auto-<hash>
  readonly scope?: PersonalityWriteScope       // optional, default preserves current behavior
}

interface PersonalityLearnValue {              // existing result shape, unchanged
  readonly status: 'learned' | 'rejected'
  readonly message: string
  readonly entry?: string                      // <kind>.<name>
  readonly path?: string
  readonly revision?: number
}

type WorkPreferenceClass = 'A' | 'B' | 'C' | 'D' | 'E'
interface PreferenceSeed {
  readonly class: WorkPreferenceClass
  readonly name: string                        // stable id suffix, for example "scope"
  readonly text: string
}
```

- `name` is used for semantic deduplication: A–E use fixed names (`scope`, `authorization`, `no-invented-abstractions`, `no-overinterpretation`, `consistency-first`, `inventory-sources`); repeated corrections update the same id and do not add entries.
- `scope` is meaningful only for `style/preference`; `understanding` is always global; `identity` is not in this tool.
- The PERSONALITY.md format, frontmatter, history, and proposal format are unchanged. The existing `PersonalityEntry` remains `{ id, kind, name, text }`, with no new fields.

### 6.3 Injection point

Reuse the `personality` section, order **100**. Reason: this is "how to interpret user input" and must come before plan and tool descriptions; the existing section already renders `understanding` and `preference` as two parts, so no new paragraph is needed.

**Caching**: a change at 100 invalidates the prefix after 100; because automatic learning has a budget and personality edits are infrequent, this is accepted. **Do not** write per-turn temporary corrections into the section; temporary instructions rely on the current turn's conversation.

### 6.4 Learnability

1. **Trigger**: after an explicit correction, the model calls `personality_learn`, with `evidence` set to the seq of the correction message; the turn-end regex only backstops explicit phrasings such as "不是这个意思/以后……" ("not what I meant/from now on…").
2. **Classification gate**: first decide whether the content is expression or a work preference; one entry can belong to only one class. Mixed content ("list items first from now on, and do not use code names") is split into `preference` + `understanding`, or rejected with a request to split.
3. **Identity**: when "I am..."/"my role is..." appears, only `personality_propose` is allowed, with human acceptance; never write automatically.
4. **Deduplication**:
   - When a stable `name` exists, overwrite by `<kind>.<name>`;
   - when no `name` exists, keep exact deduplication by `auto-<hash>`;
   - before calling, the model first looks at the entries already present in the `personality` section/prompt and prefers updating an entry with the same name;
   - learn only one entry per turn; a session is limited by the `autoLearn` budget.
5. **Do not learn**: one-off task instructions, business facts, unimplemented/undecidable states, emotional expressions, or sentences without a clear durable intent.

Mapping from A–E to fixed entries:

| Root cause | Fixed entry | Entry must be written as an executable rule |
|---|---|---|
| A Overreach | `preference.scope`, `preference.authorization` | Act only on the named objects and their direct implications; decide independently within the authorization, and ask only when the boundary changes |
| B Abstraction | `preference.no-invented-abstractions` | Do not invent code names/intermediate structures; cite by single number or `doc_id《标题》` |
| C Simplification | `preference.no-overinterpretation` | Do not treat "tidy up" as "interpret"; write only to the provable level |
| D Default conservatism | `preference.consistency-first` | When an inconsistency is found, the goal is to remove it, not preserve the status quo |
| E Missed reconciliation | `preference.inventory-sources` | For multi-source tasks, first list the reviewed/changed/unchanged objects |

### 6.5 Acceptance (3 items)

1. **Classification**: given 5 fixtures (one per A–E), `personality_learn` writes each as the corresponding `preference.<fixed name>` and produces no `understanding`/`style` mixing; then give a "先列清单，不要动" ("list items first, do not act") fixture, which must write `preference.scope` rather than `style`.
2. **Expression**: given "不是这个意思，我是说先列清单" ("not what I meant; I mean list items first"), it must split into `understanding` (reading "不是这个意思" — "not what I meant") + `preference.scope` (list first); writing only one entry or writing `style` fails.
3. **Deduplication/identity**: two consecutive corrections with the same `name` keep only one entry, with updated text; an `identity` call returns rejection and points to `personality_propose`, and PERSONALITY.md is unchanged.

### 6.6 Risks

- Over-fine classification inflates the prompt; keep 6 fixed A–E entries plus a small amount of understanding, and route anything beyond that to manual merging.
- The model may mistake a one-off instruction for durable content; the "clear durable intent" gate and `/personality diff` make this recoverable.
- The priority between global preference and the workspace overlay must be stated clearly: for the same id, the workspace overrides the global; different ids merge. A–E default to global, and a workspace may write an entry with the same name to override it.

## 7. super-agent-dispatch

### 7.1 Form

**A prompt section `703` in the super agent preset + the data file `$DSH_HOME/personality/dispatch-brief.md`.** Not placed in the personality capability: its `scope` is only `root/all`, with no "super agent only"; not placed in a skill: the brief rules must be present on every dispatch and cannot rely on the model remembering to load them. The section is registered by the super agent's contribution, and the template is maintained by a person.

### 7.2 Data model

`dispatch-brief.md` is ordinary Markdown with four fixed H2 headings; the loader performs structure validation only and does not parse semantics:

```markdown
## 目标
<one objective; quote the person's words>

## 验收
<what proves it; only from the person or the destination conventions>

## 边界
<in scope / out of scope / stop conditions>

## 证据来源
<files, commands, workspace AGENTS.md#superagent:conventions, or person quote>
```

- The four headings must appear exactly once each; if one is missing or duplicated, the loader falls back to the built-in template and records a warning.
- The template itself contains no concrete standard, phase, or policy; it contains only the slots and how to fill them.
- Who can write: a person (the file owner); the model reads only. When the model needs a new standard, it asks the person to update their own words or the target workspace conventions; it cannot change the template.
- Storage location: `$DSH_HOME/personality/dispatch-brief.md`; when absent, use the built-in default and do not create an empty file.

Loader interface:

```ts
type DispatchBriefSlotKey = 'goal' | 'acceptance' | 'boundaries' | 'evidence'

interface DispatchBriefSlot {
  readonly key: DispatchBriefSlotKey
  readonly heading: string          // exact heading text in the file
  readonly required: true
  readonly sourceRequired: true     // every filled value names a person/convention source
}

interface DispatchBriefTemplate {
  readonly version: 1
  readonly slots: readonly [
    DispatchBriefSlot, DispatchBriefSlot, DispatchBriefSlot, DispatchBriefSlot,
  ]                              // exactly four, in this order
}

interface DispatchBriefLoadResult {
  readonly template: DispatchBriefTemplate
  readonly fallback: boolean       // true when the file is absent or malformed
  readonly warning?: string        // present only for a malformed existing file
}

type BriefValueSource = 'person' | 'conventions' | 'missing'
interface BriefSlotCheck {
  readonly key: DispatchBriefSlotKey
  readonly source: BriefValueSource
  readonly reference?: string      // path, command, quote, or workspace convention anchor
}
```

`BriefSlotCheck` is a data structure designed for tests/future lightweight validation; it does not represent a new tool in this round. The template section still relies mainly on textual self-checks.

### 7.3 Injection point

`superagent:brief-template`, order **703**, registered only in the super agent preset.

Reason: 702 is the hard rule and 703 is its execution form; 703 comes after 702, so the model reads "do not invent standards" first and then "how to fill the four slots". 703 does not enter runtime context because it does not change per turn.

**Caching**: the template is reread only when the file changes, invalidating from 703 onward; this is acceptable.

### 7.4 How the template enforces "do not invent standards in a brief"

The template supplies only **slots**, no defaults; every slot requires a source:

- Goal: only the person's own words/a clear task;
- Acceptance: only from the person or the target workspace's `AGENTS.md#superagent:conventions`;
- Boundaries: write only the in/out of scope and stop conditions the person stated;
- Evidence source: must be a path, command, or convention reference; when there is no source, write "to be confirmed" and do not substitute a guess.

Fixed first and last lines (they do not occupy the four slots and prevent the Windows failure modes from recurring):

```text
结果首行: status: done | blocked | failed | unverified · task_id: <only when supplied>
结果末行: artifacts: <workspace-relative paths> · checks: <commands actually run>
没有报告或没有产物时，不得写 done。
遇到需要人决定的事: 不调用交互提问，只把一个问题写进结果。
不把 memory_search 当必需步骤；不修改 ACL、管理员权限或系统目录。
```


After the four slots, the section text adds a **pre-dispatch self-check** (not a tool validation):

1. All four slots have a source, and there is no self-invented standard such as "default/usually/generally";
2. a brief has only one goal and one acceptance;
3. whether a person has been asked about any new standard that is needed;
4. whether the target workspace conventions have been cited as `workspace-id/AGENTS.md#superagent:conventions`.

If any of these is not satisfied, ask the person first and do not dispatch. 702's "missing standard → ask" still takes priority over the template.

### 7.5 Acceptance (3 items)

1. **Structure and failure constraints**: given a template fixture, the rendered section contains exactly one of each of the four headings; after "证据来源" ("evidence source") is deleted, the loader falls back to the built-in template and warns; the fixed first and last lines contain `status`, `task_id`, `没有报告或没有产物时不得写 done`, and "do not call interactive questions".
2. **Scope**: the super agent's assembly has `superagent:brief-template`, while ordinary workspace agents do not; the order is 703; the section text contains "two sources" and "ask the person first when a source is missing".
3. **Anti-invention**: a fixture brief says "counts only, no names", while the person's words/conventions contain no such restriction; the static prompt's rule text must match "never invent a standard", and the template self-check items must require "no source, no entry"; the test asserts that the prompt contains both 702's hard rule and 703's self-check items.

### 7.6 Risks

- The template file can be broken by a person; the loader falls back to the built-in template and must not silently use half a template.
- The text of 703 overlaps with 702; keep the division "702 is the rule, 703 is the execution checklist" and avoid writing two sets of standards.
- Real enforcement requires tool-level validation; this round provides hints and structure validation only and does not add a brief parser.

## 8. write-like-human

### 8.1 Form

**A skill + data file.** The skill is an on-demand rewrite process; the vocabulary/sentence-pattern blacklist lives in `references/blacklist.yaml` and is not piled into the body. Reason: output rewriting is a task-level skill and should not occupy the system prompt every turn; the vocabulary needs human maintenance and can grow independently, while the body keeps only the process and self-checks.

Suggested location: `$DSH_HOME/skills/write-like-human/SKILL.md` and `references/blacklist.yaml` in the same directory; discovered by `skill-filesystem`, with catalog/loader provided by `tool-skill`.

### 8.2 frontmatter

The current parser guarantees only that `name`, `description`, `whenToUse`, and `metadata` are available, so:

```yaml
---
name: write-like-human
description: Rewrite user-facing prose so it reads like a person wrote it, without changing facts, code, numbers, or quoted text; load before sending a report, summary, or explanation.
metadata:
  version: 1
  kind: output-transform
  triggers:
    - user-facing report
    - summary
    - explanation
    - handoff note
---
```

- Putting `version`/`kind` under `metadata` is the compatible form under the current contract; if implementation requires them as top-level fields, the `skill-filesystem` parser and tests must be changed separately, and this must not be assumed to work already.
- `description` is the trigger surface: write only "when to use it", not an untestable goal such as "make the text more natural".

### 8.3 Trigger conditions

- Reports, summaries, explanations, and handoff notes to be sent to the user;
- when a person says in the conversation "speak plainly/do not sound like AI/simplify the wording";
- Do not trigger for: code, JSON/YAML, paths, commands, original logs, commit messages, or tool results; these stay as they are.

### 8.4 Vocabulary storage

`references/blacklist.yaml`:

```yaml
version: 1
banned_terms:
  - 赋能
  - 闭环
  - 抓手
  - 深度融合
  - 全面提升
banned_patterns:
  - label: not-x-but-y
    regex: '不是.{0,24}而是'
  - label: rule-of-three
    regex: '首先.{0,80}其次.{0,80}最后'
  - label: summary-filler
    regex: '总的来说|值得注意的是|不难看出|让我们'
  - label: em-dash
    regex: '—'
checks:
  - facts-unchanged
  - banned-scan-zero
  - max-sentence-chars
  - no-three-part-parallel
max_sentence_chars: 80
```

- The skill body only says "read this file and run the checks" and does not copy the vocabulary; updating the vocabulary does not require changing the skill.
- The vocabulary is maintained by a person; the model may read it and must not change it during a task (ask the person first if a change is needed).
- `em-dash` targets user-visible Chinese/English prose; code blocks, paths, and quoted originals are not checked.

Data structures:

```ts
interface WriteLikeHumanMetadata {
  readonly version: 1
  readonly kind: 'output-transform'
  readonly triggers: readonly string[]     // at least one trigger
}

type RewriteCheckName =
  | 'facts-unchanged'
  | 'banned-scan-zero'
  | 'max-sentence-chars'
  | 'no-three-part-parallel'

interface BlacklistPattern {
  readonly label: string
  readonly regex: string
}

interface BlacklistV1 {
  readonly version: 1
  readonly banned_terms: readonly string[]
  readonly banned_patterns: readonly BlacklistPattern[]
  readonly checks: readonly RewriteCheckName[]  // all required checks
  readonly max_sentence_chars: number           // positive integer
}

interface RewriteCheckResult {
  readonly check: RewriteCheckName
  readonly ok: boolean
  readonly hits: readonly string[]
}
```

### 8.5 Rewriting and self-checks

Steps:

1. Mark the unchangeable content: code blocks, inline code, numbers, paths, commands, proper nouns, and conclusions.
2. Replace or rewrite according to `banned_terms` / `banned_patterns`; prefer deleting sentences over replacing them with synonymous boilerplate.
3. Merge short sentences, remove "not X but Y" antithetical sentences, remove three-part parallelism, and remove "in summary"-style endings.
4. Self-checks (executable):
   - `facts-unchanged`: extract numbers/paths/inline code; the sets before and after the rewrite are equal;
   - `banned-scan-zero`: scan the body against the vocabulary; the hit count is 0;
   - `no-three-part-parallel`: a regex/syntax check finds no three-part parallelism;
   - `max-sentence-chars`: a single sentence does not exceed the configured value (default 80 Chinese characters);
   - do not add conclusions or promises absent from the original; business criteria are decided by the caller's rules, and the skill does not adjudicate.
5. If any item fails, return to step 2; do not use "more natural" as the pass criterion.

### 8.6 Acceptance (3 items)

1. **Discoverable**: the catalog lists `write-like-human`, and `skill` loading returns the frontmatter + body; `metadata.version=1`, `metadata.kind=output-transform`; the body contains no policy/phase red lines.
2. **Vocabulary active**: given a fixture containing `不是…而是…`, `—`, `总的来说`, and three-part parallelism, after rewriting `banned-scan-zero` is 0 and `facts-unchanged` is true; the original code blocks/paths are unchanged byte for byte.
3. **Negative trigger**: given input containing only code/JSON, the skill's trigger conditions judge it inapplicable; identifiers, numbers, and commands are not rewritten.

### 8.7 Risks

- Over-rewriting damages technical precision; constrain it with the "unchangeable content" list and the facts check.
- A Chinese vocabulary easily produces false positives on quoted originals; scan only the body and exclude block quotes/code blocks.
- The skill is loaded on demand and cannot be guaranteed to be invoked for every output; add a pointer line in persona, but real enforcement requires an output hook, which this round does not build.

## 9. output-summary

### 9.1 Form

**`persona` data in the personality config row + section `690`.** No new store: persona is a small, strongly typed, user-owned configuration that belongs in the existing personality row's volatile config, separate from the PERSONALITY.md entries. The section is registered by the personality provider and read by all agents; the dispatch voice is written as a conditional sentence in the section, and only the super agent actually executes it.

### 9.2 Data model

```yaml
persona:
  tone: direct          # direct | dry | warm | neutral
  length: terse         # terse | normal | detailed
  leadWithConclusion: true
  lists: comparisons    # never | comparisons | steps
  dispatchVoice: terse  # terse | coaching | neutral
```

Data structures:

```ts
type PersonaTone = 'direct' | 'dry' | 'warm' | 'neutral'
type PersonaLength = 'terse' | 'normal' | 'detailed'
type PersonaListStyle = 'never' | 'comparisons' | 'steps'
type PersonaDispatchVoice = 'terse' | 'coaching' | 'neutral'

interface PersonaConfig {                 // raw config; all optional before resolution
  readonly tone?: PersonaTone
  readonly length?: PersonaLength
  readonly leadWithConclusion?: boolean
  readonly lists?: PersonaListStyle
  readonly dispatchVoice?: PersonaDispatchVoice
}

interface ResolvedPersonaConfig {         // what the section renders; all required
  readonly tone: PersonaTone
  readonly length: PersonaLength
  readonly leadWithConclusion: boolean
  readonly lists: PersonaListStyle
  readonly dispatchVoice: PersonaDispatchVoice
}

interface PersonaRenderInput {
  readonly config: ResolvedPersonaConfig
  readonly styleEntries: readonly PersonalityEntry[]  // specific rules already rendered at 100
  readonly dispatch: boolean                          // true for the super agent
}
```

| Field | Effect | Who can write |
|---|---|---|
| `tone` | Default reply tone | A person (settings page/config) |
| `length` | Default length | A person |
| `leadWithConclusion` | Whether to give the conclusion first | A person |
| `lists` | When to use lists | A person |
| `dispatchVoice` | Dispatch voice (conditional sentence) | A person |

- The model cannot write Persona configuration; it can write only concrete `style.*` entries (through `personality_learn`, subject to scope/budget).
- A learned "replies should be short" is not written if it is one-off; if it is durable, write `style.*`, not persona config.
- When configuration is absent, the section text is empty or contains only the hard-boundary sentence; do not let an empty configuration produce empty-section junk.

### 9.3 Injection point

`personality:persona`, order **690**, all agents.

Reason: persona is default expression, placed after plan/team policy so it does not override concrete rules; placed before superagent 702, so 702's hard rules and 705's conventions can override it. Specific `style.*` entries already appear at 100, 690 supplies only defaults, and the text states clearly that "specific style entries take priority".

**Caching**: persona changes only when a person saves it, invalidating from 690 onward; do not write it every turn. A section with empty text should be dropped by assembly and produce no extra tokens.

Fixed hard-boundary text:

```text
Persona defaults never override safety, approval, sandbox, tool permission, or workspace rules. When they conflict, the rule wins.
```

### 9.4 Configurable dimensions and rendering

The section text renders only **non-default/explicit** dimensions to avoid constant noise; it also writes one line for defaults so the model knows the baseline. The order is fixed: tone → length → conclusion → lists → dispatchVoice. `dispatchVoice` is written as a conditional sentence:

```text
When dispatching (super agent only): terse.
```

Fixed status constraints (not disabled by persona configuration):

- State status only from tool receipts: `完成 / 阻塞 / 失败 / 未验证`; without a receipt, write "report delivery unconfirmed", never "reported/closed".
- Do not claim "I will monitor/report back later automatically"; monitor is a request-time query, not a subscription.
- Without `start.stage=prompted`, do not write "started/dispatched".
- Mark repeated reports as `duplicate` first and do not count one result twice; reports with different task ids but identical content must not be merged into "completed twice".
- Write routing results as `→ reuse <title> (<id>)` or `→ new <title>, reason: …`, not "some Session".
- When a person's decision is needed, ask only the one most necessary question; do not package an `ask_user_question` turn-wide cancellation as "waiting".

### 9.5 Acceptance (3 items)

1. **Determinism**: the section text from two assemblies of the same configuration is byte-identical; unknown enums are rejected during config parsing; changing `leadWithConclusion` changes only the corresponding line and not the order of other lines.
2. **Scope/order**: every agent's assembly has `personality:persona` at order 690, before `superagent:dispatcher` (702); workspace agents also have a reply persona, but the `dispatchVoice` line is explicitly conditional.
3. **Hard boundary and status**: the section text must match "never override safety, approval, sandbox, tool permission, or workspace rules"; given a fixture whose persona says "always agree", the hard-boundary sentence still exists and is not overridden by configuration; then given a "report still pending" fixture, the fixed status constraints must forbid "completed/reported".

### 9.6 Risks

- persona and `style.*` overlap; fix the "concrete style wins" text with tests and do not add a second style source.
- persona configuration is a new schema/UI surface and must be changed together with the `ui-personality` form; this round only designs it.
- The dispatch voice is visible to all agents and adds a small number of irrelevant tokens; if measurement proves it wasteful, split out a super-agent-only section later rather than introducing complex target detection now.

## 10. Prerequisites for implementing on another machine

### 10.1 Code and packages

After checking out `origin/cli-desktop` on another machine, locate the implementation points by the package paths below; do not rely on this machine's directories or line numbers:

| Needs change/reuse | Package path | Notes |
|---|---|---|
| personality provider, tools, files, section 100 | `packages/uitstalie/personality` | `personality_learn`'s `scope`/`name`, the classification gate, `persona` config, and the `personality:persona` section |
| organizer interface | `packages/uitstalie/dafeiyu` | The existing `CapabilityContribution` supports only `scope: root/all` and `promptSections`; do not assume it can target only the super agent |
| prompt section/order | `packages/core/system-prompt` | Reuse `PromptSection`; 690/703 are new stable orders and do not change the existing fixed order |
| super agent sections and preset | `packages/jira/jira-agent` | Register `superagent:brief-template` (703) beside the existing `SUPERAGENT_SECTION`, only in the super agent's contribution; do not change the 702 text |
| skill registry and directory | `packages/skill/skill`, `packages/skill/skill-filesystem`, `packages/skill/tool-skill` | The `$DSH_HOME/skills` root and catalog/tool already exist; no new skill root is needed |
| persona settings UI | `packages/uitstalie/ui-personality` | If persona should be editable visually, extend the existing field table; if no UI is built, at least keep the config hand-writable |
| data and file services | `packages/uitstalie/store-atom`, `packages/fs/fs` | Version-guarded writes to PERSONALITY.md, `$DSH_HOME` resolution, and file watching |

**Does the superagent prompt registry need to change?** Yes. `superagent:brief-template` must be registered in the super agent contribution in `packages/jira/jira-agent/src/superagent.ts`, with order 703; it cannot masquerade as "super agent only" through the personality provider's `scope: all`. If changing jira-agent is undesirable, the alternative is a small section provider mounted only on the super agent preset, but that adds a plugin row and is not the preferred option.

### 10.2 Directories and data files

- `PERSONALITY.md`: reuse the existing global `<DSH_HOME>/personality/PERSONALITY.md` and workspace `<workspace>/.dsh/memory/PERSONALITY.md`; do not change the frontmatter, block markers, or history/proposal file names.
- `dispatch-brief.md`: `<DSH_HOME>/personality/dispatch-brief.md`; use the built-in template when absent; the loader must not treat it as part of PERSONALITY.md.
- `write-like-human` skill: `<DSH_HOME>/skills/write-like-human/SKILL.md`, with the vocabulary in `references/blacklist.yaml` in the same directory. `skill-filesystem` already uses `<DSH_HOME>/skills` as the user root; no root-directory convention needs changing.
- If the product chooses to ship the skill with the package rather than placing it in the user directory, install the skill as a bundle resource into the same `<DSH_HOME>/skills` convention, or register a runtime skill; do not hard-code repository paths in code.
- persona data: put it in the personality config row and do not create a separate `persona.yaml`; avoid a second store.

### 10.3 Implementation order and verification prerequisites

- First let `pnpm install`/workspace linking complete, then change the personality config/schema and `personality_learn`; these two changes determine the shape of the test fixtures.
- The existing `personality` tests, `superagent-brief.test.ts`, and the skill install/discovery tests are the prerequisite regressions for their modules; a new section requires testing the assembly of both ordinary agents and the super agent.
- No real LLM is needed to test: section text, config parsing, scope targets, template loader fallback, skill catalog/loader, blacklist checks, and facts diff all work with fixed inputs.
- Items that require a real runtime: whether reports are delivered, the `start` stage, monitor behavior, and `ask_user_question` cancellation; this design treats these only as constraints and does not claim they are verified in this round.

### 10.4 Portability check

Before implementation, check the document with the repository's existing `verify-md-links` and `verify-md-wrap`; data files must contain only `<DSH_HOME>/...` or repository-relative paths, and must not contain local drive letters, user directories, session ids, process ids, or temporary directories.

## 11. Implementation order

| Order | Work | Why here | Prerequisite |
|---:|---|---|---|
| 0 | Finalize the `scope`/`name` extension, the `persona` schema, and the brief template format | These three are data contracts; deciding them first prevents the four modules from each writing their own | This design has passed review |
| 1 | **user-input**: optional `scope`/`name` on `personality_learn`, fixed A–E names, the classification gate, and the model's primary path | All learning passes through it; it determines what later modules write and where | 0 |
| 2 | **write-like-human**: skill + blacklist + self-check script | Decoupled from personality data, lowest risk, verifiable in parallel | 0; skill-filesystem/tool-skill already exist |
| 3 | **output-summary**: persona config + section 690 + `ui-personality` fields | Depends on user-input's priority/scope decisions; affects all agents, so tests come first | 1, 0 |
| 4 | **super-agent-dispatch**: template loader + section 703 + super agent preset integration | Depends on the 702 hard rules and persona voice; highest coupling, so last | 3; super agent preset |
| 5 | Integration: mount all four modules together and test caching/priority/regression | Per-module tests cannot prove conflict order | 1–4 |

If only one module can be done first: **do user-input first**. It directly addresses the root causes among the 13 corrections and does not depend on a new UI; the other three modules can all get stable classification and scope from it.

## 12. Out of scope this round

- Do not write code, change `packages/**`, or commit.
- Do not automatically write `identity.*`; identity still goes only through `personality_propose` + human accept.
- Do not build cross-workspace shared storage, a database, or a second PERSONALITY.md; scope decides only whether to write the global file or the workspace overlay.
- Do not automatically rewrite all output; write-like-human remains an on-demand skill, and an enforcement output hook is a separate discussion.
- Do not automatically change persona configuration, the brief template, or the blacklist; all three are written only by a person.
- Do not change superagent hard rules, approval, sandbox, tool permissions, or KB criteria.
- Do not raise the `autoLearn` default budget; first reduce duplication with classification and fixed names, then measure whether bucketing is needed.
- Do not build multi-user/multi-tenant personality isolation.

## 13. Decisions pending

1. Default value of `personality_learn`'s `scope`: keep workspace (compatible) or change to global (better matching A–E)? This design recommends keeping workspace as the default, with only user-input's automatic path explicitly passing global.
2. Should persona really be visible to all agents, or only to the super agent? This design chooses all + a conditional sentence, because it avoids target detection; split it later if token measurement shows it is not worthwhile.
3. Should the brief template require structure validation at the `start` tool layer, or only prompt + loader validation? This design does only the latter; tool-layer enforcement is a separate change.
4. Should the write-like-human vocabulary allow model-proposed changes? This design forbids the model from writing directly; it may only propose to a person.
