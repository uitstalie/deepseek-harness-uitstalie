---
description: "Host-side capability organizer: registry, live enable gate, capability-list metadata, completed-turn dispatch, failure isolation, and the read-only status Remote for capability providers."
kind: "package-reference"
---

# @deepseek-ai/dsh-dafeiyu

English | [中文](README.zh.md)

## Summary

`dafeiyu` is the host-side organizer for optional capabilities such as memory, personality, and jira. It owns the capability registry, the live enable gate, per-agent wiring, completed-turn dispatch, failure isolation, disposal, and the read-only `remote.dafeiyu` status face, so a provider only declares what it contributes. Providers do not subscribe to lifecycle events, register tools, or edit the system prompt themselves; the organizer performs those steps at one place with one decision for child agents and cancelled turns.

It provides `ctx.dafeiyu` and has no model surface. The branch composition mounts it in the `web-app` layer before provider rows; providers declare `inject: ['dafeiyu']`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Use this package

Configure the organizer's gate in the same profile patch that mounts it:

```yaml
- id: dafeiyu
  name: '@deepseek-ai/dsh-dafeiyu'
  config:
    capabilities:
      memory: { enabled: true }
      personality: { enabled: false }
      jira: { enabled: true }
```

An id absent from `capabilities` follows the provider's own default: `enabledByDefault` from a v2 descriptor, and `true` for every v1 provider. The gate is the organizer's runtime switch, not a way to unload a package: turning off a provider's Loader row removes the provider entirely and makes `status()` report that id as `missing`; closing the organizer gate keeps the provider loaded but disposes its contribution and stops wiring new agents.

`capabilities` is a volatile configuration reference: a settings write to `capabilities.<id>.enabled` swaps the snapshot and the Loader emits `loader/volatile-update`, so the organizer tears the capability down or calls `create()` again without remounting any plugin row. A completed profile reload emits `app-boot/config-reload`; the organizer then disposes every contribution, calls `create()` again for each open gate, and re-wires the agents it had already wired, with no per-capability diff — the reload may have changed any provider's configuration.

A v2 provider registers its contribution together with the metadata the capability list renders:

```text
const off = ctx.dafeiyu.register({
  id: 'memory',
  contractVersion: 2,
  label: 'Memory',
  description: 'Session summaries, searchable history, and tiered forgetting',
  enabledByDefault: true,
  settings: { sectionId: 'memory', order: 180 },
  config: resolvedProviderConfig,
  async create(runtime) {
    return {
      scope: 'root',
      tools: agent => memoryTools(runtime.ctx, agent),
      promptSections: () => [MEMORY_PROMPT_SECTION],
      onTurnEnd: input => queueMemoryJob(runtime.ctx, input),
      dispose: () => releaseProviderResources(),
    }
  },
})
```

`label` and `description` are required by contract version 2 and carry the list copy; `enabledByDefault` and `settings` are optional, and `settings.sectionId` names the provider's own settings page. A v1 descriptor keeps working with no UI metadata; the capability list then shows its id and state only.

`register()` rejects a duplicate id, a `contractVersion` other than `1` or `2`, and a v2 descriptor without a label or description, each with an error naming the capability. The service exposes two methods: `register(provider)` returns the disposer that removes the registration and its contributions, and `status()` returns one `CapabilityStatus` for every registered provider followed by configured ids that have no provider. `status()` is a synchronous snapshot; it never re-runs `create()` or reads the filesystem.

Upgrading a provider from contract version 1 to 2 is additive: `create()`, the contribution hooks, and the registration lifecycle stay exactly as they were; the descriptor gains `label` and `description`, and optionally `enabledByDefault` and `settings`. Both versions register side by side — the v1 provider keeps working and the capability list shows its id and state only — so the versions can move one provider at a time. Raising the declared version above 2 is different: the organizer rejects it by name until it lists that version, so an incompatible contract bump needs a new organizer first.

The browser reads the same snapshot through the read-only Remote namespace:

```text
const statuses = await ctx.remote.dafeiyu.status()
```

| Gate layer | Source | When closed |
|---|---|---|
| Loader row | profile patch / plugin switch | The provider does not exist; `status()` reports `missing` |
| Organizer gate | `config.capabilities.<id>.enabled` (volatile) | The provider exists, but its contribution is disposed and no new agent receives it; `status()` reports `disabled` |
| Provider config | the provider's own Loader row | Interpreted only by the provider; the organizer never reads it |

## Understand the implementation

