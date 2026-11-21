# Cookbook: attributing Home deletions to a process

English | [中文](attributing-home-deletions.zh.md)

Use this plan when files under `$DSH_HOME` disappear and the writer must be named. The sampling and watching tools in [repairing a Session request](repairing-a-session-request.md) show *when* an entry vanished and *which processes were alive*; Windows auditing is the only local mechanism that names the process that issued the delete itself. Every step needs a local administrator; nothing here is safe to enable permanently on a busy machine.

## 1. Decide the window

Auditing records future events only, so enable it before reproducing the build or install that loses data. Expect attribution on the first qualifying reproduction; a machine that never repeats the loss produces no evidence. Keep the window short: `4663` records one event per audited access, and an active Session writes hundreds of files a minute.

## 2. Enable object-access auditing

In an elevated PowerShell, enable the File System subcategory for both outcomes. This is the switch that turns attempted object access into `4663` and handle requests into `4656`.

```powershell
auditpol /set /subcategory:"File System" /success:enable /failure:enable
auditpol /get /subcategory:"File System"
```

## 3. Scope a SACL to the Home

A SACL decides which objects produce those events. Apply one to `$DSH_HOME` itself and to the top-level entries that must not disappear, auditing delete and write-data access for `Everyone`. The inheritance flags cover existing children and entries created later; a container-only rule would miss the files inside them.

```powershell
$home = "$env:USERPROFILE\.dsh"
$acl = Get-Acl $home
$rule = New-Object System.Security.AccessControl.FileSystemAuditRule(
  "Everyone", "Delete, DeleteSubdirectoriesAndFiles, WriteData", "ContainerInherit, ObjectInherit", "None", "Success, Failure")
$acl.AddAuditRule($rule)
Set-Acl -Path $home -AclObject $acl
```

## 4. Enable process-creation auditing

`4663` states the acting process id; `4688` turns that id into a command line. Enable process creation auditing and the command-line policy, then restart the audit service so the policy applies.

```powershell
auditpol /set /subcategory:"Process Creation" /success:enable
reg add "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System\Audit" /v ProcessCreationIncludeCmdLine_Enabled /t REG_DWORD /d 1 /f
```

## 5. Read the evidence

Read `4663` for the affected paths, then join its process id with `4688` to name the executable and its arguments. The Security log needs elevation to read.

```powershell
Get-WinEvent -FilterHashtable @{LogName='Security'; Id=4663} -MaxEvents 200 |
  Where-Object { $_.Message -match '\.dsh' } |
  Select-Object TimeCreated, @{n='Process';e={$_.Properties[11].Value}}, @{n='Path';e={$_.Properties[6].Value}}
Get-WinEvent -FilterHashtable @{LogName='Security'; Id=4688} -MaxEvents 200 |
  Where-Object { $_.Message -match '\.dsh|pwsh|node' } |
  Select-Object TimeCreated, @{n='Image';e={$_.Properties[5].Value}}, @{n='CommandLine';e={$_.Properties[8].Value}}
```

## 6. Turn it off afterwards

Remove the audit rule and disable both subcategories when the reproduction ends, so the Security log keeps its normal size and the machine keeps its normal overhead.

```powershell
$home = "$env:USERPROFILE\.dsh"
$acl = Get-Acl $home
$acl.Audit | Where-Object { $_.IdentityReference -eq "Everyone" } | ForEach-Object { $acl.RemoveAuditRule($_) | Out-Null }
Set-Acl -Path $home -AclObject $acl
auditpol /set /subcategory:"File System" /success:disable /failure:disable
auditpol /set /subcategory:"Process Creation" /success:disable
```

## 7. Know the limits

The Security log retains events only until its size cap rotates them, so export it after the reproduction. Auditing shows the process that issued the delete, not why it ran; an interpreter that executes an inline command still appears as `pwsh.exe` or `node.exe` with the command line from `4688`. Virtualization, containers, and network paths can produce events without a local process id, and a delete performed inside another user's logon session names that session instead.
## 8. Record what you enabled

Write down the enabled subcategories, the SACL scope, and where the evidence lives before the first event arrives. The deployment that enabled this audit records: File System with success and failure, Process Creation, the 4688 command-line setting, and a .dsh SACL limited to Delete and DeleteSubdirectoriesAndFiles; policy output, SACL state, a probe event, and the original SDDL are kept beside the operator log.

- The audit records only events after enablement; earlier deletions cannot be recovered from it.
- Keep the original SDDL until the SACL is restored, per section 6.
- Treat an absent event as evidence of a quiet window, never as proof that nothing was attempted.
