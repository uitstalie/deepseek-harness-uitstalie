# Memory and workspace information for every session: a static prompt, one toolset, and global memory

English | [中文](memory-scoping.zh.md)

Status: draft for review; Steps 0–4 are implemented. Step 0 (the over-cap archive fix), Step 1 (the read-side workspace toolset), Step 2 (intent cards and task creation), Step 3 (delivery as a tool call and the removal of per-turn memory injection), and Step 4 (global-only memory and migration) are on `cli-desktop`. JIRA is fully retired: only the cloudstore repository on GitHub, its content and history, is kept as data, not connected to any tool or process. The JIRA tools, CLI, skills, panel, local ledger, dispatch history, and superagent tools are all removed, so no turn-end delivery exists. Task-bound cross-workspace return and `task.dispatcherSessionId` are implemented (section 6.5). Workspace requests are a general capability; task creation, intent-card writes, and Session lifecycle writes are open to any agent in the target workspace, while a cross-workspace write still requires the super agent; an intent card is optional — a task may reference one for alignment, and a task without one records its brief directly. The legacy per-workspace memory reader, its cleanup and window modules, and the `memory` settings row remain as compatibility surfaces for the migration; they are not a live write or injection path, and section 12.1 records that. Length: not bound by the 12-page cap; content completeness takes precedence.

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

Between 50 and 60 entries are dispatch or session status: "dispatched to session X", "waiting for a receipt", "session aborted", "third task deferred". The dispatch ledger already held this state; the memory copy added a second, stale source.

### 1.5 Per-turn injection is the largest cost

Every summary pass appended a snapshot, and every explicit write appended an update notice. The result is 812 snapshots (216 KiB), 350 "Memory updated" notices, and 149 checkpoints containing 704 entry lines (240 KiB). None of this is a bounded, queryable view; it is an append-only stream that grows for the life of the session, and the model reads it as context. It is the main reason the session's surface grows without bound, and it must be removed rather than tuned.

### 1.6 The data-loss defect: over-cap entries were dropped without an archive record

`pruneSessionEntries` (`memory-file.ts:2857-2928`) enforces the 40-entry-per-session cap by dropping whole oldest sections and exact-text duplicates. At the time of the incident it returned counts, not archive records; `retainDocument` (`memory-file.ts:2591`) discarded those counts; the write paths archived only byte-budget and cleanup removals (`memory-file.ts:1358-1374`). A dropped entry therefore left no trace. Step 0 (the over-cap archive fix) fixed this: every over-cap and exact-duplicate removal now produces an archive record with an `over-cap` or `duplicate` reason, written before the active file on every write path.

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
- No redesign of the session or memory tool contracts beyond adding the workspace toolset and moving delivery.
- No global configuration changes.
- No snapshot or prompt-cache optimization beyond removing the per-turn injection.
- No per-session exception or feature flag that restores snapshots, update notices, or checkpoints for one session type.
- No JIRA compatibility layer: JIRA is fully retired and has no replacement tool face; neither `jiraKey` nor ledger compatibility is kept.
- No re-arrangement of the personality or `.dsh` store tools; that is a separate design item (section 2.3).

### 2.3 Related designs (out of scope for this document)

- Re-arranging the `personality` and `dsh` tools is an independent design item; this document only states the dependencies and the conflict points.
- JIRA is retired in one step: model tools, skills, panel, CLI, local ledger, dispatch history, and superagent tools are all removed, with no compatibility layer. Only the cloudstore repository on GitHub, its content and history, is kept as data; it is not connected to any tool or process, is not a design capability, and needs no credentials or remote-access instructions.
- Cross-document conclusions (the tool-surface design owns the detail):
  - namespace ownership: no `dsh_*` rename; `tool-dsh-store` keeps its name and stays the sole validated `.dsh` entry; `workspace_artifacts` publishes or resolves a `.dsh` path only through that store's path and namespace checks;
  - `workspace_*` replaces the retired super-agent orchestration surface: Session lifecycle is `workspace_sessions` (`list`, `get`, `start`, `append`, `prompt`, `stop`, `abort`, `fork`, `archive`, `compact`, `delete`), delivery failure state and resend are `workspace_message` (`status`, `retry`), and task state is `workspace_tasks`. No parallel task or delivery API remains; `workspace_tasks` starts fresh;
  - File copying: removed with the super-agent tools; `workspace_message.send` carrying artifact references expresses it instead;
  - personality storage: no merge; the profile and writing rules stay separate, and the merged `personality_apply` is their single model-facing writer;
  - `.dsh` tools: `tool-dsh-store` remains the sole validated entry; artifacts reference it rather than replace it;
  - JIRA: only the cloud data repository is kept (data as-is, not connected); everything else is removed. The local ledger and dispatch history are deleted and no tool reads them.
  - Intent cards: workspace records owned by the workspace toolset; one card per workspace, and a cross-workspace request is split into one card per workspace. They are not memory and not a host-global store.
- This document does not modify the contracts of those two tool groups.

## 3. Key decisions

### 3.1 The prompt carries only the static workspace directory

The prompt contains one line per registered workspace: title, id, and directory. It is rendered from the workspace registry when the prompt is assembled; it does not change per turn, and it changes only when the registry itself changes. Only registered workspaces appear; a subdirectory is not a workspace, and a session that tries to create or address one is refused with a prompt to register the directory first.

Why: the prompt is a fixed contract. Anything dynamic in it either forces a rewrite of the prompt or becomes an append-only message, which is exactly how 812 snapshots accumulated. Status, progress, tasks, and artifacts change constantly and belong in a query, not in the prompt.

Cost: the model must call a tool to learn what a workspace is doing. This is a deliberate move from "push everything" to "pull what is needed". The same static list applies to every session; an ordinary workspace session and the super agent get the same contract.

### 3.2 One workspace information toolset owns status, tasks, messages, artifacts, and intent cards

A single tool family answers: which sessions exist, what each is doing, which dispatch tasks exist and what their receipts say, what the user asked for and which parts are inferred, how to send a message or follow-up, and where a session's or task's artifacts are.

Why: these questions are queries with a natural scope, and a tool can enforce that scope from the calling session. A memory entry cannot: it is a copy with no owner and no expiry.

Cost: more tool calls, a new tool surface to maintain, and a clear ownership rule between the toolset and the session store.

### 3.3 Memory is `global` only

Memory keeps cross-workspace facts and conventions: shared server addresses, the harness default model, shared rules, and cross-workspace user preferences. Dispatch state and business facts are rejected at write time.

Why: after decisions 3.1 and 3.2, memory's only remaining unique value is a fact that applies everywhere and has no better owner.

Cost: no automatic recall of business conclusions; the model must query, and the query may be slower than reading an injected entry.

### 3.4 Per-turn memory injection is removed

The memory snapshot, the `memory-state` prompt section, and the "Memory updated" notice are removed for every session, not only the super agent. Transcript compression is kept; it happens only at compaction boundaries and is not a memory message. Compaction triggers at 40% of the context budget by default; the threshold is configurable, and the super agent may use a different preset per agent (default 40%, adjustable).

Why: the 812 snapshots and 350 updates are the flood; tuning their size or frequency only slows it down.

Cost: the model loses an always-present summary of recent work; that information now comes from `workspace_sessions` and `session_event_read`. Context compression still needs a compaction path, so the existing checkpoint machinery is kept only as a compaction behavior, not as a per-turn memory feature.

### 3.5 Delivery is a tool call; no turn-end fallback

Sending a message, a follow-up, or a file reference is an explicit `workspace_message` or `workspace_artifacts` call. The turn-end delivery path is removed, with no fallback and no deployment-configurable exception.

Why: an implicit turn-end delivery cannot tell a new problem from an old one, carries no reference model, and cannot pass files or citations between sessions. An explicit call can carry artifact references, an idempotency key, and a receipt.

Cost: a model that forgets to call the tool sends nothing, so the prompt must teach when and how to reply. Replies are short: conclusion, evidence, next step; no report-length prose.

## 4. Data model

### 4.1 Memory: global entries only

One entry has four logical fields — `topic`, `sourceSessionId`, `createdAt`, and `text` — and the file also stores a derived `id` (`gm-` plus the first 12 hex digits of the SHA-256 of `topic`, `createdAt`, and `text`) and the document revision. `topic` comes from a closed allowlist: `global-model`, `global-server`, `global-convention`, `global-account`, `global-tooling`. There is no `workspace_id`, no `dispatch`, no expiry, no `tags`, and no `kind` as a scope key.

- A newer entry with the same topic archives the older one: the older entry moves to `GLOBAL.archive.md` with `archivedAt`, a `reason` (`superseded`, `manual-forget`, or `migration`), and a readable `detail`.
- Stored at `$DSH_HOME/memory/GLOBAL.md` through the `.dsh` store's `global` scope (`ctx.dshStore`); the file is YAML frontmatter (`version`, `updatedAt`, `entries`) and its whole-file limit is 8 KiB.
- An entry is active while it is in `GLOBAL.md` and archived once it is in `GLOBAL.archive.md`; there is no separate state field and no state is workspace-specific.

### 4.2 Toolset records

The toolset owns the records it returns; memory does not duplicate them.

| Record | Fields (logical) | Owner |
|---|---|---|
| Session progress | session id, title, status, current turn, current activity, last progress time, latest progress line | Session store, summarized by the tool |
| Session roster | session id, workspace, created by, created at, forked from, archived by, archived at, observed at | Workspace roster store; reconciled by the tool on every read |
| Dispatch task | task id, workspace, title, goal, acceptance, status, assignee, created/updated, receipts, artifact references | Workspace task store; `workspace_tasks` is the only writer |
| Intent card | intent id, workspace, version, status, raw user text, source-annotated goal/acceptance/boundaries/output form, source session and turn, created and confirmed times | Workspace intent store; one card per workspace |
| Message | message id, target session, source session and role, text, kind (message or follow-up), delivery status, receipt, artifact references | Session inbox and message journal |
| Artifact reference | artifact id, workspace, path, sha256, size, version, kind, session id, task id, created time, summary | Workspace artifact index |

