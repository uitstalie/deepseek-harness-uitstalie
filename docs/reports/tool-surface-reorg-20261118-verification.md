# Tool surface re-organization — verification report (2026-11-18)

English | [中文](tool-surface-reorg-20261118-verification.zh.md)

`docs/reports/` is introduced by this report as the verification-report directory.

Commit under verification: the latest `cli-desktop` commit at report time (the retirement commit immediately following the persistence record). Working tree at report time: clean.

## 1. Final action lists

### `workspace_sessions`

Source: `packages/uitstalie/workspace-tools/src/sessions.ts`.

- Read: `list`, `get`.
- Lifecycle: `start`, `append`, `prompt`, `stop`, `abort`, `fork`, `archive`, `compact`, `delete`.
- Lifecycle writes require the `super` role; reads stay open to every agent in the workspace.

### `workspace_tasks`

Source: `packages/uitstalie/workspace-tools/src/tasks.ts`.

- Actions: `list`, `get`, `create`, `update`, `receipt`.

### `workspace_message`

Source: `packages/uitstalie/workspace-tools/src/messages.ts`.

- Actions: `send`, `read`, `status`, `retry`.

### Delivery failure visibility and resend

- Failure reading is `workspace_message.status`: it returns the message's `status`, `error`, `attempts`, references, and receipts.
- Resend is `workspace_message.retry`: it resends a failed message with the same message id, request identity, text, priority, references, and target.
- Failure test 1: `a thrown delivery failure is persisted as failed and retry delivers exactly once` (in `packages/uitstalie/workspace-tools/tests/delivery.spec.ts`). The test makes the controller throw `target inbox is closed`, reads the persisted `failed` state and `attempts=1` through `status`/`read`, switches the controller to accept, `retry` returns `delivered` with `attempts=2`, and the request id is accepted exactly once.
- Failure test 2: `a declined delivery keeps its reason, advances attempts, and retry then delivers` (same file). It covers `accepted:false` with `recipient inbox is full`, a failed retry updating the reason and attempts to 2, then a successful retry at `attempts=3`.
- Command/result: `pnpm exec vitest run packages/uitstalie/workspace-tools --maxWorkers=2` → 41 passed / 41, 18:16:53–18:17:09 (16 s).

## 2. Tests added or changed

| File | Cases | Result | Evidence |
|---|---|---|---|
| `packages/uitstalie/workspace-tools/tests/lifecycle.spec.ts` | 2 | pass | Super agent starts in workspace B, then append/prompt/stop/abort/fork/archive/compact/delete; ordinary root is refused every lifecycle action |
| `packages/uitstalie/workspace-tools/tests/sessions-lifecycle.spec.ts` | 7 | pass | start in another workspace, append/prompt delivery modes, stop/abort, fork/archive/compact/delete, missing delete API, ordinary-agent refusals |
| `packages/uitstalie/workspace-tools/tests/delivery.spec.ts` | 11 | pass | Includes the two failure/retry tests above; total 11 |
| `packages/uitstalie/personality/tests/provider.spec.ts` | — | pass | Merged `personality_apply`; no `write_like_human` registration |
| `packages/core/tools/tests/role-visibility.spec.ts` | 1 | pass | Retired names removed from the role matrix; agent 30 / super 30 / subagent 18 |
| `packages/uitstalie/dafeiyu/tests/composition.spec.ts` | 1 | pass | Composition still wires memory/personality/store |
| `packages/client/ui-settings-general/tests/shell.client.spec.ts` | 10 | pass | JIRA settings section removed from the roster |
| `packages/test-support/client-runtime/tests/**` | 136 (135 pass + 1 expected fail) | pass | Full web-app roster without JIRA rows |

Package totals re-run this round:

