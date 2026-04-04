#!/bin/bash
#
# Wrapper script for lab server startup.
# Ensures DVI SMB share is mounted before starting Node.
# Used by launchd plist instead of calling node directly.
#

MOUNT_SRC="//dvi:dvi@192.168.0.27/visdir"
MOUNT_DST="/Users/Shared/lab_assistant/data/dvi/mount"

# Mount DVI share if not already mounted
if ! mount | grep -q "$MOUNT_DST"; then
  echo "[startup] Mounting DVI share..."
  mkdir -p "$MOUNT_DST"
  mount_smbfs "$MOUNT_SRC" "$MOUNT_DST" 2>/dev/null && echo "[startup] DVI mount OK" || echo "[startup] DVI mount failed — will retry in dvi-trace"
else
  echo "[startup] DVI share already mounted"
fi

# Start the server
exec /opt/homebrew/bin/node /Users/Shared/lab_assistant/server/oven-timer-server.js
