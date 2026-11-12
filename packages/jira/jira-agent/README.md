---
description: "The jira ledger's model surface: the dafeiyu capability providers registering the jira_issue, jira_list and jira_kb tools, the executor's issue_work tool, the claim loop, the write guard, the /jira command, the bundled skills and the turn-end settle."
kind: "package-reference"
---

# @deepseek-ai/dsh-jira-agent

English | [中文](README.zh.md)

## Summary

Read and update the issue ledger through `jira_issue`, `jira_list`, and `jira_kb`; delegated workers use `issue_work`. Root agents also receive the ledger awareness line, write guard, `/jira`, three skills, and turn-end settlement. The separately gated superagent capability adds claim, status, source, dispatch, and workspace/Session control tools. Both capabilities integrate with `ctx.jira`, the tool registry, and `ctx.dafeiyu`; commands and skills are optional. The `jira` capability is off by default. `superagent` requires a safe `superagent_home`; the ledger's root, identity, and push queue belong to `jira-service`.

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
| `superagent-permission.ts` | one target workspace Session's permission catalog, current state, audited switch and start default |
| `dispatch-reports.ts` | the superagent-owned report journal: binding before the prompt, saved report text, delivery failure inspection and explicit retry |
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

When its deployment enables the `superagent` capability, the capability registers nine tools in total, split by role: an ordinary root agent gets six (`superagent_source`, `superagent_scan`, `superagent_claim`, `superagent_control`, `superagent_status`, `superagent_dispatch`), and the super agent — the session opened in the configured `superagent_home` — gets five (`superagent_control`, `superagent_ledger`, `superagent_models`, `superagent_permission`, `superagent_deliver`). The tools are: `superagent_scan` lists the issues that could be taken now, `superagent_claim` proposes one or claims it, `superagent_status` reports ready/proposed/in-progress/in-review/blocked counts and the issues that need a person, `superagent_source` imports the configured GitHub repository's unseen open issues as ledger issues and never writes back to GitHub, `superagent_control` lists or changes the host's workspaces (register, unregister, rename, or list orphaned registrations) and runs and steers their real Sessions, `superagent_ledger` records and resolves the per-workspace dispatch ledger, `superagent_models` lists the LLM routes a workspace Session can use, `superagent_permission` lists, reads or switches the permission of one explicitly addressed workspace Session, `superagent_deliver` copies one file into a registered workspace, and `superagent_dispatch` starts the claimed issue's executor as a real Session of its own, recording that Session on the issue as `[dispatch:session]` so a second dispatch refuses while it still runs — its `recover` verb restarts the executors a restart lost — the last one only when the row's `superagent_worker_preset` names the preset that Session joins, because a Session without one would inherit the dispatcher's ledger rights instead of only `issue_work`. Claiming refuses unless the latest comment on the issue is still this session's own proposal, so a person is asked between the two calls, and it also refuses once the session already holds `superagent_max_workers` issues in progress (default two) — a slot is a claimed issue, so a person's own session is never counted. On every completed root turn the capability also runs one pass in observe mode: it proposes the first ready issue, writes one `[claim-proposal]` comment, and never claims; it stays silent when this session already has work in progress or the latest comment is a proposal. A process-level, unref'd timer repeats that pass every five minutes and stops with the capability; when no writable session exists it can instead run the optional session-less daemon (row fields `superagent_daemon` and `superagent_daemon_workspace`): the daemon proposes under its own synthetic identity and then claims and dispatches its confirmed proposal itself, because a proposal is only claimable by the identity that wrote it. A delegated child, and an executor Session that joined the configured worker preset, carry none of the ten — the jira capability gives them the ledger's reading tools plus `issue_work` and the `jira:executor` section instead. `superagent_control list` reports each running Session's context percentage and the weighted cache-hit percentage over its most recent requests (`cacheHitPercent`) and marks rows at or above `superagent_compact_threshold_percent` (default 30) with `recommendCompact`; that is advice, and the super agent decides whether to compact.

##### Lifecycle and report semantics

```markdown
`compact` compacts one Session through the host's manual-compaction seam (the same one `/compact` uses) and refuses while the Session runs, so a task is never interrupted; `append`/`prompt` accept `compact: true` to compact before the text is admitted, `curate_memory: true` to make the workspace Session tidy its own memory first (memory stays per-workspace; this checkout never writes another workspace's store), and a turn report carries the context percentage before and after. `append`/`prompt` also accept `delivery`: `queue` (the default) admits the text after the running turn ends, while `interrupt` steers it into that turn so the Session sees it at its next step without aborting a tool call already in flight. An idle Session queues either way; the result names the delivery actually used, whether it fell back, and the seq it landed at. Every request also carries a refreshed `[superagent monitor]` line when a workspace Session's open turn passes `superagent_long_running_minutes` (default 10), listing its age, last activity and in-flight tool; the super agent decides what to do with it. `inspect` shows a running Session's live status (turn start, elapsed, last activity, in-flight tool) and its recent steps and errors. `abort` cancels a running turn, reports the captured scene, and continues the Session with `text` once it is idle; an idle Session is refused instead of faked. Report routing belongs to the super agent, not to this ledger: every dispatch appends a `pending` binding to `.superagent/reports.jsonl` (child `sessionId`, prompt `requestId`, `superSession`, workspace and instruction) **before** the child prompt is admitted. The turn-end hook matches the ending turn by its own `user/message.source.rpcId`, claims the binding, delivers the report once, and settles it `delivered`; a failed delivery leaves a `failed` record and logs the reason instead of dropping the report. The journal needs no storage-domain composition and survives a reload. The `.superagent/ledger/<workspace-id>.md` projection and the optional `superagent_dispatch` storage domain remain the human-readable, auditable ledger for `superagent_ledger` (one record per task id, `per-record` layout, backed by the base composition's `superagent.sqlite` in the deployment's storages directory); the turn-end hook projects the outcome there best-effort after delivery, so a missing or malformed ledger entry can never suppress a report. The domain records `workspace` (id/title/path), `sessionId`, `superSession`, status/timestamps, outcome, artifacts and decisions. On first open the store imports existing Markdown entries without rewriting them, skips keys already present, and preserves task IDs/timestamps; a repeated open is a no-op. Archive/stop marks pending ledger records `orphanedAt`, retains them for audit, and fails any still-pending report binding for that Session. A host without `storageDomain` (or whose route is unavailable) keeps the Markdown ledger path for record/list/resolve, with no startup failure; reports do not depend on it.
```


