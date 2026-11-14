# dafeiyu personality plugin design (2026-11-13)

English | [中文](dafeiyu-personality-plugin.zh.md)

Status: implemented (Phase 4–6, 2026-11-13). The removal list in 2.1.1 records what the rewrite deleted; the legacy-data rules in 2.2 still apply, and §12 lists what stays out of scope.

## 0. 7 decisions and corresponding changes

| Decision | Implementation in this design | Removed old approach |
|---|---|---|
| 1. personality lives only in the global `.dsh`; workspace overrides are forbidden | Reads, writes, backups, and prompts recognize only `<DSH_HOME>/personality/`; the workspace `.dsh/memory/PERSONALITY.md` is never read or written, and each workspace is warned once when one is found | Remove the overlay, `scope`, workspace writes, and the global/workspace merge rules |
| 2. Cancel turn-end automatic learning | Remove the regex and `onTurnEnd` learning; replace them with a tool that scans session records and produces candidates and evidence | Remove automatic learning, the `autoLearn` budget, and the automatic write path of `personality_learn` |
| 3. Users can invoke analysis explicitly | The `personality_analyze` tool analyzes the current, specified, or most recent N sessions and returns only candidates without changing files; it runs only when the user asks | Remove the implicit path of "learning in the background only at turn end" |
| 4. Drop the old personality directly | Remove the old code; move the old `PERSONALITY.md` to a read-only legacy backup, then never parse or migrate it; the new implementation starts empty | Remove the approach of "adding scope/compatibility layers/old-data migration on top of the old implementation" |
| 5. Merge dispatch rules into the super agent system prompt/rules | Write them directly into the existing `SUPERAGENT_SECTION` (702), at the same layer as the existing rules | Add no separate `703` section, no separate data file, and no second brief injection mechanism; none exists in HEAD |
| 6. Turn write-like-human into a tool with customizable prompt rules | The new `write_like_human` tool manages a global rules file and injects the rules into the prompt; the tool handles CRUD/enable/disable/preview | No skill-only implementation or blacklist file exists in HEAD; write-like-human is added as a tool, not renamed from a skill |
| 7. Use `output-style` for the config | The config object, file names, section name, and test fixtures all use `output-style`/`outputStyle`; `persona` remains the deployment persona prefix and persona-card concept, not this config | `output-summary` is not a current name; do not introduce it, and do not rename the separate `persona` concepts |

## 1. Conclusion

The four modules keep their division of responsibilities, but all their forms change to "global personality capability + tools + fixed prompt rules": no more workspace personality, no more background automatic learning, no more separate dispatch section, and write-like-human is no longer built as a skill.

| Module | Form | Location |
|---|---|---|
| user-input | Global personality data + `personality_analyze` / `personality_apply` tools | `PERSONALITY.md`, section 100 |
| super-agent-dispatch | Part of the existing super agent static rules | `SUPERAGENT_SECTION`, section 702 |
| write-like-human | Tool + rules file + injection section | `WRITING_RULES.yaml`, section 695 |
| output-style | Global config + injection section | `OUTPUT_STYLE.yaml`, section 690 |

**There is exactly one global root:** all personality data lives under `<DSH_HOME>/personality/`; `<DSH_HOME>` comes from the existing home resolution logic, and no machine directory is hard-coded. A workspace has no personality file and no override read path.

## 2. Old implementation exit

### 2.1 Code layer

The current implementation is a maintained capability, not an unmaintained draft: it registers contract v2, keeps the global profile plus a workspace overlay, and ships version-guarded history, identity proposals, a settings page, and 50 tests (`packages/uitstalie/personality`, `packages/uitstalie/ui-personality`). This design replaces it deliberately; the old tests are not acceptance for the new implementation. Removal scope:

- The old provider, `personality_learn`, `personality_propose`, proposal queue, `/personality` command, old prompt section, overlay watcher, and old version/history logic in `packages/uitstalie/personality`.
- The old proposal page and old settings fields in `packages/uitstalie/ui-personality`.
- The lines that mount the old provider/UI in `packages/bundle/web-app/cordis.patch.uitstalie.yml`; the new implementation decides mounting points again and does not reuse old config fields.
- The old package's exported API keeps no compatibility aliases; new tool names, section names, and data files require a new design.

### 2.1.1 Removed in the implementation

