---
description: "The soft tool policy plugin for deployments that accept process-level file access: named profiles deny model tool calls and file-tool targets, with no OS confinement."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-policy

English | [中文](README.zh.md)

## Summary

Use named profiles to deny selected model tools and file-tool targets without OS confinement. Denied tools disappear from the model schema and are refused by the tool guard; `dsh-tool-fs` checks paths before every file operation. The process keeps full user permissions: shell commands, PTC code, MCP tools, plugins, and direct `node:fs` callers bypass the policy. Choose this soft policy to keep credential directories out of model reach; choose [`dsh-sandbox-local`](../../sandbox/sandbox-local/README.md) with its sandbox-backed filesystem and shell when file effects need an OS boundary.

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

Mount this plugin beside an unconfined filesystem backend and shell executor (`dsh-fs-local`, `dsh-bash-local`, or `dsh-pwsh-local`). It needs the session projection registry, which the base bundle already mounts; it uses the tool registry, the system prompt, the command registry, and the agent registry when those services exist, and works without each of them. The shipped [soft-policy overlay](../../../apps/cli/config/overlays/soft-policy.yml) is the complete composition: it disables the sandbox rows, mounts the local backends, and mounts this plugin with `defaultProfile: guarded`.

### Security disclosure

The process is not confined. Anything the policy denies to a file tool remains reachable through a shell command, `run_code` (PTC), an MCP server, a third-party plugin, a git hook, or a program that opens the path itself. The policy checks only the tool calls the model makes through the tool registry and the file tools that call `ctx.toolPolicy.assertFileAccess`. It is a safety and accident-prevention layer, not a security boundary.

### Minimal composition

```yaml
- id: fs-local
  name: '@deepseek-ai/dsh-fs-local'

- id: bash-local
  name: '@deepseek-ai/dsh-bash-local'

- id: tool-policy
  name: '@deepseek-ai/dsh-tool-policy'
  config:
    defaultProfile: guarded
```

### Profiles

A profile is a name, a one-sentence `description` shown by `/policy` and in the prompt, optional path rules, and optional tool rules. Configuration entries merge over the built-ins: naming a built-in profile replaces it wholesale rather than appending to its lists. An unknown `defaultProfile`, a relative path rule, an unknown operation, or a duplicate tool name fails at load.

| Profile | Meaning |
|---|---|
| `unrestricted` | No path or tool denials. The process is still unconfined. |
| `guarded` (default) | Denies `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.config/gh`, `~/.kube`, `~/.docker`, and `~/.dsh` to file tools for read/write/list, and denies `run_code`. Shell tools stay available. |
| `guarded-no-shell` | `guarded` plus `bash`, `pwsh`, and `run_code`. |
| `files-read-only` | Denies `write`, `edit`, `apply_patch`, `str_replace_editor`, `bash`, `pwsh`, and `run_code`; reads stay allowed. |

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `defaultProfile` | `guarded` | Profile a session starts from. `/policy` and the reused `permission/preset` event override it per session. |
| `profiles` | `{}` | Profile definitions; each key replaces the same-named built-in. |
| `profiles.<name>.description` | the name | One sentence shown by `/policy` and in the model prompt. |
| `profiles.<name>.paths` | `[]` | Path rules; a target is denied when its lexical or physical spelling is at or under the rule's root. |
| `profiles.<name>.paths[].path` | required | Absolute path or a leading `~`; canonicalized when the profile is prepared. |
| `profiles.<name>.paths[].operations` | all | Any of `read`, `write`, `list`. |
| `profiles.<name>.paths[].includeSelf` | `true` | Whether the root itself is denied. |
| `profiles.<name>.paths[].reason` | absent | Model-facing explanation appended to the denial. |
| `profiles.<name>.tools` | `[]` | Exact model-visible tool names denied for the whole call, each with an optional `reason`. |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-policy) is the exhaustive source for every accepted field.

### Selecting a profile

`/policy` reports or switches the profile for the current session. It writes the reused `permission/preset` session event with the profile name, so an older build sees the selection as an unknown preset and falls back instead of crashing. Precedence is session selection, then the deployment `defaultProfile`. The model cannot change the profile.

The retired `DSH_PERMISSION_MODE` environment variable remains a one-release alias: `danger-full-access` selects `unrestricted`, every other value selects `guarded`, and the plugin logs a deprecation warning naming the selected profile. It overrides the configured `defaultProfile`, matching the precedence the sandbox configuration used.

### Enabling and rolling back

Apply the shipped overlay after the profile's own layers:

```sh
dsh --profile headless --patch apps/cli/config/overlays/soft-policy.yml "task"
```

The base composition is unchanged, so dropping the overlay restores the OS sandbox. A profile that embeds the soft-policy rows can apply the explicit rollback overlay after them:

```sh
dsh --profile headless \
  --patch apps/cli/config/overlays/soft-policy.yml \
  --patch apps/cli/config/overlays/os-sandbox.yml "task"
```

-----


