# Home-write Low-integrity inheritance: risk assessment

**Verdict.** Risk **Medium** (the upper half of it on developer machines). It does not block the opt-in `home-write` mode, whose stated purpose is exactly to let the confined child write the user's data. It does block making `home-write` a default or recommended preset, and it blocks any claim that the Windows backend fully enforces the mode, until the scope and the user-facing disclosure change. The worst realistic outcome is user-level code execution: a Low-integrity process that until now could only read the profile can write user data and plant content that later runs at Medium when the person opens or builds it, and the labels outlive the sandbox session.

This document assesses the existing behavior. It changes no sandbox code and proposes no switch.

## 1. Mechanism

`grantWrite` does three things in one `SetNamedSecurityInfoW` call: it adds the capability-SID write ACE, adds the Everyone `FILE_DELETE_CHILD` deny, and applies a Low mandatory label. The label is a `SYSTEM_MANDATORY_LABEL_ACE` naming `S-1-16-4096` with `SYSTEM_MANDATORY_LABEL_NO_WRITE_UP`, added with `SUB_CONTAINERS_AND_OBJECTS_INHERIT` (OI|CI) — [buildLowLabelAcl](sandbox-windows-acl/src/acl.ts) and [grantWrite](sandbox-windows-acl/src/acl.ts).

Two different effects are often conflated, and both matter here:

1. **Forward inheritance (the `(OI)(CI)` flags).** Every object created under the granted directory *after* the grant inherits the label. A file created in a granted directory shows `(I)(NW)`; a directory shows `(I)(OI)(CI)(NW)`.
2. **Backward propagation at apply time.** `SetNamedSecurityInfoW` with `LABEL_SECURITY_INFORMATION` rewrites the inherited label ACEs on the directory's *existing* subtree. This is the same eager propagation that makes `grantWrite`'s exact-label check worth having: the whole tree is touched on the first grant, not lazily. It is why `%TEMP%` — three levels below the home root, with no sandbox-created file anywhere near it — already carries the label.

The grant scope therefore decides the blast radius:

