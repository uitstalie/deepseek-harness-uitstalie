# Tool surface re-organization: personality, JIRA retirement, and `.dsh` tools

English | [中文](tool-surface-reorg.zh.md)

Status: implemented. The JIRA product is retired, including its model tools, skills, panel, CLI, local ledger, dispatch history, and super-agent tools; only the cloudstore repository on GitHub, its content and history, is kept as data, not connected to any tool or process. Session lifecycle now lives in `workspace_sessions`; delivery and return go only through `workspace_message`, task state only through `workspace_tasks`, and workspace requests and the return contract belong to the [memory and workspace design](memory-scoping.md) section 6.5. Personality owns both global files through one tool, and `tool-dsh-store` remains the only `.dsh` entry. Length budget: 12 pages / 4,000 words.

## 1. Scope and result

This document covers the three tool groups that were re-arranged:

- the personality tools and their two global files;
- the JIRA product and the super-agent tools that existed only to run its claim/dispatch loop;
- the `.dsh` store tool.

The JIRA product is removed in one step. No alias, phased removal, or compatibility layer exists. A rollback is a reinstall of the previous release; the deleted local ledger and dispatch history cannot be restored.

## 2. Retired JIRA surface

The JIRA model tools, the executor ledger tool, the claim/dispatch tools, the super-agent control and ledger tools, the three JIRA skills, the `/jira` command, the write guard, the awareness line, and the turn-end ledger settle are removed. The `packages/jira` package and the dispatch-core package are deleted. The Web app bundle no longer mounts the JIRA service, agent, or panel rows, and no longer ships the executor preset.

JIRA keeps only its cloud data repository: the cloudstore repository on GitHub, its content and history, kept as data, not connected to any tool or process, not a design capability, and needing no credentials or remote-access instructions. There is no JIRA endpoint, project, tenant, or timeout setting; the local ledger's path and audit settings were removed with the ledger.

The local JIRA ledger at `$DSH_HOME/jira` and the dispatch history under `.superagent` are deleted and cannot be restored; no model tool reads the deleted paths. The workspace task store starts fresh, with no import.

Who observes the removal: prompts, skills, and evaluation sets that expected the retired tools; profiles and patches that named the JIRA rows or the executor preset; the JIRA panel and CLI users, who lose their local data; and any stored Session whose transcript mentions the retired calls, which now returns `unknown tool`.

## 3. Session lifecycle and delivery state move into `workspace_*`

`workspace_sessions` is the single Session-lifecycle entry. Its actions are `list`, `get`, `run`, `start`, `append`, `prompt`, `stop`, `abort`, `fork`, `archive`, `compact`, and `delete`.

- `list` and `get` keep the existing read semantics: workspace sessions, status, current activity, recent progress, pending inbox, and artifact count.
- `run` is the one-call dispatch: it continues the target Session (`sessionId`, or the most recently updated one when omitted) and starts a new Session only when the workspace has none; `new_session: true` forces a fresh Session when the person asks for one, the first task defaults to `text`, and the title is derived when omitted.
- `start` creates a Session in a named registered workspace and only receives and sends its first task text and optional (derived) title; it does not check an intent card. Workspace requests are a general capability: any agent can send a request to another agent or Session through `workspace_message` or `workspace_sessions`, and the super workspace dispatches and receives through the same tool calls; intent cards and `workspace_tasks` are used only when a formal task record is needed, and the details are in the [memory and workspace design](memory-scoping.md) section 6.5.
- `append` continues a named Session or the most recently updated one; `prompt` addresses one explicit Session id.
- `stop` cuts off the running turn without text; `abort` cuts it off and then sends the follow-up text.
- `fork`, `archive`, `compact`, and `delete` keep the Host lifecycle semantics. `delete` requires the exact Session id as confirmation and refuses when the Host exposes no real delete API.

The caller's workspace is the default scope. Lifecycle writes are open to any agent in the workspace; a cross-workspace write requires the super agent (implemented); reads stay open to every agent in the workspace. Cross-workspace calls take an explicit registered workspace id and are recorded.

