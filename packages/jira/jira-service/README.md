# @deepseek-ai/dsh-jira-service

The jira ledger's single writer. One `jira-service` row owns one ledger: it resolves the root, reads this machine's identity, opens the store, holds the one push queue, refreshes the derived files and emits `changed` for whoever draws a board or an awareness line.

A second consumer — a UI, another capability, a shell — shares this service through `ctx.jira`; nobody else pushes. Across processes the store's own file locks are the guard, so the CLI can commit while a host session is open.

## Model Experience

Nothing here reaches a model directly. The tools live in `jira-agent`; this service decides where the ledger is, who writes and whether commits leave the machine. When `push.enabled` is on, a successful settle arms a debounce, so the model's writes land as local commits first and travel afterwards.

## Service

`ctx.jira` implements the contract in [`src/types.ts`](src/types.ts): read methods (`list`, `get`, `board`, `doctor`, `searchKnowledge`), write methods (`create`, `transact`, `kbCreate`, `kbUpdate`), `sync` and `settle`, plus the `changed` subscription. Every method returns a `Result`; errors are `JiraError` with one of the twelve codes, and permission is not decided here — the guard in `jira-agent` refuses a write before it reaches the ledger.

Two methods are the phase-1 bridge to the agent's existing tool runners: `store()` hands back the opened store, and `notifyWrite()` records a write those runners made directly, so `changed` still fires and the queue still arms. Both disappear when the tools move onto the write methods above.

## Configuration

| Key | Effect |
|---|---|
| `root` | Ledger root; absent resolves through `$JIRA_ROOT`, then `$DSH_HOME/jira`, then the profile's `.dsh/jira` |
| `host` | The `owner.host` audit field; absent is this machine's hostname |
| `machine_id` | Overrides `$DSH_HOME/dsh-jira/machine-id` (never stored in the ledger) |
| `remote` | Git remote to join on load; local only, it never clones or fetches |
| `push.enabled` | Whether a settle schedules a push; default false keeps everything local |
| `push.debounce_ms` | Debounce window; absent is the core default |

The vocabulary (statuses, transitions, priorities, types, resolutions) is **not** configuration here: it lives in the ledger's `config.md`, where git versions it.

## Known Limitations and Deferred Work

- No unit test yet: the class needs a Cordis context and a git store, and the behaviour it wraps is already covered by `jira-core`'s suites. An integration test through a test-only `cordis.yml` belongs with the bundle wiring.
- `store()`, `notifyWrite()` and `pushQueue()` are the bridge described above, not part of the long-term contract.
- `.volatile()` (live reconfiguration from the settings page) is not declared on the config schema.
