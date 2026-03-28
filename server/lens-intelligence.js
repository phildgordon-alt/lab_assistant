/**
 * lens-intelligence.js — Lens Inventory Intelligence Engine
 *
 * Computes: weeks of supply, stockout projections, dynamic reorder points,
 * order recommendations, consumption regression.
 *
 * Data sources:
 * - ItemPath (Kardex): on-hand inventory by SKU — PHYSICAL TRUTH
 * - ItemPath picks_history: consumption by SKU per day
 * - NetSuite: open POs with expected receipt dates
 *
 * Lead time components (configurable per SKU in lens_sku_params):
 * - Manufacturing: ~13 weeks (90 days)
 * - Ocean transit: ~4 weeks
 * - FDA hold: ~0-2 weeks
 * - Total: ~17-19 weeks default
 */

'use strict';

let computeTimer = null;

// Default lead times (overridden by lens_sku_params per SKU)
const DEFAULTS = {
  manufacturing_weeks: 13,
  transit_weeks: 4,
  fda_hold_weeks: 2,
  safety_stock_weeks: 4,
  abc_class: 'B',
};

// Safety stock by ABC class (weeks)
const SAFETY_BY_CLASS = { A: 6, B: 4, C: 3 };

// Model parameters — persisted to model_params table, editable via UI
let MODEL_PARAMS = {
  stockout_adj_finished: 10,    // +10% demand uplift for finished lenses
  stockout_adj_semifin: -10,    // -10% demand reduction for semi-finished
  use_woc_override: false,      // toggle: weeks-of-cover vs Z-score safety stock
  woc_target_weeks: 16,         // target weeks of cover when override is on
};

function loadModelParams(db) {
  try {
    db.exec("CREATE TABLE IF NOT EXISTS model_params (key TEXT PRIMARY KEY, value TEXT)");
    const rows = db.prepare('SELECT key, value FROM model_params').all();
    for (const r of rows) {
      if (r.key in MODEL_PARAMS) {
        const v = r.value;
        if (v === 'true') MODEL_PARAMS[r.key] = true;
        else if (v === 'false') MODEL_PARAMS[r.key] = false;
        else if (!isNaN(Number(v))) MODEL_PARAMS[r.key] = Number(v);
        else MODEL_PARAMS[r.key] = v;
      }
    }
  } catch {}
}

function saveModelParams(db, params) {
  db.exec("CREATE TABLE IF NOT EXISTS model_params (key TEXT PRIMARY KEY, value TEXT)");
  const upsert = db.prepare('INSERT INTO model_params (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const save = db.transaction(() => {
    for (const [k, v] of Object.entries(params)) {
      if (k in MODEL_PARAMS) {
        MODEL_PARAMS[k] = v;
        upsert.run(k, String(v));
      }
    }
  });
  save();
}

function getModelParams() { return { ...MODEL_PARAMS }; }

// ─────────────────────────────────────────────────────────────────────────────
// LINEAR REGRESSION — project consumption trend forward
// ─────────────────────────────────────────────────────────────────────────────
function linearRegression(points) {
  // points: [{ x: weekIndex, y: consumption }]
  if (points.length < 3) return null;
  const n = points.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (const p of points) {
    sumX += p.x;
    sumY += p.y;
    sumXY += p.x * p.y;
    sumXX += p.x * p.x;
  }
  const denom = (n * sumXX - sumX * sumX);
  if (denom === 0) return null;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  const rSquared = (() => {
    const meanY = sumY / n;
    let ssTot = 0, ssRes = 0;
    for (const p of points) {
      ssTot += (p.y - meanY) ** 2;
      ssRes += (p.y - (slope * p.x + intercept)) ** 2;
    }
    return ssTot > 0 ? 1 - ssRes / ssTot : 0;
  })();
  return { slope, intercept, rSquared };
}

