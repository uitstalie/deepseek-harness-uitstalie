# @deepseek-ai/dsh-jira-agent

The jira ledger's model surface, moved here from the standalone plugin package: the three resident tools' parameter schemas, output schemas and runners (`jira_issue` with its ten verbs, `jira_list`, `jira_kb`), the caller adapter that decides who is asking, the `/jira` read-only command, the three bundled skills and the session-close-out bookkeeping.

The runners work on an opened store; `jira-service` owns that store and hands it over. Registration — tools, command, skills, write guard, awareness line, settle effect — is the Cordis plugin this package does not have yet; see [Known Limitations](#known-limitations-and-deferred-work).

## Model Experience

The tools are resident: their descriptions and schemas are in the request on every turn, which is why the schemas stay small and the results render as text. Results are JSON on the wire (snake_case) and camelCase entities inside; the envelope converts once at the boundary. A write is refused with an ordinary tool result when the session may not write, and the guard refuses it earlier so no handler ever runs.

The awareness line (`[store] jira · …`) is a `PromptContext`, not a prompt section: its counts change, and a changing section would invalidate the KV cache on every change. An empty ledger injects nothing.

## Contents

| Module | Owns |
|---|---|
| `toolIssue.ts` | `jira_issue` — ten verbs, read/write action split, timeouts, concurrency safety |
| `toolList.ts` | `jira_list` — the filtered list the model reads |
| `toolKb.ts` | `jira_kb` — knowledge get/search/create/update |
| `envelope.ts` | the wire/entity conversion and the frozen `me` identity |
| `caller.ts` | who is asking: agent or human, read-only session, subagent |
| `command.ts` | `/jira` — the read-only status/list/board/show/tags surface |
| `skills.ts` | the three bundled skills and their registration |
| `sessionRecord.ts` | the close-out scan: `sessions/<id>.md`, per-issue comments, push-failure record |
| `host.ts` | the host shapes the runners were written against |

`deferred/` keeps the previous registration module and the tests that drove it (`index.ts`, `index.test.ts`, `schema.test.ts`, `bundle.test.ts`) plus the CLI/tool parity test `surfaces.test.ts`. They are outside `src` on purpose: they encode the old duck-typed host, and the next pass rewrites them against the typed tool registry rather than porting them.

## Tests

`pnpm test` runs `node --test "src/**/*.test.ts"` — the caller, command and skills suites, moved unchanged from the standalone package and still on the Node test runner. The wiring suites are the deferred ones above.

## Known Limitations and Deferred Work

- **No plugin entry yet.** `src/index.ts` re-exports the surfaces; it exports no `apply`. Until it does, the `jira-agent` row in the jira bundle stays disabled, and a profile that installs the bundle gets the ledger service but no tools.
- **Every module imports `jira-core` by deep path** (`@deepseek-ai/dsh-jira-core/store.ts`). The contract wants the agent to see types and the service only; moving the runners onto `ctx.jira` is what removes those imports, and it is the same change that adds the plugin entry.
- The tool definitions still carry JSON Schema records built by `objectSchema`, not the registry's schemastery/zod shapes; the registration rewrite is where that conversion happens.
