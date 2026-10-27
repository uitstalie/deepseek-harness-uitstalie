---
description: "The memory capability's browser surface: a settings section that edits the volatile window, budget and summary-model fields of the memory row."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-memory

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-memory` is the memory provider's settings page. It edits the volatile fields of the `memory` row — the detail, brief and forget turn ages, the sessions kept in `MEMORY.md`, the body budget, and the summary provider and model — and saves them as one revision-fenced mutation. It owns no memory data and no tools: the host provider applies a saved value on its next write or summary pass.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>

## Use this package

Mount the row in the same web-app layer that mounts the `memory` provider. The page then appears in settings as the Memory section, and the capability list's Memory link opens it through the provider's `settings.sectionId`.

```yaml
- id: ui-memory
  name: '@deepseek-ai/dsh-client-ui-memory'
```

An empty field clears the profile override and falls back to the schema default; the save button stays disabled while a numeric field is not a positive whole number.

<a id="understand-the-implementation"></a>

## Understand the implementation

`src/client/index.ts` registers the `settings.memory` copy dictionary and contributes the section at order 190. It reads the shared configuration form of the `memory` row from the optional `configForms` service, so a deployment without settings renders the unusable notice instead of dead controls.

`src/client/settings.ts` seeds a text draft from the accepted snapshot, marks the fields whose number does not parse, and writes only the changed fields through one `mutate` call fenced by the snapshot revision. `src/client/MemorySection.tsx` is presentation only: it renders the fields, the inline validation, and the save and discard actions, with every sentence coming from the dictionary.

<a id="model-experience"></a>

## Model Experience

None, as nothing here reaches a model: the page only edits the memory row's volatile fields, and the provider owns every prompt section, tool schema, and memory write.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No memory content editing** — the page edits the provider's configuration only; `MEMORY.md` entries are written by the tools and the summary job.
- **The form follows the settings service** — when the composition omits `configForms`, the section renders the unavailable notice and offers no controls.