The toolset must not create a second copy of a fact that the session store or the workspace files already own. It aggregates and mutates through those owners. Current state after Step 4: memory is the global store in section 4.1 — `$DSH_HOME/memory/GLOBAL.md`, its `GLOBAL.archive.md`, and nothing else. No workspace memory entry is written or injected: the per-turn summary job is removed, and the legacy per-workspace files are read only by the one-time migration and the old-file reader. The workspace toolset writes tasks, receipts, messages, artifact references, intent cards, session-roster entries, and artifact grants under `$DSH_HOME/workspaces/<workspace-id>/`; `workspace_message.send` is its only outbound delivery path, `workspace_artifacts.publish`/`reference` are its reference paths, and `workspace_artifacts.request`/`grant` are its access-decision path. A message or a task citation stores the artifact id, version, and SHA-256 at send time; the file itself stays in the workspace. A task has exactly one owner: `workspace_tasks`. A task record is created only when a formal task record is needed: optional active intent card → `workspace_tasks.create` → an optional `workspace_sessions.start`/`prompt` handoff; a simple or clear action needs no card and no task and runs directly or sends a request directly. There is no dispatch-history copy and no second task list. When a task references a card, a missing, proposed, stale, or cross-workspace card, or a brief that does not cover a card point, refuses at `workspace_tasks.create`; without a card the brief is recorded directly. `workspace_sessions.start` receives only the first task text and title and does not check an intent card. The general workspace-request capability, the write-role gate, and the return contract are in section 6.5.

An intent card is a workspace record, not a memory entry. One card belongs to exactly one workspace. A cross-workspace request creates one card in each target workspace, and each card keeps the user's original words verbatim. The dispatcher creates each card with one `workspace_intents.create` call for that workspace: the tool takes a single `workspace` and has no multi-workspace list. The card id is derived from the workspace and the raw text, so repeating the same create in one workspace reuses that card. The card is stored with the workspace's toolset state at `$DSH_HOME/workspaces/<workspace-id>/intents/<intentId>/` (`index.json`, `versions/<n>.json`), not in a host-global intent store. Version files are immutable; `index.json` records each version's current status, confirmation, and rejection metadata, so an old version stays readable after it is superseded.

### 4.3 Prompt data

One line per registered workspace: `- <title> (<id>) · <directory>`. The list does not change per turn; it changes only when the workspace registry changes. It contains no status, no memory, and no task data. Only registered workspaces appear; a subdirectory is refused, not treated as a workspace.

## 5. The workspace information toolset

### 5.1 Common scope rules

- The calling session's workspace is the default scope. A cross-workspace query requires an explicit `workspace` id that appears in the workspace registry, and the call is recorded.
- `workspace_intents` follows the same scope. One card belongs to one workspace. A cross-workspace request is split by the dispatcher into one card per workspace — one `create` call per workspace with the original text verbatim, because the tool takes a single `workspace` and has no multi-workspace parameter; reading a card from another workspace requires the explicit workspace id and is recorded.
- A target that is a subdirectory of a registered workspace is refused with the same message as an unknown workspace; it is never auto-registered as a new workspace.
- A query returns only records that belong to the named workspace. There is no implicit aggregation across workspaces; a cross-workspace view is an explicit list of workspace ids.
- Results are bounded summaries: no file contents, no full transcripts, and a cursor for paging. Raw content stays behind `read`, `session_event_read`, and the artifact reference resolution in section 6.
- Reads are open to any agent in the workspace. Task creation and status changes are open to any agent in the workspace, and a cross-workspace write requires the super agent; the named target session may update its own task and append its own receipt.
- Every mutation accepts a request id; when omitted, the tool generates one, and a supplied id makes a retry duplicate nothing.

The super workspace is where the super role comes from. The workspace registry records a role per workspace (`agent` or `super`; absent or unknown values resolve to `agent`), and the workspace recorded `super` is the super workspace, the person's conversation and dispatch home. A root Session whose canonical cwd is exactly that directory resolves to the super role, a subdirectory does not inherit it, and a resumed Session re-resolves the durable record (`<DSH_HOME>/storages/workspace.json`, table `workspaces`, field `role`). The cross-workspace gates in this design use that role; the agent role model records the resolution rules in full.

### 5.2 `workspace_sessions`

Lists sessions in a workspace and reports what each is doing, or manages the lifecycle of a real Session.

Input:

```
{ action: 'list' | 'get' | 'run' | 'start' | 'append' | 'prompt' | 'stop' | 'abort' | 'fork' | 'archive' | 'compact' | 'delete',
  workspace?, sessionId?, task?, title?, text?, delivery?: 'queue' | 'interrupt', new_session?, atSeq?, confirm?,
  provider?, model?, reasoning_effort?, status?, cursor?, limit? }
```

Output (`list`): `{ items: [{ sessionId, workspaceId, workspaceTitle, role, title, status, currentTurn, currentActivity, lastProgressAt, latestProgress, updatedAt, taskId?, createdBy?, createdAt?, forkedFrom?, archivedBy?, archivedAt?, archived, contextUsage? }], nextCursor? }`.

Output (`get`): the same fields plus `recentProgress: [{ at, summary }]`, `pendingInbox`, and `artifactCount`.

The roster fields come from the workspace's own session-roster records. `createdBy` and `archivedBy` are `user` or `agent:<sessionId>`; `archived` is the workspace registry's archive set; `contextUsage` is `{ tokens, window, percent }` measured on the live Agent. Every `list` and `get` reconciles the roster with the session store and the registry first: a Session the tool never recorded is attributed to `user` (the person created it in the UI), and an archived Session with no archive stamp is attributed to `user` (the person archived it there). A Session the tool created or archived already carries `agent:<sessionId>`, so the reconciliation leaves it alone. An unarchive clears the archive stamp, because the roster is current state rather than an audit log. This is why a UI create, archive, or unarchive needs no extra tool call to appear; the next read picks it up.

A `run`, `start`, `append`, `prompt`, or `abort` delivery to another Session starts with a `[workspace_session]` header naming the sender's role, its Session, the workspace, and the Session to reply to, so the executor never infers the dispatcher from the task text.

- `run` is the one-call dispatch: it delivers `text` to the target Session — `sessionId` names it, and omitting `sessionId` continues the most recently updated Session — and starts a new Session only when the workspace has none. Pass `new_session: true` to force a fresh Session even when one exists; that is the action when the person explicitly asks for a new or isolated conversation, and it rejects a `sessionId` because a fresh Session has no target yet. For that new Session, `task` is optional (it defaults to `text`) and `title` is optional (it is derived from the first task). This is the action a dispatcher should reach for; `start`, `append`, and `prompt` remain for callers that want to force a specific lifecycle.
- `start` opens a new Session in a named registered workspace with the first task text and an optional title (derived when omitted); it does not check an intent card, which is checked at `workspace_tasks.create` when a formal task record is needed (section 6.5). A simple request needs no task first.
- `append` continues `sessionId`, or the most recently updated Session when it is omitted; `prompt` addresses one explicit Session id; `delivery` is `queue` or `interrupt`.
- `stop` cuts off the running turn without text; `abort` cuts it off and then sends the follow-up text; `fork`, `archive`, `compact`, and `delete` keep the Host lifecycle semantics, and `delete` requires the exact repeated Session id.
- The lifecycle write actions are open to any agent in the workspace; a cross-workspace write requires the super agent. `list` and `get` are open to every agent in the workspace.

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

- `create` returns `{ taskId, status, createdAt }`; only `workspace` and `goal` are required. `acceptance` and `boundaries` default to empty lists, `taskType` defaults to `other`, and `requestId` is generated when omitted (omit it to create a new task per call, supply it to make a retry idempotent). `targetSessionId`, `intentId`, and `intentVersion` are optional, and the two card fields must be supplied together. A missing required field rejects with `INTENT_INCOMPLETE`; when a card is referenced, a missing card or version also rejects with `INTENT_INCOMPLETE`, a proposed version with `INTENT_UNCONFIRMED`, a superseded or non-current version with `INTENT_STALE`, and a card from another workspace with `INTENT_SCOPE_MISMATCH` (section 11.4). `taskType` comes from the closed six-category taxonomy in section 11.7; a carded task needs a `coverage` mapping or an explicit `nonCoverage` reason for every card point, and a cardless task needs neither.
- `update` accepts `status`, `note`, and `assignee`; allowed transitions are `pending → in_progress → waiting_review → done | blocked | cancelled`, and any state may return to `in_progress`. A `done` transition is refused unless the task has a complete alignment checklist for every card point and no acceptance item is `not_satisfied` and no boundary is `violated`.
- The vocabulary above is the new system's vocabulary. Existing task data is not migrated: old states remain as historical text and are not mapped. A one-time script can translate them later if needed; that script is outside this design.
- `receipt` appends `{ status, note, alignment }` and returns `{ receiptId, at, status }`. `alignment` names the task's `intentId`/`intentVersion` and carries one status and one piece of evidence for every card point; a missing or incomplete checklist rejects with `INTENT_ALIGNMENT_MISSING` or `INTENT_ALIGNMENT_INCOMPLETE`, and a `not_satisfied` acceptance point or a `violated` boundary rejects `done` with `INTENT_ALIGNMENT_UNSATISFIED`, moving the task to `waiting_review` or `blocked` with the deviations. An `out_of_scope` acceptance item and a `not_matched` output-form item do not block `done`.
- `get` returns the task (including its `coverage` and `nonCoverage`), its receipts with their alignment checklists, its target session, and its artifact references.
- `list` filters by workspace, status, and assignee.

