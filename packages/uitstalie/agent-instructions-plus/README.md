---
description: "The always-on agent-context seam: appends registered sources (workspace rules today) to the native instruction baseline, for users and maintainers sizing or debugging what reaches the model."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-instructions-plus

English | [中文](README.zh.md)

## Summary

`dsh-agent-instructions-plus` is the branch's always-on agent-context seam. It does not replace the native instruction loader: the native row keeps producing the baseline chain, and this package appends the registered context sources to that same durable message. The built-in source is every Markdown file under `<projectRoot>/.dsh/rules`; memory, personality, and similar project context can register later through the same seam. Skills keep their own injection and are not routed here.

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

The native chain — `$DSH_HOME/AGENTS.md` plus the project chain of `AGENTS.md`, `CLAUDE.md`, and their local overlays — is delivered exactly as before, by its own row. This package appends the workspace rules: every `.md` file under `.dsh/rules`, nested directories included, in path order, as `Instructions from: .dsh/rules/<name>` sections of the same message.

### Configuration

The native loader keeps its own row and schema; this package configures only the sources it contributes.

```yaml
- id: agent-instructions-plus
  name: '@deepseek-ai/dsh-agent-instructions-plus'
  config:
    rules:
      maxBytes: 16384
```

Other plugins add sources through the registry the plugin provides:

```ts
ctx.agentContextSources.register({
  name: 'memory',
  async render({ agent, fileSystem, projectRoot, signal }) {
    return { text: '…', digest: '…' }
  },
})
```

Sources render in registration order and join the same baseline message; a source is disposed with the plugin that registered it.

### Authoring rules

A rule is plain Markdown with no front-matter and no activation metadata: every file is always on, and a file whose content repeats another's after trimming collapses to the first one in path order. That keeps the set easy to reason about — there is no per-file scope to get wrong — which is also why a duplicate is worth deleting rather than renaming.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin is mounted at the profile level, so its `agent/pre-step` listener registers before any Agent exists and wraps the native loader's listener: the waterfall reaches the native loader through `next()`, and the joined source segment is appended to whichever channel the native loader used for its baseline — the batch it returned, or the pending inbox it keeps when the batch owns no step. The native rendering is reused verbatim, so the AGENTS portion stays byte-identical to a native-only composition; a source-set change the native chain does not react to emits a replacement baseline of its own. Each contribution carries its own digest, and the combined digest detects any add, remove, or edit.

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
- **The seam carries always-on context only** — skills and per-turn reminders keep their own injection points; this registry is for project context that must be present from the first request.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: open questions and directions that are not decided. Shipped behavior and accepted rationale live in the sections above and in the package code.

- **A rules edit re-emits the whole baseline; a per-file delta would need a scope model for rules first.**

</details>
