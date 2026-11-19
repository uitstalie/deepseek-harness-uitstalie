# Workspace write lease

English | [中文](workspace-write-lease.zh.md)

Status: implemented — one writer per checkout, `WORKSPACE_LEASE_HELD` and `WORKSPACE_LEASE_LOST`, idle and maximum life, reclaim, fencing, and the audit log ship in the workspace toolset. The optional queue, the UI badge, and subagent lease inheritance are not implemented. Length budget: 10 pages / 4,000 words; this draft is about 2,970 words (about 7 pages).

## 1. Background and the incident

Two dev sessions were writing the same checkout at the same time. The user saw both sessions modify files and run `pwsh` in the same tree; each could overwrite the other's work. The session log records the moment at turn 821: both sessions had a `pwsh` job in flight in the same dev checkout, and the only immediate fix was to stop one session and let the other continue. The same incident produced a recorded decision: abort the second session to stop concurrent writes, and make a workspace write lease the follow-up task.

The root cause is structural, not a model mistake. A workspace is a directory; any number of sessions may open it; nothing in the harness serializes their writes. Git, the build output, `node_modules`, generated files, and deployment scripts all assume one writer. Two writers can lose data without any tool reporting an error.

This document defines a lease that makes the one-writer assumption explicit and enforceable. It does not change the permission model: a session that is allowed to write may still write, but only while it holds the workspace lease.

## 2. Scope, goals, and non-goals

### 2.1 Goals

1. One writer per checkout at a time, enforced at the first write-class tool call, with a clear holder report when the lease is taken.
2. No silent continuation on conflict. The losing session gets a typed failure naming the holder, the acquisition time, and the current operation.
3. Crash-safe cleanup: a lease from a dead session or a restarted host is reclaimed after a bounded time, and a stale holder cannot write after reclaim.
4. Visibility and audit: the current writer is visible in the UI, and every acquisition, release, conflict, expiry, and reclaim is recorded.

### 2.2 Non-goals

- No per-file locking and no merge or conflict resolution inside a file.
- No change to sandbox or permission policy; the lease is orthogonal.
- No protection against processes outside DSH (editors, terminals, CI runners) that write the same checkout.
- No queue by default; queuing is an opt-in mode.
- No cross-workspace atomic transactions; a session writes its own workspace.
- No snapshot isolation for readers; the lease serializes writers, not readers.
- No JIRA compatibility: JIRA is deprecated, treated as out of service, and its ledger is outside the checkout; it is not part of the lease.

## 3. Granularity: one checkout, one lease

The lease is keyed by the canonical project root of the session's workspace: one lease per checkout directory.

Why this is sufficient:

- The conflicts that matter happen at the checkout level: git index and refs, build outputs, generated files, lockfiles, and deployment scripts are shared by every writer of that directory.
- Per-session locking does nothing when the conflict is between sessions; per-file locking cannot cover shell commands, builds, and deployments that touch many files.
- A single resource per checkout is simple enough to reason about, to display, and to audit.

Blind spots, stated explicitly:

- Two different checkouts, worktrees, or clones do not block each other. That is correct for source writes, but they may still contend on a shared package cache or a shared deployment target outside the lease.
- Read-only operations never acquire the lease. Two readers may run while a writer works and may observe a partially written tree; the lease does not provide snapshot isolation.
- A process outside DSH can write the same checkout without asking. The lease is an advisory protocol among DSH sessions, not a filesystem lock on the directory.
- A session that writes outside its own workspace is not covered by this lease; the sandbox and permission policy remain the boundary for that.

## 4. What counts as a write

### 4.1 Classification

Every tool declares a lease class: `write`, `read`, or `exempt`. The default for an unknown tool is `write`, because a missed write is the failure this design exists to prevent.

