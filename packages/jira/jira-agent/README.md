---
description: "The jira ledger's model surface: the dafeiyu capability providers registering the jira_issue, jira_list and jira_kb tools, the executor's issue_work tool, the claim loop, the write guard, the /jira command, the bundled skills and the turn-end settle."
kind: "package-reference"
---

# @deepseek-ai/dsh-jira-agent

English | [中文](README.zh.md)

## Summary

`dsh-jira-agent` is the ledger's model surface: a dafeiyu capability provider registering `jira_issue`, `jira_list` and `jira_kb` on a root agent, `issue_work` on a delegated child, the `jira:store` awareness line, the monotonic write guard, `/jira`, three skills, and the turn-end settle. A second, independently gated `superagent` capability adds the claim loop (`superagent_scan`, `superagent_claim`, `superagent_status`, `superagent_workspace`, `superagent_dispatch`, `superagent_source`). It injects `ctx.jira`, the tool registry and `ctx.dafeiyu`; commands and skills are optional. Both capabilities use contract version 2 and `settings.sectionId` `jira` / `superagent`; the `jira` capability is off by default, while `superagent` is on by default only when the row configures a safe `superagent_home`. The ledger's root, identity and push queue belong to the `jira-service` row.

## Table of Contents

- [Contents](#contents)
- [Tests](#tests)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="contents"></a>

## Contents

| Module | Owns |
|---|---|
| `index.ts` | the plugin entry: `name` / `inject` / `Config` / `apply`, and the controlled re-exports |
| `contribution.ts` | the dafeiyu capability: scope, tools, sections, agent hook, turn-end settle, dispose |
| `tools.ts` | the registry definitions (root and executor) and the per-call store/caller resolution |
| `workIssue.ts` | the executor's tool: its schema, its scope check and its runner |
| `superagent.ts` | the claim loop: readiness, proposal and claim; dispatch report recovery |
| `dispatch-store.ts` | the optional durable `superagent_dispatch` domain, Markdown projection and migration |
| `awareness.ts` | the `jira:store` runtime-context line and its `changed`-driven refresh |
| `wiring.ts` | the write guard, the `/jira` command registration and the skill registration |
| `toolIssue.ts` / `toolList.ts` / `toolKb.ts` | the tool schemas, descriptions and runners |
| `envelope.ts` / `caller.ts` | the wire/entity conversion, the identity tuple, who is asking |
| `command.ts` / `skills.ts` | the `/jira` subcommands and the three bundled skills |
| `sessionRecord.ts` | the close-out scan, the push-failure record and the per-apply session recorder |
| `testing/host.ts` | the real-composition harness the wiring suites mount |

`/jira` is read-only except for `new` and `sync`; `sync` flushes the service's own queue rather than starting a second one.

Every completed turn of a writable root agent settles the ledger: the derived files are regenerated and committed, then the session close-out records the commits the session made on the issues they mention. A successful settle schedules a push only when the service row enabled the push switch.

<a id="tests"></a>

## Tests

`pnpm test` runs `node --import tsx --test "src/**/*.test.ts"`. The wiring suites (`index`, `schema`, `surfaces`, `messages`) mount the shipped services through a real Cordis context — system prompt, tools, dafeiyu, commands, skills and `jira-service` — so they exercise the real registrations rather than a hand-built host.

The tsx loader resolves workspace packages through the repository's tsconfig paths, so a source checkout needs no build. From the repository root, `pnpm run test:jira` runs every jira `node:test` suite and the package-level vitest specs; the CI static gate runs `test:jira:node` while the coverage lane runs the vitest specs.

<a id="model-experience"></a>

## Model Experience

### The root tools and the executor's tool

#### What the model sees

Every request of a root agent carries the three tools: `jira_issue` with its ten verbs (`get`, `create`, `update`, `switch_state`, `comment`, `assignee`, `link`, `tag_create`, `close`, `batch_close`), `jira_list`, and `jira_kb` with `get`, `search`, `create` and `update`. A delegated child carries the same three for reading the issue it was dispatched for, plus `issue_work` with `progress`, `deliver` and `blocked`; its `jira_issue` and `jira_kb` writes stay refused, and instead of the awareness line it reads a standing `jira:executor` section. `issue_work` accepts only an issue that is in progress and assigned to the session that dispatched the child, so a child writes exactly the issue it was sent for and nothing once it hands that issue back for review. Their descriptions and schemas stay small and every result renders as text. A write is refused with an ordinary tool result when the session may not write, and the guard denies `jira_issue` earlier so no handler runs.

#### Token effect

A fixed schema cost on every root-agent request, plus the result text of each call. A child carries the three ledger schemas plus `issue_work`, and no awareness line.

#### KV Cache effect

Prefix-stable while the tool definitions and their visibility are unchanged. Every result is an ordinary tool result appended after the reusable prefix, so a call invalidates no earlier entry.

### The `jira:store` awareness line

#### What the model sees

One runtime-context contribution named `jira:store`, order `700`, rendered as a single line: the store's name, how many projects, knowledge entries and open issues it holds, plus the count of machine-anchored read-only projects. It renders nothing for an empty ledger, and it is recomputed only when the ledger commits (`changed`), never per model step. It is a **runtime context, not a system-prompt section**: the line changes while a conversation is open, and a changing system prefix invalidates the provider's KV-cache for the whole conversation; the context is appended at the tail, so the prefix stays stable.

#### Token effect

At most one line on every root-agent request; an empty ledger contributes nothing.

#### KV Cache effect

The text changes only when a commit changes a count, so a stable ledger keeps the prefix cached; a changed line re-tokenizes from this section onward.

### The claim loop

#### What the model sees

When its deployment enables the `superagent` capability, the capability registers ten tools in total, split by role: an ordinary root agent gets six (`superagent_source`, `superagent_scan`, `superagent_claim`, `superagent_workspace`, `superagent_status`, `superagent_dispatch`), and the super agent — the session opened in the configured `superagent_home` — gets five (`superagent_workspace`, `superagent_session`, `superagent_ledger`, `superagent_models`, `superagent_deliver`). The tools are: `superagent_scan` lists the issues that could be taken now, `superagent_claim` proposes one or claims it, `superagent_status` reports ready/proposed/in-progress/in-review/blocked counts and the issues that need a person, `superagent_source` imports the configured GitHub repository's unseen open issues as ledger issues and never writes back to GitHub, `superagent_workspace` lists or changes the host's workspaces (register, unregister, rename, or list orphaned registrations), `superagent_session` runs and steers real workspace Sessions, `superagent_ledger` records and resolves the per-workspace dispatch ledger, `superagent_models` lists the LLM routes a workspace Session can use, `superagent_deliver` copies one file into a registered workspace, and `superagent_dispatch` starts the claimed issue's executor as a real Session of its own, recording that Session on the issue as `[dispatch:session]` so a second dispatch refuses while it still runs — its `recover` verb restarts the executors a restart lost — the last one only when the row's `superagent_worker_preset` names the preset that Session joins, because a Session without one would inherit the dispatcher's ledger rights instead of only `issue_work`. Claiming refuses unless the latest comment on the issue is still this session's own proposal, so a person is asked between the two calls, and it also refuses once the session already holds `superagent_max_workers` issues in progress (default two) — a slot is a claimed issue, so a person's own session is never counted. On every completed root turn the capability also runs one pass in observe mode: it proposes the first ready issue, writes one `[claim-proposal]` comment, and never claims; it stays silent when this session already has work in progress or the latest comment is a proposal. A process-level, unref'd timer repeats that pass every five minutes and stops with the capability; when no writable session exists it can instead run the optional session-less daemon (row fields `superagent_daemon` and `superagent_daemon_workspace`): the daemon proposes under its own synthetic identity and then claims and dispatches its confirmed proposal itself, because a proposal is only claimable by the identity that wrote it. A delegated child, and an executor Session that joined the configured worker preset, carry none of the ten — the jira capability gives them the ledger's reading tools plus `issue_work` and the `jira:executor` section instead. `superagent_session list` reports each running Session's context percentage and the weighted cache-hit percentage over its most recent requests (`cacheHitPercent`) and marks rows at or above `superagent_compact_threshold_percent` (default 30) with `recommendCompact`; that is advice, and the super agent decides whether to compact. `compact` compacts one Session through the host's manual-compaction seam (the same one `/compact` uses) and refuses while the Session runs, so a task is never interrupted; `append`/`prompt` accept `compact: true` to compact before the text is admitted, `curate_memory: true` to make the workspace Session tidy its own memory first (memory stays per-workspace; this checkout never writes another workspace's store), and a turn report carries the context percentage before and after. `append`/`prompt` also accept `delivery`: `queue` (the default) admits the text after the running turn ends, while `interrupt` steers it into that turn so the Session sees it at its next step without aborting a tool call already in flight. An idle Session queues either way; the result names the delivery actually used, whether it fell back, and the seq it landed at. Every request also carries a refreshed `[superagent monitor]` line when a workspace Session's open turn passes `superagent_long_running_minutes` (default 10), listing its age, last activity and in-flight tool; the super agent decides what to do with it. `inspect` shows a running Session's live status (turn start, elapsed, last activity, in-flight tool) and its recent steps and errors. `abort` cancels a running turn, reports the captured scene, and continues the Session with `text` once it is idle; an idle Session is refused instead of faked. Each dispatch's pending/returned state is authoritative in an optional `superagent_dispatch` storage domain (one record per task id, `per-record` layout, backed by the base composition's `superagent.sqlite` in the deployment's storages directory) and is also appended to `.superagent/ledger/<workspace-id>.md` as a human-readable git-visible projection. The domain records `workspace` (id/title/path), `sessionId`, `superSession`, status/timestamps, outcome, artifacts and decisions, so a reload or a later process can route a report to the super Session that actually dispatched it. On first open the store imports existing Markdown entries without rewriting them, skips keys already present, and preserves task IDs/timestamps; a repeated open is a no-op. Archive/stop marks pending records `orphanedAt` and retains them for audit. A host without `storageDomain` (or whose route is unavailable) keeps the Markdown ledger path for record/list/resolve/turn-end, with no startup failure.
A new super workspace is seeded with an `AGENTS.md` definition (existing edits are preserved), so every conversation opened there reads the role and dispatch conventions even when the capability's prompt section is not in play. Each dispatch appends a `pending` row to `.superagent/ledger/<workspace-id>.md`; the child turn-end hook resolves it to `returned`, and `superagent_ledger resolve` adds outcomes, artifacts and open decisions. The ledger references jira issue keys only; jira owns issue state. The durable conclusion is left to `memory_write` (the super workspace's MEMORY.md is per-workspace, append-only, 8 KiB per line, 16 KiB managed block, 40 entries per session), which is why the ledger is a separate structured file rather than a memory entry. `superagent_session` `start`, `append` and `prompt` accept optional `provider`, `model` and `reasoning_effort` (the same names as `subagent`). The host's `session.selectModel` records a Session model selection, so append/prompt switch the next turn without forking; the reply carries the accepted `model`. Omit all three fields to follow the current/default route. `superagent_models` lists providers, a provider's models, or one model's reasoning efforts from the same `llm` registry; a workspace Session has no subagent route allowlist, so this is the deployment's actual route surface. `superagent_deliver` is the super agent's one write into a workspace directory: the host copies a file (a report, xlsx/csv, or an attachment the person dropped under `$DSH_HOME/attachments`) into a registered workspace, proves that the destination stays inside that workspace's physical directory, and refuses to replace an existing file unless `overwrite` is true. The capability contributes the registered workspaces to the in-process filesystem fence's fs-only grant, so `write`/`edit` can land there too; shell and terminal confinement are unchanged, which is what keeps a host whose sandbox cannot express extra roots (Windows ACL) working. Set `superagent_write_registered_workspaces: false` to keep the single-workspace fence. The workspace verb's `remove` goes through the live registry, not a storage file: it unregisters only, keeps the directory and every Session log, and requires `confirm` to repeat the target id, title, or path; `rename` changes only the display title. `superagent_session delete` is available only on a host with a real Session erase API. Current hosts expose only `archive`, so the tool refuses rather than pretending, and the durable JSONL under `~/.dsh/sessions` remains.

