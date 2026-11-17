# Memory and workspace information for every session: a static prompt, one toolset, and global memory

English | [中文](memory-scoping.zh.md)

Status: draft for review; Steps 0–4 are implemented. Step 0 (the over-cap archive fix, `3cb8eeaf3d`), Step 1 (the read-side workspace toolset, `cb4cc58385`), Step 2 (intent cards and task creation, `9218cf1c73`), Step 3 (delivery as a tool call and the removal of per-turn memory injection, `548dc157ba`), and Step 4 (global-only memory and migration, this change) are on `cli-desktop`. The JIRA-owned turn-end report delivery is still present because JIRA itself is still enabled; section 10.3 records that as an open gap, not as done. The legacy per-workspace memory reader, its cleanup and window modules, and the `memory` settings row remain as compatibility surfaces for the migration; they are not a live write or injection path, and section 12.1 records that. Length: not bound by the 12-page cap; content completeness takes precedence. This draft is 11,686 words (about 20 pages).

## 1. Background and the problem

Unless stated otherwise, the counts below come from a snapshot taken at 17:14 on 2026-11-17 and from that session's event log.

One super agent session accumulated 406 memory entries (40 active, 366 archived) and put 1,312 memory messages (737 KiB) onto its own surface: 812 snapshots, 149 checkpoints carrying 704 entry lines, and 350 write notices. The same session called `memory_write` 352 times and ran 818 memory summary jobs. Five failure modes and one data-loss defect follow from that evidence.

The same mechanisms run in every workspace session, not only the super agent; this session is simply the largest observed case. The change therefore applies to every session, with no opt-out and no per-session exception.

### 1.1 The same conclusion is written more than once

39 of the 352 explicit writes were written again verbatim by the automatic summary job in the same turn. Another duplicate pair is split by language: the turn 824 conclusion exists once in Chinese and once in English, and the archived turn 666 `is_default` conclusion exists once in Chinese and once in English.

The cleanup pass cannot catch these. Deduplication runs only within one turn, one session, and one kind, and it recognizes only commit hashes or a single file path (`cleanup.ts:196-227`, `cleanup.ts:301-310`); identical text is explicitly excluded (`cleanup.ts:302`). Of 366 archived entries, 9 were removed as duplicates, all of them `open` or `files`, none a `decision`.

### 1.2 Superseded conclusions coexist with their replacements

`supersedes` applies only to `open` and `files` (`cleanup.ts:169`) and only within one session (`cleanup.ts:175`). In 352 calls it was used once and archived nothing. Decisions, the entries that matter most, never participate.

The visible result is contradiction: an old claim that the automation could not read images stayed active next to the correction that a local `read_image` call did read a PNG; an old production-chain constraint stayed active next to the finding that it had been wrongly generalized. Capacity pressure does not repair this. 356 of 366 archive removals were byte-budget removals, which delete by age, not by contradiction.

### 1.3 Facts from other workspaces are mixed in

A session whose workspace is `D:\dqc\superAgent` recorded conclusions that belong to `D:\dqc\analyze` and `D:\dqc\system_img`; six duplicate pairs exist across those workspace memories. An entry carries only `kind`, `text`, `turn`, and `tags` (`memory-file.ts:236-249`), while the writer's working directory is recorded per session (`memory-file.ts:2552`) and the subject workspace is not recorded at all.

### 1.4 Dispatch and session state is stored as memory

Between 50 and 60 entries are dispatch or session status: "dispatched to session X", "waiting for a receipt", "session aborted", "third task deferred". The dispatch ledger already holds this state; the memory copy adds a second, stale source.

### 1.5 Per-turn injection is the largest cost

Every summary pass appended a snapshot, and every explicit write appended an update notice. The result is 812 snapshots (216 KiB), 350 "Memory updated" notices, and 149 checkpoints containing 704 entry lines (240 KiB). None of this is a bounded, queryable view; it is an append-only stream that grows for the life of the session, and the model reads it as context. It is the main reason the session's surface grows without bound, and it must be removed rather than tuned.

### 1.6 The data-loss defect: over-cap entries were dropped without an archive record

`pruneSessionEntries` (`memory-file.ts:2857-2928`) enforces the 40-entry-per-session cap by dropping whole oldest sections and exact-text duplicates. At the time of the incident it returned counts, not archive records; `retainDocument` (`memory-file.ts:2591`) discarded those counts; the write paths archived only byte-budget and cleanup removals (`memory-file.ts:1358-1374`). A dropped entry therefore left no trace. Step 0 (`3cb8eeaf3d`) fixed this: every over-cap and exact-duplicate removal now produces an archive record with an `over-cap` or `duplicate` reason, written before the active file on every write path.

One instance, observed directly in the live workspace file:

- At 16:04 the active block still held turns 816–817, including the decisions that memory entries must carry workspace, source session, and source turn, and that entries whose workspace cannot be determined are marked unassigned and not injected.
- At 17:13 those entries were gone from `MEMORY.md`. `MEMORY.archive.md` had no copy: searching the active and archived files for `workspace_id` returned zero hits, and the archive file's modification time was still 15:37. The frontmatter turn records for turns 810–817 were gone as well.

This was not retention pressure with a record. It was silent loss of the most recent design decisions, which is why the fix must not wait for the rest of this design.

## 2. Goals and non-goals

### 2.1 Goals

1. Reduce the prompt, for every session, to one static list of workspace names, ids, and directories. No memory snapshot, no session index, and no dispatch state is injected, and no per-turn memory message is appended.
2. Put workspace information and delivery behind one toolset: sessions and progress, dispatch tasks and receipts, messages and acknowledgements, and artifact references, each with a query scope enforced by the tool. Delivery is an explicit tool call, not an implicit side effect of ending a turn.
3. Shrink memory to `global` only: cross-workspace facts and conventions. Dispatch state and business facts never enter memory, and the existing silent-drop defect is fixed first.

### 2.2 Non-goals

- No kanban or card UI in this change.
- No memory card stream and no event-log store for memory.
- No per-workspace business memory, no workspace memory fields, and no workspace topic library.
- No migration of business or dispatch facts into memory; those facts stay in their tools and stores.
- No redesign of the session, ledger, or JIRA tool contracts beyond adding the workspace toolset and moving delivery.
- No global configuration changes.
- No snapshot or prompt-cache optimization beyond removing the per-turn injection.
- No per-session exception or feature flag that restores snapshots, update notices, or checkpoints for one session type.
- No JIRA compatibility layer: JIRA is deprecated, treated as out of service, and will be redesigned; `jiraKey` and ledger compatibility are not kept.
- No re-arrangement of the personality, JIRA, or `.dsh` store tools; that is a separate design item (section 2.3).

### 2.3 Related designs (out of scope for this document)

- Re-arranging the `personality`, `jira`, and `dsh` tools is an independent design item; this document only states the dependencies and the conflict points.
- The `jira` tools are deprecated: treat them as out of service; no compatibility layer is kept. Their retirement and any redesign are a separate design item.
- Cross-document conclusions (the tool-surface design owns the detail):
  - namespace ownership: no `dsh_*` rename; `tool-dsh-store` keeps its name;
  - `superagent_*` vs `workspace_tasks`: the orchestration tools move to `workspace_*`; this document's table is revised after approval;
  - personality storage: no merge; the profile and writing rules stay separate after `memory_*` is narrowed;
  - `.dsh` tools: `tool-dsh-store` remains the sole validated entry; artifacts reference it rather than replace it;
  - JIRA: deprecated, no compatibility layer.
  - Intent cards: workspace records owned by the workspace toolset; one card per workspace, and a cross-workspace request is split into one card per workspace. They are not memory and not a host-global store.
- This document does not modify the contracts of those three tool groups.

## 3. Key decisions

### 3.1 The prompt carries only the static workspace directory

The prompt contains one line per registered workspace: title, id, and directory. It is generated from the workspace registry at session start and does not change per turn. Only registered workspaces appear; a subdirectory is not a workspace, and a session that tries to create or address one is refused with a prompt to register the directory first.

Why: the prompt is a fixed contract. Anything dynamic in it either forces a rewrite of the prompt or becomes an append-only message, which is exactly how 812 snapshots accumulated. Status, progress, tasks, and artifacts change constantly and belong in a query, not in the prompt.

Cost: the model must call a tool to learn what a workspace is doing. This is a deliberate move from "push everything" to "pull what is needed". The same static list applies to every session; an ordinary workspace session and the super agent get the same contract.

### 3.2 One workspace information toolset owns status, tasks, messages, artifacts, and intent cards

A single tool family answers: which sessions exist, what each is doing, which dispatch tasks exist and what their receipts say, what the user asked for and which parts are inferred, how to send a message or follow-up, and where a session's or task's artifacts are.