Scope: a task belongs to exactly one workspace. Creating or changing a task is open to any agent in the workspace, and a cross-workspace write requires the super agent; the session named as a task's target may update that task and append its own receipt. A mutation accepts a `requestId`; when omitted, the tool generates one, and a supplied id makes a retry idempotent. Cross-workspace task listing requires explicit workspace ids.

### 5.4 `workspace_message`

Sends a message or follow-up to one session and reads the delivery receipt. The full delivery and reference design is section 6.

Input:

```
{ action: 'send' | 'read', workspace?, targetSessionId?, messageId?, text?, kind?: 'message' | 'followup',
  priority?: 'normal' | 'urgent', urgentReason?: 'wrong-conclusion' | 'stop-order' | 'instruction-change',
  replyTo?, references?, taskId?, requestId? }
```

- `send` returns `{ messageId, targetSessionId, status: 'queued' | 'delivered' | 'interrupted' | 'target_archived', deliveredAt?, references }`. A repeated `requestId` returns the original result.
- `read` returns the message and its receipts: `{ messageId, targetSessionId, sourceSessionId, sourceRole, text, references, receipts: [{ at, status }], nextCursor? }`. `text` is the body the sender wrote; the delivered text also starts with a sender header.
- `priority` defaults to `normal`; `urgent` is limited to the three cases below.
- `replyTo` links a reply to the message it answers.
- Scope: sessions in the same workspace may message each other (any agent); a cross-workspace send is allowed only through a task binding: the task lives in the caller's workspace, its `targetSessionId` is the caller, and its `dispatcherSessionId` is the send target (implemented, section 6.5). The target must be a session in that workspace; there is no broadcast, and the message body is bounded to one screen.

The sender header is the tool's job. A delivered message is two text blocks: the header `[workspace_message] from <role> <sessionId> in <workspace title> (<workspaceId>)` followed by `Task <taskId> · reply to <sessionId> with workspace_message.send` (or `No task bound` instead of the task), then the body. The sender stores `sourceRole` on the record, so `retry` rebuilds the same header and the target never has to guess who asked or where to answer.

Normal versus urgent: a normal message queues and arrives at the target's next turn boundary. An urgent message is one of three cases: a correction of a wrong conclusion the target is acting on; a stop order for a dangerous or irreversible operation; a user instruction change that invalidates the current work. The sender, any agent, marks `priority: 'urgent'` and names one of the three cases in `urgentReason`; the tool rejects an urgent message without it. The super agent has no separate urgent channel; any agent may mark an urgent message. An urgent message inserts before the target's next tool call and may interrupt the current step. Before Step 3 every message used the normal append path, so an urgent correction waited behind the queue and a wrong conclusion could run to completion; that is the defect this channel fixes. Step 3 sends an urgent message with `steer` and falls back to the queue when the target is idle.

`requestId` is optional for `send`: omit it to send a new message each call, supply it so a retry returns the first result. A retry of a failed delivery always reuses the failed message's own identity, so it never needs a fresh key.

Reply guidance: an ordinary agent replies with `workspace_message.send` and `replyTo` when the requested work is done or blocked. The reply is conclusion, evidence, next step, a few lines, no report; references replace attachments. The `workspace_message.send` tool description states this, and the static `workspace-routing` prompt section repeats the header and reply rules so an ordinary agent does not have to infer the contract.

Attaching `references` to `send` is the push path; see section 6.6.

This tool is not the subagent-tree messaging tool. It addresses workspace sessions, including sessions the caller did not start.

### 5.5 `workspace_artifacts`

Publishes, references, requests, grants, lists, and resolves the files and reports a session or task produced.

Input:

```
{ action: 'publish' | 'reference' | 'request' | 'requests' | 'grant' | 'list' | 'resolve',
  workspace?, path?, sessionId?, taskId?, artifactId?, version?, messageId?,
  kind?, summary?, pathPrefix?, requestId?, decision?, expiresInSeconds?, cursor?, limit? }
```

- `publish` registers a file and returns an artifact reference; it does not copy the file. It takes `path`, `kind`, and optional `summary`/`taskId`; `requestId` is optional and a repeated one is idempotent.
- `reference` attaches an existing artifact reference to a message or task without copying it; it takes `artifactId`, optional `version`, and `messageId` or `taskId`; `requestId` is optional.
- `request` asks for one recorded version. In the caller's own workspace it resolves immediately; a cross-workspace request returns `pending`, queues one pending request per requesting Session and version, and resolves `ok`, `changed`, `missing`, `denied`, or `expired` once the holder decides.
- `requests` lists the pending cross-workspace requests the workspace holds: artifact, version, requesting Session and role, and when it was asked. The queue is what a holder reads before deciding; a `grant` drains the matching requests.
- `grant` records the holder's decision for one version: `decision` is `granted` or `denied`, and `expiresInSeconds` defaults to 86400 with a minimum of 60. A grant is bound to the version's hash, so a new version needs a new grant. An agent in the artifact's workspace may grant; a cross-workspace grant requires the super agent.
- `resolve` reports whether the recorded reference still matches the file and returns no content; the attachment itself is the grant on the push path, so `resolve` does not consult the grant record.
- `list` returns references only; a task with no recorded artifact returns an empty list, not a guess.

Scope: paths must resolve inside the workspace root. The tool returns references, not contents. A same-workspace request resolves without a grant; a cross-workspace read needs the explicit workspace id and a valid version-scoped grant. The role model itself is defined by the [agent role model](agent-role-model-20261114.md). `denied` means the recorded path resolves outside the workspace root or is not a regular file, or the holder denied the version. The reference model is section 6.4; the pull and push checkpoints are section 6.6.

### 5.6 When to call which

| Question | Tool |
|---|---|
| Which sessions exist in this workspace, and what are they doing? | `workspace_sessions` with `action: 'list'` |
| What is this session working on, and what happened recently? | `workspace_sessions` with `action: 'get'` |
| Deliver work to a workspace Session, reusing the existing one | `workspace_sessions` with `action: 'run'` |
| The person asks for a new or isolated Session | `workspace_sessions` with `action: 'run'` and `new_session: true` |
| Force a new execution Session with its first task | `workspace_sessions` with `action: 'start'` |
| When a formal task record is needed, create a task or change its status (an intent card is optional) | `workspace_tasks` with `action: 'create'` or `'update'` |
| A simple or clear request | Run it directly, or send it with `workspace_message.send` / `workspace_sessions.start` |
| A person's decision is needed inside a request from another agent | `workspace_message.send` to the dispatcher; `ask_user_question_plus` refuses the interactive ask |
| What is the task status, and what did the executor report? | `workspace_tasks` with `action: 'get'` |
| What did the user ask for, and which items are inferred? | `workspace_intents` with `action: 'get'` |
| Confirm an inferred card version | `workspace_intents` with `action: 'confirm'` |
| Record a correction to the card | `workspace_intents` with `action: 'correct'` |
| Send a message or follow-up with references | `workspace_message` with `action: 'send'` |
| Did the target receive it? | `workspace_message` with `action: 'read'` |
| Where is the report or file this session or task produced? | `workspace_artifacts` with `action: 'list'` or `'resolve'` |
| Read a version this workspace did not produce | `workspace_artifacts` with `action: 'request'`; the holder records `grant` |
| See who is waiting for a cross-workspace artifact | `workspace_artifacts` with `action: 'requests'` |
| What exactly did the session say in a turn? | `session_event_read` |
| Find an older session by content | `session_search` |
| What is the shared server address or default model? | Memory `global` entries |
| What workspaces exist? | The static list in the prompt; no call |

### 5.7 The board reads the same toolset

A future board view needs sessions, progress, tasks, receipts, messages, and artifacts. All of them come from `workspace_sessions`, `workspace_tasks`, `workspace_message`, and `workspace_artifacts`. The fifth member, `workspace_intents`, supplies the dispatch context; the board does not query memory.

## 6. Tool consolidation and tool-based delivery

### 6.1 Why the tools move

