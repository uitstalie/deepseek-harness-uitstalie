---
description: "Local per-platform sandbox backends for users and maintainers choosing, configuring, or debugging process confinement on Linux, macOS, or Windows."
kind: "package-reference"
---

# @deepseek-ai/dsh-sandbox-local

English | [中文](README.zh.md)

## Summary

`dsh-sandbox-local` confines commands and their descendants on supported local backends while sharing the host kernel and filesystem. It chooses a supported platform runner automatically and fails with `SANDBOX_UNAVAILABLE` when none is usable, so commands never silently run without confinement. Each execution reports `full` or `partial` enforcement plus denial and runner-failure signatures, allowing callers to distinguish an unavailable or broken sandbox from a policy denial. Choose it for host-local bash or pwsh execution; use a container or remote executor when the process needs an isolated environment.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this provider behind `ctx.sandbox` and a confined executor, and every command the executor spawns runs confined under the policy you resolve. The shipped [base bundle](../../bundle/base/cordis.patch.yml) owns the default policy and executor wiring.

### When to choose it

Choose it when commands must run confined on the host: it is the default backend for Linux, macOS, and Windows compositions that mount `ctx.sandbox`. Choose a different mechanism when the process must run in an isolated environment — a container or remote executor replaces whole capabilities, and this provider shares the host kernel and filesystem.

### Minimal configuration

Load the sandbox service and mount the provider; the defaults below are the selection policy.

```yaml
- id: sandbox
  name: '@deepseek-ai/dsh-sandbox-local'
```

| Field | Default | Meaning |
|---|---|---|
| `runnerCommand` | `[]` | Custom runner argv; bwrap-compatible profile arguments are appended, full enforcement is asserted, and built-in selection and probes are skipped |
| `runnerFailureSignatures` | `[]` | Case-insensitive stderr substrings identifying the custom runner's own failure dialect; required with `runnerCommand` |
| `probeTimeoutMs` | `5,000` | Timeout for each functional probe of a competing runner candidate |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-sandbox-local) is the exhaustive source for every accepted field and its JSDoc.

### Confined execution and enforcement

With the provider mounted, a command runs under the mode resolved per call. Enforcement is reported as `full` or `partial`; older Landlock ABIs are the current partial case. A caller that requires a complete boundary can reject `partial`. A runner failure before command execution is distinct from a policy denial.


### Failures and recovery

An unsupported platform or an unusable runner fails closed: `confine()` rejects with `SANDBOX_UNAVAILABLE` and names the runner options for the platform, and the consumer surfaces that error rather than running the command unconfined. A runner that starts but refuses its profile is identified by its fatal stderr signature and exit code, so a broken sandbox is not mistaken for a denied command. The `runnerCommand` override is an operator assertion: it skips functional probes and assumes the configured runner implements the bwrap-compatible profile honestly.

Seatbelt, bwrap, and Landlock include the policy's explicit `additionalWritableRoots` under `workspace-write`. Read-only ignores those grants. Missing paths, non-directories, symlinked directories, and other inspection failures raise `SANDBOX_INVALID_ROOT` before the command starts. The Windows ACL backend does not inspect these extra roots and keeps workspace and private-temp access only. Its per-session preparation rejects with `SandboxPreparationError` before the command starts: `SANDBOX_INVALID_TEMP_ROOT` when the host temp root lies inside the workspace, and `SANDBOX_PREPARATION_FAILED` when a SID, ACL grant, or private temp directory cannot be created, with the `Win32Error` or Node error as `cause` and partial grants rolled back.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains runner selection, the per-platform profiles, and the failure dialects; the observable behavior is fully covered in [Use this package](#use-this-package).

### Runner selection

Selection is by platform first, probes second: Linux tries `bwrap` then Landlock; macOS selects Seatbelt; Windows has no built-in runner. A sole candidate is selected without a probe; competing candidates are functionally probed once in chain order, and the first usable verdict is cached for the provider's lifetime. A platform with no chain, or a chain where every probe fails, is unavailable and fails closed at `confine()`.

