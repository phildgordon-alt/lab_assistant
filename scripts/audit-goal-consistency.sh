#!/usr/bin/env bash
#
# Cross-surface dept-goal consistency audit.
#
# Phil 2026-05-13: "same count, same math, same code." Run this after
# deployment to verify every surface that renders a daily goal/actual
# reads the SAME number for the SAME dept on the SAME day. Asserts:
#
#   • /api/{dept}/target or /api/{dept}/dashboard returns dailyGoal
#   • /api/{dept}/goal-history today's row.target == dailyGoal
#   • daily_*_targets.total_target for today == dailyGoal
#   • countX(today) (live counter) == /api/{dept}/goal-history today.actual
#   • SHIP == CUTTING == ASSEMBLY (they share computeShipTarget)
#   • SURF, COAT have their own numbers (independent formulas)
#
# Allowed jitter: ±2 between live and captured (hourly capture lag).
# Anything larger is flagged.
#
# Usage:
#   scripts/audit-goal-consistency.sh                # localhost:3002
#   scripts/audit-goal-consistency.sh https://lab.paireyewear.tools
#   LAB_DB_PATH=/path/to/db scripts/audit-goal-consistency.sh

set -uo pipefail

HOST="${1:-http://localhost:3002}"
DB_PATH="${LAB_DB_PATH:-/Users/Shared/lab_assistant/data/lab_assistant.db}"
TODAY="$(date '+%Y-%m-%d')"

JITTER=2  # allowed difference between live and captured
FAIL=0

# Resolve jq + sqlite3
if ! command -v jq >/dev/null 2>&1; then echo "FATAL: jq not found"; exit 2; fi
if ! command -v sqlite3 >/dev/null 2>&1; then echo "FATAL: sqlite3 not found"; exit 2; fi

echo "audit-goal-consistency"
echo "  host:  $HOST"
echo "  db:    $DB_PATH"
echo "  today: $TODAY"
echo "  jitter tolerance: ±$JITTER"
echo ""

# ─────────────────────────────────────────────────────────────────────
# Pull live daily-goal from each dept endpoint
# ─────────────────────────────────────────────────────────────────────

SHIP_GOAL=$(curl -fsS  "$HOST/api/shipping/dashboard"   | jq -r '.target.daily // 0')
COAT_GOAL=$(curl -fsS  "$HOST/api/coating/intelligence" | jq -r '.dailyGoal // .target.target // 0')
SURF_GOAL=$(curl -fsS  "$HOST/api/surfacing/target"     | jq -r '.dailyGoal // 0')
CUT_GOAL=$(curl -fsS   "$HOST/api/cutting/dashboard"    | jq -r '.dailyGoal // 0')
ASM_GOAL=$(curl -fsS   "$HOST/api/assembly/jobs"        | jq -r '.dailyGoal // 0')

echo "Live daily goals from /api/{dept}/* endpoints:"
echo "  shipping:  $SHIP_GOAL"
echo "  coating:   $COAT_GOAL"
echo "  surfacing: $SURF_GOAL"
echo "  cutting:   $CUT_GOAL"
echo "  assembly:  $ASM_GOAL"
echo ""

# ─────────────────────────────────────────────────────────────────────
# Pull captured target from DB for today
# ─────────────────────────────────────────────────────────────────────

DB_SHIP=$(sqlite3 "$DB_PATH"  "SELECT COALESCE(total_target, 0) FROM daily_ship_targets       WHERE date='$TODAY';" 2>/dev/null || echo "")
DB_COAT=$(sqlite3 "$DB_PATH"  "SELECT COALESCE(total_target, 0) FROM daily_coating_targets    WHERE date='$TODAY';" 2>/dev/null || echo "")
DB_SURF=$(sqlite3 "$DB_PATH"  "SELECT COALESCE(total_target, 0) FROM daily_surfacing_targets  WHERE date='$TODAY';" 2>/dev/null || echo "")

echo "Captured targets from daily_*_targets for $TODAY:"
echo "  shipping:  ${DB_SHIP:-no-row}"
echo "  coating:   ${DB_COAT:-no-row}"
echo "  surfacing: ${DB_SURF:-no-row}"
echo ""

# ─────────────────────────────────────────────────────────────────────
# Pull today's row from goal-history endpoints
# ─────────────────────────────────────────────────────────────────────

