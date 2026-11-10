# Super agent Session tool consolidation assessment (2026-11-09)

English | [中文](superagent-session-tool-consolidation-20261109.zh.md)


## Conclusion

**Only evaluate B: merge workspace registration and the Session lifecycle; do not implement A (merging all four groups) now.** If there are no measured problems with model misuse or token budget, prefer the current state. B makes the same workspace identity and Session lifecycle discoverable through one entry point, but it remains a breaking tool-surface change and must not replace existing validation with one large `action` string parameter.

This assessment is based on the current source code and tests. It did not change runtime code, commit, or push.

## 1. Current inventory

All four tool groups are declared in `packages/jira/jira-agent/src/superagent.ts` and registered by role through `createSuperagentContribution`; they share `SUPERAGENT_OUTPUT_SCHEMA` and the `ToolValue` envelope. Tests call the runner directly, while `index.test.ts`, `superagent.test.ts`, and group-level composition tests cover the real registry path.

### `superagent_workspace`

- Actions: `roster`, `orphans`, `ensure`, `remove`, `rename`.
- Five parameters: `action`, plus optional `path/workspace/title/confirm`; `ensure` requires path, `remove` requires workspace + exact confirm, and `rename` requires workspace + title.
- Returns: `workspaces[]` (id/path/title/status/session count), or one `workspace`; remove also carries `removed/directoryKept/sessionsKept`, and rename carries `renamed`.
- Errors: no registry, non-writable session, unregistered target, missing fields, confirmation mismatch, inability to remove/rename the current super workspace, missing host delete/setTitle, and underlying registration failure.
- Consumers: `runSessionTool` and deliver/ledger use it to resolve the target workspace; `superagent_workspace roster` appears in error-recovery guidance; UI setup uses host/service rather than this model tool.

### `superagent_session`

- Actions: `append`, `start`, `prompt`, `list`, `archive`, `fork`, `delete`, `compact`, `inspect`, `stop`, `abort`.
- Thirteen parameters: `action/workspace/task/title/session/text/confirm/provider/model/reasoning_effort/atSeq/compact/curate_memory/delivery`.
- Required fields differ by action: `start` requires workspace + task; `append` requires workspace + session + text (session may be latest); `prompt` requires session + text; `abort` requires session + text; other lifecycle actions mostly require session, and delete also requires confirm.
- Returns: `session` (id/title/archive/fork, etc.), `sessions[]`, `model`, `delivery`, `usage/compaction`, `status/activity/stop/abort`, thresholds, `longRunning`, and more. Report delivery and business results are stored separately in journal/domain.
- Errors: no controller, read-only, workspace and Session not belonging to each other, missing action arguments, model or effort rejection, initial permissions not established, binding not saved, compaction busy/failure, cancellation and idle-wait failure, and missing host capability. Error context often carries workspace, session, available efforts, or a concrete failure reason.
- Consumers: task start/append/prompt all write the report binding first; turn-end derives the report from it; model selection, permission initialization, compaction, and the workspace registry are actual dependencies.

### `superagent_ledger`

- Actions: `list`, `record`, `resolve`, `report_status`, `retry_report`.
- Ten parameters: `action/workspace/task/id/status/outcome/decisions/artifacts/issue/query/limit`.
- Returns: list as `entries + counts{matched,returned,remaining} + truncated + limit`; record/resolve as `task/file`, with resolve also giving a memory suggestion; retry as business `task{result,outcome}` plus independent `delivery{status,attempts}`.
- Errors: missing super root, read-only `READ_ONLY_SESSION`, not-found `NOT_FOUND`, I/O `WRITE_FAILED`, invalid status, or missing first outcome; delivery settlement failure distinguishes recipient acceptance from journal non-persistence.
- Consumers: domain is the business-result authority, Markdown is a projection, and journal is the delivery authority. It is not a Session lifecycle tool, and consolidation must not make resolve look like a Session state transition.

### `superagent_deliver`

- Four parameters: required absolute `source`, required `workspace`, and optional `destination/overwrite`.
- Returns: `delivered{path,bytes}`.
- Errors: read-only, non-absolute source, no registry, unregistered/missing workspace, unreadable or non-regular-file source, destination escaping the physical root, unauthorized overwrite, and copy failure.
- Consumers: host-side copying and physical-path restrictions; fs-only authorization comes from the registered workspace, but this is not a Session state operation.

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
2. **Do B only when measurements prove that tool discovery/misuse is a problem.** When doing B, preserve the two internal runners, existing envelope, action-level aggregate validation, and precise errors; do not create one huge business function.
3. If the goal is to reduce the super administrator's cognitive load, prioritize improving the existing `list` output, next-step guidance, and action-error aggregation rather than changing tool names first.

B's rough workload is about 8–12 files across production, tests, prompts, and documentation, plus composition tests and model-visible snapshots (executed by their owners under repository rules). It requires changing host tool registration but not SessionController; whether agent presets change depends on whether they enumerate specific tool names. A has a larger migration surface and requires new unambiguous names for 22 actions, so it should not be promised at the same workload.

## 6. Counter-evidence: when merging is worse

- Action dispatch checks only top-level fields and does not validate nested/action conditions, causing erroneous input to be treated as defaults or partially written;
- `task` and `text`, `path` and `workspace`, and `session` and ledger `id` are confused, making the model more likely to stop/remove the wrong object;
- Returns contain only generalized text, losing business results, delivery status, delivery paths, and remaining counts;
- Every request carries all 22 action explanations, increasing tokens and selection interference;
- Old callers, skills, preset allowlists, and tests still reference old names, creating a deployment break where "the tool appears to exist but cannot be called";
- Introducing complex oneOf/compatibility aliases to reduce these risks costs more to maintain than retaining the current state.

Therefore, consolidation is not inherently a simplification; B is worthwhile only when it preserves the existing precise semantics and has measured benefits, and A is not recommended.
