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
| `workspace_sessions` | `list`, `get`, `run`, `start`, `append`, `prompt`, `stop`, `abort`, `fork`, `archive`, `compact`, `delete` | Session summaries with status, current turn, current activity, latest progress, and task id; `get` adds recent progress, the queued inbox count, artifact count, roster creator and archiver stamps, and `contextUsage` on a live Session, which is the projected occupancy of the next request divided by the routed window. `run` delivers one text to a named Session, or to the latest one when `sessionId` is omitted, and only opens a Session when the workspace has none; `new_session: true` and `start` force a fresh Session. `stop`, `abort`, `fork`, `archive`, and `compact` control the Session; `delete` refuses while the host exposes no Session delete API |
| `workspace_tasks` | `list`, `get`, `create`, `update`, `receipt` | Task summaries filtered by status and assignee; `get` returns the task, its receipts, its target session, and its artifact references; `create` needs only `workspace` and `goal` — `acceptance`, `boundaries`, and `taskType` default, and naming `intentId` with `intentVersion` is what turns on the card gates; `update` moves the state machine; `receipt` appends the alignment checklist |
| `workspace_message` | `send`, `read`, `status`, `retry` | `send` delivers a message or follow-up with artifact citations and returns its id, status, and delivery receipt; a repeated `requestId` returns the first result. `read` returns one message by id, or a page filtered by target session; `status` reports delivery state, failure reason, and attempts; `retry` re-delivers one `failed` message under its original identity |
| `workspace_artifacts` | `publish`, `reference`, `request`, `requests`, `grant`, `list`, `resolve` | `publish` hashes one file inside the workspace root and records an immutable reference; re-publishing unchanged content returns the recorded version. `reference` attaches a published reference to a message or task. `request` resolves one recorded version in the caller's workspace and answers `pending` across workspaces until the holder decides; `requests` lists the pending cross-workspace requests the workspace holds, and `grant` records the holder's version-scoped grant or denial with an expiry. `list` returns the latest reference per artifact; `resolve` compares one recorded version with the file and answers `ok`, `changed`, `missing`, or `denied` |
| `workspace_intents` | `create`, `get`, `confirm`, `correct`, `history`, `metrics` | One card version with source-annotated goal, acceptance, boundary, and output-form items; `confirm` and `correct` append state; `history` pages versions; `metrics` summarizes dispatch alignment |

`list` actions page with an opaque cursor and a default page of 20 items, capped at 100. Summaries bound their text; raw turns stay behind `session_event_read`, and file content stays behind `read`.

`start`, and `run` when it opens a new Session, seed that Session's log with the dispatcher's permission policy as `source: 'delegation'` events: its `auto` or `danger-full-access` preset, its effective sandbox mode, and a pinned `never` approval policy (a dispatched Session asks the user nothing directly; the dispatcher relays questions). A composition without the preset, sandbox-policy, or approval service dispatches without the corresponding event.

Task-bound completion notices are a separate, notification-only path. With `completionNotice: task-bound` (default `off`), a turn that ends in a Session named as a task's `targetSessionId` sends the task's `dispatcherSessionId` one queued user message whose first line starts with `[workspace-task-settled]`; an idle dispatcher is woken for a new turn and a running one handles it after its current turn. A turn that already sent a task-bound message is not announced, and a turn opened by a notice produces none, so the notice cannot chain. `done` and `cancelled` tasks stop notifying; one task gets at most `noticeMaxPerTask` notices (default 32) inside `noticeTtlMs` (default one day). A delivery failure, a missing controller, or an archived dispatcher is logged and never fails the executor turn. Configure it on the `workspace-tools` row with `completionNotice: task-bound`.

Delivery is an explicit tool call. `workspace_message.send` validates the target session, the cited artifact versions, and the caller's scope, then hands the bounded text (600 characters) to the host Session controller. A turn that calls no send delivers no message; the only turn-end delivery is the task-bound completion notice above. A same-workspace send is always allowed. A cross-workspace send is authorized in three ways: a task binding in the caller's workspace (`targetSessionId` the caller, `dispatcherSessionId` the target); the super agent opening a delivery; or a reply to a Session that already delivered into the caller's workspace. Every cross-workspace delivery is recorded in the receiving workspace as a dispatch relation, so the receiver replies by `targetSessionId` alone, with no task and no reload needed. `priority: "urgent"` needs one of the three validated `urgentReason` cases (a wrong conclusion being acted on, a stop order, or a user instruction change) and steers the target's current step, falling back to the queue when the target is idle.

