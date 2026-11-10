---
kind: upgrade-guide
description: "The permission flag becomes --policy, DSH_PERMISSION_MODE becomes a deprecated alias, and the optional soft-policy overlay replaces the OS sandbox with a tool blacklist."
---

# Tool policy and the soft-policy overlay

English | [中文](guide.zh.md)

## Change

`--permission-mode` is renamed to `--policy` for the headless one-shot app. For one release the old flag prints `dsh: --permission-mode is deprecated; use --policy.` to stderr. `--policy` selects a tool-policy profile when `dsh-tool-policy` is mounted, or a preset with the retired preset service.

`DSH_PERMISSION_MODE` is deprecated. When `dsh-tool-policy` mounts, the plugin maps the variable to a profile at load — `danger-full-access` to `unrestricted`, every other value to `guarded` — logs the mapping, and uses that profile as the deployment default. The base composition still reads the variable for its sandbox rows, so the mapping applies only where the soft policy is mounted.

The `soft-policy.yml` overlay disables the sandbox and permission rows, mounts local filesystem/shell backends and `dsh-tool-policy` with `defaultProfile: guarded`, and takes approval from `DSH_APPROVAL_POLICY`. Applying `os-sandbox.yml` afterwards restores the base rows. The unchanged base composition still uses the OS sandbox by default.

In a soft-policy composition the model-facing runtime context replaces `Current DSH file policy: …` with `Current DSH tool policy: …` and states that the process has full permissions and is not OS-confined. File tools that hit a denied path fail with the new code `FS_POLICY_DENIED`. The `/permission` command is absent because the preset row is disabled; `/policy` selects a profile instead.

## Migration

1. Replace `--permission-mode` with `--policy` in scripts, service units, CI jobs, and SDK launchers. Keep the deprecated spelling only while a consumer is pinned to this release.
2. If a launch environment exports `DSH_PERMISSION_MODE`, move the choice into `tool-policy.defaultProfile` in a profile patch, or into an agent preset. The alias stays for one release and logs a warning when it applies.
3. To adopt the soft policy, install `@deepseek-ai/dsh-fs-local`, one local shell package, and `@deepseek-ai/dsh-tool-policy` into the profile, then apply `--patch apps/cli/config/overlays/soft-policy.yml`. The process is no longer confined: shell commands, PTC, MCP, plugins, and native file access bypass path checks. Keep the base composition when a file-effect boundary is required.
4. Keep `--add-dir`: it grants roots to the sandbox and fails without `sandboxPolicy`. Provider validators run in the CLI and cannot see MCP-server directories; move work that needs this grant into the sandbox composition or an unsandboxed path.
5. For compositions that mount the overlay, update expected output asserting the retired policy line and scripts parsing `sandbox_permissions` from a tool schema. The default output is unchanged.
6. Rebuild plugins importing `@deepseek-ai/dsh-sandbox` types or calling `ctx.sandboxPolicy`; the soft-policy composition does not mount those services, so the row stays unmounted.

Confirm the migration with these commands:

- `dsh --profile headless --help` lists both policy flags.
- `dsh --profile headless --permission-mode guarded "task"` prints the deprecation warning.
- Under the soft policy, a file-tool read under `~/.ssh` fails with `FS_POLICY_DENIED`; `--add-dir /tmp/x` fails loud without `sandboxPolicy`.
- Applying `os-sandbox.yml` after `soft-policy.yml` restores `Current DSH file policy: workspace-write`.
