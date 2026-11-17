# Tool surface re-organization: personality, JIRA, and `.dsh` tools

English | [中文](tool-surface-reorg.zh.md)

Status: draft for review. Length budget: 12 pages / 4,000 words; this draft is about 3,225 words (about 8 pages).

## 1. Scope and evidence

### 1.1 Scope

This document covers three tool groups and their storage:

- `personality_*` tools and their global files (`PERSONALITY.md`, `WRITING_RULES.yaml`);
- `jira_*` tools, the JIRA ledger, and the `superagent_*` tools that exist only to run the JIRA claim/dispatch loop;
- the `.dsh` store tool (`tool-dsh-store`) and its service.

It does not redefine `memory_*` or the `workspace_*` toolset; those belong to the memory and workspace-information design. It states the boundary with that design and lists every point that needs a revision there.

### 1.2 Evidence window

The usage counts below come from one long super-agent session: 827 completed turns, about 2,200 tool calls. This is a sample, not a census. The ledger evidence comes from the two stores themselves:

- the JIRA issue ledger at `$DSH_HOME/jira` is a git repository; its latest commit and latest issue-file write are both 2026-11-10 21:15 +0800;
- the dispatch ledger at `D:\dqc\superAgent\.superagent\ledger` has entries updated through 2026-11-17T09:34Z, and `reports.jsonl` was written at 17:34 local that day;
- the personality file `$DSH_HOME/personality/PERSONALITY.md` was written at 2026-11-17 15:48.

The running build also exposed `superagent_session` and `superagent_workspace`. They are not kept as aliases: both names are removed, and the capability is implemented by `workspace_sessions`.

### 1.3 Why this document exists

The memory design leaves three tool groups out of scope but depends on their names and storage. If they are re-arranged separately and silently, the workspace toolset will either duplicate them or collide with them. This document makes the ownership explicit, proposes a removal path for JIRA, and fixes the personality and `.dsh` boundaries before either side ships.

## 2. Current inventory

### 2.1 Personality tools

| Tool | Purpose | Caller / role | Calls in the sample | Assessment |
|---|---|---|---|---|
| `personality_analyze` | Reads session records and returns evidence-backed candidates; read-only | `minRole: 'subagent'` (`api.ts:121`) | 1 | Keep |
| `personality_apply` | Writes confirmed candidates into the global `PERSONALITY.md`; refuses subagents (`agent-tools.ts:177`) | `minRole: 'agent'` | 3 | Keep, narrow |
| `write_like_human` | Maintains the global `WRITING_RULES.yaml`; refuses subagents (`writing-tool.ts:115`) | `minRole: 'agent'` | 0 | Merge into `personality_apply`; no standalone tool |

Storage: `$DSH_HOME/personality/PERSONALITY.md` (`global-store.ts:25`) and `$DSH_HOME/personality/WRITING_RULES.yaml` (`defaults.ts:26-29`). Both are global, not workspace-scoped, and both are written through the global `.dsh` store (`global-store.ts:270-309`).

### 2.2 JIRA and super-agent tools

The JIRA package mixes two different products: issue CRUD, and the super-agent dispatch loop. They must be separated before any removal. JIRA is deprecated: treat it as out of service; this document plans removal, not compatibility.

#### 2.2.1 JIRA issue tools

| Tool | Purpose | Calls in the sample | Assessment |
|---|---|---|---|
| `jira_issue` | Get, create, comment, transition, tag, and edit issues in the local JIRA ledger (`toolIssue.ts:15`) | 11 | Remove now |
| `jira_kb` | Read and write knowledge entries under the JIRA ledger (`toolKb.ts:15`) | 1 | Remove now |
| `jira_list` | List issues by project, status, tag (`toolList.ts:15`) | 7 | Remove now |

The JIRA ledger itself has had no data write since 2026-11-10 21:15, and no commit since that time. The tool calls above are small and mostly reads. The evidence supports removing the JIRA issue surface now: the ledger data stays in place, but no tool reads it after removal.

#### 2.2.2 JIRA claim/dispatch tools

