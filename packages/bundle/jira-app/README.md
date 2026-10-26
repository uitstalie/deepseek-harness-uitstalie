# @deepseek-ai/dsh-jira-app

The jira ledger's standalone profile bundle. Installing it inserts the ledger rows over whatever profile it targets: `jira-service` (the ledger's single writer), `jira-agent` (the dafeiyu capability with the tools, `/jira`, the skills, the guard and the turn-end settle) and `ui-jira` (the browser row: the `jira` settings section with the ledger status, the read-only board, the issue detail and the knowledge search).

The same three rows are mounted by `packages/bundle/web-app/cordis.patch.uitstalie.yml`, so a `dsh --profile web` built from this checkout carries the ledger without installing this bundle.

## Model Experience

The bundle itself adds nothing to a request. Its agent row contributes the three resident tool schemas and the `[store] jira · …` awareness line to every root agent; with the push switch on, the commits a model makes leave the machine after the turn's settle instead of staying local. A profile that installs the bundle without enabling the capability keeps the service (the ledger is still readable through `ctx.jira`) and loses only the model surface.

## Install

```sh
pnpm dsh plugin add @deepseek-ai/dsh-jira-app
```

or, for a profile assembled from a directory:

```sh
pnpm dsh --profile web --patch packages/bundle/jira-app/cordis.patch.yml
```

The row configuration is the `jira-service` schema: `root`, `host`, `machine_id`, `remote`, `push.enabled`, `push.debounce_ms`. The ledger's vocabulary is not configuration — it lives in the ledger repository's `config.md`.

## Known Limitations and Deferred Work

- **The browser page shows the row configuration; it does not write it.** `root`, `host` and `push.enabled` are read-only there until the `jira-service` schema declares them `.volatile()`.
- **dafeiyu v1 has no UI metadata.** The capability registers with `contractVersion: 1`, so the organizer's list shows the id and state without a `label` or a `settings.sectionId` link; the descriptor-v2 upgrade is the contract's stage 2 follow-up.
- **The row list and the patch are compared by `tests/bundle.spec.ts`.** Adding a row means updating both, and the test fails when they drift.
