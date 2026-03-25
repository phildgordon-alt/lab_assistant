/**
 * lens-intelligence.js — Lens Inventory Intelligence Engine
 *
 * Computes: weeks of supply, stockout projections, dynamic reorder points,
 * order recommendations, consumption regression.
 *
 * Data sources:
 * - ItemPath (Kardex): on-hand inventory by SKU
 * - Looker (looker_jobs): consumption by lens OPC per day
 * - NetSuite: open POs with expected receipt dates
 * - picks_history: historical Kardex consumption
 */

'use strict';

const path = require('path');

let computeTimer = null;

// ─────────────────────────────────────────────────────────────────────────────
// WEEKLY CONSUMPTION — aggregate from Looker job-level data + picks_history
// ─────────────────────────────────────────────────────────────────────────────
function buildWeeklyConsumption(db) {
  // Source 1: Looker job-level data (lens OPCs with count_lenses by day)
  const lkRows = db.prepare(`
    SELECT opc as sku, sent_from_lab_date as date, SUM(count_lenses) as lenses
    FROM looker_jobs
    WHERE opc IS NOT NULL AND opc != ''
    GROUP BY opc, sent_from_lab_date
  `).all();

  // Source 2: ItemPath picks_history (for SKUs not in Looker)
  const ipRows = db.prepare(`
    SELECT sku, date(completed_at) as date, SUM(qty) as lenses
    FROM picks_history
    WHERE completed_at IS NOT NULL AND qty <= 10
    GROUP BY sku, date(completed_at)
  `).all();

  // Merge — Looker is primary, ItemPath fills gaps
  const dailyBySku = {};
  for (const r of lkRows) {
    if (!dailyBySku[r.sku]) dailyBySku[r.sku] = {};
    dailyBySku[r.sku][r.date] = (dailyBySku[r.sku][r.date] || 0) + r.lenses;
  }
  for (const r of ipRows) {
    if (!dailyBySku[r.sku]) dailyBySku[r.sku] = {};
    if (!dailyBySku[r.sku][r.date]) {
      dailyBySku[r.sku][r.date] = r.lenses;
    }
  }

  // Aggregate into weekly buckets
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
// COMPUTE HEALTH — for all lens SKUs
// ─────────────────────────────────────────────────────────────────────────────
function computeAll(db, itempath, netsuite) {
  // Ensure tables exist
  try {
    db.exec('CREATE TABLE IF NOT EXISTS lens_inventory_status (sku TEXT PRIMARY KEY, description TEXT, category TEXT, on_hand INTEGER DEFAULT 0, avg_weekly_consumption REAL DEFAULT 0, consumption_trend_pct REAL DEFAULT 0, weeks_of_supply REAL DEFAULT 0, weeks_of_supply_with_po REAL DEFAULT 0, safety_stock_weeks REAL DEFAULT 4.0, lead_time_weeks REAL DEFAULT 6.0, dynamic_reorder_point INTEGER DEFAULT 0, open_po_qty INTEGER DEFAULT 0, next_po_date TEXT, runout_date TEXT, runout_date_with_po TEXT, will_stockout INTEGER DEFAULT 0, days_at_risk INTEGER DEFAULT 0, status TEXT DEFAULT "OK", order_recommended INTEGER DEFAULT 0, order_qty_recommended INTEGER DEFAULT 0, computed_at TEXT DEFAULT (datetime("now")))');
    db.exec('CREATE TABLE IF NOT EXISTS lens_consumption_weekly (sku TEXT NOT NULL, week_start TEXT NOT NULL, units_consumed INTEGER DEFAULT 0, PRIMARY KEY(sku, week_start))');
  } catch (e) { /* tables already exist */ }

  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;

  // Build weekly consumption first
  try { buildWeeklyConsumption(db); } catch (e) { console.error('[Lens Intelligence] Weekly consumption error:', e.message); }

  // Get on-hand from ItemPath
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
      poBySku[line.sku].lines.push({ po: order.poNumber, qty: line.qty, date: order.date, status: order.status });
      if (order.date && (!poBySku[line.sku].nextDate || order.date < poBySku[line.sku].nextDate)) {
        poBySku[line.sku].nextDate = order.date;
      }
    }
  }

  // Get category from NetSuite
  const getCat = (sku) => {
    const cat = netsuite.getSkuCategory(sku);
    return cat || 'Other';
  };

  // Get weekly consumption for each SKU (last 8 weeks)
  const weeklyRows = db.prepare(`
    SELECT sku, week_start, units_consumed
    FROM lens_consumption_weekly
    ORDER BY sku, week_start DESC
  `).all();

  const weeklyBySku = {};
  for (const r of weeklyRows) {
    if (!weeklyBySku[r.sku]) weeklyBySku[r.sku] = [];
    weeklyBySku[r.sku].push({ week: r.week_start, qty: r.units_consumed });
  }

  // Compute for all SKUs that have on-hand or consumption
  const allSkus = new Set([...Object.keys(onHandBySku), ...Object.keys(weeklyBySku)]);
  const del = db.prepare('DELETE FROM lens_inventory_status');
  const ins = db.prepare(`INSERT OR REPLACE INTO lens_inventory_status
    (sku, description, category, on_hand, avg_weekly_consumption, consumption_trend_pct,
     weeks_of_supply, weeks_of_supply_with_po, safety_stock_weeks, lead_time_weeks,
     dynamic_reorder_point, open_po_qty, next_po_date, runout_date, runout_date_with_po,
     will_stockout, days_at_risk, status, order_recommended, order_qty_recommended, computed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  const compute = db.transaction(() => {
    del.run();
    let computed = 0;

    for (const sku of allSkus) {
      const cat = getCat(sku);
      // Only process lenses for now
      if (cat !== 'Lenses' && cat !== null) continue;

      const onHand = onHandBySku[sku]?.qty || 0;
      const desc = onHandBySku[sku]?.name || sku;
      const weeks = (weeklyBySku[sku] || []).slice(0, 8);

      // Safety stock and lead time by ABC class (approximation)
      // A-class (high volume): 6 weeks safety, 6 week lead
      // B-class: 4 weeks, 6 week lead
      // C-class: 3 weeks, 6 week lead
      const totalConsumption = weeks.reduce((s, w) => s + w.qty, 0);
      const safetyWeeks = totalConsumption > 200 ? 6 : totalConsumption > 50 ? 4 : 3;
      const leadTimeWeeks = 6;

      // 4-week average consumption
      const last4 = weeks.slice(0, 4);
      const avgWeekly = last4.length > 0 ? last4.reduce((s, w) => s + w.qty, 0) / last4.length : 0;

      // Consumption trend (current week vs 4-week avg)
      const currentWeek = weeks.length > 0 ? weeks[0].qty : 0;
      const trendPct = avgWeekly > 0 ? Math.round(((currentWeek - avgWeekly) / avgWeekly) * 100) : 0;

      // Weeks of supply
      const wos = avgWeekly > 0 ? Math.round((onHand / avgWeekly) * 10) / 10 : 999;

      // Open PO data
      const po = poBySku[sku];
      const openPoQty = po?.totalQty || 0;
      const nextPoDate = po?.nextDate || null;

      // Weeks of supply with PO
      const wosWithPo = avgWeekly > 0 ? Math.round(((onHand + openPoQty) / avgWeekly) * 10) / 10 : 999;

      // Dynamic reorder point
      const reorderPoint = Math.ceil(leadTimeWeeks * avgWeekly);

      // Runout dates
      const runoutDays = avgWeekly > 0 ? Math.round((onHand / avgWeekly) * 7) : 9999;
      const runoutDate = new Date(now.getTime() + runoutDays * 86400000);
      const runoutStr = runoutDays < 9999 ? `${runoutDate.getFullYear()}-${String(runoutDate.getMonth()+1).padStart(2,'0')}-${String(runoutDate.getDate()).padStart(2,'0')}` : null;

      const runoutWithPoDays = avgWeekly > 0 ? Math.round(((onHand + openPoQty) / avgWeekly) * 7) : 9999;
      const runoutWithPoDate = new Date(now.getTime() + runoutWithPoDays * 86400000);
      const runoutWithPoStr = runoutWithPoDays < 9999 ? `${runoutWithPoDate.getFullYear()}-${String(runoutWithPoDate.getMonth()+1).padStart(2,'0')}-${String(runoutWithPoDate.getDate()).padStart(2,'0')}` : null;

      // Stockout risk
      let willStockout = 0;
      let daysAtRisk = 0;
      if (nextPoDate && runoutWithPoStr) {
        willStockout = runoutWithPoStr < nextPoDate ? 1 : 0;
        if (willStockout) {
          const diff = (new Date(nextPoDate) - runoutWithPoDate) / 86400000;
          daysAtRisk = Math.max(0, Math.round(diff));
        }
      } else if (wosWithPo < leadTimeWeeks) {
        willStockout = 1;
      }

      // Status
      let status = 'OK';
      if (wosWithPo < leadTimeWeeks) status = 'CRITICAL';
      else if (wosWithPo < leadTimeWeeks + safetyWeeks) status = 'WARNING';
      else if (wosWithPo > 20) status = 'OVERSTOCK';

      // Order recommendation
      let orderRecommended = 0;
      let orderQty = 0;
      if (onHand <= reorderPoint || status === 'CRITICAL') {
        orderRecommended = 1;
        // Order enough to cover lead time + safety stock
        const targetQty = Math.ceil((leadTimeWeeks + safetyWeeks) * avgWeekly);
        orderQty = Math.max(0, targetQty - onHand - openPoQty);
      }

      ins.run(sku, desc, cat, onHand, Math.round(avgWeekly * 10) / 10, trendPct,
        wos, wosWithPo, safetyWeeks, leadTimeWeeks, reorderPoint, openPoQty, nextPoDate,
        runoutStr, runoutWithPoStr, willStockout, daysAtRisk, status,
        orderRecommended, orderQty, today);
      computed++;
    }
    return computed;
  });

  const count = compute();
  console.log(`[Lens Intelligence] Computed health for ${count} lens SKUs`);
  return count;
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

function getSkuDetail(db, sku) {
  const status = db.prepare('SELECT * FROM lens_inventory_status WHERE sku = ?').get(sku);
  const weekly = db.prepare('SELECT * FROM lens_consumption_weekly WHERE sku = ? ORDER BY week_start DESC LIMIT 12').all(sku);
  return { status, weekly };
}

function getOrderRecommendations(db) {
  return db.prepare('SELECT * FROM lens_inventory_status WHERE order_recommended = 1 ORDER BY days_at_risk DESC, weeks_of_supply ASC').all();
}

function getSummary(db) {
  const all = getStatus(db);
  return all.summary;
}

// ─────────────────────────────────────────────────────────────────────────────
// START — compute on startup and schedule periodic refresh
// ─────────────────────────────────────────────────────────────────────────────
function start(db, itempath, netsuite) {
  // Initial compute after 120s (let all data sources load and sync first)
  setTimeout(() => {
    try { computeAll(db, itempath, netsuite); } catch (e) { console.error('[Lens Intelligence] Initial compute error:', e.message, e.stack?.split('\n')[1]); }
  }, 120000);

  // Recompute every 30 minutes
  computeTimer = setInterval(() => {
    try { computeAll(db, itempath, netsuite); } catch (e) { console.error('[Lens Intelligence] Compute error:', e.message); }
  }, 1800000);
}

function stop() {
  if (computeTimer) clearInterval(computeTimer);
}

module.exports = { start, stop, computeAll, getStatus, getSkuDetail, getOrderRecommendations, getSummary };