An artifact reference is immutable at publish time: `{ artifactId, workspaceId, path, sha256, size, version, kind, sessionId, taskId?, createdAt }`. The artifact id is stable per `workspace|path|kind`, and publishing a changed file appends a version. A message or task stores the cited `artifactId`, `version`, and `sha256`; later file changes do not rewrite the citation, and `resolve` reports `changed` or `missing` instead of silently following the new content.

`workspace_tasks.create` requires `workspace` and `goal`; `acceptance`, `boundaries`, and a six-category `taskType` default to empty lists and `other`. A card is optional: naming an `intentId` with its `intentVersion` applies the card gates — a missing field or card refuses with `INTENT_INCOMPLETE`, a proposed version with `INTENT_UNCONFIRMED`, a superseded or non-current version with `INTENT_STALE`, a card from another workspace with `INTENT_SCOPE_MISMATCH`, and an uncovered card point with `INTENT_COVERAGE_MISSING`. There is no default coverage pass: every card point needs a coverage entry or an explicit `nonCoverage` reason. `receipt` appends one alignment entry per card point with evidence; a `not_satisfied` acceptance point or a `violated` boundary moves the task to `waiting_review` or `blocked`, never `done`.

## Write lease

One checkout has one writer. The plugin wraps `tools/execute`: the first write-class call of a Session acquires the workspace write lease before dispatch, every later write-class call renews it, and a Session that already holds it is not reacquired per call. Read-class and exempt calls never acquire, and an unknown tool is a write. The record lives at `$DSH_HOME/workspaces/<key>/lease.json`, where the key is the registered workspace id or a hash of the canonical checkout, and each acquisition, refusal, reclaim, release, and loss appends one JSON line to `$DSH_HOME/logs/workspace-lease.jsonl`.

- A conflicting write is refused with `WORKSPACE_LEASE_HELD` and the holder's Session id, acquisition time, last operation, and both expiries. A writer whose lease another Session reclaimed is refused with `WORKSPACE_LEASE_LOST` while that holder is active; once the record is gone, the lease is expired, or the process is dead, the fenced writer reclaims it (generation `mine + 1` when no record remains, otherwise the record's generation `+ 1`) and proceeds. An active holder is never stolen, and observe mode never refuses: it reclaims the same stale record, or proceeds without one while an active holder remains.
- A lease expires after ten idle minutes or eight hours of total life, whichever comes first. The next writer reclaims an expired record and bumps its fencing generation.
- `read`, `glob`, `grep`, session and memory reads, and the question, todo, present, skill, and subagent-inspection tools are `read`. `workspace_*` records, memory writes, subagent and workflow control, schedules, and `workspace_sessions` lifecycle actions are `exempt`. Everything else, including shell and `tool-dsh-store`, is `write`.
- Configuration: `mode` (`enforce` by default; `observe` audits the conflict without refusing it), `idleMs`, and `maxMs`.


## Scope

The calling session's workspace is the registry account that lists the session, or the registered workspace whose canonical path equals the session's canonical cwd. A call may address another workspace only by its registered id, and that read is written to the host log. A directory path, an unregistered id, and a subdirectory of a registered workspace all take the same refusal: register the directory as a workspace first. A session whose id is not on the resolved workspace's account is not found there, so a cross-workspace question cannot be answered implicitly. `workspace_message.send` may address another workspace by its registered id, or by the target Session's own registration: the super agent may open a cross-workspace delivery, a task binding may authorize a return, and any Session may reply to one that already delivered into the caller's workspace. Every cross-workspace delivery is recorded in the receiving workspace.

`workspace_intents` follows the same scope. One card belongs to exactly one workspace; a cross-workspace request creates one card in each target workspace, and each card keeps the user's original words verbatim. Reading a card from another workspace requires the explicit id and is recorded. A task that references another workspace's card is refused with `INTENT_SCOPE_MISMATCH`.

`create`, `confirm`, and `correct` on an intent card are open to any agent in the workspace until a card UI exists; a cross-workspace write requires the super agent. Task creation and every task state change are open to agents in the workspace; the session named as a task's target may update that task and append its own receipt. Every `requestId` is optional: the tool generates one when omitted, and an explicit key makes a retry idempotent.


## Storage

