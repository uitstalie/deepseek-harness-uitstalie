---
description: "The jira ledger's standalone profile bundle: inserts the jira-service, jira-agent and jira-ui rows over the profile it is installed into, with the service row opening the ledger and the agent row contributing the model surface."
kind: "package-bundle"
---

# @deepseek-ai/dsh-jira-app

English | [中文](README.zh.md)

## Summary

`dsh-jira-app` is the jira ledger's standalone profile bundle. Installing it inserts three rows over whatever profile it targets: `jira-service` (the ledger's single writer), `jira-agent` (the dafeiyu capability with the tools, `/jira`, the skills, the guard, and the turn-end settle), and `jira-ui` (the `jira` settings section with the ledger status, read-only board, issue detail, and knowledge search). A `dsh --profile web` built from this checkout already mounts the same three rows, so installing the bundle is for other profiles.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>

## Use this package

The bundle inserts the ledger rows over whatever profile it targets: `jira-service` (the ledger's single writer), `jira-agent` (the dafeiyu capability with the tools, `/jira`, the skills, the guard and the turn-end settle) and `ui-jira` (the browser row: the `jira` settings section with the ledger status, the read-only board, the issue detail and the knowledge search).

The same three rows are mounted by `packages/bundle/web-app/cordis.patch.uitstalie.yml`, so a `dsh --profile web` built from this checkout carries the ledger without installing this bundle.

A profile that installs the bundle without enabling the capability keeps the service (the ledger is still readable through `ctx.jira`) and loses only the model surface.

### Install into a profile

```sh
pnpm dsh plugin add @deepseek-ai/dsh-jira-app
```

or, for a profile assembled from a directory:

```sh
pnpm dsh --profile web --patch packages/bundle/jira-app/cordis.patch.yml
```

The row configuration is the `jira-service` schema: `root`, `host`, `machine_id`, `remote`, `push.enabled`, `push.debounce_ms`. The ledger's vocabulary is not configuration — it lives in the ledger repository's `config.md`.

<a id="model-experience"></a>

## Model Experience

Indirectly, through the rows it inserts: `jira-agent` contributes the three resident tool schemas and the `[store] jira · …` awareness line to every root agent, and `jira-service` decides whether the commits a model makes leave the machine after the turn's settle instead of staying local.

#### KV Cache effect

The bundle adds no request text of its own; the cache behavior belongs to each inserted row's package.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The browser page shows the row configuration; it does not write it.** `root`, `host` and `push.enabled` are read-only there until the `jira-service` schema declares them `.volatile()`.
- **dafeiyu v1 has no UI metadata.** The capability registers with `contractVersion: 1`, so the organizer's list shows the id and state without a `label` or a `settings.sectionId` link; the descriptor-v2 upgrade is the contract's stage 2 follow-up.
- **The row list and the patch are compared by `tests/bundle.spec.ts`.** Adding a row means updating both, and the test fails when they drift.

<a id="dev-note"></a>

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
