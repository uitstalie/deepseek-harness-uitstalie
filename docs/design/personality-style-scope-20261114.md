# Personality style scope and long-term library evaluation (2026-11-14)

English | [中文](personality-style-scope-20261114.zh.md)

Status: **evaluation only; no code, quota, or section was changed in this round.**

This document answers three product directions: agent-type gating, a long-term style library, and the boundary between section 690 and section 702. It also records the version-conflict decision: #5 remains description-only.

## A. Quota for a long-term style library

### Current limits

`WRITING_RULES_MAX_RULES = 32`, `WRITING_RULES_MAX_TEXT_CHARS = 240`, and `WRITING_RULES_MAX_TEXT_BYTES = 4096` (`packages/uitstalie/personality/src/writing-rules.ts:27-33`). The byte cap binds before the rule cap for English text at the current single-rule size: about 17 rules fit in 4 KiB. The current library is therefore a hard-rule list, not a long-term style library.

### Token-cost estimate

Assume one enabled rule renders as one resident line, roughly 240 characters, and the tokenizer counts 44 tokens for a 242-character sample. Token counts vary by language and wording; the table is an estimate, not a measurement of current user data.

| Rules | Rule characters | Approx. tokens | Share of a 128k context |
|---:|---:|---:|---:|
| 10 | 2,400 | 440 | 0.34% |
| 30 | 7,200 | 1,320 | 1.01% |
| 100 | 24,000 | 4,400 | 3.36% |
| 300 | 72,000 | 13,200 | 10.08% |

The 300-rule case consumes about a tenth of a 128k context before the conversation starts. That is why unlimited resident accumulation is not a good long-term design.

### Two directions

1. **Full resident + higher quota.** Simple: every enabled rule is injected on every request. The cost is exactly the table's linear growth. This is acceptable around 100 rules (about 3.4% of 128k at 240 characters each) and unattractive at 300.
2. **Tiered: small resident core + on-demand retrieval.** Keep a curated core resident (for example 20 rules, about 880 tokens, 0.69%), and make the rest searchable through an explicit lookup tool. The cost is a retrieval surface: the model may miss a rule, retrieval adds a tool call and latency, and the library needs stable ids/tags.

**Recommendation: tiered.** Set the hard storage ceiling at **100 rules / 240 characters per rule / 32 KiB total**, but keep only a core of about **20 rules** resident by default and retrieve the rest on demand. The 32 KiB byte cap still governs multilingual content; 100 Chinese rules can hit the byte ceiling before the rule count. Full resident remains a valid simple mode for a small library; 300 resident rules is not recommended.

## B. Agent-type gating

### Current behavior

Section 690 is registered for **all** agents: the capability declares `scope: 'all'` and `promptSections` returns the same three sections without an agent-type filter (`packages/uitstalie/personality/src/index.ts:116-154`). The dispatch flag only changes the rendered `Dispatch voice` line; it does not gate the section (`index.ts:112`, `output-style.ts:145-164`).

`isRootAgent` is the only current classification (`index.ts:231-235`): it requires `origin !== 'subagent'`, no `parentSession`, and `delegationDepth === 0`. This separates a delegated subagent from a root, but **does not distinguish an ordinary root from the super agent**; both satisfy it. The super agent is the root Session whose cwd is the configured super workspace (`packages/jira/jira-agent/src/index.ts:174-186`), and the workspace title is `Super agent` (`superagent.ts:100`). Personality itself receives no super-agent role flag; `AgentHeader.origin` is typed only as `'subagent'` today (`packages/core/agent/src/index.ts:82-85`), not a super/ordinary role.

**Current ordinary/super difference: one line.** Both use the same `OUTPUT_STYLE.yaml` and the same `renderOutputStyleSection`; the super agent gets `- Dispatch voice: terse.` while the ordinary agent gets no dispatch line. `Hard boundary:` and `Status reporting discipline:` currently reach **both**; that is the difference the product decisions below change.

### Decision update (2026-11-14): two independent slots

- Ordinary and super styles **may differ from the start**; do not hold either slot back to keep them identical. The super slot owns dispatch/reporting discipline; the ordinary slot stays clean.
- The two slots have independent sources, defaults, and write paths. A missing super file must not fall back to the ordinary file (and vice versa); today there is only one file and one section implementation.
- Both slots still use section name/order `personality:output-style` at 690, selected per agent. A separate order is needed only if the two texts must occupy different positions; that is not required for independent content.
- Subagents receive no output-style slot at all. Sections 100 and 695 are not part of this decision.

### Subagent tools: ban, no read-only variants

Current registration already excludes both write paths for subagents: `tools: agent => isRootAgent(agent) ? [analyzeTool, applyTool, rulesTool] : [analyzeTool]` (`index.ts:119-121`). A subagent therefore sees only `personality_analyze`; there is no read-only `write_like_human` or `personality_apply` variant. This already satisfies the “ban the tools” decision at the model-facing layer.

