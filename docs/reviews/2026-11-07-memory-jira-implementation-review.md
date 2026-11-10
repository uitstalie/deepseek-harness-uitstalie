# memory / jira plugin implementation review

English | [中文](2026-11-07-memory-jira-implementation-review.zh.md)


> Review target: `D:\dqc\deepseek-harness-uitstalie-dev`, branch `cli-desktop`, HEAD at the review-day `cli-desktop` baseline Review method: read-only code review + read-only test runs; **no reviewed code or configuration was modified, and nothing was committed or pushed**. Review date: 2026-11-07

---

## 0. Executive summary

### memory — Rating **C** (usable but has gaps; tests are red at HEAD)

`@deepseek-ai/dsh-memory` and `@deepseek-ai/dsh-client-ui-memory` have substantially implemented their declared capabilities: three tools, append-only snapshots, `detail/brief/forget` three-tier migration, the 7 `/memory` subcommands, the history sidecar, the version guard, and job deduplication all have real implementations; this is not a skeleton. However, it currently has a **correctness defect that reproduces consistently at HEAD**, together with extensive contradictions between the documentation and implementation, so it receives C rather than B.

The 3 most critical issues:

1. **Canceled or errored turns also start summary jobs and write a “Memory summary failed” user message.** The organizer dispatches every `turn/end` (`packages/uitstalie/dafeiyu/src/index.ts#L336`), memory's `onTurnEnd` does not check `reason.kind` (`packages/uitstalie/memory/src/index.ts#L257`), and `readTurnConversation` accepts only `completed` and throws otherwise (`packages/uitstalie/memory/src/summary.ts#L448`, `packages/uitstalie/memory/src/summary.ts#L455`) → the failure branch writes a notice (`packages/uitstalie/memory/src/summary.ts#L374`). Memory's own test asserts that “an aborted turn does not start a summary job”; **that test fails consistently at HEAD** (`packages/uitstalie/memory/tests/summary.spec.ts#L236`).
2. **The documentation presents superseded semantics as current behavior, and the two languages and even the same document contradict one another.** The English README still says that `refreshMemorySnapshot` “replaces the snapshot in place, `surfaceOp: replace`” (`packages/uitstalie/memory/README.md#L67`, `packages/uitstalie/memory/README.md#L88`), while the implementation has long since changed to `surfaceOp: 'append'` and its comment explicitly says “never replaced in place” (`packages/uitstalie/memory/src/snapshot.ts#L420`-`packages/uitstalie/memory/src/snapshot.ts#L427`); elsewhere in the same README, `packages/uitstalie/memory/README.md#L134` and `packages/uitstalie/memory/README.md#L148` already describe the new semantics. The migration order, `onTurnEnd` contract, and `Window:` label are likewise old descriptions.
3. **The configuration and dependency declarations have drifted, and one runtime configuration switch silently stops working.** `inject` declares a `ctx.fs` dependency that is never used (`packages/uitstalie/memory/src/index.ts#L34`), and `package.json` lacks the `dsh-llm`/`dsh-session` runtime dependencies (`packages/uitstalie/memory/package.json#L26`-`packages/uitstalie/memory/package.json#L32`); after `snapshotPosition` changes to `prompt`, the already-wired agent's `promptSections` are not recomputed, while `syncMemorySnapshot` returns immediately in prompt mode (`packages/uitstalie/memory/src/snapshot.ts#L226`) → that session receives no further snapshots and reports no error.

### jira — Rating **B** (complete implementation; superagent subsystem usable but has gaps)

The ledger itself (`jira-core` / `jira-service` / `jira-agent` / `jira-cli` / `ui-jira`) is fully implemented: the single-writer service, `ctx.jira`, `remote.jira`, the three resident tools plus the executor `issue_work`, the write guard, `/jira`, three skills, and the push queue and settle behavior all have real implementations and substantial test coverage. **All 774 tests in the node suite pass.** The main deductions concern failure paths in the superagent subsystem, the reachability of the delivery composition, and the maintenance cost of a single 4,350-line file.

The 3 most critical issues:

1. **`toolFailure` violates its own declared output schema.** `SUPERAGENT_OUTPUT_SCHEMA` lists `me` as required (`packages/jira/jira-agent/src/superagent.ts#L928`), while `toolFailure` returns only `ok/error/writable` (`packages/jira/jira-agent/src/superagent.ts#L1729`-`packages/jira/jira-agent/src/superagent.ts#L1734`). It is used by `runSessionTool`'s fallback catch (`packages/jira/jira-agent/src/superagent.ts#L2451`), so the branch intended to produce a readable failure is instead masked by the host's `ToolOutputError`.
2. **The entire dispatch chain is unreachable in the delivery composition.** The `superagent` capability is disabled by default (`enabledByDefault: homeProblem === undefined`, `packages/jira/jira-agent/src/index.ts#L228`); the row patch does not configure `superagent_home` (`packages/bundle/web-app/cordis.patch.uitstalie.yml#L35`) or `superagent_worker_preset`, and `superagentDispatch` rejects immediately when the preset is unset (around `packages/jira/jira-agent/src/superagent.ts#L3700`). UI setup writes only `superagent_home` (`packages/jira/jira-service/src/superagent-setup.ts#L111`-`packages/jira/jira-service/src/superagent-setup.ts#L115`), so users cannot add the worker preset through the interface. `packages/bundle/web-app/presets/jira-worker.patch.yml` defines the `jira-worker` preset, but it is not connected.
3. **Structural debt and documentation debt compound each other.** `superagent.ts` has 4,350 lines (including a 653-line `runSessionTool` and a 505-line `createSuperagentContribution`); meanwhile, the `jira-service` README still says that “the only write is `superagentConfirm`” (`packages/jira/jira-service/README.md#L55`), while `superagentSetup` creates directories, registers a workspace, and writes profile configuration (`packages/jira/jira-service/src/remote.ts#L230`-`packages/jira/jira-service/src/remote.ts#L259`). All of `HANDOVER.md` still describes the external repository's single-package structure (`src/core`, `dist/`, 702 tests).

---

## 1. Review scope, method, and exclusions

### 1.1 State separation

| Category | Content | Treatment |
|---|---|---|
| Committed at HEAD | The two memory packages, the five jira packages and their group-level tests, `cordis.patch.uitstalie.yml`, `jira-worker.patch.yml`, and the four jira documents | **Reviewed here** |
| Uncommitted working-tree changes | At the start of the review, `git status` listed 78 entries (excluding this report), concentrated in `packages/core/session*`, `agent-loop`, `session-query`, `session-persistence*`, `packages/sandbox/*`, `docs/persistence*`, and `tool-cordis/api-catalog.ts` | **Unrelated to memory/jira and not reviewed**; disclosed only as the environment in which tests ran |
| Untracked files | `.dsh/`, `_tmp/`, two sandbox tests, `.dsh-probe.txt` | Unrelated to this review |
| Historical/experimental documents | `packages/jira/DESIGN.md`, `HANDOVER.md`, `MIGRATION.md`, and `ARCHIVE-SOURCE.md` were migrated from the external repository; `packages/jira/tests/*` is the group-level suite | Reviewed for stale documentation, but **not treated as the current implementation specification** |

