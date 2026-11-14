# Branch artifact slimming proposal (2026-11-13)

English | [中文](slimming-proposal-20261113.zh.md)

Status: inventory and proposal; on 2026-11-13 the user decided to keep `docs/inputs`, delete only 6 documents in batch 1, and defer batch 3a; this page keeps the original proposal.

## 0. Scope and conventions

**Our own artifacts:** the patch/preset files under `packages/uitstalie/*`, `packages/jira/*`, `packages/superagent/*`, `packages/bundle/*`, plus `goal/` and the `docs/**`, `scripts/**`, `tests/**` that we wrote.

**Native:** upstream repository content, that is, files outside the paths above that carry no `uitstalie-` marker. Native files are never deleted or changed in this round; we only propose ways to reduce intrusion.

This proposal rests on the current working tree (the drafting HEAD), `git grep`, in-package tests, and document references, not on impressions.

## 1. Documents · expired (delete)

| Path | Lines / size | Evidence | Deletion prerequisite |
|---|---:|---|---|
| `docs/inputs/correction-patterns-20261113.md` | 199 lines / 12,334 B | One-off analysis input; its conclusions are already inlined in sections 0/2 of `docs/design/dafeiyu-personality-plugin.md`; not product documentation | Change "inputs kept in docs/inputs" at the top of the design doc to "inputs inlined and deleted" |
| `docs/inputs/windows-superagent-eval-handoff-2026-11-09.md` | 91 lines / 6,467 B | One-off handoff draft duplicating `docs/reviews/windows-superagent-eval-handoff-2026-11-09.md`; the formal handoff stays | No references in the design or audit docs; confirm with `rg` before deleting |
| `docs/reviews/2026-11-07-memory-jira-implementation-review.md` + `.zh.md` + `.i18n.yaml` | 257 + 257 lines / 109,433 B | Review from the old grade C; its J/M items are now covered by `docs/reviews/audit-fix-coverage-20261110.*` and current tests; the old document holds local absolute paths | Confirm there are no external references first; the audit doc still keeps the conclusions after deletion |
| `docs/reviews/2026-11-07-memory-jira-fixes.md` + `.zh.md` + `.i18n.yaml` | 109 + 109 lines / 36,428 B | One-off fix log; "M1–M4 fixed" is superseded by package tests and the audit table; out of sync with the current code | Delete in the same batch as the row above; confirm there are no external references first |

Total: **8 files, about 1,022 lines of Markdown** (6 of them with i18n records), about 165 KB.

**Kept, not deleted:**

- `docs/reviews/windows-superagent-eval-2026-11-09.*`: still the only on-device Windows evidence; only the local paths are removed, the file stays.
- `docs/reviews/windows-superagent-eval-handoff-2026-11-09.*`: the k3.1 re-review and the main evaluation reference it; keep it as a historical handoff.
- `docs/reviews/audit-fix-coverage-20261110.*`: the current remediation ledger; keep.
- `goal/mission/task*.md`: `goal/mission/FROZEN.md` freezes them explicitly as historical archives; not deleted.
- `packages/jira/HANDOVER.md` / `MIGRATION.md` / `DESIGN.md` / `ARCHIVE-SOURCE.md`: the page headers already mark them historical, but `jira-core/README`, the error-code tests, and decision references still depend on them; deleting them would break doc links and tests first, so they cannot be in this round.
- `docs/design/dafeiyu-personality-plugin.*`: current design; keep.

## 2. Documents · errors (edit)

