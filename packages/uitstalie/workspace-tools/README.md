---
description: "The workspace information toolset: workspace_sessions, workspace_intents, workspace_tasks, workspace_message, and workspace_artifacts scoped to one registered workspace, with the durable task, intent-card, message, and artifact state they aggregate."
kind: "package-reference"
---

# @deepseek-ai/dsh-workspace-tools

English | [中文](README.zh.md)

## Summary

`dsh-workspace-tools` provides the workspace information toolset. It registers one capability with the `dafeiyu` organizer, which wires the tools onto every agent, so an ordinary workspace session and the super agent share one contract. The toolset owns no fact that another store owns: sessions come from `ctx.sessionQuery`, workspaces and their session accounts from `ctx.workspaceRegistry`, and artifact content from the workspace directory. It stores only dispatch tasks and their receipts, intent cards and their versions, messages, and artifact references under `$DSH_HOME/workspaces/<workspace-id>/`.

## Table of Contents

- [Use this package](#use-this-package)
- [Tools](#tools)
- [Scope](#scope)
- [Storage](#storage)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)


## Use this package

Mount the row after the organizer, store, session-query, filesystem, and workspace-registry rows:

```yaml
- id: workspace-tools
  name: '@deepseek-ai/dsh-workspace-tools'
```

The provider injects `dafeiyu`, `dshStore`, `sessionQuery`, `workspaceRegistry`, and `fs`; a profile without the workspace registry refuses the load.


## Tools

Every tool is registered at `minRole: 'subagent'`; the caller's workspace is the default scope. Reads are open to every agent; mutations check the caller's role inside the tool.

| Tool | Actions | Result |
|---|---|---|
| `workspace_sessions` | `list`, `get`, `start`, `append`, `prompt`, `stop`, `abort`, `fork`, `archive`, `compact`, `delete` | Session summaries with status, current turn, current activity, latest progress, and task id; `get` adds recent progress, pending inbox, and artifact count. Lifecycle actions require the super agent; `start` dispatches from an intent card or an existing task, binds the task to the new Session, and the executor's turn end reports back automatically |
| `workspace_tasks` | `list`, `get`, `create`, `update`, `receipt` | Task summaries filtered by status and assignee; `get` returns the task, its receipts, its target session, and its artifact references; `create` requires an active intent card and a coverage map; `update` moves the state machine; `receipt` appends the alignment checklist |
| `workspace_message` | `send`, `read` | `send` delivers a message or follow-up with artifact citations and returns its id, status, and delivery receipt; a repeated `requestId` returns the first result. `read` returns one message by id, or a page filtered by target session |
| `workspace_artifacts` | `publish`, `reference`, `list`, `resolve` | `publish` hashes one file inside the workspace root and records an immutable reference; re-publishing unchanged content returns the recorded version. `reference` attaches a published reference to a message or task. `list` returns the latest reference per artifact; `resolve` compares one recorded version with the file and answers `ok`, `changed`, `missing`, or `denied` |
| `workspace_intents` | `create`, `get`, `confirm`, `correct`, `history`, `metrics` | One card version with source-annotated goal, acceptance, boundary, and output-form items; `confirm` and `correct` append state; `history` pages versions; `metrics` summarizes dispatch alignment |

`list` actions page with an opaque cursor and a default page of 20 items, capped at 100. Summaries bound their text; raw turns stay behind `session_event_read`, and file content stays behind `read`.

Delivery is an explicit tool call. `workspace_message.send` validates the target session, the cited artifact versions, and the caller's scope, then hands the bounded text (600 characters) to the host Session controller. A cross-workspace send requires the super agent and the target workspace id; an ordinary agent may message only sessions of its own workspace.

The one automatic delivery is the task-bound completion report. When a dispatched Session finishes a turn, the toolset reads the task whose `targetSessionId` is that Session, sends one `[task-report]` to the task's `dispatcherSessionId` (task id, executor session, state, conclusion, and evidence pointers), and appends an automatic receipt that moves the task from `pending`/`in_progress` to `waiting_review` or `blocked`. The executor cannot use `workspace_message.send` for that cross-workspace address; the exception exists only in the trusted turn hook for the recorded binding. A repeated `turn/end` reuses the message request id and the receipt request id, so replay adds neither a second message nor a second receipt. `priority: "urgent"` needs one of the three validated `urgentReason` cases (a wrong conclusion being acted on, a stop order, or a user instruction change) and steers the target's current step, falling back to the queue when the target is idle.

An artifact reference is immutable at publish time: `{ artifactId, workspaceId, path, sha256, size, version, kind, sessionId, taskId?, createdAt }`. The artifact id is stable per `workspace|path|kind`, and publishing a changed file appends a version. A message or task stores the cited `artifactId`, `version`, and `sha256`; later file changes do not rewrite the citation, and `resolve` reports `changed` or `missing` instead of silently following the new content.

`workspace_tasks.create` requires `intentId`, `intentVersion`, `workspace`, `acceptance`, `boundaries`, and a six-category `taskType`. A missing field or card refuses with `INTENT_INCOMPLETE`, a proposed version with `INTENT_UNCONFIRMED`, a superseded or non-current version with `INTENT_STALE`, a card from another workspace with `INTENT_SCOPE_MISMATCH`, and an uncovered card point with `INTENT_COVERAGE_MISSING`. There is no default coverage pass: every card point needs a coverage entry or an explicit `nonCoverage` reason. `receipt` appends one alignment entry per card point with evidence; a `not_satisfied` acceptance point or a `violated` boundary moves the task to `waiting_review` or `blocked`, never `done`.


## Scope

The calling session's workspace is the registry account that lists the session, or the registered workspace whose canonical path equals the session's canonical cwd. A call may address another workspace only by its registered id, and that read is written to the host log. A directory path, an unregistered id, and a subdirectory of a registered workspace all take the same refusal: register the directory as a workspace first. A session whose id is not on the resolved workspace's account is not found there, so a cross-workspace question cannot be answered implicitly. `workspace_message.send` may address another workspace only through the super agent: an ordinary agent's cross-workspace send is refused, while the super agent names the target workspace id and the call is recorded.

`workspace_intents` follows the same scope. One card belongs to exactly one workspace; a cross-workspace request creates one card in each target workspace, and each card keeps the user's original words verbatim. Reading a card from another workspace requires the explicit id and is recorded. A task that references another workspace's card is refused with `INTENT_SCOPE_MISMATCH`.

`create`, `confirm`, and `correct` on an intent card require the super agent role or the user; ordinary agents read cards only. A user decision reaches the store through the super agent until a card UI exists. Task creation, task state changes, and dispatcher-recorded assignment require the super agent; the session named as a task's target may update that task and append its own receipt. Every mutation carries a request id, so a retry cannot duplicate a card version, a task, or a receipt.


## Storage

Records live under `$DSH_HOME/workspaces/<workspace-id>/`: `tasks/<taskId>.json`, `messages/<messageId>.json`, `artifacts/<artifactId>.json`, and `intents/<intentId>/` with `index.json` plus `versions/<n>.json`. Each file is validated on read, because a durable record is an untrusted boundary; a record that does not match its schema fails with `WORKSPACE_RECORD_CORRUPT` instead of being skipped. An artifact record holds every published version, and `resolve` checks the selected version's recorded SHA-256 against the file inside the workspace root.

A card index holds the current state of each version, the latest active version, per-item confirmation times, and the version list; each version file holds the immutable card content and is never rewritten. A correction appends a version and leaves the superseded one readable; confirmation changes only the index. A proposed version carries one consolidated confirmation request with a stable id. An intent id is derived from the workspace and its idempotency key, so a retried create returns the version it already wrote.


## Model Experience

### The workspace toolset

#### What the model sees

Every agent in a workspace sees the five tools as fixed schemas and one static system-prompt section named `workspace-directory` (order 700), which lists the registered workspaces as `- <title> (<id>) · <directory>`. The super agent also receives `workspace-dispatch` (order 702), which states the dispatch order, the card version rule, and the completion-report path; an ordinary agent never sees it. The list is the same for every session and carries no status, task, or memory data, so the prompt prefix stays stable. Results are bounded summaries: a page holds at most 100 items, activity and progress are one-line strings, and neither file content nor a transcript is returned. `workspace_sessions` with `action: 'get'` is the answer to "what did I do last turn": it returns the session's recent progress and current activity from its own log, so the model queries the session store instead of relying on a memory notice. `workspace_message.send` and `workspace_artifacts.publish` are the only delivery paths: a message carries citations, and a published reference is attached to a message or task without copying the file. `workspace_intents.get` returns the card version with one stable point id per item, so `create` and `receipt` can name a point without repeating its text. A proposed version returns its confirmation request; a task cannot be dispatched until the version is active. `workspace_tasks.get` returns the alignment checklist recorded on each receipt, so drift appears as a list. A dispatched Session's turn end delivers the `[task-report]` to its dispatcher as a new user message, so the dispatcher reads the outcome without polling; the automatic receipt records whether the delivery succeeded.

#### Token effect

Fixed schema cost on every request where the agent sees the tools, plus the bounded result of each call, the static `workspace-directory` section (one line per registered workspace), and the `workspace-dispatch` section for the super agent. The five schemas carry the action enums, filters, card items, coverage, and alignment, which is the largest fixed part of the contribution.

#### KV Cache effect

Prefix-stable while the tool definitions and their visibility are unchanged. Every result is an ordinary tool result appended after the reusable prefix, so a call invalidates no earlier entry.


## Known Limitations and Deferred Work

- **No card UI in this step** — `confirm` and `correct` are model-facing and require the super agent, which records a user decision the conversation delivered. Without a super agent or a card UI, a proposed version cannot be activated.
- **No grant model yet** — a same-workspace `read` is allowed after `publish`, and `resolve` answers `ok` for a matching same-workspace reference and `denied` for a path outside the workspace root; artifact `request`/`grant` and the `pending`/`expired` statuses remain later milestones of the same design, so a cross-workspace read needs the explicit holder grant that path will add.
- **Status is derived, not stored** — `running` comes from the live agent, `done` from the registry archive set, `blocked` from the last `turn/end` reason, and every other session reports `idle`.
- **A workspace's session scan reads every accounted log** — `workspace_sessions` folds status from each session in the account before paging, so a workspace with many sessions pays for each log read on every list call.


### Dev Note

- `src/api.ts` registers the capability; `src/tools.ts` fixes the registration order.
- `src/scope.ts` owns workspace resolution and the cross-workspace record; `src/delivery.ts` owns the Session-controller seam for `workspace_message.send`; `src/prompt.ts` renders the static workspace directory; `src/store.ts` owns the task, message, and artifact directories and their read validation; `src/intent-store.ts` owns the append-only intent card; `src/intent-rules.ts` owns source rules, point ids, coverage, and alignment; `src/paging.ts` owns the cursor.
- `tests/workspace-tools.spec.ts`, `tests/intents.spec.ts`, and `tests/delivery.spec.ts` run through the real agent loop, organizer, store, session-query, and filesystem, with an in-memory workspace registry. The delivery spec substitutes only the host Session controller, which records the admitted prompt.
