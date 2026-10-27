---
description: "The jira ledger's browser surface: the settings section that edits the ledger row and reads the board, one issue's detail and the knowledge search; the ledger itself stays read-only here."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-jira

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-jira` adds the jira ledger's browser surface: one settings section (`id: 'jira'`, `order: 200`) that edits the ledger row and reads the ledger itself — the board grouped by status, one issue's detail, and the knowledge search. The ledger views are read-only (writes stay with the model's tools); the row fields are editable because `jira-service` declares them volatile, so a save applies without a restart. The `dafeiyu` Capabilities list links to the section by id, so the id and order are a contract both halves read from one module.

## Table of Contents

- [The page](#the-page)
- [Faces](#faces)
- [Tests](#tests)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

`dafeiyu`'s Capabilities list links to the section by id (`settings.sectionId: 'jira'`), so the id and order are a contract. Both halves read them from [`src/section.ts`](src/section.ts).

<a id="the-page"></a>

## The page

| Block | Data | Writes |
|---|---|---|
| Ledger | `remote.jira.status()`: root, audit host, push switch, last push, queued push | `root`, `host`, `push.enabled` through the settings service |
| Board | `remote.jira.board()`: issues grouped by status, blocked group last, counts | none |
| Issue detail | `remote.jira.get(key)`: frontmatter fields and the Markdown body | none |
| Knowledge | `remote.jira.kbSearch(query)`: ranked hits with their `file:line` | none |

The three row fields (`root`, `host`, `push.enabled`) are edited in the settings block. Saving writes the `jira-service` profile row through the settings service; the switch writes immediately, and the service reopens the ledger against the new values without a restart. Every ledger write stays with the model: the agent's tools are the only path to the ledger, and the guard in `jira-agent` constrains them. Nothing here reads a ledger file or writes a commit.

The page follows `remote.jira.watch(signal)`. Every committed change — a tool, another session, a sync — refreshes the board, the ledger status and the open issue detail; a reconnect re-reads the same snapshots, because nothing is replayed. Reads carry a generation, so an answer that arrives after a newer read started is dropped, and a notice whose `version` is behind one already applied is ignored. Knowledge hits are one query's snapshot: a change marks them stale instead of re-running the search, and the next search replaces them. Nothing here polls or watches a ledger file.

<a id="faces"></a>

## Faces

- `src/index.ts` — the host entry: an empty plugin body plus the section identity, so the `jira-ui` row loads through this package.
- `src/client/index.ts` — the browser entry: mounts `remote.jira` (the generated Host-for-Client artifact of `jira-service`), registers the `settings.jira` copy dictionary, and contributes the page to `settings.section`.
- `src/client/store.ts` — the page controller: one board read per load, one detail read per selection, one knowledge search per query, plus those same reads after each Host change. A generation per read drops late answers and the notice's `version` drops delayed notifications. It publishes plain data; structured failures reach the components as messages, and copy stays in the dictionary.

<a id="tests"></a>

## Tests

- `tests/jira-section.client.spec.tsx` — registration (section id/order/label, disposal), the Host change stream refreshing an open page and stopping with the fiber, and rendering: the status block, a board row, opening and closing the detail, the knowledge search's `file:line` hit, and a failed board read with retry. Remote data is scripted through the store's narrow `JiraWire`, so the assertions are about what the reader sees.
- `tests/store.client.spec.ts` — the change path without a browser: board/status/detail refresh, late board and detail answers, knowledge staleness, notice version ordering, reconnect, and an unopened page reading nothing.
- `tests/entry.host.spec.ts` — the host entry loads as an inert plugin and publishes the section identity.

Run them with `pnpm exec vitest run packages/jira/ui-jira`.

<a id="model-experience"></a>

## Model Experience

None, as nothing here reaches a model: the page reads the same service the tools write, so what a reader sees and what a model changed cannot disagree; its only writes are the `jira-service` row fields.

#### KV Cache effect

None; the page assembles no request and contributes no prompt text, tool schema, or result.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Board seat:** the board, detail and knowledge search render inside the settings section. A dock/sidebar board would be a second registration (and a designer's layout) rather than another page of this section.
- **dafeiyu Capabilities list:** the Jira row's label, state and "open settings" jump are DH-12's work; this package only owns the section they link to.
- **Writes from another process:** the change feed carries what this Host writes (tools, sessions, sync). A CLI write in another process announces nothing here; the page catches up on the next in-host change, on `connection/reset`, or when the section remounts. Watching ledger files would be a second change source and is out of scope.

<a id="dev-note"></a>

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
