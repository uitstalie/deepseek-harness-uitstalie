---
description: "The .dsh store atom: the dshStore base interface with the global ($DSH_HOME) and workspace (.dsh) scopes, project-root discovery, path confinement, namespace authoring checks, and version-guarded reads and writes."
kind: "package-reference"
---

# @deepseek-ai/dsh-store-atom

English | [中文](README.zh.md)

## Summary

`store-atom` owns the `.dsh` store implementation behind `ctx.dshStore`: project-root discovery, path confinement, the store operations, the rules/skills checks, and the session sandbox policy gate. It recognizes exactly two roots — the user's `$DSH_HOME` (`global`) and the session workspace's `<projectRoot>/.dsh` (`workspace`) — and no other scope. Providers write their own area through this interface instead of assembling paths, and the model tool and sidebar Remote in `@deepseek-ai/dsh-tool-dsh-store` drive the same implementation.

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

A provider then reads and writes its own area with a store-relative path. The workspace scope is the default; the global scope takes `{ scope: 'global' }` and no session:

```ts
const read = await ctx.dshStore.readFile(session, 'memory/sessions/MEMORY.md', { signal })
const written = await ctx.dshStore.writeFile(session, 'memory/sessions/MEMORY.md', text, {
  expected: read.version,
  signal,
})
const globalRead = await ctx.dshStore.readFile(undefined, 'personality/PERSONALITY.md', { scope: 'global' })
```

`expected` is the version an earlier read returned; omitting it writes unconditionally. A concurrent writer surfaces as `FS_STALE_VERSION` instead of a silent overwrite. `ensureRoot` controls whether a writable session gets `<projectRoot>/.dsh` created on its first mutation (writes are prepared lazily; the atom never subscribes to the agent lifecycle); a global `prepare('global')` creates `$DSH_HOME` itself.

## Understand the implementation

- `src/service.ts` — the service itself: root resolution, the operations, the policy gate, and the `dshStore` interface.
- `src/paths.ts` — store-relative path normalization and confinement rejects absolute paths, `..`, drive letters, and reserved device names.
- `src/namespaces.ts` — authoring checks for `rules/**` and `skills/**`, and the `memory` area the store tool may read but not modify.
- `src/policy.ts` — resolves the session's sandbox policy and refuses mutations for a `read-only` session with the shared denial marker.
- `src/rules.ts` — workspace-rules discovery for `.dsh/rules/**` (path order, trimmed-content deduplication, per-file cap, set digest). The atom's own duplicate check and the instructions loader consume the same scan, so the atom owns the rules area without depending on an instruction provider.
- `src/store-ops.ts` — the filesystem operations shared by the service and the Remote.

The workspace root is `<projectRoot>/.dsh`, where the project root is discovered from the session cwd by the `.git` marker. The global root is `resolveDshHome()` — `$DSH_HOME` when set, `~/.dsh` otherwise. Reads are allowed in every session mode; workspace writes pass the session's policy gate, while a global write has no session gate because the policy covers the workspace, so the caller owns that audit.

## Known Limitations and Deferred Work

- **Two roots and no more.** A call addresses `$DSH_HOME` or the session workspace's `.dsh`; there is no third root and no caller-supplied absolute path, so a provider cannot point the store at an arbitrary directory.
- **The global scope is not policy-gated.** A global write ignores the workspace sandbox policy by design; the caller must only expose it on a user-confirmed path, and a misbehaving caller has no session gate to stop it.
- **The workspace scope still requires a session.** Root resolution and its write gate derive from the session's project and policy; a global call passes `undefined` instead.

## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The package was extracted from `@deepseek-ai/dsh-tool-dsh-store` so the store implementation is reused rather than imported from a tool package. The model-facing tool and the Remote stay in the tool package as consumers.

</details>
