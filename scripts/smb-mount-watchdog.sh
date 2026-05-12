#!/bin/bash
# smb-mount-watchdog.sh — Checks DVI SMB mount and remounts on failure.
# Runs via launchd every 60 seconds.
#
# Four failure modes handled:
#   1. Mount missing entirely — re-mount.
#   2. Mount exists but ls hangs — force unmount, remount.
#   3. Mount exists, ls succeeds, but file mtimes are frozen (ZOMBIE mount
#      serving cached metadata). The most-recent LT*.DAT must have advanced
#      within the appropriate threshold for the time of day. This is the
#      mode that burned us on 2026-04-21 — previous ls-timeout check
#      passed because macOS SMB returns cached directory listings without
#      hanging even when the server connection is dead.
#   4. (NEW 2026-05-12) After any remount, kickstart the lab server so its
#      queued/wedged dvi-sync ls operations get dropped instead of
#      continuing to block the HTTP event loop indefinitely.

MOUNT_POINT="/Users/Shared/lab_assistant/data/dvi/visdir"
TRACE_DIR="${MOUNT_POINT}/TRACE"
SMB_URL="//dvi:dvi@192.168.0.27/visdir"
LAB_SERVER="http://localhost:3002"
LOG_TAG="[SMB-Watchdog]"

# Liveness thresholds — relaxed off-hours since the lab really IS quiet then,
# but never disabled entirely. Previous version skipped liveness checks
# overnight, which let SMB zombify between ~10pm and the morning. That's
# exactly when the lab dies.
LIVENESS_WINDOW_BUSINESS_MIN=15      # During business hours: 15 min of quiet = stale
LIVENESS_WINDOW_OFFHOURS_MIN=480     # Off-hours: 8 hours of quiet = stale
BUSINESS_HOUR_START=6
BUSINESS_HOUR_END=22

# Slack webhook for alerts (optional — set SLACK_WEBHOOK_URL env in plist)
: "${SLACK_WEBHOOK_URL:=}"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') ${LOG_TAG} $1"; }

alert_slack() {
    [ -z "$SLACK_WEBHOOK_URL" ] && return 0
    local msg="$1"
    curl -sS -m 5 -X POST -H 'Content-Type: application/json' \
         -d "{\"text\":\"🔧 SMB-Watchdog: ${msg}\"}" \
         "$SLACK_WEBHOOK_URL" >/dev/null 2>&1 || true
}

in_business_hours() {
    local hour=$(TZ='America/Los_Angeles' date +%H)
    local dow=$(TZ='America/Los_Angeles' date +%u)   # 1=Mon .. 7=Sun
    if [ "$dow" = "7" ]; then return 1; fi
    if [ "$hour" -ge "$BUSINESS_HOUR_START" ] && [ "$hour" -lt "$BUSINESS_HOUR_END" ]; then
        return 0
    fi
    return 1
}

# Liveness probe: most-recent LT*.DAT mtime advanced within the appropriate
# window? Returns 0 if live, 1 if stale.
# (Now runs ALWAYS, not just during business hours, so we catch overnight
# zombification.)
check_liveness() {
    local threshold_min
    if in_business_hours; then
        threshold_min=$LIVENESS_WINDOW_BUSINESS_MIN
    else
        threshold_min=$LIVENESS_WINDOW_OFFHOURS_MIN
    fi

    local newest
    newest=$(ls -t "$TRACE_DIR"/LT*.DAT 2>/dev/null | head -1)
    if [ -z "$newest" ]; then
        # Files not enumerable this cycle — could be a transient SMB read hiccup.
        # Don't trigger a remount on this alone; let next cycle retry.
        log "liveness: no LT*.DAT visible this cycle — passing (will retry next cycle)"
        return 0
    fi
    local mtime
    mtime=$(stat -f "%m" "$newest" 2>/dev/null)
    if [ -z "$mtime" ]; then
        log "liveness: could not stat $(basename "$newest") — treating as stale"
        return 1
    fi
    local now=$(date +%s)
    local age_min=$(( (now - mtime) / 60 ))
    if [ "$age_min" -gt "$threshold_min" ]; then
        log "liveness: $(basename "$newest") mtime ${age_min}m old (threshold ${threshold_min}m) — STALE"
        return 1
    fi
    return 0
}