When this design started, the memory tools carried session-reading duties, the super agent tools were specific to the JIRA ledger, and outbound information was delivered by the turn-end mechanism rather than by a tool. That split makes cross-session and cross-workspace handoff hard: a message cannot carry a file reference, a report cannot cite another report, and the receiver cannot verify what it received.

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
| `superagent_scan`, `superagent_status` | Reads the JIRA ledger's readiness and counts | No new home; the JIRA ledger is deleted | Remove with JIRA, no compatibility (section 2.3) |
| `superagent_claim`, `superagent_dispatch` | Claims an issue and starts an executor | No new home; JIRA work is retired | Remove with JIRA, no compatibility (section 2.3) |
| `superagent_source` | Imports open GitHub issues into the JIRA ledger | No new home; the cloud data repository is kept as data, not connected | Remove; no compatibility |
| super-agent session control tool (removed) | Registry and Session lifecycle: `start`, `append`, `prompt`, `inspect`, `stop`, `abort`, `fork`, `archive`, `compact`, `delete`, and workspace `roster`/`orphans`/`ensure`/`remove_workspace`/`rename_workspace` | Session lifecycle moves to `workspace_sessions`; registry actions retire with JIRA | Remove; no alias |
| super-agent dispatch-ledger tool (removed) | Read and corrected the dispatch-ledger projection; report status and retry | Delivery state moves to `workspace_message` (`status`, `retry`); task state to `workspace_tasks`; dispatch history dropped | Remove; no alias |
| `superagent_deliver` | Copied a file into another workspace | `workspace_artifacts` publishes a reference and `workspace_message.send` carries it | Remove; references replace the copy |
| `superagent_permission` | Switched the caller Session's permission preset | The permission-preset service and the Host setting own the preset | Remove; no alias |
| `superagent_models` | Listed providers, models, and reasoning efforts | Model settings own model routing | Remove; no alias |
| `workspace_sessions` | Lists, reads, and controls Sessions: `list`, `get`, `run`, `start`, `append`, `prompt`, `stop`, `abort`, `fork`, `archive`, `compact`, `delete` | Workspace toolset | Add; lifecycle replaces the retired session control tool |
| `workspace_intents` | Creates, reads, confirms, corrects, and versions workspace intent cards | Workspace toolset | Add |
| `workspace_tasks` | General dispatch tasks and receipts | Workspace toolset | Add |
| `workspace_message` | Sends messages, follow-ups, and references; reads receipts; `status` reports delivery failure and `retry` resends | Workspace toolset | Add; delivery state replaces the retired ledger report actions |
| `workspace_artifacts` | Publishes, references, requests, lists pending requests, grants, and resolves artifacts; for a `.dsh` path it uses the store's checks | Workspace toolset | Add |
| `send_message`, `wait_agent` | Messaging inside the subagent tree | Subagent tree | Keep; out of scope |
| Turn-end delivery | Implicit outbound message after a turn | Removed; no fallback | Delete |
| `read`, `glob`, `grep` | Reads workspace content | Content tools | Keep |
| `tool-dsh-store` | The sole model-facing `.dsh` entry for rules, skills, and other store content | Store tool | Keep; `workspace_artifacts` routes `.dsh` paths through its path and namespace checks |
| `JIRA issue tool`, `JIRA knowledge tool`, `JIRA list tool` | Read or changed the local JIRA ledger | No new home; the ledger is deleted | Remove with JIRA, no compatibility |
| JIRA skills `jira-work`, `jira-board`, `jira-triage` | Procedures over the JIRA ledger | No new home | Remove with the tools |
| JIRA local ledger `$DSH_HOME/jira` | Issue and knowledge storage | Deleted; no tool reads it | Delete; irreversible |
| Dispatch ledger `.superagent/ledger` | Projection of dispatch history | `workspace_tasks` starts fresh | Drop; no migration or import |

`workspace_tasks` does not carry a JIRA compatibility field. JIRA is removed, so any `jiraKey` or ledger delegation is dropped, not bridged; `superagent_status` is not kept as a JIRA aggregate. The workspace toolset has five members: `workspace_sessions`, `workspace_intents`, `workspace_tasks`, `workspace_message`, and `workspace_artifacts`. The `.dsh` row is a dependency, not a decision; section 2.3 owns that boundary. Current state after the tool-surface change: `workspace_sessions` (`list`/`get`/`run`/`start`/`append`/`prompt`/`stop`/`abort`/`fork`/`archive`/`compact`/`delete`), `workspace_intents`, `workspace_tasks` (`list`/`get`/`create`/`update`/`receipt`), `workspace_message` (`send`/`read`/`status`/`retry`), and `workspace_artifacts` (`publish`/`reference`/`request`/`requests`/`grant`/`list`/`resolve`) are shipped, and the static `workspace-directory` prompt section is wired for every agent. `memory_read` is deleted (Step 1), and `memory_resolve` is deleted with the dispatch namespace in Step 4; the memory tool surface is `memory_write`, `memory_forget`, and `memory_search`. The JIRA model tools, the executor ledger tool, the claim/dispatch tools, the super-agent control and ledger tools, the three JIRA skills, the panel, and the CLI are removed; session lifecycle and delivery state live in `workspace_sessions` and `workspace_message`. The local JIRA ledger and the dispatch ledger are deleted; `workspace_tasks` starts empty. JIRA keeps only its cloud data repository, as data, not connected to any tool or process. No JIRA package remains.

### 6.3 Delivery as a tool call

`workspace_message.send` is the primary delivery path:

Input: `{ workspace?, targetSessionId, kind: 'message' | 'followup', text, priority?: 'normal' | 'urgent', urgentReason?, replyTo?, references?, taskId?, requestId }`. An urgent message must name one of the three cases in `urgentReason`, which is the tool's machine-checkable validation of section 5.4. `workspace` selects a target in another workspace and is admitted only through a task binding (section 6.5); omitting it uses the caller's workspace.

- `text` is bounded to one screen. The schema caps it at 600 characters, and the tool description requires three parts: conclusion, evidence, next step, at most six lines.
- `references` is a list of artifact references. No file content is ever placed in the message body.
- `taskId` links the message to a task when the message is a status update or follow-up.
- `priority: 'urgent'` is marked by the sender, any agent, and validated by the tool against the three cases in section 5.4; it inserts before the target's next tool call and may interrupt the current step.
- `replyTo` marks a reply to an earlier message.
- `requestId` is the idempotency key. A repeated call returns the first result.

Output: `{ messageId, targetSessionId, status: 'queued' | 'delivered' | 'interrupted' | 'target_archived', deliveredAt?, references }`.

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
- Current state after Step 4: `resolve` implements `ok`, `changed`, `missing`, and `denied`; `pending` and `expired` are reachable through `workspace_artifacts.request`/`grant`. A same-workspace request resolves without a grant; a cross-workspace request reads the version-scoped grant record, so a denied or expired decision is reported without reading the file. `resolve` on the push path does not consult that record: the attachment is the grant. A cross-workspace artifact resolve does not check workspace membership or role: it takes the explicit workspace id and is recorded, and `denied` means the recorded path resolves outside that workspace root, is not a regular file, or the holder denied the version.
- A grant is scoped to one artifact version and one requester, and it expires. A push attachment is a grant for that target session only. A new version needs a new grant; an old grant does not follow the new content.
- Cross-session references resolve inside the same workspace by default. A reference from another workspace requires an explicit `workspace` id; if the caller has no access, the result is `denied`, never `missing`.
- Deleting a file does not delete the artifact index entry; `resolve` returns `missing`, and the reference remains for audit. Re-publishing the same path creates a new version; old references resolve as `changed` rather than silently following the new content.
- A report can cite another report by artifact id. The citation is a reference, so the report does not duplicate the other report's body.

### 6.5 No turn-end fallback; workspace requests and return contract

There is no turn-end delivery path in the workspace toolset. Every outbound message from it is an explicit `workspace_message.send`; a turn that sends nothing delivers nothing. JIRA's turn-end delivery is deleted with the JIRA retirement, so no implicit outbound path exists for any role or deployment configuration. `requestId` still deduplicates retries; the same content cannot be delivered twice through it and a new problem cannot be mistaken for an old one.

Workspace requests are a general capability, not a role-exclusive workflow. Any agent can send a request to another agent or Session in the same workspace through `workspace_message` (`send`/`read`/`status`/`retry`), and can start or continue a Session through `workspace_sessions` (`start`/`append`/`prompt`). Intent cards and `workspace_tasks` are used only when a formal task record is needed and session information exchange and management must be standardized; a simple or clear action runs directly or sends a request directly, needs no separate card, and no fixed order applies to every action. `append`, `prompt`, and `abort` continue an existing Session and do not create a second task. Confirm an uncertain scope with the human first (the global personality prompt rule).

The two paths coexist. The super workspace — the dispatcher — dispatches with the same tool calls: the super agent records a formal task with `workspace_tasks.create`, starts or continues the executing Session with `workspace_sessions.start`/`prompt`, and reads the executor's return with `workspace_message.read`/`status`; a cross-workspace return is allowed only through the task binding. It does not narrow the general capability: any agent may still send a same-workspace request through `workspace_message` and start or continue a Session through `workspace_sessions`.

Write-role gate (implemented): writes inside a workspace are open to any agent — `workspace_tasks.create`/`update`/`receipt`, `workspace_intents.create`/`confirm`/`correct`, and the `workspace_sessions` lifecycle writes only require the caller to be in the target workspace; a cross-workspace write still requires the super agent. A cross-workspace send is not admitted by role; it follows the return contract below.

The return contract (implemented): `workspace_tasks.create` records the calling Session id as the task's `dispatcherSessionId`. The executor calls `workspace_message.send` with `taskId` to the Session that started the task, and the message record stores `taskId`, `requestId`, and artifact references; `requestId` is idempotent, so a repeated call returns the first result. A cross-workspace send is allowed only through the task binding: the task lives in the caller's workspace, its `targetSessionId` is the caller, and its `dispatcherSessionId` is the send target; a supplied `taskId` names the task, and without one the binding is found by caller=`targetSessionId`. Same-workspace sends are not subject to this rule. `status` reports delivery state, failure reason, and attempt count; `retry` resends a `failed` message under the same identity, and a cross-workspace `retry` uses the same task binding as `send`; task state changes only through `workspace_tasks` `update` and `receipt`, and message delivery does not change task state.

Dispatch reuses before it starts (implemented). `run` is the one-call dispatch: it continues the target Session (`sessionId`, or the most recently updated one when omitted) and starts a new Session only when the workspace has none; `run` with `new_session: true` forces a fresh Session even when one exists, and `start` does the same with an explicit first task. Before dispatching, the dispatcher reads `workspace_sessions.get`, whose roster fields include `contextUsage: { tokens, window, percent }` on a live target, and calls `compact` first when the target's context is above the threshold, so the executor receives the task with room to work.

An agent-to-agent request does not become a loop (implemented). The executor answers with at most one message per request; when it needs a person's decision — a question or an approval — it sends that request to the super agent with `workspace_message.send` instead of calling `ask_user_question`. The super agent is the only party that speaks to the person, so a dispatched Session never asks the user directly and never keeps a thread going just to reply. The dispatcher is the task's `dispatcherSessionId`; when no task exists, the delivered request identifies the dispatcher Session in its sender header, so the executor can route its question back. `ask_user_question_plus` checks the turn's latest user message for that header: a non-super turn started by `workspace_message` or `workspace_sessions` is refused with the dispatcher named, while a person-started turn and every super-agent turn delegate to the host `userQuestions` service. The super-agent exception matters: the super agent receives an executor's routed question in a turn that also carries a header, and it must still ask the person.

