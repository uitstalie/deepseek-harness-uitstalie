---
description: "The Web sidebar rules button for users reading a workspace's .dsh rules, and for maintainers wiring the workspace-row action seat."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-tool-dsh-store

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-tool-dsh-store` adds one button to every Workspace row in the Web sidebar, to the right of that row's new-session button. The button opens a read-only panel over the workspace's `.dsh` rules: the rule files the instruction loader injects, each one readable in place. It rides the store's Remote namespace (`remote.dshStore`), so the list is the Host's own loaded set and the panel cannot write anything.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Where the button appears

The plugin occupies `sidebar.workspaces.row.action`, a list seat that the Workspace row renders inside its action group after the new-session button. The seat's owner share carries the workspace identity and its label, so the occupant needs no lookup of its own; the ungrouped bucket shows no Workspace and renders no occupant.

### What the panel shows

Opening the button lists every retained rule as a path with its byte size, and selecting one reads that rule's text below the list. The list is the instruction loader's own retained set — same scan, same cross-file content deduplication — so the panel shows exactly the rules that reach the model, and an empty workspace says so instead of failing.

### Data and failures

The panel reads through `remote.dshStore.listRules` and `readRule`, which the plugin mounts itself in `apply` before waiting for them in an inner scope. A Remote call resolves to a discriminated result, so a refused workspace or an unreadable rule arrives as copy in the panel rather than as an exception. Nothing in this package writes, and the Host checks the workspace identity against its own registry.

-----

<a id="model-experience"></a>
## Model Experience

None, as the browser sidebar panel only reads rules through the store's Remote namespace; it contributes no request content and writes nothing.

#### KV Cache effect

None: the panel changes no model input.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits describe the panel's current scope.

- **Reading only** — the button shows rules; creating, editing, and deleting them happens through the model-facing store tool.
- **No live refresh** — the list loads when the panel opens; a rule created during the same session appears after reopening the panel.
- **Flat list** — rule paths are listed without grouping by their directories, which is enough while `.dsh/rules` stays shallow.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: open questions and directions that are not decided. Shipped behavior and accepted rationale live in the sections above and in the package code.

- **Mounting route** — the package is currently mounted through the local profile patch, like the other branch-owned client plugins, rather than through the shipped Web bundle.

</details>