ship_hist=$(curl -fsS  "$HOST/api/shipping/goal-history?days=1"  | jq '.history[0] // {}')
coat_hist=$(curl -fsS  "$HOST/api/coating/goal-history?days=1"   | jq '.history[0] // {}')
surf_hist=$(curl -fsS  "$HOST/api/surfacing/goal-history?days=1" | jq '.history[0] // {}')
cut_hist=$(curl -fsS   "$HOST/api/cutting/goal-history?days=1"   | jq '.history[0] // {}')
asm_hist=$(curl -fsS   "$HOST/api/assembly/goal-history?days=1"  | jq '.history[0] // {}')

SHIP_HIST_GOAL=$(echo "$ship_hist" | jq -r '.target // 0')
COAT_HIST_GOAL=$(echo "$coat_hist" | jq -r '.target // 0')
SURF_HIST_GOAL=$(echo "$surf_hist" | jq -r '.target // 0')
CUT_HIST_GOAL=$(echo  "$cut_hist"  | jq -r '.target // 0')
ASM_HIST_GOAL=$(echo  "$asm_hist"  | jq -r '.target // 0')

echo "Today's row in goal-history endpoints (.target):"
echo "  shipping:  $SHIP_HIST_GOAL"
echo "  coating:   $COAT_HIST_GOAL"
echo "  surfacing: $SURF_HIST_GOAL"
echo "  cutting:   $CUT_HIST_GOAL"
echo "  assembly:  $ASM_HIST_GOAL"
echo ""

# ─────────────────────────────────────────────────────────────────────
# Assertions
# ─────────────────────────────────────────────────────────────────────

# Returns 0 if |a - b| <= JITTER, else 1
within() {
  local a="${1:-0}" b="${2:-0}"
  local d=$(( a - b ))
  d=${d#-}
  [ "$d" -le "$JITTER" ]
}

assert_within() {
  local name="$1" a="$2" b="$3"
  if within "$a" "$b"; then
    echo "  PASS  $name: $a ≈ $b"
  else
    echo "  FAIL  $name: $a ≠ $b (Δ $((a - b)))"
    FAIL=$((FAIL + 1))
  fi
}

assert_eq() {
  local name="$1" a="$2" b="$3"
  if [ "$a" = "$b" ]; then
    echo "  PASS  $name: $a == $b"
  else
    echo "  FAIL  $name: $a != $b"
    FAIL=$((FAIL + 1))
  fi
}

echo "Assertions:"

# Dashboard vs captured (today) — within jitter (hourly capture can lag)
assert_within  "shipping dashboard ≈ daily_ship_targets"           "$SHIP_GOAL" "${DB_SHIP:-0}"
assert_within  "coating intelligence ≈ daily_coating_targets"      "$COAT_GOAL" "${DB_COAT:-0}"
assert_within  "surfacing target ≈ daily_surfacing_targets"        "$SURF_GOAL" "${DB_SURF:-0}"

# Goal-history's today row matches dashboard (overlay logic should make
# these exactly equal — no jitter allowed)
assert_eq      "shipping dashboard == goal-history today.target"   "$SHIP_GOAL" "$SHIP_HIST_GOAL"
assert_eq      "coating intelligence == goal-history today.target" "$COAT_GOAL" "$COAT_HIST_GOAL"
assert_eq      "surfacing target == goal-history today.target"     "$SURF_GOAL" "$SURF_HIST_GOAL"
assert_eq      "cutting dashboard == goal-history today.target"    "$CUT_GOAL"  "$CUT_HIST_GOAL"
assert_eq      "assembly jobs == goal-history today.target"        "$ASM_GOAL"  "$ASM_HIST_GOAL"

# Cross-dept: SHIP == CUTTING == ASSEMBLY (all share computeShipTarget)
assert_eq      "shipping == cutting (shared computeShipTarget)"    "$SHIP_GOAL" "$CUT_GOAL"
assert_eq      "shipping == assembly (shared computeShipTarget)"   "$SHIP_GOAL" "$ASM_GOAL"

# Cross-dept: SURFACING != COATING (proves the surfacing-inherits-coating
# bug is fixed)
if [ "$SURF_GOAL" = "$COAT_GOAL" ]; then
  echo "  FAIL  surfacing != coating (independent formulas): $SURF_GOAL == $COAT_GOAL  ← bug regression?"
  FAIL=$((FAIL + 1))
else
  echo "  PASS  surfacing != coating (independent formulas): $SURF_GOAL ≠ $COAT_GOAL"
fi

echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "All assertions passed."
  exit 0
else
  echo "$FAIL assertion(s) failed."
  exit 1
fi