Verified: `git status --porcelain -- packages/jira packages/uitstalie` was empty, and `git ls-files --others` was also empty under both groups. **The review conclusions for both plugins therefore correspond exactly to the review-day HEAD and are unaffected by working-tree changes.**

### 1.2 Verification actually run

| Command | Result |
|---|---|
| `node node_modules/vitest/vitest.mjs run packages/uitstalie/memory packages/uitstalie/ui-memory` | **1 failed / 118 passed** (failure: “an aborted turn does not start a summary job” in `summary.spec.ts`, `expected length 0, got 1`) |
| Same command, running only `packages/uitstalie/memory/tests/summary.spec.ts` | **The same failure reproduced consistently** (15 passed / 1 failed), ruling out test-order effects |
| `node node_modules/vitest/vitest.mjs run packages/jira` | **1 failed / 93 passed**; the failure was a 60s timeout at `packages/jira/tests/superagent-real-loop.spec.ts:162` (a real Session controller case) |
| `pnpm run test:jira:node` | **774 passed** (`jira-agent` 171, `jira-cli` 38, `jira-core` 565) |

Not run: the repository-wide `pnpm test` (affected by other uncommitted changes in this working tree, and time-consuming), real GUI compositions, and documentation checks such as `verify-translation-pairing`. See §9 for details.

---

## 2. Findings by dimension

### 2.1 Dimension 1: Degree of implementation

#### memory

| Declared capability | Status | Evidence and explanation |
|---|---|---|
| Fixed prompt section | Implemented | `packages/uitstalie/memory/src/prompt.ts` + `packages/uitstalie/memory/src/index.ts#L239` |
| `memory_write` / `memory_search` / `memory_read` | Implemented | Starting at `packages/uitstalie/memory/src/tools.ts#L109`, `packages/uitstalie/memory/src/tools.ts#L192`, and `packages/uitstalie/memory/src/tools.ts#L268` |
| Snapshot (depth-0 message / `memory-state` section) | Implemented, **but runtime switching has a gap** | `packages/uitstalie/memory/src/snapshot.ts#L209`-`packages/uitstalie/memory/src/snapshot.ts#L232`; see 2.2 |
| `detail`/`brief`/`forget` three-tier migration | Implemented; gated by compaction in production | `packages/uitstalie/memory/src/summary.ts#L327`-`packages/uitstalie/memory/src/summary.ts#L330`, `packages/uitstalie/memory/src/summary.ts#L349` |
| `/memory summaries\|stats\|prune\|pause\|resume\|edit\|revert` | Implemented | `packages/uitstalie/memory/src/commands.ts#L67`-`packages/uitstalie/memory/src/commands.ts#L198` |
| `MEMORY.history.json` sidecar | Implemented | `packages/uitstalie/memory/src/memory-file.ts#L784`, `packages/uitstalie/memory/src/memory-file.ts#L508` |
| Version guard + one retry | Implemented | `packages/uitstalie/memory/src/memory-file.ts#L755`, `packages/uitstalie/memory/src/memory-file.ts#L858` |
| One job per session + pending merge | Implemented | `packages/uitstalie/memory/src/summary.ts#L206`-`packages/uitstalie/memory/src/summary.ts#L290` |
| Failure notice | **Partially implemented (incorrect trigger condition)** | `packages/uitstalie/memory/src/summary.ts#L374`-`packages/uitstalie/memory/src/summary.ts#L386`; see “Present but nonfunctional” in 2.1 |
| Session-side search | Implemented but **has no test coverage** | The test `SessionQueryEngine` always returns empty (`packages/uitstalie/memory/tests/harness.ts#L47`-`packages/uitstalie/memory/tests/harness.ts#L55`) |

“Present but nonfunctional / happy path only”:

- **Failure notices for aborted/errored turns** (above). This is more than “one extra message”: every canceled turn occupies a job, runs a failure path, and may show the misleading “Memory summary failed” notice after the user merely pressed cancel.
- **A turn containing the first snapshot can never be collapsed**: `rawTurnTarget` explicitly rejects ranges containing a memory snapshot (`packages/uitstalie/memory/src/checkpoint.ts#L185`-`packages/uitstalie/memory/src/checkpoint.ts#L191`); when no snapshot already exists, the session's first `memory_write` appends a complete snapshot (`packages/uitstalie/memory/src/tools.ts#L158`-`packages/uitstalie/memory/src/tools.ts#L171`) → that turn's range can never be replaced, and every later pass retries it and emits a debug log. The README's description of “retry” does not explain that “some ranges will never succeed.”
- **The missing-`jobs` branch is unreachable**: `inject` already declares `jobs` (`packages/uitstalie/memory/src/index.ts#L34`), so the `ctx.get('jobs') === undefined` branch in `summary.ts` (`packages/uitstalie/memory/src/summary.ts#L236`) cannot occur in the real host; the corresponding test proves only that “the plugin does not activate without jobs,” not that branch.
- **`/memory revert <turn> extra text` is silently accepted**: `revertOne` reads only `parsed.turn` (`packages/uitstalie/memory/src/commands.ts#L187`-`packages/uitstalie/memory/src/commands.ts#L190`); extra arguments are discarded rather than reported as errors.

Conclusion: memory is **usable but has gaps**; the main flow is complete, while failure paths and one silent dead path are its weaknesses. Rating C.

#### jira

| Declared capability | Status | Evidence and explanation |
|---|---|---|
| Ten `jira_issue` verbs | Implemented | `ISSUE_PARAMETERS` in `packages/jira/jira-agent/src/toolIssue.ts`; group-level parity tests guard the verb mapping |
| `jira_list` / `jira_kb` | Implemented | `packages/jira/jira-agent/src/toolList.ts`, `packages/jira/jira-agent/src/toolKb.ts` |
| Executor `issue_work` | Implemented | `packages/jira/jira-agent/src/workIssue.ts`; `scope: 'all'` + worker routing (`packages/jira/jira-agent/src/contribution.ts#L174`-`packages/jira/jira-agent/src/contribution.ts#L180`) |
| `jira:store` runtime context | Implemented | `packages/jira/jira-agent/src/contribution.ts#L151`-`packages/jira/jira-agent/src/contribution.ts#L172` |
| Monotonic write guard | **Partially implemented** | It intercepts only `jira_issue` (`packages/jira/jira-agent/src/wiring.ts#L35`-`packages/jira/jira-agent/src/wiring.ts#L42`); `jira_kb` writes check themselves in the handler (`packages/jira/jira-agent/src/toolKb.ts#L82`), rather than relying on guard coverage |
| `/jira` + three skills | Implemented | `packages/jira/jira-agent/src/wiring.ts#L57`, `packages/jira/jira-agent/src/wiring.ts#L89` |
| Turn-end settle + push queue | Implemented | `packages/jira/jira-agent/src/contribution.ts#L104`-`packages/jira/jira-agent/src/contribution.ts#L124`; `packages/jira/jira-service/src/index.ts#L928` |
| 10 superagent tools | Implemented, but **each agent receives only 6 or 5** | Ordinary root: source/scan/claim/workspace/status/dispatch (`packages/jira/jira-agent/src/superagent.ts#L4494`-`packages/jira/jira-agent/src/superagent.ts#L4501`); super agent: workspace/session/ledger/models/deliver (`packages/jira/jira-agent/src/superagent.ts#L4486`-`packages/jira/jira-agent/src/superagent.ts#L4493`) |
| Daemon (sessionless dispatcher) | Implemented, opt-in | `packages/jira/jira-agent/src/superagent.ts#L4101`-`packages/jira/jira-agent/src/superagent.ts#L4124` |
| dispatch / recover | Implemented, **but unreachable in the delivery composition** | See item 2 in the executive summary |