| Removed surface | Detail |
|---|---|
| Old source modules | `commands.ts`, `proposals.ts`, `remote.ts`, `types.ts`, `tools.ts`, `prompt.ts`, `personality-file.ts`, and `config.ts` |
| Old tests | `tests/commands.spec.ts` and `tests/personality-file.spec.ts` |
| Old UI package | `packages/uitstalie/ui-personality` (27 tracked files, including its README and locale files) |
| Package exports | `./remote`, `./types`, `./typert`, and `./locale/*.json` |
| Config | `Config` removed; `workspaceOverlay`, `maxBytes`, `autoLearn`, and `historyLimit` are no longer read. A profile row that still carries them loads because the Loader does not reject unknown keys, and the values are ignored. |
| Dependencies | the `@deepseek-ai/dsh-commands` peer, `@deepseek-ai/schemastery`, `diff`, and `@deepseek-ai/dsh-typert-protocol` |
| Mounting and project refs | the `ui-personality` row in `cordis.patch.uitstalie.yml`, its `tsconfig.host.json` / `tsconfig.client.json` / `tsconfig.base.json` references, and the generated slot-catalog entry |
| Model surface | `personality_learn`, `personality_propose`, the `/personality` command, the proposal Remote, and the turn-end learning hook |

**What is deleted is the implementation, not the user data.** Data is handled per 2.2.

### 2.2 Data layer

The old data files keep one read-only backup; after that they are never parsed or migrated:

| Old file | Handling |
|---|---|
| `<DSH_HOME>/personality/PERSONALITY.md` | On the first startup of the new implementation, **move** the old file with `ctx.fs.moveFile` to `<DSH_HOME>/personality/legacy/PERSONALITY.<YYYYMMDDTHHMMSSZ>.md` (UTC, no colons; add `-1`, `-2` on collision), guarded by the observed source version. If the backend cannot move, use read → write legacy with `createIfAbsent` → re-read and compare hash → remove old; a failure at any step keeps the old file, creates no new `PERSONALITY.md`, and blocks writes with an error. If a crash leaves both files, compare hashes on the next startup: identical means finish the removal, different means keep both and report. |
| `<DSH_HOME>/personality/PERSONALITY.history.jsonl` | Do not parse, read, delete, or rename; leave it in place as historical evidence. The new implementation does not create a history file and never reuses this name. |
| `<DSH_HOME>/personality/PERSONALITY.proposals.jsonl` | Do not parse, read, or delete; leave it in place as historical evidence. There is no importer for queued or accepted identity entries in this rewrite. |
| `<workspace>/.dsh/memory/PERSONALITY.md` | Do not read, write, or delete; give a one-time warning when first found in each workspace, stating that "only global personality is supported and the workspace file is ignored". |

**Why not delete the old data directly:** the old file may be the user's only personality record, and deletion is irreversible. This design authorizes only "back up + ignore", not deletion. If the user explicitly asks to delete the data, open a separate explicit cleanup operation; this round does not do it.

### 2.3 Compatibility impact

Direct consumers of the old implementation:

| Consumer | Impact |
|---|---|
| `packages/uitstalie/personality` itself and its tests | Deleted/rewritten; the old tests cannot serve as acceptance for the new implementation |
| `packages/uitstalie/ui-personality` | The old proposal/settings pages are removed; new output-style/writing-rules pages are separate work |
| `packages/bundle/web-app/cordis.patch.uitstalie.yml` | The old mounting lines are removed or replaced; personality lines added manually to old profiles need migration to new lines |
| Old `personality_learn` / `personality_propose` callers | The tools disappear; the new tools are `personality_analyze` / `personality_apply`, with no automatic writes |
| Consumers that import `@deepseek-ai/dsh-personality` from another workspace package | The old exported API is removed; this is a breaking change and needs release notes/an upgrade guide |
| External scripts that read `<workspace>/.dsh/memory/PERSONALITY.md` | The new implementation no longer reads it; scripts receive no hint and can rely only on the one-time warning or documentation |

Not migrating old data, not keeping the old API compatible, and not reading old workspace files are explicit costs of this design.

## 3. Global data and files

### 3.1 Directory

| File | Purpose | Who can write |
|---|---|---|
| `<DSH_HOME>/personality/PERSONALITY.md` | user-input entries: understanding / preference / style; identity is manual-only | `personality_apply` (confirmation required) or a person |
| `<DSH_HOME>/personality/OUTPUT_STYLE.yaml` | ordinary-root output style: tone/length/conclusion/lists/dispatch voice | A person; tools read only |
| `<DSH_HOME>/personality/SUPERAGENT_OUTPUT_STYLE.yaml` | super-root output style (independent slot) | A person; tools read only |
| `<DSH_HOME>/personality/WRITING_RULES.yaml` | write-like-human's rule set | The `write_like_human` tool (when the user asks) or a person |
| `<DSH_HOME>/personality/legacy/PERSONALITY.<YYYYMMDDTHHMMSSZ>.md` | Read-only backup of the old file | Written once by the new implementation, then never written again |