`src/index.ts` is the `Dafeiyu` service, `src/types.ts` holds the provider, contribution, turn, and status types, and `src/remote.ts` is the read-only Remote face. The service retains one registration record per provider, containing the provider declaration, the resolved gate, an `AbortController`, the cached contribution, the last failure summary, the last turn timestamp, and the per-agent disposers.

The registry validates and stores providers in registration order. `create()` runs once for an enabled registration as soon as `register()` is called; while a returned promise is unsettled, the registration has no contribution, `agent/created` waits for it, and `status()` reports `disabled`. When `create()` resolves, the registration becomes `active`; when it rejects, the record keeps a one-line failure summary and becomes `failed` with no automatic retry.

On `loader/volatile-update` the organizer re-reads the gate for every registration and reconciles only the ids whose value changed: closing a gate stops admission synchronously (state, generation bump, abort, ready settlement), waits for the turn hook it already admitted, then disposes its contribution and revokes the tools and prompt sections it had added to agents; opening it installs a fresh controller and calls `create()` again. Other capabilities keep their contributions and their agents. Enabling a capability after agents exist does not retroactively wire those agents — only agents created afterwards receive the contribution.

Every activation owns a generation, its controller and its ready resolver. A `create()` that settles under an older generation only disposes the contribution it created: it cannot publish over the newer activation, and its rejection cannot mark the newer generation failed. Gate toggles, reloads and retirement are serialized per registration, so two lifecycle steps cannot interleave.

On `agent/created`, the organizer awaits every registration that is still settling and then wires each active capability whose scope matches the agent. `scope: 'root'` skips a child agent, detected through the live agent registry (`ctx.agents.roots()`) because the runtime `Agent` handle does not expose a parent field. Tools are registered with `agent.ctx.tools.register`, prompt sections with `agent.ctx.systemPrompt.section`, and their disposers are retained; `onAgentCreated` runs last. A provider failure during wiring rolls back that capability's additions for this agent and marks the capability failed without touching other capabilities.

On `session/event` of `turn/end` with `reason.kind === 'completed'`, the organizer resolves the live agent with `ctx.agents.get(session.id)`, applies the same scope filter, and calls each `onTurnEnd` serially within the session; different sessions dispatch in parallel. Aborted, errored, blocked, max-token, interrupted, and forked turns are skipped. Every hook failure is caught, summarized, and recorded as `failed`, and later capabilities still run.

Disposal aborts every registration, waits for its admitted turn hooks and settling `create()` calls, then disposes each contribution, runs the retained agent-level disposers, and clears the registry. `register()`'s disposer follows the same path for one registration. A reload aborts and drains the old generation before calling `create()` again, then re-wires the agents that were already wired.

The Remote face mounts beside the service in the same row as `remote.dafeiyu`, publishes exactly one method (`status`), and never writes: the gate is the organizer's own profile configuration, written through the settings namespace of the `dafeiyu` row, not through this face.

## Model Experience

### No model surface

#### What the model sees

Nothing direct. The organizer registers no tool, prompt section, context source, or session message; contributions appear only when a provider supplies them through `tools` or `promptSections`, and that provider owns their text and schemas.

#### Token effect

Zero direct token effect. A wired capability adds only what its own provider declares; the organizer adds no wrapper text, schema, or message of its own.

#### KV Cache effect

No effect of its own. The provider that contributes a stable prompt section or tool schema owns the resulting prefix behavior, and the organizer never rewrites an existing contribution.

## Known Limitations and Deferred Work

- **No settings page in this package** — the browser capability list lives in its own client package and links each v2 provider to its `settings.sectionId`; this package serves only the read-only status behind it.
- **No retroactive wiring on enable** — disabling revokes a capability from agents immediately, but enabling only affects agents created afterwards.
- **A settling registration reports `disabled`** — the four-state status contract has no pending value, so a registration whose `create()` promise has not settled reports `enabled: true` with `state: 'disabled'` until it becomes `active` or `failed`.
- **Missing ids cannot know a provider default** — a configured id with no provider is reported with the gate value from configuration and `state: 'missing'`; there is no descriptor to ask for `enabledByDefault`.
- **Shared names fail the later capability** — two capabilities that register the same tool or prompt-section name are not arbitrated; the later registration throws, that capability becomes `failed`, and the earlier one stays.
- **Disposal is synchronous by contract** — `CapabilityContribution.dispose` returns `void`; a provider that returns a promise has its rejection logged, but no caller waits for it.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: open questions and directions that are not decided. Shipped behavior and accepted rationale live in the sections above and in the package code.

- **Whether a settling registration needs its own status value** — the current four-state contract reports `disabled` while `create()` is unsettled; a `pending` value would be a wire-visible status change and needs a consumer first.

</details>