Conclusion: the jira ledger itself is **complete**; superagent is **usable but has gaps**; overall B.

### 2.2 Dimension 2: Whether the design matches expectations

#### memory

Memory has no standalone design document; **the README itself serves as the design specification** (“Understand the implementation” + “Model Experience”). Comparing the README as a statement of design intent with the implementation leads to this conclusion: **the core design intent (append-only, KV-cache-friendly, collapsing at compaction boundaries, tiered forgetting) holds in the implementation, but the documentation remains on the previous version's semantics, so “design intent” and “implementation” conflict on paper.**

| Design intent (README) | Actual implementation | Gap |
|---|---|---|
| Replace snapshots in place while keeping the prefix unchanged (`packages/uitstalie/memory/README.md#L67`, `packages/uitstalie/memory/README.md#L88`, `packages/uitstalie/memory/README.md#L142`) | `appendSnapshot` only appends (`packages/uitstalie/memory/src/snapshot.ts#L425`); a comment explains that replacement breaks the KV cache | **Documentation error**; `packages/uitstalie/memory/README.md#L134` and `packages/uitstalie/memory/README.md#L148` in the same README already describe the new semantics |
| Migration runs after the detail append (`packages/uitstalie/memory/README.md#L84`) | `migrateMemoryTiers` runs before `appendTurnSummary` (`packages/uitstalie/memory/src/summary.ts#L331`-`packages/uitstalie/memory/src/summary.ts#L360`), namely DH-710 | **Documentation error** |
| `onTurnEnd` receives only completed root turns (`packages/uitstalie/memory/README.md#L76`) | The organizer dispatches every `turn/end` (dafeiyu `packages/uitstalie/dafeiyu/src/index.ts#L336`) | **Documentation error**, and the implementation does not add the missing filter |
| Changes to `snapshotPosition` / `snapshotTemplate` trigger a row reload (`packages/uitstalie/memory/README.md#L188`) | Both are `.volatile()` (`packages/uitstalie/memory/src/config.ts#L75`-`packages/uitstalie/memory/src/config.ts#L76`); template changes take effect on the next refresh, while `position` is fixed during wiring, so “changing it has no effect and reports no error” | **Documentation error + implementation defect** |
| Snapshots occupy at most 16 KiB per request (`packages/uitstalie/memory/README.md#L138`) | Each summary pass may append a new snapshot (`packages/uitstalie/memory/src/summary.ts#L361` → `packages/uitstalie/memory/src/snapshot.ts#L230`), deduplicating only by whole-string equality with the “previous snapshot” | **Semantic drift**: each snapshot is ≤16 KiB, but multiple snapshots accumulate on the surface |
| `Window:` manifest (`packages/uitstalie/memory/README.md#L90`) | The implementation renders `Archived:` (`packages/uitstalie/memory/src/snapshot.ts#L403`, `packages/uitstalie/memory/src/snapshot.ts#L409`); a code comment explains the rename | **Documentation error** |

Assessment: memory's design intent and implementation have no **architectural** conflict; the problem is that the documentation was not updated after DH-723/724 changed the semantics, so the README can serve neither as a specification nor as user guidance.

#### jira

Jira's design intent is primarily recorded in three places: `DESIGN.md` (decision log, entries 1–223), `MIGRATION.md` (target shape of the three-layer split), and the package READMEs (current behavior).

Alignment results:

| Design intent | Actual implementation | Gap |
|---|---|---|
| MIGRATION: one bundle + five packages, with four surfaces depending only on `ctx.jira` | All five packages exist; `jira-agent` imports `jira-service` only with type-only imports; `ui-jira` uses `remote.jira`; the CLI drives core directly | **Matches**; however, `jira-agent`'s runner still bypasses the service and reads jira-core directly (see README:107, which no longer matches reality) |
| DESIGN 64/108: one package, adapter layer with zero host dependencies | Split into five packages; `jira-agent/src` has 102 `@deepseek-ai/*` imports | **Superseded by MIGRATION**; the document is not marked accordingly |
| DESIGN 141/96: exactly one write guard covering “write action × non-writable session” | The guard examines only `jira_issue`'s `action` (`packages/jira/jira-agent/src/wiring.ts#L36`-`packages/jira/jira-agent/src/wiring.ts#L38`) | **Narrower than the design states**; `jira_kb` writes rely on the handler, and `issue_work` relies on claim |
| DESIGN 200–223: superagent dispatch chain | Tools, daemon, dispatch, recover, and ledger are all implemented | **The implementation covers more detail than the design document**, but the delivery composition is not wired (see 2.6) |
| DESIGN 15/148: settle before pushing, ensuring that what is pushed matches the source | `sync()` uses `flushNow({ settle: true })` (`packages/jira/jira-service/src/index.ts#L907`-`packages/jira/jira-service/src/index.ts#L921`); `settle()` regenerates and commits (`packages/jira/jira-service/src/index.ts#L928`-`packages/jira/jira-service/src/index.ts#L936`) | **Matches** |

In addition, `reconfigure()` in `jira-service/src/index.ts` contains a block of **verbatim duplicate assignments** (`packages/jira/jira-service/src/index.ts#L253`-`packages/jira/jira-service/src/index.ts#L255` and `packages/jira/jira-service/src/index.ts#L257`-`packages/jira/jira-service/src/index.ts#L259`), a copy-paste remnant from implementation. It does not affect behavior but indicates that this path lacked review.

### 2.3 Dimension 3: Code simplicity and reusability

#### memory

