---
description: "The workspace-instruction loader with .dsh rules support, for users and maintainers sizing or debugging what reaches the model."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-instructions-plus

English | [中文](README.zh.md)

## Summary

`dsh-agent-instructions-plus` is the branch's workspace-instruction loader. It mounts the native `dsh-agent-instructions` loader unchanged and appends one more always-on source: every Markdown file under `<projectRoot>/.dsh/rules`, rendered into the same durable baseline message. Compositions disable the native row and mount this one instead, so the same chain is never delivered twice.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### What it adds

The native chain — `$DSH_HOME/AGENTS.md` plus the project chain of `AGENTS.md`, `CLAUDE.md`, and their local overlays — is delivered exactly as before. This package adds the workspace rules: every `.md` file under `.dsh/rules`, nested directories included, in path order.

### Configuration

The native section is the native loader's own schema, so its fields and defaults stay its own; the rules section adds one independent budget.

```yaml
- id: agent-instructions-plus
  name: '@deepseek-ai/dsh-agent-instructions-plus'
  config:
    agentInstructions:
      maxBytes: 65536
    rules:
      maxBytes: 16384
```

### Authoring rules

A rule is plain Markdown with no front-matter and no activation metadata: every file is always on, and a file whose content repeats another's after trimming collapses to the first one in path order. That keeps the set easy to reason about — there is no per-file scope to get wrong — which is also why a duplicate is worth deleting rather than renaming.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin mounts the native loader as a child plugin and registers its own `agent/pre-step` listener *before* that mount, so the listener wraps the native one: the waterfall reaches the native loader through `next()`, and the rules segment joins whichever channel the native loader used for its baseline — the batch it returned, or the pending inbox it keeps when the batch owns no step. The native rendering is reused verbatim, so the AGENTS portion stays byte-identical to a native-only composition; a rules edit the native chain does not react to emits a replacement baseline of its own.

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Workspace instruction context

#### What the model sees

One durable user message before the first request, framed as `<system-reminder>`: the native chain first, then one `Instructions from: .dsh/rules/<name>` section per retained rule file. Reaching a deeper directory can add a nested `AGENTS.md` as a later update, and editing a rule re-emits the complete baseline so the model never works from a superseded rule.

#### Token effect

Bounded by two independent budgets: the native chain keeps its `maxBytes`, and the rules segment keeps `rules.maxBytes`. The renderer omits broader files before truncating the most specific one, so no configuration drops a rule silently.

#### KV Cache effect

The baseline lands once, before the first request, so it extends the reusable prefix. A rule edit emits a replacement baseline and invalidates reuse from that point, which is why the rules budget is deliberately small.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits describe current behavior.

- **Rules are always on** — there is no per-file scope, glob, or activation flag; a rule that applies only in some situations has to say so in its own text.
- **Deduplication is by content, not intent** — two rules that say the same thing in different words are both delivered; only trimmed-equal content collapses.
- **The native loader is reused, not copied** — its entry exports the internals this plugin composes, which keeps the two implementations from drifting but ties this package to that export list.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: open questions and directions that are not decided. Shipped behavior and accepted rationale live in the sections above and in the package code.

- **A rules edit re-emits the whole baseline; a per-file delta would need a scope model for rules first.**

</details>
