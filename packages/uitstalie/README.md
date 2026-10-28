---
description: "The uitstalie package group: branch-owned capabilities and plugins — instruction sources, the .dsh store, the multi-protocol LLM adapter and catalog, memory, personality, and their Web surfaces — for readers navigating the family."
kind: "package-group"
---

# uitstalie/ — branch-owned capability family

English | [中文](README.zh.md)

## Summary

`uitstalie` is the branch-owned package group: capabilities and plugins this branch adds to the upstream harness, not upstream product packages. The host side contributes an always-on instruction source, the `.dsh` store service and its model tool, a self-owned multi-protocol LLM adapter with the models.dev catalog, and an organizer that wires memory and personality onto root agents. The client side adds the common-view overlay framework, the models.dev settings section, and a sidebar rules panel. Each package README owns its contract; the design records live under [goal/](../../goal/).

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Each row names the package's contribution and the `ctx` key or surface it attaches to.

| Package | Role | ctx key or surface |
|---|---|---|
| [`agent-instructions-plus`](agent-instructions-plus/README.md) | Appends registered always-on context sources, starting with `.dsh/rules`, to the native instruction baseline | `ctx.agentContextSources` |
| [`common-view`](common-view/README.md) | Overlay framework that adopts one native Web view and contributes slots, theme tokens, and element-local custom properties | client slots and theme tokens |
| [`dafeiyu`](dafeiyu/README.md) | Capability organizer: registry, enable gate, per-agent wiring, turn dispatch, and failure isolation | `ctx.dafeiyu` |
| [`home-backup`](home-backup/README.md) | Scheduled snapshots of sessions, storages, and profile configuration outside `$DSH_HOME`, with a retention window | host timers; no `ctx` key |
| [`llm-plus`](llm-plus/README.md) | Self-owned multi-protocol LLM adapter with OAuth flows and live-configured routes | registers on `ctx.llm` |
| [`memory`](memory/README.md) | Memory capability provider: fixed prompt section, snapshot, turn-summary job, and the `memory_*` tools | registers on `ctx.dafeiyu` |
| [`models-dev`](models-dev/README.md) | models.dev catalog service: startup fetch, disk-cache fallback, route defaults, and extra request params | `ctx.modelsDev` |
| [`personality`](personality/README.md) | Personality capability provider: global profile with workspace overlay, `personality_learn`, and `/personality` review | registers on `ctx.dafeiyu` |
| [`persona-card`](persona-card/README.md) | Role-play character card format: pure `persona/v1` validator/renderer and a safe Character Card V2/V3 JSON importer (not the deployment persona preset) | no `ctx` key |
| [`store-atom`](store-atom/README.md) | `.dsh` store atom: the `dshStore` base interface with project-root discovery, path confinement, namespace authoring checks, workspace rules discovery, and version-guarded reads and writes | `ctx.dshStore` |
| [`system-environment`](system-environment/README.md) | Host environment atom: platform facts, path spelling and comparison, environment lookup, and the user and Harness home directories | `ctx.systemEnvironment` |
| [`tool-dsh-store`](tool-dsh-store/README.md) | Model-facing store tool and the read-only rules Remote over the store atom | `ctx.dshStore` consumer |
| [`ui-dafeiyu`](ui-dafeiyu/README.md) | Capabilities settings section that lists the organizer's providers, switches their gate, and links each provider page | settings section |
| [`ui-memory`](ui-memory/README.md) | Memory settings section that edits the provider's volatile window, retention, budget and summary-model fields | settings section |
| [`ui-models-dev`](ui-models-dev/README.md) | Web settings section that browses the catalog and materializes chosen providers as `llm-plus` routes | settings section |
| [`ui-tool-dsh-store`](ui-tool-dsh-store/README.md) | Web sidebar button that lists and reads a workspace's `.dsh/rules` | workspace row menu |

-----

<a id="related-documentation"></a>
## Related documentation

- [Memory capability design](../../goal/memory.md) — the forgetting window, `.dsh/memory` storage, summary tiers, and tools behind `dsh-memory`.
- [Role-play persona card design](../../goal/persona.md) — the assistant-side card format, safe CCv2/V3 import and the boundary against deployment personas.
- [Personality profile design](../../goal/personality.md) — the global profile, workspace overlay, learning signals, and drift review behind `dsh-personality`.
- [Capability organizer design](../../goal/dafeiyu.md) — the registry, enable gate, and wiring contract `dafeiyu` defines for its providers.
- [Rules and instruction sources](../../goal/rules.md) — how `.dsh/rules` reaches the model through the instruction seam.
- [.dsh directory plugin design](../../goal/dsh-dir-plugin.md) — the store interface, namespace checks, and model tool behind `dsh-tool-dsh-store`.
- [LLM streaming subsystem](../../docs/subsystems/llm-streaming.md) — the message, request, and stream-chunk contract `llm-plus` implements and `models-dev` resolves routes for.
- [System-prompt subsystem](../../docs/subsystems/system-prompt.md) — the section and source assembly `agent-instructions-plus`, `memory`, and `personality` contribute to.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The group is mounted only by the branch patch layers (`packages/bundle/base/cordis.patch.uitstalie.yml` and `packages/bundle/web-app/cordis.patch.uitstalie.yml`). The packages are not published, so their APIs carry no upstream compatibility promise.

</details>
