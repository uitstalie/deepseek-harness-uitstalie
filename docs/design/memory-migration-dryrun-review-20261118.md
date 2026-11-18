# Memory migration dry run on real data: classification precision and the business-history gap

English | [中文](memory-migration-dryrun-review-20261118.zh.md)

Status: review memo. The dry run ran on the seven real workspaces and wrote no memory data; no migration was applied, and this change modifies documentation only. The evidence is the untracked report `prompt-audit/memory-migration-dryrun-20261118.md` (569 lines, 152,690 B, file SHA-256 `61b4e521db3c959630048cbd1901369a3e678721041fb4dab87104845967bdc2`); the report's own confirmation hash is `8c14917baae312c048d0cc298b892e172f50ddaf162dd5304a62cc4704c58f97`.

## 1. Scope and evidence

The run covered `superagent`, `deepseek-harness-uitstalie-dev`, `rimworld`, `qq-bridge-uitstalie`, `mo`, `display`, and `Stardew Valley`. The command was `node_modules/.bin/tsx packages/uitstalie/memory/scripts/migrate-global-memory.ts`, with one `--workspace` per registered workspace; the dry run is the default, and the report was captured at `prompt-audit/memory-migration-dryrun-20261118.md`.

| Measure | Report value |
|---|---|
| Workspaces | 7 |
| Existing memory files | 11 |
| Scanned paths | 14 |
| Entries | 416 |
| Entry text | 85,097 B |
| Global candidates | 27 (4,713 B) |
| Discarded | 389 |
| Classes | global 27, dispatch 62, business 174, persona 6, unclassified 147 |

The report is untracked in this workspace and is not part of this change. Its `Report hash` is the apply confirmation token, not the SHA-256 of the report file: `--apply <hash>` rescans and compares the token, while `sha256sum` over the file returns `61b4e521…` because the report text carries the generation timestamp and formatting. This memo cites candidate numbers and report line numbers from that 2026-11-18 copy.

## 2. Conclusion

The run settles the magnitude question and not the classification question. 389 of 416 entries (93.5%) are not global facts, and 27 (6.5%, 4,713 B) are proposed for migration; that supports the design's judgment that the vast majority of the legacy entries were never global facts. Precision does not support apply: 23 of the 27 candidates are session state, a removed mechanism, or workspace business, and only 4 can be argued as global. The business and unclassified volume exposes a retrieval gap, not a missing physical archive.

| Finding | Kind | Evidence | Consequence |
|---|---|---|---|
| 23 of 27 candidates are not global facts | real problem | sections 3.1–3.3; candidates #1, #3, #5–#12, #14–#15, #17–#27 | apply would add one-shot state, dead contracts, and workspace business to `GLOBAL.md` |
| 8 candidates describe mechanisms removed in Steps 3–4 | real problem | #5–#12; 10 records in the report name a removed capability | apply would freeze a dead contract as a permanent convention |
| 321 business and unclassified entries have no live retrieval path | design gap | 174 business + 147 unclassified; workspace `MEMORY.archive.md`; `memory_search` reads only the global store | the archive bytes survive, but no surface reads them and the design names no owner |
| `Summary` says 11 files while `Files` lists 14 paths | report presentation | 3 archives are missing: `display`, `qq-bridge-uitstalie`, `mo` | readers see an apparent count mismatch |
| Entry bytes and file bytes are different measures | report presentation | 85,097 B of entry text; 188,169 B on disk | the `85097 B` beside `entries` is not a file total |
| `Report hash` differs from the file SHA-256 | report presentation | `8c14917b…` vs `61b4e521…` | `sha256sum` does not reproduce the confirmation token |
| `discard` lines name no destination | report presentation | 389 discarded entries | a reader cannot see that apply appends active-file discards to the workspace archive |

## 3. Candidate classification

The report proposes 27 global candidates. Under the design's own definition — a cross-workspace fact or convention — 23 do not qualify. Even if the six workspace-business records were reclassified, 17 of 27 would still be session state or removed mechanisms.

| Category | Candidates | Count |
|---|---|---|
| Session or task state | #1, #3, #14, #17, #18, #21, #22, #23, #26 | 9 |
| Removed or superseded memory mechanism | #5, #6, #7, #8, #9, #10, #11, #12 | 8 |
| Workspace business or preference | #15, #19, #20, #24, #25, #27 | 6 |
| Arguably global | #2, #4, #13, #16 | 4 |

### 3.1 Session and task state

These entries record where a task stood at one moment: #1 says game-launch verification was not done; #14 says the dev worktree has only four expected untracked items; #17 asks the next launch to confirm the SMAPI log; #18 records a mod-list baseline of 139 → 138; #21 says `pnpm install` has not run; #22 says the JIRA removal needs a human decision; #23 records a one-time `node_modules` diagnosis; #26 is a RimSort confirmation step. A next step or a worktree snapshot is not a cross-workspace convention, and migrating it would make a transient state permanent.

### 3.2 Removed and superseded mechanisms

Eight candidates describe memory behavior that Steps 3–4 removed: #5 proposes overflow eviction and assumes no `memory_forget` exists; #6 specifies summary-failure notices; #7 and #11 state TTL defaults and `memory_resolve`; #8 and #12 describe `summarizeEveryTurns`; #9 describes batched summary turns; #10 records the TTL → supersession → dedupe → capacity order. The per-turn summary job, live TTL cleanup, `memory_resolve`, and snapshot injection are gone from the model and human surfaces, as `memory-scoping.md` §9 and §12.1 record. The legacy settings row and parser remain for old files, so the text is not merely old: it describes behavior no current surface performs.

