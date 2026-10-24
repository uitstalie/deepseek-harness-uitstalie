---
kind: package
---

# @deepseek-ai/dsh-jira-core

The jira ledger's atom layer: the domain model, the on-disk encoding, the locked write transaction, the git primitives, derivation and the read-only queries. It imports `node:*` and its own relative modules only — no `@deepseek-ai` package — so the CLI and the tests run it directly, with no host context.

The ledger itself is a separate git repository of Markdown files. `DESIGN.md` (the decision log) and `HANDOVER.md` (the operator notes) sit one directory up in `packages/jira/` because the error-code test reads the decision row as its definition.

## Model Experience

Nothing here reaches a model. `jira-agent` composes these atoms into tools; the human-facing Chinese sentences live in [`src/messages.ts`](src/messages.ts) and the renderers so both surfaces import the same string.

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

## Tests

`pnpm test` runs `node --test "src/**/*.test.ts"` — the suite moved here unchanged from the standalone plugin repository and stays on the Node test runner. Migrating it to the repository's vitest setup is pending.

`fixtures/config.md` is a verbatim copy of the ledger repository's `config.md`; the two must change together (decision 189).

## Known Limitations and Deferred Work

- `messages.test.ts` (decision 184: neither surface may restate a message literally) stays behind until `jira-cli` and `jira-agent` are both in place, because it reads both source trees.
- `surfaces.test.ts` (the CLI ⊇ tool-verb parity map) spans `jira-cli` and `jira-agent` and needs a home outside either package.
