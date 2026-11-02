---
description: "The jira ledger's model surface: the dafeiyu capability providers registering the jira_issue, jira_list and jira_kb tools, the executor's issue_work tool, the claim loop, the write guard, the /jira command, the bundled skills and the turn-end settle."
kind: "package-reference"
---

# @deepseek-ai/dsh-jira-agent

English | [中文](README.zh.md)

## Summary

`dsh-jira-agent` is the ledger's model surface: a dafeiyu capability provider that registers the three resident tools (`jira_issue` with its ten verbs, `jira_list`, `jira_kb`) on a root agent and the single `issue_work` tool on a delegated child, the one-line `jira:store` awareness section, the monotonic write guard, the `/jira` command, three skills, and the turn-end settle. It registers a second, independently gated `superagent` capability that adds the claim loop (`superagent_scan`, `superagent_claim`, `superagent_status`, `superagent_workspace`) to a root agent. It injects `ctx.jira`, the tool registry, and `ctx.dafeiyu`; commands and skills are optional, so a composition without those registries keeps the tools. It registers contract version 2 with `enabledByDefault: false` and `settings.sectionId: 'jira'` for the capabilities list. The ledger's location, machine identity, and push queue belong to the `jira-service` row, so this row carries no configuration of its own.

## Table of Contents

- [Contents](#contents)
- [Tests](#tests)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="contents"></a>

## Contents

| Module | Owns |
|---|---|
| `index.ts` | the plugin entry: `name` / `inject` / `Config` / `apply`, and the controlled re-exports |
| `contribution.ts` | the dafeiyu capability: scope, tools, sections, agent hook, turn-end settle, dispose |
| `tools.ts` | the registry definitions (root and executor) and the per-call store/caller resolution |
| `workIssue.ts` | the executor's tool: its schema, its scope check and its runner |
| `superagent.ts` | the claim loop: readiness, proposal and claim |
| `awareness.ts` | the `jira:store` prompt section and its `changed`-driven refresh |
| `wiring.ts` | the write guard, the `/jira` command registration and the skill registration |
| `toolIssue.ts` / `toolList.ts` / `toolKb.ts` | the tool schemas, descriptions and runners |
| `envelope.ts` / `caller.ts` | the wire/entity conversion, the identity tuple, who is asking |
| `command.ts` / `skills.ts` | the `/jira` subcommands and the three bundled skills |
| `sessionRecord.ts` | the close-out scan, the push-failure record and the per-apply session recorder |
| `testing/host.ts` | the real-composition harness the wiring suites mount |

`/jira` is read-only except for `new` and `sync`; `sync` flushes the service's own queue rather than starting a second one.

Every completed turn of a writable root agent settles the ledger: the derived files are regenerated and committed, then the session close-out records the commits the session made on the issues they mention. A successful settle schedules a push only when the service row enabled the push switch.

<a id="tests"></a>

## Tests

`pnpm test` runs `node --import tsx --test "src/**/*.test.ts"`. The wiring suites (`index`, `schema`, `surfaces`, `messages`) mount the shipped services through a real Cordis context — system prompt, tools, dafeiyu, commands, skills and `jira-service` — so they exercise the real registrations rather than a hand-built host.

The tsx loader resolves workspace packages through the repository's tsconfig paths, so a source checkout needs no build. From the repository root, `pnpm run test:jira` runs every jira `node:test` suite and the package-level vitest specs; the CI static gate runs `test:jira:node` while the coverage lane runs the vitest specs.

<a id="model-experience"></a>

## Model Experience

### The root tools and the executor's tool

#### What the model sees

Every request of a root agent carries the three tools: `jira_issue` with its ten verbs (`get`, `create`, `update`, `switch_state`, `comment`, `assignee`, `link`, `tag_create`, `close`, `batch_close`), `jira_list`, and `jira_kb` with `get`, `search`, `create` and `update`. A delegated child carries the same three for reading the issue it was dispatched for, plus `issue_work` with `progress`, `deliver` and `blocked`; its `jira_issue` and `jira_kb` writes stay refused, and instead of the awareness line it reads a standing `jira:executor` section. `issue_work` accepts only an issue that is in progress and assigned to the session that dispatched the child, so a child writes exactly the issue it was sent for and nothing once it hands that issue back for review. Their descriptions and schemas stay small and every result renders as text. A write is refused with an ordinary tool result when the session may not write, and the guard denies `jira_issue` earlier so no handler runs.

#### Token effect

A fixed schema cost on every root-agent request, plus the result text of each call. A child carries the three ledger schemas plus `issue_work`, and no awareness line.

#### KV Cache effect

Prefix-stable while the tool definitions and their visibility are unchanged. Every result is an ordinary tool result appended after the reusable prefix, so a call invalidates no earlier entry.

### The `jira:store` awareness line

#### What the model sees

One prompt section named `jira:store`, order `700`, rendered as a single line: the store's name, how many projects, knowledge entries and open issues it holds, plus the count of machine-anchored read-only projects. It renders nothing for an empty ledger, and it is recomputed only when the ledger commits (`changed`), never per model step.

#### Token effect

At most one line on every root-agent request; an empty ledger contributes nothing.

#### KV Cache effect

The text changes only when a commit changes a count, so a stable ledger keeps the prefix cached; a changed line re-tokenizes from this section onward.

### The claim loop

#### What the model sees

A root agent carries four more tools when its deployment enables the `superagent` capability: `superagent_scan` lists the issues that could be taken now, `superagent_claim` proposes one or claims it, `superagent_status` reports ready/proposed/in-progress/in-review/blocked counts and the issues that need a person, and `superagent_workspace` lists the host's workspaces or registers a directory so a dispatch can name its checkout. Claiming refuses unless the latest comment on the issue is still this session's own proposal, so a person is asked between the two calls. On every completed root turn the capability also runs one pass in observe mode: it proposes the first ready issue, writes one `[claim-proposal]` comment, and never claims; it stays silent when this session already has work in progress or the latest comment is a proposal. A process-level, unref'd timer repeats that pass every five minutes while at least one wired agent is alive, and stops with the capability; a pass with no live agent is deferred because there is no dispatcher identity without a session. A delegated child carries none of the four.

#### Token effect

Four more small schemas on every root-agent request while the capability is on, plus the result text: a candidate list, the claimed issue with its dispatch instruction, the status counts, or the workspace roster.

#### KV Cache effect

Prefix-stable while the capability and its definitions are unchanged; the two capabilities gate independently, so enabling one does not disturb the other's tools.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The browser surface is `ui-jira`'s, not this package's.** The agent owns the tools, the awareness line and the write guard; the `jira` settings section reads the same ledger through `remote.jira`, and disabling the capability hides only the model surface.
- **The runner modules still import `jira-core` by deep path.** The phase-1 bridge opens the store through `ctx.jira.store()`; moving the runners onto the service's own read/write methods is the phase-2 follow-up.
- **The CLI-parity assertion lives outside this package.** `packages/jira/tests/parity.spec.ts` is the neutral suite that reads this package's tool verbs and `jira-cli`'s command table, so the two surfaces are compared without either package depending on the other.
- **The awareness line no longer names the workspace binding.** The contract's section names the store and its counts; the workspace→project phrase was a context source in the standalone plugin.

<a id="dev-note"></a>

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