| Class | Tools and operations |
|---|---|
| `write` | File write, edit, patch, create, delete, move, and copy; `pwsh` and any shell or terminal tool by default; git write commands (`commit`, `add`, `checkout`, `merge`, `rebase`, `reset`, `push`); build commands; deploy commands; package-manager install or update; `tool-dsh-store` create and delete; any tool that creates or changes a file under the checkout |
| `read` | `read`, `glob`, `grep`; session search, event read, trace; memory search and read; `workspace_sessions`, `workspace_tasks` read, `workspace_message` read, `workspace_artifacts` list and resolve; `tool-dsh-store` query |
| `exempt` | Control-plane state that must remain writable while a worker holds the lease: `memory_write` into the memory store, `workspace_tasks` task and receipt writes, `workspace_message` journal writes, lease and audit files. These writes are version-guarded or append-only and are not source changes |

### 4.2 Shell commands

A shell tool can run anything, so the safe default is `write`. The initial read-only allowlist is exactly `git status`, `git diff`, `git log`, `ls`, `pwd`, and `rg`. A command on the list is classified `read` only when it is a single executable with no pipes, redirections, command substitution, or chaining; anything else, including any compound command, acquires the lease. Adding a command to the list requires a review.

The allowlist is a convenience, not a security boundary. A shell command that writes through a tool classified `read` is a classification bug; phase 1 (observe only) is designed to find those before enforcement.

### 4.3 New tools

A new tool must declare `leaseClass`. The build fails if a registered tool has no class, and a startup audit lists unclassified tools as `write` with a warning. This makes the classification exhaustive by construction instead of relying on reviewers to remember every tool.

## 5. Acquisition and conflict behavior

### 5.1 When the lease is taken

The lease is acquired on the session's first `write`-class tool call for its workspace, before the tool executes. It is held for the session, not for one call or one turn, so a multi-turn edit does not reacquire on every step.

The order is: permission and policy checks first (a denied call never takes the lease), then lease acquisition, then tool execution. A `read` or `exempt` call never acquires.

### 5.2 Conflict

If the lease is held by another live session, the call fails with a typed error:

```
WORKSPACE_LEASE_HELD
workspace:  D:\dqc\deepseek-harness-uitstalie-dev
holder:     { sessionId, title, acquiredAt, lastOperation, expiresAt }
```

The error names the holder, when it acquired the lease, what it is doing, and when the lease expires. The losing session does not continue, does not retry silently, and does not write. It reports the conflict to the user or asks what to do. The holder's `sessionId` links to the other session for inspection.

### 5.3 Queue

Queuing is off by default, because two sessions waiting on each other is exactly the failure the lease is meant to prevent.

When enabled, acquisition is FIFO with a timeout and a cancel: the waiter receives a position, can be cancelled by the turn, and on timeout gets `WORKSPACE_LEASE_TIMEOUT` with the holder report. A waiter that times out never proceeds. Queue length is bounded; a full queue rejects immediately rather than growing.

## 6. Release, renewal, expiry, and crash recovery

### 6.1 Normal release

The lease is released when the session is disposed, when the session ends, or when the holder explicitly releases it. A release removes the lease record and appends an audit entry. A crashed release is handled by expiry, below.

### 6.2 Renewal and maximum lifetime

The holder renews the lease on every `write` tool call and with a heartbeat. The lease has two bounds:

- an idle expiry, for example ten minutes without a write or heartbeat, so a forgotten session does not hold the checkout forever;
- a maximum lifetime, for example eight hours, after which the lease expires even if renewed. A long build that exceeds the maximum must reacquire, which is a signal to raise the bound, not to hold indefinitely.

Renewal is cheap: update the `expiresAt` and heartbeat timestamp in the lease record. A running command that blocks the executor does not block the heartbeat timer.

### 6.3 Crash, cancellation, and host restart

The lease record lives outside the checkout, under `$DSH_HOME/workspaces/<hash-of-canonical-root>/lease.json`, with an atomic acquire (create the lock directory, then write the record). It stores the workspace path, the holder session id and title, the acquired and expiry times, the last operation, the host id, the process id, and a fencing generation.