| Command | Cases | Result | Start–end | Seconds |
|---|---|---|---|---|
| `pnpm exec vitest run packages/uitstalie/workspace-tools --maxWorkers=2` | 6 files / 41 | 41 passed | 18:16:53–18:17:09 | 16 |
| `pnpm exec vitest run packages/uitstalie/personality --maxWorkers=2` | 8 files / 107 | 107 passed | 18:17:12–18:17:26 | 14 |
| `pnpm exec vitest run packages/uitstalie/memory --maxWorkers=2` | 7 files / 116 | 116 passed | 18:17:30–18:17:47 | 17 |
| `pnpm exec vitest run packages/core/tools/tests/role-visibility.spec.ts --maxWorkers=2` | 1 | 1 passed | 18:17:51–18:17:57 | 6 |
| `pnpm exec vitest run packages/uitstalie/dafeiyu/tests/composition.spec.ts --maxWorkers=2` | 1 | 1 passed | 18:18:01–18:18:11 | 10 |
| `pnpm exec vitest run packages/client/ui-settings-general/tests/shell.client.spec.ts --maxWorkers=2` | 10 | 10 passed | 18:18:15–18:19:29 | 75 |
| `pnpm exec vitest run packages/test-support/client-runtime --maxWorkers=2` | 14 files / 136 | 135 passed + 1 expected fail | 18:19:34–18:20:30 | 56 |

## 3. Residue proof for removed names

Command: `git grep -l -E 'superagent_control|superagent_ledger|issue_work|jira_issue|jira_kb|jira_list' -- .` → 0 files. This covers source, prompts, skills, evaluation sets, role matrix, and docs.

- `packages/jira` exists: `False`.
- `packages/superagent` exists: `False`.
- Generated catalogs: `packages/extensions/tool-cordis/src/api-catalog.ts` and `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts` contain 0 of the six names.
- Existing build outputs:
  - `packages/uitstalie/workspace-tools/lib` 77 files, 0 hits.
  - `packages/core/tools/lib` 45 files, 0 hits.
  - `packages/test-support/client-runtime/lib` 81 files, 0 hits.
  - `packages/client/ui-settings-general/lib` 78 files, 0 hits.
  - No `packages/jira` build output exists.
- No build was run in this round, so there is no fresh `packages/jira` product to inspect; the deleted package cannot appear in the artifact tree.

## 4. Design document terminal state

`docs/design/tool-surface-reorg.md`:

- Line 5: status says the JIRA product is retired and Session lifecycle lives in `workspace_sessions`; delivery failure/resend in `workspace_message`.
- Line 27: `## 3. Session lifecycle and delivery state move into `workspace_*``.
- Line 39: `workspace_message` `status`/`retry` behavior.
- Line 59: "No parallel task or delivery API remains."
- Old "two tools stay" conclusion: absent; `Select-String` for `two tools|remain|暂留` returns no such conclusion line.

`docs/design/tool-surface-reorg.zh.md`:

- Line 5: 状态：已实现；会话生命周期由 `workspace_sessions` 承载，投递失败与重发由 `workspace_message` 承载。
- Line 27: `## 3. 会话生命周期与投递状态搬进 `workspace_*``.
- Line 39: `workspace_message` 的 `status`/`retry`.
- Line 59: 不再保留并行的任务或投递 API。

Upgrade guide `docs/upgrade-guide/v0.2.2-rc.4/tool-surface-reorg/guide.md` line 17: local JIRA ledger and dispatch history "cannot be restored". Chinese counterpart line 17: "它们不可恢复".

## 5. Deferred until after the main checkout merge (not touched)

These are running-installation data and must not be deleted in this checkout:

1. `C:\Users\TS\.dsh\dsh-jira` — 90 files; present.
2. `D:\dqc\superAgent\.superagent\ledger` — 2 files; present.
3. `D:\dqc\superAgent\.superagent\reports.jsonl` — 87,601 bytes; present.
4. The exported snapshot remains at `D:\dqc\_exports\tool-surface-reorg-20261118` (not modified, not re-exported).

The running GUI is still the old build and can recreate `.superagent` files after deletion; a restart/upgrade is part of the merge step, not this checkout.

## 6. Static gates (one command at a time)

| Command | Result | Pass/fail | Start–end | Seconds |
|---|---|---|---|---|
| `pnpm run typecheck` | 5/5 gates pass | pass | 18:11:07–18:12:23 | 76 |
| `pnpm run verify-config-catalog` | 3 artifacts up to date | pass | 18:12:27–18:12:40 | 13 |
| `pnpm run verify-plugin-packages` | up to date | pass | 18:12:44–18:12:53 | 9 |
| `pnpm run verify-cordis-catalog` | 133 artifacts up to date | pass | 18:12:56–18:14:50 | 114 |
| `pnpm run verify-package-paths` | 8,302 files resolve | pass | 18:14:55–18:15:03 | 8 |
| `pnpm run verify-upgrade-guides` | conform | pass | 18:15:07–18:15:10 | 3 |
| `pnpm run verify-translation-pairing` | 1,391 pairs consistent | pass | 18:15:14–18:16:49 | 95 |

