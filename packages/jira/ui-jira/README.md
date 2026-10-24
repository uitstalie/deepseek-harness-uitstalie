# @deepseek-ai/dsh-client-ui-jira

The jira ledger's browser surface. What it owns today is the settings section's identity: `sectionId: 'jira'`, `order: 200`, and the three row fields it edits (`root`, `host`, `push.enabled`). `dafeiyu`'s Capabilities list links to that section by id, so the id cannot drift; the section reads and writes the `jira-service` row instead of keeping a second copy of the ledger's location.

The read-only views are not written yet: the board (issues grouped by status), one issue's detail, and the knowledge search with its `file:line` hits. They read through the `remote.jira` projection of `ctx.jira`, never from files, and they never write — writes go through the model's tools.

## Model Experience

Nothing here reaches a model. Client code affects the model only indirectly: a settings change is written back to the `jira-service` row, and the board's data comes from the same service the tools use, so the two cannot disagree.

## Tests

None yet — there is no client program to test. When the section and board land they follow the client-plugin test conventions (components under `tests/`, locale-owned copy).

## Known Limitations and Deferred Work

- No client plugin entry, no `client/` directory, no locale files: this package currently exports constants only. The `jira-ui` row in the jira bundle is declared disabled for that reason.
- The board, issue detail and knowledge views are undesigned here beyond the contract's read-only rule; they need a designer-derived layout rather than a first guess.
- The settings form is not wired to the profile's patch write-back; `.volatile()` on the service schema is the other half of that feature.