Why: these questions are queries with a natural scope, and a tool can enforce that scope from the calling session. A memory entry cannot: it is a copy with no owner and no expiry.

Cost: more tool calls, a new tool surface to maintain, and a clear ownership rule between the toolset, the JIRA ledger, and the session store.

### 3.3 Memory is `global` only

Memory keeps cross-workspace facts and conventions: shared server addresses, the harness default model, shared rules, and cross-workspace user preferences. Dispatch state and business facts are rejected at write time.

Why: after decisions 3.1 and 3.2, memory's only remaining unique value is a fact that applies everywhere and has no better owner.

Cost: no automatic recall of business conclusions; the model must query, and the query may be slower than reading an injected entry.

### 3.4 Per-turn memory injection is removed

The memory snapshot, the `memory-state` prompt section, and the "Memory updated" notice are removed for every session, not only the super agent. Transcript compression is kept; it happens only at compaction boundaries and is not a memory message. Compaction triggers at 40% of the context budget by default; the threshold is configurable, and the super agent may use a different preset per agent (default 40%, adjustable).

Why: the 812 snapshots and 350 updates are the flood; tuning their size or frequency only slows it down.

Cost: the model loses an always-present summary of recent work; that information now comes from `workspace_sessions` and `session_event_read`. Context compression still needs a compaction path, so the existing checkpoint machinery is kept only as a compaction behavior, not as a per-turn memory feature.

### 3.5 Delivery is a tool call; no turn-end fallback

Sending a message, a follow-up, or a file reference is an explicit `workspace_message` or `workspace_artifacts` call. The turn-end delivery path is removed, not kept as a fallback.

Why: an implicit turn-end delivery cannot tell a new problem from an old one, carries no reference model, and cannot pass files or citations between sessions. An explicit call can carry artifact references, an idempotency key, and a receipt.

Cost: a model that forgets to call the tool sends nothing, so the prompt must teach when and how to reply. Replies are short: conclusion, evidence, next step; no report-length prose.

## 4. Data model

### 4.1 Memory: global entries only

One entry has four fields: `topic`, `source_session_id`, `created_at`, and `text`. `topic` comes from a closed allowlist: `global-model`, `global-server`, `global-convention`, `global-account`, `global-tooling`. There is no `workspace_id`, no `dispatch`, no expiry, no `tags`, and no `kind` as a scope key.

- A newer entry with the same topic archives the older one.
- Stored at `$DSH_HOME/memory/GLOBAL.md` through the global store (`store-atom/src/service.ts:107-113`, `store-atom/src/service.ts:193-213`); whole-file limit 8 KiB.
- States are `active` and `archived`. No state is workspace-specific.

### 4.2 Toolset records

The toolset owns the records it returns; memory does not duplicate them.

| Record | Fields (logical) | Owner |
|---|---|---|
| Session progress | session id, title, status, current turn, current activity, last progress time, latest progress line | Session store, summarized by the tool |
| Dispatch task | task id, workspace, title, goal, acceptance, status, assignee, created/updated, receipts, artifact references | Dispatch ledger plus a general task journal for non-JIRA work |
| Intent card | intent id, workspace, version, status, raw user text, source-annotated goal/acceptance/boundaries/output form, source session and turn, created and confirmed times | Workspace intent store; one card per workspace |
| Message | message id, target session, text, kind (message or follow-up), delivery status, receipt, artifact references | Session inbox and message journal |
| Artifact reference | artifact id, workspace, path, sha256, size, version, kind, session id, task id, created time, summary | Workspace artifact index |

The toolset must not create a second copy of a fact that the ledger, the session store, or the workspace files already own. It aggregates and mutates through those owners, and the task journal exists only for work the JIRA ledger does not cover. Current state after Step 4: memory is the global store in section 4.1 — `$DSH_HOME/memory/GLOBAL.md`, its `GLOBAL.archive.md`, and nothing else. No workspace memory entry is written or injected: the per-turn summary job is removed, and the legacy per-workspace files are read only by the one-time migration and the old-file reader. The workspace toolset writes tasks, receipts, messages, artifact references, and intent cards under `$DSH_HOME/workspaces/<workspace-id>/`; `workspace_message.send` is its only outbound delivery path and `workspace_artifacts.publish`/`reference` are its only reference paths. A message or a task citation stores the artifact id, version, and SHA-256 at send time; the file itself stays in the workspace. The super agent's `superagent_control start` records the task before it starts a Session, and the dispatch ledger `.superagent/ledger` is the projection of the same task under the same task id, not a second task list; its append-only history and the report journal stay readable. A missing, proposed, stale, or cross-workspace card, or a brief that does not cover a card point, refuses the dispatch at that entry. A cross-workspace message is refused for an ordinary agent and requires the super agent plus the explicit target workspace id; the call is recorded. JIRA is still enabled because its removal is a later step, and its superagent report path still delivers a turn report at turn end when `superagent_home` is configured; section 10.3 records that as the one remaining turn-end delivery path. The ledger's manual `record` fallback remains a compatibility path rather than the dispatch truth.

An intent card is a workspace record, not a memory entry. One card belongs to exactly one workspace. A cross-workspace request creates one card in each target workspace, and each card keeps the user's original words verbatim. The card is stored with the workspace's toolset state at `$DSH_HOME/workspaces/<workspace-id>/intents/<intentId>/` (`index.json`, `versions/<n>.json`), not in a host-global intent store. Versions are append-only; an old version stays readable after it is superseded.

### 4.3 Prompt data

One line per registered workspace: `- <title> (<id>) · <directory>`. The list is static for the session and contains no status, no memory, and no task data. Only registered workspaces appear; a subdirectory is refused, not treated as a workspace.

## 5. The workspace information toolset

### 5.1 Common scope rules

- The calling session's workspace is the default scope. A cross-workspace query requires an explicit `workspace` id that appears in the workspace registry, and the call is recorded.
- `workspace_intents` follows the same scope. One card belongs to one workspace. A cross-workspace request is split into one card per workspace, each with the original text verbatim; reading a card from another workspace requires the explicit workspace id and is recorded.
- A target that is a subdirectory of a registered workspace is refused with the same message as an unknown workspace; it is never auto-registered as a new workspace.
- A query returns only records that belong to the named workspace. There is no implicit aggregation across workspaces; a cross-workspace view is an explicit list of workspace ids.
- Results are bounded summaries: no file contents, no full transcripts, and a cursor for paging. Raw content stays behind `read`, `session_event_read`, and the artifact reference resolution in section 6.
- Reads are open to any agent in the workspace. Task creation and status changes require the dispatcher role; a session may update its own task and append its own receipt.
- Every mutation carries a request id so a retry cannot duplicate a task, a message, or a receipt.

### 5.2 `workspace_sessions`

Lists sessions in a workspace and reports what each is doing.

Input:

```
{ action: 'list' | 'get', workspace?, sessionId?, status?, cursor?, limit? }
```

Output (`list`): `{ items: [{ sessionId, title, status, currentTurn, currentActivity, lastProgressAt, latestProgress, taskId? }], nextCursor? }`.

Output (`get`): the same fields plus `recentProgress: [{ at, summary }]`, `pendingInbox`, and `artifactCount`.

Scope: sessions whose workspace matches the resolved scope. `status` is one of `running`, `idle`, `blocked`, `done`. `currentActivity` is a bounded one-line summary derived from the live turn, not a full transcript.

### 5.3 `workspace_tasks`

Creates, reads, and updates dispatch tasks and their receipts.

Input:

```
{ action: 'list' | 'get' | 'create' | 'update' | 'receipt',
  workspace?, taskId?, status?, targetSessionId?, title?, goal?, acceptance?, boundaries?,
  outputForm?, intentId?, intentVersion?, coverage?, nonCoverage?, taskType?, alignment?,
  assignee?, note?, requestId?, cursor?, limit? }
```

- `create` returns `{ taskId, status, createdAt }`; `workspace`, `goal`, `acceptance`, `boundaries`, `intentId`, `intentVersion`, and `taskType` are required; `targetSessionId` is optional. A missing field or card rejects with `INTENT_INCOMPLETE`; a proposed version with `INTENT_UNCONFIRMED`; a superseded or non-current version with `INTENT_STALE`; a card from another workspace with `INTENT_SCOPE_MISMATCH` (section 11.4). `taskType` comes from the closed six-category taxonomy in section 11.7, and every card point needs a `coverage` mapping or an explicit `nonCoverage` reason.
- `update` accepts `status`, `note`, and `assignee`; allowed transitions are `pending → in_progress → waiting_review → done | blocked | cancelled`, and any state may return to `in_progress`.
- The vocabulary above is the new system's vocabulary. Existing task data is not migrated: old states remain as historical text and are not mapped. A one-time script can translate them later if needed; that script is outside this design.
- `receipt` appends `{ status, note, alignment }` and returns `{ receiptId, at, status }`; `alignment` carries one status and one piece of evidence per card point, and a `not_satisfied` acceptance point or a `violated` boundary makes the effective state `waiting_review` or `blocked` instead of `done`.
- `get` returns the task, its receipts, its target session, and its artifact references.
- `list` filters by workspace, status, and assignee.

