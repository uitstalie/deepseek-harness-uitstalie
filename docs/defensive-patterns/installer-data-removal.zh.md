# 安装器数据删除

[English](installer-data-removal.md) | 中文

**规则：** 安装器、更新器与卸载器都不写入、不删除 `$DSH_HOME` 内的任何内容。它们只删除 Electron 的 `userData` 目录与更新缓存，并把 Harness home 当作拒绝触碰的受保护根。

## 为什么

Session、profile 与凭据存放在用户选定的 home 中，可能是自定义目录或共享位置。删掉该 home 的卸载器会移除安装器从未创建的用户数据。因此删除步骤显式列出目标，并拒绝任何与 home 或安装目录重叠的目标。

## 如何落实

- 只把 `DSH_HOME` 当作受保护根读取，绝不把它作为删除目标。
- 删除目标保持在 `%APPDATA%` 或 `%LOCALAPPDATA%`（Electron 的 `userData` 与更新缓存），下次启动会重建。
- 卸载器作为升级的一部分运行时完全跳过删除，并支持显式的保留数据开关。
- 拒绝包含安装目录、受保护 home 或 Programs 目录的目标，且不穿越 junction 或符号链接。

## 证据

| 位置 | 证明什么 |
|---|---|
| `apps/desktop/installer/uninstall.nsh:13` | 升级运行在数据清理前返回。 |
| `apps/desktop/installer/uninstall.nsh:19` | `/KEEP_APP_DATA` 直接短路清理。 |
| `apps/desktop/installer/uninstall.nsh:24` | `DSH_HOME` 仅作为受保护根读取。 |
| `apps/desktop/installer/uninstall.nsh:26,30,34` | 三个删除目标分别是 `$APPDATA` 下的 `${PRODUCT_FILENAME}`、`$APPDATA` 下的 `${APP_PACKAGE_NAME}`、以及 `$LOCALAPPDATA` 下的更新缓存。 |
| `apps/desktop/installer/uninstall-data.h:99-107` | `Remove` 拒绝与安装目录或受保护 home 重叠的任何路径。 |
| `apps/desktop/installer/uninstall-data.h:43-53` | 打开目录句柄时不跟随重解析点。 |
| `apps/desktop/scripts/installer.nsh:96` | 卸载钩子只调用 `un.CleanData`。 |
| `apps/desktop/scripts/installer.nsh:239-253` | 安装只写目录与 `InstallLocation` 注册表值。 |

桌面运行时在首次启动时创建 `profiles/desktop` 及其 patch 备份；创建不是删除，升级会保留既有 home。

## 错误做法

以"属于产品"为由把 `$DSH_HOME` 传给递归删除，或删除整个 `$APPDATA` 目录，从而移除其他应用的数据。