- **Long functions/large classes**: `MemorySummaryRunner` runs from `packages/uitstalie/memory/src/summary.ts#L184` to `packages/uitstalie/memory/src/summary.ts#L399`, about 216 lines; `runPass` alone is about 95 lines (`packages/uitstalie/memory/src/summary.ts#L293`-`packages/uitstalie/memory/src/summary.ts#L387`). `apply` is about 72 lines (`packages/uitstalie/memory/src/index.ts#L201`-`packages/uitstalie/memory/src/index.ts#L272`) and combines four responsibilities in one function: “read configuration, register capabilities, register commands, cache snapshots.”
- **Copy-paste (definitions verified)**: three copies of `truncateToBytes` (`packages/uitstalie/memory/src/read.ts#L295`, `packages/uitstalie/memory/src/snapshot.ts#L471`, `packages/uitstalie/memory/src/summary.ts#L724`); three copies of `byteLength` (`packages/uitstalie/memory/src/read.ts#L309`, `packages/uitstalie/memory/src/snapshot.ts#L466`, `packages/uitstalie/memory/src/summary.ts#L712`); four copies of `errorMessage` (`packages/uitstalie/memory/src/checkpoint.ts#L230`, `packages/uitstalie/memory/src/memory-file.ts#L2197`, `packages/uitstalie/memory/src/snapshot.ts#L486`, `packages/uitstalie/memory/src/summary.ts#L739`). These are pure text utilities; extracting one `text.ts` would suffice and carries little risk.
- **Implicit state**: `snapshotTexts` is a `Map` in the `apply` closure (`packages/uitstalie/memory/src/index.ts#L223`-`packages/uitstalie/memory/src/index.ts#L227`); it only grows, and `dispose` does not clear it. The same applies to `MemorySummaryRunner`'s `sessions`/`noticed` (`packages/uitstalie/memory/src/summary.ts#L185`-`packages/uitstalie/memory/src/summary.ts#L187`). They are bounded by “the number of sessions seen in the process,” so this is not leak-level, but it is a case of “state without a single owner.”
- **Inconsistent error model**: `memory-file.ts` uses `MemoryDocumentError`, while the other modules extensively use bare `Error` (`packages/uitstalie/memory/src/config.ts#L116`, `packages/uitstalie/memory/src/summary.ts#L455`, `packages/uitstalie/memory/src/tools.ts#L155`, etc.). Upper layers cannot distinguish “corrupt document” from “invalid argument.”
- **Handwritten mini formats**: `memory-file.ts` uses five regular expressions to parse entry suffixes and strip them in reverse order (`packages/uitstalie/memory/src/memory-file.ts#L326`-`packages/uitstalie/memory/src/memory-file.ts#L341`); `parseSummaryJson` uses the heuristic of “first `[`/`{` through last `]`/`}`” (`packages/uitstalie/memory/src/summary.ts#L658`-`packages/uitstalie/memory/src/summary.ts#L670`). A custom format for the managed block is acceptable, but bracket slicing of model output is unreliable on prose containing `}`.
- **Pointless abstractions**: `MEMORY_ENTRY_LABELS = MEMORY_ENTRY_KINDS` (`packages/uitstalie/memory/src/commands.ts#L32`) is only an alias; `findSection`/`sameSection` and `findContainingSection` are two separate lookup mechanisms (`packages/uitstalie/memory/src/memory-file.ts#L1124`, `packages/uitstalie/memory/src/memory-file.ts#L1337`).

#### jira

- **Oversized single file**: `superagent.ts` has 4,350 lines. Its longest functions are `createSuperagentContribution`, `packages/jira/jira-agent/src/superagent.ts#L4048`-`packages/jira/jira-agent/src/superagent.ts#L4552` (505 lines), and `runSessionTool`, `packages/jira/jira-agent/src/superagent.ts#L2405`-`packages/jira/jira-agent/src/superagent.ts#L3057` (653 lines).
- **The same envelope is handwritten repeatedly**: besides `toolFailure`, `{ ok: true, writable, me, ... }` is expanded repeatedly in multiple runners; `verdictOf` (`packages/jira/jira-agent/src/superagent.ts#L725`) is used only by the models tool and nowhere else.
- **`createSuperagentContribution` mixes responsibilities**: the same function authorizes fs roots (`packages/jira/jira-agent/src/superagent.ts#L4072`-`packages/jira/jira-agent/src/superagent.ts#L4077`), injects the systemPrompt (`packages/jira/jira-agent/src/superagent.ts#L4081`-`packages/jira/jira-agent/src/superagent.ts#L4100`), subscribes to domains/events (`packages/jira/jira-agent/src/superagent.ts#L4129`-`packages/jira/jira-agent/src/superagent.ts#L4161`), sets timers (`packages/jira/jira-agent/src/superagent.ts#L4163`), and defines and renders 10 specs. It combines “registration + IO + business logic + rendering” in one.
- **Duplicate assignments in the service layer**: the six duplicate lines in `reconfigure()` (see 2.2).
- **Duplicate staged-form controllers in the UI**: `MemorySettingsController` at `ui-memory/src/client/settings.ts:119` and `PersonalitySettingsController` at `ui-personality/src/client/settings-form.ts:112` correspond item by item (`FIELDS`/`NUMERIC`/`EMPTY`/`UNAVAILABLE`/`draftOf`/`validNumber`/`edit`/`discard`/`save`); these are two plugins rather than one plugin internally, but the “configuration form controller” could be extracted into `ui-primitives` or a shared base class.
- **Misplaced JSDoc**: “Publish the current projection” at `ledger-settings.ts:226` is attached above `accepted()`, while the actual `publish()` is at `packages/jira/ui-jira/src/client/ledger-settings.ts#L232` and has no comment (`packages/jira/ui-jira/src/client/ledger-settings.ts#L226`-`packages/jira/ui-jira/src/client/ledger-settings.ts#L232`).
- **The 13 combinators in `result.ts`**: `map/mapErr/andThen/orElse/unwrapOr/collect/partition/pipe/isOk/isErr` appear only in `result.ts` and `result.test.ts`; production code uses only `ok`/`err`/`Result` (confirmed by grep across the group). This is a **public API with no consumers**, and the tests perpetuate its maintenance cost.

Types and error handling (jira): the `JiraError` + `Result` model is highly consistent in core (zero `throw` in non-test source), one of the best parts of this project; the problems are confined to the envelopes in the agent adapter layer and the UI boundary.

### 2.4 Dimension 4: Whether wheels were reinvented

Assessment criterion: a **wrapper with a clear platform/offline rationale and correct behavior** counts as a “reasonable wrapper”; only a facility **already present in the repository with the same capability and semantics** counts as reinventing the wheel.