No workspace personality file exists; all tools write only the global paths above.

On first activation the implementation creates `OUTPUT_STYLE.yaml` and `SUPERAGENT_OUTPUT_STYLE.yaml` with the defaults in 3.3 and an empty `WRITING_RULES.yaml`; it does not create or seed `PERSONALITY.md`.

### 3.2 PERSONALITY.md data structure

The new implementation starts from an empty file and does not parse the old format. New format:

```markdown
---
version: 1
updatedAt: <UTC ISO-8601>
entries:
  - id: understanding.role-prefix
    kind: understanding
    text: The prefix names the executor; the rest is the task.
  - id: preference.scope
    kind: preference
    text: Act only on the objects the user names and their direct implications.
---
```

```ts
type PersonalityEntryKind = 'understanding' | 'preference' | 'style' | 'identity'

interface PersonalityEntry {
  readonly id: string                 // <kind>.<lower-kebab-name>, unique
  readonly kind: PersonalityEntryKind
  readonly text: string               // one paragraph, max 400 chars
}

interface PersonalityDocument {
  readonly version: number            // positive integer; version-guarded write
  readonly updatedAt: string          // UTC ISO-8601
  readonly entries: readonly PersonalityEntry[]  // sorted by kind, then id
}
```

- `understanding` describes only "how to read user input"; `preference` describes "how to do things"; `style` describes "concrete reply rules"; `identity` is manual-edit-only, the tool refuses to write it, and this rewrite provides no importer for legacy identity entries.
- All entries are global; there is no same-name workspace override and no overlay merge.
- Writes use a version guard; a failure does not overwrite the old file. History and revert are removed from the runtime; the old `PERSONALITY.history.jsonl` is left untouched, and the new implementation never creates, reads, or reuses that name.
- The document body is capped at 32 KiB UTF-8; a write that would exceed it is rejected without overwriting.

### 3.3 OUTPUT_STYLE.yaml data structure

```yaml
version: 1
tone: direct          # direct | dry | warm | neutral
length: terse         # terse | normal | detailed
leadWithConclusion: true
lists: comparisons    # never | comparisons | steps
dispatchVoice: terse  # terse | coaching | neutral
```

```ts
type OutputTone = 'direct' | 'dry' | 'warm' | 'neutral'
type OutputLength = 'terse' | 'normal' | 'detailed'
type OutputListStyle = 'never' | 'comparisons' | 'steps'
type OutputDispatchVoice = 'terse' | 'coaching' | 'neutral'

interface OutputStyleConfig {
  readonly version: 1
  readonly tone: OutputTone
  readonly length: OutputLength
  readonly leadWithConclusion: boolean
  readonly lists: OutputListStyle
  readonly dispatchVoice: OutputDispatchVoice
}
```

### 3.4 WRITING_RULES.yaml data structure

```yaml
version: 1
rules:
  - id: no-em-dash
    text: 面向人的正文不用 em dash；代码、路径、引用原文除外。
    enabled: true
    order: 10
  - id: no-not-x-but-y
    text: 避免“不是……而是……”的对偶句；直接说结论。
    enabled: true
    order: 20
```

```ts
interface WritingRule {
  readonly id: string                 // lower-kebab, unique
  readonly text: string               // one rule, 1..240 chars
  readonly enabled: boolean
  readonly order: number              // integer; smaller first
}

interface WritingRulesDocument {
  readonly version: 1
  readonly rules: readonly WritingRule[]  // max 100; total text <= 32 KiB
}
```

- `WRITING_RULES.yaml` is written only by the tool or a person; the model cannot change the file directly.
- Rules are "executable writing constraints", not skill body text; there is no skill catalog dependency and no separate blacklist file.

## 4. Injection order and caching

### 4.1 Order table

| Order | Name | Type | Scope | Notes |
|---:|---|---|---|---|
| -1000 | `harness:identity` | section | all | Platform identity |
| 0 | `deployment:persona-prefix` | section | all | Deployment persona prefix (an existing platform section, not the output-style config) |
| 100 | `personality` | section | all | understanding / preference / style / identity entries |
| 500 | `PLAN_POLICY` | section | all | Plan policy |
| 600 | `TEAM_POLICY` | section | all | Team policy |
| 690 | `personality:output-style` | section | all | output-style default expression |
| 695 | `personality:writing-rules` | section | all | Enabled write-like-human rules |
| 702 | `superagent:dispatcher` | section | super agent | Existing rules + merged brief rules |
| 704 | `superagent:workspaces` | runtime context | super agent | Registered workspaces, rebuilt per request |
| 705 | `superagent:conventions` | runtime context | super agent | Workspace conventions, updated when files change |
| 706 | `superagent:running` | runtime context | super agent | Long-task status, rebuilt per request |
| 1000+ | Tool sections | section | all | Tool descriptions |