- On host startup, scan the lease directory. A lease whose host and process are gone, or whose expiry has passed, is reclaimed and an audit entry is written.
- A lease whose process is alive but whose session no longer exists is reclaimed after the idle expiry, not immediately, so a slow tool call is not cut off.
- A lease that expires while its holder is still alive is reclaimed; the holder's next write fails with `WORKSPACE_LEASE_LOST` because its fencing generation is stale.

### 6.4 Fencing

Every acquisition and reclaim increments a fencing generation stored in the lease record. The holder keeps the generation it acquired. Before each write, the guard re-reads the lease and compares; a mismatch means the lease was reclaimed, and the write is rejected. This prevents a stale holder from writing after a new holder acquires.

The residual gap is a shell command already running when the lease is reclaimed: it can still write, because the OS process is not stopped. The design bounds this by choosing a maximum lifetime longer than any expected command, logging the reclaim, and warning the new holder; killing the old process is out of scope.

### 6.5 Deadlock freedom

The argument is small enough to check:

- There is one resource per checkout.
- A session acquires at most one lease, for its own workspace; it never waits for a second workspace while holding one.
- Acquisition is non-blocking by default. The optional queue is FIFO with a timeout, so a waiter cannot wait forever.
- A lease is always releasable by the holder, and otherwise expires and is reclaimed.

Therefore the wait-for graph has no cycle: a session either holds the one lease or waits for it with a timeout; no session holds one lease and waits for another. If multi-workspace writes are ever allowed, leases must be acquired in canonical path order and released together on failure; that rule preserves the same acyclic order.

## 7. Visibility and audit

### 7.1 UI visibility

The host exposes a read-only lease status, for example `lease.current({ workspace })`, returning the holder, acquisition time, last operation, and expiry. The session list shows a write badge on the checkout and the current holder's title. The error and the badge use the same holder report, so the model and the user see the same facts.

### 7.2 Audit log

Every event appends one JSON line to `$DSH_HOME/logs/workspace-lease.jsonl`:

```
{ ts, event, workspace, sessionId, title, operation, result, holder?, generation }
```

`event` is `acquired`, `denied`, `released`, `expired`, `reclaimed`, or `lost`. `operation` records the tool name and the target path, not the full command, so credentials in a shell line are not copied into the log. The log rotates daily and is retained for 30 days; a size cap applies before rotation.

The audit log is append-only and is not workspace content, so it never needs the lease. It is also the source for phase 1's conflict report.

## 8. Relationship with existing mechanisms

### 8.1 Subagents and forks

A subagent runs inside its parent's session tree and the same workspace; it inherits the parent's lease instead of acquiring a second one. A fork is a new session with its own identity; it does not inherit the lease. If the parent holds the lease, a forked session's first write is denied with the holder report, which is the intended behavior for a branch that might write.

### 8.2 Scheduled batches

Each scheduled task runs as its own session. If a batch targets the same checkout, the tasks serialize: the first acquires, the others are denied or queue if the batch enables the queue. Read-only tasks in the batch do not acquire and run concurrently. A batch runner that wants throughput should split tasks by checkout.

### 8.3 Read-only analysis

Read-only analysis never acquires the lease. It may run while a writer works; the results may be stale or see a partial tree, and that is acceptable for analysis. If an analysis needs a consistent snapshot, it should wait or ask the writer to release, not take the lease.

### 8.4 Permissions

The lease does not grant or deny permissions. A session without write permission is denied by the existing policy before the lease is considered; a session with write permission still needs the lease. The two failures are distinct: `WORKSPACE_LEASE_HELD` is a conflict, not a permission error, and must not be reported as one.

## 9. Testing

