# @deepseek-ai/dsh-jira-agent

The jira ledger's model surface: a dafeiyu capability provider that registers the three resident tools (`jira_issue` with its ten verbs, `jira_list`, `jira_kb`), the `[store] jira · …` awareness line, the monotonic write guard, the `/jira` command, the three bundled skills and the turn-end settle.

The plugin injects the ledger service (`ctx.jira`), the tool registry and the organizer (`ctx.dafeiyu`). The command and skill registries are optional: a composition without one keeps the tools and loses only that surface. The ledger's location, machine identity and push queue belong to the `jira-service` row, so this row has no configuration of its own.

## Model Experience

The three tools are resident in the request on every turn of a **root** agent: their descriptions and schemas stay small and their results render as text. A child agent gets neither the tools nor the awareness line — `scope: 'root'` keeps a delegated session out of the ledger surface — and the write guard still refuses a delegated caller's write if a call reaches one.

The awareness section (`jira:store`, order 700) is one line: the store's name, how many projects, knowledge entries and open issues it holds, plus the count of machine-anchored read-only projects. It renders nothing for an empty ledger, and it is recomputed only when the ledger commits (`changed`), never per model step.

A write is refused with an ordinary tool result when the session may not write, and the guard denies it earlier so no handler runs. `/jira` is read-only except for `new` and `sync`; `sync` flushes the service's own queue rather than starting a second one.

Every completed turn of a writable root agent settles the ledger: the derived files are regenerated and committed, then the session close-out records the commits the session made on the issues they mention. A successful settle schedules a push only when the service row enabled the push switch.

## Contents

| Module | Owns |
|---|---|
| `index.ts` | the plugin entry: `name` / `inject` / `Config` / `apply`, and the controlled re-exports |
| `contribution.ts` | the dafeiyu capability: scope, tools, sections, agent hook, turn-end settle, dispose |
| `tools.ts` | the three registry definitions and the per-call store/caller resolution |
| `awareness.ts` | the `jira:store` prompt section and its `changed`-driven refresh |
| `wiring.ts` | the write guard, the `/jira` command registration and the skill registration |
| `toolIssue.ts` / `toolList.ts` / `toolKb.ts` | the tool schemas, descriptions and runners |
| `envelope.ts` / `caller.ts` | the wire/entity conversion, the identity tuple, who is asking |
| `command.ts` / `skills.ts` | the `/jira` subcommands and the three bundled skills |
| `sessionRecord.ts` | the close-out scan, the push-failure record and the per-apply session recorder |
| `testing/host.ts` | the real-composition harness the wiring suites mount |

## Tests

`pnpm test` runs `node --test "src/**/*.test.ts"`. The wiring suites (`index`, `schema`, `surfaces`, `messages`) mount the shipped services through a real Cordis context — system prompt, tools, dafeiyu, commands, skills and `jira-service` — so they exercise the real registrations rather than a hand-built host.

The suites resolve the workspace packages through their package roots, which is the built `lib/` entry. Run `pnpm run build:artifacts` before them in a source checkout.

## Known Limitations and Deferred Work

- **No browser surface yet.** `ui-jira` exports the settings-section contract only; the board, issue and knowledge views are unwritten, and its bundle row stays disabled.
- **The runner modules still import `jira-core` by deep path.** The phase-1 bridge opens the store through `ctx.jira.store()`; moving the runners onto the service's own read/write methods is the phase-2 follow-up.
- **The CLI-parity assertion is split.** The standalone package compared the tool verbs with the CLI's command names in one test. `jira-agent` may not depend on `jira-cli`, so the CLI keeps its own table/handler/usage tests and the mapping between the two surfaces is unguarded.
- **The awareness line no longer names the workspace binding.** The contract's section names the store and its counts; the workspace→project phrase was a context source in the standalone plugin.
