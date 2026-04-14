#!/bin/bash
set -e

EXT_UUID="spotify-lyrics@gnome-shell-extension"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$EXT_UUID"

echo "Installing SpotLine Enhanced to $EXT_DIR ..."

mkdir -p "$EXT_DIR/schemas"

cp extension.js prefs.js stylesheet.css metadata.json "$EXT_DIR/"
cp schemas/*.xml "$EXT_DIR/schemas/"

glib-compile-schemas "$EXT_DIR/schemas/"

echo "Done. Restart GNOME Shell to apply changes:"
echo "  X11:    killall -HUP gnome-shell"
echo "  Wayland: log out and log back in"