If the tool call fails, the model retries with the same `requestId` or reports the failure; it must not assume an automatic delivery. A reply is short: conclusion, evidence, next step; references carry files; no report-length prose.

### 6.6 Artifact access: pull and push

Artifact access has two modes, chosen by which tool runs first. Pull is implemented: `workspace_artifacts.request` and `grant` are shipped, and the push path through `workspace_message.send` references is shipped.

**Pull.** The requester calls `workspace_artifacts.request`. Checkpoints, in order:

1. The requester's access to the target workspace, by membership and role.
2. The artifact's existence and version, checked only after access. A cross-workspace caller that fails access gets `denied`, never `missing`, so artifact existence does not leak.
3. The holder's grant or the workspace policy. Same-workspace policy auto-grants; a cross-workspace request without a valid grant queues a pending request (listed by the holder with `workspace_artifacts.requests`) and returns `pending` until the holder grants.
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

- `memory_write` accepts only a global fact or convention; it rejects business facts, dispatch state, and persona or style notes, naming the tool that owns the text.
- `memory_search` searches global entries only (`GLOBAL.md`, plus `GLOBAL.archive.md` when `includeArchived` is set); the session-corpus half is removed.
- `memory_read` is deleted; session context is `session_event_read` or `workspace_sessions`.
- `memory_forget` forgets global entries by `topic` or `entryId`; the session, turn, and kind filters are removed with the dispatch namespace.
- `memory_resolve` is deleted; there are no open or dispatch entries to resolve.
- The `/memory` command keeps `list`, `stats`, and `forget --topic`/`--id`; summary, pause, prune, and session-editing subcommands are removed with the per-workspace summary job.

### 6.8 Risks in the consolidated toolset

- Delivery reliability: retries use `requestId`; the result distinguishes queued, delivered, interrupted, and failed; there is no fallback, so one explicit path is the only path.
- Double delivery: the one delivery path deduplicates with `requestId`; the second write is a no-op.
- Reference invalidation: `changed`, `missing`, and `denied` are distinct; references are immutable; no silent follow of a new version.
- Permissions: who may send to which session, and who may read whose artifacts. Cross-workspace reads are explicit and audited; `denied` is not `missing`.
- Session lifecycle: a message to an archived session returns `target_archived` and does not create a pending inbox; the artifact references remain resolvable after the session is archived.
- Tool removal breakage: deleting `memory_read` and `memory_resolve` changes the prompt and the tool catalog; the prompt, tool descriptions, and snapshots must change in the same step.

## 7. Prompt, write, and injection rules

### 7.1 Memory write rules

- The only accepted entry is a `global` fact or convention. `memory_write` takes `topic` and `text`; `topic` must be in the allowlist. The caller's session id is recorded as `sourceSessionId`; the model does not pass it.
- The body is rejected if it carries an absolute workspace path, a JIRA key, a version or commit, a device or mirror, a dispatch status, an analysis conclusion, or persona/style guidance. The rejection code is `NOT_GLOBAL_MEMORY`, and the message names the owning tool: the workspace tools, `session_event_read`/`read`, or `personality_apply`/`write_like_human`.
- There is no `dispatch` namespace and no per-turn automatic memory entry. The per-turn summary job is removed.
- A business, dispatch, or persona write is rejected; the caller is told which tool owns the text.

### 7.2 Prompt and injection rules

- The prompt has one static `workspace-directory` section. It is not rewritten per turn, and it contains no status, no memory, and no tasks.
- The memory snapshot module, the `memory-state` prompt section, the `appendMemoryUpdate` notices, and the cross-session index no longer exist; Step 3 removed them.
- Transcript compression, when the session is compacted, may still replace old turns with a summary. That is a compaction behavior: it does not append a memory message per turn, and it is not injected at session start.
- The reply contract (conclusion, evidence, next step; at most 600 characters) is stated in the `workspace_message.send` tool description and its `text` parameter, not in a system-prompt section.
- The three urgent cases are stated in the `workspace_message.send` parameter descriptions; no separate prompt section carries them.
- The rule for asking the user lives in the global personality prompt (`PERSONALITY.md`) and applies to every agent; the workspace toolset does not restrict asking by role.
- The static section's title states that only registered workspaces exist and that a subdirectory is not a workspace.
- Compaction triggers at 40% of the context budget by default; the threshold is configurable, and the super agent may use a different preset per agent (default 40%, adjustable).
- No memory message is appended on a write.

### 7.3 Search and read rules

- `memory_search` searches `GLOBAL.md` and, with `includeArchived: true`, `GLOBAL.archive.md`; session search is `session_search`.
- `memory_read` is removed from the model-facing tools; session context is `session_event_read` or `workspace_sessions`.
- Archived global entries are returned only when `includeArchived` is set, and they are never injected.

### 7.4 Every session, no exceptions

The prompt change, the removal of per-turn memory messages, and the memory rules apply uniformly: an ordinary workspace session and the super agent get the same static workspace list, the same toolset, and the same global-only memory rules. There is no feature flag that restores snapshots for one session type, because the flood is a property of the mechanism, not of the agent role.

Acceptance measurement for an ordinary session:

- Before: one snapshot per summary pass, one "Memory updated" notice per explicit write, and at most one checkpoint per tier boundary. In the observed super-agent session that produced 812 snapshots, 350 update notices, and 149 checkpoints (704 entry lines), 737 KiB in total.
- After: zero memory-sourced messages per turn in steady state; per-turn memory bytes are 0. The only context is the static workspace list in the prompt and the results of tool calls. Compaction summaries are not memory messages and are measured separately.

The "what did I do last turn" case is the one that per-turn notices used to cover. After the change, `workspace_sessions` with `action: 'get'` returns `recentProgress` and `currentActivity` for the session, and it is the tool the model should use for that question. The automated test asserts the injection surface after one write and one completed turn: no memory-sourced message and no `memory-state` section. The multi-turn zero-byte measurement and the "what did I do last turn" question on a real ordinary session are deployment checks in section 14.1.

## 8. Migration and the stop-the-bleeding fix

### 8.1 Stop-the-bleeding fix: ship first, independent of this design

Step 0 shipped independently of the rest of this design. `pruneSessionEntries` now returns archive records for every over-cap and exact-duplicate removal, with `over-cap` and `duplicate` removal reasons; `retainDocument` collects those records; every write path archives them before writing the active file; and a failed archive keeps the entries instead of dropping them.

Acceptance: lowering the cap to three entries and writing a fourth turn always leaves an archive record for each dropped entry; a failed archive keeps the entry; a stale-version retry never duplicates an archive record.

### 8.2 Migration rules

| Class | Rule | Treatment |
|---|---|---|
| `global` | Cross-workspace fact or convention: shared server address, harness default model, shared rules, cross-workspace preference | Human confirmation required; becomes a global entry |
| `dispatch` | Names a task, session, or ledger path and describes a plan, next step, or progress | Archived; `workspace_tasks` is the durable owner |
| `business` | Analysis conclusion, device or mirror, production version or HEAD, code path or commit, test result, report content, workspace configuration | Archived, never injected; the pointer, if any, lives in the task or a workspace record, not in memory |
| `persona` | Persona or writing-style guidance | Archived, never injected; personality and writing rules own it |
| `unclassified` | No source session, no turn, or ownership that cannot be determined | Archived, listed in the report, never injected, no guessing |

The dry-run report lists, per file and entry: the class, the proposed global topic, the reason, the byte count, and the target path. Global candidates are listed separately for a person to confirm. The report's SHA-256 hash is the confirmation token: `--apply <hash>` rescans and refuses unless the hash still matches, so an apply cannot run against files that changed after the report was read. Applying writes a backup of every changed file before the first write, appends the migration archive records before it rewrites an active file, records each handled entry in a journal so a repeated dry run converges, and is reversible with `--rollback <run-id>`. The rewritten active file keeps the version-1 format, so the legacy parser reads it and a code rollback leaves it readable. `packages/uitstalie/memory/scripts/migrate-global-memory.ts` is the human command; the module behind it is `packages/uitstalie/memory/src/migration.ts`.

Every workspace's memory file is migrated with the same rules; an ordinary session is not a special case. Its file gets the same report, backup, archive-first write, and rollback.

A heuristic pass over the current 406 entries suggests about 15 global candidates (most of which review should reject), about 50 dispatch entries, and about 340 business, persona, or unclassified entries. These numbers are for planning; the report is authoritative.

## 9. Milestones

| Step | What | Acceptance |
|---|---|---|
| 0 | Stop-the-bleeding fix to the over-cap path | Cap and archive tests pass; no silent loss; independent release, rollback by reverting the commit |
| 1 | Read side of the consolidated toolset: `workspace_sessions`, `workspace_tasks` read, `workspace_artifacts` list/resolve, `workspace_message` read; narrow the memory tools; keep the prompt and injection unchanged | A session in workspace A sees only A; a cross-workspace call without an explicit id fails; memory tools no longer read sessions; results are bounded and paged |
| 2 | Task creation + intent card: `workspace_intents` (workspace record, source annotations, per-version confirmation) and `workspace_tasks.create` with an optional active card; coverage check when a card is used, and the receipt gate | A traceable card becomes active without confirmation and dispatches; an inferred card stays proposed and dispatch rejects with `INTENT_UNCONFIRMED` until one consolidated confirmation; a cross-workspace request produces one card per workspace with the original text verbatim; a correction appends a version and leaves the old one readable; a missing coverage point rejects with `INTENT_COVERAGE_MISSING`; a receipt with an unsatisfied item cannot be `done` |
| 3 | Delivery becomes a tool call and the flood is removed in the same release: `workspace_message.send`, artifact publish/reference, the static prompt, and no snapshot, update notice, cross-session index, or turn-end delivery | A message and a reference round-trip; a retry does not duplicate; a turn with no send delivers nothing; an ordinary session's per-turn memory message count is 0 and bytes are 0; "what did I do last turn" is answered from `workspace_sessions` |
| 4 | Memory becomes global-only and the old entries are migrated | A business or dispatch write is rejected with a tool hint; the dry-run report is produced; only confirmed global entries remain injected; backups and rollback verified |

