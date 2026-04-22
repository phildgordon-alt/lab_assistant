#!/bin/bash
# smb-mount-watchdog.sh — Checks DVI SMB mount and remounts on failure.
# Runs via launchd every 60 seconds.
#
# Three failure modes handled:
#   1. Mount missing entirely — re-mount.
#   2. Mount exists but ls hangs — force unmount, remount.
#   3. Mount exists, ls succeeds, but file mtimes are frozen (ZOMBIE mount
#      serving cached metadata). During business hours the most-recent
#      LT*.DAT must have advanced within LIVENESS_WINDOW_MIN. This is the
#      mode that burned us on 2026-04-21 — previous ls-timeout check
#      passed because macOS SMB returns cached directory listings without
#      hanging even when the server connection is dead.

MOUNT_POINT="/Users/Shared/lab_assistant/data/dvi/visdir"
TRACE_DIR="${MOUNT_POINT}/TRACE"
SMB_URL="//dvi:dvi@192.168.0.27/visdir"
LAB_SERVER="http://localhost:3002"
LOG_TAG="[SMB-Watchdog]"

LIVENESS_WINDOW_MIN=15
BUSINESS_HOUR_START=6
BUSINESS_HOUR_END=22

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') ${LOG_TAG} $1"; }

in_business_hours() {
    local hour=$(TZ='America/Los_Angeles' date +%H)
    local dow=$(TZ='America/Los_Angeles' date +%u)   # 1=Mon .. 7=Sun
    if [ "$dow" = "7" ]; then return 1; fi
    if [ "$hour" -ge "$BUSINESS_HOUR_START" ] && [ "$hour" -lt "$BUSINESS_HOUR_END" ]; then
        return 0
    fi
    return 1
}

# Liveness probe: most-recent LT*.DAT mtime advanced within LIVENESS_WINDOW_MIN?
# Returns 0 if live (or no files to check), 1 if stale.
check_liveness() {
    local newest
    newest=$(ls -t "$TRACE_DIR"/LT*.DAT 2>/dev/null | head -1)
    if [ -z "$newest" ]; then
        log "liveness: no LT*.DAT in TRACE — treating as stale"
        return 1
    fi
    local mtime
    mtime=$(stat -f "%m" "$newest" 2>/dev/null)
    if [ -z "$mtime" ]; then
        log "liveness: could not stat $(basename "$newest") — treating as stale"
        return 1
    fi
    local now=$(date +%s)
    local age_min=$(( (now - mtime) / 60 ))
    if [ "$age_min" -gt "$LIVENESS_WINDOW_MIN" ]; then
        log "liveness: $(basename "$newest") mtime ${age_min}m old (threshold ${LIVENESS_WINDOW_MIN}m) — STALE"
        return 1
    fi
    return 0
}

# Check if visdir is an active mount point
if mount | grep -q "$MOUNT_POINT"; then
    # Mount exists — verify it's responsive (5s timeout prevents hang on stale mount)
    if /usr/bin/perl -e 'alarm 5; exec @ARGV' /bin/ls "$TRACE_DIR" >/dev/null 2>&1; then
        # ls returned — might still be a zombie serving cached data. Run liveness
        # check during business hours only (off-hours idle is legitimate).
        if in_business_hours; then
            if check_liveness; then
                exit 0
            fi
            log "Mount exists and ls works but trace mtime frozen — zombie mount, forcing remount"
        else
            exit 0
        fi
    else
        log "Mount exists but ls hung — forcing remount"
    fi
    diskutil unmount force "$MOUNT_POINT" 2>/dev/null || umount -f "$MOUNT_POINT" 2>/dev/null
    sleep 1
fi

# No active mount — check if mount point is clear
if mount | grep -q "$MOUNT_POINT"; then
    log "ERROR: could not unmount stale mount at $MOUNT_POINT"
    exit 1
fi

log "TRACE directory missing — mounting SMB share"

# Ensure mount point exists
mkdir -p "$MOUNT_POINT" 2>/dev/null

# Mount
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
RESULT=$(curl -s -X POST "${LAB_SERVER}/api/dvi/trace/recover" -o /dev/null -w "%{http_code}" 2>&1)
log "Recovery triggered (HTTP $RESULT)"
