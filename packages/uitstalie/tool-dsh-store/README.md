---
description: "The workspace .dsh store for users and maintainers who need its path refusal matrix, store operations, and the tool that will expose them."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-dsh-store

English | [中文](README.zh.md)

## Summary

`dsh-tool-dsh-store` owns the `.dsh` directory of a workspace — the project-level convention that already holds project skills and runtime snapshots. It validates a `.dsh`-relative path against a fixed refusal matrix and performs four store operations through the `ctx.fs` service: create a folder, create a file, query a target, and remove a target. The package publishes that layer only; the single model-facing tool that will expose it is deferred work, so mounting the package today adds no request content.

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

`.dsh` is already this repository's project-level convention: project skills live under `.dsh/skills`, workspace rules will live under `.dsh/rules`, and test fixtures write `.dsh/runtime.json`. The store owns that one directory, so a caller names a target relative to `.dsh` instead of assembling an absolute path.

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

Every operation takes an absolute path that the path layer already confined to the root plus the `FileSystem` service, so project-root discovery and session policy stay with the caller.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`src/paths.ts` holds the refusal matrix as pure functions that never touch the filesystem, which is why every row of the matrix is pinned by a unit test instead of an integration case. `src/store-ops.ts` maps the four operations onto `FileSystem.mkdir`, `writeText`, `stat`/`listDir`/`readText`, and `remove`, and returns named result records so callers read data rather than filesystem state. `mkdir` and `remove` are the optional primitives this branch added to the filesystem service definition; a backend without them rejects the call and names itself.

</details>

-----

<a id="model-experience"></a>
## Model Experience

None, as the package currently publishes path validation and store operations only; the tool that will expose them to the model is deferred work.

#### KV Cache effect

None: the package contributes no request content.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits describe what the package deliberately does not do yet. They are current constraints, not a task backlog.

- **No model-facing tool yet** — the `tool-dsh-store` tool (create, query, delete over a `.dsh`-relative path), its session policy gate, and its namespace checks are the next slice; until then the package is a library.
- **The root is fixed to `.dsh`** — it is not configurable, so one workspace has exactly one store, and callers cannot point the operations at another directory.
- **No content validation** — the store writes what it is given; the rule that `.dsh/rules/**` entries are Markdown and non-duplicated belongs to the tool slice that creates them.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: open questions and directions that are not decided. Shipped behavior and accepted rationale live in the sections above and in the package code.

- **The model-facing tool, its session policy gate, and its namespace checks are the next slice; until they land this package is a library.**

</details>