| Tool | Purpose | Calls in the sample | Assessment |
|---|---|---|---|
| `superagent_scan` | List ledger issues that could be taken (`superagent.ts:84`) | 0 | Remove now |
| `superagent_claim` | Propose or claim an issue after a person confirms (`superagent.ts:86`) | 0 | Remove now |
| `superagent_status` | Report the claim loop's counts and blocked items (`superagent.ts:88`) | 0 | Remove now |
| `superagent_dispatch` | Start an executor Session for a claimed issue (`superagent.ts:4773`) | 0 | Remove now |
| `superagent_source` | Import open issues from a configured repository (`superagent.ts:5008`) | 0 | Remove now |

These are the tools that exist only to run JIRA work. None was called in the sample. The dispatch ledger still records work, but it records workspace tasks, not JIRA issues; that distinction is the core of the removal plan.

#### 2.2.3 Super-agent orchestration tools

| Tool | Purpose | Calls in the sample | Assessment |
|---|---|---|---|
| `superagent_control` | Role-gated control surface for the super-agent loop (`superagent.ts:333`) | 497 | Re-home to `workspace_*` |
| `superagent_ledger` | Reads and writes the dispatch ledger (`superagent.ts:915`) | 311 | Re-home to `workspace_tasks`; ledger data is dropped |
| `superagent_deliver` | Delivers a report or message to another session (`superagent.ts:1879`) | 33 | Re-home to `workspace_message` |
| `superagent_permission` | Switches the session permission preset (`superagent-permission.ts:15`) | 37 | Re-home to permission presets |
| `superagent_models` | Reads and selects model routes (`superagent.ts:755`) | 7 | Re-home to model settings |
| `issue_work` | Executor-side issue work (`workIssue.ts:26`) | 0 in this session | Keep for executors until replaced |

The running build also exposed `superagent_session` and `superagent_workspace`. No alias is kept: both names are removed, and `workspace_sessions` implements the capability.

These tools are not JIRA-specific in behavior even though they live in the JIRA package; they are the current super-agent task, delivery, and permission surface. They are heavily used, and they are what the `workspace_*` toolset replaces. They are not part of the JIRA removal.

### 2.3 `.dsh` store tools

| Tool | Purpose | Calls in the sample | Assessment |
|---|---|---|---|
| `tool-dsh-store` | Create, query, and delete files and folders under a workspace's `.dsh`; the tool refuses to mutate `.dsh/memory` and delegates path checks to the store service (`tool-dsh-store/src/tool.ts`) | 0 | Keep, sole entry |

The store service (`ctx.dshStore`) owns project-root discovery, path confinement, namespace authoring checks, and the session policy gate (`store-atom/src/service.ts`). The memory capability writes `.dsh/memory` through that service, not through this tool. The tool is the model-facing entry for rules, skills, and other `.dsh` content.

## 3. Re-arrangement principles

### 3.1 One owner per namespace

| Namespace | Owner | Consequence |
|---|---|---|
| `workspace_*` | Workspace information design | Sessions, progress, tasks, messages, artifacts |
| `memory_*` | Memory design | Global facts and conventions only |
| `personality_*` | This document | Profile, expression style, writing rules |
| `jira_*` | Retiring | Issue access only, read-only until removal |
| `superagent_*` | Retiring as a public surface | Behavior moves into `workspace_*`, not into JIRA |
| `tool-dsh-store` | This document | The only validated `.dsh` entry |

### 3.2 `workspace_*` replaces the super-agent task surface

`superagent_ledger`, `superagent_deliver`, `superagent_session`, and `superagent_workspace` are the current task, message, and session surface. The workspace toolset defines the same concepts with explicit scopes, receipts, references, and an idempotency key. Keeping both would create two task systems; the design therefore moves behavior to `workspace_tasks`, `workspace_message`, and `workspace_sessions`, and does not preserve a parallel `superagent_*` task API.