Scope: a task belongs to exactly one workspace. Creating or changing a task requires the dispatcher (the super agent); the session named as a task's target may update that task and append its own receipt. Every mutation carries a `requestId`, so a retry does not duplicate a task or a receipt. Cross-workspace task listing requires explicit workspace ids.

### 5.4 `workspace_message`

Sends a message or follow-up to one session and reads the delivery receipt. The full delivery and reference design is section 6.

Input:

```
{ action: 'send' | 'read', targetSessionId?, messageId?, text?, kind?: 'message' | 'followup',
  priority?: 'normal' | 'urgent', urgentReason?: 'wrong-conclusion' | 'stop-order' | 'instruction-change',
  replyTo?, references?, taskId?, requestId? }
```

- `send` returns `{ messageId, deliveredAt, status: 'queued' | 'delivered' | 'interrupted' | 'target_archived' }`. A repeated `requestId` returns the original result.
- `read` returns the message and its receipts: `{ messageId, targetSessionId, text, references, receipts: [{ at, status }], nextCursor? }`.
- `priority` defaults to `normal`; `urgent` is limited to the three cases below.
- `replyTo` links a reply to the message it answers.
- Scope: sessions in the same workspace may message each other; a cross-workspace message goes through the super agent, not directly. The target must be a session in an authorized workspace; there is no broadcast, and the message body is bounded to one screen.

Normal versus urgent: a normal message queues and arrives at the target's next turn boundary. An urgent message is one of three cases: a correction of a wrong conclusion the target is acting on; a stop order for a dangerous or irreversible operation; a user instruction change that invalidates the current work. The sender, any agent, marks `priority: 'urgent'` and names one of the three cases in `urgentReason`; the tool rejects an urgent message without it. The super agent is not special here; it was only the first dispatcher. An urgent message inserts before the target's next tool call and may interrupt the current step. Before Step 3 every message used the normal append path, so an urgent correction waited behind the queue and a wrong conclusion could run to completion; that is the defect this channel fixes. Step 3 sends an urgent message with `steer` and falls back to the queue when the target is idle.

Reply guidance: an ordinary agent replies with `workspace_message.send` and `replyTo` when the requested work is done or blocked. The reply is conclusion, evidence, next step, a few lines, no report; references replace attachments. The prompt states this, because an ordinary agent does not infer the tool contract.

Ask-user and approval are a separate reliability item; see section 7.5.

Attaching `references` to `send` is the push path; see section 6.6.

This tool is not the subagent-tree messaging tool. It addresses workspace sessions, including sessions the caller did not start.

### 5.5 `workspace_artifacts`

Publishes, references, requests, and resolves the files and reports a session or task produced.

Input:

```
{ action: 'publish' | 'reference' | 'request' | 'grant' | 'resolve' | 'list',
  workspace?, path?, sessionId?, taskId?, artifactId?, requestId?, approve?, reason?,
  kind?, summary?, pathPrefix?, cursor?, limit? }
```

- `publish` registers a file and returns an artifact reference; it does not copy the file.
- `reference` attaches an existing artifact reference to a message or task without copying it.
- `request` is the pull path: the requester asks for a reference or path and gets `{ requestId, status: 'granted' | 'pending' | 'denied', grant? }`. Same-workspace policy may grant immediately; a cross-workspace request defaults to pending until the holder grants.
- `grant` is the holder or workspace policy decision on a pending request: `{ requestId, approve }` returns `granted` or `denied`; only the holder or the policy may call it.
- `resolve` reports whether the reference still matches and whether the caller holds a grant; it returns no content.
- `list` returns references only; a task with no recorded artifact returns an empty list, not a guess.

Scope: paths must resolve inside the workspace root. The tool returns references, not contents; `read` returns the content after the caller has a valid grant. The reference model is section 6.4; the pull and push checkpoints are section 6.6.

### 5.6 When to call which

| Question | Tool |
|---|---|
| Which sessions exist in this workspace, and what are they doing? | `workspace_sessions` with `action: 'list'` |
| What is this session working on, and what happened recently? | `workspace_sessions` with `action: 'get'` |
| Create a dispatch task, or change its status (an active intent card is required) | `workspace_tasks` with `action: 'create'` or `'update'` |
| What is the task status, and what did the executor report? | `workspace_tasks` with `action: 'get'` |
| What did the user ask for, and which items are inferred? | `workspace_intents` with `action: 'get'` |
| Confirm an inferred card version | `workspace_intents` with `action: 'confirm'` |
| Record a correction to the card | `workspace_intents` with `action: 'correct'` |
| Send a message or follow-up with references | `workspace_message` with `action: 'send'` |
| Did the target receive it? | `workspace_message` with `action: 'read'` |
| Where is the report or file this session or task produced? | `workspace_artifacts` with `action: 'list'` or `'resolve'` |
| What exactly did the session say in a turn? | `session_event_read` |
| Find an older session by content | `session_search` |
| What is the shared server address or default model? | Memory `global` entries |
| What workspaces exist? | The static list in the prompt; no call |

### 5.7 The board reads the same toolset

A future board view needs sessions, progress, tasks, receipts, messages, and artifacts. All of them come from `workspace_sessions`, `workspace_tasks`, `workspace_message`, and `workspace_artifacts`. The fifth member, `workspace_intents`, supplies the dispatch context; the board does not query memory.

## 6. Tool consolidation and tool-based delivery

### 6.1 Why the tools move

Today the memory tools carry session-reading duties, the super agent tools are specific to the JIRA ledger, and outbound information is delivered by the turn-end mechanism rather than by a tool. That split makes cross-session and cross-workspace handoff hard: a message cannot carry a file reference, a report cannot cite another report, and the receiver cannot verify what it received.

The target ownership is one workspace toolset for sessions, tasks, messages, artifacts, and intent cards; memory reduced to global facts; the turn-end path removed. This section is the migration map and the delivery/reference contract.

### 6.2 Existing tool to new home

| Existing tool or path | Current responsibility | New home | Action |
|---|---|---|---|
| `memory_write` | Writes any durable entry, including business facts | Memory, global only | Keep, narrow |
| `memory_search` | Searches memory entries and session history | Memory, global only | Keep, narrow |
| `memory_read` | Reads a session turn as a transcript | Session query: `session_event_read`, `workspace_sessions` | Delete |
| `memory_forget` | Forgets entries by session, turn, kind, or tag | Memory, global only | Keep, narrow |
| `memory_resolve` | Resolves open work items | No open or dispatch memory entries remain | Delete |
| `session_search` | Searches prior sessions in the caller workspace | Session query | Keep |
| `session_event_search`, `session_event_read`, `session_trace`, `session_event_trace` | Reads authorized session events and lineage | Session query | Keep |
| `superagent_scan`, `superagent_status` | Reads the JIRA ledger's readiness and counts | JIRA ledger view | Deprecated with JIRA; no compatibility (section 2.3) |
| `superagent_claim`, `superagent_dispatch` | Claims an issue and starts an executor | JIRA ledger actions | Deprecated with JIRA; no compatibility (section 2.3) |
| `workspace_sessions` | Lists sessions, status, current activity, recent progress | Workspace toolset | Add |
| `workspace_intents` | Creates, reads, confirms, corrects, and versions workspace intent cards | Workspace toolset | Add |
| `workspace_tasks` | General dispatch tasks and receipts | Workspace toolset | Add |
| `workspace_message` | Sends messages, follow-ups, and references; reads receipts | Workspace toolset | Add |
| `workspace_artifacts` | Publishes, references, and resolves artifacts | Workspace toolset | Add |
| `send_message`, `wait_agent` | Messaging inside the subagent tree | Subagent tree | Keep; out of scope |
| Turn-end delivery | Implicit outbound message after a turn | Removed; no fallback | Delete |
| `read`, `glob`, `grep` | Reads workspace content | Content tools | Keep |
| `tool-dsh-store` | Reads `.dsh` content | Store tool | Out of scope here; unchanged (section 2.3) |

