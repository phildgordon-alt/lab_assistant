#!/bin/bash
#
# Backfill all DVI files from the SMB mount that were missed during the outage.
# Compares mount vs local directories and copies missing files.
#
# Usage: bash scripts/backfill-dvi-from-mount.sh [days_back]
# Default: 3 days back
#

MOUNT="/Users/Shared/lab_assistant/data/dvi/mount"
DATA="/Users/Shared/lab_assistant/data/dvi"
DAYS_BACK="${1:-3}"

if [ ! -d "$MOUNT" ]; then
  echo "ERROR: Mount not found at $MOUNT"
  exit 1
fi

echo "=== DVI File Backfill ==="
echo "Mount: $MOUNT"
echo "Local: $DATA"
echo "Looking back: $DAYS_BACK days"
echo ""

TOTAL_COPIED=0

# ── 1. Shipped Invoices (XML) ──────────────────────────────────
echo "--- Shipped Invoices (VISION/SHIPLOG → data/dvi/shipped) ---"
mkdir -p "$DATA/shipped"
COPIED=0
for f in "$MOUNT/VISION/SHIPLOG"/*.xml; do
  [ -f "$f" ] || continue
  name=$(basename "$f")
  # Check if modified in last N days
  if [ "$(uname)" = "Darwin" ]; then
    if ! find "$f" -mtime -${DAYS_BACK} -print -quit 2>/dev/null | grep -q .; then
      continue
    fi
  fi
  if [ ! -f "$DATA/shipped/$name" ]; then
    cp "$f" "$DATA/shipped/$name"
    COPIED=$((COPIED + 1))
  fi
done
echo "  Copied: $COPIED new files"
TOTAL_COPIED=$((TOTAL_COPIED + COPIED))

# ── 2. Breakage Reports (TXT) ──────────────────────────────────
echo "--- Breakage Reports (VISION/LDS/breakage → data/dvi/breakage) ---"
mkdir -p "$DATA/breakage"
COPIED=0
if [ -d "$MOUNT/VISION/LDS/breakage" ]; then
  for f in "$MOUNT/VISION/LDS/breakage"/*.txt; do
    [ -f "$f" ] || continue
    name=$(basename "$f")
    if [ "$(uname)" = "Darwin" ]; then
      if ! find "$f" -mtime -${DAYS_BACK} -print -quit 2>/dev/null | grep -q .; then
        continue
      fi
    fi
    if [ ! -f "$DATA/breakage/$name" ]; then
      cp "$f" "$DATA/breakage/$name"
      COPIED=$((COPIED + 1))
    fi
  done
else
  echo "  WARNING: breakage directory not found on mount"
fi
echo "  Copied: $COPIED new files"
TOTAL_COPIED=$((TOTAL_COPIED + COPIED))

# ── 3. Job Export (XML/JSON) ──────────────────────────────────
echo "--- Job Export (VISION/Q/jobexport → data/dvi/jobs) ---"
mkdir -p "$DATA/jobs"
COPIED=0
if [ -d "$MOUNT/VISION/Q/jobexport" ]; then
  for f in "$MOUNT/VISION/Q/jobexport"/*.xml "$MOUNT/VISION/Q/jobexport"/*.json; do
    [ -f "$f" ] || continue
    name=$(basename "$f")
    if [ "$(uname)" = "Darwin" ]; then
      if ! find "$f" -mtime -${DAYS_BACK} -print -quit 2>/dev/null | grep -q .; then
        continue
      fi
    fi
    if [ ! -f "$DATA/jobs/$name" ]; then
      cp "$f" "$DATA/jobs/$name"
      COPIED=$((COPIED + 1))
    fi
  done
else
  echo "  WARNING: jobexport directory not found on mount"
fi
echo "  Copied: $COPIED new files"
TOTAL_COPIED=$((TOTAL_COPIED + COPIED))

# ── 4. Daily Job Export (TXT) ──────────────────────────────────
echo "--- Daily Job Export (EXPORT/D → data/dvi/daily) ---"
mkdir -p "$DATA/daily"
COPIED=0
if [ -d "$MOUNT/EXPORT/D" ]; then
  for f in "$MOUNT/EXPORT/D"/*.txt; do
    [ -f "$f" ] || continue
    name=$(basename "$f")
    if [ "$(uname)" = "Darwin" ]; then
      if ! find "$f" -mtime -${DAYS_BACK} -print -quit 2>/dev/null | grep -q .; then
        continue
      fi
    fi
    if [ ! -f "$DATA/daily/$name" ]; then
      cp "$f" "$DATA/daily/$name"
      COPIED=$((COPIED + 1))
    fi
  done
else
  echo "  WARNING: EXPORT/D directory not found on mount"
fi
echo "  Copied: $COPIED new files"
TOTAL_COPIED=$((TOTAL_COPIED + COPIED))

# ── 5. Trace files (DAT) — already read live, but verify ──────
echo "--- Trace Files (TRACE → verified via DVI_TRACE_LOCAL_PATH) ---"
TODAY=$(date +%y%m%d)
if [ -f "$MOUNT/TRACE/LT${TODAY}.DAT" ]; then
  SIZE=$(stat -f%z "$MOUNT/TRACE/LT${TODAY}.DAT" 2>/dev/null || stat -c%s "$MOUNT/TRACE/LT${TODAY}.DAT" 2>/dev/null)
  echo "  Today's trace (LT${TODAY}.DAT): ${SIZE} bytes — OK"
else
  echo "  WARNING: Today's trace file not found"
fi

echo ""
echo "=== TOTAL: $TOTAL_COPIED files copied ==="

if [ $TOTAL_COPIED -gt 0 ]; then
  echo ""
  echo "Files copied. If the server is running, dvi-sync will pick up"
  echo "shipped XMLs automatically. For daily exports, run:"
  echo "  node rebuild_dvi_from_daily.js"
fi
