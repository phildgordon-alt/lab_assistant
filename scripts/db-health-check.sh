#!/bin/bash
# Lab_Assistant DB Health Check wrapper.
# Runs the .sql script and prefixes 'ALERT:' to any line showing ALERT/ALERT-CRIT/EMPTY/ZERO/MIXED.
# Read-only, safe to run anytime. Expected runtime under 5 seconds.
set -euo pipefail
DB="${LAB_DB:-/Users/Shared/lab_assistant/data/lab_assistant.db}"
SQL="$(cd "$(dirname "$0")" && pwd)/db-health-check.sql"
[[ -f "$DB"  ]] || { echo "ALERT: DB not found at $DB" >&2; exit 1; }
[[ -f "$SQL" ]] || { echo "ALERT: SQL script missing at $SQL" >&2; exit 1; }
# Open via file: URI with mode=ro so the connection is read-only but the
# process-wide sqlite3 shell still accepts piped-in queries (plain -readonly
# fights with stdin on some builds — SQLITE_CANTOPEN per query).
# Match only when the STATUS token is the final word on the line (column output),
# so narrative prose containing "ALERT" etc. isn't flagged.
sqlite3 "file:${DB}?mode=ro" < "$SQL" | awk '
  /(ALERT-CRIT|ALERT|EMPTY|ZERO|MIXED|WARN)[[:space:]]*$/ { print "ALERT: " $0; next }
  { print }
'