Current state (2026-11-17, after the dispatch wiring; this note records what the tree does, not a change to this design's direction): `superagent_control start` records the task in the target workspace and `.superagent/ledger` is its projection under the same task id. `superagent_ledger` still reads and corrects that projection; dropping it in favour of `workspace_tasks` remains the direction of this document.

### 3.3 JIRA is removed now; the dispatch ledger is dropped, not migrated

JIRA is deprecated and removed immediately: the tools and skills go, only the GitHub credential code/config stays, and no compatibility layer is built. The dispatch ledger has no old account or historical value; it is dropped, not migrated. `workspace_tasks` starts fresh, with no import and no compatibility.

### 3.4 Personality and global memory keep separate storage

Personality owns how the assistant speaks and what the user prefers about interaction: persona, style, writing rules. Global memory owns facts and conventions that apply across workspaces: server addresses, the default model, shared rules of work. A content preference such as "do not use internal codenames" is a personality or writing rule; a fact such as "the shared gateway is at this address" is global memory. The two files are not merged, because they have different lifecycles, review flows, and failure modes.

### 3.5 The `.dsh` store stays the only validated entry

`workspace_artifacts` publishes references, not copies. For a path under `.dsh`, publishing or resolving must go through the store's path and namespace checks; the artifact tool must not become a second writer. `.dsh/memory` remains read-only to every tool except the memory capability.

## 4. Decisions by tool

| Tool / group | Decision | Reason | Impact |
|---|---|---|---|
| `personality_analyze` | Keep | Read-only, cheap, used by subagents | No change |
| `personality_apply` | Keep, narrow | Writes global profile; only confirmed candidates | Root agents; subagents already refused |
| `write_like_human` | Merge into `personality_apply`; no standalone tool | Zero calls in the sample; one tool should own both global files | Root agents that maintain writing rules |
| `PERSONALITY.md`, `WRITING_RULES.yaml` | Keep separate from global memory | Different lifecycle and review flow | Users with profile rules; no migration |
| `jira_issue` | Remove now | JIRA deprecated; low traffic; no compatibility | Agents that still read JIRA issues stop |
| `jira_kb` | Remove now | One call in the sample; KB is local Markdown | Knowledge-base readers |
| `jira_list` | Remove now | Seven calls; issue listing is the panel's job | Agents that list issues |
| `superagent_scan`, `superagent_claim`, `superagent_status`, `superagent_dispatch`, `superagent_source` | Remove now | Zero calls; the loop is replaced by `workspace_tasks` | JIRA claim/dispatch users |
| `superagent_control`, `superagent_ledger`, `superagent_deliver` | Re-home to `workspace_*`; no aliases | Heavily used; parallel task systems must not survive | Super-agent dispatcher; all affected prompts |
| `superagent_permission` | Re-home to the permission-preset service | The session policy already owns presets | Sessions that switch presets |
| `superagent_models` | Re-home to model settings | Model routing is configuration, not a task tool | Sessions that select models |
| `superagent_session`, `superagent_workspace` | Remove; no alias | Observed in the running build; `workspace_sessions` implements the capability | Sessions that used the aliases |
| `issue_work` | Keep until the executor flow is replaced | Executor role needs a write path | Executor sessions |
| `tool-dsh-store` | Keep, sole `.dsh` entry | Path, namespace, and policy checks live here | Any agent editing `.dsh` |
| JIRA ledger `$DSH_HOME/jira` | Leave in place; no migration or export | No compatibility; deleting it is a separate decision | JIRA readers; panel, CLI |
| Dispatch ledger `.superagent/ledger` | Drop; no migration or import | No old account or historical value | Old task history unavailable; `workspace_tasks` starts fresh |
| JIRA cloud configuration | Keep only GitHub credential code/config; remove endpoint, project/tenant, timeouts, and the rest | GitHub credentials may be reused; the rest is dead | JIRA/panel/CLI users; config owner |

## 5. JIRA removal and cloud configuration

### 5.1 Immediate removal

JIRA is removed in one step, not phased:

- Remove `jira_issue`, `jira_kb`, `jira_list`, the claim/dispatch tools (`superagent_scan`, `superagent_claim`, `superagent_status`, `superagent_dispatch`, `superagent_source`), and the JIRA skills (`jira-work`, `jira-board`, `jira-triage`). There is no read-only phase, no export phase, and no phase 4.
- Keep only the GitHub credential code/config: the credential lookup and the code that reads it stay. Remove the rest of the JIRA cloud configuration (endpoint, project/tenant, timeout, and related entries); they are not kept for compatibility.
- Keep no alias for any removed name. `superagent_session` and `superagent_workspace` are removed; `workspace_sessions` implements the capability.
- Delete the local JIRA issue ledger. Before deletion, a one-time static export may be taken; without it the data is unrecoverable. No tool reads it after removal.
- Drop the dispatch ledger. There is no migration, no import, and no compatibility; `workspace_tasks` starts fresh. Old task history is not preserved, which is accepted because there is no old account or historical value.

### 5.2 Dependencies

- The JIRA panel and CLI are not model tools. They lose the model tool surface and have no local data to read after the ledger is deleted. No compatibility layer is built for them.
- Any scheduler or automatic analysis that reads the JIRA ledger must stop or be retired in the same change; there is no archive to read.
- The dispatch ledger's writers move to `workspace_tasks`; the old ledger is not read. The super-agent orchestration tools are not JIRA and move to `workspace_*`.
- After the release, verify that only the GitHub credential config remains and the other JIRA cloud entries are gone.

### 5.3 Rollback

- The removal is one release. Roll back by reinstalling the previous release and restoring the previous config; the GitHub credential config was never removed, the other JIRA cloud config was removed, and the local JIRA data was deleted and cannot be restored. Only the optional one-time export remains.
- The dispatch ledger was dropped; rollback cannot restore its history. That is accepted and must be stated in the release note.

## 6. Personality

### 6.1 Boundary with global memory

| Content | Home | Example |
|---|---|---|
| Persona, tone, interaction style | Personality profile | "Be direct; lead with the conclusion" |
| Writing rules | `WRITING_RULES.yaml` | "Do not use internal codenames" |
| Cross-workspace preferences about how to work | Personality profile | "Ask one question, not a questionnaire" |
| Cross-workspace facts and conventions | Global memory | Shared gateway address; default model |
| Workspace business facts | Workspace tools | Session progress, tasks, artifacts |

The routing rule is: if the statement changes *how the assistant behaves*, it is personality; if it states *what is true across workspaces*, it is global memory. A statement can be rejected by both when it is a business fact.

### 6.2 Storage

Do not merge `PERSONALITY.md` or `WRITING_RULES.yaml` into global memory. They are global files with their own revision, review, and prompt-injection paths. Merging would make a style edit and a server-address edit share one writer, one diff, and one rollback.

### 6.3 Tools

- Keep `personality_analyze` read-only and available to subagents.
- Keep `personality_apply` for root agents only; narrow it to confirmed candidates and to the two personality files.
- Merge `write_like_human` into `personality_apply`; the merged tool owns both global files, and no standalone `write_like_human` is kept.
- Do not add a `workspace_*` personality path; personality is global by definition.

## 7. `.dsh` tools

### 7.1 Single entry

`tool-dsh-store` remains the only model-facing tool for `.dsh` content. It owns create, query, and delete; the store service owns path normalization, root confinement, namespace checks, and the session policy gate. No new `dsh_*` family is introduced; a rename to `dsh_store` would be churn without a behavior gain and is deferred.

### 7.2 Relationship to `workspace_artifacts`

`workspace_artifacts` is read-only today: it lists published references and resolves one recorded version (`packages/uitstalie/workspace-tools/src/artifacts.ts:78-90`); the `publish`/`reference` action does not exist yet. When it lands, it will publish a reference with an id, path, hash, size, and version. For a path under `.dsh`, publishing and resolving must use the store's checks: the artifact tool does not write the file, does not bypass path confinement, and does not copy `.dsh/memory`. The receiver reads the content through the store tool or the store service, after resolving the reference.

### 7.3 Permissions and sandbox

The store tool checks `.dsh` rules at write time and refuses to mutate `.dsh/memory`. The session policy still gates writes; a read-only session may query but not create or delete. Cross-workspace artifact references are explicit and audited; a `.dsh` path from another workspace resolves only when the caller has a readable grant, otherwise the result is `denied`, not `missing`.

## 8. Risks and decisions needed

### 8.1 Decisions needed from you

None. The remaining decisions are closed; see section 8.3.

### 8.2 Risks

- JIRA local data is deleted; without the optional one-time export it is unrecoverable.
- Dropping the dispatch ledger loses old task history. That is accepted because there is no historical value; do not attempt an import.
- GitHub credential code/config removed with the tools: keep it out of the removal and verify after release that it remains. The other JIRA cloud config is intentionally removed.
- Two task systems during the transition: `superagent_*` and `workspace_*`. Mitigation: no new features on the old surface; a fixed end date; the workspace tools land first.
- Personality and global memory duplicate a preference. Mitigation: the routing rule in section 6.1 and a review of the first migrated entries.
- `.dsh` bypass through artifacts. Mitigation: publish and resolve go through the store checks; `.dsh/memory` stays read-only.
- Immediate removal has no phased rollback: reinstall the previous release; the dropped dispatch ledger and deleted JIRA data cannot be restored.

### 8.3 Decisions confirmed this round

These remain decisions, not shipped changes. In the current tree JIRA is still enabled (`jira: { enabled: true }` in `packages/bundle/web-app/cordis.patch.uitstalie.yml`), the dispatch ledger is still the only task writer, and `write_like_human` is still a standalone tool (`packages/uitstalie/personality/src/writing-tool.ts:64`); the aliases are the one item already removed (`packages/jira/jira-agent/tests/superagent.test.ts:402-403`).

- JIRA: removed now, no phases; only GitHub credential code/config kept; other JIRA cloud config removed; no compatibility layer. Not implemented.
- Dispatch ledger: dropped; no migration or import; `workspace_tasks` starts fresh. Not implemented.
- JIRA skills: removed together with the tools; no copy kept. Not implemented.
- Aliases: none; `superagent_session` and `superagent_workspace` are removed, and `workspace_*` implements the capability. Implemented.
- JIRA local data: deleted; an optional one-time static export may be taken before deletion; irreversible. Not applicable until JIRA is removed.
- Personality: `write_like_human` merged into `personality_apply`; no standalone tool is kept. Not implemented.

## 9. Conflicts with the memory and workspace design

| Point | Memory/workspace design says | This design says | Action |
|---|---|---|---|
| `superagent_*` rows | Unchanged, out of scope (section 2.3, section 6.2 table) | Orchestration tools re-home to `workspace_*`; no aliases; the JIRA loop is removed now | Tool-surface design wins; revise the memory design's table |
| `superagent_deliver` | Not mentioned; `workspace_message` replaces turn-end delivery | `superagent_deliver` is the current delivery surface, heavily used | Tool-surface design wins; add it to the memory mapping and remove it with the move |
| `.dsh` row | Out of scope and unchanged | `tool-dsh-store` stays the sole entry; artifacts reference it | No conflict; add a pointer in the memory design |
| Personality storage | Boundary left open | No storage merge; profile and writing rules stay separate | Tool-surface design wins; the memory design resolves its open point |
| `workspace_*` vs `dsh_*` naming | Listed as a conflict to align | No `dsh_*` rename now; `tool-dsh-store` keeps its name | Tool-surface design wins; record the decision |

JIRA is removed immediately: `jiraKey`, ledger compatibility, and `superagent_*` JIRA bindings are dropped, not reconciled, so they are no longer conflict rows. The dispatch ledger is dropped, not migrated; the memory design now states that `workspace_tasks` starts fresh, so there is no conflict row for it either.

This document does not edit the memory design. After approval, those rows are the exact revisions to apply there; until then, the memory design's "out of scope" wording remains accurate for its own scope.

## 10. Appendix: evidence and open data

- Tool call counts: one super-agent session, 827 completed turns, about 2,200 tool calls. JIRA issue tools: 19 calls. JIRA claim/dispatch tools: 0. Super-agent orchestration: 841 core calls (`superagent_control`, `superagent_ledger`, `superagent_deliver`), plus 139 for session, permission, models, and workspace. Personality: 4. `.dsh` store: 0.
- JIRA ledger: `$DSH_HOME/jira`, git repository, latest commit and latest issue write 2026-11-10 21:15 +0800; 315 files under `projects/`, 13 knowledge files. Deleted; an optional one-time static export may be taken; irreversible.
- Dispatch ledger: `.superagent/ledger`, latest update 2026-11-17T09:34Z; `reports.jsonl` written 2026-11-17 17:34 local. Dropped; no migration; `workspace_tasks` starts fresh.
- Personality: `PERSONALITY.md` written 2026-11-17 15:48; no `WRITING_RULES.yaml` observed at that path.
- Limits: one session is not a census; the running build exposed aliases that are now removed; the JIRA panel and CLI are not model tools and are not counted.
