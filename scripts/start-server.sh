#!/bin/bash
#
# Wrapper script for lab server startup.
# Used by launchd plist (com.paireyewear.labassistant.server) instead of calling node directly.
#
# MOUNT STRATEGY (Option A — single mounter):
#   smb-mount-watchdog.sh is the SOLE mounter of the DVI SMB share.
#   This script does NOT mount. Previously it did, which combined with the watchdog
#   produced stacked mounts at the same path (ENOENT on reads post-cb1338b).
#   Instead we wait up to 30s for the watchdog's mount to appear before exec'ing node.
#   The watchdog runs at launchd load (RunAtLoad true) so it fires before this script
#   on a fresh boot; the 30s window covers any race on kickstart.

MOUNT_DST="/Users/Shared/lab_assistant/data/dvi/visdir"
TRACE_DIR="${MOUNT_DST}/TRACE"
WAIT_MAX=30
waited=0

echo "[startup] Waiting for DVI SMB mount at $MOUNT_DST..."
while ! mount | grep -qF "$MOUNT_DST"; do
  if [ "$waited" -ge "$WAIT_MAX" ]; then
    echo "[startup] WARNING: DVI mount not ready after ${WAIT_MAX}s — starting Node anyway; dvi-trace will self-heal"
    break
  fi
  sleep 1
  waited=$((waited + 1))
done

if mount | grep -qF "$MOUNT_DST"; then
  echo "[startup] DVI mount confirmed (waited ${waited}s)"
fi

# Start the server
exec /opt/homebrew/bin/node /Users/Shared/lab_assistant/server/oven-timer-server.js
