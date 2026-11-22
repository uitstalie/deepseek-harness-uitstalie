#!/bin/sh
# Refresh the icon and desktop caches after the RPM transaction. The package
# installs a standard hicolor size set plus a pixmaps copy, so a theme without
# an indexed 1104 px directory no longer hides the menu icon.
#
# The desktop file is now deepseek-ai-dsh-desktop.desktop, matching the app_id
# Electron derives from desktopName. Remove the pre-rename entry so an upgrade
# cannot leave two menu items; RPM removes it too, but stale copies survive
# interrupted transactions.

rm -f /usr/share/applications/deepseek-harness.desktop

if command -v gtk-update-icon-cache >/dev/null 2>&1 && [ -d /usr/share/icons/hicolor ]; then
  gtk-update-icon-cache -f -t /usr/share/icons/hicolor >/dev/null 2>&1 || true
fi

if command -v update-desktop-database >/dev/null 2>&1 && [ -d /usr/share/applications ]; then
  update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
fi

exit 0
