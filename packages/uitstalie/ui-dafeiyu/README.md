---
description: "The capability list's browser surface: a settings section that lists every dafeiyu provider with its state, its enable switch, and a link to the provider's own settings page."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-dafeiyu

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-dafeiyu` is the capabilities settings page. It lists every provider registered with the `dafeiyu` organizer, shows the state the organizer reports (`active`, `disabled`, `missing` or `failed`), flips the organizer's enable gate through the `dafeiyu` settings namespace, and links a v2 provider to its own settings section by `settings.sectionId`. It owns no capability data and no provider configuration: status arrives over the read-only `remote.dafeiyu` namespace, and the switch writes the same volatile configuration a profile edit writes.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Use this package

Mount the row in the same web-app layer that mounts `dafeiyu` and the providers; it then appears in settings as the Capabilities section. A consumer does not configure this package — it is the organizer's own list.

```yaml
- id: ui-dafeiyu
  name: '@deepseek-ai/dsh-client-ui-dafeiyu'
```

The switch is the organizer gate: turning a capability off disposes its contribution and revokes its tools from agents immediately; turning it on rebuilds the contribution, and only agents created afterwards receive it. Provider configuration is never edited here: a provider with `settings.sectionId` gets an open-settings button that switches the settings panel to that section, and a provider without one shows no link.

Rows show the descriptor label and description for contract version 2 providers, and fall back to the id for version 1 providers. A configured id whose plugin row is absent is reported as `not loaded` and its switch is disabled.

## Understand the implementation

`src/client/index.ts` mounts the generated `remote.dafeiyu` contribution unless the carrier already provides the namespace, registers the `settings.capabilities` copy dictionary, and contributes the section. The gate form comes from `ctx.configForms.get('dafeiyu')` — the shared config form for the organizer's own entry — so the switch shares the revision fence and conflict recovery of every settings editor.

`src/client/store.ts` owns the page state: one `status()` read publishes the entries, and `setEnabled()` writes `capabilities.<id>.enabled` through that form, then re-reads the status until the host's reconciliation shows the requested value (a closed gate disposes synchronously; an opened one awaits the provider's `create()`). A refused write sets `refused`, a thrown one sets `actionError`, and both render as one alert.

`src/client/CapabilitiesSection.tsx` is presentation only: it renders the state badge, the description, the last failure, the switch and the settings link from the inject face, and every sentence comes from the `settings.capabilities` dictionary.

## Model Experience

### No model surface

#### What the model sees

Nothing. The page is a settings surface; it registers no tool, prompt section, context source, or session message, and it never writes the session. The capability tools and prompt sections it lists belong to the providers and reach agents only through the organizer.

#### Token effect

Zero. The page changes only what a provider's contribution contains, and that content is the provider's own.

#### KV Cache effect

No direct effect. A capability switched off here stops contributing its tools and prompt sections to new agents, which changes the prompt those agents build; an existing agent's built prompt is not rewritten.

## Known Limitations and Deferred Work

- **No provider configuration here** — the jira ledger's root, host and push switch belong to `ui-jira`'s section; this page only links to it.
- **Enabling does not wire running agents** — an enabled capability reaches agents created after the switch, not agents already running.
- **One switch at a time** — the page disables every switch while one write is in flight, so two capabilities cannot race the same revision.
- **A missing provider still shows a switch** — the configured gate can be changed, but the control stays disabled until its plugin row loads.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: open questions and directions that are not decided. Shipped behavior and accepted rationale live in the sections above and in the package code.

- **Whether a failed switch needs a toast** — the alert stays in place until the next action; a transient toast would need a surface shared with the settings shell.

</details>
