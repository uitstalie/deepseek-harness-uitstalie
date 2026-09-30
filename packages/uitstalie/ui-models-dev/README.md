---
description: "The models.dev settings section for users picking catalog providers and turning them into llm-plus routes."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-models-dev

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-models-dev` adds one section to the Web settings: it lists the providers in the models.dev catalog, lets you pick the ones you want and edit their route details, and writes the result as `llm-plus` routes. The catalog itself is fetched and cached by `dsh-models-dev`; this package is the browser surface over it, so the section works whenever that host service and the adapter are mounted.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Where it appears

The section registers into the settings surface and shows the catalog as provider cards: each card names the provider, its protocol family, endpoint, credential variable names, and model count. A search field narrows the list, and a provider with no catalog entry can still be added by hand.

### What you can do

Selecting a provider opens a draft form for the route and its models: choose the models to expose, adjust the endpoint or protocol, and mark which fields the catalog supplied. Saving materializes the pick as a route the adapter registers, and the section then lists it under your own routes, where it can be edited again or removed.

### OAuth providers

A provider that needs an interactive login shows an authorization panel instead of a plain key field: the section starts the flow, shows the pending state, and reports the result, so a login that fails is visible rather than silently breaking later requests.

-----

<a id="model-experience"></a>
## Model Experience

None, as the browser settings section only edits catalog-backed routes; the host services that register and serve them own every model-visible effect.

#### KV Cache effect

None: the section contributes no request content.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits describe the section's current scope.

- **Settings surface only** — it lists and edits routes; it does not test a route or send a probe request.
- **Catalog-driven list** — without a mounted catalog service the list is empty, and only manual entry remains.
- **Route shape follows the adapter** — the form edits exactly the fields `dsh-llm-plus` accepts, so a new adapter field needs a matching form field here.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: open questions and directions that are not decided. Shipped behavior and accepted rationale live in the sections above and in the package code.

- **A route can be edited but not probed; a test-connection action needs a host-side call that does not exist yet.**

</details>