`workspace_tasks` does not carry a JIRA compatibility field. JIRA is deprecated, so any `jiraKey` or ledger delegation is dropped, not bridged; `superagent_status` is not kept as a JIRA aggregate. The workspace toolset has five members: `workspace_sessions`, `workspace_intents`, `workspace_tasks`, `workspace_message`, and `workspace_artifacts`. The `.dsh` row remains a dependency, not a decision; section 2.3 owns that boundary. Current state after Step 3: `workspace_sessions`, `workspace_intents`, `workspace_tasks` (`list`/`get`/`create`/`update`/`receipt`), `workspace_message` (`send`/`read`), and `workspace_artifacts` (`publish`/`reference`/`list`/`resolve`) are shipped, and the static `workspace-directory` prompt section is wired for every agent. `memory_read` is deleted (`cb4cc58385`); `memory_resolve` still exists (`packages/uitstalie/memory/src/tools.ts:229`); artifact `request`/`grant` are not implemented, so `pending` and `expired` remain unreachable. JIRA and the `superagent_*` tools are still enabled (`jira: { enabled: true }` in `packages/bundle/web-app/cordis.patch.uitstalie.yml`), and their turn-end report delivery is not removed by Step 3. Removing JIRA and `memory_resolve` remains an open decision, not a shipped change.

### 6.3 Delivery as a tool call

`workspace_message.send` is the primary delivery path:

Input: `{ targetSessionId, kind: 'message' | 'followup', text, priority?: 'normal' | 'urgent', urgentReason?, replyTo?, references?, taskId?, requestId }`. An urgent message must name one of the three cases in `urgentReason`, which is the tool's machine-checkable validation of section 5.4.

- `text` is bounded to one screen. The schema caps it at 600 characters, and the prompt requires three parts: conclusion, evidence, next step, at most six lines.
- `references` is a list of artifact references. No file content is ever placed in the message body.
- `taskId` links the message to a task when the message is a status update or follow-up.
- `priority: 'urgent'` is marked by the sender, any agent, and validated by the tool against the three cases in section 5.4; it inserts before the target's next tool call and may interrupt the current step.
- `replyTo` marks a reply to an earlier message.
- `requestId` is the idempotency key. A repeated call returns the first result.

Output: `{ messageId, deliveredAt, status: 'queued' | 'delivered' | 'interrupted' | 'target_archived', references }`.

A reply is short: conclusion, evidence, next step; references carry the files; no report-length prose. Attaching references is the push path; section 6.6 defines its checkpoints.

`workspace_artifacts.publish` registers the file and returns a reference. `workspace_artifacts.reference` attaches that reference to a message or task without copying the file. The receiver calls `workspace_artifacts.resolve` to check the reference, then `read` to read the content. A message, task, or report cites another one by artifact id, not by pasting its content.

### 6.4 Reference model

An artifact reference is immutable at send time:

```
ArtifactRef = { artifactId, workspaceId, path, sha256, size, version,
                kind, sessionId, taskId?, createdAt }
```

- `artifactId` is stable per logical artifact: `artifact-<sha256(workspaceId|path|kind)[:16]>`.
- `version` increases when the file at that path is published again; `sha256` and `size` describe the published content.
- A message or task stores the reference's `artifactId`, `version`, and `sha256` at send time. Later changes do not rewrite it.
- `resolve` compares the recorded hash with the current file and the caller's grant, and returns one status:
  - `ok`: the file exists, the hash matches, and the caller holds a valid grant or push attachment.
  - `changed`: the file exists but the hash differs; this is "the file changed", not "the file is gone".
  - `missing`: the path no longer exists; this is "the file is gone".
  - `denied`: the caller may not read that workspace or artifact, or the holder refused.
  - `pending`: a pull request exists but no grant or denial has been decided.
  - `expired`: the grant window passed.
- A grant is scoped to one artifact version and one requester, and it expires. A push attachment is a grant for that target session only. A new version needs a new grant; an old grant does not follow the new content.
- Cross-session references resolve inside the same workspace by default. A reference from another workspace requires an explicit `workspace` id; if the caller has no access, the result is `denied`, never `missing`.
- Deleting a file does not delete the artifact index entry; `resolve` returns `missing`, and the reference remains for audit. Re-publishing the same path creates a new version; old references resolve as `changed` rather than silently following the new content.
- A report can cite another report by artifact id. The citation is a reference, so the report does not duplicate the other report's body.

### 6.5 No turn-end fallback; retries and reply shape

There is no turn-end delivery path. Every outbound message is an explicit `workspace_message.send`; a turn that sends nothing delivers nothing. `requestId` still deduplicates retries; because there is only one delivery path, the same content cannot be delivered twice and a new problem cannot be mistaken for an old one.

If the tool call fails, the model retries with the same `requestId` or reports the failure; it must not assume an automatic delivery. A reply is short: conclusion, evidence, next step; references carry files; no report-length prose.

### 6.6 Artifact access: pull and push

Artifact access has two modes, chosen by which tool runs first.

**Pull.** The requester calls `workspace_artifacts.request`. Checkpoints, in order:

1. The requester's access to the target workspace, by membership and role.
2. The artifact's existence and version, checked only after access. A cross-workspace caller that fails access gets `denied`, never `missing`, so artifact existence does not leak.
3. The holder's grant or the workspace policy. Same-workspace policy may auto-grant; a cross-workspace request defaults to `pending` until the holder grants.
4. The read: the grant is still valid and the version and hash match.

Failures: `denied` (no access or refused), `pending` (no decision yet), `expired` (deadline passed), `missing` (no file), `changed` (hash or version moved).

**Push.** The sender calls `workspace_message.send` with references. Checkpoints, in order:

1. The sender's share permission for each artifact.
2. The target's membership in the workspace.
3. The reference's existence and version at send time. An invalid reference fails the send atomically; no message is delivered with a broken reference.
4. At the receiver, the attachment is the grant; `resolve` checks the version and hash and returns `changed` or `missing` as above.

Failures: a send-time `denied` fails the message and names the reference; a receive-time `changed` or `missing` leaves the message intact and marks that reference.

Who initiates changes the order: a pull checks the receiver's access before existence; a push checks the sender's share permission before the target's membership. A grant is version-scoped and expires; a new version needs a new grant.

### 6.7 Memory tools after the split

- `memory_write` accepts only a global fact or convention; it rejects business facts and dispatch state with a pointer to the workspace tools.
- `memory_search` searches global entries only; the session-corpus half is removed.
- `memory_read` is deleted; session context is `session_event_read` or `workspace_sessions`.
- `memory_forget` forgets global entries by topic or entry id; the session, turn, and kind filters are removed with the dispatch namespace.
- `memory_resolve` is deleted; there are no open or dispatch entries to resolve.
- The `/memory` command keeps global listing, statistics, and forget; summary, pause, prune, and session-editing subcommands move to transcript housekeeping or are removed.

### 6.8 Risks in the consolidated toolset

- Delivery reliability: retries use `requestId`; the result distinguishes queued, delivered, interrupted, and failed; there is no fallback, so one explicit path is the only path.
- Double delivery: both paths share one idempotency key and one journal; the second write is a no-op.
- Reference invalidation: `changed`, `missing`, and `denied` are distinct; references are immutable; no silent follow of a new version.
- Permissions: who may send to which session, and who may read whose artifacts. Cross-workspace reads are explicit and audited; `denied` is not `missing`.
- Session lifecycle: a message to an archived session returns `target_archived` and does not create a pending inbox; the artifact references remain resolvable after the session is archived.
- Tool removal breakage: deleting `memory_read` and `memory_resolve` changes the prompt and the tool catalog; the prompt, tool descriptions, and snapshots must change in the same step.

## 7. Prompt, write, and injection rules

### 7.1 Memory write rules

- The only accepted entry is a `global` fact or convention. `memory_write` takes `topic`, `text`, and `source_session_id`; `topic` must be in the allowlist.
- The body is rejected if it contains an absolute workspace path, a JIRA key, a version or commit, a device or mirror, a dispatch status, or an analysis conclusion. The rejection code is `NOT_GLOBAL_MEMORY` and the message names the workspace tool to use instead.
- There is no `dispatch` namespace and no per-turn automatic memory entry. The summary job no longer writes memory.
- A business or dispatch write is rejected; the caller is told to use `workspace_tasks`, `workspace_sessions`, `workspace_message`, `workspace_artifacts`, `session_event_read`, or `read`.

### 7.2 Prompt and injection rules

- The prompt has one static workspace directory section. It is not rewritten per turn, and it contains no status, no memory, and no tasks.
- The memory snapshot, the `memory-state` prompt section (`api.ts:303-312`), and the `appendMemoryUpdate` notices (`snapshot.ts:442-449`) are removed.
- The cross-session index (`snapshot.ts:343-374`) is removed with them.
- Transcript compression, when the session is compacted, may still replace old turns with a summary. That is a compaction behavior: it does not append a memory message per turn, and it is not injected at session start.
- The prompt states the reply contract: conclusion, evidence, next step, at most six lines or 600 characters, and references for files.
- The prompt states the three urgent cases and that a normal message is not urgent.
- The prompt tells a worker to state what information is missing and stop; only the root or super agent asks the user.
- The prompt states that only registered workspaces exist; a subdirectory is refused.
- Compaction triggers at 40% of the context budget by default; the threshold is configurable, and the super agent may use a different preset per agent (default 40%, adjustable).
- No other memory message is appended on a write.