Full-window results:

| Command | Result | Start–end | Seconds |
|---|---|---|---|
| `pnpm run clean` | 425 paths removed | 18:21:40–18:22:03 | 23 |
| `pnpm run build` | 10/10 gates pass | 18:22:07–18:29:39 | 452 |
| `pnpm run check:all` | exceeded the 20-minute cap and was stopped; no final summary | 18:29:44–about 18:50 | about 1,200 |
| `pnpm run doc-sync` | 43/43 passed after fixes | 18:57:47–19:02:06 | 259 |
| `pnpm run test` | exceeded the 20-minute cap and was stopped; no final summary | 19:02:10–about 19:22 | about 1,200 |
| `pnpm run verify-persistence-formats --write` | refreshed 3 files | 18:55:12–18:55:24 | 12 |
| `pnpm run verify-persistence-formats` | v0–v4 pass | 18:55:12–18:55:24 | 12 |
| `pnpm run verify-repository-references` | no prohibited references | 18:55:35–18:55:47 | 12 |

The two `doc-sync` failures were fixed inside the window (format facts regenerated, commit hash removed from this report); each failing gate passed when rerun alone. `check:all` did not complete, so this report does not claim a full gate pass.

## 7. Gates not completed this round

- `check:all` was stopped at the 20-minute cap and produced no final summary; it is not a pass.
- Full `vitest` (`pnpm test`) was stopped at the 20-minute cap and produced no final summary; changed package paths were run individually and pass.
- `doc-sync` now passes 43/43 (18:57:47–19:02:06, 259 s) after the two fixes.
- `verify-md-links`, `verify-package-readme-model-experience`, `verify-module-graph`, `verify-persistence-changes`: covered by the passing 43/43 `doc-sync` run; not rerun individually.

## 8. Outstanding / not done

- Running-installation JIRA ledger and dispatch data are not deleted in this checkout; they are listed in section 5 and must be handled after the main checkout is upgraded/restarted.
- The designed terminal state is committed and pushed, but the running GUI (old build) still exposes the retired tools until it is restarted with this build.
- This report does not claim `doc-sync` green; it claims the seven static gates above and the listed package tests.

## 9. Full `check:all` window (2026-11-18 19:39–20:19)

- Command: `pnpm run check:all`.
- Start/end: 19:39:34–20:19:35 (about 2,400 s). Stopped at the 40-minute cap; no final `run-gates` summary was produced.
- Result: **failed / incomplete**. Fifteen gates reported `FAILED` before the cap; the run was still completing remaining gates when stopped.
- Failed gates observed: client domain graph, duplication, runtime closure, constraints, vendor rescope, plugin locale metadata, product package classification, proxy-aware dispatchers, no new silent catches, no new unknown casts, no new Cordis root reads, CLI help reference, plugin entry exports, documentation site checks, package dependencies.
- Caused by this change:
  - `product package classification` (`verify-product-use`): `packages/jira/jira-cli: stale package policy; remove the missing or ineligible directory`. The deletion left the `packages/jira/jira-cli` entry in `scripts/product-package-policy.ts` (and related entrypoint checks). This needs a follow-up policy edit; not fixed in this verification round.
  - `no new unknown casts` (`verify-no-unknown-casts`): 15 `as unknown as` assertions in `packages/uitstalie/workspace-tools/tests/delivery.spec.ts` and `intents.spec.ts`; the casts were added to satisfy TypeScript in the prior round. This needs typed narrowing or a documented exemption; not fixed in this verification round.
- Not caused by this change (files/lines outside the changed set or pre-existing in `HEAD~1`): client domain graph, duplication, runtime closure, constraints, vendor rescope, plugin locale metadata (no `workspace-tools/locale` in `HEAD~1`), proxy-aware dispatchers (`service.ts`/`tasks.ts` unchanged), no new silent catches (`memory/src/entry-times.ts` unchanged), no new Cordis root reads (`llm-plus` tests unchanged), CLI help reference (`headless --help` process killed), plugin entry exports (`workspace-tools/src/index.ts` unchanged), documentation site checks (5 s test timeout), package dependencies (`ui-models-dev` unchanged).
- Because `check:all` did not pass, the conditional full `pnpm test` was **not run**. The changed-package tests in section 2 already pass.
