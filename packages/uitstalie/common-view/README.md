---
description: "The branch's overlay framework for native Web views: one adopted view at a time, contributed through slots, theme tokens, and component-local custom properties."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-common-view

English | [中文](README.zh.md)

## Summary

`dsh-client-common-view` is the branch's overlay framework for native Web views: it adopts **one view at a time** and contributes that view's overlay through the seams the harness already has — slot registrations (grouping and replacement), theme tokens, and component-local custom properties set inline. It borrows Android's shape: `ui-primitives` plus slot declarations are the framework's view templates, and slot shadowing is the `OverlayManagerService`, where a registration with a lower `priority` wins the cell and withdrawing it restores the native occupant.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### The adopted view

The package adopts the session row's action list (`sidebar.workspaces.session.row.action`, declared by `ui-workspace`). Its two contributions are independent switches on the plugin's row config:

| Config field | Default | Effect |
|---|---|---|
| `sessionRowAction` | `true` | Inserts the overlay's marker into the row's action list, between the native `archive` (`order` 100) and `pin` (`order` 200) items. |
| `takeoverArchive` | `false` | Registers the same cell the native `archive` item occupies at `priority: -1`, so the overlay's component renders while the native registration stays live for an instant rollback. |
| `accent` | `var(--dsw-alias-state-business-primary)` | The color both contributions paint with. It travels into component CSS as the `--dsh-common-view-accent` custom property set inline on the element, never as a literal color in a stylesheet. |
| `unitGap` | `4px` | Gap between the layout units' children. |
| `unitAlign` | `center` (`stretch` for a column) | Cross-axis placement inside the layout units. |
| `unitJustify` | `start` | Along-axis distribution inside the layout units. |

Geometry belongs to the composition layer: the view is composed from layout units (`Row`, `Column`) whose spec is resolved once and emitted back as native output — a box class from the unit's own CSS module plus component-local custom properties and inline axes. Nothing foreign reaches the DOM, and every leaf is a shared control.

Because a row that declares no `config` hands the browser half `undefined`, the browser half resolves what it receives through `resolveCommonViewConfig`; both halves read the same defaults from `src/config.ts`.

<a id="model-experience"></a>
## Model Experience

None, as the framework registers browser-side view contributions only; it adds no tool, no prompt section, and no context content.

#### KV Cache effect

None: the overlay changes no model input.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Resource overlay needs a registration at or above the element that reads the property.** Custom properties inherit, so a contribution inside a view can paint only itself; overriding a row's or a list's own resource requires a cell at that level, which the adopted view does not expose today.
- **React props have no external channel.** A view's props are chosen by whatever renders it, so changing them means occupying the seat that renders it.
- **Build-hashed class names are not a selector.** The overlay therefore uses tokens, custom properties, and the few stable `data-*` hooks, never a stylesheet rule keyed on a component class.
- **One declarer per slot.** The framework can occupy declared cells; adding a new position inside another package's component still requires that package to declare one.
- **The takeover contribution is a sample.** It exists to exercise the shadowing path end to end; a real adopted view answers to a concrete requirement.

-----

<a id="dev-note"></a>
### Dev Note

The design, the Android mapping, the per-view method (one adapter module per view with its structure and resource inventory), and the slice plan live with the branch's design notes, as do the mission and the first view's study; each is named in the mission record rather than linked from this public README.
