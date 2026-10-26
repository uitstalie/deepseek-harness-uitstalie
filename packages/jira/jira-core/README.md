---
description: "The jira ledger's atom layer: entities, the issue/v1 codec, the locked write transaction, git and push primitives, derivation, the knowledge base, doctor and lint reports, and the read-only queries the CLI and the service share."
kind: "package-reference"
---

# @deepseek-ai/dsh-jira-core

English | [中文](README.zh.md)

## Summary

`dsh-jira-core` holds the jira ledger's atoms: the issue, project, machine and tag model, the `issue/v1` frontmatter codec, the two-level `mkdir` lock and compare-and-set write transaction, git, rebase and debounce-push primitives, the derived `BOARD.md`/`index.md`/`log.md` files, doctor and lint reports, the knowledge base, and the read-only queries the CLI and the service share. It imports `node:*` and its own relative modules only — no `@deepseek-ai` package — so the CLI and the tests run it directly with no host context. `jira-agent` composes these atoms into the model's tools, and the human-facing Chinese sentences live in one `messages` module both surfaces import.

## Table of Contents

- [Modules](#modules)
- [Tests](#tests)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

The ledger itself is a separate git repository of Markdown files. [DESIGN.md](../DESIGN.md) (the decision log) and [HANDOVER.md](../HANDOVER.md) (the operator notes) sit one directory up in `packages/jira/`, and the error-code test reads the decision row as its definition.

<a id="modules"></a>

## Modules

| Entry (via `@deepseek-ai/dsh-jira-core`) | Owns |
|---|---|
| `entities` | issue/project/machine/tag keys, timestamps, identity, the issue, comment and project values |
| `codec` | the `issue/v1` frontmatter document: decode, encode, round-trip |
| `store` | store creation, `storePaths`, the vocabulary, `transact` (two-level lock, CAS, audit identity, commit) |
| `git`, `rebase`, `push`, `lock` | subprocess git with injected identity and timeouts, `pull --rebase`, the debounced push queue, the `mkdir` lock primitive |
| `generate`, `generateStore` | the derived `BOARD.md`/`index.md`/`log.md`/`tags/index.md`, the source-tree hash, regenerate-and-commit |
| `doctor`, `lint`, `inspect` | consistency reports and the read-only queries the CLI and the service share |
| `kb`, `kbstore`, `kbsearch` | knowledge keys, the knowledge document, creation and update, the `file:line` search |
| `messages` | the one place each human-facing sentence is written |
| `result`, `errors` | `Result`, `JiraError` and its twelve codes |

`src/index.ts` is the controlled re-export surface. The package also exposes `./*` to its own `src/*.ts`; only `jira-cli` uses that, because a CLI command needs the same atoms the service does.

<a id="tests"></a>

## Tests

`pnpm test` runs `node --test "src/**/*.test.ts"` — the suite moved here unchanged from the standalone plugin repository and stays on the Node test runner. Migrating it to the repository's vitest setup is pending.

`fixtures/config.md` is a verbatim copy of the ledger repository's `config.md`; the two must change together (decision 189).

<a id="model-experience"></a>

## Model Experience

None, as nothing here reaches a model: `jira-agent` composes these atoms into tools, and the human-facing Chinese sentences live in [`src/messages.ts`](src/messages.ts) and the renderers so both surfaces import the same string.

#### KV Cache effect

None; the package assembles no request and contributes no prompt text, tool schema, or message.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- `messages.test.ts` (decision 184: neither surface may restate a message literally) lives in `jira-agent/src/messages.test.ts`, because it reads both source trees.
- `surfaces.test.ts` (the CLI ⊇ tool-verb parity map) lives in `jira-agent/src/surfaces.test.ts`, because it spans `jira-cli` and `jira-agent`.

<a id="dev-note"></a>

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
