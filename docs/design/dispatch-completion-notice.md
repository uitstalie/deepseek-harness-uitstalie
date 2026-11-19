# Dispatch completion notices: waking the dispatcher

English | [中文](dispatch-completion-notice.zh.md)

Status: implemented (first version). The implementation is `packages/uitstalie/workspace-tools/src/completion.ts`, mounted by the `workspace-tools` plugin when `completionNotice` is on; tests are in `tests/completion-notice.spec.ts`.

## 1. Background and goals

Without a completion signal, the dispatcher can only sleep or poll inside its turn; a normal message enters next-turn only when the target's turn ends, so an executor that ends its turn without sending a message never wakes the dispatcher. C adds that positive signal for task-bound dispatches.

Goals:

1. When an executor turn ends, deliver one completion notice to the task's dispatcher.
2. The notice enters the dispatcher's next-turn as a normal user message; an idle dispatcher is woken immediately, a running one handles it after its current turn ends.
3. Apply only to task-bound relations; same-workspace message replies and non-task dispatches stay as they are.

Non-goals:

- Not a replacement for a `workspace_message` reply, and not a synchronous wait (separate proposal).
- Does not change the task state machine; task state still changes only through `workspace_tasks`.
- Does not broadcast to non-bound Sessions, the subagent tree, or users.

## 2. Trigger points

| Trigger | Semantics | Advantage | Cost |
|---|---|---|---|
| Executor `turn/end` | One notice per finished turn | Covers "ended without a message" | A multi-turn task notifies more than once |
| `workspace_message.send` admitted | A reply message already exists | No extra noise | Nothing when the executor sends no message |
| `workspace_tasks.receipt` | Formal completion receipt | Most precise semantics | Depends on the executor writing a receipt |

Prefer `turn/end` as the main trigger and dedupe on "this turn already delivered a message with `taskId`"; use `receipt` only for the status summary in the notice body. The task record already carries `targetSessionId`/`dispatcherSessionId`; a cross-workspace relation also exists in the dispatch relation (`dispatch.ts`), and either locates the dispatcher.

## 3. Delivery form and turn boundary

The notice is delivered with `agent.followup`, the same mechanism as subagent settlement and scheduled reminders: a user message marked `workspace-task-settled` enters the dispatcher's next-turn; an idle dispatcher is woken immediately, a running one opens a new turn after its current turn ends; it never steers or interrupts the current step. If `source.kind` is a closed union, the first version reuses `user` with a first-line marker, and a new kind goes through Session-format review.

| Field | Content |
|---|---|
| taskId | Task id |
| executorSessionId / turn | Executor Session and the finished turn |
| status | Turn stop reason and current task state |
| reportRef | Newest receipt or message id from that turn |
| summary | One-line result summary; the body stays in `workspace_message.read` / `workspace_tasks.get` |

## 4. Idempotency and anti-self-excitation

- The dedupe key is `(taskId, executorSessionId, turn)`; one notice per turn.
- When the turn already delivered a `workspace_message` with `taskId`, the notice is a no-op and the message stands.
- A dispatcher turn opened by a notice does not trigger another notice for the same task, preventing a wake → re-dispatch → wake chain.
- Only task-bound relations qualify: the task exists and its `targetSessionId`/`dispatcherSessionId` match both sides.
- After the task reaches `done`/`cancelled`, no further notices; add a per-task inbound limit and an expiry.

## 5. Relation to existing notification mechanisms

| Mechanism | Current behavior | Relation to this design |
|---|---|---|
| `workspace_message` normal message | next-turn; wakes an idle Session | Main return path; the notice does not replace it |
| `urgent` steer | Inserts into next-step; may interrupt | Only the three urgent cases; not for completion |
| scheduled reminder | `agent.followup` wakes the Session | Same mechanism; reuse delivery and dedupe lessons |
| subagent settlement | Child settlement notice + followup | Same pattern; reuse notice structure and source metadata |
| `wait_agent` | Blocks for next-step input | Cannot receive workspace next-turn messages; does not replace C |

## 6. Switch, rollback, and failure degradation

- Switch: config `completionNotice: 'off' | 'task-bound'`; the first version defaults to `off` and is configured on the `workspace-tools` row, flipped to `task-bound` after a staged rollout; `noticeMaxPerTask` (default 32) and `noticeTtlMs` (default one day) bound one task's notices.
- Rollback: turning the switch off restores the old behavior; the notice is a normal user message, so no Session-format change is needed.
- Failure degradation: when the host controller is missing or declines, record the failure and reason without failing the executor turn; do not retry without bound, and the dispatcher can still self-check with `workspace_tasks get`.
- Compatibility: historical dispatches with no bound task produce no notice; an older version reads the notice as ordinary user text.

## 7. Test plan

- Integration point: executor `turn/end` → task/relation lookup → notice build → `agent.followup`.
- Assertion: an idle dispatcher opens a new turn and receives the notice; a running dispatcher handles it after its turn ends.
- Assertion: several messages in one turn produce one notice; an already-delivered reply makes it a no-op; a non-bound dispatch delivers nothing.
- Assertion: a notice turn triggers no further notice; `done`/`cancelled` stops delivery; failure does not fail the executor turn.
- Assertion: `urgent` still steers; scheduled/subagent notice paths are unaffected.

## 8. Non-goals and open questions

- No synchronous wait or blocking dispatch (B/D are separate).
- Open: the first-version default switch; whether the notice carries the report body; how to merge concurrent executors for one task.
