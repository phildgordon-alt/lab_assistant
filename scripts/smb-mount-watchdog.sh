#!/bin/bash
# smb-mount-watchdog.sh — Checks DVI SMB mount and remounts if missing
# Runs via launchd every 60 seconds.
# If the TRACE directory is missing or empty, remounts the SMB share
# and triggers a trace recovery via the Lab Server API.

MOUNT_POINT="/Users/Shared/lab_assistant/data/dvi/visdir"
TRACE_DIR="${MOUNT_POINT}/TRACE"
SMB_URL="//dvi:dvi@192.168.0.27/visdir"
LAB_SERVER="http://localhost:3002"
LOG_TAG="[SMB-Watchdog]"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') ${LOG_TAG} $1"; }

# Check if TRACE directory exists and has LT files
if [ -d "$TRACE_DIR" ] && ls "$TRACE_DIR"/LT*.DAT >/dev/null 2>&1; then
    # Mount is healthy — nothing to do
    exit 0
fi

log "TRACE directory missing or empty — remounting SMB share"

# Unmount stale mount if present
umount "$MOUNT_POINT" 2>/dev/null

# Ensure mount point exists
mkdir -p "$MOUNT_POINT"

# Remount
mount -t smbfs "$SMB_URL" "$MOUNT_POINT" 2>&1
MOUNT_RC=$?

if [ $MOUNT_RC -ne 0 ]; then
    log "ERROR: mount failed (rc=$MOUNT_RC). DVI host 192.168.0.27 may be unreachable."
    exit 1
fi

# Verify TRACE dir exists after mount
if [ ! -d "$TRACE_DIR" ]; then
    log "ERROR: mounted but TRACE directory not found at $TRACE_DIR"
    exit 1
fi

log "Mount restored. Triggering trace recovery..."

# Give the mount a moment to stabilize
sleep 2

# Trigger trace recovery via Lab Server API
curl -s -X POST "${LAB_SERVER}/api/dvi/trace/recover" -o /dev/null -w "HTTP %{http_code}" 2>&1
CURL_RC=$?

if [ $CURL_RC -eq 0 ]; then
    log "Recovery triggered successfully"
else
    log "WARNING: recovery API call failed (rc=$CURL_RC) — server may not be running"
fi
