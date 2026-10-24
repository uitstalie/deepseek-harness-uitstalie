# Working one issue with dsh-jira

The issue ledger lives in a local git repository: **one Markdown file per issue**, and every
write is a commit. Use the `jira_issue` tool — it holds the rules, and the store's
`config.md` holds the data those rules are made of (statuses, transitions, which statuses
are closed, the priorities).

## The loop

1. **Read first.** `jira_issue { action: "get", key: "DH-12" }` returns the issue, its
   comments and whether this session may write (`writable`). If `writable` is false, do not
   try to write: a subagent or a read-only session cannot, by design.
2. **Claim it** while you work: `action: "assignee", assignee: "self"`. Release with
   `assignee: "none"` when you stop.
3. **Leave a trail.** `action: "comment", comment: { body: "..." }` for decisions and
   findings; `action: "update", data: { note: "..." }` for the one reminder the next reader
   needs. A comment never changes the issue; a `note` does.
4. **Move it along the declared edges only.** `action: "switch_state", to: "in_progress"`.
   An edge that is not in `config.md` does not exist — the tool answers with the ones that do.
5. **Close with a resolution.** Entering a status in `closed` requires `resolution`
   (`fixed` / `invalid` / `limitation` / `abandoned`), and `limitation` also requires
   `resolution_note` saying what the limit is. Reopening clears the conclusion and records
   it as a comment, so nothing is lost.

## Rules of thumb

* Write small and often: each write is a commit, and the history is the audit log.
* Do not invent a key. `create` allocates one from the store's counters
  (`action: "create", project: "DH", data: { summary: "..." }`).
* Re-read before overwriting when you have been away: pass `expected_revision` and the write
  is refused if somebody moved on without you.
* If the issue is marked conflicted, the write is refused until you pass `ack_conflict`.
  That is a merge conflict a human should look at, not something to bulldoze.
* Never edit `.jira/` or `counters/` by hand.

## Knowledge entries: `jira_kb`

The ledger also holds knowledge (`knowledge/<domain>/KB-<n>.md`): runbooks, pitfalls, how-tos and
concepts. Use `jira_kb` — never write the files directly.

* `action: "search", query: "…"` — the first stop when you are about to do something that has bitten
  somewhere before. It answers with `file:line` and a short snippet, never a whole entry, plus `counts`
  so a truncated answer is visible.
* `action: "get", key: "KB-7"` — one entry, whole.
* `action: "create", data: { domain, type, title, body }` — `type` is one of the store's `kb_types`
  (runbook / pitfall / howto / concept). Do **not** invent a key: `create` allocates one.
* `action: "update", key: "KB-7", data: { … }` — needs a key.

The same write rules apply: a read-only or delegated session cannot create or update, and the source
lineage (`machine_id`, `captured_at`, …) is recorded by the store, not by you.

## Tags: they must exist first

`tags: ["mcp"]` on a create is refused with `UNKNOWN_TAG` until `mcp` is registered — the registry is
the explanation of what a tag *means* (decision 26), so an unused one is not silently invented.

* Create it through the tool: `jira_issue { action: "tag_create", data: { name: "mcp", description: "why this tag exists" } }`
  (`description` is required; `alias` is optional).
* Or from a terminal: `jira tag-create mcp --description "why this tag exists"`.
* The `UNKNOWN_TAG` error carries `registered` (every tag there is) and, when the registry is empty, a
  `hint` naming both ways to create one.

## When to sync (multi-machine)

Every write is committed locally; the push happens on a debounce and again when the session ends, so most
of the time there is nothing to do. Sync explicitly when:

* you are about to **stop** and the work matters to the other machine (a `jira sync` is one command and
  it pulls, refreshes the derived files and pushes);
* you just **pulled** something and want the other machine's writes settled into your view;
* `/jira status` (or `jira sync`) says **本地领先 origin N 个提交** — that means an earlier push did not
  go out. Run `jira sync` and read its line; if it still fails, the reason is now printed.

`jira sync` is also the repair path after a rejected push: it rebases, refreshes and retries.