# After a remount, the lab server may still have a queue of wedged dvi-sync
# `ls` operations that will continue to block the HTTP event loop until those
# requests' 300s timeouts expire. Kickstarting the server kills those
# operations and starts the dvi-sync polling fresh against the healthy mount.
# Without this, remounting fixed SMB but the lab server stayed dead until
# manual intervention. (2026-05-12: this was the missing piece in the daily
# morning-death sequence — remount worked, lab server stayed wedged.)
kickstart_lab_server() {
    local uid
    uid=$(id -u)
    if launchctl print "gui/${uid}/com.paireyewear.labassistant.server" >/dev/null 2>&1; then
        log "kickstarting lab server to clear any wedged dvi-sync queue"
        launchctl kickstart -k "gui/${uid}/com.paireyewear.labassistant.server" 2>&1
    fi
}

REMOUNT_TRIGGERED=0
REMOUNT_REASON=""

# Check if visdir is an active mount point
if mount | grep -q "$MOUNT_POINT"; then
    # Mount exists — verify it's responsive at the inode layer first.
    # `test -d` (single stat()) is microseconds on a healthy mount and hangs only
    # on a truly wedged mount. ls was taking >15s on a 165-file TRACE dir under
    # launchd, false-positiving every cycle.
    if /usr/bin/perl -e 'alarm 15; exec @ARGV' /bin/test -d "$TRACE_DIR" >/dev/null 2>&1; then
        # test -d passed. Still might be a zombie serving cached data — check
        # mtime advancement.
        if check_liveness; then
            exit 0
        fi
        REMOUNT_REASON="zombie mount — trace mtime frozen"
    else
        REMOUNT_REASON="mount hung at inode layer"
    fi
    log "Mount exists but unhealthy: ${REMOUNT_REASON} — forcing remount"
    REMOUNT_TRIGGERED=1
    diskutil unmount force "$MOUNT_POINT" 2>/dev/null || umount -f "$MOUNT_POINT" 2>/dev/null
    sleep 1
fi

# No active mount — check if mount point is clear
if mount | grep -q "$MOUNT_POINT"; then
    log "ERROR: could not unmount stale mount at $MOUNT_POINT"
    alert_slack "could not unmount stale mount at $MOUNT_POINT — manual intervention needed"
    exit 1
fi

if [ $REMOUNT_TRIGGERED -eq 0 ]; then
    log "TRACE directory missing — mounting SMB share"
    REMOUNT_REASON="mount missing entirely"
fi

# Ensure mount point exists
mkdir -p "$MOUNT_POINT" 2>/dev/null

# Mount
mount_smbfs "$SMB_URL" "$MOUNT_POINT" 2>&1
MOUNT_RC=$?

if [ $MOUNT_RC -ne 0 ]; then
    log "ERROR: mount failed (rc=$MOUNT_RC). DVI host 192.168.0.27 may be unreachable."
    alert_slack "mount failed (rc=$MOUNT_RC) — DVI host 192.168.0.27 may be unreachable"
    exit 1
fi

# Verify TRACE dir exists after mount
if [ ! -d "$TRACE_DIR" ]; then
    log "ERROR: mounted but TRACE directory not found at $TRACE_DIR"
    alert_slack "mounted but TRACE directory not found — manual investigation needed"
    exit 1
fi

log "Mount restored after: ${REMOUNT_REASON}"
alert_slack "remounted DVI share (${REMOUNT_REASON})"

# Give the mount a moment to stabilize
sleep 2

# Drop any wedged operations in the lab server by kickstarting it. Without
# this, the lab server stayed dead even after a successful remount because
# its in-flight dvi-sync `ls` calls continue to block the event loop for
# their full 300s timeout.
kickstart_lab_server