| Duplicate implementation | Location | Existing alternative | Assessment and recommendation |
|---|---|---|---|
| Atomic write (tmp + rename + 3 backoffs) | `writeTextAtomic` at `packages/jira/jira-core/src/io.ts#L178`; retry constants at `packages/jira/jira-core/src/system/policy.ts#L17` | `writeFileAtomic` / `withFileLock` in `packages/util/atomic-write`, used by 10+ production packages including `boot/config-editor`, `credentials-local`, and `boot/plugin-manager` | **Reinvented wheel**. If jira's “zero-dependency/offline-copy” premise is retained, it should at least share the same retry and error semantics; that premise is weaker in the monorepo |
| Cross-process lock (mkdir + owner + heartbeat/reaping) | `packages/jira/jira-core/src/lock.ts#L1`-`packages/jira/jira-core/src/lock.ts#L50` | `withFileLock` in `atomic-write`; lease/flock in `session-persistence-jsonl` | **Reasonable wrapper + partial duplication**: the mkdir lock has a genuine Windows antivirus rationale (decision 59), but the repository already has two lock implementations, so a third should at least share the interface and timeout semantics |
| Restricted YAML/frontmatter parsing | `packages/jira/jira-core/src/frontmatter.ts#L1`-`packages/jira/jira-core/src/frontmatter.ts#L40` | `yaml` is already a workspace dependency used by `store-atom`, `personality`, and others; memory also uses `yaml` directly | **Justified wrapper** (strict rejection, text as truth, decision 105), but “must support offline copying and have zero runtime dependencies” (decision 65) no longer holds in the five-package monorepo; update the rationale in the documentation rather than rewriting it now |
| Handwritten JSON Schema subset + parameter validation | `packages/jira/jira-core/src/schema.ts#L1`-`packages/jira/jira-core/src/schema.ts#L15`, `validate.ts` | `zod@4.4.3` is already a direct dependency of `jira-agent` (`packages/jira/jira-agent/package.json#L33`); `z.toJSONSchema` can produce the host dialect, and `schemastery` is also in use | **Reinvented wheel** (the clearest case). The rationale is still “the adapter layer does not import the host,” but `jira-agent` already imports the host; move parameter validation to the agent adapter layer using zod, and keep only output shapes in core |
| home/`~` resolution | `packages/jira/jira-core/src/system/env.ts`, `superagent-setup.ts:55` | `resolveDshHome` in `@deepseek-ai/dsh-home-paths` | **Reasonable wrapper but has drifted once** (recorded in HANDOVER); reuse it or add cross-tests |
| Regex-based tag-file reading | `packages/jira/jira-core/src/store.ts#L114`-`packages/jira/jira-core/src/store.ts#L130` | `decodeTag` in the same package's `tagstore.ts` | **Internal duplication**; merge them, because two decoders in the same file will eventually drift |
| Session-event derivation (title/activity/cache/latest task) | `activityOf`/`cacheHitOf`/`sessionTitleOf`/`lastTaskOf` in `superagent.ts` | `session-stats`, `session-turn-outline`, Session projections | **Partial duplication** (determined by static reading): superagent needs a “cross-workspace session overview,” which existing packages do not directly provide; however, replaying `snapshotEvents()` and hardcoding event names will drift from the session event vocabulary over time |
| UI configuration form controllers | `packages/uitstalie/ui-memory/src/client/settings.ts#L119` vs `packages/uitstalie/ui-personality/src/client/settings-form.ts#L112` | No shared base class | **Copy-paste**; extract a `StagedConfigFormController` |
| `.superagent` path rules and home validation | `packages/jira/jira-service/src/superagent-setup.ts#L67`, `packages/jira/jira-service/src/superagent-setup.ts#L87` vs `packages/jira/jira-agent/src/superagent.ts#L324`, `packages/jira/jira-agent/src/superagent.ts#L366` | Two implementations | **Duplicated and already drifted**: the agent side uses `realpathSync`, while the service side uses lexical comparison via `resolve`; the two entry points may disagree on whether paths identify “the same directory” |

The parts that are “reasonable wrappers, not duplication”: `jira-core`'s `Result`/`JiraError` model, `runGit` in `git.ts`, platform adaptation in `system/*`, the offline single-file board in `boardHtml.ts`, and `ui-jira`'s `remote.jira` read model.

### 2.5 Dimension 5: Degree of decoupling

#### memory

| Coupling point | Evidence | Impact |
|---|---|---|
| Unused `fs` dependency declared | `inject` includes `fs` (`packages/uitstalie/memory/src/index.ts#L34`); `ctx.fs` is spied only in tests (`checkpoint.spec.ts:167`, etc.) and never read by production code | Valid compositions without `fs` are rejected, unnecessarily binding the capability to fs |
| Hidden dependency on the `tool-jobs` controller | `jobs.start` may be available, but the controller must be attached by `tool-jobs` (`summary.ts:236` checks only that `jobs` exists) | Summaries are silently skipped when the composition lacks `tool-jobs`, and `inject` cannot express this dependency |
| Direct reads of Agent internals | `agent.options`, `agent.session.requestHeader()` (`packages/uitstalie/memory/src/summary.ts#L426`-`packages/uitstalie/memory/src/summary.ts#L431`), `agent.session.surface.nodes` (`packages/uitstalie/memory/src/index.ts#L250`) | Changes to the host Agent/Session structure directly break the provider; there is no adapter layer |
| Hardcoded storage path in prompts | Prompt text and tool descriptions specify `.dsh/memory` (`packages/uitstalie/memory/src/prompt.ts#L21`, `packages/uitstalie/memory/src/tools.ts#L115`), creating a second source of truth alongside `store-atom`'s `STORE_DIR_NAME` | Model prompts become false when the storage root or directory name changes |
| Configuration fields duplicated between UI and host | `ui-memory` lists 7 field names (`packages/uitstalie/ui-memory/src/client/settings.ts#L35`-`packages/uitstalie/ui-memory/src/client/settings.ts#L43`), and the host separately lists 10 (`packages/uitstalie/memory/src/config.ts#L66`-`packages/uitstalie/memory/src/config.ts#L77`); sectionId/order also appear in two places (`packages/uitstalie/memory/src/index.ts#L40`, `packages/uitstalie/ui-memory/src/section.ts#L7`) | Renaming a field causes no compile error, only empty values or rejected saves |
| Changing storage / changing provider | Storage uses `ctx.dshStore` + `dsh-fs`'s `FS_STALE_VERSION`; models use `ctx.llm` + route fallback | Changing storage requires rewriting `memory-file`'s version-conflict handling; changing provider has no impact (correct design) |

#### jira

- **Good boundaries**: `jira-core` truly has zero host imports (`boundaries.spec.ts` + my recheck); `jira-service` is the only writer; `ui-jira` uses only `remote.jira`; `jira-cli` does not depend on `jira-agent`.
- **Direct agent dependencies on the host**: 9 duck-typed services (`sessionController`, `workspaceRegistry`, `llm`, `agents`, `tokenMeter`, `compaction`, `sandboxPolicy`, `permissionPresets`, `storageDomain`), plus Agent internal APIs such as `agent.ctx.effect` (`packages/jira/jira-agent/src/superagent.ts#L4507`), `session.snapshotEvents`, `agent.cancel({..})`, and `whenIdle`. Missing dependencies silently degrade behavior, with no type checking.
- **Casts used to bypass `inject`**: `contribution.ts:152` and `superagent.ts:4081` assert `ctx` as `{ inject?: ... }` and invoke it manually rather than declaring Cordis `ctx.inject`. This works but leaves lifecycle management to the caller (see 2.6).
- **UI bypasses Typert types**: `ui-jira/src/client/index.ts:157` and `packages/jira/ui-jira/src/client/index.ts#L174` use `as unknown as` to access `superagentSetup` / `superagentState`, while `JiraWire` in `store.ts` has neither method (`packages/jira/ui-jira/src/client/store.ts#L32`-`packages/jira/ui-jira/src/client/store.ts#L49`). Protocol changes will not produce errors here.
- **Hardcoding**: `.superagent/ledger` (`dispatch-ledger.ts:20`), the `Super agent` title, the `workspace-write` default, `~/.dsh/sessions`, and `$DSH_HOME/attachments`. These are product choices, but they are scattered through the code rather than centralized in a configuration/constants module.
- **Circular dependencies**: none. `jira-agent` imports `jira-service` only with type-only imports, and `jira-service` does not import `jira-agent`. However, `jira-agent/package.json` places `jira-service` in `devDependencies` (`packages/jira/jira-agent/package.json#L43`), while types from `tools.ts:25` appear in the published `lib/types`—an undeclared type dependency for consumers.