| Test | Pass condition |
|---|---|
| Two sessions, same checkout, both write | One acquires; the other gets `WORKSPACE_LEASE_HELD` with the holder; no file is written by the loser |
| Queue enabled, second waits | Second acquires after the first releases; a timeout returns `WORKSPACE_LEASE_TIMEOUT` and the second never writes |
| Two readers while a writer holds | Both readers succeed; neither acquires |
| Crash of the holder | After the expiry, a new session reclaims; audit has `reclaimed`; the old session's next write gets `WORKSPACE_LEASE_LOST` |
| Host restart | Startup scan reclaims stale leases; a fresh session acquires |
| Subagent write | Inherits the parent's lease; no second acquisition |
| Fork write while parent holds | Denied with the holder report |
| Unclassified tool | Build or startup check fails; the tool is treated as `write` |
| Shell read-only allowlist | `git status` does not acquire; `git commit` does; a piped or redirected command acquires |
| Audit | Every event is one JSON line with the required fields; no full command text |

## 10. Rollout and risks

### 10.1 Phases

| Phase | What | Acceptance | Rollback |
|---|---|---|---|
| 1. Observe | Classify every tool; compute and log would-be conflicts; show a "would be blocked" badge; never block | The incident's pattern appears in the audit log; behavior is unchanged | Turn the feature off; no data to undo |
| 2. Enforce | Block with `WORKSPACE_LEASE_HELD`; default no queue; reclaim and fencing enabled | Two-session test, crash test, and read-only test pass; the audit log is usable | Switch back to observe mode |
| 3. Queue and UI | Optional FIFO queue with timeout; holder badge and status surface | Queue test and UI status pass; no stuck waiter | Disable the queue; enforcement stays |

Phase 1 is the safe way to find classification mistakes before a session is blocked. Phase 2 starts only after two weeks of observation or 20 logged would-be conflicts, whichever comes first. Phase 2 is the actual incident fix. Phase 3 is convenience.

### 10.2 Risks

- **Classification misses**: a write tool or a shell command classified as read. Mitigation: default to `write`, require a class on every tool, and use phase 1 to find the misses.
- **False positives**: a long build blocks another session for hours. Mitigation: the holder report, a documented way to release, and an idle expiry; the maximum lifetime bounds the worst case.
- **Stale lease after reclaim**: an in-flight command can still write. Mitigation: fencing for new calls, a maximum lifetime longer than expected commands, and an audit warning; killing the old process is out of scope.
- **Cross-process races**: two hosts with the same checkout. Mitigation: the lease record lives outside the checkout and acquisition is atomic; a network filesystem without atomic create is out of scope.
- **Audit leakage**: commands may contain secrets. Mitigation: log the tool name and target path, never the full command.
- **User confusion**: a blocked session looks broken. Mitigation: the error names the holder, the UI shows the badge, and the prompt tells the model to report the conflict rather than retry.

## 11. Conflicts with the other two designs

| Point | Other design says | This design says | Precedence |
|---|---|---|---|
| Control-plane writes | `workspace_tasks` and `workspace_message` write their journals under `.dsh` | Those writes are `exempt`; they must stay writable while a worker holds the lease | This document decides lease class; the workspace design owns the tools |
| `workspace_artifacts` publish | Publishes a reference to an existing file | Publish only indexes; creating a new file still needs a `write` tool and the lease | This document decides lease class |
| `superagent_*` control writes | The tool-surface design moves them to `workspace_*` | Their journal writes are `exempt`; their source-changing actions follow the new tool's class | This document decides lease class; the tool-surface design owns the move |
| Read-only analysis | Neither design requires a lease for reads | Reads never acquire | No conflict |
| Tool classification | The other designs assign tool ownership and names | This design assigns each tool's lease class, regardless of owner | This document wins for lease class; the other two win for ownership |

JIRA is deprecated: no compatibility layer is kept, and its ledger is outside the checkout, so it is not a conflict. The remaining rows are decided as shown.

This document does not edit the memory/workspace or tool-surface designs. If a tool moves between owners, its lease class travels with it; the move does not change the locking rule.