A text search finds eleven records that mention one of `TTL defaults`, `memory_resolve`, `summarizeEveryTurns`, summary batching, or `snapshot`: candidates #7, #8, #9, #11, #12 and discarded entries at report lines 264, 296, 312, 326, 364, and 442. Ten name a removed capability; line 296 is a persona entry about stale design snapshots, not the memory snapshot. Migrating the ten would make a dead contract a standing global convention.

### 3.3 Workspace business and preferences

Six candidates belong to one workspace: #15 records `setup-dsh.mjs` behavior in the dev checkout; #19 records a Stardew research permission; #20 records an approval-policy setting; #24 records an uncommitted ReGrowth2 file; #25 records the RimSort user-rule schema; #27 records the spout smoke tint conclusion. The design says business history stays in its workspace and global memory holds cross-workspace facts; these are workspace facts or permissions, and #20 is a session setting that should not become a global default.

### 3.4 Plausible global records

Four candidates can be argued as global, and the set is still not clean. #2 records a KWin startup constraint but proposes `global-account`, while the content is a machine fact; #4 records `write_like_human` root-only visibility but anchors it to a prompt section number; #13 records the one-time migration's dry-run default; #16 records the task state machine. #16 is the clearest durable convention; #4 is a harness behavior that belongs in its owner; #13 is a procedure for a one-time tool; #2 has the wrong topic. At most two of the four are ready to migrate without a second review.

## 4. Report presentation

The report is usable, but five presentation choices invite a wrong reading.

- Files: `Summary` counts 11 existing files, while `Files` prints 14 scanned paths. Three archives are missing — `display`, `qq-bridge-uitstalie`, and `mo` — so the difference is explained by the report itself, not by a scan error. The missing set is three of seven archives, not a majority.
- Bytes: `Summary` reports `entries: 416 (85097 B)`, the sum of entry text; the `Files` lines report on-disk file sizes and sum to 188,169 B. Both numbers are correct, but the report does not label the measure.
- Hash: `Report hash:` is the apply token over the scan payload. The file's SHA-256 is `61b4e521…`. The design calls it "the report's SHA-256 hash" (§8.2), which reads as a file checksum.
- Discard destination: every discarded line says `discard` and stops. It does not say that apply appends a record to the workspace `MEMORY.archive.md`, so a reader cannot verify preservation from the report alone.
- Truncation: discarded text is cut at 200 characters, and 121 of the 389 discarded rows end in an ellipsis. The report lists every entry but is not a full-content archive; long text remains only in the source file and, after apply, the workspace archive.

## 5. Design gaps

### 5.1 Business history has no live retrieval path

The design says business history stays in its workspace and the workspace archive is legacy data (`memory-scoping.md` §12.1). Apply preserves it physically: `applyMemoryMigration` appends a record for every discarded entry from an active file to that workspace's `MEMORY.archive.md` before rewriting the active file, with the detail `discarded by migration (business: …)` and archive reason `migration`; entries already in the archive stay there. The test `apply migrates only confirmed global entries, backs up every changed file, and keeps old files parseable` asserts the discarded text and `"reason":"migration"` in the archive.

The earlier finding that the migration has no workspace-side archive path is therefore wrong. The gap is retrieval and durability: after Step 4, `memory_search` reads `GLOBAL.md` and `GLOBAL.archive.md` only; no tool reads the workspace archive; and the design names no owner for business history beyond "stays in its workspace". The source files still hold every entry, and apply copies active-file discards to the archive, so the dry-run report is not the only copy of the text. It is the only cross-workspace, classified inventory, and the default dry run writes no file — this run's report exists only because it was written to an untracked path, and an apply would store `report.md` under `$DSH_HOME/memory/migration/runs/<run-id>/`. The design does not say whether either copy is the retained record or which surface should answer a later business-history question.

### 5.2 The global class has no operational test

The design defines `global` with examples — shared server address, harness default model, shared rules, cross-workspace preference — and leaves task and session state to the `dispatch` class and workspace facts to `business`. The classifier's reason strings are one-line categories such as "a shared convention" and "a shared tooling fact". They do not distinguish a durable convention from a next step, a worktree snapshot, or a one-time diagnosis, which is why #1, #14, #17, and #18 pass as `global`. This is a design gap: the class table is prose, and no test or fixture states which one-shot records must be rejected.

## 6. What this round does not do

This round changes documentation only. It does not change `packages/uitstalie/memory/src/migration.ts` or the classifier, does not apply the report to real data, does not run a rollback drill, and does not choose a destination for business history. The 27 candidates stay unconfirmed; the apply step in §14.4 of `memory-scoping.md` stays unchecked.

## 7. Reproduction

- Run the dry run with one `--workspace` per registered workspace and capture the report to a file; confirm that `$DSH_HOME/memory` is unchanged.
- Check the file hash with `sha256sum prompt-audit/memory-migration-dryrun-20261118.md`; compare it with the report's `Report hash` only to see that they are different measures.
- Read the candidate and discarded sections for #1, #14, #17, #18, #7–#12, and the lines cited in §3.2.
- Run the migration test that proves the archive append: `pnpm exec vitest run packages/uitstalie/memory/tests/migration.spec.ts`.
