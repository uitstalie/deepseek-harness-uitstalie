---
kind: upgrade-guide
description: "The permission flag becomes --policy, DSH_PERMISSION_MODE becomes a deprecated alias, and the optional soft-policy overlay replaces the OS sandbox with a tool blacklist."
---

# Tool policy and the soft-policy overlay

English | [中文](guide.zh.md)

## Change

`--permission-mode` is renamed to `--policy` for the headless one-shot app. The old flag still works for one release and prints `dsh: --permission-mode is deprecated; use --policy.` to stderr; a later release removes it. `--policy` accepts a tool-policy profile when the composition mounts `dsh-tool-policy`, and falls back to a permission preset when it mounts the retired preset service, so the same command works on both compositions.

`DSH_PERMISSION_MODE` is deprecated. When `dsh-tool-policy` mounts, the plugin maps the variable to a profile at load — `danger-full-access` to `unrestricted`, every other value to `guarded` — logs the mapping, and uses that profile as the deployment default. The base composition still reads the variable for its sandbox rows, so the mapping applies only where the soft policy is mounted.

The repository adds two patch overlays. `soft-policy.yml` disables the `sandbox`, `sandbox-policy`, `bash-sandbox`, `pwsh-sandbox`, `fs-sandbox`, and `permission` rows, mounts `dsh-fs-local`, one local shell executor, and `dsh-tool-policy` with `defaultProfile: guarded`, and takes approval from `DSH_APPROVAL_POLICY`. `os-sandbox.yml` restores the base rows when applied after it. The base composition is unchanged, so neither overlay is required and the default behavior is still the OS sandbox.

In a soft-policy composition the model-facing runtime context replaces `Current DSH file policy: …` with `Current DSH tool policy: …` and states that the process has full permissions and is not OS-confined. File tools that hit a denied path fail with the new code `FS_POLICY_DENIED`. The `/permission` command is absent because the preset row is disabled; `/policy` selects a profile instead.

## Migration

1. Replace `--permission-mode` with `--policy` in scripts, service units, CI jobs, and SDK launchers. Keep the deprecated spelling only while a consumer is pinned to this release.
2. If a launch environment exports `DSH_PERMISSION_MODE`, move the choice into `tool-policy.defaultProfile` in a profile patch, or into an agent preset. The alias stays for one release and logs a warning when it applies.
3. To adopt the soft policy, install the packages the overlay references (`@deepseek-ai/dsh-fs-local`, `@deepseek-ai/dsh-bash-local` or `@deepseek-ai/dsh-pwsh-local`, `@deepseek-ai/dsh-tool-policy`) into the profile, then apply the overlay with `--patch apps/cli/config/overlays/soft-policy.yml`. Accept that the process is no longer confined: shell commands, PTC code, MCP servers, plugins, and direct native file access are outside the path checks. Deployments that need a file-effect boundary stay on the base composition.
4. Keep `--add-dir`: it grants workspace roots to the sandbox and fails with a clear error when no `sandboxPolicy` service is mounted. The validators that live in the provider plugin run in the CLI process and cannot see MCP-server directories, so a soft-policy deployment that relied on `--add-dir` must move that work into the sandbox composition or an unsandboxed path.
5. Update any checked-in expected output that asserts the retired policy line, and any script that parses `sandbox_permissions` from a tool schema, only for compositions that actually mount the overlay. The default composition's output is unchanged.
6. Rebuild custom Client or Host plugins that import `@deepseek-ai/dsh-sandbox` types or call `ctx.sandboxPolicy` directly; the soft-policy composition does not mount those services, so such a row stays unmounted.

## Verification

1. `dsh --profile headless --help` lists `--policy` and the deprecated `--permission-mode`.
2. `dsh --profile headless --permission-mode guarded "task"` prints the deprecation warning on stderr and runs with the selected policy.
3. With the soft-policy overlay applied, a file-tool read under `~/.ssh` fails with `FS_POLICY_DENIED` and the request context reads `Current DSH tool policy: guarded`; `dsh --profile headless --add-dir /tmp/x "task"` fails loud rather than silently dropping the grant.
4. Applying `os-sandbox.yml` after `soft-policy.yml` boots the sandbox rows again, and a new Session reports `Current DSH file policy: workspace-write`.