Implemented: Steps 0–4. Step 3 shipped `workspace_message.send`, artifact `publish`/`reference`, the static workspace directory, and the removal of the memory snapshot, the `memory-state` section, the "Memory updated" notice, and the cross-session index. A turn that sends nothing delivers nothing through the workspace toolset: the only call that reaches the host Session controller is `workspace_message.send`. Step 4 shipped the global-only store (`$DSH_HOME/memory/GLOBAL.md` plus `GLOBAL.archive.md`), the three-tool surface (`memory_write`, `memory_forget`, `memory_search`), the `NOT_GLOBAL_MEMORY` refusal with a pointer to the owning tool, the removal of the per-turn summary job, and the report-hash migration with backups, a journal, and rollback. `memory_resolve`, the workspace-summary command forms, live TTL cleanup, and the cross-session index are gone from the model and human surfaces. Implemented: the task-bound cross-workspace return with `task.dispatcherSessionId` (section 6.5). Shipped: artifact `request`, `requests`, and `grant`.

Each step is independently shippable and reversible. Step 0 ships first. Steps 1–4 do not depend on the board direction.

Ordering: the read side lands first so the model can query before anything is removed. Task creation and the intent card land next, so a formal task record has a workspace record to validate against. The flood removal and the delivery tool land in the same release, so there is no window where the old injection is gone and the new delivery path is not yet available. The memory migration is last because it rewrites user data and benefits from a stable toolset.

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
- One owner for a task: only `workspace_tasks` writes the task record. When a formal task record is needed, the order is optional active intent card → `workspace_tasks.create` → an optional `workspace_sessions.start`/`prompt`; a simple or clear action needs no card and no task. There is no dispatch-history copy and no second task list. Return goes only through `workspace_message.send`, and task state only through `workspace_tasks`.
- Message priority: an urgent message may interrupt a step. `workspace_message.send` requires one of the three named cases as `urgentReason` when the priority is urgent, steers the running step when the target is running, and falls back to the queue when it is idle. The three cases are narrow, and a normal message is never urgent; a misclassified urgent message is a defect to review.
- Reference invalidation: `publish`/`reference`/`send` shipped, so changed, missing, and denied are reachable and distinct; a citation is immutable at send time, and a new version needs a new citation. `request`/`grant` shipped, so `pending` and `expired` are reachable; a grant is version-scoped, expires after its lifetime, and never reveals a decision the holder did not make. A cross-workspace denial never reveals existence.
- Cross-workspace authorization: an explicit workspace id, registry membership, and a recorded call. A cross-workspace send is allowed only through a task binding; without one, a call from any role is refused. Pull checks the receiver first, push checks the sender first; no implicit aggregation.
- Losing context compression: a compaction preset that is too aggressive may drop context; make it configurable, test a long session, and keep the previous value as a rollback.
- Confirmation channel: confirm an uncertain scope with the human first (the global personality prompt rule); a confirmation request has a deadline and visible states, and a broken chain marks it `failed` rather than hanging.
- Migration misclassification: the dry run lists every candidate with its class, reason, topic, bytes, and target; apply refuses a stale report hash; backups make a wrong migration reversible and the journal makes a repeated dry run converge. A wrongly archived global fact can be re-added, and a code rollback still parses the rewritten version-1 file.
- Legacy memory shell: the per-workspace `MEMORY.md` reader (`memory-file.ts`), its cleanup, window, and checkpoint modules, and the `memory` settings row remain as compatibility code for old files and the migration. They have no live write or injection path; removing them is deferred until the migration has run on the deployed data.
- Every-session blast radius: a prompt or toolset defect now reaches ordinary sessions too. Step 3 staged shipment as toolset first, then the static prompt and injection removal, and keeps the previous prompt available as a build-time rollback for one release. The zero-injection regression test is the gate: a build that appends one per-turn memory message fails its own suite.
- The task-bound return is implemented: a cross-workspace send requires the task in the caller's workspace with `targetSessionId` the caller and `dispatcherSessionId` the target; `create` records `task.dispatcherSessionId`. A cross-workspace send without a binding, including one from the super agent, is refused.

### 10.4 Confirmed in this round

- Task status: new vocabulary only; old task data is not migrated; a one-time script can do it later.
- Messaging: same-workspace messages are allowed (any agent); a cross-workspace send is allowed only as a task-bound return (implemented); the sender, any agent, marks urgent and the tool validates the three cases; the prompt teaches the short reply.
- Reply format: conclusion, evidence, next step; at most 6 lines or 600 characters; files as references.
- Task types: analysis and diagnosis, fix, test verification, migration and deployment, design document, other; a closed list changed only by review.
- Artifact access: pull via `request`/`grant`, push via message references; the tool order decides; same-workspace policy may auto-grant; a cross-workspace read needs an explicit grant; denied, pending, expired, missing, and changed are distinct.
- Ask user and approval: confirm an uncertain scope with the human first (the global personality prompt rule), which applies to every agent; request states are visible and nothing hangs silently.
- Workspace list: registered workspaces only; subdirectories are refused with a registration prompt.
- Compaction: kept; triggers at 40% of the context budget by default; configurable; the super agent may use per-agent presets (default 40%, adjustable).
- Turn-end delivery: removed; no fallback; replies are conclusion, evidence, next step, not reports.
- JIRA: fully retired; only the cloudstore data repository on GitHub is kept, as data, not connected to any tool or process, not a design capability, and needing no credentials or remote-access instructions.
- JIRA local data: the local ledger and dispatch history are deleted and irreversible; no tool reads them.
- Dispatch history: dropped; no migration or import; `workspace_tasks` starts fresh.
- JIRA skills and super-agent session aliases: removed; no alias names are kept.
- Intent cards: used only when a formal task record is needed and session information exchange and management must be standardized; a simple or clear action needs no separate card. Workspace records, one per workspace; a cross-workspace request is split by the initiator into one card per workspace with the original text verbatim (one `create` call per workspace, because the tool has no multi-workspace parameter); every item is source-annotated; an all-traceable version is active immediately; a version with inferred items is proposed and confirmed once before task creation; an active version is reused without re-confirmation; a correction appends a version and supersedes the previous one.

## 11. Intent cards: dispatch alignment

### 11.1 The failure this fixes

Decomposing a user request into tasks re-expresses the request, and each re-expression can drift; the user corrects it, the correction is lost in the next task, and the same drift returns. Prompt improvements reduce the rate but cannot make the intent durable: the task carries a paraphrase, not the user's words, and nothing checks the task before creation or the result after it.

This is a structural failure, so the fix is a workspace record: an intent card that the initiator writes when alignment is needed, that a task may reference, that task creation validates against when referenced, that receipts are checked against, and that corrections append to. The card belongs to the workspace the work happens in, not to the host or to memory; a simple or clear action needs no card, and a cardless task records its brief directly.

### 11.2 The intent card

An intent card is one workspace's record of one user request. It has one stable id and append-only versions.

| Field | Meaning |
|---|---|
| `intentId` | Stable id for the request inside the workspace |
| `workspaceId` | The one workspace this card belongs to |
| `version` | 1, 2, 3…; each correction appends a new version |
| `status` | `proposed` or `active` in the immutable version file; `superseded` is the current state recorded in `index.json` |
| `rawUserText` | The user's original words, verbatim |
| `items` | The goal, acceptance points, boundaries, and output form; each item carries its own source annotation |
| `sourceSessionId`, `sourceTurn` | Where the user stated the request |
| `createdAt`, `author` | When and who created this version |
| `confirmedAt`, `confirmedBy` | When and who confirmed the inferred items; recorded on the version summary in `index.json`, not in the version file |
| `supersedesVersion` | The previous version this one replaces, if any |
| `requestId` | Idempotency key of the create or correction that wrote this version |
| `reason`, `correctionText` | Correction reason and the user's correcting message, for version 2 and later |
| `changedPoints`, `changedPointRefs` | Changed item texts and stable `kind[index]` point identities, for recurrence metrics |
| `taskType` | Six-category attribution recorded with a correction, when known |

Each item is `{ text, source, anchor?: { path, heading? }, reason? }` and appears in `goal`, `acceptance`, `boundaries`, or `outputForm`. `rawUserText` is not an item; it is stored verbatim and is never paraphrased. The point identity (`goal[0]`, `acceptance[1]`, …) is derived, not stored. `confirmedAt` is not stored on the version item; the tool projects it from the version summary in `index.json` onto each inferred item it returns.

- `user-verbatim`: the item text is copied from `rawUserText` without paraphrase. This is traceable.
- `user-anchor`: the user named a workspace document or section; `anchor` records the workspace-relative path and heading, and the item quotes that anchor. This is traceable.
- `inference`: the initiator wrote the item from its own interpretation. It is not traceable and needs confirmation.

