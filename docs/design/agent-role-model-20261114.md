# Agent role model and tool matrix draft (2026-11-14)

English | [中文](agent-role-model-20261114.zh.md)

Status: **role field and section gating are implemented; tool visibility is not changed in this round.** This page is the review draft for later tool configuration.

## 1. Role classification

| Role | Meaning |
|---|---|
| `subagent` | A delegated child, or any Session with child lineage; least privilege. |
| `agent` | A normal root/workspace Session; ordinary work. |
| `super` | The super-agent root that dispatches work; most privilege. |

The role type and reader live in `packages/core/agent/src/runtime-types.ts` and `packages/core/agent/src/role.ts`: `AgentRole`, `agentRoleOf`. The organizer only owns the future tool-minimum helpers (`packages/uitstalie/dafeiyu/src/role.ts`).

## 2. Declaration source and default

- The only source is `agent.options.role` (declared through Session/agent creation options; a preset/config that creates the Agent must set it). There is no cwd, workspace-title, preset-name, or tool-presence inference.
- **Current activation gap:** no shipped preset or profile line sets `role: 'super'`; a super Session must be created with `agentOptions: { role: 'super' }` (or a preset that passes it). Until that is wired, `SUPERAGENT_OUTPUT_STYLE.yaml` is read only by explicitly constructed super Agents. The existing profile was not modified.
- An undeclared **root** resolves to `agent`, not `super`. This is the safe default for an ordinary workspace Session: `super` is never granted implicitly, while a root must retain normal workspace capability to function.
- An undeclared **child** resolves to `subagent` from durable lineage (`origin: 'subagent'`, `parentSession`, or `delegationDepth > 0`). Child lineage wins over a declared value, so a child cannot promote itself.
- `agent.options.role` is live agent configuration. A resumed Session must be re-created with the same declaration if it needs `super`; there is no persisted role field in this stage.

## 3. Parent/child rule

`agentRoleOf` first checks lineage; if the Agent is a child, it returns `subagent` regardless of `agent.options.role`. A subagent is therefore **not** a super-capable copy of its parent, and it cannot opt into `super`. An ordinary root with no declaration is `agent`; a root declaring `super` is the only way to obtain the super role.

## 4. Existing implicit judgments and future replacement

| Current judgment | Location | Future role replacement |
|---|---|---|
| Capability `scope: 'root'` | `dafeiyu/src/index.ts:318-320` | Keep scope for non-tool resources; tool visibility should use `agentRoleOf`. |
| Personality tool filter | `personality/src/index.ts:122` | Existing behavior: subagent gets analyze only. Future: declare `minRole` per tool through the shared interface. |
| Jira worker test | `jira-agent/src/contribution.ts:146-179` | Current `isWorker` (subagent or executor preset) still controls tools; not changed. |
| Super-agent test | `jira-agent/src/superagent.ts:418-424`, `:5752-5769` | Current cwd-based `isSuperAgentSession`; future `agentRoleOf === 'super'`. |
| Memory capability scope | `memory/src/index.ts:296` | Future tool-level role declaration; current behavior unchanged. |
| Schedule runtime rejection | `schedule/tool-schedule/src/index.ts:307` | Current subagent call refusal; visibility unchanged. |

The role field is the shared source; each consumer migrates separately. This round does **not** replace any of the above behavior.

## 5. 690 gating and quota

- Section 690 is omitted for `subagent`; ordinary and super roots use independent `OUTPUT_STYLE.yaml` and `SUPERAGENT_OUTPUT_STYLE.yaml` slots. The existing ordinary file keeps working unchanged.
- Writing rules: 100 rules / 240 characters / 32 KiB total; only the first 40 enabled rules are resident. The 41st is omitted with `N rule(s) not injected: resident limit is 40.`; no retrieval. These are implemented and tested.

## 6. Tool matrix draft

“Current” is the behavior in this tree; no row in this table was changed by this round.

