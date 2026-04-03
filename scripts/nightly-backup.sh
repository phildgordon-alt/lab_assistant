#!/bin/bash
# Nightly database backup — run via launchd at 1 AM
BACKUP_DIR="/Users/Shared/lab_assistant/backups"
DB_PATH="/Users/Shared/lab_assistant/data/lab_assistant.db"
mkdir -p "$BACKUP_DIR"
cp "$DB_PATH" "$BACKUP_DIR/lab_assistant_$(date +%Y%m%d).db"
# Keep only last 30 days
find "$BACKUP_DIR" -name "lab_assistant_*.db" -mtime +30 -delete
