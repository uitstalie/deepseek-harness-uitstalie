---
kind: upgrade-guide
description: "Memory grows a bounded eviction policy and an explicit forget path, summary failures become reason-coded, and session search survives one unreadable stored session."
---

# Memory eviction, explicit forget, and search containment

English | [中文](guide.zh.md)

## Change

`dsh-memory` no longer fails a write just because the managed block reached `maxBytes`. When an append or summary would exceed the budget, the provider evicts individual entries in a fixed durability order — `open`, then `files`, then `decision`, then `preference`, oldest first within one kind — never evicting the turn being written. Each removal is recorded in the `MEMORY.md` frontmatter (`at`, `sessionId`, `kind`, `turn`, `text`, `reason`, `detail`), and `memory_write` names every evicted entry, calling out an evicted `decision` explicitly. A single incoming entry that cannot fit even after every other entry is evicted still fails loudly; raise `maxBytes` or forget something first.

The model surface gains a fourth tool, `memory_forget`, with optional `kind`, `tag`, `beforeTurn`, `sessionId`, and `allSessions` filters; at least one of `kind`, `tag`, or `beforeTurn` is required. The human surface gains `/memory forget ...` and a filtered `/memory prune --kind <kind> --tag <tag> --before-turn <n> [--session <id> | --all-sessions]`; `/memory prune [keep]` keeps its previous cap semantics. Every explicit removal is recorded in the frontmatter too, and `memory_forget` refreshes the snapshot.

`maxBytes` stays configurable and still defaults to `16384`; the default now has a stated rationale in the config schema and the [config catalog](../../../config-catalog.md#deepseek-aidsh-memory): it matches the snapshot's own 16 KiB budget so the persisted body and the rendered snapshot stay one prompt-sized block.

A summary failure notice is no longer the fixed `Memory summary failed; the previous memory is still in effect.` line. It now names a stable code, the attempt count, and a short cause, for example:

```text
Memory summary failed [UPSTREAM_RATE_LIMIT] (attempt 2/2); previous memory still in effect: provider rate-limited
```

Transient upstream failures (rate limit, timeout, server/transport stream errors, malformed or empty responses) get one bounded retry before the notice; budget, file, and authorization failures are reported after their first attempt. The previous `MEMORY.md` remains in effect. The full error goes to the debug log. The notice is still appended only once per failure code per session, and a successful pass clears that state.

`memory_search` no longer fails when one stored session cannot be observed. The provider skips that session, keeps any index rows it already has, continues searching the rest of the workspace, and returns `warnings` on the search page; `memory_search` renders each warning as a `Warning:` line naming the session and the failure. A repaired stored log is picked up on a later search without restarting.

The v1-to-v2 Session migration now keeps a usage-only chunk that follows the terminal `finish` in the same Assistant attempt. A released adapter that emitted `finish` before `usage` produced a log whose complete ordered attempt no longer matched the message's chunk references; that log now migrates instead of failing the read. New `llm-plus` OpenAI-compatible streams also defer the terminal finish to the end of the stream so a trailing usage frame cannot recreate the pattern.

## Automatic cleanup

Active memory now cleans itself before capacity eviction, in this fixed order: TTL, supersession, same-turn deduplication, then capacity eviction. `open` entries default to a 3-day TTL and `files` entries to 14 days (`openTtlDays`, `filesTtlDays`); `0` disables a rule, and `decision`/`preference` never expire automatically. TTL uses the turn-start time from the session log when available and otherwise the session `updatedAt`.

A new `memory_resolve` tool archives finished `open` work explicitly; it needs `turn`, `tag`, or an explicit `all: true`. `memory_write` now accepts `supersedes`, a list of tags naming older entries of the same kind in the same session that the write replaces. Without `supersedes`, supersession requires the same session, the same short-lived kind, an older turn, at least `supersessionMinSharedTags` (default 2) shared tags, and Jaccard ≥ 0.5. Same-turn deduplication is deliberately narrow: it only removes entries sharing a commit hash, or two `files` entries naming the same single path; the longer text is kept.

Every automatic removal writes a full-text record to `MEMORY.archive.md` with `session`, `turn`, `tags`, `archivedAt`, `originalAt`, `reason`, and the original text, and adds a bounded audit record to the `MEMORY.md` frontmatter. `memory_search` searches the archive and marks those hits `archived: <reason>`. Archive writes are deduplicated by `(session, turn, kind, normalized text)`, so a retried or stale write cannot duplicate a record. If the archive cannot be written, TTL/resolve/supersede/dedup removals are skipped and the new entry still commits; capacity eviction proceeds to keep the write inside `maxBytes`.

## Migration

1. No memory-file migration is required. `evictions` is an optional frontmatter field; files written by the previous provider parse unchanged, and a file without it renders as before.
2. Expect automatic evictions only when a workspace is at its body budget. Review `/memory stats` (it now reports recorded evictions) and raise `maxBytes` if the default retention is too aggressive for a workspace.
3. Agents that enumerate memory tools now see `memory_forget`. Update any profile-level tool allowlists or documentation that names exactly three memory tools.
4. Clients that render memory summary-failure notices should not match on the old fixed sentence. Match the `Memory summary failed` prefix and read the bracketed code and attempt count; the notice is still bounded to 120 characters.
5. Search consumers may read the optional `warnings` field on `SessionSearchPage`. It is absent when every stored session was observed. The existing `items` and cursor behavior is unchanged.
6. Confirm the change: fill a test workspace to its body budget and observe the next `memory_write` succeed with an `Evicted ...` line and an `evictions:` frontmatter entry; call `memory_forget` with a tag and see the entries disappear; force a summary failure and see the code and attempt count in the notice; point search at a workspace with one damaged stored session and see the other sessions' hits plus a `Warning:` line.

## Rollback

Revert the `dsh-memory`, `dsh-session-query`, `dsh-session-query-sqlite`, `dsh-session-format-v1-to-v2`, and `dsh-llm-plus` commits for this change. Memory files stay readable in both directions: older providers ignore the optional `evictions` field, and newer providers accept files without it. No stored session artifact is rewritten by the reader fix.