#### Token effect

Six small schemas on an ordinary root-agent request (five on the super agent's) while the capability is on, plus the result text: a candidate list, the claimed issue with its dispatch instruction, the status counts, or the workspace roster.

#### KV Cache effect

Prefix-stable while the capability and its definitions are unchanged; the two capabilities gate independently, so enabling one does not disturb the other's tools.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The durable dispatch store is optional.** Without `storageDomain`, or when the SQLite route cannot open, the package deliberately falls back to the Markdown ledger rather than failing startup. Archived/dispatched records are retained with `orphanedAt`; the store does not silently delete audit history.
- **The browser surface is `ui-jira`'s, not this package's.** The agent owns the tools, the awareness line and the write guard; the `jira` settings section reads the same ledger through `remote.jira`, and disabling the capability hides only the model surface.
- **Every runner goes through `ctx.jira`.** The tool modules import `jira-core` only from its package root, for types and presentation helpers; they never open the store, lock it, run git or write files behind the service. `packages/jira/tests/agent-boundary.spec.ts` is the ratchet that keeps it that way.
- **The dispatch surface needs both a worker preset and a super home.** `superagent_dispatch` refuses when the row leaves `superagent_worker_preset` unset, and the capability stays off until a person configures `superagent_home`. The shipped `web-app` branch layer pairs the `jira-worker` preset with the row; a deployment that overrides the row must keep that pairing.
- **The CLI-parity assertion lives outside this package.** `packages/jira/tests/parity.spec.ts` is the neutral suite that reads this package's tool verbs and `jira-cli`'s command table, so the two surfaces are compared without either package depending on the other.
- **The session-less daemon is opt-in and needs a checkout.** `superagent_daemon` defaults to false; with `superagent_daemon_workspace` unset, or without a worker preset or a session controller, the daemon pass writes nothing. Its dispatcher identity is synthetic (`agent:daemon|dsh|<machine>|superagent-daemon`), and it never writes a human confirmation.
- **The awareness line no longer names the workspace binding.** The contract's section names the store and its counts; the workspace→project phrase was a context source in the standalone plugin.

<a id="dev-note"></a>

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