**There is no 703 and no `dispatch-brief.md` in HEAD.** Do not add a separate section or data file. The three new names are `PERSONALITY` (100), `PERSONALITY_OUTPUT_STYLE` (690), and `PERSONALITY_WRITING_RULES` (695); all three are added to `SECTION_ORDERS` and resolved through `getSectionOrder`.

### 4.2 Cache impact

| Change | Invalidated range | Design tradeoff |
|---|---|---|
| `PERSONALITY.md` entry changes | From 100 | Happens only after the user confirms `personality_apply`, low frequency; no background automatic writes |
| `OUTPUT_STYLE.yaml` changes | From 690 | Edited by a person, low frequency |
| `WRITING_RULES.yaml` changes | From 695 | Tool CRUD, bounded by size limits; invalidated only by enable/order/text changes |
| `SUPERAGENT_SECTION` changes | From 702 | Static rules, deployment-level changes |
| runtime context | 704–706 | Rebuilt per request; does not affect the system prefix |

Rule files must not contain timestamps, seqs, current task names, or other volatile content; these go only in tool results or runtime context.

## 5. user-input: tool-based collection and confirmation

### 5.1 Data and classification

Reuse `understanding` / `preference` / `style` from `PERSONALITY.md`; `identity` is manual-only. There is no workspace copy.

The A–E and expression-habit tables are analysis targets, not seed data; `PERSONALITY.md` starts empty.

- `understanding`: interpretation of sentence patterns, word choice, modal particles, role prefixes, and ellipsis/rhetorical questions.
- `preference`: A–E work preferences (scope, authorization, abstraction, simplification, consistency, reconciliation).
- `style`: concrete reply-style rules; output-style manages defaults, and `style` entries override specific scenarios.
- One entry can belong to only one class; mixed content is split into two entries or rejected.

A–E analysis candidates:

| Root cause | Entry id | Rule |
|---|---|---|
| A Overreach | `preference.scope`, `preference.authorization` | Act only on the named objects and their direct implications; decide independently within the authorization, and ask only when the boundary changes |
| B Abstraction | `preference.no-invented-abstractions` | Do not invent code names/intermediate structures; cite by single number or `doc_id《标题》` |
| C Simplification | `preference.no-overinterpretation` | Do not treat "tidy up" as "interpret"; write only to the provable level |
| D Default conservatism | `preference.consistency-first` | When an inconsistency is found, the goal is to remove it, not preserve the status quo |
| E Missed reconciliation | `preference.inventory-sources` | For multi-source tasks, first list the reviewed/changed/unchanged objects |

Expression-habit candidates:

| Habit | Entry id | Interpretation |
|---|---|---|
| `<角色>：<指令>` | `understanding.role-prefix` | The prefix names the executor; only the latter half is the task |
| Omitted subject/object | `understanding.ellipsis` | Take the nearest context; confirm in one line when necessary, and do not ask a string of questions |
| Rhetorical question expressing affirmation | `understanding.rhetorical-question` | Usually a conclusion notification, not a question |
| Mixed Chinese/English | `understanding.mixed-terms` | skill/MR/KB/log/app are common terms; do not translate |
| First/after markers | `understanding.sequence` | Order is a hard constraint; completing the previous action is a prerequisite |

### 5.2 personality_analyze

Purpose: when the user says "analyze my recent expressions/preferences" or explicitly requests it, scan session records and produce candidates and evidence; **read-only, no file writes**.

