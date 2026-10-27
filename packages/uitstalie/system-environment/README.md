---
description: "The host environment atom: platform facts, path spelling and comparison rules, environment lookup, and the user and Harness home directories, provided as ctx.systemEnvironment."
kind: "package-reference"
---

# @deepseek-ai/dsh-system-environment

English | [中文](README.zh.md)

## Summary

`dsh-system-environment` provides `ctx.systemEnvironment`: the one place a branch plugin asks about the platform, path spelling and comparison, environment variables, and the user and Harness home directories. Both rule sets (`win32` and `posix`) are available on every host, so Windows behavior is testable on Linux and vice versa. It has no model surface and no UI; a plugin that compares paths or expands `~` injects this service instead of importing `node:path` / `node:os` and deciding the same question a second way.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>

## Use this package

Mount the row once, before any consumer of `ctx.systemEnvironment`:

```yaml
- id: system-environment
  name: '@deepseek-ai/dsh-system-environment'
```

A plugin then declares `inject: ['systemEnvironment']` and asks the service instead of re-deriving:

```ts
const under = ctx.systemEnvironment.isUnder(workspaceRoot, candidate)
const home = ctx.systemEnvironment.dshHome()
const programFiles = ctx.systemEnvironment.env('ProgramFiles')
const same = ctx.systemEnvironment.samePath(left, right)
```

`platform` and `env` are the row's test seam: both default to the running host, and pinning them is how a spec exercises the Windows rules on Linux (or the POSIX rules on Windows).

<a id="understand-the-implementation"></a>

## Understand the implementation

`src/index.ts` builds one frozen value from the resolved platform:

- `normalizePath` is the comparison spelling: the platform dialect normalizes separators, a trailing separator is dropped, and Windows folds case. `samePath` and `isUnder` are defined on it, so a path is never compared two different ways. `isUnder('/a/b', '/a/bc')` is false; a trailing-separator root such as `C:\` is handled.
- `env(name)` is an exact lookup on POSIX and a case-insensitive one on Windows, because the OS is.
- `homeDir()` is `HOME`, or `USERPROFILE` (then `HOME`) on Windows; `dshHome()` is the shared `resolveDshHome` resolution (`$DSH_HOME`, else the OS home's `.dsh`).
- `path`, `separator`, and `delimiter` expose the dialect itself for callers that must build, not just compare.

<a id="known-limitations-and-deferred-work"></a>

## Known Limitations and Deferred Work

- **No filesystem work.** This is lookup and comparison, not resolution against disk: a consumer that must prove a target exists still stats it itself.
- **The default Harness home follows the OS home.** A test that overrides only `HOME` still sees the real OS home from `dshHome()` unless it pins `DSH_HOME` or uses the `env` seam.
- **Consumers still carry their own path rules.** Sandbox diagnostics, home-backup, and store-atom each spell path comparison themselves; migrating them onto this service is tracked separately and must not change behavior.
