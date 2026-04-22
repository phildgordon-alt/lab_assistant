/**
 * long-tail-analysis.js — Stock vs Surface Decision Engine
 *
 * Determines which lens SKUs should be stocked (finished) vs sent to surfacing
 * based on break-even analysis: carrying cost of stocking low-volume SKUs
 * vs the surfacing premium per lens.
 *
 * Logic from Lens_Planning_V3.xlsx Long Tail Analysis sheet.
 *
 * Break-even formula:
 *   break_even_units = (surfacing_premium × 12) / (lens_cost × carrying_pct)
 *   If monthly volume < break_even → cheaper to surface than stock
 *
 * Parameters (configurable in DB):
 * - Low runner threshold: default 3 units/month
 * - Carrying cost %: default 25% annually
 * - Per-material: finished lens cost, surfacing premium
 */

'use strict';

let _semifinishedSet = null;  // lazy-loaded from db; invalidate after backfill

// Default cost inputs by material type
const MATERIAL_COSTS = {
  PLY:  { lensCost: 3.00, surfPremium: 2.00, name: 'Polycarbonate SV' },
  BLY:  { lensCost: 5.00, surfPremium: 2.00, name: 'Poly + Blue Light' },
  H67:  { lensCost: 12.00, surfPremium: 2.00, name: 'High Index 1.67' },
  B67:  { lensCost: 15.00, surfPremium: 2.00, name: 'H67 + Blue Light' },
  CR39: { lensCost: 2.00, surfPremium: 2.00, name: 'CR-39' },
};

const DEFAULT_CARRYING_PCT = 0.25; // 25% annual carrying cost
const DEFAULT_LOW_RUNNER_THRESHOLD = 3; // units/month

// Seasonality multipliers
const SEASONALITY = {
  1:  0.65,  // Post-holiday January
  2:  1.08,  // Valentine's
  3:  1.05,  // Spring Break
  4:  1.0,
  5:  1.0,
  6:  1.0,
  7:  1.0,
  8:  1.12,  // Back to School
  9:  1.0,
  10: 1.18,  // Halloween
  11: 0.85,  // Thanksgiving
  12: 1.30,  // Christmas ramp
};

// Service level Z-scores for safety stock
const Z_SCORES = { A: 2.33, B: 1.65, C: 1.28 };

// ─────────────────────────────────────────────────────────────────────────────
// BREAK-EVEN CALCULATION
// ─────────────────────────────────────────────────────────────────────────────
function calculateBreakEven(lensCost, surfPremium, carryingPct = DEFAULT_CARRYING_PCT) {
  // Break-even: monthly volume at which carrying cost = surfacing premium
  // carrying cost per unit per year = lensCost × carryingPct
  // surfacing premium per unit = surfPremium
  // break-even units/month = (surfPremium × 12) / (lensCost × carryingPct)
  if (lensCost <= 0 || carryingPct <= 0) return 0;
  return (surfPremium * 12) / (lensCost * carryingPct);
}

// ─────────────────────────────────────────────────────────────────────────────
// STATISTICAL SAFETY STOCK
// ─────────────────────────────────────────────────────────────────────────────
function calculateSafetyStock(zScore, stdDev, leadTimeMonths) {
  // Safety Stock = Z × σ × √Lead Time
  return Math.ceil(zScore * stdDev * Math.sqrt(leadTimeMonths));
}

