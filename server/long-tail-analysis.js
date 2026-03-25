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
function runAnalysis(db) {
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
    const costs = MATERIAL_COSTS[material] || MATERIAL_COSTS.PLY;
    const abcClass = paramsMap[r.sku]?.abc_class || (monthlyVol >= 100 ? 'A' : monthlyVol >= 20 ? 'B' : 'C');

    // Break-even
    const breakEven = calculateBreakEven(costs.lensCost, costs.surfPremium);
    const decision = monthlyVol < breakEven ? 'SURFACE' : 'STOCK';

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
      materialName: costs.name,
      abcClass,
      monthlyVolume: Math.round(monthlyVol * 10) / 10,
      adjustedMonthly,
      seasonalMultiplier,
      breakEven: Math.round(breakEven * 10) / 10,
      decision,
      lensCost: costs.lensCost,
      surfPremium: costs.surfPremium,
      onHand: status.on_hand || 0,
      safetyStock,
      zScore,
      stdDev: Math.round(stdDev * 10) / 10,
      annualCarryCost: decision === 'STOCK' ? Math.round(status.on_hand * costs.lensCost * DEFAULT_CARRYING_PCT * 100) / 100 : 0,
      annualSurfCost: decision === 'SURFACE' ? Math.round(monthlyVol * 12 * costs.surfPremium * 100) / 100 : 0,
    };
    results.push(result);

    // Aggregate by material
    if (!byMaterial[material]) byMaterial[material] = { material, name: costs.name, totalSkus: 0, lowRunners: 0, stockSkus: 0, surfaceSkus: 0, totalMonthlyVol: 0, lowRunnerVol: 0, totalCarryCost: 0, totalSurfCost: 0 };
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

  return {
    results,
    summary: {
      totalSkus: results.length,
      surfaceCount: totalSurface,
      stockCount: totalStock,
      surfacePct: results.length > 0 ? Math.round(totalSurface / results.length * 1000) / 10 : 0,
    },
    byMaterial: Object.values(byMaterial).sort((a, b) => b.totalMonthlyVol - a.totalMonthlyVol),
    parameters: {
      carryingCostPct: DEFAULT_CARRYING_PCT,
      lowRunnerThreshold: DEFAULT_LOW_RUNNER_THRESHOLD,
      materialCosts: MATERIAL_COSTS,
      seasonality: SEASONALITY,
      zScores: Z_SCORES,
      currentSeasonality: SEASONALITY[new Date().getMonth() + 1] || 1.0,
    },
  };
}

module.exports = { runAnalysis, calculateBreakEven, calculateSafetyStock, standardDeviation, MATERIAL_COSTS, SEASONALITY, Z_SCORES };
