#!/bin/bash
#
# Set up persistent macOS SMB mount for DVI server.
# This replaces the Node.js SMB2 library (which breaks on Node 22 OpenSSL).
# macOS handles SMB cipher negotiation natively — no more cipher errors.
#
# Usage: sudo bash scripts/setup-dvi-mount.sh
#
# What it does:
# 1. Creates /Volumes/visdir mount point
# 2. Adds entry to /etc/auto_master + /etc/auto_smb for automount
# 3. Mount happens on first access, reconnects automatically
#
# After running, both dvi-trace and dvi-sync read from /Volumes/visdir as local files.

set -e

DVI_HOST="${DVI_SYNC_HOST:-192.168.0.27}"
DVI_USER="${DVI_SYNC_USER:-dvi}"
DVI_PASS="${DVI_SYNC_PASSWORD:-dvi}"
SHARE="visdir"
MOUNT_POINT="/Volumes/visdir"

echo "=== DVI SMB Mount Setup ==="
echo "Host: $DVI_HOST"
echo "User: $DVI_USER"
echo "Share: $SHARE"
echo "Mount: $MOUNT_POINT"
echo ""

# 1. Test connectivity
echo "Testing connection to $DVI_HOST:445..."
if ! nc -z -w5 "$DVI_HOST" 445 2>/dev/null; then
  echo "ERROR: Cannot reach $DVI_HOST on port 445 (SMB)"
  echo "Check that the DVI server is running and reachable on the network."
  exit 1
fi
echo "OK — SMB port reachable"

# 2. Create mount point
if [ ! -d "$MOUNT_POINT" ]; then
  echo "Creating $MOUNT_POINT..."
  mkdir -p "$MOUNT_POINT"
fi

# 3. Test mount
echo "Mounting //$DVI_USER@$DVI_HOST/$SHARE..."
mount_smbfs "//$DVI_USER:$DVI_PASS@$DVI_HOST/$SHARE" "$MOUNT_POINT" 2>/dev/null || {
  echo "ERROR: mount_smbfs failed"
  echo "Try manually: mount_smbfs '//$DVI_USER:$DVI_PASS@$DVI_HOST/$SHARE' $MOUNT_POINT"
  exit 1
}

# Verify
if [ -d "$MOUNT_POINT/TRACE" ]; then
  echo "OK — TRACE directory found"
  ls "$MOUNT_POINT/TRACE"/LT*.DAT 2>/dev/null | tail -3
else
  echo "WARNING: TRACE directory not found at $MOUNT_POINT/TRACE"
  echo "Contents of $MOUNT_POINT:"
  ls "$MOUNT_POINT/" 2>/dev/null || echo "(empty)"
fi

echo ""
echo "=== Mount successful ==="
echo ""
echo "Add to Mac Studio .env:"
echo "  DVI_TRACE_LOCAL_PATH=$MOUNT_POINT/TRACE"
echo ""
echo "To make persistent across reboots, add to /etc/fstab:"
echo "  //$DVI_USER:$DVI_PASS@$DVI_HOST/$SHARE $MOUNT_POINT smbfs -N 0 0"
echo ""
echo "Or add a launchd plist that runs mount_smbfs at boot."