Records live under `$DSH_HOME/workspaces/<workspace-id>/`: `tasks/<taskId>.json`, `messages/<messageId>.json`, `dispatches/<sourceSessionId>~<targetSessionId>.json` for the reply relations, `artifacts/<artifactId>.json`, `grants/<artifactId>-v<version>.json`, `requests/<requestId>.json`, `sessions/<sessionId>.json` for the roster, and `intents/<intentId>/` with `index.json` plus `versions/<n>.json`. Each file is validated on read, because a durable record is an untrusted boundary; a record that does not match its schema fails with `WORKSPACE_RECORD_CORRUPT` instead of being skipped. An artifact record holds every published version, and `resolve` checks the selected version's recorded SHA-256 against the file inside the workspace root.

A card index holds the current state of each version, the latest active version, per-item confirmation times, and the version list; each version file holds the immutable card content and is never rewritten. A correction appends a version and leaves the superseded one readable; confirmation changes only the index. A proposed version carries one consolidated confirmation request with a stable id. An intent id is derived from the workspace and its idempotency key, so a retried create returns the version it already wrote.


## Model Experience

### The workspace toolset

#### What the model sees

Every agent in a workspace sees the five tools as fixed schemas and one static system-prompt section named `workspace-directory` (order 700), which lists the registered workspaces as `- <title> (<id>) · <directory>`. The list is the same for every session and carries no status, task, or memory data, so the prompt prefix stays stable. Results are bounded summaries: a page holds at most 100 items, activity and progress are one-line strings, and neither file content nor a transcript is returned. `workspace_sessions` with `action: 'get'` is the answer to "what did I do last turn": it returns the session's recent progress and current activity from its own log, so the model queries the session store instead of relying on a memory notice. `workspace_message.send` and `workspace_artifacts.publish` are the only delivery paths: a message carries citations, and a published reference is attached to a message or task without copying the file. `workspace_intents.get` returns the card version with one stable point id per item, so `create` and `receipt` can name a point without repeating its text. A proposed version returns its confirmation request; a task cannot be dispatched until the version is active. `workspace_tasks.get` returns the alignment checklist recorded on each receipt, so drift appears as a list.

#### Token effect

Fixed schema cost on every request where the agent sees the tools, plus the bounded result of each call and the static `workspace-directory` section (one line per registered workspace). The five schemas carry the action enums, filters, card items, coverage, and alignment, which is the largest fixed part of the contribution.

#### KV Cache effect

Prefix-stable while the tool definitions and their visibility are unchanged. Every result is an ordinary tool result appended after the reusable prefix, so a call invalidates no earlier entry.


## Known Limitations and Deferred Work

- **No card UI in this step** — `confirm` and `correct` are model-facing; any agent in the workspace drives them, and a user decision reaches the store through the super agent. Without a card UI, a proposed version is still activated by an agent, not by a person.
- **`delete` needs a host API** — `workspace_sessions.delete` refuses while the host `SessionController` exposes no delete method; `archive` is the only hide path today, and the Session log stays on disk.
- **Pending artifact requests are pull-only** — a cross-workspace `request` queues one pending entry per requester Session and version under `<workspace>/requests`; nothing pushes a notice, so the holder has to read `workspace_artifacts.requests` to see who is waiting.
- **No write-lease queue or holder badge** — a refused Session is not queued behind the holder, and the Session list shows no write badge.
- **A subagent acquires its own lease** — a dispatched child does not inherit its parent Session's lease, so it can be refused while the parent holds the checkout.
- **Every shell call is a write** — the design's shell read whitelist is not implemented; `pwsh` and any terminal tool always acquire.
- **Status is derived, not stored** — `running` comes from the live agent, `done` from the registry archive set, `blocked` from the last `turn/end` reason, and every other session reports `idle`.
- **A workspace's session scan reads every accounted log** — `workspace_sessions` folds status from each session in the account before paging, so a workspace with many sessions pays for each log read on every list call.


### Dev Note

- `src/api.ts` registers the capability; `src/tools.ts` fixes the registration order.
- `src/scope.ts` owns workspace resolution and the cross-workspace record; `src/delivery.ts` owns the Session-controller seam for `workspace_message.send`; `src/prompt.ts` renders the static workspace directory; `src/store.ts` owns the task, message, and artifact directories and their read validation; `src/intent-store.ts` owns the append-only intent card; `src/intent-rules.ts` owns source rules, point ids, coverage, and alignment; `src/paging.ts` owns the cursor.
- `tests/workspace-tools.spec.ts`, `tests/intents.spec.ts`, and `tests/delivery.spec.ts` run through the real agent loop, organizer, store, session-query, and filesystem, with an in-memory workspace registry. The delivery spec substitutes only the host Session controller, which records the admitted prompt.