Options if implementation changes:

| Option | Cost | Effect |
|---|---|---|
| Registration filter only (current) | One predicate; already implemented | Tools are absent from the subagent's schema and cannot be called; zero runtime branch. |
| Runtime rejection only | Keep tools visible, reject in `execute` | Saves no context and gives a worse model experience; also exposes write tools to the model. Not recommended. |
| Both | Filter plus a root/role check inside `execute` | Defense in depth for direct service calls; adds code/tests, no context cost. Recommended only if direct non-registry calls are a real boundary. |

Do not add a read-only variant. The context saved for a subagent is the two tool definitions it does not receive: their descriptions total **765 characters ≈ 158 tokens** (240 + 525 characters; 43 + 115 tokens on the same sample). The parameter schemas add more; the exact saving is the whole definitions, not just descriptions. This saving already applies with the current filter.

### Proposed shape

- Subagent: omit section 690 entirely; keep the existing tool ban. Keep sections 100 and 695 unchanged unless a separate decision says subagents need no profile/writing rules at all.
- Ordinary root: one clean output-style slot.
- Super-agent root: a distinct output-style slot containing dispatch/reporting discipline.
- Do not infer the role from cwd, workspace title, presence of `superagent_control`, or a preset name. Those are mutable/incidental and would make personality depend on jira internals. Add an explicit agent-role signal where the Session is created, or expose a small role service that both capabilities can consult. This is a design prerequisite, not an implementation detail to hide in a path comparison.

A low-churn structure is to keep the section name/order `personality:output-style` at 690 and choose the source by role inside `sectionsFor`: subagent → no section; ordinary → `OUTPUT_STYLE.yaml`; super → a second store such as `SUPERAGENT_OUTPUT_STYLE.yaml`. This gives two slots without a new section number. If the two texts must have different positions in the assembled prompt, a separate order (for example 691) is the alternative, but it changes the order map and all order assertions.

### Future different content

The two slots are expected to diverge immediately. The super slot starts with the dispatch line and the status-reporting discipline; the ordinary slot starts clean. When they diverge further, only the source selection, each store's seed/default, and the role signal change. The section name and order can remain 690; subagent omission and the tool ban remain one branch each. Tests for rendering, section order, role selection, and prompt-source contents must cover both sources; the prompt reference document must show both.

## C. Section 702 boundary

The current 702 text has 31 lines (`packages/jira/jira-agent/src/superagent.ts:116-199`). The table groups the slots/contract lines by their actual role. “Output style” here means a rule about how the super agent itself reports or reasons to the person, not a rule about what a dispatched worker must produce.

| 702 line / first 20 chars | Classification | Migration impact |
|---|---|---|
| L1 `You are the super ag` | Dispatch/role | Keep 702; moving it would change who the section describes. |
| L3 `The [superagent works` | Dispatch/context | Keep 702; depends on runtime workspace context. |
| L4 `` `superagent_control` `` | Dispatch/safety | Keep 702; action ordering and write warnings. |
| L5 `A workspace brief has` | Dispatch | Keep 702; brief-source rule. |
| L7 `Brief slots (fill ev` | Dispatch template | Keep 702; moving it would split the brief contract. |
| L13 `Result contract:` | Dispatch contract | Keep 702; it describes the dispatched task's output, not the super agent's prose. |
| L14 `First line: status:` | Dispatch contract | Keep 702; coupled to result contract. |
| L15 `Last line: artifacts` | Dispatch contract | Keep 702; coupled to result contract. |
| L16 `No report or no arti` | Safety/dispatch | Keep 702; “not done” is a correctness rule. |
| L17 `Do not use interacti` | Safety | Keep 702; tool-policy constraint. |
| L18 `Do not require memor` | Safety | Keep 702; ACL/system constraint. |
| L19 `Make dimension-by-di` | **Output style** | Candidate for super style slot; `superagent-brief.test.ts` and the prompt reference assert it. Moving it changes which section carries the acceptance wording, not the behavior. |
| L21 `One brief carries one` | Dispatch | Keep 702; scope control. |
| L22 `Policies and organiz` | Safety | Keep 702; person-owned policy boundary. |
| L23 `Route deliberately, n` | Dispatch | Keep 702; Session routing. |
| L24 `While a Session runs` | Dispatch | Keep 702; delivery/interrupt semantics. |
| L25 `A [superagent monito` | Dispatch/safety | Keep 702; monitor/stop/abort semantics. |
| L26 `Reports are evidence:` | **Output style** | Candidate for super style slot; it governs how the super agent relays a report. The prompt reference records it; `superagent-brief.test.ts` does not assert this sentence. |
| L27 `Ask before you decide` | Safety | Keep 702; approval boundary. |
| L28 `Use subagent only for` | Dispatch | Keep 702; delegation policy. |
| L29 `When a file must be h` | Dispatch | Keep 702; handoff workflow. |
| L30 `Use superagent_permis` | Safety | Keep 702; permission semantics. |

