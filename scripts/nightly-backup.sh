#!/bin/bash
# Nightly database backup — runs via launchd at 02:30 PT
# Uses SQLite's online .backup API (safe with WAL + active writers).
# Previous version used `cp` which is unsafe on a live WAL-mode DB.

set -euo pipefail

BACKUP_DIR="/Users/Shared/lab_assistant/backups"
DB_PATH="/Users/Shared/lab_assistant/data/lab_assistant.db"
LOG="$BACKUP_DIR/backup.log"
STAMP=$(date +%Y%m%d-%H%M)
OUT="$BACKUP_DIR/lab_assistant_${STAMP}.db"

mkdir -p "$BACKUP_DIR"
echo "[$(date)] START backup -> $OUT" >> "$LOG"

if sqlite3 "$DB_PATH" ".backup $OUT" >> "$LOG" 2>&1; then
  SIZE=$(ls -lh "$OUT" | awk '{print $5}')
  echo "[$(date)] OK backup complete, size=$SIZE" >> "$LOG"
else
  echo "[$(date)] FAIL backup exited non-zero" >> "$LOG"
  rm -f "$OUT"
  exit 1
fi

# Verify the backup opens and has expected tables
if ! sqlite3 "$OUT" "SELECT COUNT(*) FROM sqlite_master WHERE type='table';" >> "$LOG" 2>&1; then
  echo "[$(date)] FAIL backup verification failed" >> "$LOG"
  rm -f "$OUT"
  exit 1
fi

# Retention: keep last 30 days
find "$BACKUP_DIR" -name "lab_assistant_*.db" -mtime +30 -delete
echo "[$(date)] DONE" >> "$LOG"
