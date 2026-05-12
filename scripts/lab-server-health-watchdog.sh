#!/bin/bash
# lab-server-health-watchdog.sh — External health probe + auto-recovery.
#
# Runs every 60s via launchd. Hits the lab server's /api/db/status. If it
# fails three times in a row, kickstarts the server and pings Slack.
#
# Rationale (2026-05-12): the smb-watchdog catches SMB-side problems. But
# the lab server can also wedge on its own for reasons unrelated to SMB:
# a slow SQL query, a hung middleware, an in-flight long fetch. We need a
# health probe that doesn't trust ANY internal state — just "is the HTTP
# handler responding within 10 seconds." This is the failsafe that lets
# you sleep through the night.
#
# Failure counter is persisted in a small state file so a single transient
# 1-failure cycle doesn't trigger a restart. Three consecutive failures
# (3 minutes of unresponsiveness) is the threshold.

LAB_SERVER_URL="${LAB_SERVER_URL:-http://localhost:3002/api/db/status}"
STATE_FILE="/tmp/lab-server-health-watchdog.state"
CONSECUTIVE_THRESHOLD=3
PROBE_TIMEOUT_SEC=10
LOG_TAG="[LabHealth-Watchdog]"

: "${SLACK_WEBHOOK_URL:=}"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') ${LOG_TAG} $1"; }

alert_slack() {
    [ -z "$SLACK_WEBHOOK_URL" ] && return 0
    local msg="$1"
    curl -sS -m 5 -X POST -H 'Content-Type: application/json' \
         -d "{\"text\":\"⚕️ LabHealth: ${msg}\"}" \
         "$SLACK_WEBHOOK_URL" >/dev/null 2>&1 || true
}

# Read current consecutive-failure count
fail_count=0
[ -f "$STATE_FILE" ] && fail_count=$(cat "$STATE_FILE" 2>/dev/null || echo 0)
[ -z "$fail_count" ] && fail_count=0

# Probe. -m sets total timeout; -sS = silent but show errors; -o /dev/null
# discards body since we only care about HTTP status. -w prints just the code.
http_code=$(curl -sS -m "$PROBE_TIMEOUT_SEC" -o /dev/null -w '%{http_code}' \
            "$LAB_SERVER_URL" 2>/dev/null)
curl_rc=$?

if [ "$curl_rc" -eq 0 ] && [ "$http_code" = "200" ]; then
    # Healthy. If we had been failing, log the recovery.
    if [ "$fail_count" -gt 0 ]; then
        log "recovered after ${fail_count} consecutive failure(s)"
        alert_slack "lab server recovered after ${fail_count} consecutive failure(s)"
    fi
    echo 0 > "$STATE_FILE"
    exit 0
fi

# Unhealthy this cycle. Increment counter.
fail_count=$((fail_count + 1))
echo "$fail_count" > "$STATE_FILE"
log "probe failed (curl_rc=${curl_rc}, http=${http_code:-none}, fail_count=${fail_count}/${CONSECUTIVE_THRESHOLD})"

if [ "$fail_count" -lt "$CONSECUTIVE_THRESHOLD" ]; then
    # Below threshold — wait for next cycle. Transient failures are common.
    exit 0
fi

# Three or more consecutive failures — kickstart.
log "threshold reached (${fail_count} consecutive failures) — kickstarting lab server"
alert_slack "lab server unresponsive for ${fail_count} consecutive cycles (≥${CONSECUTIVE_THRESHOLD}min) — auto-restarting"

uid=$(id -u)
launchctl kickstart -k "gui/${uid}/com.paireyewear.labassistant.server" 2>&1 | while read line; do
    log "kickstart: $line"
done

# Reset counter — the kickstart attempt is itself a recovery action. Next
# cycle will probe afresh.
echo 0 > "$STATE_FILE"
