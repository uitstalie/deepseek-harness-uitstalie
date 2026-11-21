# Installer data removal

English | [中文](installer-data-removal.zh.md)

**Rule:** an installer, updater, or uninstaller never writes to or deletes anything inside `$DSH_HOME`. It removes only the Electron `userData` directory and the updater cache, and it treats the Harness home as a protected root it refuses to touch.

## Why

A Session, profile, and credentials live in a home the user chooses, which may be a custom directory or a shared location. An uninstaller that deletes that home removes user data the installer never created. The data-removal step therefore names its targets explicitly and refuses any target that overlaps the home or the installation directory.

## How to apply it

- Read `DSH_HOME` only as the protected root; never pass it as a removal target.
- Keep removal targets under `%APPDATA%` or `%LOCALAPPDATA%` (Electron `userData` and the updater cache) so they are recreated on the next launch.
- Skip removal entirely when the uninstaller runs as part of an upgrade, and honour an explicit keep-data switch when it is present.
- Refuse a target that contains the installation directory, the protected home, or the Programs directory, and refuse to traverse a junction or symbolic link.

## Evidence

| Location | What it proves |
|---|---|
| `apps/desktop/installer/uninstall.nsh:13` | An update run returns before data cleanup. |
| `apps/desktop/installer/uninstall.nsh:19` | `/KEEP_APP_DATA` short-circuits cleanup. |
| `apps/desktop/installer/uninstall.nsh:24` | `DSH_HOME` is read only as the protected root. |
| `apps/desktop/installer/uninstall.nsh:26,30,34` | The three removal targets are `${PRODUCT_FILENAME}` under `$APPDATA`, `${APP_PACKAGE_NAME}` under `$APPDATA`, and the updater cache under `$LOCALAPPDATA`. |
| `apps/desktop/installer/uninstall-data.h:99-107` | `Remove` refuses any path overlapping the installation directory or the protected home. |
| `apps/desktop/installer/uninstall-data.h:43-53` | Directory handles open without following reparse points. |
| `apps/desktop/scripts/installer.nsh:96` | The uninstall hook calls only `un.CleanData`. |
| `apps/desktop/scripts/installer.nsh:239-253` | Installation writes the directory and the `InstallLocation` registry value only. |

The desktop runtime creates `profiles/desktop` and its patch backup on first launch; creation is not deletion, and an upgrade keeps the existing home.

## Wrong

Passing `$DSH_HOME` to a recursive delete because it "belongs to the product", or deleting the whole `$APPDATA` directory, which removes unrelated applications' data.
