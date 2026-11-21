#!/bin/sh
# Refresh the icon and desktop caches after the RPM transaction. The package
# installs a standard hicolor size set plus a pixmaps copy, so a theme without
# an indexed 1104 px directory no longer hides the menu icon.

if command -v gtk-update-icon-cache >/dev/null 2>&1 && [ -d /usr/share/icons/hicolor ]; then
  gtk-update-icon-cache -f -t /usr/share/icons/hicolor >/dev/null 2>&1 || true
fi

if command -v update-desktop-database >/dev/null 2>&1 && [ -d /usr/share/applications ]; then
  update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
fi

exit 0
