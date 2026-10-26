---
description: "The jira package group: the multi-machine issue ledger behind the jira tools, CLI and browser section, for readers navigating the family."
kind: "package-group"
---

# jira/ — the multi-machine issue ledger

English | [中文](README.zh.md)

## Summary

`jira` is the package group behind the multi-machine issue ledger: a local git repository of Markdown files that DSH agents read and write across sessions and machines. `jira-core` holds the domain and git atoms, `jira-service` is the single writer that owns sync and the `ctx.jira` service, `jira-agent` exposes the ledger to the model through three tools plus the awareness line and write guard, `jira-cli` gives a person the `jira` command, and `ui-jira` adds the browser section. The branch's `web-app` layer mounts the three rows as one composition.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>

## Packages

Each row names the package's contribution and the row, entry, or bundle that mounts it.

| Package | Role | Row or entry |
|---|---|---|
| [`jira-core`](jira-core/README.md) | Ledger atoms: entities, codec, locked transactions, git and push primitives, derivation, doctor, knowledge base, and the shared read queries | no row; imported by the other packages |
| [`jira-service`](jira-service/README.md) | Single writer: resolves the root, opens the store, owns the push queue and settle, registers `ctx.jira`, and publishes `remote.jira` | row `jira-service` |
| [`jira-agent`](jira-agent/README.md) | Model surface: the three jira tools, the awareness line, the write guard, `/jira`, the skills, and the turn-end settle | row `jira-agent` |
| [`jira-cli`](jira-cli/README.md) | Human surface: the `jira` command with its 23 subcommands, exit codes, and Chinese output | `jira` bin; no row |
| [`ui-jira`](ui-jira/README.md) | Browser surface: the `jira` settings section with the ledger status, read-only board, issue detail, and knowledge search | row `jira-ui` |

-----

<a id="related-documentation"></a>

## Related documentation

- [DESIGN.md](DESIGN.md) — the ledger's decision log, copied from the external repository.
- [HANDOVER.md](HANDOVER.md) — the operator handover: current state, machine setup, and open work.
- [MIGRATION.md](MIGRATION.md) — the executed three-layer split and its contracts.
- [ARCHIVE-SOURCE.md](ARCHIVE-SOURCE.md) — what was ported from the external repository, what was not, and the exit criteria for archiving it.
- [jira capability contract](../../goal/jira-contract.md) — the service API, provider descriptor, configuration, and UI contract behind the split.
- [Tool subsystem](../../docs/subsystems/tools.md) — how the three resident jira tools register and render results.
- [System prompt subsystem](../../docs/subsystems/system-prompt.md) — the section assembly the `jira:store` awareness line joins.
- [Typert subsystem](../../docs/subsystems/typert.md) — the generated Host-for-Client remote that gives `ui-jira` its `remote.jira` methods.
- [Settings subsystem](../../docs/subsystems/settings.md) — the section registry the `jira` settings page contributes to.

-----

<a id="dev-note"></a>

## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The group is mounted by the three-row patch in `packages/bundle/web-app/cordis.patch.uitstalie.yml`, the single composition since the unused standalone bundle was removed (DH-203). The packages are private, so their APIs carry no upstream compatibility promise; the ledger data repository keeps its own history and CI.

</details>
