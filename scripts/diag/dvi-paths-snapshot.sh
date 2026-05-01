#!/usr/bin/env bash
# dvi-paths-snapshot.sh — Phase 0 one-shot DVI path enumeration.
#
# Read-only. Every probe is bounded by `perl alarm` so a wedged SMB subdir
# can't hang the script. Output goes to data/path-verification-<timestamp>.log
# AND to stdout (so the operator can paste it back).
#
# Usage: bash scripts/diag/dvi-paths-snapshot.sh
#
# What it does:
#   1. Reports mount status for the visdir SMB share.
#   2. Lists the top-level entries of the mount.
#   3. Probes EVERY suspected DVI source path with a bounded test -d + ls -wc.
#   4. Probes ALTERNATIVE path candidates in case DVI reorganized the share
#      (e.g. paths without VISION prefix, or under different parents).
#   5. Lists every directory under VISION/ and EXPORT/ definitively.
#   6. Pulls 3 newest entries from each path that exists, as a sample.
#   7. Lists the local mirror dirs (data/dvi/jobs, shipped, breakage, daily).

set -u

MOUNT=/Users/Shared/lab_assistant/data/dvi/visdir
LOG_DIR=/Users/Shared/lab_assistant/data
LOG="${LOG_DIR}/path-verification-$(date +%Y%m%d-%H%M%S).log"

# Bounded test -d helper. Returns 0 if dir exists, 1 if missing OR hung.
exists_bounded() {
    /usr/bin/perl -e 'alarm 10; exec @ARGV' /bin/test -d "$1" >/dev/null 2>&1
}

# Bounded file count for a directory. Echoes the count or "?" on hang/miss.
count_bounded() {
    local n
    n=$(/usr/bin/perl -e 'alarm 15; exec @ARGV' /bin/sh -c "/bin/ls '$1' 2>/dev/null | wc -l" 2>/dev/null | tr -d ' ')
    echo "${n:-?}"
}

probe() {
    local label="$1" path="$2"
    if exists_bounded "$path"; then
        local n=$(count_bounded "$path")
        printf "  EXISTS  %-32s files=%-6s  %s\n" "$label" "$n" "$path"
    else
        printf "  MISSING %-32s                 %s\n" "$label" "$path"
    fi
}

{
    echo "=========================================================="
    echo "DVI Path Verification — $(date '+%Y-%m-%d %H:%M:%S %Z')"
    echo "=========================================================="
    echo
    echo "## Mount status"
    if mount | grep visdir; then :; else echo "  (no visdir mount currently active)"; fi
    echo
    echo "## Top-level enumeration of $MOUNT"
    /usr/bin/perl -e 'alarm 30; exec @ARGV' /bin/ls -la "$MOUNT/" 2>&1 | head -30
    echo
    echo "## Configured DVI source paths (per config/dvi-sync.json)"
    probe "TRACE (live tail)"            "$MOUNT/TRACE"
    probe "VISION (parent)"              "$MOUNT/VISION"
    probe "VISION/Q (parent)"            "$MOUNT/VISION/Q"
    probe "VISION/Q/jobexport"           "$MOUNT/VISION/Q/jobexport"
    probe "VISION/SHIPLOG"               "$MOUNT/VISION/SHIPLOG"
    probe "VISION/LDS (parent)"          "$MOUNT/VISION/LDS"
    probe "VISION/LDS/breakage"          "$MOUNT/VISION/LDS/breakage"
    probe "EXPORT (parent)"              "$MOUNT/EXPORT"
    probe "EXPORT/D"                     "$MOUNT/EXPORT/D"
    echo
    echo "## Alternative path candidates (in case the share was reorganized)"
    probe "alt: jobexport at root"       "$MOUNT/jobexport"
    probe "alt: SHIPLOG at root"         "$MOUNT/SHIPLOG"
    probe "alt: breakage at root"        "$MOUNT/breakage"
    probe "alt: D at root"               "$MOUNT/D"
    probe "alt: VISION/jobexport"        "$MOUNT/VISION/jobexport"
    probe "alt: VISION/jobs"             "$MOUNT/VISION/jobs"
    probe "alt: VISION/breakage"         "$MOUNT/VISION/breakage"
    probe "alt: VISION/SHIP"             "$MOUNT/VISION/SHIP"
    probe "alt: VISION/Q/jobs"           "$MOUNT/VISION/Q/jobs"
    probe "alt: VISION/Q/JOBEXPORT"      "$MOUNT/VISION/Q/JOBEXPORT"
    echo
    echo "## Full VISION/ subdir list (definitive — only directories)"
    /usr/bin/perl -e 'alarm 30; exec @ARGV' /bin/ls -la "$MOUNT/VISION/" 2>&1 | grep '^d' | head -40
    echo
    echo "## Full EXPORT/ subdir list (definitive — only directories)"
    /usr/bin/perl -e 'alarm 15; exec @ARGV' /bin/ls -la "$MOUNT/EXPORT/" 2>&1 | grep '^d' | head -20
    echo
    echo "## Samples (newest 3 per path that exists)"
    for p in "TRACE" "VISION/Q/jobexport" "VISION/SHIPLOG" "VISION/LDS/breakage" "EXPORT/D"; do
        if exists_bounded "$MOUNT/$p"; then
            echo "  ── $p ─────────────"
            /usr/bin/perl -e 'alarm 30; exec @ARGV' /bin/sh -c "/bin/ls -lt '$MOUNT/$p/' 2>&1 | head -4" 2>/dev/null
        fi
    done
    echo
    echo "## Local mirror dirs (sibling of visdir/)"
    /bin/ls -la /Users/Shared/lab_assistant/data/dvi/ | head -15
    echo
    echo "=========================================================="
    echo "END  $(date '+%Y-%m-%d %H:%M:%S %Z')"
    echo "=========================================================="
} 2>&1 | tee "$LOG"

echo
echo "Saved to: $LOG"
