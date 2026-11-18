---
kind: upgrade-guide
description: "The JIRA product and the super-agent control/ledger tools are removed; session lifecycle moves to workspace_sessions and delivery failure/retry to workspace_message, and the local JIRA and dispatch data are irrecoverable after deletion."
---
# The JIRA product is removed; session lifecycle moves to the workspace toolset

English | [中文](guide.zh.md)

## Change

The JIRA product is removed in one step. The issue, knowledge-base, and list model tools, the executor ledger tool, the claim/dispatch tools, the super-agent control and ledger tools, the three JIRA skills, the `/jira` command and write guard, and the whole `packages/jira` package no longer exist. The JIRA and super-agent config rows and the `jira-worker` preset are removed from the Web app bundle. No alias or compatibility layer exists.

Session lifecycle now lives in `workspace_sessions`, whose actions are `list`, `get`, `start`, `append`, `prompt`, `stop`, `abort`, `fork`, `archive`, `compact`, and `delete`. A lifecycle write requires the super-agent role; reads stay open to every agent in the workspace. Delivery failure state and resend now live in `workspace_message`: `status` reports a message's delivery state, failure reason, and attempts; `retry` resends a failed message with the same request identity.

`personality_apply` owns both global personality files: pass exactly one of `candidates` (the profile) or `writingRules` (the rules file) plus `confirm: true`. `personality_analyze` stays read-only for subagents. `workspace_artifacts` validates a `.dsh` path through the `.dsh` store and refuses `.dsh/memory`.

The local JIRA ledger at `$DSH_HOME/jira` and the dispatch history under `.superagent` were deleted after a one-time export to `D:\dqc\_exports\tool-surface-reorg-20261118`. They cannot be restored; `workspace_tasks` starts fresh with no import.

## Migration

1. Replace every super-agent control call with `workspace_sessions` actions (`start`, `append`, `prompt`, `stop`, `abort`, `fork`, `archive`, `compact`, `delete`) and every ledger call with `workspace_tasks` or `workspace_message`. Carry the claimed work content in the `start` task text; no executor ledger tool remains.
2. Replace `write_like_human({ action, ... })` with `personality_apply({ writingRules: { action, ... }, confirm: true })`. Remove `write_like_human` from allowlists and role matrices.
3. Remove the JIRA and super-agent rows, the `jira-worker` preset, and `@deepseek-ai/dsh-jira-*` dependencies from profiles, patches, and package manifests. A patch that still names them reports `patch: entry ... not found` at load.
4. Replace file handoff with `workspace_artifacts.publish` plus a `workspace_message.send` reference. Replace permission and model selection with the Host settings.
5. If you need the deleted data, copy it from the export before deleting the originals. Confirm: the tool list contains no JIRA or super-agent tool; `dsh --profile headless --dump-config` shows no JIRA row or skill; `.dsh/memory` publish is refused.
