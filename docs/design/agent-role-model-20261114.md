# Agent role model and tool matrix draft (2026-11-14)

English | [中文](agent-role-model-20261114.zh.md)

Status: **role field, section gating, and the approved tool gates are implemented.** Tool visibility is enforced once in the tool registry; superagent remains the only unmigrated family.

## 1. Role classification

| Role | Meaning |
|---|---|
| `subagent` | A delegated child, or any Session with child lineage; least privilege. |
| `agent` | A normal root/workspace Session; ordinary work. |
| `super` | The super-agent root that dispatches work; most privilege. |

The role type and reader live in `packages/core/agent/src/runtime-types.ts` and `packages/core/agent/src/role.ts`: `AgentRole`, `agentRoleOf`. Feature packages declare a tool gate through `@deepseek-ai/dsh-tools` (`withMinRole` / `toolMinRole`); no feature package imports dafeiyu for role. The organizer only owns the future registration filter.

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
| Personality tool filter | `personality/src/index.ts:122` | Existing behavior: subagent gets analyze only; not migrated to minRole in this round. |
| Jira worker test | `jira-agent/src/contribution.ts:146-179` | `isWorker` still chooses the worker tool set; every returned tool also carries `minRole: agent`, so role gates subagents. |
| Super-agent test | `jira-agent/src/superagent.ts:418-424`, `:5752-5769` | Current cwd-based `isSuperAgentSession`; future `agentRoleOf === 'super'`. |
| Memory capability scope | `memory/src/index.ts:296` | Future tool-level role declaration; current behavior unchanged. |
| Schedule runtime rejection | `schedule/tool-schedule/src/index.ts:307` | Current subagent call refusal; visibility unchanged. |

The role field is the shared source; each consumer migrates separately. This round does **not** replace any of the above behavior.

## 5. 690 gating and quota

- Section 690 is omitted for `subagent`; ordinary and super roots use independent `OUTPUT_STYLE.yaml` and `SUPERAGENT_OUTPUT_STYLE.yaml` slots. The existing ordinary file keeps working unchanged.
- Writing rules: 100 rules / 240 characters / 32 KiB total; only the first 40 enabled rules are resident. The 41st is omitted with `N rule(s) not injected: resident limit is 40.`; no retrieval. These are implemented and tested.

## 6. Tool matrix draft

“Current” is the visibility enforced in this tree; rows marked “new” were migrated in this round.

| Tool family | Current visibility (filter location) | Suggested role | Why | What a subagent loses |
|---|---|---|---|---|
| `personality_analyze` | all agents; `personality/index.ts:122` | `subagent`+ | Read-only research | Nothing |
| `personality_apply` / `write_like_human` | subagent excluded; `personality/index.ts:122` | `agent`+ | Global write | No write access (already) |
| `jira_issue` / `jira_list` / `jira_kb` | agent+ (new); `minRole: agent` | `agent` | Ledger identity belongs to main/workspace Sessions | Hidden from subagent |
| jira `issue_work` | agent+ (new); `minRole: agent` | `agent` | Worker executor is an agent root | Hidden from subagent |
| `tool-dsh-store` | agent+ (new); `minRole: agent` | `agent` | Rules/skills management | Hidden from subagent |
| `memory_write` / `forget` / `resolve` | agent+ (new); `memory/src/tools.ts` `minRole: agent` | `agent` | Single writer | No write access (newly hidden) |
| `memory_search` / `read` | subagent+ (new); `memory/src/index.ts` scope now `all`, tools carry `minRole: subagent` | `subagent` | Research may need history | Now available; no loss |
| `superagent_control` / `ledger` / `deliver` / `permission` | super-only via cwd + root; `superagent.ts:5752-5769` | `super` | Dispatch/ledger/delivery | Nothing (already unavailable) |
| `schedule_create/edit/list/view` | agent+ (new); `minRole: agent`, runtime guard retained | `agent` | Subagent cannot reach next trigger | Hidden from subagent; runtime refusal remains |
| `plugin_manager` | agent+ (new); `minRole: agent` | `agent` | Global profile management | Hidden from subagent |
| `subagent` / `subagent_fork` / `workflow` | agent+ (new); `minRole: agent` | `agent` | No nested fan-out | Hidden from subagent; depth guards remain |
| `send_message` / `list_agents` / `wait_agent` | subagent+ (new); `minRole: subagent` | `subagent` | Child needs parent communication | Retained; no loss |
| `read` / `write` / `edit` / `glob` / `grep` / `pwsh` / … | all agents | `subagent`+ | Basic execution | Nothing; removal would break work |

## 7. Interface reservation

`withMinRole(tool, role)` and `toolMinRole(tool)` live in `packages/core/tools/src/role.ts` and are exported by `@deepseek-ai/dsh-tools`; a feature package declares a gate without importing dafeiyu. `ToolRegistry.register` and `ToolRegistry.definitions` enforce `ToolDefinition.minRole` centrally (`core/tools/src/index.ts:128` and `:312`). The intended consumer signature is:

```ts
tools(agent) -> ToolDefinition[] // each may carry minRole; the organizer filters roleAllows(agentRoleOf(agent), minRole)
```

The registry enforces these declarations centrally; only superagent remains unmigrated.

## 8. File naming and default rationale

`SUPERAGENT_OUTPUT_STYLE.yaml` follows the existing `SUPERAGENT_*` constant prefix and sits beside `OUTPUT_STYLE.yaml`; this package has no agent-type suffix convention, so the explicit super prefix is the clearest existing convention. The ordinary slot keeps its existing filename, so an existing `OUTPUT_STYLE.yaml` is untouched.

An undeclared root defaults to `agent`, not `subagent`: a root is a normal workspace Session and must retain ordinary workspace capability; `subagent` is a lineage-derived role, not a safe default for a root. `super` is never implicit.

## 9. Verification and non-goals

- Existing tests: personality 105/105, tool-dsh-store 19/19, jira superagent 125/125, typecheck 5/5.
- Tool visibility now changes exactly for the rows marked “new”: memory read/write split, communication retained, schedule/plugin/delegation hidden, and jira/.dsh hidden from subagents. Only superagent remains pending.
- Not in this round: 702 extraction, localization, superagent tool gating, or any quota change.
