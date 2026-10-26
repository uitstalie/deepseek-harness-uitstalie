---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-26-memory-message-sources

English | [中文](2026-10-26-memory-message-sources.zh.md)

## Summary

Adds an additive 'memory' producer to the shared message-source union: a 'snapshot' form carrying one named section, and a 'notice' form carrying a one-line summary plus, on a tier checkpoint, the replaced turn window. The memory capability emits that source on the user messages it appends after a memory write, a summarization failure, or a turn-tier checkpoint. The roots event:user/message, event:developer/message, event:agent/inbox/spliced (inserted messages), and event:session/title-llm-request (messages) all embed the same union, so each root digest changes although no other structure differs. No existing variant, field, or SESSION_FORMAT_VERSION changes, so the record stays same-version.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-26-memory-message-sources
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-user-rpc-principal"
    after: "507c4f9f9af76c4e9b724c142bb285f6833f9783e864807eedaa444f2d87fdc2"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "b44ccc9e12edc15d3f356781c1386fd987733ffceb0706a26928ce4d4de16807"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-user-rpc-principal"
    after: "eb033515eef2beaf56a5d6f2d4d610afed1f574653350fae5c77616f414047b7"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "988d4337942842ccadf5b7527ca0bf79737ec5b7ae0a522593e2b21437442e97"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Both directions preserve meaning. Old logs stay readable because the two variants are additions: no existing source variant was removed, narrowed, or rewritten, and a log without a memory source means exactly what it meant before. Older readers that meet a memory source keep the record: the source slot's recorded policy uses 'kind' as its discriminator and declares unknownKinds 'preserve'; V4 message admission requires only a nonempty producer-owned kind and refuses only the retired 'plugin' wrapper, so it retains 'memory' verbatim; the Chat and Trajectory projections render an unknown producer as injected context labeled by its durable kind and never reinterpret it as the human 'user' source; and model request serialization reads message role and content, not a user source. New readers of old logs keep the previous behavior when the variant is absent, and the presence of a memory source adds no validation, replay, or authority requirement: its text is ordinary model-visible content and the memory provider rebuilds its own state by scanning the surface, so a reader without the capability simply shows one injected message. Writers emit the variant only on user messages produced by the memory capability; developer messages currently carry the 'tool-registry' source and title requests carry 'dsh-session-title-llm', and nothing else about those roots changed.

<a id="verification"></a>
## Verification

pnpm --silent run verify-persistence-changes --json: reported exactly these four roots as union-variants-changed requiring compatibility review, and no other root. pnpm exec vitest run packages/uitstalie/memory/tests/snapshot.spec.ts packages/uitstalie/memory/tests/checkpoint.spec.ts packages/uitstalie/memory/tests/read.spec.ts: 3 files and 22 tests passed. pnpm exec vitest run packages/session/session-format-v3-to-v4/tests/message-sources.spec.ts packages/session/session-persistence-jsonl/tests/native-source-admission.spec.ts: 2 files and 42 tests passed, including retaining an unknown direct source kind through migration and native restore while rejecting only malformed or retired kinds. pnpm exec vitest run packages/session/session-format-v3-to-v4/tests/sources.spec.ts: 29 tests passed. pnpm exec vitest run packages/session/session-title-llm/tests/llm.spec.ts: 17 tests passed. pnpm exec vitest run packages/client/ui-trajectory/tests/event-projection.client.spec.ts: 5 tests passed, including an unknown producer rendered under its durable kind.

<a id="dev-note"></a>
## Dev Note

None.