### 2.6 Dimension 6: Composability

#### memory

- **Can be disabled independently**: the Loader row can be disabled as a whole; `/memory` mounts optionally through `ctx.inject(['commands'])` (`packages/uitstalie/memory/src/index.ts#L269`-`packages/uitstalie/memory/src/index.ts#L271`), which is the correct composition pattern.
- **Inaccurate declarations**: of the six `inject` entries, `fs` is unused; `jobs` merely needs to “exist,” while actual usability also depends on `tool-jobs` attaching a controller. Both make supposedly “optional capabilities” effectively non-optional.
- **Incomplete configuration exposure**: the UI edits only 7 of 10 fields (omitting `maxEntries`, `snapshotTemplate`, and `snapshotPosition`); the latter two can be changed only in profile YAML.
- **No cross-validation of the section contract**: the host's `MEMORY_SETTINGS_SECTION/ORDER` and the UI's `section.ts` each maintain a copy, and changing one does not cause a compile failure.

#### jira

- **Independent gating of the two capabilities is a strength**: `jira` and `superagent` are registered separately and have separate `enabledByDefault` values; dafeiyu can toggle them by id (`packages/jira/jira-agent/src/index.ts#L205`-`packages/jira/jira-agent/src/index.ts#L249`).
- **But the defaults and composition are inconsistent**: `jira` is explicitly enabled in the delivery patch (`packages/bundle/web-app/cordis.patch.uitstalie.yml#L9`-`packages/bundle/web-app/cordis.patch.uitstalie.yml#L13`); `superagent` has no entry and is disabled by `enabledByDefault` (home not configured → false). The `jira-worker` preset already ships with the bundle (`presets/jira-worker.patch.yml`), but no row configuration connects it to `superagent_worker_preset` → **“the preset exists, but dispatch always rejects.”**
- **A “personal branch layer” is embedded in the public bundle**: `@deepseek-ai/dsh-web-app`'s `dsh.bundle.patch` unconditionally lists `./cordis.patch.uitstalie.yml` (`packages/bundle/web-app/package.json#L50`-`packages/bundle/web-app/package.json#L57`), so installing this public package also mounts branch plugins such as memory, jira, and persona-card; disabling them requires editing the patch. The composition boundary is a “branch layer,” not an “optional bundle.”
- **Dependency declarations**: `jira-core` declares `peerDependencies: cordis` (`packages/jira/jira-core/package.json#L23`-`packages/jira/jira-core/package.json#L25`), but it has zero host imports, so this peer is empty; memory has the opposite problem, missing two actual runtime dependencies. Both directions of “inaccurate declaration” are present.
- **Lifecycle**: `createSuperagentContribution`'s `dispose` is synchronous (`CapabilityContribution.dispose?(): void`, dafeiyu `packages/uitstalie/dafeiyu/src/types.ts#L98`), so `void dispatchStore?.close()` (`packages/jira/jira-agent/src/superagent.ts#L4544`) cannot be awaited; meanwhile, `poll()` has no `disposed` flag, so **an already-started pass continues after the timer is cleared** (`packages/jira/jira-agent/src/superagent.ts#L4103`-`packages/jira/jira-agent/src/superagent.ts#L4124`). Dafeiyu's `contain` only applies `catch` to the returned Promise and does not `await` it (`packages/uitstalie/dafeiyu/src/index.ts#L526`-`packages/uitstalie/dafeiyu/src/index.ts#L535`). Impact: a proposal comment may still be produced after the capability is disabled; closing the dispatch store can race storageDomain removal. This is **incomplete teardown under the contract's constraints**, not guaranteed data corruption.

### 2.7 Dimension 7: Whether documentation is stale

Principle: **list “missing documentation” and “incorrect documentation” separately**.

#### Incorrect documentation (traceable to code)

