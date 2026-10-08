---
description: "The workspace .dsh store for users and maintainers who need its path refusal matrix, store operations, and the model-facing store tool."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-dsh-store

English | [中文](README.zh.md)

## Summary

`dsh-tool-dsh-store` owns the `.dsh` directory of a workspace — the project-level convention that already holds project skills and runtime snapshots. It validates a `.dsh`-relative path against a fixed refusal matrix, performs four store operations through the `ctx.fs` service, and registers one model-facing tool that performs them on request. It also keeps the store root present for each session, skipping that creation while the session may not write.

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

`.dsh` is already this repository's project-level convention: project skills live under `.dsh/skills`, workspace rules live under `.dsh/rules`, and test fixtures write `.dsh/runtime.json`. The store owns that one directory, so a caller names a target relative to `.dsh` instead of assembling an absolute path.

### What the tool does

The registered `tool-dsh-store` tool takes an `action` of `create`, `query`, or `delete` and a `path` relative to `.dsh`. `create` writes a file or makes a folder, `query` lists a folder or reads a file, and `delete` removes a file or a folder — a populated folder only when the call also sets `recursive`. Creating a rule validates the `rules` namespace first: the target must be Markdown, its text must not be empty, and its text must not repeat a rule that already exists.

### Paths are validated before they are used

`normalizeStorePath` accepts a `.dsh`-relative path and rejects every form that could leave the root or name something different on another platform: absolute POSIX paths and UNC prefixes, Windows drive letters, `..` escapes, `~`, `$`, and `%` expansions, Windows reserved device names, illegal characters, and segments ending in a dot or space. A doubled separator, a `.` segment, and surrounding whitespace are normalized rather than rejected, because they name the same target.

### Store operations

| Operation | Function | Result |
|---|---|---|
| Ensure the root exists | `ensureStoreRoot` | Whether this call created it |
| Create a folder | `createStoreFolder` | `{ path, kind: 'directory' }` |
| Create a file | `createStoreFile` | `{ path, kind: 'file' }` |
| Query a target | `queryStoreTarget` | Target kind, direct children, and optionally file text |
| Remove a target | `removeStoreTarget` | `{ path, kind }`; a populated directory requires `recursive` |

Every operation takes an absolute path that the path layer already confined to the root plus the `FileSystem` service, and a mutation also receives the calling session's resolved policy, so a confining provider fences the same call.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`src/paths.ts` holds the refusal matrix as pure functions that never touch the filesystem, which is why every row of the matrix is pinned by a unit test instead of an integration case. `src/store-ops.ts` maps the four operations onto `FileSystem.mkdir`, `writeText`, `stat`/`listDir`/`readText`, and `remove`, and returns named result records so callers read data rather than filesystem state. `src/policy.ts` resolves the per-session policy once per mutating call and refuses a `read-only` session with the shared denial marker; a query is not gated, because reading the store does not write it. `src/tool.ts` defines the tool and restricts the `rules` namespace, and `src/index.ts` resolves `<projectRoot>/.dsh` per session — `cwd` upward to a `.git` marker, `cwd` when no marker exists — and creates it once the session may write.

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

- **Namespace checks cover `rules` only** — `mcp.json` and `skills/**/SKILL.md` are written as given; validating them is deferred.
- **The root is fixed to `.dsh`** — it is not configurable, so one workspace has exactly one store.
- **A read-only session keeps no store root** — creating it is a write, so it appears the first time the session may write, and a query placed before that reports the root as missing.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: open questions and directions that are not decided. Shipped behavior and accepted rationale live in the sections above and in the package code.

- **Namespace validation for `mcp.json` and `skills/**/SKILL.md`** — the `rules` checks landed first; the other two namespaces need the MCP client's schema and the skill manifest rules respectively.

</details>