| Tool family | Current visibility (filter location) | Suggested role | Why | What a subagent loses |
|---|---|---|---|---|
| `personality_analyze` | all agents; `personality/index.ts:122` | `subagent`+ | Read-only research | Nothing |
| `personality_apply` / `write_like_human` | subagent excluded; `personality/index.ts:122` | `agent`+ | Global write | No write access (already) |
| `jira_issue` / `jira_list` / `jira_kb` | worker/subagent gets them; `jira/contribution.ts:179` | `agent`+ | Ledger identity belongs to main/workspace Sessions | **Pending**: would lose ledger read/write/search |
| jira `issue_work` | worker/subagent; `jira/contribution.ts:179` | `agent`+ | Worker executor is an agent root | **Pending**: would lose worker write |
| `tool-dsh-store` | all agents; `tool-dsh-store/index.ts:51` | `agent`+ | Rules/skills management | **Pending**: would lose `.dsh` management |
| `memory_write` / `forget` / `resolve` | none for subagent; `memory/index.ts:296` (scope root) | `agent`+ | Single writer | Nothing (already unavailable) |
| `memory_search` / `read` | none for subagent; same | **pending**: allow `subagent` | Research may need history | If denied, only parent summaries remain |
| `superagent_control` / `ledger` / `deliver` / `permission` | super-only via cwd + root; `superagent.ts:5752-5769` | `super` | Dispatch/ledger/delivery | Nothing (already unavailable) |
| `schedule_create/edit/list/view` | visible to all; runtime refuses subagent (`tool-schedule:307`) | `agent`+ | Subagent cannot reach next trigger | Pending: only hidden schema, call already refused |
| `plugin_manager` | all agents; no role check (`plugin-manager/tools.ts:87`) | `agent`+ | Global profile management | Pending |
| `subagent` / `subagent_fork` / `workflow` | all agents; direct registration (`tool-subagent:338`, `tool-workflow:331`) | `agent`+ | No nested fan-out | Pending: current depth limits only |
| `send_message` / `list_agents` / `wait_agent` | all agents; direct registration (`tool-subagent-control:84`, `list-agents.ts:46`, `wait-agent.ts:91`) | `subagent`+ | Child needs parent communication | If removed, cannot reply/query parent |
| `read` / `write` / `edit` / `glob` / `grep` / `pwsh` / … | all agents | `subagent`+ | Basic execution | Nothing; removal would break work |

## 7. Interface reservation

`withMinRole(tool, role)` and `toolMinRole(tool)` exist in `dafeiyu/src/role.ts` as the future declaration shape. The organizer does **not** call them in this round; no tool definition carries `minRole`, and the registration loop is unchanged. The intended consumer signature is:

```ts
tools(agent) -> ToolDefinition[] // each may carry minRole; the organizer filters roleAllows(agentRoleOf(agent), minRole)
```

This is a design reservation only. No provider is migrated here.

## 8. File naming and default rationale

`SUPERAGENT_OUTPUT_STYLE.yaml` follows the existing `SUPERAGENT_*` constant prefix and sits beside `OUTPUT_STYLE.yaml`; this package has no agent-type suffix convention, so the explicit super prefix is the clearest existing convention. The ordinary slot keeps its existing filename, so an existing `OUTPUT_STYLE.yaml` is untouched.

An undeclared root defaults to `agent`, not `subagent`: a root is a normal workspace Session and must retain ordinary workspace capability; `subagent` is a lineage-derived role, not a safe default for a root. `super` is never implicit.

## 9. Verification and non-goals

- Existing tests: personality 105/105, tool-dsh-store 19/19, jira superagent 125/125, typecheck 5/5.
- No tool visibility changed in this round. Only the already-approved 690 gating and writing-rule quota/resident behavior are implemented.
- Not in this round: 702 extraction, localization, tool configuration, memory read policy, schedule/delegation/plugin visibility.
