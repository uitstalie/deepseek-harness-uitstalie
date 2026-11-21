# Cookbook：把 Home 删除归因到具体进程

[English](attributing-home-deletions.md) | 中文

当 `$DSH_HOME` 下的文件消失、必须点名写入者时，用这份方案。会话修复工具（[repairing a Session request](repairing-a-session-request.zh.md)）能给出"哪个条目、在何时消失、当时有哪些进程存活"；Windows 审核是本地唯一能点名**发起删除的进程本身**的机制。每一步都需要本地管理员权限，而且这些开关都不适合在繁忙的机器上长期开启。

## 1. 确定观察窗口

审核只记录开启之后发生的事件，所以要在复现"构建/安装丢数据"之前打开。预期在第一次符合条件的复现时就能归因；如果机器不再复现，就不会有任何证据。窗口要短：`4663` 每次被审核的访问都记一条，活跃的 Session 每分钟要写几百个文件。

## 2. 开启对象访问审核

在管理员 PowerShell 中，把 File System 子类别在成功与失败两种结果上都打开。这是让对象访问尝试变成 `4663`、句柄请求变成 `4656` 的开关。

```powershell
auditpol /set /subcategory:"File System" /success:enable /failure:enable
auditpol /get /subcategory:"File System"
```

## 3. 给 Home 挂 SACL

SACL 决定哪些对象产生这些事件。给 `$DSH_HOME` 本身以及不允许消失的顶层条目各挂一条规则，对 `Everyone` 审核删除与写数据访问。继承标志同时覆盖已有子条目与之后新建的条目；只用容器级规则会漏掉它们里面的文件。

```powershell
$home = "$env:USERPROFILE\.dsh"
$acl = Get-Acl $home
$rule = New-Object System.Security.AccessControl.FileSystemAuditRule(
  "Everyone", "Delete, DeleteSubdirectoriesAndFiles, WriteData", "ContainerInherit, ObjectInherit", "None", "Success, Failure")
$acl.AddAuditRule($rule)
Set-Acl -Path $home -AclObject $acl
```

## 4. 开启进程创建审核

`4663` 给出动作发生的进程 id；`4688` 把这个 id 还原成命令行。打开进程创建审核与命令行策略，然后重启审核服务让策略生效。

```powershell
auditpol /set /subcategory:"Process Creation" /success:enable
reg add "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System\Audit" /v ProcessCreationIncludeCmdLine_Enabled /t REG_DWORD /d 1 /f
```

## 5. 读取证据

先按受影响路径读 `4663`，再用其中的进程 id 关联 `4688`，得到可执行文件与参数。Security 日志需要提权才能读取。

```powershell
Get-WinEvent -FilterHashtable @{LogName='Security'; Id=4663} -MaxEvents 200 |
  Where-Object { $_.Message -match '\.dsh' } |
  Select-Object TimeCreated, @{n='Process';e={$_.Properties[11].Value}}, @{n='Path';e={$_.Properties[6].Value}}
Get-WinEvent -FilterHashtable @{LogName='Security'; Id=4688} -MaxEvents 200 |
  Where-Object { $_.Message -match '\.dsh|pwsh|node' } |
  Select-Object TimeCreated, @{n='Image';e={$_.Properties[5].Value}}, @{n='CommandLine';e={$_.Properties[8].Value}}
```

## 6. 事后关掉

复现结束后移除审核规则并关闭两个子类别，让 Security 日志恢复正常大小、机器恢复正常开销。

```powershell
$home = "$env:USERPROFILE\.dsh"
$acl = Get-Acl $home
$acl.Audit | Where-Object { $_.IdentityReference -eq "Everyone" } | ForEach-Object { $acl.RemoveAuditRule($_) | Out-Null }
Set-Acl -Path $home -AclObject $acl
auditpol /set /subcategory:"File System" /success:disable /failure:disable
auditpol /set /subcategory:"Process Creation" /success:disable
```

## 7. 了解限制

Security 日志只在容量上限内保留事件，复现后要立刻导出。审核给出的是发起删除的进程，不是它为什么运行；内联命令的解释器仍显示为 `pwsh.exe` 或 `node.exe`，命令行来自 `4688`。虚拟化、容器与网络路径可能产生没有本地进程 id 的事件，在另一个用户登录会话里执行的删除只会指向那个会话。
## 8. 记录你开启了什么

在第一个事件到来之前，写下开启的子类、SACL 范围与证据所在位置。启用本审计的部署记录为：文件系统（成功与失败）、进程创建、4688 命令行设置，以及 .dsh 上仅 Delete 与 DeleteSubdirectoriesAndFiles 的 SACL；策略输出、SACL 状态、探测事件与原始 SDDL 与操作日志放在一起。

- 审计只记录开启之后的事件；更早的删除无法由它恢复。
- 在按第 6 节还原 SACL 之前，保留原始 SDDL。
- 没有事件只能说明窗口安静，不能证明没有人尝试。