function standardDeviation(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

// ─────────────────────────────────────────────────────────────────────────────
// DETECT MATERIAL TYPE FROM SKU
// ─────────────────────────────────────────────────────────────────────────────
function detectMaterial(sku, description = '') {
  const desc = (description || '').toUpperCase();
  const s = (sku || '').toUpperCase();

  if (desc.includes('BLY') || desc.includes('BLUE') || desc.includes('B67')) {
    return desc.includes('67') || desc.includes('H67') || desc.includes('B67') ? 'B67' : 'BLY';
  }
  if (desc.includes('H67') || desc.includes('1.67') || desc.includes('HI67')) return 'H67';
  if (desc.includes('CR') || desc.includes('CR-39') || desc.includes('CR39')) return 'CR39';
  if (desc.includes('PLY') || desc.includes('POLY')) return 'PLY';

  // Fallback by SKU prefix patterns
  if (s.startsWith('4800')) return 'PLY'; // Essilor poly default
  if (s.startsWith('062')) return 'PLY';  // Somo default
  return 'PLY'; // default
}

// ─────────────────────────────────────────────────────────────────────────────
// RUN LONG TAIL ANALYSIS
// ─────────────────────────────────────────────────────────────────────────────
function runAnalysis(db, overrides = {}) {
  // Load configurable thresholds from model_params or use overrides
  try {
    db.exec("CREATE TABLE IF NOT EXISTS model_params (key TEXT PRIMARY KEY, value TEXT)");
    const keys = ['long_tail_carrying_pct', 'long_tail_low_runner', 'long_tail_surf_premium_ply', 'long_tail_surf_premium_bly', 'long_tail_surf_premium_h67', 'long_tail_surf_premium_b67', 'long_tail_surf_premium_cr39', 'long_tail_lens_cost_ply', 'long_tail_lens_cost_bly', 'long_tail_lens_cost_h67', 'long_tail_lens_cost_b67', 'long_tail_lens_cost_cr39', 'long_tail_surf_lead_days', 'long_tail_finished_lead_days', 'long_tail_lead_time_cost_per_day', 'long_tail_surf_daily_cap'];
    for (const k of keys) {
      const row = db.prepare('SELECT value FROM model_params WHERE key = ?').get(k);
      if (row?.value) overrides[k] = Number(row.value);
    }
  } catch {}

  const carryingPct = overrides.long_tail_carrying_pct ?? DEFAULT_CARRYING_PCT;
  const lowRunnerThreshold = overrides.long_tail_low_runner ?? DEFAULT_LOW_RUNNER_THRESHOLD;

  // Lead time weighting — surfacing takes longer, that has a cost
  const surfLeadDays = overrides.long_tail_surf_lead_days ?? 3.0;      // days in surfacing
  const finishedLeadDays = overrides.long_tail_finished_lead_days ?? 1.75; // days for finished stock
  const leadTimeCostPerDay = overrides.long_tail_lead_time_cost_per_day ?? 0.50; // $/lens/extra day
  const extraDays = Math.max(0, surfLeadDays - finishedLeadDays);
  const leadTimePenalty = extraDays * leadTimeCostPerDay; // added to surfacing premium

  // Surfacing capacity cap — max lenses/day from long-tail routing
  const surfDailyCap = overrides.long_tail_surf_daily_cap ?? 0; // 0 = no cap

  // Allow per-material cost overrides
  const costs = JSON.parse(JSON.stringify(MATERIAL_COSTS));
  if (overrides.long_tail_lens_cost_ply) costs.PLY.lensCost = overrides.long_tail_lens_cost_ply;
  if (overrides.long_tail_lens_cost_bly) costs.BLY.lensCost = overrides.long_tail_lens_cost_bly;
  if (overrides.long_tail_lens_cost_h67) costs.H67.lensCost = overrides.long_tail_lens_cost_h67;
  if (overrides.long_tail_lens_cost_b67) costs.B67.lensCost = overrides.long_tail_lens_cost_b67;
  if (overrides.long_tail_lens_cost_cr39) costs.CR39.lensCost = overrides.long_tail_lens_cost_cr39;
  if (overrides.long_tail_surf_premium_ply) costs.PLY.surfPremium = overrides.long_tail_surf_premium_ply;
  if (overrides.long_tail_surf_premium_bly) costs.BLY.surfPremium = overrides.long_tail_surf_premium_bly;
  if (overrides.long_tail_surf_premium_h67) costs.H67.surfPremium = overrides.long_tail_surf_premium_h67;
  if (overrides.long_tail_surf_premium_b67) costs.B67.surfPremium = overrides.long_tail_surf_premium_b67;
  if (overrides.long_tail_surf_premium_cr39) costs.CR39.surfPremium = overrides.long_tail_surf_premium_cr39;
  // Get weekly consumption data
  const weeklyRows = db.prepare(`
    SELECT sku, SUM(units_consumed) as total, COUNT(DISTINCT week_start) as weeks
    FROM lens_consumption_weekly
    GROUP BY sku
  `).all();

  // Get on-hand from lens_inventory_status
  const statusRows = db.prepare('SELECT sku, description, on_hand, avg_weekly_consumption FROM lens_inventory_status').all();
  const statusMap = {};
  for (const r of statusRows) statusMap[r.sku] = r;

  // Get SKU params for ABC class
  const paramsRows = db.prepare('SELECT sku, abc_class FROM lens_sku_params').all();
  const paramsMap = {};
  for (const r of paramsRows) paramsMap[r.sku] = r;

  const results = [];
  const byMaterial = {};

  for (const r of weeklyRows) {
    const weeksData = r.weeks || 1;
    const monthlyVol = (r.total / weeksData) * 4.33; // convert weekly to monthly
    const status = statusMap[r.sku] || {};
    const desc = status.description || '';
    const material = detectMaterial(r.sku, desc);
    const matCosts = costs[material] || costs.PLY;
    const abcClass = paramsMap[r.sku]?.abc_class || (monthlyVol >= 100 ? 'A' : monthlyVol >= 20 ? 'B' : 'C');

    // Break-even — surfacing premium includes lead time penalty
    const effectiveSurfPremium = matCosts.surfPremium + leadTimePenalty;
    const breakEven = calculateBreakEven(matCosts.lensCost, effectiveSurfPremium, carryingPct);
    let decision = monthlyVol < breakEven ? 'SURFACE' : 'STOCK';

    // Semi-finished blanks must ALWAYS be STOCK — they're raw material for surfacing.
    // Source of truth: db.getSemifinishedSkus() which unions lens_sku_properties
    // (aggregated from live data) with the bootstrap seed list.
    if (!_semifinishedSet) _semifinishedSet = require('./db').getSemifinishedSkus();
    if (_semifinishedSet.has(r.sku) || /^(062|026|001)/.test(r.sku)) decision = 'STOCK';

    // Statistical safety stock
    const weeklyValues = db.prepare('SELECT units_consumed FROM lens_consumption_weekly WHERE sku = ? ORDER BY week_start DESC LIMIT 12').all(r.sku).map(w => w.units_consumed);
    const monthlyValues = [];
    for (let i = 0; i < weeklyValues.length - 3; i += 4) {
      monthlyValues.push(weeklyValues.slice(i, i + 4).reduce((s, v) => s + v, 0));
    }
    const stdDev = standardDeviation(monthlyValues.length >= 2 ? monthlyValues : weeklyValues);
    const zScore = Z_SCORES[abcClass] || Z_SCORES.B;
    const leadTimeMonths = 4; // default, could be from params
    const safetyStock = calculateSafetyStock(zScore, stdDev, leadTimeMonths);

    // Current month seasonality
    const currentMonth = new Date().getMonth() + 1;
    const seasonalMultiplier = SEASONALITY[currentMonth] || 1.0;
    const adjustedMonthly = Math.round(monthlyVol * seasonalMultiplier);

    const result = {
      sku: r.sku,
      description: desc,
      material,
      materialName: matCosts.name,
      abcClass,
      monthlyVolume: Math.round(monthlyVol * 10) / 10,
      adjustedMonthly,
      seasonalMultiplier,
      breakEven: Math.round(breakEven * 10) / 10,
      decision,
      lensCost: matCosts.lensCost,
      surfPremium: matCosts.surfPremium,
      onHand: status.on_hand || 0,
      safetyStock,
      zScore,
      stdDev: Math.round(stdDev * 10) / 10,
      annualCarryCost: decision === 'STOCK' ? Math.round((status.on_hand || 0) * matCosts.lensCost * carryingPct * 100) / 100 : 0,
      effectiveSurfPremium,
      leadTimePenalty,
      annualSurfCost: decision === 'SURFACE' ? Math.round(monthlyVol * 12 * effectiveSurfPremium * 100) / 100 : 0,
    };
    results.push(result);

    // Aggregate by material
    if (!byMaterial[material]) byMaterial[material] = { material, name: matCosts.name, totalSkus: 0, lowRunners: 0, stockSkus: 0, surfaceSkus: 0, totalMonthlyVol: 0, lowRunnerVol: 0, totalCarryCost: 0, totalSurfCost: 0 };
    byMaterial[material].totalSkus++;
    byMaterial[material].totalMonthlyVol += monthlyVol;
    if (decision === 'SURFACE') {
      byMaterial[material].surfaceSkus++;
      byMaterial[material].lowRunners++;
      byMaterial[material].lowRunnerVol += monthlyVol;
      byMaterial[material].totalSurfCost += result.annualSurfCost;
    } else {
      byMaterial[material].stockSkus++;
      byMaterial[material].totalCarryCost += result.annualCarryCost;
    }
  }

  // Capacity cap: if surfacing daily volume exceeds cap, flip highest-volume SURFACE SKUs back to STOCK
  let cappedSkus = 0;
  if (surfDailyCap > 0) {
    // Sort SURFACE results by monthly volume descending (highest volume flipped first)
    const surfaceResults = results.filter(r => r.decision === 'SURFACE').sort((a, b) => b.monthlyVolume - a.monthlyVolume);
    let totalSurfDaily = surfaceResults.reduce((s, r) => s + r.monthlyVolume, 0) / 21.7;
    for (const r of surfaceResults) {
      if (totalSurfDaily <= surfDailyCap) break;
      // Flip this SKU back to STOCK — it's the highest volume SURFACE SKU
      r.decision = 'STOCK';
      r.annualCarryCost = Math.round(r.onHand * r.lensCost * carryingPct * 100) / 100;
      r.annualSurfCost = 0;
      totalSurfDaily -= (r.monthlyVolume / 21.7);
      cappedSkus++;
    }
    // Rebuild byMaterial aggregates
    for (const m of Object.values(byMaterial)) {
      m.stockSkus = 0; m.surfaceSkus = 0; m.lowRunners = 0; m.lowRunnerVol = 0; m.totalCarryCost = 0; m.totalSurfCost = 0;
    }
    for (const r of results) {
      const m = byMaterial[r.material];
      if (!m) continue;
      if (r.decision === 'SURFACE') {
        m.surfaceSkus++; m.lowRunners++; m.lowRunnerVol += r.monthlyVolume; m.totalSurfCost += r.annualSurfCost;
      } else {
        m.stockSkus++; m.totalCarryCost += r.annualCarryCost;
      }
    }
  }

  // Persist routing decisions to lens_sku_params
  const upsertRouting = db.prepare(`
    INSERT INTO lens_sku_params (sku, routing, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(sku) DO UPDATE SET routing = excluded.routing, updated_at = datetime('now')
  `);
  const saveRouting = db.transaction(() => {
    for (const r of results) {
      upsertRouting.run(r.sku, r.decision);
    }
  });
  try { saveRouting(); } catch (e) { console.error('[LongTail] Error saving routing:', e.message); }

  // Sort: surface candidates first, then by monthly volume ascending
  results.sort((a, b) => {
    if (a.decision !== b.decision) return a.decision === 'SURFACE' ? -1 : 1;
    return a.monthlyVolume - b.monthlyVolume;
  });

  const totalSurface = results.filter(r => r.decision === 'SURFACE').length;
  const totalStock = results.filter(r => r.decision === 'STOCK').length;

  // Surfacing workload impact — how much work goes to surfacing
  const surfaceResults = results.filter(r => r.decision === 'SURFACE');
  const surfacingMonthlyVol = surfaceResults.reduce((s, r) => s + r.monthlyVolume, 0);
  const surfacingWeeklyVol = Math.round(surfacingMonthlyVol / 4.33);
  const surfacingDailyVol = Math.round(surfacingMonthlyVol / 21.7); // ~21.7 working days/month
  const surfacingAnnualCost = surfaceResults.reduce((s, r) => s + r.annualSurfCost, 0);
  const stockingAnnualCost = results.filter(r => r.decision === 'STOCK').reduce((s, r) => s + r.annualCarryCost, 0);

  return {
    results,
    summary: {
      totalSkus: results.length,
      surfaceCount: totalSurface,
      stockCount: totalStock,
      surfacePct: results.length > 0 ? Math.round(totalSurface / results.length * 1000) / 10 : 0,
    },
    surfacingImpact: {
      skus: totalSurface,
      dailyVolume: surfacingDailyVol,
      weeklyVolume: surfacingWeeklyVol,
      monthlyVolume: Math.round(surfacingMonthlyVol),
      annualSurfacingCost: Math.round(surfacingAnnualCost),
      annualStockingCost: Math.round(stockingAnnualCost),
      netSavings: Math.round(stockingAnnualCost - surfacingAnnualCost),
      cappedSkus,
      dailyCap: surfDailyCap,
    },
    byMaterial: Object.values(byMaterial).sort((a, b) => b.totalMonthlyVol - a.totalMonthlyVol),
    parameters: {
      carryingCostPct: carryingPct,
      lowRunnerThreshold,
      surfLeadDays,
      finishedLeadDays,
      leadTimeCostPerDay,
      leadTimePenalty,
      surfDailyCap,
      materialCosts: costs,
      seasonality: SEASONALITY,
      zScores: Z_SCORES,
      currentSeasonality: SEASONALITY[new Date().getMonth() + 1] || 1.0,
    },
  };
}

module.exports = { runAnalysis, calculateBreakEven, calculateSafetyStock, standardDeviation, MATERIAL_COSTS, SEASONALITY, Z_SCORES };
