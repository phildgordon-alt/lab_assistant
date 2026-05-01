#!/bin/bash
# smb-mount-watchdog.sh — Checks DVI SMB mount and remounts on failure.
# Runs via launchd every 60 seconds.
#
# Failure modes handled (one probe per DVI source directory, not just TRACE):
#   1. Mount missing entirely — re-mount.
#   2. Mount exists but `test -d <subdir>` hangs — force unmount, remount.
#   3. Mount exists, ls succeeds, but newest file mtime is frozen (zombie mount
#      serving cached metadata) — force unmount, remount.
#
# 2026-04-21 incident — fixed by introducing the mtime liveness check (TRACE only).
# 2026-05-01 incident — TRACE was warm but `VISION/Q/jobexport` was zombied;
#   server hit ETIMEDOUT on next ls, kernel-pinned the new node PID, blocked port
#   3002 bind. Fix: probe every DVI-Sync source directory each cycle, not just
#   TRACE. Bound BOTH `test -d` AND `ls -t` with `perl alarm` — an unbounded
#   `ls -t` against a wedged share handle hangs forever, same way the inode
#   stat does.

MOUNT_POINT="/Users/Shared/lab_assistant/data/dvi/visdir"
SMB_URL="//dvi:dvi@192.168.0.27/visdir"
LAB_SERVER="http://localhost:3002"
LOG_TAG="[SMB-Watchdog]"

BUSINESS_HOUR_START=6
BUSINESS_HOUR_END=22
PROBE_TIMEOUT=15  # seconds — same alarm bound for both test -d and ls -t

# DVI source directories to probe each cycle. Format:
#   "subdir|liveness_window_min|glob|do_liveness"
# - subdir: path under $MOUNT_POINT
# - liveness_window_min: max age (in min) of newest matching file before flagging
#   STALE during business hours. Ignored when do_liveness=0.
# - glob: filename pattern for the `ls -t | head -1` probe. Must match files
#   that get freshly written in the normal flow of that source.
# - do_liveness: 1 = mtime advancement check during business hours; 0 = existence
#   probe only (for legitimately quiet dirs that may go hours without new files).
#
# Liveness windows reflect each dir's normal cadence (per dvi-sync.js schedule):
#   TRACE        — continuous LT*.DAT writes during business hours, 15-min stale window
#   jobexport    — high churn (~30s polls), 20-min stale window absorbs noise
#   SHIPLOG      — bursty, 1-2h quiet gaps normal off-shift, 120-min window
#   breakage     — low volume, legit hours-quiet, no liveness check
#   EXPORT/D     — once-per-day file, no liveness check
PROBE_TARGETS=(
  "TRACE|15|LT*.DAT|1"
  "VISION/Q/jobexport|20|*.xml|1"
  "VISION/SHIPLOG|120|*.xml|1"
  "VISION/LDS/breakage|0||0"
  "EXPORT/D|0||0"
)

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

# Probe one DVI subdirectory. Returns 0 if healthy, 1 if zombie/dead/stale.
# Both `test -d` and `ls -t` are wrapped in `perl alarm` — an unbounded ls
# against a wedged SMB share handle will hang the same as a wedged stat().
probe_subdir() {
    local subdir="$1" window="$2" glob="$3" do_liveness="$4"
    local full="${MOUNT_POINT}/${subdir}"

    # 1. Existence probe — bounded stat()
    if ! /usr/bin/perl -e 'alarm shift; exec @ARGV' "$PROBE_TIMEOUT" /bin/test -d "$full" >/dev/null 2>&1; then
        log "probe[${subdir}]: test -d hung or missing after ${PROBE_TIMEOUT}s — ZOMBIE"
        return 1
    fi

    # 2. Liveness probe — only during business hours, only for high-churn dirs
    if [ "$do_liveness" = "1" ] && in_business_hours; then
        local newest
        newest=$(/usr/bin/perl -e 'alarm shift; exec @ARGV' "$PROBE_TIMEOUT" \
            /bin/sh -c "ls -t ${full}/${glob} 2>/dev/null | head -1")
        if [ -z "$newest" ]; then
            # Empty enumeration could be a transient SMB read hiccup (we've seen
            # ls succeed seconds after returning empty). Don't trigger remount on
            # this alone — let next cycle retry. Same conservative posture as the
            # original TRACE-only check.
            log "probe[${subdir}]: no ${glob} visible this cycle — passing (retry next cycle)"
            return 0
        fi
        local mtime
        mtime=$(stat -f "%m" "$newest" 2>/dev/null)
        if [ -z "$mtime" ]; then
            log "probe[${subdir}]: stat failed on $(basename "$newest") — ZOMBIE"
            return 1
        fi
        local age_min=$(( ($(date +%s) - mtime) / 60 ))
        if [ "$age_min" -gt "$window" ]; then
            log "probe[${subdir}]: newest ${glob} is ${age_min}m old (threshold ${window}m) — STALE"
            return 1
        fi
    fi
    return 0
}

# Existence-only probe used after a fresh mount. Liveness windows would false-
# positive on the first cycle after a mount even if the share is healthy.
verify_subdir_exists() {
    local subdir="$1"
    local full="${MOUNT_POINT}/${subdir}"
    /usr/bin/perl -e 'alarm shift; exec @ARGV' "$PROBE_TIMEOUT" /bin/test -d "$full" >/dev/null 2>&1
}

# ── Main probe loop ─────────────────────────────────────────────────────────
if mount | grep -q "$MOUNT_POINT"; then
    HEALTHY=1
    FAILED_DIR=""
    for entry in "${PROBE_TARGETS[@]}"; do
        IFS='|' read -r subdir window glob do_liveness <<< "$entry"
        if ! probe_subdir "$subdir" "$window" "$glob" "$do_liveness"; then
            HEALTHY=0
            FAILED_DIR="$subdir"
            break
        fi
    done
    if [ "$HEALTHY" = "1" ]; then
        exit 0
    fi
    log "Mount unhealthy at ${FAILED_DIR} — forcing remount"
    diskutil unmount force "$MOUNT_POINT" 2>/dev/null || umount -f "$MOUNT_POINT" 2>/dev/null
    sleep 1
fi

# No active mount — verify mount point is clear before remounting
if mount | grep -q "$MOUNT_POINT"; then
    log "ERROR: could not unmount stale mount at $MOUNT_POINT"
    exit 1
fi

log "Mount missing — mounting SMB share"

# Ensure mount point exists
mkdir -p "$MOUNT_POINT" 2>/dev/null

# Mount
mount_smbfs "$SMB_URL" "$MOUNT_POINT" 2>&1
MOUNT_RC=$?

if [ $MOUNT_RC -ne 0 ]; then
    log "ERROR: mount failed (rc=$MOUNT_RC). DVI host 192.168.0.27 may be unreachable."
    exit 1
fi

# Verify ALL probe target subdirs are accessible after mount (existence only —
# liveness windows would false-positive on the first cycle after a fresh mount)
for entry in "${PROBE_TARGETS[@]}"; do
    IFS='|' read -r subdir _ _ _ <<< "$entry"
    if ! verify_subdir_exists "$subdir"; then
        log "ERROR: mounted but ${subdir} not accessible after ${PROBE_TIMEOUT}s"
        exit 1
    fi
done

log "Mount restored."

# Give the mount a moment to stabilize
sleep 2

# /api/dvi/trace/recover removed per Apr-17 incident plan (W2 followup):
# dvi-trace now self-heals via its own polling loop; the explicit POST was
# causing double-recovery races and is no longer needed.
