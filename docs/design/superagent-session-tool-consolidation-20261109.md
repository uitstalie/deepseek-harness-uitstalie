# Super agent Session tool consolidation assessment (2026-11-09)

English | [中文](superagent-session-tool-consolidation-20261109.zh.md)


## Conclusion

**Only evaluate B: merge workspace registration and the Session lifecycle; do not implement A (merging all four groups) now.** If there are no measured problems with model misuse or token budget, prefer the current state. B makes the same workspace identity and Session lifecycle discoverable through one entry point, but it remains a breaking tool-surface change and must not replace existing validation with one large `action` string parameter.

This assessment is based on the current source code and tests. It did not change runtime code, commit, or push.

Implementation status (2026-11-14): B is implemented in `personality-rewrite-20261113`; this page keeps the assessment history and the current inventory below.

## 1. Current inventory (B implemented, tag `personality-rewrite-20261113`)

The earlier four-group split was the pre-consolidation state. B is implemented: three model-facing entries, all declared in `packages/jira/jira-agent/src/superagent.ts` and registered by role through `createSuperagentContribution`, sharing `SUPERAGENT_OUTPUT_SCHEMA` and the `ToolValue` envelope.

### `superagent_control`

- 16 actions: `roster`, `orphans`, `ensure`, `remove_workspace`, `rename_workspace`, `start`, `append`, `prompt`, `list`, `inspect`, `stop`, `abort`, `fork`, `archive`, `compact`, `delete`.
- Workspace and Session lifecycle share one entry; `runWorkspaceTool` and `runSessionTool` remain the internal behavior owners.
- Action-level required fields are still validated together; the `ToolValue` envelope, `READ_ONLY_SESSION`/`NOT_FOUND`/`WRITE_FAILED`/`INVALID_INPUT` distinctions, business result, and delivery status are preserved.
- Reports remain separate from the lifecycle call; `superagent_ledger` owns business results and `superagent_deliver` owns file handoff.

### `superagent_ledger`

- 5 actions: `list`, `record`, `resolve`, `report_status`, `retry_report`.
- Domain is the business-result authority, Markdown is the projection, and the journal is the delivery authority.

### `superagent_deliver`

- Required absolute `source` and `workspace`; optional `destination` and `overwrite`.
- Host-side copy with physical-path containment; this is not a Session state operation.


## 2. Option A: merge everything into `superagent(action, ...)`

Conceptual schema:

```text
{
  action: 'roster' | 'orphans' | 'ensure' | 'remove' | 'rename'
    | 'start' | 'append' | 'prompt' | 'list' | 'inspect' | 'stop' | 'abort'
    | 'fork' | 'archive' | 'compact' | 'delete'
    | 'ledger_list' | 'record' | 'resolve' | 'report_status' | 'retry_report'
    | 'deliver'
  workspace?: string
  path?: string
  title?: string
  session?: string
  task?: string
  text?: string
  id?: string
  outcome?: string
  decisions?: string[]
  artifacts?: string[]
  source?: string
  destination?: string
  overwrite?: boolean
  // 其余现有字段继续并入同一对象
}
```

This is a single object with 22 actions and 32 parameter fields. The current parameter declaration text is about 8,027 characters, and the four tool descriptions total about 2,813 characters; estimating only from the existing text gives about 10.8K characters (about 2.5–3.5K tokens, not measured with a tokenizer). The merged version also needs action-routing explanations, so it will not naturally become shorter. Although the four tool names and descriptions disappear, action explanations and disambiguation across names increase.

A's only clear benefit is that the model needs to discover just one tool name. The cost is that workspace `remove` and Session `delete`, ledger `list` and Session `list`, Session `record`, and others must be renamed; all guidance, report bodies, skills, READMEs, and tests must migrate.

## 3. Option B: merge registration and lifecycle only

Keep `superagent_ledger` and `superagent_deliver`, and merge workspace/session into, for example, `superagent_control`:

```text
{
  action: 'roster' | 'orphans' | 'ensure' | 'remove_workspace' | 'rename_workspace'
    | 'start' | 'append' | 'prompt' | 'list' | 'inspect' | 'stop' | 'abort'
    | 'fork' | 'archive' | 'compact' | 'delete',
  workspace?: string,
  path?: string,
  title?: string,
  session?: string,
  task?: string,
  text?: string,
  confirm?: string,
  provider?: string,
  model?: string,
  reasoning_effort?: string,
  atSeq?: number,
  compact?: boolean,
  curate_memory?: boolean,
  delivery?: 'queue' | 'interrupt'
}
```

This has 16 actions and 16 fields (including action). If deliberately avoiding renames, `remove`/`rename` could also express the workspace actions, but `remove_workspace/rename_workspace` makes errors and intent clearer. B does not need to mix report retry or file copying into lifecycle state.

The implementation can keep `runWorkspaceTool` and `runSessionTool` as purely internal runners, with the new entry responsible only for the legal action set, action-level required fields, and dispatch. This avoids rewriting the host workspace/Session services, but still changes tool registration, schema, and model-visible text.

