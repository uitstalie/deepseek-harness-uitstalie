---
kind: upgrade-guide
description: "Memory grows a bounded eviction policy and an explicit forget path, summary failures become reason-coded, and session search survives one unreadable stored session."
---

# Memory eviction, explicit forget, and search containment

English | [中文](guide.zh.md)

## Change

`dsh-memory` no longer fails a write at `maxBytes`. When an append or summary would exceed the budget, the provider evicts entries in a fixed order — `open`, `files`, `decision`, `preference`, oldest first within a kind — never the turn being written. Each removal is recorded in the `MEMORY.md` frontmatter, and `memory_write` names every evicted entry. A single oversized entry still fails.

The model surface gains `memory_forget` with optional `kind`, `tag`, `beforeTurn`, `sessionId`, and `allSessions`; at least one of `kind`, `tag`, or `beforeTurn` is required. `/memory forget` and filtered `/memory prune` mirror it. `maxBytes` still defaults to `16384`, matching the snapshot's 16 KiB budget.

A summary failure notice now reports a stable code, attempt count, and cause, for example `Memory summary failed [UPSTREAM_RATE_LIMIT] (attempt 2/2); previous memory still in effect: provider rate-limited`. Transient upstream failures get one bounded retry; budget, file, and authorization failures report after the first attempt. The previous `MEMORY.md` stays in effect, and the notice stays once per code per session.

`memory_search` skips one unobservable stored session, keeps existing index rows, searches the rest, and returns `warnings` rendered as `Warning:` lines. The v1-to-v2 migration keeps a usage-only chunk after terminal `finish`; llm-plus streams defer `finish` to the stream end.

Active memory cleans itself before capacity eviction: TTL, supersession, same-turn deduplication, then capacity eviction. `open` defaults to 3 days and `files` to 14 (`openTtlDays`, `filesTtlDays`; `0` disables); `decision`/`preference` never expire. `memory_resolve` archives finished `open` work. `memory_write` accepts `supersedes`; otherwise supersession requires the same session and short-lived kind, an older turn, at least `supersessionMinSharedTags` shared tags (default 2), and Jaccard ≥ 0.5. Automated removals append a full record to `MEMORY.archive.md` and a bounded audit to the frontmatter, deduplicated by `(session, turn, kind, normalized text)`; a failed archive write skips automatic removals but the new entry commits.

`summarizeEveryTurns` controls how many completed turns share one summary call; the default `1` keeps one call per turn. Larger values batch a strict `{ turns: [...] }` reply and commit per-turn entries in one version-guarded write. A partial batch flushes on disposal; failures keep it pending, cancellation writes nothing, and tier migration follows each batch.

## Migration

1. No memory-file migration is required; `evictions` is optional and older files parse as before.
2. Expect evictions at the body budget; review `/memory stats` and raise `maxBytes` if needed.
3. Update allowlists and docs naming three memory tools.
4. Match summary-failure notices by the `Memory summary failed` prefix, not the old fixed sentence.
5. Search consumers may read the optional `warnings` field, absent when every stored session was observed.
6. Confirm with a budget-filling write, a tagged forget, a forced summary failure, and a search over one damaged session. Revert the `dsh-memory`, `dsh-session-query`, `dsh-session-query-sqlite`, `dsh-session-format-v1-to-v2`, and `dsh-llm-plus` commits to roll back.
