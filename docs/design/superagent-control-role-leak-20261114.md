# Superagent `control` no longer reaches ordinary agent Sessions (2026-11-14)

English | [中文](superagent-control-role-leak-20261114.zh.md)

Status: **fixed** — reproduced on a real deployment after restart; the ordinary root branch now omits `control` entirely. Fixed in the `fix(jira): hide superagent_control from ordinary agent roots` commit on `origin/cli-desktop`.

## Observed behavior

After the restart, an ordinary workspace Session running with role `agent` reported `superagent_control` in its model-facing tool list. `superagent_ledger` and `superagent_permission` were absent. This was read from the live Session's tool catalog, not inferred from a report.

Reproduction before the fix:

1. Open a normal (non-super) workspace Session; role must be `agent`.
2. Read the Session's actual tool list (system prompt/tool catalog), not the declared matrix.
3. Observe `superagent_control` present; `superagent_ledger`/`superagent_permission` absent.

## Code location

- `packages/jira/jira-agent/src/superagent.ts:5587` names the merged tool with `CONTROL_TOOL_NAME`; the constant is `superagent_control` (`:335`).
- The Jira capability's branch is `:5785-5804`:
  - executor Session → `[]` (DH-703);
  - super Session → five tools, including `control`, each wrapped with `withMinRole(tool, 'super')` (`:5790-5795`);
  - ordinary root → `source`, `scan`, `claim`, `status`, `dispatcher`, with no `control` (`:5797-5803`).
- `ToolRegistry` only hides a tool when `ToolDefinition.minRole` is present (`packages/core/tools/src/role.ts`). The ordinary branch no longer produces `control`, so there is no role-filter bypass to rely on.

## Conflict with the role model

The comments at `:5781-5784` state the intended split:

- DH-703: an executor Session is a root, so scope alone would hand it dispatcher verbs; it gets none.
- DH-716: the super agent is a root too and dispatches; it keeps the workspace roster and loses ledger-bound verbs that would invite it into the claim loop.

An ordinary workspace root is neither an executor nor a super agent. It must not receive the dispatcher/workspace-management surface. The approved role matrix marks `superagent_control`, `ledger`, `deliver`, and `permission` as `super`; the ordinary branch now matches it.

`superagent_control` is not a read-only roster tool. Its actions are:

`roster`, `orphans`, `ensure`, `remove_workspace`, `rename_workspace`, `start`, `append`, `prompt`, `list`, `inspect`, `stop`, `abort`, `fork`, `archive`, `compact`, `delete`.

## Impact before the fix

An ordinary `agent` Session could:

- register, unregister, or rename workspaces (`ensure`, `remove_workspace`, `rename_workspace`);
- start Sessions in other workspaces, append/prompt/stop/abort them, fork, archive, or delete them;
- trigger `compact` on another Session, now through the preset compaction bridge;
- inspect other Sessions' workspace/session state.

This was a real permission escalation: a normal workspace agent could operate on Sessions and workspaces outside its own task. The destructive actions (`remove_workspace`, `delete`) require confirmation strings, but that is not an authorization boundary. `superagent_ledger` and `superagent_permission` were hidden only because the ordinary branch did not include them, not because role gating protected `control`.

## Fix

Option 1 is applied: remove `control` from the ordinary root branch. Ordinary roots keep only `superagent_source`, `superagent_scan`, `superagent_claim`, `superagent_status`, and `superagent_dispatch`; the super branch remains the only producer of `superagent_control` (and the other super-only tools). The executor branch stays `[]`. No runtime-only rejection path was kept: the tool is not advertised and is not callable for an ordinary root.

The capability now declares ten tools in total: five ordinary-root tools and five super-only tools, with disjoint sets.

## Test impact

`packages/core/tools/tests/role-visibility.spec.ts` snapshots the **approved matrix**, not the jira contribution wiring. It already declares `superagent_control` as `super`, so its approved counts stay **32** for `agent` and **36** for `super`; it now also asserts explicitly that the agent set excludes `superagent_control` and the super set includes it. The earlier note's claim that the 32-name agent snapshot included `superagent_control` was incorrect.

The real wiring is covered in `packages/jira/jira-agent/src/superagent.test.ts`: an ordinary root gets exactly five names and no super-only tool, the super agent gets all five super tools, and the regression test is `hides every super-only workspace tool from an ordinary root`. README tool counts were corrected from nine/six to ten/five.

## Scope

This note records the observed leak and the applied fix. The runtime checkout was not rebuilt or restarted.
