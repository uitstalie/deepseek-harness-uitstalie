---
description: "The models.dev catalog service for users and maintainers choosing routes, refreshing provider metadata, or debugging the on-disk cache."
kind: "package-reference"
---

# @deepseek-ai/dsh-models-dev

English | [中文](README.zh.md)

## Summary

`dsh-models-dev` fetches the models.dev catalog once per process, caches it on disk, and serves provider and model metadata to the packages that build LLM routes. It answers synchronous lookups — `getProvider`, `getModel`, `resolveModelDefaults`, and `resolveExtraParams` — plus two Remote methods the Web settings section calls, and it emits `models-dev/updated` whenever it adopts a new catalog. A failed fetch falls back to the cached copy and then to an empty catalog, so a consumer always gets an answer instead of an error.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### What the service provides

Registry values come from the dataset and are advisory: a route resolves to a provider id, then to model metadata, harness-shaped defaults (`contextWindow`, `maxTokens`, modalities, reasoning), and the provider's extra request parameters. The service never mutates caller routing; it answers lookups and reports how the current catalog was obtained.

### Configuration

Only the source and cache knobs are configurable; the defaults suit a normal developer machine.

| Field | Default | Meaning |
|---|---|---|
| `sourceUrl` | the models.dev API endpoint | Catalog source for the network fetch |
| `cachePath` | `$DSH_HOME/cache/models-dev.json` | On-disk copy that survives restarts |
| `cacheTtlMs` | `3600000` | Age after which a fetch is attempted again |
| `timeoutMs` | `10000` | Network timeout for one fetch |
| `routeAliases` | `{ 'deepseek-official': 'deepseek' }` | Route names mapped onto dataset provider ids |
| `extraParams` | `{}` | Per-provider and per-model request parameters supplied by the user |

### Refresh and cache

The first request or the settings section triggers loading; concurrent callers share one in-flight refresh. A successful fetch writes the cache, a failed fetch keeps serving the cached copy, and a failure with no cache serves an empty catalog whose lookups return nothing rather than throwing.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the model routes, defaults, and extra request parameters its catalog resolves for the LLM consumers.

#### KV Cache effect

None directly: the service contributes no request content, and the values it resolves become part of requests the LLM consumers own.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the catalog can be trusted for.

- **Advisory metadata, never policy** — a route or model missing from the dataset still works when configured explicitly; the catalog only fills in what the caller did not state.
- **One source shape** — only the models.dev payload layout is parsed; another registry would need its own parser.
- **No credential handling** — the service reads public metadata and never touches API keys; credential resolution belongs to the credentials seam.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: open questions and directions that are not decided. Shipped behavior and accepted rationale live in the sections above and in the package code.

- **The disk cache is keyed by path only; a second catalog source would need its own cache identity.**

</details>
