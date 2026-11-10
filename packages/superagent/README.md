---
description: "The superagent package group: durable dispatch state and report delivery independent of the Jira issue ledger."
kind: "package-group"
---

# superagent/ — durable dispatch state and reports

English | [中文](README.zh.md)

## Summary

The superagent packages retain workspace dispatch bindings, business results, and report delivery independently of the issue ledger. `superagent-core/` owns the durable report journal, dispatch domain, and recovery operations. Callers can recover saved reports after a restart and acknowledge delivered results without reopening failed work. Journal claims remain process-local; cross-process ownership needs a separate mechanism.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`superagent-core/`](superagent-core/README.md) | Durable report journal, dispatch domain, and startup recovery operations | library, no key |

<a id="related-documentation"></a>
## Related documentation

- [Agent Teams subsystem](../../docs/subsystems/agent-team.md) — shared task coordination; dispatch result ownership and report delivery remain separate.
- [Jira packages](../jira/README.md) — optional issue references and the human-readable dispatch projection.

<a id="dev-note"></a>
## Dev Note

None.
