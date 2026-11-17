---
description: "The workspace information toolset: workspace_sessions, workspace_tasks, workspace_message, and workspace_artifacts reads scoped to one registered workspace, with the durable task, message, and artifact state they aggregate."
kind: "package-reference"
---

# @deepseek-ai/dsh-workspace-tools

English | [中文](README.zh.md)

## Summary

`dsh-workspace-tools` provides the workspace information toolset. It registers one capability with the `dafeiyu` organizer, which wires the tools onto every agent, so an ordinary workspace session and the super agent share one read contract. The toolset owns no fact that another store owns: sessions come from `ctx.sessionQuery`, workspaces and their session accounts from `ctx.workspaceRegistry`, and artifact content from the workspace directory. It stores only dispatch tasks, messages, and artifact references under `$DSH_HOME/workspaces/<workspace-id>/`.

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

Every tool is registered at `minRole: 'subagent'`; the caller's workspace is the default scope.

| Tool | Actions | Result |
|---|---|---|
| `workspace_sessions` | `list`, `get` | Session summaries with status, current turn, current activity, latest progress, and task id; `get` adds recent progress, pending inbox, and artifact count |
| `workspace_tasks` | `list`, `get` | Task summaries filtered by status and assignee; `get` returns the task, its receipts, its target session, and its artifact references |
| `workspace_message` | `read` | One message by id, or a page of messages filtered by target session, with delivery receipts and artifact citations |
| `workspace_artifacts` | `list`, `resolve` | Latest published reference per artifact, filtered by session, task, kind, or path prefix; `resolve` compares one recorded version with the file and answers `ok`, `changed`, `missing`, or `denied` |

`list` actions page with an opaque cursor and a default page of 20 items, capped at 100. Summaries bound their text; raw turns stay behind `session_event_read`, and file content stays behind `read`.


## Scope

The calling session's workspace is the registry account that lists the session, or the registered workspace whose canonical path equals the session's canonical cwd. A call may address another workspace only by its registered id, and that read is written to the host log. A directory path, an unregistered id, and a subdirectory of a registered workspace all take the same refusal: register the directory as a workspace first. A session whose id is not on the resolved workspace's account is not found there, so a cross-workspace question cannot be answered implicitly.


## Storage

Records live under `$DSH_HOME/workspaces/<workspace-id>/`: `tasks/<taskId>.json`, `messages/<messageId>.json`, and `artifacts/<artifactId>.json`. Each file is validated on read, because a durable record is an untrusted boundary; a record that does not match its schema fails with `WORKSPACE_RECORD_CORRUPT` instead of being skipped. An artifact record holds every published version, and `resolve` checks the selected version's recorded SHA-256 against the file inside the workspace root.


## Model Experience

### The workspace toolset

#### What the model sees

Every agent in a workspace sees the four tools as fixed schemas; there is no per-turn message and no prompt section in this step. Results are bounded summaries: a page holds at most 100 items, activity and progress are one-line strings, and neither file content nor a transcript is returned. `workspace_sessions` with `action: 'get'` is the answer to "what did I do last turn": it returns the session's recent progress and current activity from its own log, so the model queries the session store instead of relying on a memory notice.

#### Token effect

Fixed schema cost on every request where the agent sees the tools, plus the bounded result of each call. The four schemas carry the action enums, filters, and cursor, which is the largest fixed part of the contribution.

#### KV Cache effect

Prefix-stable while the tool definitions and their visibility are unchanged. Every result is an ordinary tool result appended after the reusable prefix, so a call invalidates no earlier entry.


## Known Limitations and Deferred Work

- **Read side only in this step** — `workspace_tasks.create`/`update`/`receipt`, `workspace_intents`, `workspace_message.send`, and artifact `publish`/`reference`/`request`/`grant` arrive in later milestones of the same design. Until then a workspace's task, message, and artifact directories can be read but only the later milestones write them.
- **No grant model yet** — `resolve` answers `ok` for a same-workspace caller and `denied` for a path outside the workspace root; `pending` and `expired` become reachable with the artifact grant path.
- **Status is derived, not stored** — `running` comes from the live agent, `done` from the registry archive set, `blocked` from the last `turn/end` reason, and every other session reports `idle`.
- **A workspace's session scan reads every accounted log** — `workspace_sessions` folds status from each session in the account before paging, so a workspace with many sessions pays for each log read on every list call.


### Dev Note

- `src/api.ts` registers the capability; `src/tools.ts` fixes the registration order.
- `src/scope.ts` owns workspace resolution and the cross-workspace record; `src/store.ts` owns the record directories and their read validation; `src/paging.ts` owns the cursor.
- `tests/workspace-tools.spec.ts` runs through the real agent loop, organizer, store, session-query, and filesystem, with an in-memory workspace registry.