| Path | Original sentence | Proposed sentence | Evidence |
|---|---|---|---|
| `goal/native-change-inventory.md` | `| 原生改动，带标记 | 73 | ... |`; body text "73 files" | `| 原生改动，带标记 | 102 | 2026-11-13 的 git grep 结果（源/配置；另 10 个原生文档） |`; body text changed to 102 | Current `git grep -l "uitstalie-"` (excluding `goal/`, `docs/`, and our own package groups) is **102**; the old count 73 is stale |
| `docs/reviews/windows-superagent-eval-2026-11-09.md` | ``- dev: `<dev-checkout>`, branch `cli-desktop`, on the same baseline as the runtime.`` | ``- dev: `<dev-checkout>`, branch `cli-desktop`, on the same baseline as the runtime.`` | Documentation portability; local absolute paths must not be committed |
| Same as above `.zh.md` | ``- dev：`<dev-checkout>`，分支 `cli-desktop`，与 runtime 使用同一基线。`` | ``- dev：`<dev-checkout>`，分支 `cli-desktop`，与 runtime 使用同一基线。`` | Edit both languages as a pair; other `D:\dqc\...` occurrences in the same paragraph also become `<dev-checkout>` / `<super-workspace>` |
| `docs/reviews/2026-11-07-memory-jira-implementation-review.md` | ``> Review target: `<dev-checkout>`, branch ...`` | If the document stays, change it to `> Review target: <dev-checkout>, branch ...` | The document is already in the deletion batch; if it is kept instead, the Chinese side must change too and the pairing be re-recorded |

`docs/reviews/2026-11-07-memory-jira-fixes.md` is not edited on its own: the whole file goes into the deletion batch, avoiding "edit, then delete".

**Not treated as errors, do not change:**

- In `docs/reviews/windows-superagent-eval-2026-11-09.*`, "the build then failed with 4 unused imports" is a dated historical fact, not the current state; keep the original sentence.
- `packages/jira/HANDOVER.md` / `DESIGN.md` / `MIGRATION.md` already mark themselves historical at the top; the body is not changed unless the whole document is archived.

## 3. Code · deprecated/obsolete

### (a) No references at all

We found **no** branch source file that is completely unreferenced at whole-file level; `rg` finds package/composition or test references for `packages/uitstalie/personality`, `packages/uitstalie/ui-personality`, and `packages/uitstalie/persona-card` alike. Do not delete files that "look unused" just to pad the numbers.

### (b) Referenced but superseded

| Path | Size | Superseded by | Test coverage | Disposition |
|---|---:|---|---|---|
| `packages/uitstalie/personality/**` | 15 ts/tsx/md files, **4,937 lines / 211 KB** | The new global implementation in `docs/design/dafeiyu-personality-plugin.md` (not yet implemented) | 4 test files (`commands`/`personality-file`/`provider`/`watch`), about 1,487 lines | **Not deleted now**. Replace the whole package once the new design is implemented; the old tests go together with the old code, and tests cannot be deleted first |
| `packages/uitstalie/ui-personality/**` | 13 ts/tsx/md files, **1,136 lines / 44 KB** | The new output-style / writing-rules UI (sections 8/7 of the design doc) | Three tests: `entry.host`, `personality-section.client`, `settings-form.client` | Deleted in the same batch as personality; the old proposal page does not stay |
| `--permission-mode` old flag | `packages/bundle/headless/src/startup.ts` (about 5 places), `src/index.ts` (2 legacy fields), `tests/startup.spec.ts` (3 cases) | `--policy` (the current official flag) | `startup.spec.ts` has a dedicated "retired flag warning" case | Can be deleted; update README, `docs/cli-help.*`, tests, and release/upgrade notes in the same change. Even after deletion it remains a breaking CLI change and needs its own release note |

### (c) Experimental/not wired

We found no branch package that is "completely unwired and safe to delete wholesale". `persona-card` is off by default but is explicitly mounted by `cordis.patch.uitstalie.yml`; it is a deliberate experimental feature and is not listed for deletion.

**Deletion volume for the old personality:** 28 files, 6,073 lines, about 255 KB, including 4 test files and about 1,487 lines. **The prerequisite is** that the new design is implemented with equivalent tests; otherwise the deletion removes the personality capability entirely.

## 4. Native intrusion inventory

