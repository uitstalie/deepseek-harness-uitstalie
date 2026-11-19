# Agent role model and tool matrix draft (2026-11-14)

English | [中文](agent-role-model-20261114.zh.md)

Status: **role field, section gating, and the approved tool gates are implemented.** Tool visibility is enforced once in the tool registry; the JIRA and super-agent-only tools are retired, so every approved-matrix row is at `agent` or below. The approved-matrix snapshot is 18/30/30 for `subagent`/`agent`/`super` (`packages/core/tools/tests/role-visibility.spec.ts`). Workspace-tool writes are open to agents in the workspace; a cross-workspace write still requires the super agent.

## 1. Role classification

| Role | Meaning |
|---|---|
| `subagent` | A delegated child, or any Session with child lineage; least privilege. |
| `agent` | A normal root/workspace Session; ordinary work. |
| `super` | The super-agent root that dispatches work from the super workspace; most privilege, and the role gate for cross-workspace writes. |

The role type and reader live in `packages/core/agent/src/runtime-types.ts` and `packages/core/agent/src/role.ts`: `AgentRole`, `agentRoleOf`. Feature packages declare a tool gate through `@deepseek-ai/dsh-tools` (`withMinRole` / `toolMinRole`); no feature package imports dafeiyu for role. The organizer attaches tools to agents; the tool registry performs the role filter.

## 2. Declaration source and default

- The durable source is the Workspace record's `role` field (`agent` or `super`; absent/unknown -> `agent`). `SessionController.createSession` resolves it by canonical cwd and merges it into `agentOptions`; client request bodies cannot set it.
- Resolution is an exact canonical workspace-path match (`workspaceRegistry.resolveByPath`); a Session whose cwd is a subdirectory of a `super` workspace does not inherit that role and falls back to `agent`.
- Ordinary workspaces default to `agent`; the super workspace is marked `super` once in the Workspace store (`<DSH_HOME>/storages/workspace.json`, table `workspaces`, field `role`). Older records without the field stay `agent`; any value other than `super` also resolves to `agent`. `agent.options.role` remains the live value the rest of the model reads.
- An undeclared **root** resolves to `agent`, not `super`. This is the safe default for an ordinary workspace Session: `super` is never granted implicitly, while a root must retain normal workspace capability to function.
- An undeclared **child** resolves to `subagent` from durable lineage (`origin: 'subagent'`, `parentSession`, or `delegationDepth > 0`). Child lineage wins over a declared value, so a child cannot promote itself.
- `agent.options.role` is live agent configuration. A resumed Session resolves the role again from its Workspace record; the durable role lives on the Workspace, not the Session header.

## 3. Parent/child rule

`agentRoleOf` first checks lineage; if the Agent is a child, it returns `subagent` regardless of `agent.options.role`. A subagent is therefore **not** a super-capable copy of its parent, and it cannot opt into `super`. An ordinary root with no declaration is `agent`; a root declaring `super` is the only way to obtain the super role.

## 4. Existing implicit judgments and future replacement

| Current judgment | Location | Future role replacement |
|---|---|---|
| Capability `scope: 'root'` | `dafeiyu/src/api.ts:325` | Keep scope for non-tool resources; tool visibility is enforced by the registry's `minRole`. |
| Personality tool filter | `personality/src/api.ts:120` | Migrated: analyze declares `minRole: subagent`, apply declares `minRole: agent`. |
| Memory capability scope | `memory/src/tools.ts:42-44` | Migrated: each of the three memory tools declares its `minRole`. |
| Schedule runtime rejection | `schedule/tool-schedule/src/index.ts:298-315` | A subagent call is still refused at runtime; visibility comes from `minRole`. |

The role field is the shared source; tool visibility is enforced centrally by the registry's `minRole`, and non-tool judgments stay in their own capabilities.

## 5. 690 gating and quota

- Section 690 is omitted for `subagent`; ordinary and super roots use independent `OUTPUT_STYLE.yaml` and `SUPERAGENT_OUTPUT_STYLE.yaml` slots. The existing ordinary file keeps working unchanged.
- Writing rules: 100 rules / 240 characters / 32 KiB total; only the first 40 enabled rules are resident. The 41st is omitted with `N rule(s) not injected: resident limit is 40.`; no retrieval. These are implemented and tested.

## 6. Tool matrix draft

“Current” is the visibility enforced in this tree; rows marked “new” were migrated in this round. The JIRA and super-agent tools are retired; JIRA keeps only its cloudstore data repository on GitHub, as data, not connected to any tool or process, not a design capability, and needing no credentials or remote-access instructions.