### 7.3 Search and read rules

- `memory_search` searches global memory only. The session-corpus half is removed (`tools.ts:490-506`); session search is `session_search`.
- `memory_read` is removed from the model-facing tools; session context is `session_event_read` or `workspace_sessions`.
- Archived global entries are queryable when explicitly requested but are never injected.

### 7.4 Every session, no exceptions

The prompt change, the removal of per-turn memory messages, and the memory rules apply uniformly: an ordinary workspace session and the super agent get the same static workspace list, the same toolset, and the same global-only memory rules. There is no feature flag that restores snapshots for one session type, because the flood is a property of the mechanism, not of the agent role.

Acceptance measurement for an ordinary session:

- Before: one snapshot per summary pass, one "Memory updated" notice per explicit write, and at most one checkpoint per tier boundary. In the observed super-agent session that produced 812 snapshots, 350 update notices, and 149 checkpoints (704 entry lines), 737 KiB in total.
- After: zero memory-sourced messages per turn in steady state; per-turn memory bytes are 0. The only context is the static workspace list in the prompt and the results of tool calls. Compaction summaries are not memory messages and are measured separately.

The "what did I do last turn" case is the one that per-turn notices used to cover. After the change, `workspace_sessions` with `action: 'get'` returns `recentProgress` and `currentActivity` for the session, and the prompt's "where to look" map names that tool. The acceptance test removes the notice, asks the session what it did last turn, and asserts that the answer comes from `workspace_sessions` (or `session_event_read` for the raw turn), not from a memory message.

This test is part of step 3 and runs on an ordinary workspace session, not the super agent.

### 7.5 Confirmation channel: ask-user and approval

The old ask-user and approval path is removed now, with no transition. It was barely executed: requests stalled, no responder answered, and failures were silent. Keeping it as a fallback would preserve the failure mode.

The chain is:

```
worker agent --(blocked; states what is missing)--> super agent
super agent --(one consolidated question, options, deadline)--> user
user --(decision)--> super agent
super agent --(explicit instruction)--> worker agent
```

A worker does not pop its own confirmation. It states the missing information and stops. The super agent, or the session's root agent when there is no super agent, is the only asker. The super agent gives explicit instructions, not open-ended questions.

Every request has a state: `pending`, `answered`, `expired`, or `denied`, visible in the UI. If no answer arrives by the deadline, the request becomes `expired` and returns the consequence to the asker; the worker must stop or use a pre-declared safe default, never continue silently. A broken chain (asker gone, target gone) marks the request `failed`; there is no silent hang.

The old path is removed in the same release; there is no dual path and no data migration. Tests cover answered, expired, denied, and broken-chain cases.

## 8. Migration and the stop-the-bleeding fix

### 8.1 Stop-the-bleeding fix: ship first, independent of this design

Step 0 shipped in `3cb8eeaf3d`, independent of the rest of this design. `pruneSessionEntries` now returns archive records for every over-cap and exact-duplicate removal, with `over-cap` and `duplicate` removal reasons; `retainDocument` collects those records; every write path archives them before writing the active file; and a failed archive keeps the entries instead of dropping them.

Acceptance: lowering the cap to three entries and writing a fourth turn always leaves an archive record for each dropped entry; a failed archive keeps the entry; a stale-version retry never duplicates an archive record.

### 8.2 Migration rules

| Class | Rule | Treatment |
|---|---|---|
| `global` | Cross-workspace fact or convention: shared server address, harness default model, shared rules, cross-workspace preference | Human confirmation required; becomes a global entry |
| `dispatch` | Names a task, session, or ledger path and describes a plan, next step, or progress | Archived; the task tool and the ledger are the durable owners |
| `business` | Analysis conclusion, device or mirror, production version or HEAD, code path or commit, test result, report content, workspace configuration | Archived, never injected; the pointer, if any, lives in the task or ledger, not in memory |
| `unclassified` | No source session, no turn, or ownership that cannot be determined | Archived, listed in the report, never injected, no guessing |

The dry-run report lists, per file and entry: the class, the proposed global topic, the reason, the byte count, and the target path. Global candidates are listed separately for a person to confirm. The report's SHA-256 hash is the confirmation token: `--apply <hash>` rescans and refuses unless the hash still matches, so an apply cannot run against files that changed after the report was read. Applying writes a backup of every changed file before the first write, appends the migration archive records before it rewrites an active file, records each handled entry in a journal so a repeated dry run converges, and is reversible with `--rollback <run-id>`. The rewritten active file keeps the version-1 format, so the legacy parser reads it and a code rollback leaves it readable. `packages/uitstalie/memory/scripts/migrate-global-memory.ts` is the human command; the module behind it is `packages/uitstalie/memory/src/migration.ts`.

Every workspace's memory file is migrated with the same rules; an ordinary session is not a special case. Its file gets the same report, backup, archive-first write, and rollback.

A heuristic pass over the current 406 entries suggests about 15 global candidates (most of which review should reject), about 50 dispatch entries, and about 340 business or unclassified entries. These numbers are for planning; the report is authoritative.

## 9. Milestones

| Step | What | Acceptance |
|---|---|---|
| 0 | Stop-the-bleeding fix to the over-cap path | Cap and archive tests pass; no silent loss; independent release, rollback by reverting the commit |
| 1 | Read side of the consolidated toolset: `workspace_sessions`, `workspace_tasks` read, `workspace_artifacts` list/resolve, `workspace_message` read; narrow the memory tools; keep the prompt and injection unchanged | A session in workspace A sees only A; a cross-workspace call without an explicit id fails; memory tools no longer read sessions; results are bounded and paged |
| 2 | Task creation + intent card: `workspace_intents` (workspace record, source annotations, per-version confirmation) and `workspace_tasks.create` requiring an active card; coverage check and the receipt gate | A traceable card becomes active without confirmation and dispatches; an inferred card stays proposed and dispatch rejects with `INTENT_UNCONFIRMED` until one consolidated confirmation; a cross-workspace request produces one card per workspace with the original text verbatim; a correction appends a version and leaves the old one readable; a missing coverage point rejects with `INTENT_COVERAGE_MISSING`; a receipt with an unsatisfied item cannot be `done` |
| 3 | Delivery becomes a tool call and the flood is removed in the same release: `workspace_message.send`, artifact publish/reference, the static prompt, and no snapshot, update notice, cross-session index, or turn-end delivery | A message and a reference round-trip; a retry does not duplicate; a turn with no send delivers nothing; an ordinary session's per-turn memory message count is 0 and bytes are 0; "what did I do last turn" is answered from `workspace_sessions` |
| 4 | Memory becomes global-only and the old entries are migrated | A business or dispatch write is rejected with a tool hint; the dry-run report is produced; only confirmed global entries remain injected; backups and rollback verified |

Implemented: Steps 0–4. Step 3 shipped `workspace_message.send`, artifact `publish`/`reference`, the static workspace directory, and the removal of the memory snapshot, the `memory-state` section, the "Memory updated" notice, and the cross-session index. A turn that sends nothing delivers nothing through the workspace toolset: the only call that reaches the host Session controller is `workspace_message.send`. Step 4 shipped the global-only store (`$DSH_HOME/memory/GLOBAL.md` plus `GLOBAL.archive.md`), the three-tool surface (`memory_write`, `memory_forget`, `memory_search`), the `NOT_GLOBAL_MEMORY` refusal with a pointer to the owning tool, the removal of the per-turn summary job, and the report-hash migration with backups, a journal, and rollback. `memory_resolve`, the workspace-summary command forms, live TTL cleanup, and the cross-session index are gone from the model and human surfaces. Not started: artifact `request`/`grant`, and the removal of JIRA's own turn-end report delivery (section 10.3).

Each step is independently shippable and reversible. Step 0 ships first. Steps 1–4 do not depend on the board direction.

Ordering: the read side lands first so the model can query before anything is removed. Task creation and the intent card land next, so dispatch has a workspace record to validate against. The flood removal and the delivery tool land in the same release, so there is no window where the old injection is gone and the new delivery path is not yet available. The memory migration is last because it rewrites user data and benefits from a stable toolset.

Rollback: step 0 is one commit revert. Steps 1–4 keep a reader that parses the previous file version and write a per-file backup before migration, so reverting the code leaves existing files readable and step 4 can restore its backups. Step 2 stores cards per workspace and append-only; disabling `workspace_intents` leaves the files readable, and already dispatched tasks keep their recorded `intentId` and `intentVersion`, but no new task passes the card check. The archive stays append-only, so a rollback never loses the record of what was removed.