The current `git grep -l -e "uitstalie-" -e "dsh-uitstalie"` (excluding `goal/`, `docs/`, and our own package groups) yields **102 source/config files**; another **10 native documents** carry the marker. The 73 in `goal/native-change-inventory.md` is an old baseline and is stale. The table below groups files by intrusion surface; the full per-file list comes from that command, and key files are listed separately.

| Intrusion group | Files | Typical change | Can return to native | Minimum range that must stay |
|---|---:|---|---|---|
| Unmarked search default | 3 | `openAt: first-search` in `packages/bundle/base/cordis.patch.yml` and `packages/bundle/web-app/cordis.patch.yml`; the expectation in `apps/cli/tests/lazy-search-startup.compat.spec.ts` | **Yes** | Restore `never` natively; override it to `first-search` from `cordis.patch.uitstalie.yml`, and put the branch test in `packages/uitstalie/**` or a new file under `apps/cli/tests` |
| CI static gate | 1 | The jira node:test step in `.github/workflows/ci.yml` | **Yes** | Delete the native workflow block; the local `scripts/run-gates`/CI side uses a separate branch file |
| Root rule | 1 | The Windows ACL line in `AGENTS.md` | **Yes** | Delete that line; the restriction is already documented in `docs/subsystems/sandbox` and the `goal` docs |
| base composition | 1 | The home-write block in `packages/bundle/base/cordis.patch.yml` | **Yes** (must verify the branch patch layer applies after it) | Move it to `cordis.patch.uitstalie.yml` and leave only a blank line natively |
| web/base package manifests | 2 | Branch dependencies and patch arrays in `packages/bundle/{base,web-app}/package.json` | **Not fully** (a native package must declare the patch/dependency to mount it) | Keep only the minimum dependencies plus one `*.uitstalie.yml` reference; bundling the branch is a separate item |
| Build/gate configuration | 20 | `tsconfig.base/host/client`, `vitest.config.ts`, and 15 `scripts/*` branch classification/exemption entries | **Not fully** | Keep only the lines needed to register branch packages and generate branch directories; delete one-off exemptions and string special cases |
| Native export seam | 1 | About 20 lines of exports in `packages/context/agent-instructions/src/index.ts` | **No** (plus needs the internal state machine) | Keep only the export block; mid-term, propose a stable seam upstream |
| Windows/file behavior | About 40 | The `uitstalie-` blocks in `packages/sandbox/*`, `packages/shell/*`, `packages/fs/*` | **No** (the Windows ACL/soft-policy fixes are the behavior value) | Keep only the minimal blocks for fail-closed, classification, and fencing |
| Test support | 4 | The `$stream`/roster stand-ins in `packages/test-support/client-runtime/*` | **Not fully** | Keep only the stand-ins the branch Web roster needs |
| Runtime loader | 1 | The v1/v2 shape probe in `vendor/loader/src/internal.ts` | **No** (the branch runtime depends on it) | Keep this one place; do not extend it |
| Native README/docs | 2 + 2 | The uitstalie line in `packages/README.*`; the hand-written marker in `docs/subsystems/sandbox.*` | **README yes**; the sandbox doc can only be narrowed | The README line can move to `packages/uitstalie/README`; the sandbox doc keeps only the restriction note and does not restate the implementation |

**Item by item** (high-impact files):

- `packages/bundle/web-app/cordis.patch.yml`: `openAt: first-search` is an **unmarked** native change and must be fixed first.
- `packages/bundle/base/cordis.patch.yml`: `openAt: first-search` + the home-write block; the former is unmarked, the latter has a DH-902 marker.
- `apps/cli/tests/lazy-search-startup.compat.spec.ts`: a native test changed for first-search; it must be reverted together with the previous item.
- `.github/workflows/ci.yml`, `AGENTS.md`: one CI block and one rule line; both can return to native.
- `tsconfig.*`, `vitest.config.ts`, `scripts/*`: 20 files in total, the plumbing that lets branch packages build; not feature code, but the most markers.
- `packages/context/agent-instructions/src/index.ts`: the only "native internal API export" seam; keep.
- `packages/sandbox/*`, `packages/shell/*`, `packages/fs/*`: about 40 files that carry Windows/policy behavior; keep them, and do not revert them for the sake of "zero intrusion".

