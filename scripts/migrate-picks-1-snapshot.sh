#!/bin/bash
# Migration step 1/4 — snapshot the prod DB before any picks_history changes.
# This is the rollback point for steps 2-4. Cheap and fast (~5 sec).
#
# Usage:
#   bash scripts/migrate-picks-1-snapshot.sh
#
# Output: /Users/Shared/lab_assistant/data/backups/lab_assistant.db.pre-picks-canonical-YYYY-MM-DD-HHMM

set -e

DB="${LAB_DB:-/Users/Shared/lab_assistant/data/lab_assistant.db}"
BACKUP_DIR="${BACKUP_DIR:-/Users/Shared/lab_assistant/data/backups}"
STAMP=$(date '+%Y-%m-%d-%H%M')
DEST="${BACKUP_DIR}/lab_assistant.db.pre-picks-canonical-${STAMP}"

if [ ! -f "$DB" ]; then
  echo "ERROR: DB not found at $DB"
  exit 1
fi

mkdir -p "$BACKUP_DIR"

echo "── Snapshotting $DB → $DEST ──"
# Use sqlite3 .backup so we get a consistent copy even with the server holding it open
sqlite3 "$DB" ".backup '$DEST'"

SRC_BYTES=$(stat -f%z "$DB")
DST_BYTES=$(stat -f%z "$DEST")
echo "  Source: $SRC_BYTES bytes"
echo "  Backup: $DST_BYTES bytes"

if [ "$SRC_BYTES" != "$DST_BYTES" ]; then
  echo "  WARNING: byte counts differ — sqlite .backup truncates/recompresses, this is usually OK if WAL was active"
fi

echo ""
echo "Snapshot complete. To roll back:"
echo "  cp '$DEST' '$DB'"
echo "  launchctl kickstart -k gui/\$(id -u)/com.paireyewear.labassistant.server"
echo ""
echo "Next: bash scripts/migrate-picks-2-backfill.sh"
