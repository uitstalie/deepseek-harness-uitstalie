# memory / jira fix report

English | [中文](2026-11-07-memory-jira-fixes.zh.md)


> Corresponding review: [2026-11-07-memory-jira-implementation-review.md](2026-11-07-memory-jira-implementation-review.md) > Baseline and branch: `cli-desktop`; HEAD at review time was the review-day baseline; fixes spanned the memory and Jira work listed below (not pushed). > Working method: changed only memory / jira / related composition and documentation; did not revert, clean, or commit any unrelated worktree changes.

---

## 0. Executive summary

| Item | Priority | Status |
|---|---|---|
| M1 summary jobs started for aborted/errored turns | P0 | ✅ Fixed; tests pass |
| J1 `toolFailure` missing `me` | P0 | ✅ Fixed; regression test added |
| J2 no worker preset in the delivery composition | P1 | ✅ Chose "wire in the preset"; guarded by composition tests |
| M2 silent runtime failure of `snapshotPosition` | P1 | ✅ Changed to always register `memory-state`; takes effect when switched to prompt |
| M3 memory documentation/dependency/config drift | P1 | ✅ Changed (including both README languages, manifest, and inject) |
| M4 snapshot accumulation | P1 | ✅ Chose "correct the documentation promise + pin with tests"; eviction listed as follow-up (rationale in §3) |
| J3 reconfigure duplication / documentation | P1 | ✅ Fixed (including HANDOVER/DESIGN historical banners) |
| J4 superagent teardown | P1 | ✅ Added `disposed` gate and comments |
| P2 low-risk items | P2 | Partially complete; unfinished items and reasons in §4 |

All relevant tests were rerun and passed after the fixes: memory + ui-memory **122 passed**, jira vitest **96 passed**, jira node **776 passed**, and related package `tsc -b` **exit 0**.

---

## 1. Fix details (problem → fix → evidence → tests)

### M1 (P0) memory: no summary jobs for cancelled/errored turns

- **Problem**: the organizer dispatched every `turn/end` (`packages/uitstalie/dafeiyu/src/index.ts:336`), memory's `onTurnEnd` did not check `reason.kind` (`packages/uitstalie/memory/src/index.ts:264`), while `readTurnConversation` accepted only `completed` and threw (`summary.ts:448-455`), and the failure branch wrote a failure notice (`summary.ts:374`). At review time, `tests/summary.spec.ts:237` was reliably red.
- **Fix**: filter on the memory side (`packages/uitstalie/memory/src/index.ts:269`): `if (input.event.data.reason.kind !== 'completed') return`. The reason for choosing the memory side rather than the organizer side: dafeiyu's "dispatch every ending" behavior was an intentional contract change on 2026-11-05 for superagent failure reporting (superagent.ts's turn-end reporting depends on it); filtering on the organizer side would also remove that path. Each provider determining its own success conditions is the contract's intent.
- **Documentation**: `packages/uitstalie/memory/README.md`, `README.zh.md`, and `packages/uitstalie/dafeiyu/README.md:95` were synchronized to "the organizer dispatches every ending, and providers filter for themselves."
- **Tests**: the existing aborted case passed, and a blocked case and notice assertions were added (`packages/uitstalie/memory/tests/summary.spec.ts:237`, `:255`).

### J1 (P0) jira: failure envelopes must satisfy the output schema

- **Problem**: `SUPERAGENT_OUTPUT_SCHEMA` requires `ok/writable/me` (`superagent.ts:928`), `toolFailure` did not return `me` (formerly `:1729-1734`), and the fallback catch used it (`:2451`) → an intended readable failure would be replaced by `ToolOutputError`.
- **Fix**: `sessionActionFailure(message, me, details?)` (`packages/jira/jira-agent/src/superagent.ts:1733`) now supplies `me`; call sites pass `me`; it is exported from `index.ts` for direct test verification (`packages/jira/jira-agent/src/index.ts:368`). JSDoc states that "the output schema requires three fields, and the registry throws `ToolOutputError` if one is missing."
- **Tests**: `packages/jira/jira-agent/src/superagent.test.ts:2463` asserts `ok/writable/me`, that all schema `required` fields are present, and that the value is structured-cloneable.

### J2 (P1) jira: wire the worker preset into the delivery composition

