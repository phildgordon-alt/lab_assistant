#!/bin/bash
# Apply Apple smbfs tuning to fix intermittent enumeration failures
# (empty `ls`, ENOENT for files that exist) on the DVI SMB mount.
# Root cause hypothesis: directory cache + SMB2 lease-break races with
# the Windows DVI host. notify_off=yes is the historical fix.
#
# IMPORTANT: nsmb.conf option names HAVE SHIFTED between macOS releases.
# Before running, validate every option below against the local man page:
#   man nsmb.conf
# on the Mac Studio. If an option name is wrong, the kernel silently
# ignores it and the share keeps misbehaving.
#
# REQUIRES sudo. Apply once on the Mac Studio. Then restart smb-watchdog
# and observe; if symptoms persist, run the diagnostic:
#   sudo log stream --predicate 'subsystem == "com.apple.smb"' --info --debug
#
# To revert: sudo rm /etc/nsmb.conf && launchctl kickstart -k gui/$(id -u)/com.paireyewear.labassistant.smb-watchdog

set -e

NSMB=/etc/nsmb.conf
BACKUP=/etc/nsmb.conf.bak.$(date +%Y%m%d_%H%M%S)

if [ -f "$NSMB" ]; then
  echo "Backing up existing $NSMB to $BACKUP"
  sudo cp "$NSMB" "$BACKUP"
fi

echo "Writing $NSMB..."
# Verified options for Darwin 25.3.0 (macOS): notify_off, protocol_vers_map,
# signing_required all confirmed in `man nsmb.conf` 2026-04-23. Earlier
# draft also included dir_cache_max/dir_cache_min/validate_neg_off — those
# do NOT exist on this version (grep on man page returned empty). Removed.
sudo tee "$NSMB" > /dev/null <<EOF
[default]
# Disable change-notify to stop directory-cache poisoning from lease breaks.
# Without this, macOS smbfs can return empty enumerations after a Windows
# client writes to a directory we have cached. THE primary fix for the
# intermittent ENOENT / empty-ls problem.
notify_off=yes

# Force SMB2/SMB3 only, never fall back to SMB1 (default value 7 = 1+2+3).
# SMB1 is deprecated and has known macOS interop bugs on directories with
# 100+ entries — TRACE/ has 165 LT*.DAT files, right in the danger zone.
protocol_vers_map=6

# Don't require server signing (DVI Windows host may not negotiate it).
signing_required=no
EOF

sudo chmod 644 "$NSMB"

echo ""
echo "Wrote $NSMB. To apply:"
echo "  1. Force-unmount the share if mounted:"
echo "       sudo umount -f /Users/Shared/lab_assistant/data/dvi/visdir"
echo "  2. Trigger watchdog to remount with new settings:"
echo "       launchctl kickstart -k gui/\$(id -u)/com.paireyewear.labassistant.smb-watchdog"
echo "  3. Verify:"
echo "       smbutil statshares -a"
echo "       ls /Users/Shared/lab_assistant/data/dvi/visdir/"
echo ""
echo "If symptoms PERSIST: capture diagnostic"
echo "  sudo log stream --predicate 'subsystem == \"com.apple.smb\"' --info --debug"
echo "and look for 'lease break' / 'notify' / 'reconnect' events."
echo ""
echo "To revert:"
echo "  sudo rm $NSMB && sudo cp $BACKUP $NSMB  # if backup exists"
echo "  launchctl kickstart -k gui/\$(id -u)/com.paireyewear.labassistant.smb-watchdog"