| Documentation location | Stale content | Current code | Required correction |
|---|---|---|---|
| `packages/uitstalie/memory/README.md#L67`, `packages/uitstalie/memory/README.md#L88`, `packages/uitstalie/memory/README.md#L142` | Snapshots “append or replace,” “replace in place, `surfaceOp: replace`” | Append only (`packages/uitstalie/memory/src/snapshot.ts#L425`, comment at `packages/uitstalie/memory/src/snapshot.ts#L420`-`packages/uitstalie/memory/src/snapshot.ts#L424`) | Change to append-only; remove `surfaceOp: replace` |
| `packages/uitstalie/memory/README.md#L84` | “Migration runs after the detail append” | Migrate before append (`packages/uitstalie/memory/src/summary.ts#L331`-`packages/uitstalie/memory/src/summary.ts#L360`) | Rewrite in the DH-710 order |
| `packages/uitstalie/memory/README.md#L76` | `onTurnEnd` is called only for completed turns | Dafeiyu dispatches every `turn/end` (`packages/uitstalie/dafeiyu/src/index.ts#L336`) | Either add filtering to the code, or update the documentation and handle non-completed turns |
| `packages/uitstalie/memory/README.md#L90` | “`Window:` manifest” | Actually `Archived:` (`packages/uitstalie/memory/src/snapshot.ts#L403`, `packages/uitstalie/memory/src/snapshot.ts#L409`) | Change the label |
| `packages/uitstalie/memory/README.md#L54` | “Six hard dependencies, including `ctx.fs`” | `ctx.fs` is unused in production; `dsh-llm`/`dsh-session` are the undeclared runtime dependencies | Correct the dependency list and complete the manifest |
| `packages/uitstalie/memory/README.md#L138` | “At most 16 KiB per request” | Each summary pass may append a new snapshot (`packages/uitstalie/memory/src/summary.ts#L361`) | Change to “each snapshot ≤16 KiB; multiple snapshots can accumulate on the surface” |
| `packages/uitstalie/memory/README.md#L188` | “Position/template changes trigger a row reload” | Both are volatile; switching position at runtime does not rewire | Correct the documentation + fix switching |
| `packages/jira/jira-agent/README.md#L12` | “Both capabilities have `enabledByDefault: false`” | Superagent uses `homeProblem === undefined` (`packages/jira/jira-agent/src/index.ts#L228`) | Change to “jira is off by default; superagent depends on whether home is configured” |
| `packages/jira/jira-agent/README.md#L90`, `packages/jira/jira-agent/README.md#L95` | “The root agent has 10 tools,” “10 schemas per request” | Ordinary root has 6, super agent has 5 (`packages/jira/jira-agent/src/superagent.ts#L4484`-`packages/jira/jira-agent/src/superagent.ts#L4501`) | Rewrite for the 6/5 split, or adjust the implementation |
| `packages/jira/jira-agent/README.md#L107` | “The runner still imports jira-core by deep path / uses `ctx.jira.store()`” | No deep-path imports; `JiraServiceApi` has no `store()` (the method table in `types.ts`) | Remove this limitation |
| `packages/jira/jira-service/README.md#L55` | “The only browser-surface write is `superagentConfirm`” | `superagentSetup` performs `mkdir`, registers a workspace, and writes the profile (`packages/jira/jira-service/src/remote.ts#L230`-`packages/jira/jira-service/src/remote.ts#L259`) | Add the second write and explain the permission boundary |
| Service method enumeration at `packages/jira/jira-service/README.md#L32` / remote table at `packages/jira/jira-service/README.md#L42` | The service enumeration omits `status/snapshot/queryIssues/tagsLint/syncState`; the remote table omits `superagentState/superagentSetup` | `JiraServiceApi` in `types.ts` and `@Remote` in `remote.ts` | Relist according to the current API |
| `packages/jira/README.md#L12`, `packages/jira/README.md#L32` | jira-agent mentions only “three tools”; ui-jira mentions only status/board/details/KB | There is also `issue_work` + 10 `superagent_*` tools; the UI also has the superagent panel and sidebar setup (`packages/jira/ui-jira/src/client/index.ts#L125`-`packages/jira/ui-jira/src/client/index.ts#L167`) | Synchronize the tool counts and UI capabilities |
| `packages/jira/HANDOVER.md#L3`, `packages/jira/HANDOVER.md#L20`, `packages/jira/HANDOVER.md#L83`, `packages/jira/HANDOVER.md#L284`, `packages/jira/HANDOVER.md#L400` | 199 decisions, 702 tests, `src/core`/`src/cli`/`src/plugin`, `dist/plugin/index.js`, mandatory `pnpm build` | Five-package monorepo; entry is `lib/index.js`; 774 node tests; DESIGN already has 223 entries | Mark “historical document” at the top, or move it into `archive/` |
| `packages/jira/DESIGN.md#L3` | Status line says “82 confirmed decisions,” discussion draft v3 | §8 is actually numbered 1–223 (script counted 310 lines, maximum 223) | Update the status line; mark layouts superseded by MIGRATION |
| `packages/jira/DESIGN.md#L177`-`packages/jira/DESIGN.md#L179` | Single-package `src/core`/`src/cli`/`src/plugin` tree | Five packages | Add “historical layout, see MIGRATION.md” |
| `packages/jira/DESIGN.md#L33` | Verification baseline `@deepseek-ai/dsh-root@0.2.1-alpha.2` | Root `package.json` version is `0.2.2-alpha.3` | Reverify and update the baseline |
| `packages/jira/ARCHIVE-SOURCE.md#L27` + `packages/jira/README.md#L43` | States that HANDOVER's “body is unchanged,” while linking HANDOVER as “current state / open work” | All of HANDOVER describes the pre-migration structure | Do one of two things: add a banner, or stop calling it the current handover in the README |
| `packages/jira/MIGRATION.md#L5`, `packages/jira/MIGRATION.md#L15` | Target package names `@uitstalie/*`, planned shape | Actual names are `@deepseek-ai/dsh-*`, already implemented | The page header already says “planned values”; add the same statement in §2.1 |

#### Missing documentation

- There is no `docs/subsystems/memory.md` / `docs/subsystems/jira.md` and no product-level user page; only generated catalogs (`docs/config-catalog.md`, `module-graph.md`) cover configuration and the package graph. The `ctx.jira` / `remote.jira` contracts currently exist only in package READMEs and `types.ts`.
- `docs/user/guide/mcp-memory.md` describes a third-party MCP memory service, which has the same name as `dsh-memory` but is a different thing and can easily be mistaken for the same capability.
- There is no current-state operations page: how to build/test/smoke the five packages, how to toggle superagent in a profile, and how to set the worker preset are scattered across the old HANDOVER and source code.
- `jira-agent`'s 11 `superagent_*` row configuration fields have no package-level configuration table (only JSDoc in `index.ts` and generated catalogs).

---

## 3. Consolidated duplication and reuse list

| # | Duplicate implementation location | Existing alternative | Recommended action | Priority |
|---|---|---|---|---|
| 1 | Atomic write at `jira-core/src/io.ts:178` | `writeFileAtomic` in `packages/util/atomic-write` | Reuse; at least share retry/error semantics | P2 |
| 2 | mkdir lock at `jira-core/src/lock.ts` | `withFileLock` in `atomic-write`, session lease | Retain the mkdir rationale; extract a unified interface | P2 |
| 3 | Handwritten JSON Schema/validation at `jira-core/src/schema.ts` | `zod@4.4.3` (already in agent), `schemastery` | Use zod in the adapter layer; keep only shapes in core | P2 |
| 4 | Restricted YAML at `jira-core/src/frontmatter.ts` | `yaml` (already used by memory) | Keep it; update the “offline, zero dependencies” rationale | P2 |
| 5 | Regex tag reading at `jira-core/src/store.ts:114` | `tagstore.decodeTag` in the same package | Merge immediately | P2 |
| 6 | Combinators at `jira-core/src/result.ts:61-163` | No production callers | Delete or mark internal | P2 |
| 7 | Memory's `truncateToBytes`×3 / `byteLength`×3 / `errorMessage`×4 | None | Extract `text.ts` | P2 |
| 8 | `ui-memory/settings.ts:119` vs `ui-personality/settings-form.ts:112` | No shared base class | Extract a staged config controller | P2 |
| 9 | `superagent-setup.ts:67,87` vs `superagent.ts:324,366` | Two sets of home/path rules | Merge into one (mind realpath vs lexical comparison) | P1 |
| 10 | Duplicate assignments at `jira-service/src/index.ts:253-259` | Itself | Delete the duplicate block | P2 |
| 11 | Hardcoded `.superagent/ledger`, `Super agent`, `workspace-write`, etc. | None | Collect into one constants/configuration module | P2 |

---

## 4. Consolidated design-conformance comparison

