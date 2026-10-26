---
description: "Scheduled snapshots of the harness home for operators who must recover sessions, storages, or profile configuration after a deleted or damaged $DSH_HOME."
kind: "package-reference"
---

# @deepseek-ai/dsh-home-backup

English | [中文](README.zh.md)

## Summary

`dsh-home-backup` copies the harness home's durable state to a directory outside `$DSH_HOME` on a fixed interval and keeps a bounded number of snapshots. One snapshot takes the configured home entries whole — `sessions` and `storages` by default — each profile's configuration files, and the credentials file only when asked. The plugin is host-only: it contributes no tools, no prompt sections, and no Session events, and it writes one `manifest.json` per snapshot so a restore can tell what a snapshot contains.

## Table of Contents

- [Use this package](#use-this-package)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### What a snapshot contains

A snapshot copies each configured home entry recursively, then the known configuration files of every `profiles/<name>` directory: `package.json`, `pnpm-workspace.yaml`, `cordis.yml`, and `cordis.patch.yml`. Profile dependencies and build output stay out, because they are reinstallable. `manifest.json` records the snapshot name, creation time, source home, copied entries with their file and byte counts, and whether credentials were included.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `destination` | `<user home>/dsh-backups` | Directory that holds the snapshots; it must sit outside `$DSH_HOME` |
| `intervalMs` | `1800000` | Interval between snapshots (at least one minute) |
| `initialDelayMs` | `30000` | Delay before the first snapshot; `0` snapshots at mount |
| `retain` | `24` | Snapshots kept, including the newest |
| `paths` | `["sessions", "storages"]` | Home-relative entries copied whole |
| `profileConfig` | `true` | Copy each profile's configuration files |
| `credentials` | `false` | Copy `.credentials.yaml`; enable only when the destination is protected |

Each run writes its snapshot into a sibling staging directory and renames it into place, so a destination never exposes a partly written snapshot. A failed run removes its staging directory, reports the failure through the host log, and leaves the next scheduled run armed. Retention removes the oldest snapshots beyond `retain` after the new snapshot lands.

### Restoring

Stop every `dsh` process, then copy a snapshot's `sessions` and `storages` directories back over the new home; `manifest.json` states which home and entries the snapshot came from. Restoring a profile's configuration means copying the `profiles/<name>` files back beside the profile's dependencies, which the profile manager reinstalls.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **Full copies, not increments** — every snapshot copies the selected trees in full, so disk use scales with snapshots × data. Retention, not delta storage, bounds it.
- **No encryption** — a snapshot is a plain file copy. Keep the destination on a protected volume and leave `credentials` off unless that holds.
- **Not a consistency point** — a file being written while it is copied, such as the active session log, is captured as read. A snapshot is recovery material, not a transaction log.
- **No manual trigger** — scheduling is the only entry point; an ad-hoc copy or restore runs through the filesystem.
- **Snapshots run only while a host process runs** — the timers belong to the serving process, so a machine that never starts `dsh` never snapshots; an OS-level scheduler is the alternative when backups must continue without it.
- **Overlapping runs are not coalesced** — a snapshot slower than the interval lets the next scheduled run start; each run writes its own directory and retention keeps the newest.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: open questions and directions that are not decided. Shipped behavior and accepted rationale live in the sections above and in the package code.

- **Incremental snapshots and a restore command are open ideas, not decisions.**
- **The destination is user configuration, not a derived path; a deployment that mounts this row on a network share owns that share's retention.**

</details>
