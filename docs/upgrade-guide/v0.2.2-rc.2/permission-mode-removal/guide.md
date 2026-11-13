---
kind: upgrade-guide
description: "The headless --permission-mode flag and its legacy config key are removed; use --policy and the policy key."
---

# Remove the deprecated `--permission-mode` flag

English | [中文](guide.zh.md)

## Change

The headless one-shot app no longer accepts `--permission-mode`, and the headless row no longer reads the legacy `permissionMode` config key. Use `--policy` and the `policy` key. The replacement was introduced in v0.2.2-alpha.3; this release removes the compatibility window.

## Migration

1. Replace `--permission-mode` with `--policy` in scripts, service units, CI jobs, and SDK launchers.
2. Replace `permissionMode:` with `policy:` in headless profile patches and Cordis overlays.
3. Keep older upgrade guides as historical records; they describe releases where the alias still existed.

## Verification

- `dsh --profile headless --help` lists `--policy` and no longer lists `--permission-mode`.
- `dsh --profile headless --policy guarded "run the tests"` runs with the selected policy.
- A profile that still sets `permissionMode` fails validation instead of silently ignoring the old key.
