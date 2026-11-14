# Superagent `control` leaks to ordinary agent Sessions (2026-11-14)

English | [中文](superagent-control-role-leak-20261114.zh.md)

Status: **open** — reproduced on a real deployment after restart; documentation only, fix not applied here.

## Observed behavior

After the restart, an ordinary workspace Session running with role `agent` reported `superagent_control` in its model-facing tool list. `superagent_ledger` and `superagent_permission` were absent. This is not a report-derived guess: the list was read from the live Session's tool catalog.

Reproduction:

1. Open a normal (non-super) workspace Session; role must be `agent`.
2. Read the Session's actual tool list (system prompt/tool catalog), not the declared matrix.
3. Observe `superagent_control` present; `superagent_ledger`/`superagent_permission` absent.

## Code location

- `packages/jira/jira-agent/src/superagent.ts:5586-5587` defines the merged tool with `name = CONTROL_TOOL_NAME`; `CONTROL_TOOL_NAME` is `superagent_control` (`:335`).
- The Jira capability's branch is `:5781-5805`:
  - executor Session → `[]` (DH-703);
  - super Session → five tools, including `control`, each wrapped with `withMinRole(tool, 'super')` (`:5789-5795`);
  - ordinary root → `source`, `scan`, `claim`, `control`, `status`, `dispatcher`, with **no `minRole`** (`:5796-5803`).
- `ToolRegistry` only hides a tool when `ToolDefinition.minRole` is present (`packages/core/tools/src/role.ts`); the ordinary branch never declares it, so role filtering cannot remove `control`.

## Conflict with the role model

The comments at `:5781-5785` state the intended split:

- DH-703: an executor Session is a root, so scope alone would hand it dispatcher verbs; it gets none.
- DH-716: the super agent is a root too and dispatches; it keeps the workspace roster and loses ledger-bound verbs that would invite it into the claim loop.

An ordinary workspace root is neither an executor nor a super agent. It should not receive the dispatcher/workspace-management surface. The approved role matrix marks `superagent_control`, `ledger`, `deliver`, and `permission` as `super`; the ordinary branch contradicts that matrix.

`superagent_control` is not a read-only roster tool. Its actions are:

`roster`, `orphans`, `ensure`, `remove_workspace`, `rename_workspace`, `start`, `append`, `prompt`, `list`, `inspect`, `stop`, `abort`, `fork`, `archive`, `compact`, `delete`.

## Impact

An ordinary `agent` Session can:

- register, unregister, or rename workspaces (`ensure`, `remove_workspace`, `rename_workspace`);
- start Sessions in other workspaces, append/prompt/stop/abort them, fork, archive, or delete them;
- trigger `compact` on another Session, now through the preset compaction bridge;
- inspect other Sessions' workspace/session state.

This is a real permission escalation: a normal workspace agent can operate on Sessions and workspaces outside its own task. The destructive actions (`remove_workspace`, `delete`) require confirmation strings but that is not an authorization boundary. `superagent_ledger` and `superagent_permission` are hidden only because the ordinary branch does not include them, not because role gating protects `control`.

## Fix options and decisions

The fix is intentionally not applied in this checkout. Options:

1. **Remove `control` from the ordinary branch (recommended).** Ordinary roots keep their own jira tools only; the super branch remains the only producer of `control`. This restores the DH-716 intent.
2. **Split the tool.** Keep a narrow read-only roster/list tool for ordinary roots and move all lifecycle/workspace writes to a super-only tool. This requires deciding whether ordinary roots need any roster visibility.
3. **Keep the tool visible but enforce at runtime.** This leaks the capability in the tool catalog and still advertises an action surface the role model says should not exist; only acceptable as a temporary defense, not as the matrix fix.

Decision needed from the person: does an ordinary root need any part of the workspace roster, or should it get none of the `superagent_control` verbs? The DH-703/DH-716 comments imply **none**.

## Test impact

`packages/core/tools/tests/role-visibility.spec.ts` currently expects the `agent` snapshot to have **32** names, including `superagent_control`; the `super` snapshot has 36. Removing `control` from the ordinary branch (option 1) changes the agent set to **31** and must update that expected count/set. Splitting the tool changes the name set differently. Do not update the snapshot without deciding the product behavior.

## Scope

This note records the observed leak and the code path; it does not change the implementation, tests, snapshot, profile, or runtime. A successor must implement the chosen option, add a regression test that asserts an ordinary agent cannot see or invoke the super-only surface, and rebuild/restart.
