# Windows on-machine evaluation: super agent (report loop / lifecycle / routing / question permissions / environment / memory)

English | [中文](windows-superagent-eval-2026-11-09.zh.md)


Date: 2026-11-09. Subject: the **running** super agent on a physical Windows 10 machine (`@deepseek-ai/dsh-jira-agent`'s `superagent_session` / `superagent_ledger` / report journal / dispatch ledger), assessed using the severity scales in `goal/superagent-implementation-assessment-2026-11-08.md`, `goal/memory-plugin-assessment-2026-11-08.md`, and `goal/jira-ledger-assessment-2026-11-08.md`; `goal/linux-sandbox-audit.md` is used only as a reference for platform differences. Handoff file: `docs/reviews/windows-superagent-eval-handoff-2026-11-09.md`.

**Nature**: read-only evaluation. No production code or configuration was changed, and nothing was committed or pushed; temporary scripts and logs are in `.tmp-eval/` (untracked; see §9). The three evidence levels in this report are strictly separate: **committed code** / **loaded by the runtime** / **reproduced on the physical Windows machine**.

---

## 0. Executive summary

1. **The “normal report loop” on Windows really worked this time, with on-machine evidence rather than inference.** At the snapshot written to disk on 2026-11-09, the journal contained 13 task ids in total: **10 `delivered` and 3 still `pending` (including this evaluation session itself)**, with exactly one entry for each delivered task; the super Session received 10 `[task-report]` messages, corresponding one-to-one with the 10 delivered tasks, and the delay between the child Session's turn/end and delivery was 1–2 seconds (§3.1). This **differs** from the Fedora report's historical conclusion that “there was no automatic return after completion”: the happy path of the current runtime at the 2026-11-09 permission-fix baseline, including the report journal, works.
2. **But the P0s have not been closed; only some of them have changed.** The four P0s have different evidence levels (confirmed by re-review): duplicate cross-process claims of the same report (**synthetic multiprocess store experiment on Windows**, 26 claims for 6 items that should have been claimed; not a live reproduction with two real Hosts; raw stdout in §3.1 and `.tmp-eval/journal-race-stdout.txt`); a turn with empty output was automatically recorded as `returned` (**reproduced on-machine**); delivery failure is a terminal state with no retry and no startup recovery (**code + unit tests**; no failure was induced on-machine); continuing after `abort` creates no new binding (**code + unit tests**; not triggered on-machine).
3. **First, I correct one of my own erroneous conclusions: the dispatch domain has not been disabled.** I initially read only the main database (mtime 09:31:48, `-wal` 0 B) and concluded “75 rows, 0 rows today” because I **missed the WAL**. After copying `superagent.sqlite` + `-wal` + `-shm` to a temporary directory and querying again: **90 rows, 15 rows today**, including this evaluation task and the re-review task; `task-mw8m5yg4` became `failed@02:12:52` in the domain at the same moment as the manual resolve. The domain is therefore actually used by dispatch/resolve (the correction in re-review §4.1 is valid); what needs checking is its **authority relationship and source observability** relative to the Markdown projection, not whether it is “unopened.” The original P1-1 is withdrawn and replaced by a P2 observability item.
4. **The current sandbox side effects are real, but their attribution cannot be established.** The roots of the `deepseek-harness-uitstalie-dev`, `superAgent`, and `system_img` workspaces still carry `Everyone:(CI)(DENY)(S,DC)` and `Low Mandatory Level:(OI)(CI)(NW)`; `<analyze-workspace>` is Medium. The handoff file records a successful cleanup on 11-07, so “it was cleaned up then” and “it has appeared again now” can both be true; ACEs have no timestamps, so the writer and time remain undetermined. **This evaluation's ACL root-directory probe did not reproduce the historical rename EPERM**; however, Web/esbuild encountered `Access is denied` while deleting a temporary file on the same day, and the normal build did not pass (§3.5). Supplementary diagnosis located the esbuild deletion failure in the No-Write-Up restriction imposed on a Low process by a Medium file (§3.8), which does not change the conclusion that the writer and time of the persistent workspace labels remain undetermined.
5. **Overall rating: C+ (“usable, but integrity and recoverability are not established”).** Under the existing scale, P0s remain open, so the system should not be judged converged; nor can we retain the old conclusion that “reports simply do not come back on Windows”—that conclusion is no longer valid.

**The three most critical items**: cross-process claims are not atomic (§4 P0-1); empty output/no report is automatically written as `returned` (P0-2); delivery failure has no retry and no startup scan (P0-3). The fourth P0 is abort binding (P0-4).

---

## 1. Version, environment, and the three kinds of evidence

### 1.1 Running runtime

| Item | Measured value | Evidence |
|---|---|---|
| runtime checkout | `<runtime-checkout>` | Process command line |
| runtime HEAD | `2026-11-09 权限修复基线` (`cli-desktop`, **0** worktree changes) | `git -C … rev-parse HEAD`, empty `git status --porcelain` |
| Launch method | `node --import tsx/esm apps/cli/src/bin.ts web`, PID 5084, started at **2026-11-09 09:45:03** | `Get-CimInstance Win32_Process -Filter "ProcessId=5084"` |
| Interpreter / version | Node **v24.13.0**; root package `@deepseek-ai/dsh-root@0.2.2-rc.1` | `node --version`, `package.json` |
| Listener | `127.0.0.1:3080` (HTTP 401, startup token required) | `netstat -ano`, `Invoke-WebRequest` |
| profile / home | `DSH_PROFILE=web`, `DSH_HOME=<DSH_HOME>`, super home `<super-workspace>` | Process env, `~/.dsh/profiles/web/cordis.patch.yml` |

Key fact: the runtime uses **tsx to execute the TypeScript source directly**, without bundled artifacts. The “code loaded by the runtime” is therefore **the clean runtime worktree**, not build artifacts from `apps/web/dist`.

### 1.2 Consistency between the dev checkout and the runtime

- dev: `<dev-checkout>`, branch `cli-desktop`, on the same baseline as the runtime.
- However, the dev worktree has **79 status entries (73 modified tracked files)**, including `agent.ts`, `session/src/*`, `jira-agent/src/api-catalog.ts`, and others. The runtime worktree is clean, so: **the runtime did not load dev's uncommitted changes**. On this machine, any assumption that “dev has been fixed but the runtime may not have loaded it” is reversed: the running instance **definitely did not** load those uncommitted fixes in dev.
- The code baseline measured in this evaluation is the runtime checkout, not the `deepseek-harness-uitstalie-dev` worktree.

### 1.3 Machine and permissions

- Windows 10 Pro 22H2, build **19045.6466**, x64.
- User `TS-20240229UGAL\TS`, **not an administrator** (`IsInRole(Administrator)=False`), process integrity **Medium**.
- Evaluation Session cwd: `<dev-checkout>`; super Session `session-ecc925ac…` cwd: `<super-workspace>`.
- During the evaluation, a user action changed the Session file policy from `workspace-write` to `danger-full-access`; this does not affect the read-only conclusions below. The memory tools and ACL probes were exercised under both policies.

### 1.4 Three evidence levels (citation rules for this report)

| Level | Meaning | Use in this report |
|---|---|---|
| Committed code | Source/tests exist at the measured baseline | Used only to explain mechanisms and give line numbers, never as a conclusion by itself |
| Loaded by the runtime | The current process on port 3080 executed the code | Corroborated by the live journal/ledger/tool output |
| Reproduced on the physical Windows machine | Actually occurred on this machine in this round and can be rechecked | The only hard evidence for conclusions |

---

## 2. Live data (2026-11-09, produced by the runtime itself)

- Report journal: `<super-workspace>\.superagent\reports.jsonl`, which continued to grow during the evaluation (still being written at 10:12:12).
- Dispatch ledger: `<super-workspace>\.superagent\ledger\*.md` (`ledger-544e144b…md`, 537 KB).
- Dispatch domain: `<DSH_HOME>\storages\superagent.sqlite` (**90 rows, 15 rows today**; must be read together with `-wal`; see §3.2).
- Super Session log: `<DSH_HOME>\sessions\--D-dqc-superAgent--\session-ecc925ac-d736-45f2-b1f6-8e84a8abe0ec\session.v4.jsonl.zstd`.
- Child Session log: `…\--D-dqc-deepseek-harness-uitstalie-dev--\session-6e0cddc9-d2d7-487f-b93c-b97dbdc31c56\…`.
- This evaluation task was itself dispatched: `task-mw8mct4b-de1cbbd1`, whose child Session is `session-5599a833…` (this Session). The journal had already written `pending@2026-11-09T02:05:23Z` before the prompt.

> Log decoding method: the Session log consists of **1911 concatenated zstd frames** with no length prefix. Node's `zstdDecompressSync` and `createZstdDecompress` both **return only the first frame** (2.7 MB → 217 B), so the data must be split at each `28 b5 2f fd` and decompressed frame by frame (`.tmp-eval/decode-session.mjs`). This is a serious pitfall when rerunning on Windows: there is no `zstd` CLI, and the one-shot API silently truncates the data.

---

## 3. Measurement matrix

### 3.1 A. Report loop

#### A-1 Normal completion: works (on-machine)

Journal entries (mid-evaluation snapshot at 02:12Z: `lines=20 records=20 distinct ids=8`; §3.1 A-4 below explains the relationship between 8 and 13):

```
lines=20 records=20 distinct ids=8
task-mw8lnutt… pending@01:45:59Z -> delivering@01:50:43Z -> delivered@01:50:43Z  attempts=0,1,1
task-mw8lvw5q… pending@01:52:14Z -> delivering@01:58:22Z -> delivered@01:58:22Z
task-mw8lxomm… pending@01:53:37Z -> delivering@02:01:49Z -> delivered@02:01:49Z
task-mw8m5yg4…  pending@02:00:03Z -> delivering@02:12:12Z -> delivered@02:12:12Z
task-mw8m9vx1… pending@02:03:07Z -> delivering@02:08:13Z -> delivered@02:08:13Z
```

Child Session turn boundaries (`session-log.mjs … turns`):

```
2906 2026-11-09 01:50:42Z turn/end {"turn":7,"reason":{"kind":"completed"}}
2993 2026-11-09 01:58:20Z turn/end {"turn":8,"reason":{"kind":"completed"}}
3141 2026-11-09 02:01:47Z turn/end {"turn":9,"reason":{"kind":"completed"}}
3163 2026-11-09 02:12:10Z turn/end {"turn":10,"reason":{"kind":"completed"}}
```

Corresponding `[task-report]` messages received by the super Session (`kind:"user"`, `rpcId:"superagent-report-…"`):

```
607 01:57:35Z [task-report] session-a20c592e… task-mw8lret8-5650a2b5 (context 16%).
635 01:58:22Z [task-report] session-6e0cddc9… task-mw8lvw5q-3c97f302 (context 56%).
690 02:01:49Z [task-report] session-6e0cddc9… task-mw8lxomm-d5af2d74 (context 62%).
856 02:12:12Z [task-report] session-6e0cddc9… task-mw8m5yg4-c19b2a0a (context 63%), but produced no assistant text.
```

Delivery latency was 1–2 s; one message per task; 10 delivered messages for the day, with no duplicates. **This is “loaded by the runtime + reproduced on-machine.”**

#### A-2 No report (empty output): observed, but the ledger records success (on-machine, P0)

`turn 10` completed without any assistant text. The system did two things:

1. The report body was a diagnostic sentence, **which is correct**: `[task-report] … finished its turn (task task-mw8m5yg4-c19b2a0a) … but produced no assistant text. Inspect the Session … do not assume the task succeeded.` (super log seq 856)
2. However, the ledger projection wrote `returned` before delivery (`superagent.ts:3927` → `projectReportToLedger`). File evidence: `ledger-544e144b-651b-4202-a71b-ad04d7660f63.md`:

```
6050: ## task-mw8m5yg4-c19b2a0a · returned
6096: - dispatched: 2026-11-09T02:00:03Z
6097: - updated:   2026-11-09T02:12:12Z
6100: - outcome: the turn ended completed without assistant text
6102: ## task-mw8m5yg4-c19b2a0a · failed
```

`superagent_ledger list` did return `returned` at 02:12:14 (super log seq 863), and only at 02:12:52 did a manual `resolve status=failed` change it to failed (seq 911-912). **“No output” was automatically recorded as `returned` and required human correction.** This is an even sharper instance of Fedora P0, “business result written as returned before delivery”: even empty output was returned.

#### A-3 Delivery failure: the mechanism exists, but it remains terminal (code + unit tests; not induced on-machine)

The failure branch of `handleTaskTurnEnd` only warns and settles as failed; it does not retry:

```
3949: if (delivered) { await settleReport(… 'delivered' …) }
3952:   host.ctx.logger.warn('… the report was NOT delivered; marking the dispatch failed')
3957:   await settleReport(host, journal, report.id, 'failed', at, 'the report could not be delivered …')
```

`claim` explicitly does not claim failed reports: `dispatch-reports.ts:243 if (status === 'delivered' || status === 'failed') return undefined`. The unit test `marks the report failed and warns when delivery fails` passes, but **there is no retry tool and no UI retry entry point**, and the journal exposes only the `forSession/claim/all` read interfaces. Startup does not scan pending/delivering either: this round examined all capability initialization (`superagent.ts:4483-4527`) and `handleTaskTurnEnd`; the only recovery is “the next turn-end triggers claim, then retry after the lease expires” (`dispatch-reports.ts:244-249`). `superSessionForReport` (`superagent.ts:3670-3700`) only falls back to another recipient; it is not startup recovery.

**Limitation**: this round neither closed the recipient nor injected a write failure, so it could not show “what the user sees after failed” live. “Failure visibility/retryability” therefore counts as **established by code + unit tests, not verified on-machine**.

#### A-4 Duplicate reports: no duplicates in the journal, duplicates in the ledger (on-machine)

- Journal (snapshot at 02:12Z): `lines=20`, `ids=8`, 6 delivered; by the time the report was written to disk, this had grown to **13 ids: 10 delivered / 3 pending**. Two delivered entries for the same id never appeared; at the mid-evaluation snapshot, each id had exactly one.
- Ledger: the same task can have multiple sections. `task-mw8lnutt-aa5ccf25` has **two returned sections** (`:5347`, `:5462`), one from automatic projection and one from manual resolve; `m5yg4` has returned + failed sections. The report itself was delivered only once (the super log contains only one `task-mw8m5yg4` report), so **the so-called “duplicate reports” in the current Windows run appear as duplicate ledger sections, not duplicate deliveries**. This differs from the Fedora report's historical phenomenon of “duplicate arrivals with different task ids.”

#### A-5 Whether the ledger / journal / domain / UI show the same state

| Surface | Today's `task-mw8m5yg4` | Conclusion |
|---|---|---|
| journal | `delivered` (02:12:12) | Delivery fact |
| Ledger Markdown | First `returned` (6050), then manually `failed` (6102) | Business fact corrected by a person |
| dispatch domain | `failed` from 02:12:52; `returned` during the preceding automatic-projection period (final state failed; see §3.2) | Automatic state was wrong for 40 seconds, then correct after manual correction |
| UI panel | Not opened (port 3080 requires a token) | Not verified |

The four surfaces **did not show the same state**. The domain absence was not specific to this task, but global (§3.2).

### 3.2 dispatch domain: opened and used; authority relationship and data source need checking (original conclusion withdrawn)

> **Revision (2026-11-09, after k3.1 re-review)**: the first version of this section asserted “domain unopened, Markdown throughout, 0 entries today,” which was **wrong**. Cause: only the main database was opened read-only with `node:sqlite`, without applying the WAL, so the query read an old 09:31 snapshot. The recheck results and corrections follow.

- **Recheck method**: copy `<DSH_HOME>\storages\superagent.sqlite` **together with `-wal` (267,832 B) and `-shm`** to `.tmp-eval/dbcopy/`, open the copy read-write (SQLite automatically recovers the WAL), then query `u_superagent_dispatch_dispatches`.
- **Result**: `rows 90`, statuses `{"returned":63,"pending":23,"failed":4}`, **15 rows** today (2026-11-09); `task-mw8lnutt` was created at 01:45:59 and returned at 01:50:57; `task-mw8m5yg4` became **failed at 02:12:52** (the same moment as the manual resolve); this evaluation task `task-mw8mct4b` and the re-review task `task-mw8n3mda` are also in the domain.
- **Conclusion**: the current runtime's `DispatchStore` is open, and dispatch/resolve really writes to SQLite. The original report's chain of reasoning—“domain unopened / `store.list` returned undefined / tasks present only in Markdown”—does not hold: tasks returned by `superagent_ledger list` also exist in the domain, so the data source cannot be inferred from that result (re-review §4.1). P1-1 is withdrawn.
- **Weak conclusion that remains (P2)**: `superagent_ledger` does not expose “whether this entry comes from the domain or Markdown, whether it is degraded, and why,” so a person can only guess from the result; the single sampling of `storageDomain` during `DispatchStore` construction (`dispatch-store.ts:169-171`) still poses the static lifecycle risk that “a late-arriving service causes permanent degradation,” but **this was not the root cause on-machine** (the domain opened normally this time).
- **Authority relationship**: the domain and Markdown projection coexist (`dispatch-store.ts:214-227` projection synchronization). This round **did not** compare the domain/projection field by field for the same id; the re-review still raises the issue (not run on-machine) that `artifacts/decisions` are short-circuited by `dispatch-store.ts:282-289` after the domain has returned, making the projection non-replayable. This is listed as P2/unverified.

### 3.3 B. Lifecycle

- **A multi-step `start` failure leaves an empty Session** (confirmed in code; not induced on-machine): `2817` start → `2838 controller.create` → `2845` select model → `2853` rename → `2864` write report binding → `2872` prompt. Model failure (2847), title failure (2855), and binding failure (2867) all directly `return failure`; they **do not delete or mark the Session, or provide an entry point for continuing it**. Only workspace/task/reportTo are resolved first (2818-2835). No test covers the residue left by each step's failure.
- **Continuing after `abort` creates no new binding** (confirmed in code; not triggered on-machine): `3113-3169`: cancel → waitForIdle → `prompt({ requestId: 'superagent-recover-…' })`. **There is no `recordDispatchReport`**, so completion of that instruction after abort is not reported back as a new task. The unit test `aborts a running Session, reports the scene and continues it` asserts only `resumed`, not a new report. This matches Fedora P0 3.3 and remains unfixed.
- **pending/delivering after `archive`**: the unit test `fails pending reports when their Session is archived or stopped` passes; `failPendingForSessions` handles only **pending** (`dispatch-reports.ts:271-279`), **not delivering**; nor do the capability's archive/stop paths (`superagent.ts:4570-4607`) wait for in-flight deliver/settle, so a late send remains possible after archival.
- **Recipient for the sole super Session**: the journal's `superSession` is written at dispatch (`superagent.ts:890`), and only when empty does it fall back to `superSessionForReport` (`:3670-3703`), which selects the “most recently updated super root Session” and **may not be the original dispatcher**; if none is found, it settles failed + warns (`3911-3919`). All 10 reports in this round carried `superSession`, so **the fallback was not used**; fallback behavior was not run on-machine.
- **`accepted:false` from `abort` is not checked**: `3157-3168` still returns `resumed:true` when `admitted.accepted` is false; a normal `append/prompt` can likewise leave a pending binding. This should be included in P0-4 acceptance.
- **A settle failure leaves delivering**: `3716-3733` records a journal settle write failure only as a warning; if delivery actually succeeded but delivered was not persisted, a resend may occur after the lease, and startup still does not scan. This is a static extension of P0-3.
- **The module-level journal owner does not participate in dispose quiescence**: `reportJournals` is a module-level Map (`836-851`), and dispose (`4985-5004`) neither clears the Map nor waits for report handling that has already started, leaving a window for late sending/writing after dispose (re-review §5.1; not run on-machine).

### 3.4 C. Session routing

- **A missing explicit session is rejected** (code + on-machine behavior): when no session is supplied, `append` returns `append needs \`session\`: which of …` (`2703-2724`); every super append in this round explicitly supplied `session-6e0cddc9…` / `session-a20c592e…` (super log seq 569, 590, 673, 732, 839).
- **An unregistered workspace is rejected**: `"…" is not a registered workspace` (`2665-2666`).
- **`list` provides enough information** (on-machine): it returns title/model/effort/context%/cache%/lastTask/running/idle (super log seq 667: `session-6e0cddc9… memory 与 jira 插件实现审查 running 2m context 61% deepseek-official/deepseek-flash cache 100% (consider compact)`).
- **Untitled/duplicate names**: all Sessions created today had titles (`Windows super agent 评测`, `反馈记录分析 2026-11-06～2026-11-09`); no untitled Session appeared; historical untitled behavior was not reproduced in this round.
- **Recursive ledger filenames (historical residue, visible on-machine)**: `ledger/` contains `D__dqc_superAgent_.superagent_ledger_544e144b….md` and `…_D__dqc_superAgent_.superagent_ledger_544e144b….md` (two- and three-level nesting), dated 2026-11-05; the corresponding domain records have this slug as `workspace.id`, and `path` contains backticks (`` `<dev-checkout>…` ``). The current `append` rejects unregistered workspaces, but `DispatchStore.migrate()` still reads these historical rows into the domain (`dispatch-store.ts:205-211`), and `ledgerFileOf` continues to generate filenames from ids (`dispatch-ledger.ts:116-117`).

### 3.5 E. Windows environment

- **ACL/integrity labels remain** (on-machine; conflicts with handoff file §2.3):

| Workspace | `Everyone:(CI)(DENY)(S,DC)` | Integrity label |
|---|---|---|
| `<dev-checkout>` | Present | **Low** `(OI)(CI)(NW)` |
| `<super-workspace>` | Present | **Low** |
| `<system-img-workspace>` | Present | **Low** |
| `<analyze-workspace>` (not opened today) | Absent | **Medium** |

- **The current residue is real, but its attribution is undetermined**: ACEs have no timestamps, so it is impossible to distinguish “not fully cleaned on 11-07,” “rewritten later by an old process,” and “reapplied when the workspace was opened this time.” The ledger underlying the handoff file does record the live cleanup on 11-07 (`ledger-544e144b….md:4023-4069`: DENY cleared on 15 paths, 9 directories changed Low→Medium, 7 workspaces verified; `:4075-4083`: code no longer writes Low/DENY, and the old backend is fail-closed and disabled by default). **“Cleanup succeeded then” and “it has appeared again now” can both be true**, so this does not show that the handoff was fabricated. `analyze` being Medium is also insufficient by itself to prove that “not opened” is the only reason.
- **This evaluation's ACL root-directory probe did not reproduce the historical rename EPERM** (limited scope): a Medium process (non-administrator) performed `write/rename/unlink/mkdir/rename dir/rm -r` on the workspace root, all successfully (`.tmp-eval/acl-probe.mjs`), covering only this set of tokens/paths/operations. This shows only that **the probe reported no error**; it does not imply “there is currently no EPERM” or “DENY is ineffective for every deletion path.” Directory/file distinctions, parent-directory DELETE_CHILD, target DELETE, inheritance flags, and restricted tokens require separate verification.
- **Supplementary diagnosis located the same-day build permission failure**: ledger `:6294-6312` records a `pnpm run build` at 02:22 with **9/10 gates**, failing in the Web build: `[vite:esbuild-transpile] remove <temp>\esbuild-...: Access is denied.` Three retries, a changed TEMP, and a minimal `esbuild.transform` reproduction outside Vite all failed. Supplementary diagnosis read the actual residual file's ACL and the current token, confirming that a Low-integrity process is subject to the Medium file's No-Write-Up restriction; see §3.8 for the root cause and platform recommendation.
- **Normal-permission build**: this evaluation did not rerun the full-repository `pnpm run build` (read-only constraint + 79 uncommitted changes in the dev tree + it would touch `node_modules`). The ledger on the same machine shows that `tsc -b tsconfig.host.json` and `pnpm run typecheck` passed and build reached 9/10 (blocked at Web/esbuild), but this remains **cited evidence**; the only operations this evaluation ran independently were `pnpm install --frozen-lockfile` (successful) and `node:test` (all green). `vitest run` on those two `.test.ts` files returned `No test files found` (exit 1), which **does not count as passing**.
- **junction / path aliases, file locking, concurrent memory writes**: **not verified** (reasons in §7). A separate synthetic experiment covered the multiprocess journal (P0-1).

### 3.6 D. Questions / permissions

- **`ask_user_question` cancellation/timeout**: **no question occurred** in this Windows round. Child Session `6e0cddc9` had only one `approval/asked` + one `approval/decided` (the tool catalog includes `ask_user_question`, but it was not called). See §3.7 for the measured rejection of cross-Session `memory_read`. **The question path in D was not verified.**
- **Permission presets applied per task**: `start` has no permission parameter (`SESSION_PARAMETERS` contains only workspace/task/title/model/effort/session/delivery/compact/curate_memory, etc.); super itself is fixed by `superagent_permission_preset` (`index.ts` config); the child Session's preset comes from `agentPreset` (`superagent.ts:2840-2842`). **“Selecting permissions per task” does not exist in the tool interface**, and this round did not change configuration to verify it. Not verified.
- **Whether effort forces a manual round trip**: today's `start` did not pass effort, and the child Session header already had `reasoningEffort:"high"` (`request/header` seq 13), showing that the default took effect with **no manual round trip**. However, the tool still requires `reasoning_effort` for “models that declare efforts” (`superagent.ts:536`, `1925`); `kimi-code-plan-cn/k3.1-pro` declares low/high/max (super log seq 755-756), so dispatching to it causes a round trip. **That branch was not run on-machine.**

### 3.7 F. memory retrieval

- **Default `memory_search` is unavailable** (on-machine, reproduced in both this Session and the super Session; **P1**, per `goal/memory-plugin-assessment-2026-11-08.md:138-144` and the handoff file):
```
Error: session search is disabled: this deployment configures the session-query index with openAt "never"
```

Unit test results for this round (Windows, measured runtime baseline): `dispatch-reports` + `dispatch-store` **15/15 pass**; `superagent.test.ts` **83/83 pass** (152 s). Coverage includes “binding before prompt,” “deliver only once per turn,” “minimal report for empty text + warning,” and “set failed on failure.” **Note**: `vitest run` on those two `.test.ts` files returned `No test files found` (exit 1)—they run under `node:test` and cannot be counted as vitest passes. The “remount recovery” at `:857-888` merely calls the turn-end handler directly with an empty Map; it **does not demonstrate startup recovery**.

---

## 7. Unverified items and reasons

| Item | Reason |
|---|---|
| Visibility/retryability/UI of a real delivery failure live | Did not close the recipient or inject a write failure; only unit tests and code paths were examined |
| Startup recovery after restart | Port 3080 could not be restarted (would interrupt the user's Session); the absence of a journal startup scan is confirmed by code |
| `ask_user_question` cancellation/timeout | No question occurred in the Windows child Session this round (only one approval) |
| Permission presets applied per task | The tool interface has no permission parameter; configuration was not changed |
| Whether the UI panel displays delivery status | Port 3080 requires a startup token (`?token=`, 43 characters); the browser was not driven |
| junction / path aliases | Not tested; requires constructing a junction and comparing the literal cwd in `sameCheckout`/memory |
| File locking (Session lease) | Not tested; requires two hosts writing the same Session simultaneously |
| Concurrent writes to the same `MEMORY.md` | Not tested; requires a second memory-capable host/process, which falls under changing configuration |
| Full-repository `pnpm run build` | Not independently rerun in this evaluation; only the same-machine ledger's 9/10 and esbuild `Access is denied` (cited evidence, not rerun) |
| Field-by-field consistency between the domain and Markdown projection | This evaluation checked only row counts/statuses/times, not artifacts/decisions field by field for the same id |
| Continuing after `abort` on-machine | No running turn was constructed; code and unit tests confirm no new binding |
| Whether recursive filenames can still be newly generated | Current `append` rejects unregistered workspaces; whether `start` also rejects them was not separately verified |

---

## 8. Recommendations (“correctness first, then convergence”)

1. **P0-1**: Give the journal a genuine cross-process claim—a same-directory lock file (`mkdir`/exclusive open) + lease, or make claim an atomic rename/single writer; at minimum, explicitly reject more than one deliverer for the same superHome instead of relying on a deployment constraint.
2. **P0-2**: Record “business result” and “delivery status” separately: with no assistant text / on delivery failure, automatic projection must be `failed` (or `unknown`), not `returned` first; place `projectReportToLedger` after successful `deliver`, or explicitly mark “no output” in the outcome.
3. **P0-3**: Failure must not be terminal. Add `retry` to `superagent_ledger`, scan pending/delivering at startup (including expired leases), and display failed + reason in the UI.
4. **P0-4**: The prompt for continuing after `abort` must also go through `recordDispatchReport` (new taskId + requestId); otherwise the continuation never reports back.
5. **P1-1**: Decouple `memory_search` from session FTS—with `openAt:"never"`, still return MEMORY.md hits and explicitly mark them `partial`; do not leave “retrieval unavailable” for the caller to work around with grep.
6. **P1-2/P1-3**: Continue controlled before/after ACL snapshots and identification of the persistent-label writer, distinguishing historical residue, rewrites by old processes, and application by the current entry point; on Windows, change the default to the full-permission soft sandbox described in §3.8, retaining deny lists, tool policies, and audit logs, with hard ACL/Low integrity only as optional strong isolation. This recommendation is pending implementation; this report does not state that the configuration has been switched.
7. **P1-4**: `start` should resolve model/title/permission/binding capability before create; unavoidable failures should record `created/configured/admitted/failed` and permit continuation/cleanup.
8. **P1-5**: The projection must be replayable; supplementing artifacts/decisions after returned must not be short-circuited; archive historical invalid workspace ids and nested ledgers without deleting evidence.
9. **P2-1**: Identify the data source (domain/Markdown) and degradation reason in `superagent_ledger` results; retry or explicitly reject when `storageDomain` arrives late.

---

## 9. Temporary files

`.tmp-eval/` is an untracked temporary directory that currently retains **scripts, test logs, and the race stdout transcript** (about 30 KB): `journal-summary.mjs`, `domain-dump.mjs`, `decode-session.mjs`, `session-log.mjs`, `journal-race.mjs`, `claim-child.mjs`, `acl-probe.mjs`, `journal-race-stdout.txt`, plus `nodetest-{dispatch,superagent}.log` and `vitest-dispatch.log`. The synthetic journal (3000 lines), `dbcopy/`, and ACL probe residue have been deleted; all of `.tmp-eval/` can be deleted at any time. No production code/configuration was changed, and nothing was committed/pushed; no existing ledger, journal, or Session log was deleted.

---

## Appendix: Evidence index

| Topic | Location |
|---|---|
| Report journal format and claim | `packages/jira/jira-agent/src/dispatch-reports.ts:147-305` (claim 239-258, failed terminal state 243, lease 244-249) |
| Automatic projection before delivery | `packages/jira/jira-agent/src/superagent.ts:3923-3927` |
| No-text outcome | `superagent.ts:949`; live `ledger-544e144b….md:6100` |
| Delivery-failure terminal state | `superagent.ts:3949-3957` |
| No binding after `abort` | `superagent.ts:3113-3169` |
| `start` order and failure residue | `superagent.ts:2817-2896` (create 2838, model 2845, rename 2853, bind 2864, prompt 2872) |
| `append` explicit session / unregistered workspace | `superagent.ts:2664-2724` |
| Domain fallback for ledger list | `superagent.ts:3375-3376`; `dispatch-store.ts:234-236` |
| Single domain sampling | `dispatch-store.ts:170-171`; `storage-domain/src/index.ts:223-234` |
| Recursive filenames | `dispatch-ledger.ts:116-117`; `<super-workspace>\.superagent\ledger\D__dqc_…` |
| Effort requirement | `superagent.ts:536,1925` |
| Live evidence on this machine | `<super-workspace>\.superagent\reports.jsonl`; `…\ledger\544e144b….md:5347,5462,6050,6100,6102`; `~\.dsh\storages\superagent.sqlite`; super Session `session-ecc925ac…` |
| Evaluation scripts | `.tmp-eval/{journal-summary,domain-dump,decode-session,session-log,journal-race,claim-child,acl-probe}.mjs`; race stdout transcript `.tmp-eval/journal-race-stdout.txt` |

---

## k3.1 re-review revision record

Re-review report: [windows-superagent-eval-k3.1-review-2026-11-09.md](windows-superagent-eval-k3.1-review-2026-11-09.md). Conclusion: **partially accepted; C+ and 4 P0s maintained, 0 downgraded**. This report incorporates the re-review corrections as follows (only evidence and framing changed, not conclusions).

| # | Re-review comment | Changes to this report |
|---|---|---|
| 1 | **Dispatch-domain conclusion was wrong**: SQLite (including the WAL) already had writes for today before the snapshot; the unchanged main-database mtime was caused by the WAL; “list returned Markdown tasks” cannot be used to infer `store.list` undefined | **Original P1-1 withdrawn**, along with all statements that the “domain was unopened / everything used Markdown / 0 entries today / 75 rows”; §3.2 rewritten as a recheck (**90 rows, 15 rows today**, including this evaluation and the re-review task), explaining that reading only the main database missed the WAL and giving a WAL-safe query method; domain authority changed to pending verification (P2-1), with single sampling treated only as a static risk |
| 2 | **EPERM framing was too broad**: failure to reproduce with the ACL root probe ≠ no current EPERM; same-day Web/esbuild temporary-file deletion `Access is denied`, normal build 9/10 | §3.5 changed to “**this evaluation's ACL root-directory probe did not reproduce the historical rename EPERM** (limited tokens/paths/operations),” and lists the same-day esbuild permission failure (ledger `:6294-6312`, cited evidence, not independently rerun), explicitly stating that the two kinds of errors cannot prove/disprove each other; P1-2 title changed to “current residue/reappearance, writer and time undetermined,” and P1-3 separately lists the build-permission investigation |
| 3 | **26/6 lacked raw logs and experiment boundaries**: should say “synthetic multiprocess store experiment,” not that duplicate delivery occurred live with two Hosts | P0-1 changed to **reproduced in a synthetic multiprocess store experiment on Windows (not live with two Hosts)**, with script paths and `.tmp-eval/journal-race-stdout.txt` added (labeled as a Session transcript, not separately persisted by the program), stating the barrier/seed and that settle, crashes, and recipient deduplication were not covered, and noting that **the re-review did not independently rerun it**; §5 correspondingly changed to “mechanism confirmed; do not extrapolate a live failure rate” |
| 4 | **`memory_search` should be restored to P1** (existing scale `goal/memory-plugin…:138-144`, handoff file) | P2-1 → **P1-1**; §3.7 marked P1; §5 table says “maintained with corrected severity.” `memory_read` not distinguishing interrupted/failed remains P2 |

Secondary issues also identified by the re-review and corrected in this report:

- **P0-3/P0-4 evidence expanded**: added settle failure leaving delivering (`superagent.ts:3716-3733`), archive/stop not waiting for in-flight work (`dispatch-reports.ts:271-279`, `superagent.ts:4570-4607`), unchecked `accepted:false` (`:3157-3168`), recipient fallback (`:3670-3703`), and module-level `reportJournals` not cleared on dispose (`:836-851`, `:4985-5004`).
- **Remount test ≠ startup recovery**: `:857-888` merely calls the handler directly with an empty Map, as noted in P0-3 and §6.
- **Test accounting**: `vitest run` on these two `.test.ts` files actually returned `No test files found` (exit 1) and is no longer counted as passing; `node:test` 15/15 and 83/83 remain valid.
- **Duplicate ledger sections**: `:5347`/`:5462` are append-only projection history, not duplicate delivery; the real problem is that supplements after returned are short-circuited by `dispatch-store.ts:282-289`, making the projection non-replayable.
- **memory §4.8 documentation drift**: that specific assertion is withdrawn (P2-5 rewritten) and is no longer treated as currently verified drift.
- **“Overturning the old conclusion” narrowed**: it means only that the observed happy path of the current Windows runtime automatically reports back; it does not mean restart/multiple-Host/injected-failure paths are reliable.

**Evidence still missing and its impact**: P0-1 still has no real two-Host end-to-end delivery evidence and no independent re-review rerun; P0-3/P0-4 remain statically confirmed, with no on-machine failure injection; the domain and projection have not been compared field by field. These limitations reduce **evidence coverage**, but do not change the determination that the 4 P0s are definite defects; C+ and the P0 count remain unchanged.
