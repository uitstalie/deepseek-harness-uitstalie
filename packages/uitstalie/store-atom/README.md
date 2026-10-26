---
description: "The .dsh store atom: the dshStore base interface with project-root discovery, path confinement, namespace authoring checks, and version-guarded reads and writes for workspace .dsh content."
kind: "package-reference"
---

# @deepseek-ai/dsh-store-atom

English | [中文](README.zh.md)

## Summary

`store-atom` owns the `.dsh` store implementation behind `ctx.dshStore`: project-root discovery, path confinement, the store operations, the rules/skills authoring checks, and the per-session sandbox policy gate. A capability provider writes its own store area through this interface instead of assembling a store path or re-implementing the refusal matrix, and the model-facing tool and the read-only sidebar Remote in `@deepseek-ai/dsh-tool-dsh-store` drive the same implementation.

It provides `ctx.dshStore` and has no model surface of its own. The branch composition mounts it in the `web-app` layer before the tool that consumes it; consumers declare `inject: ['dshStore']`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Use this package

Mount the row once per composition, before any consumer of `ctx.dshStore`:

```yaml
- id: store-atom
  name: '@deepseek-ai/dsh-store-atom'
  config:
    ensureRoot: true
```

A provider then reads and writes its own area with a store-relative path:

```ts
const read = await ctx.dshStore.readFile(session, 'memory/sessions/MEMORY.md', { signal })
const written = await ctx.dshStore.writeFile(session, 'memory/sessions/MEMORY.md', text, {
  expected: read.version,
  signal,
})
```

`expected` is the version an earlier read returned; omitting it writes unconditionally. A concurrent writer surfaces as `FS_STALE_VERSION` instead of a silent overwrite. `ensureRoot` controls whether a writable session gets `<projectRoot>/.dsh` created before its first step.

## Understand the implementation

- `src/service.ts` — the service itself: root resolution, the operations, the policy gate, and the `dshStore` interface.
- `src/paths.ts` — store-relative path normalization and confinement rejects absolute paths, `..`, drive letters, and reserved device names.
- `src/namespaces.ts` — authoring checks for `rules/**` and `skills/**`, and the `memory` area the store tool may read but not modify.
- `src/policy.ts` — resolves the session's sandbox policy and refuses mutations for a `read-only` session with the shared denial marker.
- `src/store-ops.ts` — the filesystem operations shared by the service and the Remote.

The workspace store root is `<projectRoot>/.dsh`, where the project root is discovered from the session cwd by the `.git` marker. Reads are allowed in every session mode; writes pass the session's policy gate.

## Known Limitations and Deferred Work

- **Only the workspace scope exists.** The design calls for a `global` scope rooted at `$DSH_HOME`; it is not implemented yet because the personality profile's configurable `globalPath` can point outside `$DSH_HOME` and that contract has to be decided first.
- **A session is required for every call.** Root resolution and the write gate derive from the session's project and policy; there is no session-less path for a host-side writer yet.

## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The package was extracted from `@deepseek-ai/dsh-tool-dsh-store` so the store implementation is reused rather than imported from a tool package. The model-facing tool and the Remote stay in the tool package as consumers.

</details>
