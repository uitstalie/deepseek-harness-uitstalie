---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-18-jira-retirement

English | [中文](2026-11-18-jira-retirement.zh.md)

## Summary

The JIRA retirement removes the `jira-agent` attribution kind from user and developer message sources. Historical Session logs that carry it remain readable as text; no event envelope or Session header version changes.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-18-jira-retirement
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-18-remove-critical-event-marker"
    after: "2148e56dbc9e6af522a7f5a4f07405efad7d676d1bb12a02ddb2b6084e5ee643"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-18-remove-critical-event-marker"
    after: "93b0316fa036f88759ac2dd4b0c0f8a4b66aac5c72fd7e3b5689ed0782d475b0"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-18-remove-critical-event-marker"
    after: "4a9f833141f52370b14def53650376c4ddb5f9f42cd8d2f0ff012d02deb71d69"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-18-remove-critical-event-marker"
    after: "3daa71f0b8c8540fac0c3dddb065f85133ddcbe32c922cd189f5934c3b5b3da1"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Older readers still recognize the `jira-agent` kind and preserve the recorded text and metadata. A new reader without the declaration treats the unknown source metadata as opaque and still preserves the message body, which is what the removed producer promised. No replay, validation, or authority behavior depended on the kind, so the same Session version is safe in both directions.

<a id="verification"></a>
## Verification

`pnpm run verify-persistence-changes` after the record, `pnpm run typecheck`, `pnpm run doc-sync`, and the workspace, role-visibility, personality, memory, and test-support suites.

<a id="dev-note"></a>
## Dev Note

None.
