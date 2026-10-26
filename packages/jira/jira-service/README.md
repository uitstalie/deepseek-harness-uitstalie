---
description: "The jira ledger's single writer: resolves the root, opens the store, owns the push queue and settle, registers the ctx.jira service, and publishes the read-only remote.jira browser face."
kind: "package-reference"
---

# @deepseek-ai/dsh-jira-service

English | [中文](README.zh.md)

## Summary

`dsh-jira-service` is the ledger's single writer: one row owns one ledger, resolves its root, reads this machine's identity, opens the store, holds the one push queue, regenerates the derived files, and emits `changed` whenever it commits. The browser, other capabilities, and the CLI share that service through `ctx.jira`, so a ledger never has two writers. It also publishes `remote.jira`, the read-only browser face. Push is off by default: writes stay local commits until `push.enabled` turns the queue on.

## Table of Contents

- [Service](#service)
- [Remote](#remote)
- [Configuration](#configuration)
- [Tests](#tests)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="service"></a>

## Service

One `jira-service` row owns one ledger: it resolves the root, reads this machine's identity, opens the store, holds the one push queue, refreshes the derived files and emits `changed` for whoever draws a board or an awareness line.

A second consumer — a UI, another capability, a shell — shares this service through `ctx.jira`; nobody else pushes. Across processes the store's own file locks are the guard, so the CLI can commit while a host session is open.

`ctx.jira` implements the contract in [`src/types.ts`](src/types.ts): read methods (`list`, `get`, `board`, `doctor`, `searchKnowledge`), write methods (`create`, `transact`, `kbCreate`, `kbUpdate`), `sync` and `settle`, plus the `changed` subscription. Every method returns a `Result`; errors are `JiraError` with one of the twelve codes, and permission is not decided here — the guard in `jira-agent` refuses a write before it reaches the ledger.

Two methods are the phase-1 bridge to the agent's existing tool runners: `store()` hands back the opened store, and `notifyWrite()` records a write those runners made directly, so `changed` still fires and the queue still arms. Both disappear when the tools move onto the write methods above.

<a id="remote"></a>

## Remote

`ctx.jiraRemote` is the browser face and the only thing a client may call: it is a Typert remote service in the `jira` namespace (`remote.jira`), mounted by this row's own constructor on a child fiber, so one row answers both the tools and the UI from one ledger.

| Method | Returns |
|---|---|
| `status()` | root, audit host, machine identity, push switch, last push outcome, whether a push is armed |
| `board()` | issues grouped by status, blocked group last, with counts |
| `list(query)` | the same result narrowed by `project`, `status`, `tag`, `tags`, `assignee`, `includeClosed`, `limit` |
| `get(key)` | one issue's frontmatter fields and Markdown body |
| `kbSearch(query, topK?)` | ranked knowledge hits with their `file:line` |

There are no write methods: writes go through the model's tools, which the agent's guard constrains. Every result is plain JSON — branded ids, timestamps and identities arrive as `string` — so the browser needs no ledger types. A ledger failure becomes a `RemoteError` whose code is `jira/<kebab-code>` (one per `jira-core` code) and whose `details.jiraCode` is the ledger's own code; the message is the ledger's formatted report.

<a id="configuration"></a>

## Configuration

| Key | Effect |
|---|---|
| `root` | Ledger root; absent resolves through `$JIRA_ROOT`, then `$DSH_HOME/jira`, then the profile's `.dsh/jira`. Volatile: a settings write reopens the ledger without a remount |
| `host` | The `owner.host` audit field; absent is this machine's hostname. Volatile, like `root` |
| `machine_id` | Overrides `$DSH_HOME/dsh-jira/machine-id` (never stored in the ledger) |
| `remote` | Git remote to join on load; local only, it never clones or fetches |
| `push.enabled` | Whether a settle schedules a push; default false keeps everything local. Volatile: the switch applies without a restart |
| `push.debounce_ms` | Debounce window; absent is the core default |

The vocabulary (statuses, transitions, priorities, types, resolutions) is **not** configuration here: it lives in the ledger's `config.md`, where git versions it.

<a id="tests"></a>

## Tests

`tests/composition.spec.ts` boots the service through the real Loader: a test-only [`tests/fixtures/cordis.yml`](tests/fixtures/cordis.yml) inserts this one row over a temporary ledger, and the spec asserts that `ctx.jira` opens it, reports the resolved root and identity, and reads an issue and the board. `tests/remote.spec.ts` boots the same row over a temporary ledger with one issue and one knowledge entry and calls the Remote methods directly: JSON-safe results, the grouped board, the filter, the detail, the knowledge hit, and the two failure codes. Run both with `pnpm exec vitest run packages/jira/jira-service`.

<a id="model-experience"></a>

## Model Experience

None, as nothing here reaches a model directly: the tools live in `jira-agent`, and this service only decides where the ledger is, who writes, and whether commits leave the machine; when `push.enabled` is on, a successful settle arms a debounce, so the model's writes land as local commits first and travel afterwards.

#### KV Cache effect

None of its own; a commit it makes changes ledger data, and only `jira-agent` decides whether any of that text re-enters a request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- `store()`, `notifyWrite()` and `pushQueue()` are the phase-1 bridge described above, not part of the long-term contract.
- `status()` is synchronous and reports `machineId` as `local` until the service first opens the ledger; a client that shows the identity reads `board()` (or any other method) first.
- The composition test covers the read surface; the write methods, `sync` and `settle` are exercised through `jira-core`'s suites and the agent's wiring suites.

<a id="dev-note"></a>

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
