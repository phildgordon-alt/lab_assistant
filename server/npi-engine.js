/**
 * npi-engine.js — New Product Introduction Engine
 *
 * Manages NPI scenarios: define new products, model cannibalization,
 * adjust reorder quantities, estimate initial orders.
 */

'use strict';

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO CRUD
// ─────────────────────────────────────────────────────────────────────────────
function createScenario(db, data) {
  const id = generateId();
  db.prepare(`INSERT INTO npi_scenarios (id, name, description, new_sku_prefix, adoption_pct, source_type, source_value, proxy_sku, manufacturing_weeks, transit_weeks, fda_hold_weeks, status, launch_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, data.name, data.description || null, data.new_sku_prefix || null,
    data.adoption_pct || 50, data.source_type || 'prefix', data.source_value || null,
    data.proxy_sku || null, data.manufacturing_weeks || 13, data.transit_weeks || 4,
    data.fda_hold_weeks || 2, data.status || 'planning', data.launch_date || null
  );
  return id;
}

function updateScenario(db, id, data) {
  const fields = [];
  const vals = [];
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined && k !== 'id') { fields.push(`${k} = ?`); vals.push(v); }
  }
  if (fields.length > 0) {
    fields.push("updated_at = datetime('now')");
    vals.push(id);
    db.prepare(`UPDATE npi_scenarios SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
  }
}

function deleteScenario(db, id) {
  db.prepare('DELETE FROM npi_cannibalization WHERE scenario_id = ?').run(id);
  db.prepare('DELETE FROM npi_scenarios WHERE id = ?').run(id);
}

function getScenarios(db) {
  return db.prepare('SELECT * FROM npi_scenarios ORDER BY created_at DESC').all();
}

function getScenario(db, id) {
  const scenario = db.prepare('SELECT * FROM npi_scenarios WHERE id = ?').get(id);
  const cannibalization = db.prepare('SELECT * FROM npi_cannibalization WHERE scenario_id = ? ORDER BY lost_weekly DESC').all(id);
  return { scenario, cannibalization };
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPUTE CANNIBALIZATION
// ─────────────────────────────────────────────────────────────────────────────
function computeCannibalization(db, scenarioId) {
  const scenario = db.prepare('SELECT * FROM npi_scenarios WHERE id = ?').get(scenarioId);
  if (!scenario) return null;

  const adoptionRate = (scenario.adoption_pct || 50) / 100;

  // Find source SKUs based on source_type
  let sourceSkus = [];
  if (scenario.source_type === 'prefix' && scenario.source_value) {
    // All SKUs matching prefix
    sourceSkus = db.prepare(`
      SELECT sku, SUM(units_consumed) as total, COUNT(DISTINCT week_start) as weeks
      FROM lens_consumption_weekly
      WHERE sku LIKE ? || '%'
      GROUP BY sku
      ORDER BY total DESC
    `).all(scenario.source_value);
  } else if (scenario.source_type === 'skus' && scenario.source_value) {
    // Comma-separated list of specific SKUs
    const skuList = scenario.source_value.split(',').map(s => s.trim()).filter(Boolean);
    if (skuList.length > 0) {
      const placeholders = skuList.map(() => '?').join(',');
      sourceSkus = db.prepare(`
        SELECT sku, SUM(units_consumed) as total, COUNT(DISTINCT week_start) as weeks
        FROM lens_consumption_weekly
        WHERE sku IN (${placeholders})
        GROUP BY sku
        ORDER BY total DESC
      `).all(...skuList);
    }
  } else if (scenario.source_type === 'proxy' && scenario.proxy_sku) {
    // Use proxy SKU's consumption as the estimate for the new product
    sourceSkus = db.prepare(`
      SELECT sku, SUM(units_consumed) as total, COUNT(DISTINCT week_start) as weeks
      FROM lens_consumption_weekly
      WHERE sku = ?
      GROUP BY sku
    `).all(scenario.proxy_sku);
  } else if (scenario.source_type === 'null_opc') {
    // CR39 special case: null OPC jobs from Looker
    const nullJobs = db.prepare(`
      SELECT COUNT(DISTINCT job_id) as jobs
      FROM looker_jobs
      WHERE (opc IS NULL OR opc = '')
    `).get();
    // Get total weeks of data
    const dateRange = db.prepare(`
      SELECT COUNT(DISTINCT sent_from_lab_date) as days FROM looker_jobs
    `).get();
    const weeks = Math.max(1, (dateRange?.days || 1) / 5); // ~5 working days per week
    // Get all poly SKUs as cannibalization source
    sourceSkus = db.prepare(`
      SELECT sku, SUM(units_consumed) as total, COUNT(DISTINCT week_start) as weeks
      FROM lens_consumption_weekly
      WHERE sku LIKE '4800%' OR sku LIKE '062%'
      GROUP BY sku
      ORDER BY total DESC
    `).all();
  }

  // Compute cannibalization per source SKU
  const del = db.prepare('DELETE FROM npi_cannibalization WHERE scenario_id = ?');
  const ins = db.prepare('INSERT INTO npi_cannibalization (scenario_id, source_sku, current_weekly, lost_weekly, new_weekly) VALUES (?, ?, ?, ?, ?)');

  let totalCurrentWeekly = 0;
  let totalLostWeekly = 0;

  const save = db.transaction(() => {
    del.run(scenarioId);
    for (const s of sourceSkus) {
      const weeklyAvg = s.weeks > 0 ? Math.round(s.total / s.weeks * 10) / 10 : 0;
      const lost = Math.round(weeklyAvg * adoptionRate * 10) / 10;
      const remaining = Math.round((weeklyAvg - lost) * 10) / 10;
      ins.run(scenarioId, s.sku, weeklyAvg, lost, remaining);
      totalCurrentWeekly += weeklyAvg;
      totalLostWeekly += lost;
    }
  });
  save();

  // Compute new product demand
  const totalLeadTime = (scenario.manufacturing_weeks || 13) + (scenario.transit_weeks || 4) + (scenario.fda_hold_weeks || 2);
  const safetyWeeks = 4;
  const newProductWeeklyLenses = Math.round(totalLostWeekly * 2); // 2 lenses per job
  const initialOrderQty = Math.ceil((totalLeadTime + safetyWeeks) * newProductWeeklyLenses);

  return {
    scenario,
    sourceSkuCount: sourceSkus.length,
    totalCurrentWeekly: Math.round(totalCurrentWeekly),
    totalLostWeekly: Math.round(totalLostWeekly),
    newProductWeeklyJobs: Math.round(totalLostWeekly),
    newProductWeeklyLenses,
    initialOrderQty,
    totalLeadTime,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET ACTIVE CANNIBALIZATION ADJUSTMENTS (feeds into Lens Intelligence reorders)
// ─────────────────────────────────────────────────────────────────────────────
function getActiveAdjustments(db) {
  // Get all active/launched scenarios
  const scenarios = db.prepare("SELECT id, adoption_pct FROM npi_scenarios WHERE status IN ('active', 'launched')").all();
  if (scenarios.length === 0) return {};

  const adjustments = {}; // sku → reduction in weekly demand
  for (const s of scenarios) {
    const canns = db.prepare('SELECT source_sku, lost_weekly FROM npi_cannibalization WHERE scenario_id = ?').all(s.id);
    for (const c of canns) {
      adjustments[c.source_sku] = (adjustments[c.source_sku] || 0) + c.lost_weekly;
    }
  }
  return adjustments;
}

module.exports = { createScenario, updateScenario, deleteScenario, getScenarios, getScenario, computeCannibalization, getActiveAdjustments };