- **Problem**: `superagent_dispatch` rejected directly when `superagent_worker_preset` was unset (`superagent.ts:3700`), while the delivery patch's `jira-agent` row did not configure it (formerly `cordis.patch.uitstalie.yml:35`); the same bundle already defined the `jira-worker` preset but never connected it.
- **Fix (chose "wire it in" from two options)**: `packages/bundle/web-app/cordis.patch.uitstalie.yml:36-43` adds `superagent_worker_preset: jira-worker` to the `jira-agent` row, and a comment explains that it configures the same bundle's `presets/jira-worker.patch.yml`; superagent itself remains opt-in through `superagent_home`.
- **Why not "hide the tool when unconfigured"**: the capability is disabled by default, and tool visibility is also controlled by `superagent_home`; hiding the tool would make "home is configured but dispatch is not visible" harder to diagnose, while wiring in the preset is consistent with existing bundle assets and has the smallest change surface.
- **Tests**: `packages/jira/tests/bundle-composition.spec.ts:168` asserts that the delivery patch's `jira-agent.config` is `{ superagent_worker_preset: 'jira-worker' }` and that `jira-worker.patch.yml` does contain `id: jira-worker`.
- **Documentation**: the limitation entry in `packages/jira/jira-agent/README.md` now says "the dispatch surface requires both a worker preset and super home."

### M2 (P1) memory: runtime switching of `snapshotPosition`

- **Problem**: the section set was determined at wiring time from the then-current `snapshotPosition` (formerly `index.ts:239-245`); after switching to `prompt`, the already-wired agent had no `memory-state` section, while `syncMemorySnapshot` returned directly in prompt mode (`snapshot.ts:226`) → the session stopped receiving snapshots without reporting an error.
- **Fix**: the `memory-state` section is **always registered**, and `text()` returns content only in `prompt` mode (`packages/uitstalie/memory/src/index.ts:243-253`). System-prompt assembly discards empty sections (`packages/core/system-prompt/src/index.ts:298-299`), so `depth-0` mode has no additional cost; after switching to `prompt`, the next refresh takes effect. "Reject the switch" was not chosen because this field is already volatile; rejection would appear in the UI as "saved but not effective," which is harder to explain.
- **Tests**: `packages/uitstalie/memory/tests/provider.spec.ts:126` writes in `depth-0`, switches to `prompt`, and writes again, asserting that the `memory-state` section appears and no more messages are appended.

### M3 (P1) memory: documentation/dependency/config drift

- **README (English)**: `snapshot` changed to append-only (no longer says replace / `surfaceOp: replace`), migration changed to "before detail append," `Window:` changed to `Archived:`, dependencies changed from "six services including `ctx.fs`" to five services + actual imports, and token effect changed to "≤16 KiB each, can accumulate."
- **README (Chinese)**: synchronized the changes above and kept it consistent with English.
- **Manifest**: added `@deepseek-ai/dsh-llm` and `@deepseek-ai/dsh-session` to `dependencies` in `packages/uitstalie/memory/package.json` (the source has runtime imports); `pnpm-lock.yaml` was updated with `pnpm install --lockfile-only --offline`.
- **Inject**: removed the never-used `fs` (`packages/uitstalie/memory/src/index.ts:34`) and synchronized JSDoc.
- **Configuration without UI**: `maxEntries`, `snapshotTemplate`, and `snapshotPosition` are explicitly documented as profile-YAML fields with their purposes in `packages/uitstalie/ui-memory/README.md`.
- **Tests**: full memory suite 122 passed (including new position / accumulation cases).

### M4 (P1) memory: snapshot accumulation

