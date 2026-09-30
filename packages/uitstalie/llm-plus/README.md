---
description: "The self-owned multi-protocol LLM adapter for users and maintainers configuring routes, credentials, or the Models settings entry."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-plus

English | [中文](README.zh.md)

## Summary

`dsh-llm-plus` is this branch's own LLM adapter. It speaks four provider protocols — OpenAI chat completions, OpenAI responses, Anthropic messages, and Gemini — and registers every route with the `ctx.llm` registry, so a profile can reach providers the shipped adapters do not cover. All routes come from configuration: there are no built-in routes, credentials resolve only through the credentials seam, and a settings edit reaches the running adapter without a restart.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### When to choose it

Choose it when a workspace should talk to a provider through one of the four supported protocol families, including OpenAI-compatible endpoints and Anthropic-style gateways. It does not replace the shipped DeepSeek adapter; both can be mounted, and the model selection decides which route a session uses.

### Routes are configuration

A route names a protocol, a base URL, a model id, and optional per-route fields; the adapter turns each entry into a provider registration. A structurally invalid route fails the mounting fiber instead of silently registering a broken provider, and the profile's `routes` object is the single place a route is edited.

### Credentials come from the seam

The plugin reads no environment variables. It injects `credentials` and asks for the reference each route names, so an environment fallback, a local file, or a remote authorization flow stays a provider concern rather than adapter logic. Providers that need an interactive login register an OAuth flow, and the settings section drives it.

### Live configuration

The route table is a volatile configuration reference. When the Loader commits a read-only change it emits `loader/volatile-update`; the plugin re-resolves the table and atomically replaces its registrations, and the configuration hook rejects a bad candidate before it can be committed.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the provider routes and request fields it registers with `dsh-llm`, which owns request assembly.

#### KV Cache effect

None directly: the adapter forwards assembled requests, and the fields it contributes are part of requests `dsh-llm` owns.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define the adapter's current reach.

- **Four protocol families** — other wire formats need a new protocol module and its request/response mapping.
- **No built-in routes** — a profile that mounts the adapter without routes reaches no provider, by design.
- **Catalog metadata is advisory** — model defaults come from `dsh-models-dev` when it is mounted; without it, only explicitly configured fields apply.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: open questions and directions that are not decided. Shipped behavior and accepted rationale live in the sections above and in the package code.

- **The route form in the settings section and the route schema in this package must move together, and nothing enforces that pairing yet.**

</details>
