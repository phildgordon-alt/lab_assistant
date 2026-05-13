'use strict';

/**
 * Canonical lens classifier — SV / SURF / UNKNOWN.
 *
 * Phil 2026-05-13: "same count, same math, same code." This module is
 * the SOLE source of truth for the SV/SURF/UNKNOWN bucketing used by
 * every daily-goal formula in the lab. Previously the same 3-line
 * rule was duplicated in 5+ places (ship-target.js, three sites in
 * oven-timer-server.js, OverviewTab.jsx, flow-agent.js) and drifted.
 *
 * lens_type taxonomy (from DVI XML, see oven-timer-server.js:489):
 *   S = single vision
 *   C = custom/aspheric SV (treated as SV in NPI and coating-queue)
 *   P = progressive
 *   B = bifocal
 *   NULL/other = unknown (lens-type recovery hasn't backfilled yet)
 *
 * SLA tiers (in workdays):
 *   SV      → 2  (S, C)
 *   SURF    → 3  (P, B)
 *   UNKNOWN → 2.3 (70/30 SV/SURF blend — biases unknowns toward the
 *                   tighter SLA so they pressure the target reasonably
 *                   instead of all rolling into surfacing's 3-day
 *                   fraction — the v1 bug that produced 670 vs 1500
 *                   expected, per ship-target.js header history)
 *
 * IMPORTANT — what this is NOT:
 * - This is NOT a lens-LINE classifier. The flow-agent uses an extended
 *   classifier that also looks at `_semiFinishedSkus.has(opc)` to
 *   classify by SKU substitution rules. Do not collapse them.
 * - This is NOT an aging-hours classifier. The aging_alert card in
 *   OverviewTab.jsx uses hours-based thresholds (24h/48h) which is a
 *   separate UI rule, not an SLA-target rule.
 */

const SLA_WORKDAYS = {
  SV:      2,
  SURF:    3,
  UNKNOWN: 2.3,
};

/**
 * Classify a lens type into the SV/SURF/UNKNOWN bucket used by every
 * daily-goal formula. Pure function — no DB, no time, no state.
 *
 * @param {string|null|undefined} lensType - raw lens_type from DVI XML
 * @returns {'SV'|'SURF'|'UNKNOWN'}
 */
function classify(lensType) {
  const lt = String(lensType || '').toUpperCase().trim();
  if (lt === 'S' || lt === 'C') return 'SV';
  if (lt === 'P' || lt === 'B') return 'SURF';
  return 'UNKNOWN';
}

/**
 * Long-form label used by the aging endpoint's per-job classification
 * and any UI surface that wants the spelled-out tier name. Returns
 * 'Single Vision' / 'Surfacing' / 'Unknown'.
 */
function classifyLabel(lensType) {
  const tier = classify(lensType);
  if (tier === 'SV')   return 'Single Vision';
  if (tier === 'SURF') return 'Surfacing';
  return 'Unknown';
}

/**
 * Aging endpoint's SLA-target convention: SV jobs get 2 days, Surfacing
 * and Unknown both get 3 days (conservative — avoids misclassifying a
 * Surfacing job as over-SLA on the SV 2-day target). Returns days, not
 * workdays (the aging UI is calendar-day driven, not workday driven).
 *
 * Note: this is DIFFERENT from SLA_WORKDAYS (which is workdays and uses
 * UNKNOWN=2.3 for blended weight in the target formula). Both rules
 * are legitimately different — keep separate.
 */
function agingSlaDays(lensType) {
  const tier = classify(lensType);
  return tier === 'SV' ? 2 : 3;
}

module.exports = {
  classify,
  classifyLabel,
  agingSlaDays,
  SLA_WORKDAYS,
};
