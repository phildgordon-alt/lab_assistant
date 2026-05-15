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

/**
 * Phil 2026-05-14: classify SV vs SURF from the PICK SKU (or OPC if
 * pick not yet populated). Used by coating-target.js v4 + surfacing-
 * target.js v3 because `lens_type` in jobs often holds DVI recipe
 * codes ('AR', 'BLUE_CUT') instead of S/C/P/B markers, so classify()
 * returns UNKNOWN for most live jobs. The pick SKU itself encodes the
 * lens family via prefix range — that's the reliable signal until/if
 * lens_type is backfilled across the dataset.
 *
 * Prefix ranges (Phil 2026-05-14, to be verified against prod data):
 *   - 062xxxxxx — SV finished lens (single vision, pre-coated by supplier)
 *   - 480xxxxxx — semi-finished puck (must be surfaced + coated → SURF)
 *
 * Adjust SV_PREFIXES / SURF_PREFIXES if Phil discovers other ranges in
 * use. Anything not matching either range → UNKNOWN (caller decides
 * whether to default-to-SURF for safety in upstream demand counts).
 *
 * @param {string|null|undefined} pickOrOpc - lens_pick_r/_l or fallback lens_opc_r/_l
 * @returns {'SV'|'SURF'|'UNKNOWN'}
 */
const SV_PREFIXES   = ['062'];
const SURF_PREFIXES = ['480'];

function classifyByPick(pickOrOpc) {
  const s = String(pickOrOpc || '').trim();
  if (!s) return 'UNKNOWN';
  for (const p of SV_PREFIXES)   if (s.startsWith(p)) return 'SV';
  for (const p of SURF_PREFIXES) if (s.startsWith(p)) return 'SURF';
  return 'UNKNOWN';
}

/**
 * Classify a job row using the most reliable available signal.
 * Order of preference:
 *   1. lens_pick_r / lens_pick_l (post-pick: actual SKU picked)
 *   2. lens_opc_r / lens_opc_l   (pre-pick: planned SKU per Rx)
 *   3. lens_type (S/C/P/B markers — usually missing in DVI data)
 * Returns 'SV'|'SURF'|'UNKNOWN'.
 */
function classifyJobRow(job) {
  if (!job) return 'UNKNOWN';
  const candidates = [job.lens_pick_r, job.lens_pick_l, job.lens_opc_r, job.lens_opc_l];
  for (const c of candidates) {
    const t = classifyByPick(c);
    if (t !== 'UNKNOWN') return t;
  }
  return classify(job.lens_type);
}

module.exports = {
  classify,
  classifyLabel,
  classifyByPick,
  classifyJobRow,
  agingSlaDays,
  SLA_WORKDAYS,
  SV_PREFIXES,
  SURF_PREFIXES,
};
