---
description: "Host-side capability organizer: registry, enable gate, per-agent wiring, completed-turn dispatch, failure isolation, and disposal for capability providers."
kind: "package-reference"
---

# @deepseek-ai/dsh-dafeiyu

English | [中文](README.zh.md)

## Summary

`dafeiyu` is the host-side organizer for optional capabilities such as memory and personality. It owns the capability registry, the enable gate, per-agent wiring, completed-turn dispatch, failure isolation, and disposal, so a provider only declares what it contributes. Providers do not subscribe to lifecycle events, register tools, or edit the system prompt themselves; the organizer performs those steps at one place with one decision for child agents and cancelled turns.

It provides `ctx.dafeiyu` and has no model surface. The v1 composition mounts it in the `web-app` branch layer before provider rows; providers declare `inject: ['dafeiyu']`.

## Use this package

Configure the organizer's gate in the same profile patch that mounts it:

```yaml
- id: dafeiyu
  name: '@deepseek-ai/dsh-dafeiyu'
  config:
    capabilities:
      memory: { enabled: true }
      personality: { enabled: false }
```

An id absent from `capabilities` is enabled. The gate is the organizer's runtime switch, not a way to unload a package: turning off a provider's Loader row removes the provider entirely and makes `status()` report that id as `missing`; turning off the organizer gate keeps the provider loaded but never calls its `create()`. The skeleton reads the gate when the provider registers, so a gate change takes effect on the next profile start.

A provider registers from its own `apply()` and keeps the returned disposer as an effect:

```ts
const off = ctx.dafeiyu.register({
  id: 'memory',
  contractVersion: 1,
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

`register()` rejects a duplicate id and a `contractVersion` other than `1` with an error naming the capability. The service exposes two methods: `register(provider)` returns the disposer that removes the registration and its contributions, and `status()` returns one `CapabilityStatus` for every registered provider followed by configured ids that have no provider. `status()` is a synchronous snapshot; it never re-runs `create()` or reads the filesystem.

| Gate layer | Source | When closed |
|---|---|---|
| Loader row | profile patch / plugin switch | The provider does not exist; `status()` reports `missing` |
| Organizer gate | `config.capabilities.<id>.enabled` | The provider exists, but `create()` is never called and the capability stays `disabled` |
| Provider config | the provider's own Loader row | Interpreted only by the provider; the organizer never reads it |

## Understand the implementation

`src/index.ts` is the `Dafeiyu` service; `src/types.ts` holds the provider, contribution, turn, and status types. The service retains one registration record per provider, containing the provider declaration, the resolved gate, an `AbortController`, the cached contribution, the last failure summary, and the per-agent disposers.

The registry validates and stores providers in registration order. `create()` runs once for an enabled registration as soon as `register()` is called; while a returned promise is unsettled, the registration has no contribution, `agent/created` waits for it, and `status()` reports `disabled`. When `create()` resolves, the registration becomes `active`; when it rejects, the record keeps a one-line failure summary and becomes `failed` with no automatic retry.

On `agent/created`, the organizer awaits every registration that is still settling and then wires each active capability whose scope matches the agent. `scope: 'root'` skips a child agent, detected through the live agent registry (`ctx.agents.roots()`) because the runtime `Agent` handle does not expose a parent field. Tools are registered with `agent.ctx.tools.register`, prompt sections with `agent.ctx.systemPrompt.section`, and their disposers are retained; `onAgentCreated` runs last. A provider failure during wiring rolls back that capability's additions for this agent and marks the capability failed without touching other capabilities.

On `session/event` of `turn/end` with `reason.kind === 'completed'`, the organizer resolves the live agent with `ctx.agents.get(session.id)`, applies the same scope filter, and calls each `onTurnEnd` serially within the session; different sessions dispatch in parallel. Aborted, errored, blocked, max-token, interrupted, and forked turns are skipped. Every hook failure is caught, summarized, and recorded as `failed`, and later capabilities still run.

Disposal disposes each contribution first, then runs the retained agent-level disposers, then clears the registry. The same tear-down runs when a single `register()` disposer is called; in both cases the registration's `AbortController` is aborted first so in-flight `create()` and hook work can stop.

## Model Experience

### No model surface in v1

#### What the model sees

Nothing direct. The organizer registers no tool, prompt section, context source, or session message; contributions appear only when a provider supplies them through `tools` or `promptSections`, and that provider owns their text and schemas.

#### Token effect

Zero direct token effect. A wired capability adds only what its own provider declares; the organizer adds no wrapper text, schema, or message of its own.

#### KV Cache effect

No effect of its own. The provider that contributes a stable prompt section or tool schema owns the resulting prefix behavior, and the organizer never rewrites an existing contribution.

## Known Limitations and Deferred Work

- **No settings surface or command** — v1 exposes `status()` only; the configuration lives in the profile patch, and `/capabilities` is deferred until the settings page lands.
- **No config-reload handling yet** — the skeleton has no `app-boot/config-reload` listener, so changing `capabilities` requires restarting the profile; the design's dispose-then-recreate reload is deferred to the settings step.
- **A settling registration reports `disabled`** — the four-state status contract has no pending value, so a registration whose `create()` promise has not settled reports `enabled: true` with `state: 'disabled'` until it becomes `active` or `failed`.
- **No retroactive wiring** — the organizer listens to `agent/created` only; agents that already exist when a capability registers do not receive its contributions.
- **Shared names fail the later capability** — two capabilities that register the same tool or prompt-section name are not arbitrated; the later registration throws, that capability becomes `failed`, and the earlier one stays.
- **Disposal is synchronous by contract** — `CapabilityContribution.dispose` returns `void`; a provider that returns a promise has its rejection logged, but no caller waits for it.