## 4. Hard constraints and costs

### Parameter and description budgets

- The current four groups have roughly 1.1K, 4.5K, 1.8K, and 0.6K characters of parameter declarations respectively; descriptions are roughly 0.55K, 0.77K, 1.05K, and 0.43K.
- B removes few fields and can only reduce repeated workspace/action explanations; what actually decreases is the number of tools, not parameter complexity.
- `SESSION_PARAMETERS` already has 13 fields and 11 actions; adding workspace actions makes it easier for the model to confuse `task`, `text`, `path`, and `session`.

### Requiredness and cross-field relations

`start` and `append` cannot express their full semantics through "all fields are optional." Action-level prechecks already list all missing fields at once; consolidation must preserve and extend them while also checking:

- start: workspace + task; session/text cannot substitute;
- append: workspace + session + text;
- prompt/abort: session + text;
- ensure: path; remove_workspace: workspace + confirm;
- provider/model/reasoning_effort combinations, delivery/compact mutual exclusion, and read-only/write action restrictions.

Marking only action as required is insufficient. If the host schema uses oneOf, it must retain an independent object and required fields for each action; bypassable runtime recursive validation cannot be used to claim that "the schema is strict."

### Error and return semantics

All errors should continue to carry the action, workspace, session/task id, and an actionable next step; `READ_ONLY_SESSION`, `NOT_FOUND`, `WRITE_FAILED`, and INVALID_INPUT must not be unified. Returns should also retain the existing envelope fields rather than compressing every result into one `message` for consolidation. In particular, business returned/failed and report delivered/failed must remain independent.

### Breaking surface

- Host registration: change the Spec name, parameters, render, and run wiring in `createSuperagentContribution`; this is not a host SessionController API redesign.
- Agent presets: if a preset filters or authorizes by tool name, update the corresponding lists; if it only loads the superagent capability, the capability itself needs no change, but tool-list assertions still do.
- Tests: the many direct runner calls in `superagent.test.ts` can remain; real tool-name/roster/schema/rendering tests must change, and composition and report chains must be rerun.
- Documentation and guidance: `super-workspace-definition.ts`, both README languages, skills, tool names in errors, report templates, and historical invocation guidance all need attention; historical review documents should remain unchanged rather than being globally rewritten.

## 5. Recommendation and work estimate

### Recommendation

1. **Do not do A now.** It mixes task results, delivery recovery, and file permissions into the lifecycle, increases erroneous-routing risk, and does not provide enough benefit to offset migration.
2. **Do B only when measurements prove that tool discovery/misuse is a problem.** The implementation went ahead without such a measurement; see the decision record below. When doing B, preserve the two internal runners, existing envelope, action-level aggregate validation, and precise errors; do not create one huge business function.
3. If the goal is to reduce the super administrator's cognitive load, prioritize improving the existing `list` output, next-step guidance, and action-error aggregation rather than changing tool names first.

B's rough workload is about 8–12 files across production, tests, prompts, and documentation, plus composition tests and model-visible snapshots (executed by their owners under repository rules). It requires changing host tool registration but not SessionController; whether agent presets change depends on whether they enumerate specific tool names. A has a larger migration surface and requires new unambiguous names for 22 actions, so it should not be promised at the same workload.


### Implementation decision record (2026-11-14)

No benchmark, token count, misuse report, PR description, or commit-message measurement for this consolidation was found in the repository. This record therefore makes no numeric benefit claim.

B is implemented in `personality-rewrite-20261113`; the current code keeps the three-entry surface. The recorded basis is structural, not measured: A would rewrite 22 actions and break all existing `superagent_workspace`/`superagent_session` callers, while B preserves the two internal runners and the existing envelope/action validation. The decision accepts B as the current baseline rather than leaving the design and code divergent.

Rollback trigger: if a real benchmark, field report, or regression shows worse discovery/misuse, token cost, or a broken caller contract, revert `personality-rewrite-20261113` and restore `superagent_workspace`/`superagent_session` with the same envelope and aggregate validation; rerun the superagent behavior and composition tests. No numeric claim is made until such evidence exists.

## 6. Counter-evidence: when merging is worse

- Action dispatch checks only top-level fields and does not validate nested/action conditions, causing erroneous input to be treated as defaults or partially written;
- `task` and `text`, `path` and `workspace`, and `session` and ledger `id` are confused, making the model more likely to stop/remove the wrong object;
- Returns contain only generalized text, losing business results, delivery status, delivery paths, and remaining counts;
- Every request carries all 22 action explanations, increasing tokens and selection interference;
- Old callers, skills, preset allowlists, and tests still reference old names, creating a deployment break where "the tool appears to exist but cannot be called";
- Introducing complex oneOf/compatibility aliases to reduce these risks costs more to maintain than retaining the current state.

Therefore, consolidation is not inherently a simplification; B is worthwhile only when it preserves the existing precise semantics and has measured benefits, and A is not recommended.
