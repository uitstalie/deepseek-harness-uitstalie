# @deepseek-ai/dsh-jira-cli

The jira ledger's human surface: the `jira` command with its 23 subcommands. It drives `jira-core` directly — no host, no Cordis context, no profile — which is what lets the ledger repository's own CI run `jira lint` and `jira generate --check` on a plain checkout.

## Model Experience

Nothing here reaches a model: this is the surface a person uses in a shell, and the model's equivalent is `jira_issue` / `jira_list` / `jira_kb` in `jira-agent`. The two share their logic in `jira-core` and their sentences in `jira-core`'s `messages`, so a message cannot drift between them.

## Commands

`assignee`, `batch`, `board`, `close`, `comment`, `doctor`, `generate`, `get`, `hooks`, `init`, `kb`, `link`, `lint`, `list`, `machines`, `new`, `project`, `switch`, `sync`, `tag-create`, `tags`, `update`, `verify-commit-msg`.

Exit codes are the contract: `0` success, `1` a ledger or git failure, `2` a usage error. Output is Chinese and byte-stable; `--json` is the machine-readable form agents read. `sync` uses its own queue — the CLI is a separate process and does not share the host's.

## Tests

`pnpm test` runs `node --test "src/**/*.test.ts"`: the command table/registry agreement (decision 187) and the in-process walk a person takes (`init` → `new` → `list` → `board` → `comment` → `switch` → `doctor` → `sync`), against a real temporary store. Migrating these to vitest is pending.

## Known Limitations and Deferred Work

- The `bin` is `lib/index.js`, which only exists after a build; a source-mode `jira` run needs the built artifact. The repository's application-launch rule expects apps to be launched by a profile, so the bin is a compatibility surface for the ledger repository's CI rather than a supported product entry point.
- `bin` and `sync`-queue ownership are unchanged from the standalone package; merging the CLI onto `jira-service`'s queue was explicitly out of scope (a CLI process cannot share the host's queue).