Acceptance for every session: before the change, an ordinary session receives one snapshot per summary pass plus one update per write, and at most one checkpoint per tier boundary; after step 3, its per-turn memory message count is 0 and its per-turn memory bytes are 0. The "what did I do last turn" test in section 7.4 passes on that session through `workspace_sessions`.

## 10. Risks and open questions

### 10.1 Open items

None. The decisions above are conclusions, and the implementation values are fixed: 40% compaction, the six task types, and the 600-character reply cap.

### 10.2 Later, not this design

- The board UI and its rendering.
- An event-log store for tasks and messages; the toolset can start on the existing stores.
- Archive retention policy and size budget.
- A latency budget for the toolset once the model relies on it for progress.

### 10.3 Risks

- Tool latency and cost: keep the results bounded, and put a short "where to look" map in the prompt.
- Two owners for a task: closed for new dispatches. `superagent_control start` reads the target workspace's intent card, records the task through the workspace toolset, and writes `.superagent/ledger` only as that task's projection under the same task id, so a dispatched task has one identity in both places. `superagent_ledger` keeps its read and correction contract but no longer mints a separate identity. The JIRA ledger itself is untouched until its removal step, and the ledger's manual `record` fallback stays a compatibility path, not the dispatch truth.
- Message priority: an urgent message may interrupt a step. `workspace_message.send` requires one of the three named cases as `urgentReason` when the priority is urgent, steers the running step when the target is running, and falls back to the queue when it is idle. The three cases are narrow, and a normal message is never urgent; a misclassified urgent message is a defect to review.
- Reference invalidation: `publish`/`reference`/`send` shipped, so changed, missing, and denied are reachable and distinct; a citation is immutable at send time, and a new version needs a new citation. `pending` and `expired` are not reachable until artifact `request`/`grant` ships; a cross-workspace denial never reveals existence.
- Cross-workspace authorization: an explicit workspace id, registry membership, and a recorded call. A cross-workspace message is refused for an ordinary agent and allowed for the super agent only. Pull checks the receiver first, push checks the sender first; no implicit aggregation.
- Losing context compression: a compaction preset that is too aggressive may drop context; make it configurable, test a long session, and keep the previous value as a rollback.
- Confirmation channel: the old path is removed; the new chain has a deadline and visible states, and a broken chain marks the request failed instead of hanging.
- Migration misclassification: the dry run lists every candidate with its class, reason, topic, bytes, and target; apply refuses a stale report hash; backups make a wrong migration reversible and the journal makes a repeated dry run converge. A wrongly archived global fact can be re-added, and a code rollback still parses the rewritten version-1 file.
- Legacy memory shell: the per-workspace `MEMORY.md` reader (`memory-file.ts`), its cleanup, window, and checkpoint modules, and the `memory` settings row remain as compatibility code for old files and the migration. They have no live write or injection path; removing them is deferred until the migration has run on the deployed data. JIRA's prompts still name the old `memory_write` arguments; that text moves with JIRA's retirement, not with this step.
- Every-session blast radius: a prompt or toolset defect now reaches ordinary sessions too. Step 3 staged shipment as toolset first, then the static prompt and injection removal, and keeps the previous prompt available as a build-time rollback for one release. The zero-injection regression test is the gate: a build that appends one per-turn memory message fails its own suite.
- Turn-end delivery remains in JIRA: the only surviving implicit outbound path is jira-agent's dispatch-report delivery, active when `superagent_home` is configured. Step 3's delivery tool does not depend on it and no workspace-toolset path calls it, but removing it is deferred to JIRA's retirement. Until then the two paths coexist, and the "no send, no delivery" rule holds for the workspace toolset only. This is an open gap, not accepted as done.

### 10.4 Confirmed in this round

- Task status: new vocabulary only; old task data is not migrated; a one-time script can do it later.
- Messaging: same-workspace messages are allowed; cross-workspace messages go through the super agent; the sender, any agent, marks urgent and the tool validates the three cases; the prompt teaches the short reply.
- Reply format: conclusion, evidence, next step; at most 6 lines or 600 characters; files as references.
- Task types: analysis and diagnosis, fix, test verification, migration and deployment, design document, other; a closed list changed only by review.
- Artifact access: pull via `request`/`grant`, push via message references; the tool order decides; same-workspace policy may auto-grant; a cross-workspace read needs an explicit grant; denied, pending, expired, missing, and changed are distinct.
- Ask user and approval: the old path is removed now; the chain is worker → super agent → user → super agent → worker; a worker states what is missing and stops; expired, denied, and failed are visible; no silent hang.
- Workspace list: registered workspaces only; subdirectories are refused with a registration prompt.
- Compaction: kept; triggers at 40% of the context budget by default; configurable; the super agent may use per-agent presets (default 40%, adjustable).
- Turn-end delivery: removed; no fallback; replies are conclusion, evidence, next step, not reports.
- JIRA: removed now; only GitHub credential code/config kept; other JIRA cloud config removed; no compatibility layer.
- JIRA local data: deleted; an optional one-time static export may be taken before deletion; irreversible.
- Dispatch ledger: dropped; no migration or import; `workspace_tasks` starts fresh.
- JIRA skills and the `superagent_session`/`superagent_workspace` aliases: removed; no alias names are kept.
- Intent cards: workspace records, one per workspace; a cross-workspace request is split into one card per workspace with the original text verbatim; every item is source-annotated; an all-traceable version is active immediately; a version with inferred items is proposed and confirmed once before dispatch; an active version is reused without re-confirmation; a correction appends a version and supersedes the previous one.

## 11. Intent cards: dispatch alignment

### 11.1 The failure this fixes

The super agent decomposes a user request into tasks. The request is re-expressed in the decomposition, and each re-expression can drift; the user corrects it, the correction is lost in the next task, and the same drift returns. Prompt improvements reduce the rate but cannot make the intent durable: the task carries a paraphrase, not the user's words, and nothing checks the task before dispatch or the result after it.

This is a structural failure, so the fix is a workspace record: an intent card that the super agent writes once, that tasks must reference, that dispatch validates against, that receipts are checked against, and that corrections append to. The card belongs to the workspace the work happens in, not to the host or to memory.

### 11.2 The intent card

An intent card is one workspace's record of one user request. It has one stable id and append-only versions.

| Field | Meaning |
|---|---|
| `intentId` | Stable id for the request inside the workspace |
| `workspaceId` | The one workspace this card belongs to |
| `version` | 1, 2, 3…; each correction appends a new version |
| `status` | `proposed`, `active`, or `superseded` |
| `rawUserText` | The user's original words, verbatim |
| `items` | The goal, acceptance points, boundaries, and output form; each item carries its own source annotation |
| `sourceSessionId`, `sourceTurn` | Where the user stated the request |
| `createdAt`, `author` | When and who created this version |
| `confirmedAt`, `confirmedBy` | When and who confirmed the inferred items, if any |
| `supersedesVersion` | The previous version this one replaces, if any |

Each item is `{ text, source, anchor?, confirmedAt? }` and appears in `goal`, `acceptance`, `boundaries`, or `outputForm`. `rawUserText` is not an item; it is stored verbatim and is never paraphrased.

- `user-verbatim`: the item text is copied from `rawUserText` without paraphrase. This is traceable.
- `user-anchor`: the user named a workspace document or section; `anchor` records the workspace-relative path and heading, and the item quotes that anchor. This is traceable.
- `inference`: the super agent wrote the item from its own interpretation. It is not traceable and needs confirmation.

Storage: `$DSH_HOME/workspaces/<workspace-id>/intents/<intentId>/` with `index.json` (latest active version and version list) and `versions/<n>.json`. The store is append-only: a correction writes a new version; old versions are never edited or deleted. It is workspace state beside the task, message, and artifact records, not a host-global intent directory and not memory.

Ownership: the user owns the intent. The super agent may create a version from the request and annotate every item. A version whose items are all traceable is created `active`; a version with any inferred item is created `proposed`. The user confirms inferred items or appends a correction; ordinary agents read the card. The super agent cannot silently rewrite an active version.

### 11.3 Per-version confirmation

Confirmation is per version and only for inferred items.

- `workspace_intents.create` computes the status from the source annotations. All items traceable means `active`, with no user interaction.
- Any inferred item means `proposed`. The create result includes one consolidated confirmation request: `{ requestId, items: [{ point, text, reason }] }`. The super agent asks the user once, through the chain in section 7.5.
- `workspace_intents.confirm` takes `{ intentId, version, decision: 'confirm' | 'reject', note? }`. Confirm sets `status: 'active'`, writes `confirmedAt` and `confirmedBy` on each inferred item, and keeps the source annotation so each item remains traceable. Reject leaves the version `proposed`; dispatch stays blocked.
- An `active` version is reused by every later dispatch. It is not confirmed again. A correction appends a new version; the old version becomes `superseded`.
- A task that references a `proposed` version is rejected with `INTENT_UNCONFIRMED` and the pending confirmation id; it never produces a separate confirmation per item.