```ts
type AnalysisScope =
  | { readonly kind: 'current' }
  | { readonly kind: 'session'; readonly sessionId: string }
  | { readonly kind: 'recent'; readonly limit: number }  // 1..20

interface AnalyzeInput {
  readonly scope: AnalysisScope                 // required
  readonly kinds?: readonly PersonalityEntryKind[]  // optional; identity rejected
  readonly maxCandidates?: number               // optional, 1..20, default 10
}

interface EvidenceRef {
  readonly sessionId: string
  readonly seq: number                          // positive
  readonly quote: string                        // exact excerpt, max 400 chars
  readonly turn?: number
}

interface PersonalityCandidate {
  readonly candidateId: string                  // stable hash of kind+name+text
  readonly kind: Exclude<PersonalityEntryKind, 'identity'>
  readonly name: string                         // lower-kebab
  readonly text: string                         // proposed entry text
  readonly evidence: readonly EvidenceRef[]     // at least one
  readonly occurrences: number                  // across scanned sessions
  readonly confidence: 'high' | 'medium'
}

interface AnalyzeResult {
  readonly candidates: readonly PersonalityCandidate[]
  readonly sessionsScanned: number
  readonly truncated: boolean
  readonly warnings: readonly string[]          // legacy workspace files, unreadable sessions
}
```

- `scope: current` reads only the current Session; `session` reads the specified id; `recent` reads the most recent N readable Sessions.
- Evidence must be a concrete excerpt and seq; it cannot be only a summary such as "the user often says this".
- Do not call `memory_search` as a required step; read session records directly. When retrieval is unavailable, return `warnings`; do not fabricate evidence.
- Do not write files, change the prompt, or apply automatically.

### 5.3 personality_apply

Purpose: when the user has reviewed the candidates and explicitly says "write/apply", or on manual confirmation, write to the global `PERSONALITY.md`.

```ts
interface ApplyCandidate {
  readonly kind: Exclude<PersonalityEntryKind, 'identity'>
  readonly name: string
  readonly text: string
  readonly evidence: readonly EvidenceRef[]     // at least one
}

interface ApplyInput {
  readonly candidates: readonly ApplyCandidate[]  // 1..20
  readonly confirm: true                          // required literal
}

interface ApplyResult {
  readonly applied: readonly string[]             // entry ids
  readonly rejected: readonly { readonly name: string; readonly reason: string }[]
  readonly path: string                           // global PERSONALITY.md
  readonly revision: number
}
```

- `confirm` must be the literal `true`; the tool description requires "call only after the user explicitly asks to apply".
- Write only `<DSH_HOME>/personality/PERSONALITY.md`; when an old workspace file is found, only warn, do not read or write it.
- Reject `identity`; identity can only be edited manually by a person.
- The same `id` is an update, not an addition; `name` is stable for deduplication.
- There is no automatic call path: no turn-end hook, no regex, no budget counter.

### 5.4 Acceptance (3 items)

1. **Analysis scope**: `sessionsScanned` is correct for the three fixtures `current`/`session`/`recent`; every candidate has at least one `EvidenceRef`, and `quote` comes from a real excerpt in that session; `PERSONALITY.md` is unchanged before and after `personality_analyze`.
2. **Confirmation gate**: when `confirm` is missing or false, reject and do not write; `identity` candidates are rejected; applying the same `id` twice keeps only one entry and updates its text.
3. **Single global copy**: construct `workspace/.dsh/memory/PERSONALITY.md`; `personality_analyze`/`apply` do not read or write it and return one warning only; every write path matches `<DSH_HOME>/personality/PERSONALITY.md`.

### 5.5 Risks

- Analysis may extract a "pseudo-preference" from a one-off task; when evidence is insufficient, return only `medium` and require manual confirmation.
- With many sessions, reading `recent` is expensive; limit it to 20, truncate results, and set `truncated`.
- A single global file has no overlay, so workspace-specific preferences can only rely on the current turn's instructions; this is the explicit cost of decision 1.

## 6. super-agent-dispatch: merged into existing rules

### 6.1 Form

**Modify the text of the existing `SUPERAGENT_SECTION` (order 702) directly**, writing the brief template into the same section. There is no separate section, no `dispatch-brief.md`, and no new injection mechanism.

### 6.2 Rule content

Append the fixed template after the existing rule that "a brief has only two sources and must not invent standards":

```text
Brief slots (fill every slot; no slot has a default):
目标: <one objective; quote the person>
验收: <what proves it; person or destination AGENTS.md#superagent:conventions only>
边界: <in scope / out of scope / stop conditions>
证据来源: <workspace-relative paths, commands, convention anchors>

Result contract:
- First line: status: done | blocked | failed | unverified · task_id: <only when supplied>
- Last line: artifacts: <workspace-relative paths> · checks: <commands actually run>
- No report or no artifact means not done.
- Do not use interactive ask_user_question in a dispatched task; return one blocking question instead.
- Do not require memory_search; do not modify ACLs, admin permissions, or system directories.
```