| Design-intent source | Intent | Implementation | Gap level |
|---|---|---|---|
| memory README | Append-only snapshots, KV-cache-friendly | Append only (`snapshot.ts:425`) | **Implementation matches; documentation wrong** |
| memory README | Migration after append | Migrate before append (`summary.ts:331-360`) | **Implementation matches; documentation wrong** |
| memory README | `onTurnEnd` receives only completed turns | Receives all turn ends (`dafeiyu:336`) | **Implementation defect** |
| memory config JSDoc | 10 volatile fields take effect immediately | Switching `snapshotPosition` does not rewire | **Implementation defect** |
| MIGRATION.md | One bundle + five packages, four surfaces depending only on `ctx.jira` | Five packages, single-writer service, remote read model | **Matches** |
| DESIGN 141 | One guard covers write actions × non-writable sessions | Covers only `jira_issue` | **Implementation narrower than design** |
| DESIGN 148 | Settle after pull and before push | `flushNow({ settle: true })` + `settle()` | **Matches** |
| DESIGN 200–223 | Real Session dispatch + preset isolation | dispatch/recover/daemon all present | **Implementation matches; delivery composition not wired** |
| jira-agent README | All 10 tools are on the root agent | 6/5 split | **Documentation wrong** |
| jira-service README | The only write is `superagentConfirm` | Also `superagentSetup` | **Documentation wrong** |

---

## 5. Prioritized recommendations

Ordering principle: correctness > security/data > maintainability > style.

### P0 (address immediately)

1. **Memory: canceled/errored turns must no longer start summary jobs or write failure notices.** In `onTurnEnd`, return immediately when `input.event.data.reason.kind !== 'completed'` (or in `runPass`, treat “no completed turn” as a normal skip rather than a failure). Also change the dafeiyu and memory READMEs to say “all turn ends arrive, and each provider decides for itself.” Acceptance: `summary.spec.ts:236` passes, with new assertions that “an aborted turn writes no notice and produces no job.”
2. **Jira: add `me` to `toolFailure` (and clarify the semantics of `writable`).** Otherwise, `runSessionTool`'s fallback failure is masked again by `ToolOutputError` (`superagent.ts:1729` vs `:928`). Acceptance: use a fake controller that throws to trigger the catch, and assert that the return value passes the output schema.

### P1 (this round or the next)

3. **Jira: connect `superagent_worker_preset` into the delivery composition** (or make the entire `superagent` capability invisible when unconfigured, rather than “tools exist but always reject”). Also let UI setup write the worker preset, or state explicitly in the README/UI that manual row editing is required.
4. **Memory: a runtime `snapshotPosition` switch must either rewire the agent or reject the write and report an error**; do not make “no snapshots after switching” silent behavior.
5. **Memory: correct the English README's replace/order/`Window:`/six-dependencies/16 KiB statements** and make the two languages consistent; add the `dsh-llm`/`dsh-session` runtime dependencies and remove the unused `fs` inject.
6. **Jira: deduplicate `jira-service`'s `reconfigure()` and correct the README's “only write” claim**; add a historical banner to `HANDOVER.md` or move it into `archive/`.
7. **Jira: complete `createSuperagentContribution` teardown**: add a `disposed` flag so `poll()` exits before each step; `dispose` should at least log close failures (the current `void ... .catch(log)` is acceptable but cannot be awaited). If dafeiyu's `dispose` contract cannot change, at least document “close is not awaited” in a comment.
8. **Memory: establish a budget/deduplication policy for snapshot accumulation** (for example, retain only the latest snapshot, or mark old snapshots `superseded` and clean them at compaction boundaries); otherwise, long-session context grows linearly, contrary to the README's token promise.

### P2 (maintainability/style, as needed)

9. Jira: split `superagent.ts` into files by `claim / workspace / session / dispatch / ledger-report / source / contribution`; start with the 653-line `runSessionTool`.
10. Jira: reuse and merge `jira-core`'s atomic write/lock/schema/tag decoding; delete the dead combinators in `result.ts`.
11. Jira: merge the two sets of home/path rules (realpath vs lexical).
12. Memory: extract `text.ts` to remove the 3×3×4 duplicate helpers; clear `snapshotTexts`/`sessions` on session dispose.
13. UI: the conditional hooks and early returns at `MemorySection.tsx:48` / `JiraSection.tsx:53-57` violate the rules of hooks; move them before the returns. Change `ui-memory` to use injected `useSnapshot` rather than direct `useSyncExternalStore`.
14. Documentation: DESIGN status line/baseline version/old-layout annotations; tool counts in jira/README; planned package names in MIGRATION.
15. Bring CLI/agent parameter vocabulary (`--tag`/`--all` vs `tags`/`include_closed`) into parity tests or unify it.

---

## 6. Unverified matters (limits of this review)

| Assessment | Basis | Explanation |
|---|---|---|
| Memory's aborted-turn defect | **Runtime verification** | Rerunning the same test alone still failed; the root cause is explained by static code reading |
| All jira node tests pass | **Runtime verification** | `pnpm run test:jira:node` → 774 passed |
| The only jira group-level vitest failure is a timeout | **Runtime verification (partial)** | Only the `60s` timeout was observed; it was not determined whether the environment was slow or this was a real regression; the file does not raise the timeout for real Session cases |
| `toolFailure` triggers `ToolOutputError` | **Static reading** | Depends on schema validation in the host's `pipeline.ts`; no reproduction case was written |
| Dispatch is unreachable in the delivery composition | **Static reading + configuration check** | The superagent toggle was not actually clicked in the GUI for verification |
| Superagent internal details such as append/prompt branch copying and N×2 replay | **Static reading (subagent)** | Not every line number was individually rechecked; the report retains only cross-verifiable portions |
| Impact of daemon/poll teardown | **Static reading** | No reproduction was constructed where a pass happened to be running during disable |
| UI hook violations cause crashes | **Static reading** | Triggering requires props to change from missing to complete; assembly paths usually provide everything at once |
| Documentation checks (`verify-translation-pairing`) | **Not run** | Local `pnpm` reported `unable to open database file` under the sandbox; after switching to full access, only tests were run, not documentation checks |
| Repository-wide `pnpm test` | **Not run** | The working tree had 78 unrelated uncommitted changes, so a repository-wide run could not be attributed |
| Session/persistence/sandbox changes in the working tree | **Not reviewed** | Explicitly outside this review's scope |

---

## 7. Appendix: evidence index for this review (principal files)

- memory: `packages/uitstalie/memory/src/{index,config,summary,snapshot,checkpoint,tools,commands,memory-file}.ts`, `tests/summary.spec.ts`, `tests/harness.ts`, `README.md`/`README.zh.md`
- memory UI: `packages/uitstalie/ui-memory/src/client/{MemorySection.tsx,settings.ts,index.ts}`, `src/section.ts`
- Organizer: `packages/uitstalie/dafeiyu/src/{index.ts,types.ts}`, `README.md`
- jira: `packages/jira/{jira-agent,jira-service,jira-core,jira-cli,ui-jira}/src`, `packages/jira/tests/*.spec.ts`
- Composition: `packages/bundle/web-app/{cordis.patch.uitstalie.yml,presets/jira-worker.patch.yml,package.json}`
- Documentation: `packages/jira/{README,DESIGN,HANDOVER,MIGRATION,ARCHIVE-SOURCE}.md`, package READMEs

> This report was produced read-only; no reviewed code or configuration was modified, and no commit was created or pushed.
