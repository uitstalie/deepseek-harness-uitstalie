---
description: "The .dsh base interface: a dshStore service for path-confined store operations, plus the model-facing store tool and a read-only sidebar Remote."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-dsh-store

English | [中文](README.zh.md)

## Summary

`dsh-tool-dsh-store` owns a workspace's `.dsh` directory — the project-level convention holding project skills and runtime snapshots. The `ctx.dshStore` service is the base interface for `.dsh` management, owning project-root discovery, path confinement, the store operations including the version-guarded `writeFile`, namespace authoring checks, and the session policy gate; the model-facing tool and read-only Remote consume it. `.dsh/memory` is reserved for the memory capability, which writes it through the service while the tool may only read it. The plugin also keeps each session's store root present and serves `remote.dshStore`, letting the Web sidebar list and read a workspace's rules without a session.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### The .dsh directory is the store

`.dsh` is already this repository's project-level convention: project skills live under `.dsh/skills`, workspace rules live under `.dsh/rules`, and test fixtures write `.dsh/runtime.json`. The store owns that one directory, so a caller names a target relative to `.dsh` instead of assembling an absolute path. The `dshStore` service is the base interface other plugins consume: `projectRootFor`, `rootFor`, `prepare`, and one method per store operation, each with the same refusals; the tool below is its main consumer.

### What the tool does

The registered `tool-dsh-store` tool takes an `action` of `create`, `query`, or `delete` and a `path` relative to `.dsh`. `create` writes a file or makes a folder, `query` lists a folder or reads a file, and `delete` removes a file or a folder — a populated folder only when the call also sets `recursive`. Creating a rule validates the `rules` namespace first: the target must be Markdown, its text must not be empty, and its text must not repeat a rule that already exists. Writing a skill validates the skill document the skill root needs: the path must be one of the two shapes it discovers, the frontmatter must be a mapping, and `name` must be lowercase words joined by hyphens (`skills/review.md`, `skills/handoff/SKILL.md`).

### Paths are validated before they are used

`normalizeStorePath` accepts a `.dsh`-relative path and rejects every form that could leave the root or name something different on another platform: absolute POSIX paths and UNC prefixes, Windows drive letters, `..` escapes, `~`, `$`, and `%` expansions, Windows reserved device names, illegal characters, and segments ending in a dot or space. A doubled separator, a `.` segment, and surrounding whitespace are normalized rather than rejected, because they name the same target.

### Store operations

| Operation | Function | Result |
|---|---|---|
| Ensure the root exists | `ensureStoreRoot` | Whether this call created it |
| Create a folder | `createStoreFolder` | `{ path, kind: 'directory' }` |
| Create a file | `createStoreFile` | `{ path, kind: 'file' }` |
| Write a file with an optional version guard (service only) | `writeFile` | `{ path, version }`; a stale `expected` rejects with `FS_STALE_VERSION` |
| Query a target | `queryStoreTarget` | Target kind, direct children, and optionally file text |
| Remove a target | `removeStoreTarget` | `{ path, kind }`; a populated directory requires `recursive` |

The `store-ops` helpers take an absolute path that the path layer has already confined to the root plus the `FileSystem` service; `writeFile` takes the `.dsh`-relative path and resolves it itself, and it is the write path for a plugin that owns a namespace. Every mutation receives the calling session's resolved policy, so a confining provider fences the same call. The `memory/**` area is writable through the service but read-only for the tool: `query` reaches it while `create` and `delete` are refused.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`src/paths.ts` holds the refusal matrix as pure functions that never touch the filesystem, which is why every row of the matrix is pinned by a unit test instead of an integration case. `src/store-ops.ts` maps the store primitives onto `FileSystem.mkdir`, `writeText`, `stat`/`listDir`/`readText`, and `remove`, and returns named result records so callers read data rather than filesystem state. `src/namespaces.ts` holds the namespace authoring checks plus `isMemoryPath`, whose first-segment comparison is case-insensitive because Windows and macOS fold case. `src/policy.ts` resolves the per-session policy once per mutating call and refuses a `read-only` session with the shared denial marker; a query is not gated, because reading the store does not write it. `src/service.ts` is the `dshStore` base interface: it owns project-root discovery, the `.dsh` root, the store operations, the namespace checks, and the policy gate; `writeFile` maps `expected` to `writeText`'s `replaceIfVersion` guard, while an omitted `expected` is the unconditional write and `createIfAbsent` stays unexposed. `src/tool.ts` builds the tool as its consumer and holds the `memory` reservation: it refuses `create` and `delete` on that prefix, so the reservation lives in the tool layer while the service stays writable. `src/index.ts` provides the service, registers the tool and the Remote, and prepares the root on each step once the session may write; the tool is registered at the profile level, so every agent in the profile can call it. `src/remote.ts` is the read-only Remote namespace the sidebar uses: it is addressed by workspace root because a workspace row may have no session, it checks that root against the Host's workspace registry before reading anything, and its listing is the instruction loader's own retained set, so the panel shows exactly what reaches the model.

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Workspace store tool

#### What the model sees

One tool named `tool-dsh-store` with a required `action` of `create`, `query`, or `delete`, a required `path` relative to `.dsh`, and the optional `target`, `content`, and `recursive` fields. Each call answers with one short text result — `Created file .dsh/rules/api.md.`, `Deleted directory .dsh/rules.`, or `Not found: .dsh/rules/absent.md.` — and a folder query lists its direct children as `- file .dsh/rules/api.md (24 bytes)`.

#### Token effect

Fixed schema cost on every request where the tool is visible. Results stay small: a folder query grows with the number of direct children, and a file query returns that file's complete text.

#### KV Cache effect

Prefix-stable while the definition and visibility are unchanged. Results are ordinary tool results appended after the reusable prefix, so they invalidate no earlier entry.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits describe what the package deliberately does not do.

- **Content checks cover `rules` and `skills`** — a `mcp.json` namespace is deliberately not checked, because no plugin in the harness reads one; validating it would invent a convention instead of protecting an existing consumer.
- **`memory/` is matched without case** — on a case-insensitive filesystem `Memory/...` aliases `memory/...`, so the tool refuses `memory`, `Memory`, and every descendant; the service stays writable for the memory capability.
- **The root is fixed to `.dsh`** — it is not configurable, so one workspace has exactly one store.
- **A read-only session keeps no store root** — creating it is a write, so it appears the first time the session may write, and a query placed before that reports the root as missing.
- **The tool is visible profile-wide** — it is registered at the profile level, so every agent in the profile (including the `minimal` preset) sees it; the store root described above still follows each session.
- **Omitting `expected` makes `writeFile` unconditional** — it creates or replaces whatever is there without a staleness check; the `createIfAbsent` guard is a separate `FileSystem.writeText` mapping that the store service does not expose yet.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: open questions and directions that are not decided. Shipped behavior and accepted rationale live in the sections above and in the package code.

- **Whether a `mcp.json` namespace should exist at all** — it would need a consuming plugin before the store could meaningfully validate its contents.

</details>