- This template is at the same layer as the existing rules; `SUPERAGENT_SECTION` remains the only source.
- 2026-11-14 user decision: comparison, selection, and A/B acceptance must give per-dimension verdicts with numeric evidence, name which dimension improves or worsens and under what condition, and mark unmeasured dimensions "untested + why"; a single "better overall" verdict is forbidden.
- 2026-11-14 user criticism: do not dispatch implementation paths, commands, or step lists; give only goal, acceptance, and boundaries, and offer a method only when the workspace says it cannot start.
- Relationships with `superagent:workspaces` (704), `superagent:conventions` (705), and `superagent:running` (706): 702 is the static rule; 704 provides workspace identity; 705 provides the target workspace conventions, and 702 requires citing them; 706 provides long-task status. No new order.
- On conflict, 702's "two sources, do not invent standards" takes priority over any wording in the template; the template is only an execution form.

### 6.3 Acceptance (3 items)

1. `SUPERAGENT_SECTION` text contains the four slots, `status/task_id`, `artifacts/checks`, the `interactive ask` prohibition, `memory_search` not required, and the ACL prohibition; an ordinary workspace agent's prompt does not contain these super agent rules.
2. No new `703` section is added; the section order remains 702 and runtime context remains 704–706; the test asserts that the assembly has no `superagent:brief-template`.
3. All hard rules of the existing `superagent-brief.test.ts` still match; a new fixture writing "counts only, no names" is still covered by "never invent a standard".

### 6.4 Risks

- The rule text grows, increasing the fixed per-request cost for the super agent; this is the cost of merging the template into 702.
- 702 is already large; implement only the necessary slots and failure constraints, and do not copy the content of `superagent:conventions` again.

## 7. write-like-human: rules tool

### 7.1 Form

**Tool `write_like_human` + global `WRITING_RULES.yaml` + prompt section 695.** It is not a skill, does not depend on the skill catalog, and no longer has a separate blacklist file. It is implemented in `src/writing-tool.ts` and registered only for a root agent through the organizer's `tools(agent)` filter; section 695 is still injected for every agent.

### 7.2 Tool interface

```ts
type WritingRuleAction = 'list' | 'add' | 'update' | 'remove' | 'enable' | 'disable' | 'preview'

interface WriteLikeHumanInput {
  readonly action: WritingRuleAction                 // required
  readonly id?: string                               // required for update/remove/enable/disable
  readonly text?: string                             // required for add/update; 1..240 chars
  readonly order?: number                            // optional for add/update
  readonly enabled?: boolean                         // optional for add/update
}

interface WritingRuleView {
  readonly id: string
  readonly text: string
  readonly enabled: boolean
  readonly order: number
}

interface WriteLikeHumanResult {
  readonly action: WritingRuleAction
  readonly rules: readonly WritingRuleView[]         // current list, sorted by order then id
  readonly promptSection?: string                    // preview only; enabled rules joined
  readonly path: string                              // global WRITING_RULES.yaml
  readonly revision: number
}
```

- `add` generates a lower-kebab id automatically (or accepts an explicit id) and rejects duplicates; `update` keeps the id; `remove` deletes; `enable/disable` toggles.
- `preview` returns only the injected text and does not write files.
- All write operations write only `<DSH_HOME>/personality/WRITING_RULES.yaml`; there is no workspace path.
- The tool modifies only when the user asks; no rules are generated automatically.

### 7.3 Injection

`personality:writing-rules`, order **695**, all agents.

The text contains only enabled rules, sorted by ascending `order` and then by id for the same order; when the set is empty the section is empty (dropped by assembly). Each rule is one line; ids/timestamps are not rendered.

Size limits:

- At most 100 rules; each rule 1–240 characters; the combined body of enabled rules is ≤ 32 KiB UTF-8 bytes. Only the first 40 enabled rules are resident; the rest are stored with an omission notice.
- Above the limit: the tool rejects the write and reports the current byte/entry count; it does not silently truncate.
- When the injected text exceeds 32 KiB, refuse to save; the 40-rule resident cap bounds the section even when more rules are stored.

### 7.4 Priority

Highest to lowest:

1. Platform/system/approval/sandbox.
2. Explicit user instructions in the current turn ("do not use that rule this time").
3. superagent hard rules and workspace conventions (702/705).
4. writing rules (695) — concrete output rules.
5. `style` entries in `PERSONALITY.md` (100) — concrete scenario rules.
6. output-style defaults (690).

writing rules cannot override the first two layers; when they conflict with output-style, the concrete writing rule wins; when they are at the same level as `style` entries, the rule with the more specific id comes first, and the section text states clearly that "more specific rules take priority".

### 7.5 Acceptance (3 items)