### Merge versus keep separate

**Recommendation: keep 702 mostly separate; extract only the two output-style rules (L19 and L26) into the super-agent style slot.** 702 is the dispatcher's role/brief/safety contract; most of it is not a style library. The two extracted rules are about how the super agent summarizes and compares, so they belong to the super style; after extraction, 702 should point to the style section rather than duplicate the wording. Do not merge the result contract, monitor semantics, permissions, or workspace role into the style library.

This is a **partial merge**: a super-only style slot owns prose/reporting discipline, while 702 keeps dispatch workflow, role, and safety. The ordinary style library must not receive super-only discipline.

## D. Localization of tool results and errors

### Strings that need localization

| Source | Strings | Notes |
|---|---|---|
| `analyze.ts:164-174` | `Scanned …`, candidate line, `warning:` | Model-facing result text; evidence ids/seq must stay stable. |
| `apply.ts:96-100` | `Applied …`, rejected lines | Model-facing result; `applied`/`rejected` keys stay English. |
| `writing-tool.ts:169-178` | `write_like_human failed…`, success line, rule line, `Injected text:` | Model-facing result; `ok`, `action`, `rules` keys stay English. |
| `analyze.ts:143,181,188,222` | session-read warning, identity, `maxCandidates`, `recent.limit` | Error/degrade prose. |
| `apply.ts:68,70,77` | confirm, candidate count, evidence | Error prose; stable fields/ids unchanged. |
| `writing-rules.ts:122,256,259,339` | rule count/text/bytes | Error prose. |
| `global-store.ts:378,395,405,408,413,450` | identity, empty/blank text, char/body limits | Error prose; `kind`/`code` remain stable. |

The existing `.i18n.yaml` plus `verify-translation-pairing` mechanism is **documentation translation only**; it does not provide runtime strings. `displayReason` in `packages/core/tools/src/contracts.ts:379` is a localized UI/ask shape, not a general tool-result localization service. There is no server-side session locale in `AgentHeader` today.

### Where the language comes from

- **Recommended: an explicit personality language setting** (global personality config or Session metadata) selected once when the Session/agent is created. Stable, testable, and independent of UI chrome.
- Global config only: simple, but all Sessions share one language even when a person switches conversational language.
- Detect from the latest user message: no stable source, changes mid-turn, and is hard to test; not recommended as the primary mechanism.
- Do not reuse the browser/UI locale: it is a client concern and is not available to the server-side tool execution path.

### Model-visible consequence

These strings are tool **return values**, not UI copy. The model reads the rendered text and tends to continue in that language, so a Chinese result can steer a Chinese answer even when the system prompt is English. Localize the prose only; keep machine-stable keys, ids, codes, and status tokens English (`ok`, `action`, `applied`/`rejected`, `error.code`, dispatch `status: done|blocked|failed|unverified`, `task_id`, `artifacts`, `checks`). The JSON fields should stay language-neutral; only render/message text should vary. Tests must assert structure and tokens, not exact localized prose unless a locale is explicitly selected.

## E. Impact if implemented

| Area | Files / tests / docs | Rebuild/restart |
|---|---|---|
| Quota | `writing-rules.ts` constants; `writing-rules.spec` and prompt reference counts | Code change: yes |
| Tiered retrieval | new lookup tool/service, prompt vocabulary, tool tests; docs and prompt reference | Code change: yes |
| Agent gating | `personality/src/index.ts` (`sectionsFor`, `loadBundle`), `output-style.ts`/`defaults.ts`, a role signal in the Session metadata or role service; `provider.spec`, `output-style.spec`, section-order tests | Code change: yes |
| Two style slots | second global store path/seed; `index.ts` source selection; role-selection tests; README and prompt reference | Code change: yes |
| 702 extraction | `superagent.ts` text; `superagent-brief.test.ts`; prompt reference and design §6 | Code change: yes |
| Localization | `analyze.ts`, `apply.ts`, `writing-tool.ts`, `writing-rules.ts`, `global-store.ts`; new locale source; result/error tests; prompt reference | Code change: yes |
| Documentation only | design/prompt docs; no runtime effect | No |

All code or prompt changes require a rebuild and restart of the running harness. Documentation-only changes do not.

## Non-goals and open decisions

- This round does not change quotas, split sections, add a role field, add retrieval, or move 702 text.
- The ordinary and super slots are independent and may differ from the start; no read-only `personality_apply`/`write_like_human` variant is planned for subagents.
- The super-agent role signal is an explicit prerequisite; cwd/title/tool-presence heuristics are rejected.
- The version-conflict item remains description-only: writes retry once internally and the model is told to `list` before a second attempt (`0d3fcb3ef0`).
- Product decisions still needed: the runtime source for the localized result language; whether subagents keep profile 100 and writing rules 695; whether the core always-on set is 20 or another number; whether the two slots need different prompt orders.