## 5. Intrusion reduction proposals (ordered by footprint)

| Priority | Proposal | Type | Expected benefit |
|---:|---|---|---|
| 1 | Restore `openAt: first-search` in base/web to the native `never`; override it in `cordis.patch.uitstalie.yml`; restore the native CLI test and add a separate branch test | ① Fully back to native | Removes 2 unmarked native config changes + 1 native test; first-search still works |
| 2 | Delete the branch block from `.github/workflows/ci.yml`; run jira node:test from a branch script/branch workflow file instead | ① Fully back to native | One fewer native CI conflict point |
| 3 | Delete the Windows ACL line from `AGENTS.md`; the restriction is already in docs and goal | ① Fully back to native | One fewer root-rule conflict point |
| 4 | Move the base home-write block into `cordis.patch.uitstalie.yml` | ① Fully back to native (verify layer order) | One fewer native patch conflict point |
| 5 | Narrow `packages/bundle/{base,web-app}/package.json` to "one branch patch + minimum dependencies"; move dependencies into the branch bundle's package | ② Keep but narrow | Only registration lines remain in the native JSON; branch dependencies are centralized |
| 6 | Keep only registration and generation lines in `tsconfig.*`/`vitest.config`/`scripts/*`, and delete one-off string exemptions | ② Keep but narrow | Marker blocks in 20 files shrink; cannot reach zero (branch packages must be registered) |
| 7 | Keep the `agent-instructions` export block; delete it after proposing the seam upstream | ③ Must keep | 20 lines of internal dependency; leave it alone for now |
| 8 | Keep the Windows fixes in sandbox/shell/fs; narrow them to what fail-closed and classification need | ③ Must keep | About 40 files cannot return to native; reverting them reintroduces Windows failures |
| 9 | Keep `test-support`/`vendor/loader`/the native README line | ③ Must keep / minimal | Test and runtime dependencies; the README could move to branch docs, with little benefit |

**Expected footprint:** 102 marked source/config files; proposals 1–4 remove about 6 native files/conflict points (102 → about 96); 5–6 only shorten blocks and remove no files; 7–9 do not change. **Do not treat "102→96" as a big win**: the real remaining bulk is 40 Windows behavior files and 20 build plumbing files.

## 6. Phased execution plan (not executed this round)

### Batch 1: Document cleanup (low risk, do first)

**Delete:**

- `docs/inputs/correction-patterns-20261113.md`
- `docs/inputs/windows-superagent-eval-handoff-2026-11-09.md`
- `docs/reviews/2026-11-07-memory-jira-implementation-review.{md,zh.md,i18n.yaml}`
- `docs/reviews/2026-11-07-memory-jira-fixes.{md,zh.md,i18n.yaml}`

**Correct:**

- 73 → 102 in `goal/native-change-inventory.md` (and re-run `git grep -l` to record the date).
- Change the local paths in `docs/reviews/windows-superagent-eval-2026-11-09.md` / `.zh.md` to `<dev-checkout>` / `<super-workspace>`; re-record the pairing as a pair.
- In the design doc header, change "inputs kept in docs/inputs" to "inputs inlined, files deleted".

**Impact:** doc links/pairing/goal references. Check with `rg` before executing; after deleting, run `pnpm run verify-translation-pairing`, `verify-md-links`, `test:docs`.

**Rollback:** one commit; `git revert <sha>` restores all documents and sidecars. No build impact.

### Batch 2: Deprecated CLI flag (small code change, needs a separate decision)

**Changes:**