- **Problem**: each summary boundary could append a complete snapshot; deduplication only compared whole-string equality with the "previous snapshot text," so long sessions would accumulate snapshots.
- **Fix (chose "correct the documentation promise + pin with tests" from three options)**: the README's Token effect and Known Limitations now state "each is ≤16 KiB, but append-only accumulates; evicting old snapshots requires replacing earlier nodes, exactly the KV-cache cost that DH-723 removed."
- **No hard eviction implemented**: eviction rules either replace old nodes every turn in the steady state (reintroducing DH-723's cache problem) or skip the full snapshot at startup/resume (the model loses current state). Both are product tradeoffs that should not be decided unilaterally in a "bug fix" commit; they are listed as follow-up tasks in this report.
- **Tests**: `packages/uitstalie/memory/tests/summary.spec.ts:596` appends one snapshot at each of two summary boundaries and asserts that both remain, seq increases, and each is ≤ `MEMORY_SNAPSHOT_MAX_BYTES`.

### J3 (P1) jira: duplicate assignment and documentation

- **Code**: removed six duplicate assignment lines from `reconfigure()` (`packages/jira/jira-service/src/index.ts:248-259`).
- **Regression test**: `packages/jira/jira-service/tests/volatile.spec.ts:83` asserts that one volatile commit applies all three root/host/push fields.
- **jira-service README**: `superagentConfirm` is no longer the "only write"; added `superagentSetup` (creates the directory, registers the workspace, and writes `superagent_home`, `remote.ts:230-259`), and completed the service-method enumeration and remote table.
- **HANDOVER.md**: added a historical banner at the top explaining that it describes the pre-migration single-package state (`src/core`, `dist/`, 702 tests) and that its commands should not be executed.
- **DESIGN.md**: added a historical note at the top—82 was the count at that time (§8 already has 223), and the single-package tree and "zero host dependencies/offline copying" premises have been superseded by `MIGRATION.md`; the historical body and correction records remain.
- **jira/README.md**: marked DESIGN/HANDOVER links as historical; added `issue_work` and superagent to the jira-agent summary.
- **jira-agent README**: changed `enabledByDefault` to the actual rule; changed tool counts to "6 for ordinary root / 5 for super agent"; removed the obsolete "deep-path import / `ctx.jira.store()`" limitation.

### J4 (P1) jira: superagent teardown

- **Fix**: `createSuperagentContribution` adds `disposed` (`superagent.ts:4073`), `poll()` checks it at entry and after the daemon pass (`:4114`, `:4128`), `onTurnEnd` checks it at entry (`:4532`), and `dispose()` sets it before releasing (`:4546` onward).
- **Comments**: state explicitly that the `dispose()` contract is synchronous and that `dispatchStore.close()` is **intentionally not awaited**, with failures only logged (`:4557-4562`).
- **Tests**: `superagent.test.ts:2480` disposes the minimal host twice consecutively and asserts that `onTurnEnd` after disposal does not reject.

### P2 (completed)

- **Memory text helpers**: added `packages/uitstalie/memory/src/text.ts` (`byteLength`/`truncateToBytes`/`errorMessage`) and removed 3×3×4 copies from `read/snapshot/summary/checkpoint/memory-file`.
- **UI conditional hooks**: split `MemorySection.tsx` into an outer prop guard + `MemorySectionBody` (`:60`), and `JiraSection.tsx` into an outer component + `JiraSectionBody` (`:77`), so hooks no longer follow early returns; `JiraSection`'s optional settings hook uses a stable no-op fallback (`:50`, `:64`).
- **Small documentation/comments**: restored the dangling JSDoc in `ledger-settings.ts` to its position; changed the "replaces it once" title in `snapshot.spec.ts` to "appends a fresh one."

---

## 2. Commit map

| Change | Content | File scope |
|---|---|---|
| memory M1 + M2 + M3 + M4 + text helpers | Memory behavior, documentation, and text helpers | `packages/uitstalie/memory/**`, `ui-memory/README*`, `dafeiyu/README.md`, `pnpm-lock.yaml` |
| jira J1 + J4 | Failure envelopes and superagent teardown | `packages/jira/jira-agent/src/{index,superagent,superagent.test}.ts` |
| J2 delivery composition | Worker-preset wiring | `packages/bundle/web-app/cordis.patch.uitstalie.yml`, `packages/jira/tests/bundle-composition.spec.ts` |
| J3 service layer | Reconfigure fix | `packages/jira/jira-service/**` |
| J3 historical documentation | Historical-document corrections | `packages/jira/{README*,DESIGN,HANDOVER}`, `jira-agent/README*` |
| P2 UI hooks | Conditional-hook fixes | `packages/jira/ui-jira/src/client/{JiraSection,ledger-settings}.tsx/ts`, `ui-memory/src/client/MemorySection.tsx` |

Note: `memory/src/index.ts` carries M1/M2/M3 together, and `superagent.ts` carries J1/J4 together; they cannot be split further by file, so commits were organized by subsystem without mixing in any unrelated paths.

---

## 3. Deferred P2 items and reasons

| Item | Reason |
|---|---|
| Replace jira-core's atomic writes and locks with `packages/util/atomic-write` / `withFileLock` | Cross-module structural change involving jira-core's "zero runtime dependencies/offline copying" premise (decision 65) and Windows retry semantics; a separate commit and separate verification are safer and should not be mixed with this bugfix |
| Replace handwritten validation in `jira-core/src/schema.ts` with `zod` | Same as above; this is adapter-layer refactoring, and `schema.ts` serves both the CLI and tool surface, so the change surface exceeds the benefit |
| Merge the two home/path rules (`superagent-setup.ts` lexical vs `superagent.ts` realpath) | Their semantics differ (one is "configured paths are equal," the other is "physical directories are equal"); product semantics must be defined before unification; already listed in the review report, so left unchanged for now |
| Change `store.ts:114` to use `tagstore.decodeTag` | `loadTags` is a **tolerant read** (returns even without description/aliases), while `decodeTag` is **strict decoding** (returns `Result`); direct replacement would change read behavior and first requires a "tolerant decoding" intermediate layer, which is follow-up work |
| Split `superagent.ts` (4350 lines) | The user explicitly requested no high-risk structural changes in this round; the report already provides suggested split boundaries |
| Remove uncalled combinators from `result.ts` | They are public exports, and removal could affect callers outside this repository; evaluate separately rather than mixing with the bugfix |

---

## 4. Verification evidence

Executed serially on this machine (Windows); all passed:

| Command | Result |
|---|---|
| `node node_modules/vitest/vitest.mjs run packages/uitstalie/memory packages/uitstalie/ui-memory` | **122 passed / 11 files** (before the fix: 1 failed / 118 passed) |
| `node node_modules/vitest/vitest.mjs run packages/jira` | **96 passed / 18 files** (including `superagent-real-loop`, which previously timed out at 60s and passed in 25s this time) |
| `pnpm run test:jira:node` | **776 passed** (jira-agent 173, jira-cli 38, jira-core 565; 774 before the fix) |
| `node node_modules/typescript/bin/tsc -b packages/uitstalie/memory/tsconfig.json packages/uitstalie/ui-memory/tsconfig.client.json packages/uitstalie/dafeiyu/tsconfig.json packages/jira/jira-agent/tsconfig.json packages/jira/jira-service/tsconfig.json packages/jira/ui-jira/tsconfig.client.json` | **exit 0** |
| `pnpm install --lockfile-only --offline` | Updated `pnpm-lock.yaml`, moving only memory's `dsh-llm`/`dsh-session` into the dependencies section |

### Two abnormal restarts during the fix (must be recorded)

During the fixes, the machine experienced an abnormal power loss/hard reset at 18:42:57 and again at 18:51:41 (System log `Kernel-Power 41` + `6008`; `BugcheckCode=0`, `PowerButtonTimestamp=0`, no 1074, no dump/minidump). Both occurred during jira test load. The repository source contains no `shutdown`/`Stop-Computer`, and my new tests do not start subprocesses; the event characteristics look more like power/thermal/hardware protection triggered by heavy load (the machine also has the same 41 records on 10-17, 10-19, and 11-06).

Therefore, this round's verification changed to **serial** execution (node suites first, then vitest, then memory), and everything passed; however, this does not establish that "the hardware is fine." If this machine will continue running the full test suite, first investigate power/thermal/memory and use `--maxWorkers=1` to reduce peak load.

---

## 5. Remaining risks

1. **M4 is a documented known cost, not a hard limit**: long sessions can still accumulate multiple snapshots (each ≤16 KiB); an eviction policy needs a separate product decision.
2. **`jira-agent` places `jira-service` in devDependencies**, while `lib/types` references its types; the package is private, but this remains a type-resolution risk for consumers outside the repository (listed in the review report; not changed here).
3. **Superagent's `dispose` still cannot wait for `dispatchStore.close()`**: this is a limitation of dafeiyu's `CapabilityContribution.dispose(): void` contract; this change only guarantees "stop accepting new work + log failures," and complete closure requires a contract upgrade.
4. **The full-repository `pnpm test` was not run this round**: the worktree still has unrelated uncommitted changes (session/sandbox, etc.), so full-repository results could not be attributed; relevant suites were run separately by subsystem.
5. **J2's dispatch chain was not verified on a real GUI machine**: composition tests prove that the preset is paired and the capability is disabled by default; actually opening superagent still requires setting `superagent_home`, which is a deployment step rather than a code path.

---

> These fixes were not pushed; no commits unrelated to memory/jira were created; none of the user's uncommitted work was deleted or reverted.