function projectConsumption(weeks, weeksForward = 4) {
  if (weeks.length < 3) {
    // Not enough data for regression — use flat average
    const avg = weeks.length > 0 ? weeks.reduce((s, w) => s + w.qty, 0) / weeks.length : 0;
    return { avgWeekly: avg, projected: avg, method: 'average', regression: null };
  }

  // Build regression points (most recent = highest x)
  const points = weeks.map((w, i) => ({ x: weeks.length - i, y: w.qty }));
  const reg = linearRegression(points);

  const avgWeekly = weeks.reduce((s, w) => s + w.qty, 0) / weeks.length;

  if (!reg || reg.rSquared < 0.3) {
    // Poor fit — use average
    return { avgWeekly, projected: avgWeekly, method: 'average', regression: reg };
  }

  // Project forward
  const projected = Math.max(0, reg.slope * (weeks.length + weeksForward) + reg.intercept);

  // If trend is clearly up, use projected. If flat or down, use average (conservative)
  const useProjected = reg.slope > 0 && reg.rSquared >= 0.5;

  return {
    avgWeekly,
    projected: useProjected ? projected : avgWeekly,
    method: useProjected ? 'regression' : 'average',
    regression: reg,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// WEEKLY CONSUMPTION — from ItemPath picks_history
// ─────────────────────────────────────────────────────────────────────────────
function buildWeeklyConsumption(db) {
  const ipRows = db.prepare(`
    SELECT sku, date(completed_at) as date, SUM(qty) as qty
    FROM picks_history
    WHERE completed_at IS NOT NULL AND qty <= 10
    GROUP BY sku, date(completed_at)
  `).all();

  const dailyBySku = {};
  for (const r of ipRows) {
    if (!dailyBySku[r.sku]) dailyBySku[r.sku] = {};
    dailyBySku[r.sku][r.date] = (dailyBySku[r.sku][r.date] || 0) + r.qty;
  }

  const del = db.prepare('DELETE FROM lens_consumption_weekly');
  const ins = db.prepare('INSERT OR REPLACE INTO lens_consumption_weekly (sku, week_start, units_consumed) VALUES (?, ?, ?)');

  const save = db.transaction(() => {
    del.run();
    for (const [sku, days] of Object.entries(dailyBySku)) {
      const weekBuckets = {};
      for (const [date, qty] of Object.entries(days)) {
        const d = new Date(date + 'T00:00:00');
        const day = d.getDay();
        const mondayOffset = day === 0 ? 6 : day - 1;
        d.setDate(d.getDate() - mondayOffset);
        const weekStart = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        weekBuckets[weekStart] = (weekBuckets[weekStart] || 0) + qty;
      }
      for (const [week, qty] of Object.entries(weekBuckets)) {
        ins.run(sku, week, qty);
      }
    }
  });
  save();
}

// ─────────────────────────────────────────────────────────────────────────────
// GET SKU PARAMS — configurable per SKU with defaults
// ─────────────────────────────────────────────────────────────────────────────
function getSkuParams(db, sku) {
  const row = db.prepare('SELECT * FROM lens_sku_params WHERE sku = ?').get(sku);
  if (row) return row;
  return {
    manufacturing_weeks: DEFAULTS.manufacturing_weeks,
    transit_weeks: DEFAULTS.transit_weeks,
    fda_hold_weeks: DEFAULTS.fda_hold_weeks,
    total_lead_time_weeks: DEFAULTS.manufacturing_weeks + DEFAULTS.transit_weeks + DEFAULTS.fda_hold_weeks,
    safety_stock_weeks: DEFAULTS.safety_stock_weeks,
    abc_class: DEFAULTS.abc_class,
    min_order_qty: 0,
    routing: 'STOCK',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPUTE HEALTH — for all lens SKUs
// ─────────────────────────────────────────────────────────────────────────────
function computeAll(db, itempath, netsuite) {
  // Ensure tables exist
  try {
    db.exec("CREATE TABLE IF NOT EXISTS lens_inventory_status (sku TEXT PRIMARY KEY, description TEXT, category TEXT, on_hand INTEGER DEFAULT 0, avg_weekly_consumption REAL DEFAULT 0, projected_weekly REAL DEFAULT 0, consumption_method TEXT, consumption_trend_pct REAL DEFAULT 0, weeks_of_supply REAL DEFAULT 0, weeks_of_supply_with_po REAL DEFAULT 0, safety_stock_weeks REAL DEFAULT 4.0, lead_time_weeks REAL DEFAULT 19.0, manufacturing_weeks REAL DEFAULT 13.0, transit_weeks REAL DEFAULT 4.0, fda_hold_weeks REAL DEFAULT 2.0, dynamic_reorder_point INTEGER DEFAULT 0, open_po_qty INTEGER DEFAULT 0, next_po_date TEXT, runout_date TEXT, runout_date_with_po TEXT, will_stockout INTEGER DEFAULT 0, days_at_risk INTEGER DEFAULT 0, status TEXT DEFAULT 'OK', order_recommended INTEGER DEFAULT 0, order_qty_recommended INTEGER DEFAULT 0, abc_class TEXT DEFAULT 'B', regression_slope REAL, regression_r2 REAL, computed_at TEXT DEFAULT (datetime('now')))");
    db.exec('CREATE TABLE IF NOT EXISTS lens_consumption_weekly (sku TEXT NOT NULL, week_start TEXT NOT NULL, units_consumed INTEGER DEFAULT 0, PRIMARY KEY(sku, week_start))');
    db.exec("CREATE TABLE IF NOT EXISTS lens_sku_params (sku TEXT PRIMARY KEY, supplier TEXT, manufacturing_weeks REAL DEFAULT 13.0, transit_weeks REAL DEFAULT 4.0, fda_hold_weeks REAL DEFAULT 2.0, safety_stock_weeks REAL DEFAULT 4.0, abc_class TEXT DEFAULT 'B', min_order_qty INTEGER DEFAULT 0, notes TEXT, updated_at TEXT DEFAULT (datetime('now')))");
  } catch (e) { /* tables exist */ }

  // Load model params
  loadModelParams(db);

  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;

  // Build weekly consumption
  try { buildWeeklyConsumption(db); } catch (e) { console.error('[Lens Intelligence] Weekly consumption error:', e.message); }

  // Get on-hand from ItemPath (physical Kardex truth)
  const inv = itempath.getInventory();
  const onHandBySku = {};
  for (const m of (inv.materials || [])) {
    onHandBySku[m.sku] = { qty: m.qty || 0, name: m.name || m.sku };
  }

  // Get open POs from NetSuite
  const poData = netsuite.getOpenPOs();
  const poBySku = {};
  for (const order of (poData.orders || [])) {
    for (const line of (order.lines || [])) {
      if (!poBySku[line.sku]) poBySku[line.sku] = { totalQty: 0, nextDate: null, lines: [] };
      poBySku[line.sku].totalQty += line.qty;
      poBySku[line.sku].lines.push({ po: order.poNumber, qty: line.qty, date: order.date, shipDate: order.shipDate, status: order.status, phase: order.phase });
      if (order.date && (!poBySku[line.sku].nextDate || order.date < poBySku[line.sku].nextDate)) {
        poBySku[line.sku].nextDate = order.date;
      }
    }
  }

  // Get category from NetSuite
  const getCat = (sku) => netsuite.getSkuCategory(sku) || 'Other';

  // Get weekly consumption for each SKU
  const weeklyRows = db.prepare('SELECT sku, week_start, units_consumed FROM lens_consumption_weekly ORDER BY sku, week_start DESC').all();
  const weeklyBySku = {};
  for (const r of weeklyRows) {
    if (!weeklyBySku[r.sku]) weeklyBySku[r.sku] = [];
    weeklyBySku[r.sku].push({ week: r.week_start, qty: r.units_consumed });
  }

  // Compute for all SKUs
  const allSkus = new Set([...Object.keys(onHandBySku), ...Object.keys(weeklyBySku)]);

  // Drop and recreate to handle schema changes
  try { db.exec('DROP TABLE IF EXISTS lens_inventory_status'); } catch {}
  db.exec("CREATE TABLE IF NOT EXISTS lens_inventory_status (sku TEXT PRIMARY KEY, description TEXT, category TEXT, on_hand INTEGER DEFAULT 0, avg_weekly_consumption REAL DEFAULT 0, projected_weekly REAL DEFAULT 0, consumption_method TEXT, consumption_trend_pct REAL DEFAULT 0, cv REAL DEFAULT 0, weeks_of_supply REAL DEFAULT 0, weeks_of_supply_with_po REAL DEFAULT 0, safety_stock_weeks REAL DEFAULT 4.0, lead_time_weeks REAL DEFAULT 19.0, manufacturing_weeks REAL DEFAULT 13.0, transit_weeks REAL DEFAULT 4.0, fda_hold_weeks REAL DEFAULT 2.0, dynamic_reorder_point INTEGER DEFAULT 0, open_po_qty INTEGER DEFAULT 0, next_po_date TEXT, runout_date TEXT, runout_date_with_po TEXT, will_stockout INTEGER DEFAULT 0, days_at_risk INTEGER DEFAULT 0, status TEXT DEFAULT 'OK', order_recommended INTEGER DEFAULT 0, order_qty_recommended INTEGER DEFAULT 0, demand_adj_qty INTEGER DEFAULT 0, abc_class TEXT DEFAULT 'B', routing TEXT DEFAULT 'STOCK', sku_type TEXT DEFAULT 'finished', regression_slope REAL, regression_r2 REAL, computed_at TEXT DEFAULT (datetime('now')))");

  const ins = db.prepare(`INSERT INTO lens_inventory_status
    (sku, description, category, on_hand, avg_weekly_consumption, projected_weekly, consumption_method,
     consumption_trend_pct, cv, weeks_of_supply, weeks_of_supply_with_po, safety_stock_weeks, lead_time_weeks,
     manufacturing_weeks, transit_weeks, fda_hold_weeks, dynamic_reorder_point, open_po_qty, next_po_date,
     runout_date, runout_date_with_po, will_stockout, days_at_risk, status, order_recommended,
     order_qty_recommended, demand_adj_qty, abc_class, routing, sku_type, regression_slope, regression_r2, computed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  let computed = 0;
  const compute = db.transaction(() => {
    // Get discontinued SKUs
    let discontinuedSkus = new Set();
    try {
      const disc = db.prepare("SELECT sku FROM lens_sku_params WHERE abc_class = 'X'").all();
      discontinuedSkus = new Set(disc.map(r => r.sku));
    } catch {}

    for (const sku of allSkus) {
      const cat = getCat(sku);
      // Only lenses — must be categorized as Lenses or have lens OPC prefix
      const isLensPrefix = /^(4800|06[0-9]|026|001|5[0-9]{3})/.test(sku);
      if (cat === 'Lenses') { /* confirmed lens */ }
      else if (cat === null && isLensPrefix) { /* uncategorized but looks like lens OPC */ }
      else continue; // skip frames, tops, other, unknown non-lens
      if (discontinuedSkus.has(sku)) continue;

      const onHand = onHandBySku[sku]?.qty || 0;
      const desc = onHandBySku[sku]?.name || sku;
      const weeks = (weeklyBySku[sku] || []).slice(0, 12);
      const params = getSkuParams(db, sku);

      // Lead time components
      const mfgWeeks = params.manufacturing_weeks;
      const transitWeeks = params.transit_weeks;
      const fdaWeeks = params.fda_hold_weeks;
      const totalLeadTime = mfgWeeks + transitWeeks + fdaWeeks;

      // Detect SKU type: semi-finished = 062, 026, 001 prefixes, or SF_ marker
      // 4800 and 8820 are finished lenses (single vision / plano)
      const skuType = /^(SF_|062|026|001)/.test(sku) ? 'semifinished' : 'finished';

      // Consumption projection with regression
      const projection = projectConsumption(weeks.slice(0, 8));
      const avgWeekly = projection.avgWeekly;
      const projectedWeekly = projection.projected;

      // Stock-out compensation: adjust demand before planning
      const stockoutAdj = skuType === 'semifinished'
        ? (1 + MODEL_PARAMS.stockout_adj_semifin / 100)
        : (1 + MODEL_PARAMS.stockout_adj_finished / 100);
      const useRate = projectedWeekly * stockoutAdj;

      // Coefficient of variation (demand volatility)
      const weeklyQtys = weeks.map(w => w.qty);
      const stdDev = weeklyQtys.length >= 2
        ? Math.sqrt(weeklyQtys.reduce((s, v) => s + (v - avgWeekly) ** 2, 0) / (weeklyQtys.length - 1))
        : 0;
      const cv = avgWeekly > 0 ? Math.round((stdDev / avgWeekly) * 100) / 100 : 0;

      // Safety stock: Z-score method or Weeks-of-Cover override
      let safetyWeeks;
      if (MODEL_PARAMS.use_woc_override) {
        safetyWeeks = MODEL_PARAMS.woc_target_weeks;
      } else {
        safetyWeeks = SAFETY_BY_CLASS[params.abc_class] || params.safety_stock_weeks;
      }

      // Consumption trend
      const currentWeek = weeks.length > 0 ? weeks[0].qty : 0;
      const trendPct = avgWeekly > 0 ? Math.round(((currentWeek - avgWeekly) / avgWeekly) * 100) : 0;

      // Weeks of supply (using adjusted consumption rate)
      const wos = useRate > 0 ? Math.round((onHand / useRate) * 10) / 10 : 999;

      // Open PO data
      const po = poBySku[sku];
      const openPoQty = po?.totalQty || 0;
      const nextPoDate = po?.nextDate || null;
      const wosWithPo = useRate > 0 ? Math.round(((onHand + openPoQty) / useRate) * 10) / 10 : 999;

      // Safety stock: Z × σ × √LeadTime (in weeks)
      const weeklyQtysForSS = weeks.map(w => w.qty);
      const weeklyStdDev = weeklyQtysForSS.length >= 2
        ? Math.sqrt(weeklyQtysForSS.reduce((s, v) => s + (v - avgWeekly) ** 2, 0) / (weeklyQtysForSS.length - 1))
        : 0;
      const Z_SCORES = { A: 2.33, B: 1.65, C: 1.28 };
      let safetyStockUnits;
      if (MODEL_PARAMS.use_woc_override) {
        // Weeks of Cover method: target weeks × weekly rate / weeks_per_period
        safetyStockUnits = Math.ceil(MODEL_PARAMS.woc_target_weeks * useRate);
      } else {
        // Z-score method: Z × σ × √LeadTime
        const zScore = Z_SCORES[params.abc_class] || Z_SCORES.B;
        safetyStockUnits = Math.ceil(zScore * weeklyStdDev * Math.sqrt(totalLeadTime));
      }

      // Dynamic reorder point = (lead time × weekly consumption) + safety stock
      const reorderPoint = Math.ceil(totalLeadTime * useRate) + safetyStockUnits;

      // Runout dates
      const runoutDays = useRate > 0 ? Math.round((onHand / useRate) * 7) : 9999;
      const runoutDate = new Date(now.getTime() + runoutDays * 86400000);
      const runoutStr = runoutDays < 9999 ? `${runoutDate.getFullYear()}-${String(runoutDate.getMonth()+1).padStart(2,'0')}-${String(runoutDate.getDate()).padStart(2,'0')}` : null;

      const runoutWithPoDays = useRate > 0 ? Math.round(((onHand + openPoQty) / useRate) * 7) : 9999;
      const runoutWithPoDate = new Date(now.getTime() + runoutWithPoDays * 86400000);
      const runoutWithPoStr = runoutWithPoDays < 9999 ? `${runoutWithPoDate.getFullYear()}-${String(runoutWithPoDate.getMonth()+1).padStart(2,'0')}-${String(runoutWithPoDate.getDate()).padStart(2,'0')}` : null;

      // Stockout risk
      let willStockout = 0;
      let daysAtRisk = 0;
      if (nextPoDate && runoutWithPoStr) {
        willStockout = runoutWithPoStr < nextPoDate ? 1 : 0;
        if (willStockout) {
          daysAtRisk = Math.max(0, Math.round((new Date(nextPoDate) - runoutWithPoDate) / 86400000));
        }
      } else if (wosWithPo < totalLeadTime) {
        willStockout = 1;
      }

      // Status
      let status = 'OK';
      if (wosWithPo < totalLeadTime) status = 'CRITICAL';
      else if (wosWithPo < totalLeadTime + safetyWeeks) status = 'WARNING';
      else if (wosWithPo > 40) status = 'OVERSTOCK';

      // Order recommendation — SURFACE-routed SKUs should not be stocked
      let orderRecommended = 0;
      let orderQty = 0;
      let demandAdjQty = 0;
      const routing = params.routing || 'STOCK';
      if (routing === 'SURFACE') {
        status = 'SURFACE';
      } else if (status === 'OVERSTOCK') {
        // Don't order — we already have more than enough (including open POs)
        orderRecommended = 0;
      } else if (onHand <= reorderPoint || status === 'CRITICAL') {
        orderRecommended = 1;
        // Correct formula: Order Qty = Reorder Point - Current Inventory
        // (ROP already includes lead time demand + safety stock)
        // But subtract open POs — don't double-order what's already coming
        orderQty = Math.max(0, reorderPoint - onHand - openPoQty);
        if (orderQty < (params.min_order_qty || 0) && orderQty > 0) orderQty = params.min_order_qty;
        demandAdjQty = orderQty;
        // If open POs already cover the gap, don't recommend ordering
        if (orderQty <= 0) orderRecommended = 0;
      }

      // ABC class (auto if not set)
      const totalConsumption = weeks.reduce((s, w) => s + w.qty, 0);
      const abcClass = params.abc_class || (totalConsumption > 200 ? 'A' : totalConsumption > 50 ? 'B' : 'C');

      ins.run(sku, desc, cat, onHand,
        Math.round(avgWeekly * 10) / 10, Math.round(projectedWeekly * 10) / 10, projection.method,
        trendPct, cv, wos, wosWithPo, safetyWeeks, totalLeadTime,
        mfgWeeks, transitWeeks, fdaWeeks, reorderPoint, openPoQty, nextPoDate,
        runoutStr, runoutWithPoStr, willStockout, daysAtRisk, status,
        orderRecommended, orderQty, demandAdjQty, abcClass, routing, skuType,
        projection.regression?.slope ? Math.round(projection.regression.slope * 100) / 100 : null,
        projection.regression?.rSquared ? Math.round(projection.regression.rSquared * 100) / 100 : null,
        today);
      computed++;
    }
  });
  compute();

  console.log(`[Lens Intelligence] Computed health for ${computed} lens SKUs`);
  return computed;
}

// ─────────────────────────────────────────────────────────────────────────────
// GETTERS
// ─────────────────────────────────────────────────────────────────────────────
function getStatus(db, statusFilter = null) {
  let query = 'SELECT * FROM lens_inventory_status';
  const params = [];
  if (statusFilter) {
    query += ' WHERE status = ?';
    params.push(statusFilter);
  }
  query += " ORDER BY CASE status WHEN 'CRITICAL' THEN 0 WHEN 'WARNING' THEN 1 WHEN 'OK' THEN 2 WHEN 'OVERSTOCK' THEN 3 END, weeks_of_supply ASC";
  const rows = db.prepare(query).all(...params);

  const summary = { total: rows.length, critical: 0, warning: 0, ok: 0, overstock: 0, stockoutRisk: 0, orderRecommended: 0 };
  for (const r of rows) {
    summary[r.status.toLowerCase()] = (summary[r.status.toLowerCase()] || 0) + 1;
    if (r.will_stockout) summary.stockoutRisk++;
    if (r.order_recommended) summary.orderRecommended++;
  }

  return { items: rows, summary };
}

function getSkuDetail(db, sku, netsuite) {
  const status = db.prepare('SELECT * FROM lens_inventory_status WHERE sku = ?').get(sku);
  const weekly = db.prepare('SELECT * FROM lens_consumption_weekly WHERE sku = ? ORDER BY week_start DESC LIMIT 12').all(sku);
  const params = getSkuParams(db, sku);

  // Get PO detail for this SKU
  const pos = [];
  try {
    const poData = netsuite.getOpenPOs();
    for (const order of (poData.orders || [])) {
      for (const line of (order.lines || [])) {
        if (line.sku === sku) {
          pos.push({
            poNumber: order.poNumber,
            date: order.date,
            shipDate: order.shipDate || null,
            phase: order.phase || '',
            status: order.status,
            vendor: order.vendor,
            qty: line.qty,
            rate: line.rate,
            amount: line.amount,
          });
        }
      }
    }
  } catch {}

  return { status, weekly, params, pos };
}

function getOrderRecommendations(db) {
  return db.prepare('SELECT * FROM lens_inventory_status WHERE order_recommended = 1 ORDER BY days_at_risk DESC, weeks_of_supply ASC').all();
}

function getSummary(db) {
  return getStatus(db).summary;
}

// ─────────────────────────────────────────────────────────────────────────────
// SKU PARAMS MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────
function updateSkuParams(db, sku, params) {
  const existing = db.prepare('SELECT * FROM lens_sku_params WHERE sku = ?').get(sku);
  if (existing) {
    const fields = [];
    const vals = [];
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && k !== 'sku') { fields.push(`${k} = ?`); vals.push(v); }
    }
    if (fields.length > 0) {
      fields.push("updated_at = datetime('now')");
      vals.push(sku);
      db.prepare(`UPDATE lens_sku_params SET ${fields.join(', ')} WHERE sku = ?`).run(...vals);
    }
  } else {
    db.prepare(`INSERT INTO lens_sku_params (sku, supplier, manufacturing_weeks, transit_weeks, fda_hold_weeks, safety_stock_weeks, abc_class, min_order_qty)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      sku, params.supplier || null, params.manufacturing_weeks || 13, params.transit_weeks || 4,
      params.fda_hold_weeks || 2, params.safety_stock_weeks || 4, params.abc_class || 'B', params.min_order_qty || 0);
  }
}

function getAllSkuParams(db) {
  return db.prepare('SELECT * FROM lens_sku_params ORDER BY sku').all();
}

// ─────────────────────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────────────────────
function start(db, itempath, netsuite) {
  setTimeout(() => {
    try { computeAll(db, itempath, netsuite); } catch (e) { console.error('[Lens Intelligence] Initial compute error:', e.message, e.stack?.split('\n')[1]); }
  }, 120000);

  computeTimer = setInterval(() => {
    try { computeAll(db, itempath, netsuite); } catch (e) { console.error('[Lens Intelligence] Compute error:', e.message); }
  }, 1800000);
}

function stop() {
  if (computeTimer) clearInterval(computeTimer);
}

module.exports = { start, stop, computeAll, getStatus, getSkuDetail, getOrderRecommendations, getSummary, updateSkuParams, getAllSkuParams, getModelParams, saveModelParams };
