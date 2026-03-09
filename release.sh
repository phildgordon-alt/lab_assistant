#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# Lab_Assistant Release Script
# Bumps version, commits, tags, builds installer
# Usage: ./release.sh [patch|minor|major]
#   patch: 2.1.0 → 2.1.1 (bug fixes)
#   minor: 2.1.0 → 2.2.0 (new features)
#   major: 2.1.0 → 3.0.0 (breaking changes)
# ═══════════════════════════════════════════════════════════════════
set -e

BUMP="${1:-patch}"
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

# Validate bump type
if [[ "$BUMP" != "patch" && "$BUMP" != "minor" && "$BUMP" != "major" ]]; then
  echo "Usage: ./release.sh [patch|minor|major]"
  exit 1
fi

# Get current version
OLD_VER=$(node -e "console.log(require('./package.json').version)")
echo ""
echo "Current version: $OLD_VER"

# Bump version in package.json (no git tag — we do it manually)
NEW_VER=$(node -e "
  const v = '$OLD_VER'.split('.').map(Number);
  if ('$BUMP' === 'major') { v[0]++; v[1]=0; v[2]=0; }
  else if ('$BUMP' === 'minor') { v[1]++; v[2]=0; }
  else { v[2]++; }
  console.log(v.join('.'));
")

echo "New version:     $NEW_VER ($BUMP bump)"
echo ""
read -p "Proceed? (y/n) " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 0
fi

# Update package.json
node -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync('package.json','utf8'));
  pkg.version = '$NEW_VER';
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"
echo "✓ package.json → $NEW_VER"

# Update gateway package.json if it exists
if [ -f gateway/package.json ]; then
  node -e "
    const fs = require('fs');
    const pkg = JSON.parse(fs.readFileSync('gateway/package.json','utf8'));
    pkg.version = '$NEW_VER';
    fs.writeFileSync('gateway/package.json', JSON.stringify(pkg, null, 2) + '\n');
  "
  echo "✓ gateway/package.json → $NEW_VER"
fi

# Git commit + tag
git add package.json gateway/package.json 2>/dev/null
git commit -m "release: v${NEW_VER}"
git tag -a "v${NEW_VER}" -m "Lab_Assistant v${NEW_VER}"
echo "✓ Git commit + tag v${NEW_VER}"

# Build installer
echo ""
echo "Building installer..."
bash build-installer.sh

# Push
echo ""
read -p "Push to remote + tags? (y/n) " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
  git push origin main
  git push origin "v${NEW_VER}"
  echo "✓ Pushed to remote"
fi

echo ""
echo "═══════════════════════════════════════"
echo "  Released v${NEW_VER}"
echo "  Installer: Lab_Assistant_${NEW_VER}.pkg"
echo "═══════════════════════════════════════"