Delivery state lives in `workspace_message`. `send` records a message and its delivery attempt. `status` reports the message's state, failure reason, and attempt count. `retry` resends a failed message with the same request identity, body, and references; a repeated retry does not enqueue twice. A failed message remains readable through `read`, so a failure is never a silent loss.

Workspace requests and the return contract belong to the memory and workspace design ([memory and workspace design](memory-scoping.md) sections 5.4, 6.5, and 11.8): any agent can send a request to another agent or Session in the same workspace through `workspace_message` (`send`/`read`/`status`/`retry`); intent cards and `workspace_tasks` are used only when a formal task record is needed, and a simple or clear action needs no separate card. The executor returns with `workspace_message.send` carrying `taskId`; a cross-workspace send is allowed only through a task binding (`task.targetSessionId` is the caller and `task.dispatcherSessionId` is the target, implemented); `requestId` is idempotent; `status` and `retry` handle failures; task state changes only through `workspace_tasks`. Task creation and intent-card writes are open to any agent in the workspace; a cross-workspace write still requires the super agent. This document does not redefine those contracts.

## 4. Personality

`personality_analyze` stays read-only and available to subagents. `personality_apply` is root-only and owns both global files: pass exactly one of `candidates` (the profile) or `writingRules` (the rules file), plus the literal `confirm: true`. The two files are not merged with global memory; they keep separate lifecycles, review flows, and prompt sections.

## 5. `.dsh`

`tool-dsh-store` remains the only model-facing entry for `.dsh` content. `workspace_artifacts` publishes and resolves references; for a `.dsh` path it calls the store's path normalization and namespace check and refuses `.dsh/memory`. It never becomes a second store writer.

## 6. Final tool surface

| Namespace | Owner | Members |
|---|---|---|
| `workspace_*` | Workspace information design | `workspace_sessions`, `workspace_intents`, `workspace_tasks`, `workspace_message`, `workspace_artifacts` |
| `ask_user_question_plus` | Workspace information design | Refuses a non-super interactive ask inside a request from another agent and names the dispatcher; a person-started or super-agent turn delegates to the host `userQuestions` service |
| `memory_*` | Memory design | `memory_write`, `memory_forget`, `memory_search` |
| `personality_*` | This change | `personality_analyze`, `personality_apply` |
| `tool-dsh-store` | This change | The only validated `.dsh` entry |
| Retired | — | JIRA and super-agent tool groups, with no alias |

`workspace_sessions` now carries the lifecycle actions; `workspace_message` carries delivery status and retry. No parallel task or delivery API remains.

## 7. Risks and rollback

- The local JIRA ledger and dispatch history are deleted and unrecoverable. The cloud keeps only the cloudstore data repository, as data, not connected to any tool or process.
- The removal is one release with no phased path. Roll back by reinstalling the previous release; the deleted data does not return.
- A prompt or preset that still names a retired tool or JIRA row fails visibly: the tool call returns `unknown tool`, and a patch naming a removed row fails at load.
- The `.dsh` boundary is enforced by the store; an artifact path under `.dsh/memory` is refused rather than copied.

## 8. Alignment with the memory and workspace design

The memory design's mapping rows were revised in the same change: the JIRA claim/dispatch surface is removed, the JIRA model tools are gone, delivery and return are `workspace_message`, task state is `workspace_tasks`, session lifecycle is `workspace_sessions`, and the `.dsh` pointer stays. Workspace requests and the return contract are defined only by the memory and workspace design; this document points to it. `workspace_tasks` starts fresh; no JIRA key or ledger compatibility field exists.

## 9. Verification

The implementation change records the executed gates: repository typecheck, the affected package tests (workspace tools, personality, memory, role visibility, composition), documentation sync, the config and plugin catalogs, package paths, upgrade guides, and bilingual pairing. The tool catalog of a rebuilt composition contains no retired name, and `packages/jira` no longer exists.