- Delete the `--permission-mode` option, the alias parsing, and the warning from `packages/bundle/headless/src/startup.ts`.
- Delete the legacy `permissionMode` read path from `packages/bundle/headless/src/index.ts`.
- Delete/rewrite the 3 alias cases in `packages/bundle/headless/tests/startup.spec.ts`.
- Drop the old flag from `packages/bundle/headless/README.md` and `docs/cli-help.*`; keep the historical upgrade guides (they record history).
- A new release note is required: this is a breaking CLI deletion, not a "silent cleanup".

**Impact:** headless build/tests, CLI help generation, doc pairing. **Rollback:** one commit.

### Batch 3: Old personality + native intrusion (high risk, blocked on the new design)

**3a Old personality:**

- Delete `packages/uitstalie/personality/**` (28 files, 6,073 lines) and `packages/uitstalie/ui-personality/**` (10 files).
- Delete the bundle mount lines, the old config, and the old tests; per the design, the old `PERSONALITY.md` is only backed up/moved, and this commit does not delete user data.
- **Prerequisite:** the new `personality_analyze` / `personality_apply`, output-style, and writing-rules have equivalent tests; otherwise execution is forbidden.

**3b Native intrusion:**

- Restore native `openAt: never` in base/web; override first-search in `cordis.patch.uitstalie.yml`; restore the native CLI test.
- Delete the native CI block, the `AGENTS.md` line, and the base home-write block (verify the branch patch layer order first).
- Narrow the leftover markers in `tsconfig`/`scripts`; do not touch the Windows behavior in sandbox/shell/fs.

**Impact:** build 10/10, typecheck 5/5, the six-file tests, memory/personality tests, CLI smoke, pairing. **Rollback:** one commit each for 3a and 3b; deleting user data is outside rollback scope (data is only moved/backed up).

## 7. Expected deletion volume

| Category | Files | Lines (approx.) | Notes |
|---|---:|---:|---|
| Document deletion | 8 | 1,022 | 2 inputs + 6 old memory review/fixes |
| Document corrections | 5 | Few | 2 English/Chinese pairs + goal + pairing |
| Code deletion (old personality) | 28 | 6,073 | Wait for the new implementation; includes 4 test files, 1,487 lines |
| Deprecated CLI flag | 0 (only 7 files changed) | About 50 | Delete option/branches/tests, no files deleted |
| **Total deletions** | **36** | **About 7,100** | Docs about 165 KB + old personality about 255 KB |

Native intrusion is not counted in "files deleted": proposals 1–4 remove about 6 native conflict points, 5–6 only shorten blocks, and 7–9 must stay.

## 8. Explicitly not deleted/changed

- Do not delete native files, or tests that still have behavior value.
- Do not delete `goal/mission/task*.md` (FROZEN), the current audit/design, the Windows on-device evaluation, or the formal handoff.
- Do not delete the old `PERSONALITY.md` user data; per the design it is only moved/backed up.
- Do not put the old `--permission-mode` deletion and the personality deletion in the same commit.
- No drive-by refactoring and no feature changes; this round only proposes.
## 9. Execution result

- Batch 1: 13 files, +474/−1,226; deleted 6 old memory/jira review and fix documents, kept `docs/inputs`; pairing 1,303 pairs, md-wrap 2,658 files, and md-links 2,621 files passed.
- Batch 2: 14 files, +101/−81; removed `--permission-mode`; build 10/10, typecheck 5/5, headless 135/135; release note added.
- Batch 3b: 8 files, +40/−39; restored native `openAt: never`, branch patch overrides with `first-search`; build 10/10, typecheck 5/5; a real memory-tool search hit in 46 ms first and 6 ms second; native markers **102 → 99**.
- Batch 3a: old personality deletion is **deferred until after the new implementation**; not done in this round.
- The remaining 99 items are retained in full under the 2026-11-13 user decision in `goal/native-change-inventory.md`; Windows ACL and the agent-instructions export seam are explicitly not slimming targets.

**Conclusion: slimming stops here; future work only approves each new intrusion one by one.**
