---
description: "The identity proposal queue's browser surface: a settings section that lists queued identity proposals with their evidence, and accepts or rejects them through remote.personality."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-personality

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-personality` is the personality provider's settings page. It lists the identity proposals the model or a person queued in `PERSONALITY.proposals.jsonl`, shows each proposal's name, text, evidence, queue time and status, and accepts or rejects a pending one. It owns no profile data and no proposal storage: reads and decisions cross the `remote.personality` namespace, and the host writes an accepted identity entry through the same version-guarded profile write the `/personality accept` command uses. A rejected proposal only records its status.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)


## Use this package

Mount the row in the same web-app layer that mounts the `personality` provider. The page then appears in settings as the Personality section, and the capability list's Personality link opens it through the provider's `settings.sectionId`.

```yaml
- id: ui-personality
  name: '@deepseek-ai/dsh-client-ui-personality'
```

Accepting writes the identity entry into the global `PERSONALITY.md` and the proposal moves to `accepted`; rejecting records `rejected` and leaves the profile unchanged. The same decisions are available as `/personality proposals`, `/personality accept <id>` and `/personality reject <id>`, so a headless session never needs this page.


## Understand the implementation

`src/client/index.ts` mounts the generated `remote.personality` contribution unless the carrier already provides the namespace, registers the `settings.personality` copy dictionary, and contributes the section at order 210 (after the capability list and the Jira page). It unwraps each `RemoteResult` and throws the host failure so the page can show one in-place alert; it never retries a decision on its own.

`src/client/PersonalitySection.tsx` is presentation only. It reads the queue once on mount, renders pending proposals first with a status badge and the evidence line, swaps a decided row for the value the host returned, and disables that row's buttons while its decision is in flight. Every sentence comes from the `settings.personality` dictionary.

The host side lives in `@deepseek-ai/dsh-personality`: `src/proposals.ts` owns the JSONL queue and its version-guarded writes, and `src/remote.ts` exposes `list`, `accept` and `reject` over `remote.personality`. A settings-page decision records its session as `settings-ui` in the profile history; acceptance still runs `confirmIdentity`, which no other path can set.


## Model Experience

### No model surface

#### What the model sees

Nothing. The page is a settings surface; its only own contributions are the `settings.personality` copy dictionary and the `remote.personality` queue it reads, so it registers no tool, prompt section, context source, or session message. The `personality_propose` tool that fills the queue belongs to the provider and reaches agents through the organizer.

#### Token effect

Zero. The page changes only the profile file, and that profile is the provider's own prompt section, which changes for assemblies after the accepted write.

#### KV Cache effect

No direct effect. Accepting an identity entry changes the provider's system-prompt section, so the next assembly's prefix changes from that section onward; an existing agent's built prompt is not rewritten.


## Known Limitations and Deferred Work

- **The page reads once per visit** — a proposal queued while the page is open appears after reopening the section; there is no live subscription on the queue.
- **Acceptance is synchronous with the click** — the page waits for the host's profile write; a slow or failed write shows the alert and keeps the row pending.
- **No editing before acceptance** — a proposal's name and text are fixed when queued; the reject-then-repropose path is the only way to change them here.
- **Global only** — identity entries live in the global profile; the page never reads or writes the workspace overlay.


### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: open questions and directions that are not decided. Shipped behavior and accepted rationale live in the sections above and in the package code.

- **Whether the page should subscribe to queue changes** — a live refresh would need a host push or a poll; neither exists for a file-backed queue today.

</details>
