# @deepseek-ai/dsh-jira-app

The jira ledger's standalone profile bundle. Installing it inserts the ledger rows over whatever profile it targets: `jira-service` today, the agent and browser rows once their packages export plugins. It is deliberately **not** part of `web-app`'s patch layer yet — the branch's contract reaches that wiring in stage 2, and installing a bundle that gives a profile a service but no tools would be a partial capability.

## Model Experience

The bundle itself adds nothing to a request. With the agent row enabled it would add the three resident tool schemas and the `[store] jira · …` awareness line; with the push switch on, the commits a model makes leave the machine after the turn's settle instead of staying local.

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

- `jira-agent` and `jira-ui` are declared `disabled`: their packages export no plugin yet (see their READMEs). Enabling a row whose package has no `apply` fails at load, and a silently inert row is worse than a visibly off one.
- Not wired into `packages/bundle/web-app/cordis.patch.uitstalie.yml`: contract stage 2 owns that, together with the dafeiyu descriptor's `label` / `settings` metadata (the installed dafeiyu is still contract v1, which has neither field).
- No bundle test yet; the row list and `cordis.patch.yml` are meant to be checked against each other the way `sdk-minimal`'s spec does.