### Platform profiles

The built-in Windows ACL runner is disabled because its directory labels and delete denies affect ordinary user processes. The Windows chain is empty and reports `SANDBOX_UNAVAILABLE`; the direct runner refuses before changing a directory or spawning a command. An explicitly configured `runnerCommand` remains an operator-owned alternative. The ACL diagnosis skill stays available for repairing existing permissions.

The bwrap profile combines a read-only host root, a fresh `/dev`, and `/proc` from a private PID namespace — commands manage their descendants but cannot see host processes, so procfs magic links cannot bypass the mounts; `workspace-write` adds an ephemeral `/tmp` and writable binds for the workspace and each explicit extra root. The [historical private-PID note](../../../.agents/notes/archived/bug-fix/2026-08-06-bwrap-private-pid-namespace.md) records the boundary.

The `@deepseek-ai/node-addon-system/landlock-run` API supplies the platform launcher, functional probe, and grant vocabulary; this provider maps mode to grants only, keeping path resolution and probe parsing with the versioned binary.

The Seatbelt profile is allow-default with `(deny file-write*)` plus write allow-lists derived from the shared `writableRoots` helper, so exactly the mode's promised file effects are governed; every root is canonicalized because Seatbelt matches resolved paths (`/tmp` IS `/private/tmp`).


With the built-in Windows runner and a skill registry, this provider registers the [ACL diagnosis skill](../sandbox-windows-acl/README.md#repair-permissions). An operator-supplied `runnerCommand` does not register it; provider disposal removes the skill and its extracted resources.


### Denial and runner-failure dialects


### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: runner chain selection, functional probes, per-call wrap, ACL grant lifecycle |
| [`src/profiles.ts`](src/profiles.ts) | Per-platform profile builders: bwrap mounts, Landlock grants, Seatbelt SBPL |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Start with the subsystem reference for the shared vocabulary, then the seam contract, the consumers, and the win32 rung.

- [Process sandbox subsystem](../../../docs/subsystems/sandbox.md) — modes, per-call policy, and classification dialects.
- [Sandbox seam package](../sandbox/README.md) — the service contract this provider implements.
- [Bash sandbox executor](../../shell/bash-sandbox/README.md) — the confined bash consumer.
- [Windows ACL restricted-token rung](../sandbox-windows-acl/README.md) — the win32 backend this provider mounts.
- [The historical subprocess sandbox decision](../../../.agents/notes/archived/feature/2026-07-06-sandbox.md) — capability boundary and runner selection semantics.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through [`dsh-bash-sandbox`](../../shell/bash-sandbox/README.md) and [`dsh-tool-bash`](../../shell/tool-bash/README.md), which render this provider's enforcement and denial facts, while the [`dsh-sandbox`](../sandbox/README.md) seam owns the `SANDBOX_UNAVAILABLE` text and this provider owns runner selection, and profiles stay outside context.

#### KV Cache effect

No direct invalidation; the named consumers own any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


- **No built-in Windows execution** — the retired ACL runner cannot preserve ordinary user permissions while enforcing its modes. Configure an isolated `runnerCommand` or use a remote/container executor.
- **Landlock may be partial** — older supported kernel ABIs confine only the access classes they expose, reported as `enforcement: 'partial'` rather than overstated as full.
- **Seatbelt depends on deprecated `sandbox-exec`** — macOS still ships it, but this provider cannot replace or probe that private policy engine if Apple removes it.
- **Runner selection is cached for the provider lifetime** — installing, removing, or repairing a runner requires reloading the plugin before selection changes.
- **`runnerCommand` is an operator assertion** — a configured custom runner skips functional probes and is assumed to implement the bwrap-compatible profile honestly; if it is itself a Bash script, its interpreter startup runs before that script applies confinement.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: undecided directions and open questions. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

#### Future: environment-coherent groups

An environment-coherent capability group example, such as bash plus fs against one container, remains undecided.

</details>