Storage: `$DSH_HOME/workspaces/<workspace-id>/intents/<intentId>/` with `index.json` (the append-only version list and each version's current status, confirmation, and rejection metadata) and `versions/<n>.json`. Version files are immutable: a correction writes a new version, and old versions are never edited or deleted. It is workspace state beside the task, message, and artifact records, not a host-global intent directory and not memory.

Ownership: the user owns the intent. The initiator may create a version from the request and annotate every item; any agent in the workspace may write the card, and a cross-workspace write requires the super agent. A version whose items are all traceable is created `active`; a version with any inferred item is created `proposed`. The user confirms inferred items or appends a correction. No one can silently rewrite an active version.

### 11.3 Per-version confirmation

Confirmation is per version and only for inferred items.

- `workspace_intents.create` computes the status from the source annotations. All items traceable means `active`, with no user interaction.
- Any inferred item means `proposed`. The create result includes one consolidated confirmation request: `{ requestId, items: [{ point, text, reason }] }`. When to ask the human is decided by the global personality prompt rule; the tool produces one consolidated request, not one question per item.
- `workspace_intents.confirm` takes `{ intentId, version, decision: 'confirm' | 'reject', note?, requestId }`. Confirm updates the version's summary in `index.json` (`status: 'active'`, `confirmedAt`, `confirmedBy`, `confirmedPoints`) and leaves `versions/<n>.json` unchanged; the tool projects `confirmedAt` onto each inferred item in its response and keeps the source annotation, so each item remains traceable. Reject records `rejectedAt`/`rejectedBy` on the summary and leaves the version `proposed`; dispatch stays blocked.
- An `active` version is reused by every later dispatch. It is not confirmed again. A correction appends a new version; the previous version becomes `superseded` in `index.json`.
- A task that references a `proposed` version is rejected with `INTENT_UNCONFIRMED` and the pending confirmation id; it never produces a separate confirmation per item.

### 11.4 Pre-dispatch validation

`workspace_tasks.create` requires only `workspace` (the target) and `goal`; `acceptance`, `boundaries`, `taskType`, and `requestId` are optional, with empty lists, `other`, and a generated key as their defaults. `intentId` and `intentVersion` are optional; when both are supplied, the service reads that card version and runs the checks below, and when both are omitted it records the task without a card and skips them. Supplying only one of the two, or supplying `coverage`/`nonCoverage` without a card, rejects with `INTENT_INCOMPLETE`; missing a required field also rejects with `INTENT_INCOMPLETE`. When a card is referenced, a missing card, or a version the card does not have, rejects with `INTENT_INCOMPLETE`; a proposed version rejects with `INTENT_UNCONFIRMED`; a version that is superseded or not the latest active one rejects with `INTENT_STALE`, and the caller must re-read the card; a card from a different workspace rejects with `INTENT_SCOPE_MISMATCH`; the task must reference the card in its own workspace.

When the task references a card, the service runs a coverage check: every goal, acceptance point, boundary, and output-form item in the card must map to an item in the task brief. The caller supplies `coverage: [{ point, brief, note? }]`, where `point` is the card point identity (for example `acceptance[0]`) and `brief` must match a task-brief item for that field, whitespace-normalized; a missing mapping rejects the dispatch with `INTENT_COVERAGE_MISSING`. The only waiver is an explicit `nonCoverage: [{ point, reason }]` with a non-empty reason, supplied by the dispatcher as the dispatch confirmation (currently the super agent). There is no default pass and no "assume covered". A cardless task skips this check.

The schema and the service enforce this; the prompt only tells the super agent to read the card first, then the task, then write the coverage list when a card is used. A model that references a card cannot dispatch without covering it.

### 11.5 Post-execution alignment

When a task references a card and returns, the initiator checks the receipt against the same `intentId` and `intentVersion`; a cardless task's `done` receipt needs no alignment checklist. Each item gets one status:

- acceptance: `satisfied`, `not_satisfied`, or `out_of_scope`;
- boundary: `respected` or `violated`;
- output form: `matched` or `not_matched`.

Each status carries evidence: the changed file, the test, the report line, or the missing item. The alignment is produced by the initiator or a validator, not by the executor alone. A `done` transition requires a complete alignment checklist for every card point: a missing alignment rejects with `INTENT_ALIGNMENT_MISSING`, an alignment that leaves a point unchecked rejects with `INTENT_ALIGNMENT_INCOMPLETE`, and any `not_satisfied` acceptance item or `violated` boundary rejects with `INTENT_ALIGNMENT_UNSATISFIED`, moving the task to `waiting_review` or `blocked` with the deviation list. An `out_of_scope` acceptance item and a `not_matched` output-form item do not block `done`. The receipt shown to the user includes the checklist and any deviations, so drift appears as a list, not as a surprise. A new card version during the task does not change the version the task is checked against.

### 11.6 Correction capture and recurrence

Every user correction appends a new intent version with `reason`, the correcting message (`correctionText`), and the changed items (`changedPoints` are their texts; `changedPointRefs` are their stable `kind[index]` identities). The previous active version becomes `superseded` in `index.json`; it stays readable. The new version follows the same source rule: traceable items make it `active`, and any inferred item makes it `proposed` until confirmed.

The next formal task record reads the latest active version automatically; no one restates the intent from memory. A correction that repeats an earlier point is recorded against both versions. The store counts recurrence by card point identity across corrections, so a recurring drift is a number, not an impression.

### 11.7 Metrics

Deviation rate = user corrections / dispatched tasks. The `metrics` action returns two whole-workspace windows (7 and 30 days) and the same windows grouped by task type for every type with recorded activity (`byTaskType`); a rate is `null` when its denominator is zero. A correction event is one new intent version created by a user correction; several changed points in one correction count once. Recurrence rate = corrections whose changed point identity was corrected before / corrections in the window.

Task types are a closed list of six: analysis and diagnosis, fix, test verification, migration and deployment, design document, and other. Adding or renaming a type requires a review; the model cannot invent one.

The inputs are recorded at three points: the intent version append, the task dispatch, and the receipt alignment. No metric depends on memory or on a model's self-report.

### 11.8 Tool surface

`workspace_intents` is the fifth member of the workspace toolset, after sessions, tasks, messages, and artifacts. It provides `create`, `get`, `confirm`, `correct`, `history`, and `metrics`. It follows the scope rules in section 5.1: the caller's workspace is the default, and a cross-workspace call requires the explicit workspace id and is recorded. Intent cards are open to ordinary agents: `create`, `confirm`, and `correct` are open to any agent in the workspace, and a cross-workspace write requires the super agent.

`workspace_tasks.create` accepts an optional active card reference, as above. When the task references a card, `workspace_tasks.receipt` accepts the alignment checklist, and the task state machine refuses `done` without a complete checklist or with a `not_satisfied` acceptance item or a `violated` boundary; a cardless task's `done` needs no checklist.

The formal task entry is `workspace_tasks.create`, plus `workspace_sessions.run` (or `start`/`prompt`) when a delivering Session is needed: the task is recorded against the active card version when it references one (card reference, the brief's acceptance and boundaries, task type, coverage map, `requestId`), or with the brief alone when it does not, then the Session starts with the task's work content as its first task text; `start` itself does not check a card. A simple or clear action needs no card and runs directly or sends a request through `workspace_message`. `run`, `append`, `prompt`, and `abort` continue an already started Session and do not create a second task. The workspace toolset is mounted in the same composition, so `workspace_intents` and `workspace_tasks` are on every agent; writes are open inside each agent's workspace, and a cross-workspace write requires the super agent. The card, coverage, and idempotency rules exist once, and that one implementation is exposed to the dispatcher through the `ctx.workspaceTasks` service; the service is not a model surface and performs no role check of its own.

Current state after Step 4: the tool enforces the task refusals, the coverage check, the receipt gate, the static workspace directory, the message scope and idempotency rules, and artifact publish/reference/request/grant. `workspace_message.send` and `workspace_artifacts.publish`/`reference`/`request`/`requests`/`grant` are shipped. Until a card UI exists, `create`, `confirm`, and `correct` are open to any agent in the workspace; a cross-workspace write requires the super agent. A `nonCoverage` entry is an explicit dispatch waiver, recorded on the task with its reason; it is not a default pass.

### 11.9 What this does not do

This is not a stronger prompt, and not a mandatory workflow for every action. When a formal task record is needed, the prompt only says where to look and in what order: read the intent card, then the task, then the coverage list; a simple or clear action runs directly. The constraints live in the schema, the confirmation state, the coverage check, the receipt gate, and the workspace store.

It also does not put intent cards in memory, in a host-global intent directory, or in a second workspace index. It does not require confirmation for an all-traceable version, and it does not re-confirm an active version.

### 11.10 Acceptance tests

1. A traceable card dispatches without confirmation: `workspace_intents.create` with only `user-verbatim` and `user-anchor` items returns `status: 'active'`; `workspace_tasks.create` succeeds without a confirmation call.
2. An inferred card is blocked until confirmed: a card with one `inference` returns `status: 'proposed'`; `workspace_tasks.create` returns `INTENT_UNCONFIRMED`; `workspace_intents.confirm` with the version makes it active; the same version then dispatches, and a second task reuses it without another confirmation.
3. A cross-workspace request splits cards: the dispatcher creates one card in each target workspace with one `workspace_intents.create` call per workspace (the tool takes a single workspace and has no multi-workspace list); `rawUserText` is byte-identical in both; a task in A references A's card; a task that references B's card from A returns `INTENT_SCOPE_MISMATCH`.
4. A correction appends a version: `workspace_intents.correct` creates version 2, marks version 1 `superseded`, and version 1 remains readable with its original items; the next task references version 2.
5. Coverage is enforced when a card is referenced: a task brief missing an acceptance point returns `INTENT_COVERAGE_MISSING`; adding the point or an explicit non-coverage reason lets it proceed. A cardless task skips the check.
6. A receipt with a deviation is gated: a task with no alignment rejects with `INTENT_ALIGNMENT_MISSING`, an alignment that leaves a card point unchecked rejects with `INTENT_ALIGNMENT_INCOMPLETE`, and an alignment with `not_satisfied` or `violated` cannot move the task to `done` (`INTENT_ALIGNMENT_UNSATISFIED`).

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
| Cross-session index | "Recent sessions" outline | No | `workspace_sessions` | Implemented: removed with the snapshot in Step 3 |
| Global and personal preference sharing | Mixes cross-workspace facts with persona and style | Split | Global memory for facts; personality for persona and style | Implemented: persona and style belong to `personality_apply` / `write_like_human` |

Intent cards are not a memory capability; they are workspace records and never enter the global memory store.

Implementation status after Step 4: every row is implemented as its Action cell states. The injection surface is empty, so no memory entry — global or legacy — is injected; confirmed global entries are read only through `memory_search`. The legacy modules named in section 10.3 remain for the migration and old-file parsing, and the `memory` settings row is retained but inert until that shell is removed.

### 12.2 Super-agent capabilities

| Capability | Today's problem | Still needed? | New home / replacement | Action |
|---|---|---|---|---|
| Workspace registry and list | Static list injected in the prompt | Yes | Keep the registry; static prompt; `workspace_sessions` for status | Keep, change |
| Session create, reuse, archive | Super-agent session tools | Yes | Session service; `workspace_sessions`; no memory copy | Move |
| Dispatch | Claim/dispatch tools plus JIRA claim | Yes | `workspace_message`/`workspace_sessions` send requests directly; `workspace_tasks` when a formal record is needed; JIRA claim and dispatch retired | Move |
| Intent capture and alignment | A request is re-expressed per task and can drift | Yes | `workspace_intents` as a workspace record, plus `workspace_tasks` coverage and receipt checks | Add |
| Dispatch records and receipts | Dispatch history and the manual ledger | Yes | `workspace_tasks` tasks and receipts; starts fresh, no migration | Move |
| Delivery | Super-agent delivery tool plus the turn-end path | Yes | `workspace_message`; no turn-end fallback | Move |
| Report presentation | Report files and delivery | Yes | `workspace_artifacts` references plus `workspace_message`; the UI renders | Move |
| Permission switch | Permission-switch tool | Yes | Permission-preset service | Move |
| Long-task monitoring | Session status and JIRA status | Yes | `workspace_sessions` status and progress plus the write lease | Move |
| Cross-workspace collaboration | Dispatch, with memory copies | Yes | `workspace_tasks`, `workspace_message`, `workspace_artifacts`, and `workspace_intents` with explicit scope; never memory | Move |

Current state after Step 4: `workspace_intents`, task creation, the coverage check, the receipt gate, `workspace_message.send`, artifact publish/reference, and the static workspace directory are implemented; JIRA, its tools, and its turn-end delivery no longer exist. Task creation, intent-card writes, and Session lifecycle writes are open to agents in the workspace; a cross-workspace write is still limited to the super agent (implemented). This table records the target ownership, and the implemented rows are the ones this tree ships.

## 13. Appendix: future direction

A board view is a plausible later UI. Its data comes from the workspace toolset: `workspace_sessions`, `workspace_tasks`, `workspace_message`, and `workspace_artifacts`; `workspace_intents` supplies dispatch context, and memory contributes only global facts. A memory card stream, a per-workspace memory index, and an event-log store are explicitly out of scope; if the board needs one later, it is a new design over the same toolset, not a change to memory. Intent cards are workspace records, not memory.

## 14. Deployment acceptance for Steps 3 and 4

Nothing in this section has been checked on a deployed Windows host. It is the checklist for the person who syncs this branch, deploys it tomorrow, and continues the work there. **CI** means the branch's automated suite already covers the item; **Deploy** means a real process, a real Session, or the running GUI is required, or the item must run against the real `$DSH_HOME` and real workspaces, and the suite cannot prove it. Do not tick a **Deploy** item from the test suite alone, and do not report Steps 3–4 as deployed-accepted before they are ticked.

The automated half is `pnpm exec vitest run packages/uitstalie/memory packages/uitstalie/workspace-tools`.

### 14.1 Ordinary session: no per-turn memory injection

- [ ] A fresh ordinary workspace Session, after at least three turns with at least one `memory_write`, has zero `user/message` events whose `source.kind` is `memory` in its durable log, and zero memory bytes. CI: the injection test (`neither a legacy workspace file nor the global file is injected per turn`, `packages/uitstalie/memory/tests/provider.spec.ts`) asserts no memory message after one write and one completed turn; the multi-turn count is a deploy check. Deploy: read the real Session's log or surface and count.
- [ ] The assembled system prompt has no section named `memory-state`. CI: the same spec asserts the assembled prompt. Deploy: inspect the prompt in the running host.
- [ ] A resumed Session over an existing `MEMORY.md` receives no snapshot. CI: no dedicated resume test; the snapshot code and its startup hook are removed, and the injection test asserts no memory message on a fresh Session. Deploy: open a Session in a workspace whose `MEMORY.md` already holds entries.
- [ ] No "Memory updated" message appears after a write, and no "Memory snapshot" message appears after a completed turn. CI: the injection test asserts a completed turn and a write leave zero memory messages; the literal strings are removed with the snapshot module. Deploy: perform one write and one completed turn in the GUI.

The per-turn summary job is removed, so no summary-failure notice is appended anymore. If a `form: 'notice'` memory message still appears, it is a stale code path and must be treated as an injection regression.

### 14.2 Delivery only through the tool

- [ ] A turn that calls no send delivers nothing: no message record and no prompt into another Session. CI: `a turn with no send delivers nothing` (`packages/uitstalie/workspace-tools/tests/delivery.spec.ts`). Deploy: run a turn in Session A, then confirm Session B's inbox is unchanged and no `messages/*.json` was written.
- [ ] A message and an artifact reference round-trip. CI: `a message round-trips with its artifact reference`. Deploy: send from the super agent to a workspace Session and read it back.
- [ ] A retried send with the same `requestId` returns the first message and appends nothing. CI: `a repeated requestId returns the first message without a second delivery`. Deploy: repeat the call and compare ids.
- [ ] `workspace_sessions` answers "what did I do last turn". CI: `"what did I do last turn" is answered by workspace_sessions`. Deploy: ask after a real turn and confirm the answer is the Session's own progress, not a memory notice.
- [ ] A cross-workspace send is allowed only through a task binding: an unbound send (ordinary agent or super agent) is refused, and a bound send succeeds with a recorded call. CI: `a cross-workspace send is allowed only as a task-bound return`. Deploy: attempt both.
- [ ] Publishing a path outside the workspace root is refused. CI: `publish refuses a path outside the workspace root and a missing file`. Deploy: repeat with a relative `..` path.
- [ ] The static `workspace-directory` prompt section lists the registered workspaces and contains no status, task, or memory data. CI: `every session gets the same static workspace directory section`. Deploy: compare two Sessions and the super agent's prompt.

### 14.3 Verified: task-bound cross-workspace return

- [ ] The executor returns to the starting Session with `workspace_message.send` carrying `taskId`; `workspace_tasks.create` records `dispatcherSessionId`, and a cross-workspace send is allowed only through the task binding (`targetSessionId` is the caller, `dispatcherSessionId` is the target). CI: `a cross-workspace send is allowed only as a task-bound return` covers the bound success, the unbound refusal, and the `dispatcherSessionId` read-back; `delivery.spec.ts` also covers the same-workspace return. Deploy: confirm on a real dispatch that the return goes only through `workspace_message.send` and that no turn-end delivery appears.

### 14.4 Step 4: global-only memory and migration

- [ ] The dry-run report names, per file and entry, the class, the proposed topic, the reason, the byte count, and the target path, and it writes no memory data. CI: `the dry run reports files, entries, classes, bytes, and the target without writing data` (`packages/uitstalie/memory/tests/migration.spec.ts`). Deploy: run `migrate-global-memory.ts --workspace <dir> ...` against every registered workspace and confirm that `$DSH_HOME/memory` is unchanged.
- [ ] Apply refuses a report hash that no longer matches a fresh scan and writes nothing on refusal. CI: `apply refuses a report hash from another scan`. Deploy: repeat an apply with the stale hash.
- [ ] Every changed file is backed up before the first write, and a rollback restores the exact bytes; the old `MEMORY.md` parses before apply, after apply, and after rollback. CI: `apply migrates only confirmed global entries, backs up every changed file, and keeps old files parseable`, `rollback restores the exact original bytes and makes the first report reproducible`. Deploy: inspect `$DSH_HOME/memory/migration/runs/<run-id>/`, apply on a copy of one real workspace, then roll back.
- [ ] `$DSH_HOME/memory/GLOBAL.md` contains only confirmed global entries; business, dispatch, persona, and unclassified text is absent and listed as discarded in the report. CI: the same apply spec. Deploy: read the global file after a real apply.
- [ ] The injection surface holds no memory entry: with both a legacy `MEMORY.md` and a populated `GLOBAL.md`, a Session receives no memory-sourced message and no `memory-state` section. CI: `neither a legacy workspace file nor the global file is injected per turn` (`packages/uitstalie/memory/tests/provider.spec.ts`). Deploy: open a Session and inspect its prompt and log.
- [ ] A business write is refused with `NOT_GLOBAL_MEMORY` and a tool hint, and a completed turn writes no memory entry. CI: `a business write is refused with the workspace tool hints`, `a completed turn writes no memory job, no MEMORY.md, and no memory message`. Deploy: call `memory_write` with a business fact, then complete a turn.

The dry run has run on the seven real workspaces; [the dry-run review](memory-migration-dryrun-review-20261118.md) records 23 of 27 global candidates outside the global class and the business-history retrieval gap, so the apply item above stays unchecked.

### 14.5 Not provable in CI

- A real Windows deployment, the GUI, a process restart and resume, the real multi-workspace registry, and the real memory files are outside the suite. The **Deploy** items above are the manual gate; they stay unchecked until a person checks them on the deployed host.
- The migration deliberately does not run in CI against real data. Its reports, backups, and rollback are proven on temporary `$DSH_HOME` and temporary workspaces; the real apply remains a person's confirmed step, not an automated deployment action.
