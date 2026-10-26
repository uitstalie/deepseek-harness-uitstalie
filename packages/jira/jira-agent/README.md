---
description: "The jira ledger's model surface: the dafeiyu capability provider registering the jira_issue, jira_list and jira_kb tools, the write guard, the /jira command, the bundled skills and the turn-end settle."
kind: "package-reference"
---

# @deepseek-ai/dsh-jira-agent

English | [中文](README.zh.md)

## Summary

`dsh-jira-agent` is the ledger's model surface: a dafeiyu capability provider that registers the three resident tools (`jira_issue` with its ten verbs, `jira_list`, `jira_kb`), the one-line `jira:store` awareness section, the monotonic write guard, the `/jira` command, three bundled skills, and the turn-end settle. It injects `ctx.jira`, the tool registry, and `ctx.dafeiyu`; commands and skills are optional, so a composition without those registries keeps the tools. The ledger's location, machine identity, and push queue belong to the `jira-service` row, so this row carries no configuration of its own.

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
| `tools.ts` | the three registry definitions and the per-call store/caller resolution |
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

`pnpm test` runs `node --test "src/**/*.test.ts"`. The wiring suites (`index`, `schema`, `surfaces`, `messages`) mount the shipped services through a real Cordis context — system prompt, tools, dafeiyu, commands, skills and `jira-service` — so they exercise the real registrations rather than a hand-built host.

The suites resolve the workspace packages through their package roots, which is the built `lib/` entry. Run `pnpm run build:artifacts` before them in a source checkout.

<a id="model-experience"></a>

## Model Experience

### The three resident jira tools

#### What the model sees

Every request of a root agent carries the three tools: `jira_issue` with its ten verbs (`get`, `create`, `update`, `switch_state`, `comment`, `assignee`, `link`, `tag_create`, `close`, `batch_close`), `jira_list`, and `jira_kb` with `get`, `search`, `create` and `update`. Their descriptions and schemas stay small and every result renders as text. A child agent receives neither the tools nor the awareness line, because the capability registers with `scope: 'root'`. A write is refused with an ordinary tool result when the session may not write, and the guard denies it earlier so no handler runs.

#### Token effect

A fixed schema cost on every root-agent request, plus the result text of each call. A child agent carries none of it.

#### KV Cache effect

Prefix-stable while the tool definitions and their visibility are unchanged. Every result is an ordinary tool result appended after the reusable prefix, so a call invalidates no earlier entry.

### The `jira:store` awareness line

#### What the model sees

One prompt section named `jira:store`, order `700`, rendered as a single line: the store's name, how many projects, knowledge entries and open issues it holds, plus the count of machine-anchored read-only projects. It renders nothing for an empty ledger, and it is recomputed only when the ledger commits (`changed`), never per model step.

#### Token effect

At most one line on every root-agent request; an empty ledger contributes nothing.

#### KV Cache effect

The text changes only when a commit changes a count, so a stable ledger keeps the prefix cached; a changed line re-tokenizes from this section onward.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The browser surface is `ui-jira`'s, not this package's.** The agent owns the tools, the awareness line and the write guard; the `jira` settings section reads the same ledger through `remote.jira`, and disabling the capability hides only the model surface.
- **The runner modules still import `jira-core` by deep path.** The phase-1 bridge opens the store through `ctx.jira.store()`; moving the runners onto the service's own read/write methods is the phase-2 follow-up.
- **The CLI-parity assertion is split.** The standalone package compared the tool verbs with the CLI's command names in one test. `jira-agent` may not depend on `jira-cli`, so the CLI keeps its own table/handler/usage tests and the mapping between the two surfaces is unguarded.
- **The awareness line no longer names the workspace binding.** The contract's section names the store and its counts; the workspace→project phrase was a context source in the standalone plugin.

<a id="dev-note"></a>

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
