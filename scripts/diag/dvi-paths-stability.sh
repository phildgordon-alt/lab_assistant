#!/usr/bin/env bash
# dvi-paths-stability.sh — Phase 0 stability sweep.
#
# Probes each suspected DVI source path every 60 seconds for 30 cycles
# (30 minutes total). Distinguishes "exists right now" from "transiently
# vanishes" — which the planner identified as the dominant pattern with
# this SMB share.
#
# Read-only. Bounded probes. Output goes to data/path-stability-<ts>.log
# AND to stdout. Designed to be backgroundable:
#
#   nohup bash scripts/diag/dvi-paths-stability.sh > /dev/null 2>&1 &
#
# Or to run in foreground and watch:
#
#   bash scripts/diag/dvi-paths-stability.sh
#
# At end, prints a summary table:
#   target | present_count | missing_count | flip_count | first_state | last_state

set -u

MOUNT=/Users/Shared/lab_assistant/data/dvi/visdir
LOG_DIR=/Users/Shared/lab_assistant/data
LOG="${LOG_DIR}/path-stability-$(date +%Y%m%d-%H%M).log"

CYCLES="${CYCLES:-30}"
CYCLE_INTERVAL_SEC="${CYCLE_INTERVAL_SEC:-60}"

# Targets — same as snapshot script's primary list, plus TRACE as a control.
TARGETS=(
    "TRACE"
    "VISION/Q/jobexport"
    "VISION/SHIPLOG"
    "VISION/LDS/breakage"
    "EXPORT/D"
)

# Bounded test -d. Returns 0 if exists, 1 if missing or hung.
exists_bounded() {
    /usr/bin/perl -e 'alarm 8; exec @ARGV' /bin/test -d "$1" >/dev/null 2>&1
}

count_bounded() {
    local n
    n=$(/usr/bin/perl -e 'alarm 10; exec @ARGV' /bin/sh -c "/bin/ls '$1' 2>/dev/null | wc -l" 2>/dev/null | tr -d ' ')
    echo "${n:-?}"
}

# Per-target counters
declare -A PRESENT_COUNT
declare -A MISSING_COUNT
declare -A FIRST_STATE
declare -A LAST_STATE
declare -A FLIP_COUNT

for t in "${TARGETS[@]}"; do
    PRESENT_COUNT["$t"]=0
    MISSING_COUNT["$t"]=0
    FIRST_STATE["$t"]=""
    LAST_STATE["$t"]=""
    FLIP_COUNT["$t"]=0
done

{
    echo "=========================================================="
    echo "DVI Path Stability Sweep — $(date '+%Y-%m-%d %H:%M:%S %Z')"
    echo "Cycles=${CYCLES}  Interval=${CYCLE_INTERVAL_SEC}s  Total=$((CYCLES * CYCLE_INTERVAL_SEC / 60))min"
    echo "=========================================================="
    echo

    for cycle in $(seq 1 "$CYCLES"); do
        ts=$(date '+%Y-%m-%d %H:%M:%S')
        for t in "${TARGETS[@]}"; do
            if exists_bounded "$MOUNT/$t"; then
                state="PRESENT"
                n=$(count_bounded "$MOUNT/$t")
                PRESENT_COUNT["$t"]=$((${PRESENT_COUNT["$t"]} + 1))
                printf "%s cycle=%-3d %-25s %s files=%s\n" "$ts" "$cycle" "$t" "$state" "$n"
            else
                state="MISSING"
                MISSING_COUNT["$t"]=$((${MISSING_COUNT["$t"]} + 1))
                printf "%s cycle=%-3d %-25s %s\n" "$ts" "$cycle" "$t" "$state"
            fi

            if [ -z "${FIRST_STATE["$t"]}" ]; then
                FIRST_STATE["$t"]="$state"
            fi
            if [ -n "${LAST_STATE["$t"]}" ] && [ "${LAST_STATE["$t"]}" != "$state" ]; then
                FLIP_COUNT["$t"]=$((${FLIP_COUNT["$t"]} + 1))
            fi
            LAST_STATE["$t"]="$state"
        done

        # Don't sleep after the final cycle
        if [ "$cycle" -lt "$CYCLES" ]; then
            sleep "$CYCLE_INTERVAL_SEC"
        fi
    done

    echo
    echo "=========================================================="
    echo "SUMMARY  $(date '+%Y-%m-%d %H:%M:%S %Z')"
    echo "=========================================================="
    printf "%-25s %-8s %-8s %-6s %-9s %-9s\n" "TARGET" "PRESENT" "MISSING" "FLIPS" "FIRST" "LAST"
    for t in "${TARGETS[@]}"; do
        printf "%-25s %-8d %-8d %-6d %-9s %-9s\n" \
            "$t" \
            "${PRESENT_COUNT["$t"]}" \
            "${MISSING_COUNT["$t"]}" \
            "${FLIP_COUNT["$t"]}" \
            "${FIRST_STATE["$t"]}" \
            "${LAST_STATE["$t"]}"
    done
    echo
    echo "Verdict per target:"
    for t in "${TARGETS[@]}"; do
        p="${PRESENT_COUNT["$t"]}"
        m="${MISSING_COUNT["$t"]}"
        f="${FLIP_COUNT["$t"]}"
        if [ "$p" -eq "$CYCLES" ]; then
            echo "  $t: STABLE-PRESENT (path is correct, no transient vanishing observed)"
        elif [ "$m" -eq "$CYCLES" ]; then
            echo "  $t: STABLE-MISSING (path is wrong OR share has been broken the whole sweep)"
        elif [ "$f" -gt 0 ]; then
            echo "  $t: TRANSIENT (flipped $f times — present $p / missing $m)"
        fi
    done
    echo
    echo "=========================================================="
    echo "END  $(date '+%Y-%m-%d %H:%M:%S %Z')"
    echo "=========================================================="
} 2>&1 | tee "$LOG"

echo
echo "Full log: $LOG"
