---
description: "The Web sidebar rules button for users reading a workspace's .dsh rules, and for maintainers wiring the workspace-row action seat."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-tool-dsh-store

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-tool-dsh-store` adds one button to every Workspace row in the Web sidebar, to the right of that row's new-session button. The button opens the workspace's `.dsh` rules as rows of the shared `Menu`, and reading one rule opens the shared `Modal`, so the surfaces behave like every other row menu and dialog in the app. It rides the store's Remote namespace (`remote.dshStore`), so the list is the Host's own loaded set and the panel cannot write anything.

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

### What the button and dialog show

The button is the trigger's mark only: the checklist of rule paths arrives as shared menu rows, and selecting one opens the shared dialog with that rule's text. The list is the instruction loader's own retained set — same scan, same cross-file content deduplication — so what the menu offers is exactly what reaches the model. A workspace with no rules, or a listing that fails, answers in the same dialog instead of an empty menu.

### Data and failures

The panel reads through `remote.dshStore.listRules` and `readRule`, which the plugin mounts itself in `apply` before waiting for them in an inner scope. A Remote call resolves to a discriminated result, so a refused workspace or an unreadable rule arrives as copy in the dialog rather than as an exception. Nothing in this package writes, and the Host checks the workspace identity against its own registry.

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