### 11.4 Pre-dispatch validation

`workspace_tasks.create` requires `intentId`, `intentVersion`, `workspace` (the target), `acceptance`, and `boundaries`. Missing any of them rejects the call with `INTENT_INCOMPLETE`. A proposed version rejects with `INTENT_UNCONFIRMED`. A version that is superseded or not the latest active one rejects with `INTENT_STALE`, and the caller must re-read the card. A card from a different workspace rejects with `INTENT_SCOPE_MISMATCH`; the task must reference the card in its own workspace.

The service then runs a coverage check: every goal, acceptance point, boundary, and output-form item in the card must map to an item in the task brief. A missing mapping rejects the dispatch with `INTENT_COVERAGE_MISSING`, unless the caller supplies `nonCoverage: [{ point, reason }]` and the super agent confirms it. There is no default pass and no "assume covered".

The schema and the service enforce this; the prompt only tells the super agent to read the card first, then the task, then write the coverage list. A model that forgets the card cannot dispatch.

### 11.5 Post-execution alignment

When a task returns, the super agent checks the receipt against the same `intentId` and `intentVersion` that the task referenced. Each item gets one status:

- acceptance: `satisfied`, `not_satisfied`, or `out_of_scope`;
- boundary: `respected` or `violated`;
- output form: `matched` or `not_matched`.

Each status carries evidence: the changed file, the test, the report line, or the missing item. The alignment is produced by the super agent or a validator, not by the executor alone. The task cannot move to `done` while any acceptance item is `not_satisfied` or any boundary is `violated`; it goes to `waiting_review` or `blocked` with the checklist. The receipt shown to the user includes the checklist, so drift appears as a list, not as a surprise. A new card version during the task does not change the version the task is checked against.

### 11.6 Correction capture and recurrence

Every user correction appends a new intent version with `reason`, the correcting message, and the changed items. The previous active version becomes `superseded`; it stays readable. The new version follows the same source rule: traceable items make it `active`, and any inferred item makes it `proposed` until confirmed.

The next dispatch reads the latest active version automatically; no one restates the intent from memory. A correction that repeats an earlier point is recorded against both versions. The store counts recurrence by `(intent point, correction reason)` across tasks, so a recurring drift is a number, not an impression.

### 11.7 Metrics

Deviation rate = user corrections / dispatched tasks, computed per workspace and task type over a rolling window (7 and 30 days). A correction event is one new intent version created by a user correction; several changed points in one correction count once. Recurrence rate = corrections whose point was already corrected before / corrections in the window.

Task types are a closed list of six: analysis and diagnosis, fix, test verification, migration and deployment, design document, and other. Adding or renaming a type requires a review; the model cannot invent one.

The inputs are recorded at three points: the intent version append, the task dispatch, and the receipt alignment. No metric depends on memory or on a model's self-report.

### 11.8 Tool surface

`workspace_intents` is the fifth member of the workspace toolset, after sessions, tasks, messages, and artifacts. It provides `create`, `get`, `confirm`, `correct`, `history`, and `metrics`. It follows the scope rules in section 5.1: the caller's workspace is the default, and a cross-workspace call requires the explicit workspace id and is recorded. The user or the UI creates, confirms, and corrects; the super agent may create a proposed version and read; ordinary agents read only.

`workspace_tasks.create` requires the active card reference, as above. `workspace_tasks.receipt` accepts the alignment checklist, and the task state machine refuses `done` with an unsatisfied item.

The dispatch entry is `superagent_control start`: it requires the same card reference, the brief's acceptance and boundaries, its task type, and the coverage map, records the task in the target workspace before any Session starts, and writes the ledger entry as that task's projection under the same id. `append`, `prompt`, and `abort` continue a Session that already passed this check and do not create a second task. The workspace toolset is mounted in the same composition, so `workspace_intents` and `workspace_tasks` are on the super agent's own session; an ordinary agent keeps the read side of both tools, and the mutation role check still refuses its writes.

Current state after Step 3: the tool enforces the dispatch refusals, the coverage check, the receipt gate, the static workspace directory, the message scope and idempotency rules, and artifact publish/reference. `workspace_message.send` and `workspace_artifacts.publish`/`reference` are shipped; artifact `request`/`grant` are not. Until a card UI exists, the super agent is the channel that records the user's confirmation and correction, so `create`, `confirm`, and `correct` require the super agent role or the user; ordinary agents read cards only. A `nonCoverage` entry is the super agent's explicit dispatch waiver, recorded on the task with its reason; it is not a default pass.

### 11.9 What this does not do

This is not a stronger prompt. The prompt only says where to look and in what order: read the intent card, then the task, then the coverage list. The constraints live in the schema, the confirmation state, the coverage check, the receipt gate, and the workspace store.

It also does not put intent cards in memory, in a host-global intent directory, or in a second workspace index. It does not require confirmation for an all-traceable version, and it does not re-confirm an active version.

### 11.10 Acceptance tests

1. A traceable card dispatches without confirmation: `workspace_intents.create` with only `user-verbatim` and `user-anchor` items returns `status: 'active'`; `workspace_tasks.create` succeeds without a confirmation call.
2. An inferred card is blocked until confirmed: a card with one `inference` returns `status: 'proposed'`; `workspace_tasks.create` returns `INTENT_UNCONFIRMED`; `workspace_intents.confirm` with the version makes it active; the same version then dispatches, and a second task reuses it without another confirmation.
3. A cross-workspace request splits cards: a request for workspaces A and B creates one card in each; `rawUserText` is byte-identical in both; a task in A references A's card; a task that references B's card from A returns `INTENT_SCOPE_MISMATCH`.
4. A correction appends a version: `workspace_intents.correct` creates version 2, marks version 1 `superseded`, and version 1 remains readable with its original items; the next task references version 2.
5. Coverage is enforced: a task brief missing an acceptance point returns `INTENT_COVERAGE_MISSING`; adding the point or an explicit non-coverage reason lets it proceed.
6. A receipt with a deviation is gated: an alignment with `not_satisfied` or `violated` cannot move the task to `done`.

These tests run in `packages/uitstalie/workspace-tools/tests/intents.spec.ts`; the same file covers `INTENT_INCOMPLETE`, `INTENT_STALE`, `INTENT_SCOPE_MISMATCH`, role refusals, subdirectory refusals, `requestId` retries, and the history cursor.

## 12. Capability inventory: memory and super agent

This section lists what the two surfaces do today, whether the new design keeps each capability, and what replaces it when it does not.

### 12.1 Memory capabilities

| Capability | Today's problem | Still needed? | New home / replacement | Action |
|---|---|---|---|---|
| Write | Records any durable conclusion, including business facts | Only global facts and conventions | `memory_write` for global only | Implemented: only the five global topics; business, dispatch, and persona text is refused with `NOT_GLOBAL_MEMORY` and a tool hint |
| Search | Searches memory entries and session history | Memory only | `memory_search`; session search is `session_search` | Implemented: `GLOBAL.md` and `GLOBAL.archive.md` only |
| Read | Reads a session turn as a transcript | No | `session_event_read`, `workspace_sessions` | Implemented: absent from the toolset |
| Forget | Forgets by session, turn, kind, or tag | Global only | `memory_forget` without the session filters | Implemented: `topic` or `entryId` only |
| Archive | Keeps removed entries searchable | Global only | Global archive; business history stays in its workspace | Implemented: `GLOBAL.archive.md`; the workspace archive is legacy data |
| TTL and expiry | Expires `open` and `files` after 3 and 14 days | No | Removed with the dispatch namespace | Delete: no live path; the legacy reader keeps the rule only to parse old files |
| Snapshot injection | Per-turn memory snapshot | No | Static prompt plus tool queries | Implemented: removed; the injection surface is empty |
| Summary generation | Writes per-turn business entries | No memory entries | Compaction summary only, not memory | Implemented: the per-turn summary job is removed |
| Cross-session index | "Recent sessions" outline | No | `workspace_sessions` | Implemented: removed with the snapshot in `548dc157ba` |
| Global and personal preference sharing | Mixes cross-workspace facts with persona and style | Split | Global memory for facts; personality for persona and style | Implemented: persona and style belong to `personality_apply` / `write_like_human` |

Intent cards are not a memory capability; they are workspace records and never enter the global memory store.