| Granted object | Label reaches |
|---|---|
| Home root (`C:\Users\<user>`) | The entire profile: Desktop, Documents, Downloads, `AppData`, `%TEMP%`, source trees checked out under the profile |
| Each non-system drive root (`D:\`…) | Every file and directory on that drive |
| Session workspace | The workspace tree (already true under `workspace-write`, whose grant is standing) |
| Private temp directory | The temp tree (inside the home under `home-write`) |
| Configured `homeWriteRoots` | Each configured root, replacing the platform defaults |

`excludePaths` is different: `denyWrite` edits only the DACL and deliberately leaves the label alone ([denyWrite](sandbox-windows-acl/src/acl.ts)). An excluded directory under a granted root still inherits the Low label from that root; the exclusion only denies the capability SID.

Persistence is a property of real SACL edits, not of the process that made them:

- `AclWriteGrant.dispose()` calls `revokeWrite`, which removes the capability ACEs and clears the label when no other capability grant remains ([revokeWrite](sandbox-windows-acl/src/acl.ts)). The removal propagates: after a grant/dispose cycle on a scratch directory, both the directory and a child file return to having no label (evidence in section 3).
- `home-write` grants are **revocable but provider-lifetime**. Switching the session back to `workspace-write` does not dispose the provider, so the labels stay. Only a graceful provider dispose (server shutdown or HMR) revokes them. A crash or a killed server leaves the labels behind, and the next provision's exact-label skip means nothing re-applies or cleans them.
- The workspace-root grant is **standing by design** and is never revoked, so a workspace stays Low for the life of the machine's ACL state, independent of this mode.

## 2. Impact

A Low mandatory label with no-write-up is a floor, not a ceiling. It denies writes from **lower** integrity subjects. A Medium-integrity subject is higher, so write-down is allowed and the DACL remains the only authority:

- The signed-in user's ordinary applications (Medium) still read, write, delete, rename, and change the ACL wherever the DACL allows. Explorer, IDEs, editors, build tools, `git`, package managers, and backups keep working; there is no "cannot save" wave.
- An elevated (High) process is likewise unaffected. The label is not a permission grant and does not elevate anything.

What changes is the opposite direction. Every **Low-integrity** process running as the user now passes the integrity check on these objects; before, write-up denied it even when the DACL named the user's SID. Low integrity is the containment level Windows gives browser renderers and other content processes, several document converters, and other sandboxed helpers. The home DACL grants the user full control, so for those processes the DACL no longer stops a write either.

Concrete consequences:

1. **Low compromise becomes a Medium code-execution pivot.** A compromised browser renderer writes `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\payload.cmd`, a Desktop `.lnk`, or a `.ps1` the person is likely to run. The content executes at Medium at the next logon or double-click. Before `home-write`, the integrity check denied the write even though the renderer ran as the same user.
2. **Build and editor configuration poisoning.** The same write reaches `D:\…\.vscode\tasks.json`, `.git/hooks/pre-commit`, `.npmrc`, or a `package.json` script, because the whole drive is granted and labeled. The next Medium build or commit runs attacker-controlled content in the developer's context — the highest-value target on a development machine.
3. **Persistence beyond the session.** Files created while the label stands inherit it, so the downgrade spreads to new content on its own. It survives switching the session back and, after an unclean shutdown, survives the sandbox entirely; only an explicit revocation or a manual relabel narrows it again.

Two boundaries keep this from being worse:

- **It is not a privilege elevation.** A Low process still cannot write Medium- or High-integrity system objects outside the granted roots, and the label never raises a token's integrity level.
- **DSH's own confined children do not gain from it.** They are Low *and* write-restricted; the write-restricted pass-2 check still requires a capability SID, and the profile's DACL names the user's SID, not that capability. `read-only` and `workspace-write` sessions remain unable to write the home. The incremental exposure is to Low processes *outside* DSH, plus the intended home-write child.

For the security posture the direction is worse, not better: it removes one defense-in-depth layer over the whole profile and every non-system drive so that a single mode can write there. The mode's grant already gives the agent that write authority; the label additionally gives it to every other Low process on the machine.

## 3. Reproduction and evidence

All commands were run on the affected Windows host. The first block shows the state the earlier home-write grants left behind; the second isolates the mechanism on a scratch directory outside every granted root, so it proves the label behavior without relying on the home grant.

```powershell
icacls C:\Users\TS
#   Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)          <- explicit, on the home root
icacls C:\Users\TS\AppData\Local\Temp
#   Mandatory Label\Low Mandatory Level:(I)(OI)(CI)(NW)       <- inherited, three levels down
icacls D:\
#   Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)          <- the drive root grant
icacls D:\dqc
#   Mandatory Label\Low Mandatory Level:(I)(OI)(CI)(NW)
```

The minimal mechanism demo uses a directory on `C:\ProgramData` (outside the home and outside every drive root), a synthetic Low child run through the real read-only runner, and `icacls`:

```powershell
$demo = 'C:\ProgramData\dsh-label-demo'
$temp = 'C:\ProgramData\dsh-label-demo-temp'
New-Item -ItemType Directory $demo, $temp
cmd /c "icacls $demo /grant *S-1-1-0:(OI)(CI)(M)"
$probe = "try { Set-Content -LiteralPath '$demo\low-child.txt' -Value x -ErrorAction Stop; 'WRITE: OK' } catch { 'WRITE: DENIED' }"

# Child = Low integrity, restricting SIDs [logon, Everyone]; the DACL allows Everyone M.
node --import tsx/esm packages\sandbox\sandbox-windows-acl\src\runner.ts `
  --workspace $demo --temp $temp --mode read-only -- pwsh -NoProfile -Command $probe
# prints: WRITE: DENIED      <- integrity write-up, even though the DACL grants Everyone M

cmd /c "icacls $demo /setintegritylevel (OI)(CI)L"
# the same child command now prints: WRITE: OK
icacls "$demo\low-child.txt"
#   Mandatory Label\Low Mandatory Level:(I)(NW)   <- inherited by the new file

# Restore the directory; the inherited label follows the parent.
cmd /c "icacls $demo /setintegritylevel (OI)(CI)M"
icacls "$demo\low-child.txt"
#   Mandatory Label\Medium Mandatory Level:(I)(NW)
```

The step that relabels is the **`grantWrite(grantedRoot)` call**, not the child spawn: the first home-write confinement (or the first agentless home-write run) applies the label to the root, and `SetNamedSecurityInfoW` then propagates it through the existing tree. On this host the home grant is what relabeled `%TEMP%`; a later standalone run against `D:\` labeled the drive.

The revocation path is verified with the production code, not `icacls`: create a scratch directory and child, `AclWriteGrant.create(workspaceWriteSid(dir)).add(dir)`, then `dispose()`.

```text
=== BEFORE          (no label / no capability ACE)
=== AFTER GRANT     dir:   S-1-4-…:(OI)(CI)(W,D,DC)  +  Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)
                    child: S-1-4-…:(I)(W,D,DC)       +  Mandatory Label\Low Mandatory Level:(I)(NW)