##### Dispatch and monitor results

```markdown
Dispatch and monitoring results include context usage, delivery, status, and task-report fields; business results remain separate from report delivery.
```

#### Token effect

Six small schemas on an ordinary root-agent request (five on the super agent's) while the capability is on, plus the result text: a candidate list, the claimed issue with its dispatch instruction, the status counts, or the workspace roster.

#### KV Cache effect

Prefix-stable while the capability and its definitions are unchanged; the two capabilities gate independently, so enabling one does not disturb the other's tools.

### Workspace handoff and reporting

#### What the model sees

A new super workspace gets an `AGENTS.md` whose plugin-owned block (between the `superagent:managed` markers, currently v1) carries the role and dispatch conventions; text outside the block is never rewritten. The block is re-checked when the capability is created and whenever a super Session opens: a version bump replaces only the block, a hand-edited block is left alone with one visible notice, and an unchanged file is not touched. Each dispatch appends a `pending` row to `.superagent/ledger/<workspace-id>.md`. At turn end the domain records the business `returned`/`failed` result before delivery, independently of report delivery; only a delivered report refreshes the Markdown projection. `superagent_ledger resolve` settles or corrects that result, including artifacts and open decisions; a pending task needs a non-empty outcome and cannot be changed back to pending. `report_status` lists failed deliveries with reasons, and `retry_report` resends the exact saved report after the recipient recovers. The dispatch result names both the ledger directory and its Markdown file. The ledger references jira issue keys only; jira owns issue state. The durable conclusion is left to `memory_write` (the super workspace's MEMORY.md is per-workspace, append-only, 8 KiB per line, 16 KiB managed block, 40 entries per session), which is why the ledger is a separate structured file rather than a memory entry. `superagent_control` `start`, `append` and `prompt` accept optional `provider`, `model` and `reasoning_effort` (the same names as `subagent`). The host's `session.selectModel` records a Session model selection, so append/prompt switch the next turn without forking; the reply carries the accepted `model`. Omit all three fields to follow the current/default route. `superagent_models` lists providers, a provider's models, or one model's reasoning efforts from the same `llm` registry; a workspace Session has no subagent route allowlist, so this is the deployment's actual route surface. `superagent_deliver` is the super agent's one write into a workspace directory: the host copies a file (a report, xlsx/csv, or an attachment the person dropped under `$DSH_HOME/attachments`) into a registered workspace, proves that the destination stays inside that workspace's physical directory, and refuses to replace an existing file unless `overwrite` is true. The capability contributes the registered workspaces to the in-process filesystem fence's fs-only grant, so `write`/`edit` can land there too; shell and terminal confinement are unchanged, which is what keeps a host whose sandbox cannot express extra roots (Windows ACL) working. Set `superagent_write_registered_workspaces: false` to keep the single-workspace fence. `remove_workspace` goes through the live registry, not a storage file: it unregisters only, keeps the directory and every Session log, and requires `confirm` to repeat the target id, title, or path; `rename_workspace` changes only the display title. `superagent_control delete` is available only on a host with a real Session erase API. Current hosts expose only `archive`, so the tool refuses rather than pretending, and the durable JSONL under `~/.dsh/sessions` remains.

##### Permission setup and switches

```markdown
`superagent_control start` explicitly establishes `workspace-write` before it admits the first task; failure leaves the new Session unprompted and returns an error. `superagent_permission` `list` needs no target, while `get` and `set` require both the registered `workspace` and an exact `session` id. `set` uses the existing permission service, records `permission/preset` plus changed sandbox/approval events, and verifies the effective values. The available presets include `read-only`, `workspace-write`, and `danger-full-access` when configured. `soft` is available only in the unconfined soft-policy composition and selects `guarded`: full process file access with tool/path blacklists, unchanged independent approval policy, and no ACL or OS confinement. It never disables a live OS sandbox. Widening access requires `reason`; the authorized super agent does not need another human approval for each switch.
```

#### Token effect

Dispatch results carry the workspace, Session, model, ledger, and report-routing fields; a file handoff also carries its delivered path.

#### KV Cache effect

Results do not rewrite the system prompt. The report arrives as a later message, and the selected route applies at the next turn boundary.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The durable report journal is mandatory for a dispatch.** A tool refuses before prompting when its report binding cannot be written; the dispatch domain owns business results, and the Markdown ledger is a human-readable projection, so a projection failure never loses a report. A failed delivery remains visible through `report_status`; `retry_report` explicitly resends its saved text. Without `storageDomain`, or when the SQLite route cannot open, the ledger falls back to Markdown rather than failing startup. Archived/dispatched records are retained with `orphanedAt`, and pending report bindings for an archived or stopped Session become failed; neither store silently deletes audit history.
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