| Tool family | Current visibility (filter location) | Suggested role | Why | What a subagent loses |
|---|---|---|---|---|
| `personality_analyze` | all agents; `personality/src/api.ts:120` | `subagent`+ | Read-only research | Nothing |
| `personality_apply` / `write_like_human` | subagent excluded; `personality/src/api.ts:120` | `agent`+ | Global write | No write access (already) |
| `tool-dsh-store` | agent+ (new); `minRole: agent` | `agent` | Rules/skills management | Hidden from subagent |
| `memory_write` / `memory_forget` | agent+ (new); `memory/src/tools.ts:42-43` `minRole: agent` | `agent` | Single writer | No write access (newly hidden) |
| `memory_search` | subagent+ (new); `memory/src/api.ts:273` scope `all`, the tool carries `minRole: subagent` (`memory/src/tools.ts:44`) | `subagent` | Research may need history | Now available; no loss |
| `workspace_sessions` / `workspace_intents` / `workspace_tasks` / `workspace_message` / `workspace_artifacts` | subagent+ (new); `minRole: subagent` (`packages/uitstalie/workspace-tools/src/tools.ts:27-31`), with action-level role checks inside each tool | `subagent` | Reads are open to every agent in the workspace; writes are open to any agent in the workspace: lifecycle, card writes, and task create/update/receipt all work, and a cross-workspace write needs the super agent; a cross-workspace send is allowed only through a task binding | Now available; writes work in the workspace, and cross-workspace writes stay gated |
| `schedule_create/edit/list/view` | agent+ (new); `minRole: agent`, runtime guard retained | `agent` | Subagent cannot reach next trigger | Hidden from subagent; runtime refusal remains |
| `plugin_manager` | agent+ (new); `minRole: agent` | `agent` | Global profile management | Hidden from subagent |
| `subagent` / `subagent_fork` / `workflow` | agent+ (new); `minRole: agent` | `agent` | No nested fan-out | Hidden from subagent; depth guards remain |
| `send_message` / `list_agents` / `wait_agent` | subagent+ (new); `minRole: subagent` | `subagent` | Child needs parent communication | Retained; no loss |
| `read` / `write` / `edit` / `glob` / `grep` / `pwsh` / … | all agents | `subagent`+ | Basic execution | Nothing; removal would break work |

## 7. Interface reservation

`withMinRole(tool, role)` and `toolMinRole(tool)` live in `packages/core/tools/src/role.ts` and are exported by `@deepseek-ai/dsh-tools`; a feature package declares a gate without importing dafeiyu. `ToolRegistry.register` and `ToolRegistry.definitions` enforce `ToolDefinition.minRole` centrally (`core/tools/src/index.ts:133-138` and `:313-320`). The intended consumer signature is:

```text
tools(agent) -> ToolDefinition[] // each may carry minRole; the organizer filters roleAllows(agentRoleOf(agent), minRole)
```

The registry enforces these declarations centrally; the approved matrix is fully migrated.

## 8. File naming and default rationale

`SUPERAGENT_OUTPUT_STYLE.yaml` follows the existing `SUPERAGENT_*` constant prefix and sits beside `OUTPUT_STYLE.yaml`; this package has no agent-type suffix convention, so the explicit super prefix is the clearest existing convention. The ordinary slot keeps its existing filename, so an existing `OUTPUT_STYLE.yaml` is untouched.

An undeclared root defaults to `agent`, not `subagent`: a root is a normal workspace Session and must retain ordinary workspace capability; `subagent` is a lineage-derived role, not a safe default for a root. `super` is never implicit.

## 9. Verification and non-goals

- Existing tests: `role-visibility.spec.ts` asserts the 18/30/30 approved matrix; the personality, tool-dsh-store, and workspace-tools suites pass; typecheck passes.
- Tool visibility now changes exactly for the rows marked “new”: memory read/write split, communication retained, and schedule/plugin/delegation/.dsh hidden from subagents; no super-only tool row remains.
- Not in this round: 702 extraction, localization, or any quota change.

## 10. Deployment acceptance: the super workspace in the sidebar

The durable role now reaches the browser, and the sidebar renders the `super` Workspace in its own section above the ordinary checkouts. **CI** means the branch's automated suite covers the item; **Deploy** means the running GUI or the real `<DSH_HOME>` is required and the suite cannot prove it. Do not tick a **Deploy** item from the suite alone. This section accepts the sidebar change only; the model-facing rows of section 6 keep their own coverage.

- [ ] `WorkspaceView` carries the durable role in the follow baseline and in every later role change, and a record without `role` projects as `agent`. CI: `projects the durable Workspace role in the baseline and in later role changes` (`packages/api/workspace-controller/tests/workspace-controller.host.spec.ts`). Deploy: read the feed row of a Workspace whose record has no `role`.
- [ ] The client registers one `super` group from the Workspace snapshot, removes it when the role disappears or the Workspace does, and registers nothing for an ordinary snapshot. CI: `lifts the durable super workspace into its own sidebar section and follows the Workspace list` (`packages/client/ui-workspace/tests/apply.client.spec.ts`). Deploy: confirm `<DSH_HOME>/storages/workspace.json` names one `role: super` record and the sidebar shows one special section.
- [ ] The browser puts the registered Workspace under its own heading above the ordinary list, and draws no special heading without a registration. CI: `renders a registered special Workspace in its own section above the ordinary list` and `renders no special section without a registered group` (`packages/client/ui-workspace/tests/workspace-browser.client.spec.tsx`). Deploy: the default grouped view shows "Super workspace" above "Other workspaces".
- [ ] The section follows the record, not the title: a Workspace named like the home but stored `agent` stays in the ordinary section, and a `super` Workspace renders in the special one whatever its title. Deploy: rename the super Workspace, restart the host, and confirm the section is unchanged.
- [ ] Clearing the durable role moves the Workspace back to the ordinary section, and its next Session becomes `agent`. Deploy: remove `role` from that record in `<DSH_HOME>/storages/workspace.json`, restart the host, and confirm the split disappears.
- [ ] The split is a grouped-view feature: the flat "In one list" view has no Workspace rows and no headings, and switching back restores the split. Deploy: toggle both views in the GUI.

The person confirmed the split on the deployed 3080 host on 2026-11-19; the remaining **Deploy** items stay unchecked until they are walked on that host.
