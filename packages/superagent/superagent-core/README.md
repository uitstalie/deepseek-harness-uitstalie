---
description: "A durable report journal for workspace dispatches, retaining task bindings and delivery state independently of the issue ledger."
kind: "package-library"
---

# @deepseek-ai/dsh-superagent-core

English | [中文](README.zh.md)

## Summary

Callers can bind a workspace Session and prompt identity to a dispatch before admitting work, then retain and settle its report delivery independently of any issue ledger. The journal stores pending, delivering, delivered, and failed states with attempts and errors, and supports reading failed reports for an explicit retry. `DispatchStore` persists business results in the dispatch domain and accepts an explicit projection interface for human-readable output.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Use `DispatchReportStore` with the super workspace root. The caller must record a binding before admitting the child prompt, claim and prepare the report before delivery, and settle the result after the recipient accepts or rejects it. The journal is stored under `.superagent/reports.jsonl`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The package contains the journal, the dispatch domain model, and the domain store's filesystem operations. It does not import a Jira service, issue types, or Markdown parser. Journal writes are serialized per store instance; a new instance can read the latest record for each task. The domain store accepts a `DispatchProjection` for legacy Markdown import and projection, while business results remain in the domain. The caller remains responsible for delivery, retry policy, and lifecycle orchestration.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **One instance is not a cross-process lock** — multiple hosts writing one journal need separate ownership or an atomic claim mechanism.
- **Delivery is orchestrated by the caller** — the journal does not send messages, restart a Session, or decide when a failed report should be retried.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