<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The policy has four layers. **Visibility** applies per-agent `ctx.tools.restrict({ deny })` from the profile, so a denied tool is absent from the model schema and the PTC SDK; `run_code` is deliberately never passed to `restrict` because the registry reserves the PTC transport, and the guard owns that denial. **The execution gate** is a monotonic `ctx.tools.guard()` that runs after the extensible pre-execute policy, so neither listener order nor a stale visibility mask can turn a denial back into permission. **File targets** are checked by `dsh-tool-fs` through `assertFileAccess`, after the tool resolves the target and before any mutation; `read`, `read_image`, `write`, `edit`, and every `apply_patch` file target call it. **Prompt and command** register the `tool-policy` system-prompt context and `/policy`.

Path rules match on two spellings. A configured rule is expanded (`~`), made absolute, and canonicalized; a requested target is canonicalized against the session cwd with its nearest existing ancestor resolved through `realpath`, and the two spellings are compared with a path-relative check rather than a string prefix, so `~/.ssh2` does not match `~/.ssh`. Windows drive letters, UNC shares, `\\?\` prefixes, alternate data streams, and trailing dots/spaces are normalized; drive-relative and device-namespace paths fail closed. A target that cannot be canonicalized is denied rather than allowed.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `ToolPolicyService`, `ctx.toolPolicy`, profile resolution, denials |
| [`src/profiles.ts`](src/profiles.ts) | Built-in profiles, config validation, the retired environment alias |
| [`src/canonicalize.ts`](src/canonicalize.ts) | Platform path grammars, `~`, physical resolution |
| [`src/match.ts`](src/match.ts) | Lexical/physical prefix matching with operation filters |
| [`src/guard.ts`](src/guard.ts) | The monotonic tool guard |
| [`src/visibility.ts`](src/visibility.ts) | Per-agent schema restriction and profile-change re-apply |
| [`src/prompt.ts`](src/prompt.ts) | The model-facing policy context |
| [`src/command.ts`](src/command.ts) | `/policy` |

</details>

-----


<a id="further-exploration"></a>
## Further Exploration

- [Sandbox and soft tool policy](../../../docs/subsystems/sandbox.md) — the subsystem page, including the OS sandbox this policy can replace.
- [tool-fs](../../fs/tool-fs/README.md) — the model-facing tools that call the file-target check.
- [sandbox-local](../../sandbox/sandbox-local/README.md) and [sandbox-policy](../../sandbox/sandbox-policy/README.md) — the confinement the base composition uses instead.

-----


<a id="model-experience"></a>
## Model Experience

### Tool policy context and denials

#### What the model sees

Every request carries one runtime-context section, rendered from the profile in force. A `guarded` composition produces the following context.

##### Guarded policy context

```markdown
Current DSH tool policy: guarded (soft policy; the process has full user permissions and is NOT OS-confined). Baseline soft policy: credential/DSH paths are denied to file tools; run_code is disabled. File-tool access is denied for: `~/.ssh` (read/write/list), … . Tools denied: run_code (…). This policy only checks model tool calls. Shell commands, scripts, PTC code, MCP tools, and direct native file access are not path-checked by it; do not use them to reach a denied path.
```

##### Denial results

```markdown
A denied tool call returns `tool "<name>" is denied by DSH tool policy "<profile>": <reason>`. A denied file target fails with code `FS_POLICY_DENIED` and the text `cannot <operation> "<path>": it is under the tool-policy denied path "<rule>" (<operations>) in profile "<profile>"; <reason>. This is a soft policy over model tool calls, not an OS sandbox.` Allowed calls are unchanged: the policy adds no schema fields and no approval prompts.
```

#### Token effect

One short runtime-context section per request. Denials replace the ordinary tool result with a one-to-two-sentence error; there is no success payload to save.

#### KV Cache effect

Append-only. The context section is stable while the profile is stable; a `/policy` switch appends a new section, and the reusable request prefix keeps earlier entries valid.

## Known Limitations and Deferred Work

- **Not a security boundary.** Shell commands, `run_code`, MCP tools, plugins, git hooks, and direct native file access are outside the check. A denied path stays reachable through any of them.
- **`run_code` visibility is fixed.** The tool registry refuses to restrict the PTC transport, so a denied `run_code` remains listed where the PTC executor mounts and is refused only by the guard.
- **Time-of-check to time-of-use.** A target is canonicalized just before the operation; a concurrent symlink swap between the check and the system call is not eliminated.
- **Remote and opaque targets are skipped.** A non-absolute backend path is left to that backend rather than denied.
- **Search is not covered.** `dsh-tool-fs-search` has no search-root or exclusion check yet.
- **Only `dsh-tool-fs` calls the file-target check.** Another plugin that reads or writes through `ctx.fs` directly is never inspected.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The session profile is stored in the existing `permission/preset` event so an older build can replay a newer session without an unknown event type; the payload is a profile name here and was a permission-preset name before. `SESSION_FORMAT_VERSION` is unchanged. The retired four sandbox previews (`read-only`, `workspace-write`, `home-write`, `danger-full-access`) are deliberately not profile names, so a stale selection falls back to the deployment default.

</details>
