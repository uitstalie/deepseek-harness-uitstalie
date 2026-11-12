---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-12-superagent-notice-source

English | [中文](2026-11-12-superagent-notice-source.zh.md)

## Summary

Adds the jira-agent context-formed user-message source kind used by the superagent workspace-definition notice. The kind is attribution-only: it carries the notice form and a one-line summary, and no existing persisted field changes shape.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-12-superagent-notice-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-09-critical-event-attribution"
    after: "14e2aeb6b9c85cd464a86322e15eff8a9844942e0dc6c2d1bb9a6b44e4cf4675"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-09-critical-event-attribution"
    after: "30284af1b48ef0fd0b5c7fad406a022dd5fb6b320e5f16970fbbdd1424498ba5"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-09-critical-event-attribution"
    after: "4820f1c88a7bd93c9d332db24cb8b4a55d77757dfcaec6a0f1a749f5b50ad744"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-09-critical-event-attribution"
    after: "fb80b645949c6095d7ef524fcc6d08b245fe3a9249ff69a8a3562a79a49139f4"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

A reader without this plugin preserves the recorded message text as an ordinary user message and ignores the source metadata; the notice has no replay, validation or authority effect, so a Session that never held one behaves exactly as before. New readers keep every historical source kind and mixed logs readable, and absence of this kind retains the old behavior. No Session header, event envelope or event version changes.

<a id="verification"></a>
## Verification

gen-persistence-catalog regenerated the catalog and schema inventory; verify-persistence-changes records and checks this acknowledgment; the jira-agent suite passes 227/227 with the managed-section append/adopt tests, typecheck passes 5/5, and lint stays at the 557-error/0-warning baseline.

<a id="dev-note"></a>
## Dev Note

None.