Implementation status after Step 4: every row is implemented as its Action cell states. The injection surface is empty, so no memory entry — global or legacy — is injected; confirmed global entries are read only through `memory_search`. The legacy modules named in section 10.3 remain for the migration and old-file parsing, and the `memory` settings row is retained but inert until that shell is removed.

### 12.2 Super-agent capabilities

| Capability | Today's problem | Still needed? | New home / replacement | Action |
|---|---|---|---|---|
| Workspace registry and list | Static list injected in the prompt | Yes | Keep the registry; static prompt; `workspace_sessions` for status | Keep, change |
| Session create, reuse, archive | `superagent_session` and session tools | Yes | Session service; `workspace_sessions`; no memory copy | Move |
| Dispatch | `superagent_dispatch` plus JIRA claim | Yes | `workspace_tasks`; JIRA claim and dispatch retired | Move |
| Intent capture and alignment | A request is re-expressed per task and can drift | Yes | `workspace_intents` as a workspace record, plus `workspace_tasks` coverage and receipt checks | Add |
| Ledger and receipts | `.superagent/ledger`, `superagent_ledger` | Yes | `workspace_tasks` journal and receipts; starts fresh, no migration | Move |
| Delivery | `superagent_deliver` plus the turn-end path | Yes | `workspace_message`; no turn-end fallback | Move |
| Report presentation | `reports.jsonl` and delivery | Yes | `workspace_artifacts` references plus `workspace_message`; the UI renders | Move |
| Permission switch | `superagent_permission` | Yes | Permission-preset service | Move |
| Long-task monitoring | Session status and JIRA status | Yes | `workspace_sessions` status and progress plus the write lease | Move |
| Cross-workspace collaboration | Dispatch, with memory copies | Yes | `workspace_tasks`, `workspace_message`, `workspace_artifacts`, and `workspace_intents` with explicit scope; never memory | Move |

Current state after Step 3: `workspace_intents`, task creation, the coverage check, the receipt gate, `workspace_message.send`, artifact publish/reference, and the static workspace directory are implemented; the JIRA-bound capabilities, including their turn-end report delivery, remain implemented and enabled. This table records the target ownership, and the implemented rows are the ones this tree ships.

## 13. Appendix: future direction

A board view is a plausible later UI. Its data comes from the workspace toolset: `workspace_sessions`, `workspace_tasks`, `workspace_message`, and `workspace_artifacts`; `workspace_intents` supplies dispatch context, and memory contributes only global facts. A memory card stream, a per-workspace memory index, and an event-log store are explicitly out of scope; if the board needs one later, it is a new design over the same toolset, not a change to memory. Intent cards are workspace records, not memory.

## 14. Deployment acceptance for Steps 3 and 4

Nothing in this section has been checked on a deployed Windows host. It is the checklist for the person who syncs this branch, deploys it tomorrow, and continues the work there. **CI** means the branch's automated suite already covers the item; **Deploy** means a real process, a real Session, or the running GUI is required, or the item must run against the real `$DSH_HOME` and real workspaces, and the suite cannot prove it. Do not tick a **Deploy** item from the test suite alone, and do not report Steps 3–4 as deployed-accepted before they are ticked.

The automated half is `pnpm exec vitest run packages/uitstalie/memory packages/uitstalie/workspace-tools`.

### 14.1 Ordinary session: no per-turn memory injection

- [ ] A fresh ordinary workspace Session, after at least three turns with at least one `memory_write`, has zero `user/message` events whose `source.kind` is `memory` in its durable log, and zero memory bytes. CI: `an ordinary session receives zero memory messages per turn` (`packages/uitstalie/memory/tests/provider.spec.ts`). Deploy: read the real Session's log or surface and count.
- [ ] The assembled system prompt has no section named `memory-state`. CI: the same spec asserts the assembled prompt. Deploy: inspect the prompt in the running host.
- [ ] A resumed Session over an existing `MEMORY.md` receives no snapshot. CI: `a resumed session is not injected with a memory snapshot`. Deploy: open a Session in a workspace whose `MEMORY.md` already holds entries.
- [ ] No "Memory updated" message appears after a write, and no "Memory snapshot" message appears after a completed turn. CI: both are asserted absent. Deploy: perform one write and one completed turn in the GUI.

The per-turn summary job is removed, so no summary-failure notice is appended anymore. If a `form: 'notice'` memory message still appears, it is a stale code path and must be treated as an injection regression.

### 14.2 Delivery only through the tool

- [ ] A turn that calls no send delivers nothing: no message record and no prompt into another Session. CI: `a turn with no send delivers nothing` (`packages/uitstalie/workspace-tools/tests/delivery.spec.ts`). Deploy: run a turn in Session A, then confirm Session B's inbox is unchanged and no `messages/*.json` was written.
- [ ] A message and an artifact reference round-trip. CI: `a message round-trips with its artifact reference`. Deploy: send from the super agent to a workspace Session and read it back.
- [ ] A retried send with the same `requestId` returns the first message and appends nothing. CI: `a repeated requestId returns the first message without a second delivery`. Deploy: repeat the call and compare ids.
- [ ] `workspace_sessions` answers "what did I do last turn". CI: `"what did I do last turn" is answered by workspace_sessions`. Deploy: ask after a real turn and confirm the answer is the Session's own progress, not a memory notice.
- [ ] A cross-workspace send is refused for an ordinary agent and allowed for the super agent with the explicit workspace id; the call is recorded. CI: `an ordinary agent cannot message another workspace; the super agent can`. Deploy: attempt both.
- [ ] Publishing a path outside the workspace root is refused. CI: `publish refuses a path outside the workspace root and a missing file`. Deploy: repeat with a relative `..` path.
- [ ] The static `workspace-directory` prompt section lists the registered workspaces and contains no status, task, or memory data. CI: `every session gets the same static workspace directory section`. Deploy: compare two Sessions and the super agent's prompt.

### 14.3 Known gap: JIRA turn-end delivery

- [ ] If `superagent_home` is configured, a JIRA dispatch still reports through jira-agent's turn-end path. Step 3 did **not** remove it: JIRA is still enabled and its retirement is a later step (section 10.3). CI: no removal assertion; the existing JIRA suite still passes. Deploy: confirm whether the deployment uses the JIRA superagent. If it does, record that the "no send, no delivery" rule in 14.2 holds for the workspace toolset only, and do not report the turn-end removal as complete.

### 14.4 Step 4: global-only memory and migration

- [ ] The dry-run report names, per file and entry, the class, the proposed topic, the reason, the byte count, and the target path, and it writes no memory data. CI: `the dry run reports files, entries, classes, bytes, and the target without writing data` (`packages/uitstalie/memory/tests/migration.spec.ts`). Deploy: run `migrate-global-memory.ts --workspace <dir> ...` against every registered workspace and confirm that `$DSH_HOME/memory` is unchanged.
- [ ] Apply refuses a report hash that no longer matches a fresh scan and writes nothing on refusal. CI: `apply refuses a report hash from another scan`. Deploy: repeat an apply with the stale hash.
- [ ] Every changed file is backed up before the first write, and a rollback restores the exact bytes; the old `MEMORY.md` parses before apply, after apply, and after rollback. CI: `apply migrates only confirmed global entries, backs up every changed file, and keeps old files parseable`, `rollback restores the exact original bytes and makes the first report reproducible`. Deploy: inspect `$DSH_HOME/memory/migration/runs/<run-id>/`, apply on a copy of one real workspace, then roll back.
- [ ] `$DSH_HOME/memory/GLOBAL.md` contains only confirmed global entries; business, dispatch, persona, and unclassified text is absent and listed as discarded in the report. CI: the same apply spec. Deploy: read the global file after a real apply.
- [ ] The injection surface holds no memory entry: with both a legacy `MEMORY.md` and a populated `GLOBAL.md`, a Session receives no memory-sourced message and no `memory-state` section. CI: `neither a legacy workspace file nor the global file is injected per turn` (`packages/uitstalie/memory/tests/provider.spec.ts`). Deploy: open a Session and inspect its prompt and log.
- [ ] A business write is refused with `NOT_GLOBAL_MEMORY` and a tool hint, and a completed turn writes no memory entry. CI: `a business write is refused with the workspace tool hints`, `a completed turn writes no memory job, no MEMORY.md, and no memory message`. Deploy: call `memory_write` with a business fact, then complete a turn.

### 14.5 Not provable in CI

- A real Windows deployment, the GUI, a process restart and resume, the real multi-workspace registry, and the real memory files are outside the suite. The **Deploy** items above are the manual gate; they stay unchecked until a person checks them on the deployed host.
- The migration deliberately does not run in CI against real data. Its reports, backups, and rollback are proven on temporary `$DSH_HOME` and temporary workspaces; the real apply remains a person's confirmed step, not an automated deployment action.
