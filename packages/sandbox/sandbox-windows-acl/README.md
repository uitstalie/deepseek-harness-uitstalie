---
description: "Disabled Windows ACL confinement primitives and the diagnostic skill for repairing Windows file permissions."
kind: "package-library"
---

# @deepseek-ai/dsh-sandbox-windows-acl

English | [中文](README.zh.md)

## Summary

This package retains Windows ACL primitives and the ACL diagnosis skill, but confined execution is disabled. Its former Low workspace labels and Everyone delete-deny entries also affected ordinary user processes; a Medium restricted token cannot preserve the former write boundary. `dsh-sandbox-local`, the direct runner, and public `AclSandbox` construction refuse before changing a directory or spawning the command. New grant helpers modify only a capability-SID allow ACE: never a Low label or an Everyone delete deny.

## Table of Contents

- [Repair permissions](#repair-permissions)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="repair-permissions"></a>
## Repair permissions

The bundled `diagnose-windows-sandbox-acl` skill inspects the requested path and every ancestor. It adds the signed-in user's full-control allow ACE where effective `WRITE_DAC` or `WRITE_OWNER` is missing and removes explicit AppContainer package allow ACEs at their sources. It preserves deny entries, owners, inheritance, and mandatory labels. Every changed DACL is backed up and re-read before the run reports success.

The script refuses reparse paths, managed application trees, and objects outside its authorized root. Failed repairs restore attempted changes in reverse order. Run it unconfined, not elevated, then repeat the original confined operation; a verified permission change does not by itself prove that the original failure is resolved.

`registerAclDiagnosisSkill` contributes the skill when `dsh-sandbox-local` mounts its built-in Windows support and a skill registry is available. Registration extracts resources for external PowerShell, including ASAR and SEA deployments. Fiber disposal unregisters the provider and removes its copy.

## Model Experience

Indirectly, through the bundled diagnosis skill's catalog entry and `dsh-sandbox-local`'s unavailable-backend diagnostics.

#### KV Cache effect

One catalog entry is present on Windows. Resource extraction does not invalidate a request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The built-in runner is unavailable** — the package provides no confined Windows execution until a replacement preserves ordinary user permissions and enforces the mode's file effects.
- **Diagnosis preserves integrity labels** — it does not repair Low labels left by the retired runner. Recovery directories and scripts can remain after an unclean shutdown.
- **Diagnosis needs an unconfined caller** — its security-descriptor operations fail in a confined process. Approval availability determines whether the operation can proceed.

<a id="dev-note"></a>
### Dev Note

None.