1. **CRUD**: after `add` → `list` → `update` → `disable` → `remove`, the file keeps only the expected rules; disabled rules do not appear in `preview`/the section; after `remove` the section does not contain that rule.
2. **Limits/injection**: writes are allowed within the 100-rule/32 KiB boundary, and beyond it are rejected without changing the file; section order is 695, sorted by order/id, and an empty set produces no text.
3. **Conflict**: a fixture has both output-style "terse" and a writing rule "explain in detail"; the section text specifies that the writing rule wins; a fixture has both a superagent hard rule and a writing rule, and the hard rule wins. The tool does not modify 702.

### 7.6 Risks

- Rules are written by a person and may contradict each other; the tool can only sort them and cannot judge semantic conflicts; conflicts are handled by section priority and manual review.
- The 32 KiB limit restricts the number of rules; only 40 are resident, so a large library needs curation rather than unlimited resident growth.
- All agents receive the injection, and overly broad rules pollute tool-style output; rule text states clearly "user-visible prose only", and code/JSON are not changed.

## 8. output-style: global configuration

### 8.1 Form

**Global `OUTPUT_STYLE.yaml` + section 690.** The name is uniformly `output-style`; there is no `output-summary`; `persona` is the deployment persona prefix and persona-card concept, not this config field.

### 8.2 Configuration and injection

Data is in 3.3. Section `personality:output-style`, order **690**, all agents.

```ts
interface OutputStyleRenderInput {
  readonly config: OutputStyleConfig
  readonly styleEntries: readonly PersonalityEntry[]  // from PERSONALITY.md at 100
  readonly dispatch: boolean                          // true for super agent
}
```

- Fixed field order: `tone` → `length` → `leadWithConclusion` → `lists` → `dispatchVoice`.
- Concrete `style` entries (100) take priority over output-style defaults; the section text states this.
- `dispatchVoice` is written as a conditional sentence, and only the super agent actually executes it.

Fixed hard boundary:

```text
Output style never overrides safety, approval, sandbox, tool permission, or workspace rules. When they conflict, the rule wins.
```

Fixed status constraints (not disabled by configuration):

- State `done / blocked / failed / unverified` only from tool receipts; without a receipt, write "report delivery unconfirmed".
- Do not say "I will monitor/report back later automatically"; monitor is a query, not a subscription.
- Without `start.stage=prompted`, do not write "started/dispatched".
- Mark repeated reports as `duplicate`; write routing as `→ reuse <title> (<id>)` or `→ new <title>, reason: …`.
- When a person's decision is needed, ask only one necessary question; do not package an `ask_user_question` whole-turn cancellation as "waiting".

### 8.3 Acceptance (3 items)

1. **Naming**: code, configuration, sections, and fixtures use `output-style`/`outputStyle`; `output-summary` must not appear; `persona` is allowed only for the existing deployment persona prefix and persona-card concepts. All `outputStyle` fields parse, and unknown enums are rejected.
2. **Order/scope**: section order 690, present for all agents; before `SUPERAGENT_SECTION` (702); `style` entries are at 100, and concrete rules take priority.
3. **Hard boundary/status**: the section matches "never overrides safety, approval, sandbox, tool permission, or workspace rules"; given a "report pending" fixture, the fixed status constraints forbid "completed/reported".

### 8.4 Risks

- The global default style cannot vary by workspace; this is the cost of decision 1, and workspace differences can only rely on concrete `style` entries or the current turn's instructions.
- `dispatchVoice` is visible to all agents but executed only by the super agent, producing a small number of irrelevant tokens; if measurement proves it wasteful, split it later, but this round adds no target detection.

## 9. Data flow

```text
用户要求分析
  → personality_analyze(scope=current|session|recent)
      → 读取会话记录，产出 candidates + evidence
      → 不写文件

用户确认
  → personality_apply(candidates, confirm=true)
      → 只写 <DSH_HOME>/personality/PERSONALITY.md
      → section 100 下次 assembly 生效

用户维护写作规则
  → write_like_human(add/update/remove/enable/disable)
      → 只写 <DSH_HOME>/personality/WRITING_RULES.yaml
      → section 695 下次 assembly 生效

用户编辑输出风格
  → OUTPUT_STYLE.yaml
      → section 690 下次 assembly 生效

super agent 派发
  → SUPERAGENT_SECTION 702（含 brief 模板）
  → runtime context 704–706（工作区/约定/长任务）
```

## 10. Implementation order