=== AFTER DISPOSE   (no label / no capability ACE, on the directory AND the child)
```

So a revocation that actually runs restores the tree. The gap is *when* it runs (section 1).

## 4. Mitigations and alternatives

**Reduce the granted scope.** Grant the workspace plus explicitly named directories instead of the whole home and every non-system drive. This is the only change that removes the blast radius rather than describing it, and it changes the product promise of the mode, so it is a product decision. The current defaults are what make the finding machine-wide.

**Keep the label, fix the lifecycle.** The verified revocation exists; what is missing is a trigger. Dispose the home-write grants when the last session leaves the mode (not only at server shutdown), and run a startup sweep for crash residue. Provide the documented manual recovery for people who need it now: `icacls <root> /setintegritylevel (OI)(CI)M` restores the root and its inherited labels; the `AclWriteGrant.dispose()` path clears the ACE as well.

**Grant an access ACE without the integrity label.** Not viable. A Low child writing a Medium object is denied by the integrity policy regardless of the DACL, so the mode's core promise ("the home is writable") needs the label. Making the label non-inheritable would make only the root writable and leave every existing file and subdirectory unwritable — a silent half-mode.

**Do not lower the child's integrity.** Removing the Low label from the token would drop the integrity containment for the child entirely, which is worse than the current trade.

**Warn in the GUI.** Yes. The preset picker currently shows only the one-line description "Write inside the user home except force-read-only paths; wider retries require approval" ([preset defaults](../interaction/permission-presets/src/index.ts)); it does not say that the mode relabels the home (and every non-system drive) to Low integrity, that the labels persist while the server is running, or how to restore them. A confirmation that names the granted trees and the lasting side effect is the cheapest mitigation available, and it is a wording change rather than a behavior change.

**Not a mitigation.** Adding `excludePaths` for `%APPDATA%\…\Startup`, `.vscode`, or `.git/hooks` denies only the capability SID; the label and the user's DACL still let other Low processes write there.

## 5. Conclusion

**Risk: Medium.** The mode already grants the agent DACL write over the home, so the agent's own authority does not change; the finding is that the same grant lowers the integrity floor of the whole profile and every non-system drive, which benefits every *other* Low process on the machine, persists beyond the session, and is not disclosed.

**Blocking.** Not for the opt-in `home-write` mode. Yes for promoting it to a default or recommended preset, and yes for any statement that the Windows backend fully enforces the mode, until the scope is reduced or the disclosure and lifecycle are fixed.

**Priority.** P1: GUI/preset disclosure of the integrity side effect and the restore command; fix the stale one-line preset description while there. P2: revoke home-write grants when the mode is left, and clean crash residue at startup. P3 (product decision): replace whole-home/whole-drive defaults with workspace plus explicitly named roots.

**If the decision is to change it,** the touch points are, without implementing them here:

- `packages/sandbox/sandbox-local/src/index.ts` — `windowsAclRunnerArgv` and `materializeHomeWriteGrant`: which roots are granted, and when the grants are disposed (mode departure, startup sweep).
- `packages/sandbox/sandbox-windows-acl/src/acl.ts` — `grantWrite` / `buildLowLabelAcl`: an explicit "label this root only" or restore API if the scope decision needs it.
- `packages/sandbox/sandbox-policy/src/index.ts` — the default `homeWriteRoots` scope.
- `packages/interaction/permission-presets/src/index.ts` and `packages/client/ui-permission-presets/src/client/locales.ts` — the preset description and the confirmation copy.
