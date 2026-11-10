# Windows super agent evaluation handoff

English | [中文](windows-superagent-eval-handoff-2026-11-09.zh.md)


Date: 2026-11-09 Purpose: Have dev rerun the evaluation on Windows using the existing assessment criteria, followed by a kimi k3.1 review. Status: **Preliminary assessment and evidence index pending verification**, not a final conclusion.

## 0. Sources and limits

- Primary sources: visible history and archived summaries of this super agent Session `session-ecc925ac-d736-45f2-b1f6-8e84a8abe0ec`; the earlier related Session `session-a835d6fa-92cd-4f66-8847-f335d410a6c2`.
- Assessment criteria references:
  - `goal/superagent-implementation-assessment-2026-11-08.md`
  - `goal/memory-plugin-assessment-2026-11-08.md`
  - `goal/jira-ledger-assessment-2026-11-08.md`
  - `goal/linux-sandbox-audit.md` (for platform differences only)
- The hands-on evidence in the three 2026-11-08 assessments came from Fedora, and those documents explicitly require a Windows rerun; this document does not treat Fedora figures as Windows facts.
- The original Session log was rejected by an older reader because of the unknown `agent/tool-pair-repair` event. Dev has repaired the parser, but the current runtime may not have loaded that repair. This handoff therefore relies on visible history and archived summaries; dev should also reread the original logs with the new code during the rerun.

## 1. Preliminary assessment (Windows, to be verified)

**Overall: dispatch, file operations, and task execution can complete, but the completion → report → visibility → recovery loop is not proven closed. Under the existing criteria, P0 items cannot be judged closed.**

Preliminary judgments using the documented criteria:

| Priority | Assessment | Evidence |
|---|---|---|
| P0 | The report/task-state loop remains unreliable | The history repeatedly shows tasks marked completed in child Sessions while the super side remained pending and required manual `resolve`; the same report arrived repeatedly under different task ids; after `abort`, no new taskId/report binding existed. |
| P0 | Windows sandbox side effects can damage the working environment | `home-write` applied Low integrity labels to the user directory/workspace and wrote `Everyone:(CI)(DENY)(S,DC)` at the workspace root, causing EPERM on ordinary-privilege `rename` and requiring administrator PowerShell for builds. The old ACL backend is disabled and fails closed. |
| P1 | Session routing and lifecycle still incur operational costs | Numerous untitled Sessions; a multi-step `start` failure can leave an empty Session; `inspect` works only while a Session is running; monitor still provides a prompt on request rather than a state subscription. |
| P1 | Default retrieval is unavailable | `session-query` defaults to `openAt: "never"`, and `memory_search` directly reports `SESSION_QUERY_SEARCH_DISABLED`; the current Windows environment is also affected. |
| P1 | Questions, permissions, and task state are not orchestrated | A child Session's `ask_user_question` can be canceled and abort the entire turn; permission/effort can still require manual back-and-forth. |
| P2 | Observation and documentation | The panel does not show report delivery status; some figures and README entries in audit documents are outdated (for example, memory §4.8 and the `superagent.ts` line count changing from 4350 to 5006). |

## 2. Evidence observed on Windows

### 2.1 Reports and ledger

- Multiple tasks completed in their child Sessions, but the super-side ledger remained pending until manual `resolve`.
- The same report arrived repeatedly under different task ids; deduplication by task id alone is insufficient and requires content/result identity.
- Continuing with a prompt after `abort` produced no new taskId/report binding, so the new task did not report back as a new task.
- Monitor can only indicate that a task has been running for a long time; it cannot block until a report arrives. Long tasks may not automatically report back after completion.

### 2.2 Sessions and routing

- `list` contains multiple untitled Sessions; `append` requires an explicit Session, making routing prone to degradation.
- The `start` sequence create → selectModel → rename → bind → prompt is not atomic; a failure partway through leaves a Session without a task.
- `inspect` directly rejects cold Sessions; no unified interface shows the last failure, last report, or next step.

### 2.3 Windows sandbox and build

- `home-write` applied Low integrity labels to `C:\Users\TS`, the drive root, and the workspace, which were inherited by their subtrees.
- `Everyone:(CI)(DENY)(S,DC)` at the workspace root denied deletion of child items, causing Node `fs.rename()` to fail with EPERM; `pnpm build` required administrator PowerShell.
- The Low labels and DENY ACE were cleaned up on site; the old Windows ACL backend is disabled and fails closed with `SANDBOX_UNAVAILABLE`. Ordinary-privilege write/rename/mkdir/unlink operations were verified in 7 workspaces.
- After the latest synchronization, the only failure in the repository-wide `pnpm run build` was 4 unused imports (TS6133) in a local sandbox test, not a problem in the remote baseline or with the Windows platform; after cleanup, all 10/10 gates should pass.

### 2.4 Memory and retrieval

- `memory_search` fails by default because of `openAt: "never"`, with no local fallback.
- Memory write volume is high, but genuine search/read loops are rare; automatic summaries and dispatch conclusions are duplicated.
- Windows reruns are needed for file locks, junctions, ACLs, genuine compaction interruption, and concurrent writes to the same MEMORY.md.

## 3. Rerun matrix (using the existing criteria)

Cover at least:

1. **Report loop**
   - Normal child Session completion, missing reports, failed report delivery, duplicate reports, and continuation after abort.
   - Check whether ledger, journal, domain, and UI can show the same state and whether failures are retryable and visible.
2. **Lifecycle**
   - Residue from `start` failures at each step; handling of pending/delivering states after `abort`/`archive`; recipient selection for the sole super Session.
3. **Session routing**
   - `append` behavior for untitled or duplicate-named Sessions; rejection when an explicit Session is missing; whether `list`/`inspect` provide enough information about each Session's purpose.
4. **Questions and permissions**
   - Cancellation and timeout of a child Session's `ask_user_question`; whether permission presets take effect per task; whether effort still forces manual back-and-forth.
5. **Windows environment**
   - Ordinary-privilege builds after ACL cleanup; junctions/path aliases; multi-process journals; file locks; concurrent memory writes.
6. **Memory retrieval**
   - `memory_search` behavior under the default configuration; `memory_read` handling of aborted/failed turns; search fallback paths.

## 4. Deliverable requirements

- Windows evaluation report: `docs/reviews/windows-superagent-eval-2026-11-09.md` is recommended.
- Record runtime/HEAD, Windows version, administrator status, workspaces used, reproduction steps, original errors, and P0/P1/P2 decisions.
- Distinguish the three kinds of facts: code committed, runtime loaded, and reproduced on Windows.
- Do not modify the production code under evaluation; place temporary test files in a workspace temporary directory and clean them up or document them afterward.
- During the kimi k3.1 review, focus on whether evidence supports each P0 decision, whether Fedora/old-runtime facts are treated as Windows facts, whether the report loop is genuinely verified, and whether any static inferences remain unreproduced.

## 5. One instruction for dev

First read the assessment criteria in the three assessment documents and this handoff, then rerun the matrix on the current Windows runtime. Do not directly carry over Fedora call statistics, paths, or cloudstore conclusions. After completion, submit the report to kimi k3.1 for independent review.