| Order | Work | Why | Prerequisite |
|---:|---|---|---|
| 1 | Remove the old personality implementation; implement the legacy backup/workspace warning | Prevent old tools and old data from continuing to produce behavior; define the boundary first | None |
| 2 | Build the new global `PERSONALITY.md` data layer + `personality_analyze` / `personality_apply` + section 100 | user-input is the foundation of the new design; the other modules depend on the global data model | 1 |
| 3 | `output-style` configuration + section 690 | Depends on global configuration and section order; independent of tools | 2 |
| 4 | `write_like_human` tool + `WRITING_RULES.yaml` + section 695 | Needs section order and the global write path; CRUD can be tested independently | 2 |
| 5 | Merge the brief template into `SUPERAGENT_SECTION` | Changes only the 702 text; depends on the existing superagent rules and runtime context | None (can run in parallel with 2–4, but test conflicts last) |
| 6 | Integration tests: injection order, caching, global paths, old-data backup/warnings | Per-module tests cannot prove priority and global constraints | 1–5 |

Do 1 first because "drop the old implementation directly" is the highest constraint; if the old code remains, other modules will be polluted by old tools/old sections.

## 11. Prerequisites for implementing on another machine

### 11.1 Packages and change points

| Needs change/reuse | Package path | Notes |
|---|---|---|
| Old personality implementation | `packages/uitstalie/personality` | Delete the old provider/tools/commands/proposals/overlay; put the new implementation in the same package or a new one, and per decision 4 do not reuse the old API |
| Old UI | `packages/uitstalie/ui-personality` | Remove the old proposal pages/settings fields; build new output-style/writing-rules pages separately |
| Organizer | `packages/uitstalie/dafeiyu` | The new personality can still register as a capability; tools and sections use the existing contribution |
| prompt order | `packages/core/system-prompt` | 100/690/695/702 reuse/add fixed orders; do not change mechanisms outside the fixed table |
| super agent rules | `packages/jira/jira-agent` | Change only the `SUPERAGENT_SECTION` text; add no section and no `703` |
| Global file service | `packages/uitstalie/store-atom`, `packages/fs/fs` | Global `$DSH_HOME` reads/writes, version guard, file watching |
| web mounting | `packages/bundle/web-app/cordis.patch.uitstalie.yml` | Replace old personality/UI lines; new tools and pages need new lines |

No new skill directory is needed, and `skill-filesystem`/`tool-skill` need no changes; write-like-human is an ordinary tool.

### 11.2 Implementation-order prerequisites

- Decide the new `PERSONALITY.md` format and the legacy backup path before writing tools; otherwise `personality_apply` will write old-format compatibility code.
- Old data backup must complete before the first new write; when the backup fails, new writes are forbidden.
- The workspace old-file warning is process-wide once (once per workspace path); do not spam the log on every request.
- Tool visibility: `personality_analyze` is visible to every agent; `personality_apply` and `write_like_human` are root-only, enforced through the dafeiyu `tools(agent)` filter rather than a prompt. Section 695 stays all-agent, so child agents read the rules but cannot change them.
- `write_like_human` modifies global rules; it is exposed only to the root agent. The rules section is injected for all agents, so read access does not depend on the tool.

### 11.3 Data and paths

- All paths use `<DSH_HOME>/personality/...`; do not write local drive letters, user directories, session ids, process ids, or temporary directories.
- Do not create personality files for workspaces; old workspace files only warn.
- Old global files/history/proposals are not migrated; after backup they are not parsed.

## 12. Not done in this rewrite

- The new output-style/writing-rules UI pages are not part of this rewrite.
- Do not build workspace override/overlay/scope; do not write workspace personality.
- Do not build turn-end automatic learning, regexes, background scanning, or automatic writes.
- Do not migrate old data; do not delete old data; do not keep old API compatibility aliases.
- Do not build a separate dispatch section/data file/`703`.
- Do not build skill-only write-like-human; do not add a skill directory.
- Do not change superagent runtime context mechanisms outside `SUPERAGENT_SECTION`.
- Do not delete `PERSONALITY.history.jsonl` / `PERSONALITY.proposals.jsonl`; leave them in place.
- Do not build multi-user/multi-workspace personality isolation.

## 13. Decisions pending

1. Should old data be **deleted** after backup? This design only backs up and does not delete; if the user wants deletion, a separate explicit cleanup command is required.
2. Does the Loader reject unknown config keys? If yes, keep `workspaceOverlay` as an ignored deprecated key for one release and annotate it in the config catalog; otherwise delete the field.
3. Resolved: the `write_like_human` tool is given only to the root agent, through `tools(agent)`; child agents receive section 695 as read-only context.
