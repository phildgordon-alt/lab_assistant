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
// Statuses:
// draft = modeling only, no impact on reorders
// approved = confirmed, but waiting for PO/inventory
// in_production = PO placed with supplier
// on_the_water = shipped, in transit
// received = inventory arrived, fully active cannibalization
const VALID_STATUSES = ['draft', 'approved', 'in_production', 'on_the_water', 'received'];

function createScenario(db, data) {
  const id = generateId();
  db.prepare(`INSERT INTO npi_scenarios (id, name, description, new_sku_prefix, adoption_pct, source_type, source_value, proxy_sku, manufacturing_weeks, transit_weeks, fda_hold_weeks, safety_stock_weeks, abc_class, status, launch_date, standard_profile_template_id, standard_profile_qty)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, data.name, data.description || null, data.new_sku_prefix || null,
    data.adoption_pct || 50, data.source_type || 'prefix', data.source_value || null,
    data.proxy_sku || null, data.manufacturing_weeks || 13, data.transit_weeks || 4,
    data.fda_hold_weeks || 2,
    data.safety_stock_weeks != null ? data.safety_stock_weeks : null,
    data.abc_class || null,
    data.status || 'draft', data.launch_date || null,
    data.standard_profile_template_id != null ? Number(data.standard_profile_template_id) : null,
    data.standard_profile_qty != null ? Number(data.standard_profile_qty) : null
  );
  // Phase 4: auto-create one placeholder SKU — 'NPI-{id}-V1'. Operator adds
  // more variants from the UI and maps each to a real SKU on receipt.
  try {
    db.prepare(
      `INSERT INTO npi_placeholder_skus (placeholder_code, scenario_id, variant_index, label, status)
       VALUES (?, ?, 1, ?, 'pending')`
    ).run(`NPI-${id}-V1`, id, data.name || null);
  } catch { /* placeholder table may not exist on first boot — fine */ }
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

function getScenario(db, id, netsuite) {
  const scenario = db.prepare('SELECT * FROM npi_scenarios WHERE id = ?').get(id);
  const cannibalization = db.prepare('SELECT * FROM npi_cannibalization WHERE scenario_id = ? ORDER BY lost_weekly DESC').all(id);

  // Check linked PO status if available
  let linkedPO = null;
  if (scenario?.new_sku_prefix && netsuite) {
    try {
      const poData = netsuite.getOpenPOs();
      for (const order of (poData.orders || [])) {
        for (const line of (order.lines || [])) {
          if (line.sku?.startsWith(scenario.new_sku_prefix)) {
            linkedPO = { poNumber: order.poNumber, date: order.date, shipDate: order.shipDate, phase: order.phase, status: order.status, vendor: order.vendor, qty: line.qty };
            break;
          }
        }
        if (linkedPO) break;
      }
    } catch {}
  }

  return { scenario, cannibalization, linkedPO };
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
    // Comma-separated (or whitespace-separated) list. Normalize + dedupe.
    const skuList = [...new Set(
      scenario.source_value.split(/[\s,;\n\r]+/).map(s => s.trim()).filter(Boolean)
    )];
    // Chunk the IN query. SQLite's default SQLITE_MAX_VARIABLE_NUMBER varies
    // (999 in older builds, 32766 in newer) — and large IN lists cost more
    // per-param anyway. 500 per batch is safe + fast. Aggregate across
    // batches and re-sort at the end.
    if (skuList.length > 0) {
      const CHUNK = 500;
      const byKey = new Map(); // sku → { total, weeks (max across batches, but each batch sees its own rows) }
      for (let i = 0; i < skuList.length; i += CHUNK) {
        const chunk = skuList.slice(i, i + CHUNK);
        const placeholders = chunk.map(() => '?').join(',');
        const rows = db.prepare(`
          SELECT sku, SUM(units_consumed) as total, COUNT(DISTINCT week_start) as weeks
          FROM lens_consumption_weekly
          WHERE sku IN (${placeholders})
          GROUP BY sku
        `).all(...chunk);
        for (const r of rows) byKey.set(r.sku, r);
      }
      sourceSkus = [...byKey.values()].sort((a, b) => b.total - a.total);
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
  } else if (scenario.source_type === 'material_category') {
    // Material-category cannibalization. Read targets, find SKUs in
    // lens_sku_properties matching (material × lens_type class), weight by
    // their own adoption_pct, aggregate into sourceSkus the same way the
    // 'skus' path does. Fixed 12-month window on lens_consumption_weekly.
    const targets = db.prepare(
      `SELECT material_code, lens_type_class, adoption_pct FROM npi_scenario_material_targets WHERE scenario_id = ?`
    ).all(scenarioId);
    if (targets.length > 0) {
      // Collect matching SKUs per target, preserving adoption_pct
      const skuAdoption = new Map(); // sku → adoption_pct
      const skuList = [];
      for (const t of targets) {
        const skus = db.prepare(
          `SELECT sku FROM lens_sku_properties
           WHERE material = ?
             AND ${t.lens_type_class === 'SV' ? `lens_type_modal IN ('S','C')` : `lens_type_modal = 'P'`}`
        ).all(t.material_code);
        for (const r of skus) {
          skuAdoption.set(r.sku, t.adoption_pct);
          skuList.push(r.sku);
        }
      }
      if (skuList.length > 0) {
        // Pull weekly consumption in chunks of 500 (SQLite param limit safety)
        const CHUNK = 500;
        const rowsByKey = new Map();
        for (let i = 0; i < skuList.length; i += CHUNK) {
          const chunk = skuList.slice(i, i + CHUNK);
          const ph = chunk.map(() => '?').join(',');
          const rows = db.prepare(`
            SELECT sku, SUM(units_consumed) as total, COUNT(DISTINCT week_start) as weeks
            FROM lens_consumption_weekly
            WHERE sku IN (${ph})
              AND week_start >= date('now', '-12 months', 'localtime')
            GROUP BY sku
          `).all(...chunk);
          for (const r of rows) rowsByKey.set(r.sku, r);
        }
        // Build sourceSkus with per-SKU adoption_pct instead of global. Custom
        // override: we compute lost/remaining here directly since the default
        // loop below uses scenario.adoption_pct. We'll store the per-SKU math
        // and short-circuit the default loop.
        const save = db.transaction(() => {
          const del2 = db.prepare('DELETE FROM npi_cannibalization WHERE scenario_id = ?');
          const ins2 = db.prepare('INSERT INTO npi_cannibalization (scenario_id, source_sku, current_weekly, lost_weekly, new_weekly) VALUES (?, ?, ?, ?, ?)');
          del2.run(scenarioId);
          for (const sku of skuAdoption.keys()) {
            const r = rowsByKey.get(sku);
            const weeklyAvg = r && r.weeks > 0 ? Math.round(r.total / r.weeks * 10) / 10 : 0;
            const adoption = (skuAdoption.get(sku) || 50) / 100;
            const lost = Math.round(weeklyAvg * adoption * 10) / 10;
            const remaining = Math.round((weeklyAvg - lost) * 10) / 10;
            ins2.run(scenarioId, sku, weeklyAvg, lost, remaining);
          }
        });
        save();
        // Re-read and hand off to the shared tail: set sourceSkus so the
        // downstream totals computation runs as normal. Cast lost_weekly to
        // emulate what the 'skus' path would produce.
        sourceSkus = db.prepare(
          `SELECT source_sku AS sku, (current_weekly) AS total, 1 AS weeks FROM npi_cannibalization WHERE scenario_id = ?`
        ).all(scenarioId).map(r => ({ sku: r.sku, total: r.total, weeks: 1 }));
        // Suppress the default loop's re-delete+insert by flagging with a
        // sentinel. Cleanest way: skip the default save by running what's
        // below manually. But simplest is to just let the default loop run —
        // it will DELETE + re-INSERT with the SCENARIO-level adoption_pct
        // overriding our per-target logic. That's wrong.
        // Fix: short-circuit by returning here with the full computed response.
        const totalCurrentWeekly2 = [...rowsByKey.values()].reduce((s, r) => s + (r.weeks > 0 ? r.total / r.weeks : 0), 0);
        const totalLostWeekly2 = db.prepare(
          `SELECT SUM(lost_weekly) AS s FROM npi_cannibalization WHERE scenario_id = ?`
        ).get(scenarioId).s || 0;
        const totalLeadTime2 = (scenario.manufacturing_weeks || 13) + (scenario.transit_weeks || 4) + (scenario.fda_hold_weeks || 2);
        const newProductWeeklyLenses2 = Math.round(totalLostWeekly2);
        const SAFETY_BY_CLASS = { A: 6, B: 4, C: 3 };
        const monthlyLenses2 = newProductWeeklyLenses2 * 4.33;
        const autoAbc2 = monthlyLenses2 >= 100 ? 'A' : monthlyLenses2 >= 20 ? 'B' : 'C';
        const abcClass2 = scenario.abc_class || autoAbc2;
        const safetyWeeks2 = scenario.safety_stock_weeks || SAFETY_BY_CLASS[abcClass2];
        const initialOrderQty2 = Math.ceil((totalLeadTime2 + safetyWeeks2) * newProductWeeklyLenses2);
        return {
          scenario,
          sourceSkuCount: skuAdoption.size,
          totalCurrentWeekly: Math.round(totalCurrentWeekly2),
          totalLostWeekly: Math.round(totalLostWeekly2),
          newProductWeeklyJobs: Math.round(totalLostWeekly2),
          newProductWeeklyLenses: newProductWeeklyLenses2,
          abcClass: abcClass2,
          abcClassSource: scenario.abc_class ? 'scenario_override' : 'auto_from_volume',
          safetyWeeks: safetyWeeks2,
          safetyWeeksSource: `material_category_${abcClass2}`,
          initialOrderQty: initialOrderQty2,
          totalLeadTime: totalLeadTime2,
          materialTargets: targets,
        };
      }
    }
    // No targets set — empty response, don't fall through to the 'skus' default save
    db.prepare('DELETE FROM npi_cannibalization WHERE scenario_id = ?').run(scenarioId);
    return {
      scenario,
      sourceSkuCount: 0,
      totalCurrentWeekly: 0, totalLostWeekly: 0,
      newProductWeeklyJobs: 0, newProductWeeklyLenses: 0,
      abcClass: scenario.abc_class || 'B', abcClassSource: 'default',
      safetyWeeks: scenario.safety_stock_weeks || 4, safetyWeeksSource: 'default',
      initialOrderQty: 0,
      totalLeadTime: (scenario.manufacturing_weeks || 13) + (scenario.transit_weeks || 4) + (scenario.fda_hold_weeks || 2),
      note: 'No material targets selected — go to Material Targets section and pick at least one.',
    };
  } else if (scenario.source_type === 'standard_profile') {
    // Non-cannibalizing NPI — no source SKUs, no cannibalization rows.
    // User specifies standard_profile_template_id + standard_profile_qty.
    // The initial order qty is the user's total directly (no lead-time math
    // applied because they're already saying "I want N lenses").
    // Short-circuit: clear any stale cannibalization rows and return.
    db.prepare('DELETE FROM npi_cannibalization WHERE scenario_id = ?').run(scenarioId);
    const totalLeadTime = (scenario.manufacturing_weeks || 13) + (scenario.transit_weeks || 4) + (scenario.fda_hold_weeks || 2);
    const qty = Number(scenario.standard_profile_qty) || 0;
    const tpl = scenario.standard_profile_template_id
      ? db.prepare('SELECT * FROM rx_profile_templates WHERE id = ?').get(scenario.standard_profile_template_id)
      : null;
    return {
      scenario,
      sourceSkuCount: 0,
      totalCurrentWeekly: 0,
      totalLostWeekly: 0,
      newProductWeeklyJobs: 0,
      newProductWeeklyLenses: 0,
      abcClass: scenario.abc_class || 'B',
      abcClassSource: scenario.abc_class ? 'scenario_override' : 'default',
      safetyWeeks: scenario.safety_stock_weeks || 4,
      safetyWeeksSource: 'standard_profile',
      initialOrderQty: qty,
      totalLeadTime,
      standardProfile: { template: tpl, qty },
    };
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
  // totalLostWeekly is already in lens units (from ItemPath picks), NOT jobs
  const newProductWeeklyLenses = Math.round(totalLostWeekly);

  // ABC class + safety stock now pulled from the lens intelligence model.
  // Lens intel classifies by adjusted AVG MONTHLY: A>=100, B>=20, C<20.
  // SAFETY_BY_CLASS: A=6wk, B=4wk, C=3wk (matches lens-intelligence.js:33).
  // Model's use_woc_override flag (weeks-of-cover override) is honored too.
  const SAFETY_BY_CLASS = { A: 6, B: 4, C: 3 };
  const monthlyLenses = newProductWeeklyLenses * 4.33;
  const autoAbcClass = monthlyLenses >= 100 ? 'A' : monthlyLenses >= 20 ? 'B' : 'C';
  const abcClass = scenario.abc_class || autoAbcClass;
  // Read model params from DB (key/value table populated by Lens Intelligence Model tab)
  let modelParams = { use_woc_override: false, woc_target_weeks: 16 };
  try {
    const rows = db.prepare(`SELECT key, value FROM model_params WHERE key IN ('use_woc_override','woc_target_weeks')`).all();
    for (const r of rows) {
      if (r.key === 'use_woc_override') modelParams.use_woc_override = (r.value === 'true' || r.value === true);
      else if (r.key === 'woc_target_weeks' && !isNaN(Number(r.value))) modelParams.woc_target_weeks = Number(r.value);
    }
  } catch { /* model_params table may not exist on older DBs */ }
  let safetyWeeks;
  let safetyWeeksSource;
  if (scenario.safety_stock_weeks != null && scenario.safety_stock_weeks > 0) {
    safetyWeeks = scenario.safety_stock_weeks;
    safetyWeeksSource = 'scenario_override';
  } else if (modelParams.use_woc_override) {
    safetyWeeks = modelParams.woc_target_weeks;
    safetyWeeksSource = 'model_woc_override';
  } else {
    safetyWeeks = SAFETY_BY_CLASS[abcClass];
    safetyWeeksSource = `model_abc_${abcClass}`;
  }

  const initialOrderQty = Math.ceil((totalLeadTime + safetyWeeks) * newProductWeeklyLenses);

  return {
    scenario,
    sourceSkuCount: sourceSkus.length,
    totalCurrentWeekly: Math.round(totalCurrentWeekly),
    totalLostWeekly: Math.round(totalLostWeekly),
    newProductWeeklyJobs: Math.round(totalLostWeekly),
    newProductWeeklyLenses,
    abcClass,
    abcClassSource: scenario.abc_class ? 'scenario_override' : 'auto_from_volume',
    safetyWeeks,
    safetyWeeksSource,
    initialOrderQty,
    totalLeadTime,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET ACTIVE CANNIBALIZATION ADJUSTMENTS (feeds into Lens Intelligence reorders)
// ─────────────────────────────────────────────────────────────────────────────
function getActiveAdjustments(db) {
  // Only apply cannibalization adjustments when product is close to arriving
  // on_the_water = start ramping down source SKU reorders (product arriving soon)
  // received = full cannibalization in effect
  // draft/approved/in_production = too early to adjust reorders
  const scenarios = db.prepare("SELECT id, adoption_pct, status FROM npi_scenarios WHERE status IN ('on_the_water', 'received')").all();
  if (scenarios.length === 0) return {};

  const adjustments = {}; // sku → reduction in weekly demand
  for (const s of scenarios) {
    // Ramp: on_the_water = 50% of cannibalization, received = 100%
    const ramp = s.status === 'received' ? 1.0 : 0.5;
    const canns = db.prepare('SELECT source_sku, lost_weekly FROM npi_cannibalization WHERE scenario_id = ?').all(s.id);
    for (const c of canns) {
      adjustments[c.source_sku] = (adjustments[c.source_sku] || 0) + (c.lost_weekly * ramp);
    }
  }
  return adjustments;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPAND TO PER-JOB RX LIST
// Produces one row per expected demand unit. For cannibalizing scenarios:
// for each source SKU, allocate qty proportionally to its lost_weekly share
// of the total, then emit rows by replaying that SKU's historical Rx samples
// (cycling with replacement if needed). For standard_profile: expand template
// buckets by pct_of_total and emit rows at the bucket midpoint (or, for
// Surfacing, by base_curve only — pucks have no Rx).
//
// Output shape: array of {
//   line_no, source_sku, placeholder_sku, material, base_curve, diameter,
//   lens_type, sph, cyl, axis, add, pd, confidence
// }
// ─────────────────────────────────────────────────────────────────────────────
function expandScenarioToPerJobRows(db, scenarioId) {
  const scenario = db.prepare('SELECT * FROM npi_scenarios WHERE id = ?').get(scenarioId);
  if (!scenario) return { error: 'Scenario not found', rows: [] };

  const compute = computeCannibalization(db, scenarioId);
  if (!compute) return { error: 'Compute failed', rows: [] };

  const rows = [];
  // Placeholder SKUs per scenario — cycle through in order. If none exist
  // (old scenarios pre-Phase-4), fall back to new_sku_prefix.
  const placeholders = db.prepare(
    `SELECT * FROM npi_placeholder_skus WHERE scenario_id = ? ORDER BY variant_index`
  ).all(scenarioId);
  const phCodes = placeholders.length > 0
    ? placeholders.map(p => p.placeholder_code)
    : [scenario.new_sku_prefix || `NPI-${scenarioId}-V1`];
  const phRealSku = new Map();
  for (const p of placeholders) if (p.real_sku) phRealSku.set(p.placeholder_code, p.real_sku);
  let lineNo = 1;
  const pickPlaceholder = (n) => phCodes[(n - 1) % phCodes.length];

  if (scenario.source_type === 'standard_profile') {
    const tplId = scenario.standard_profile_template_id;
    const qty = Number(scenario.standard_profile_qty) || 0;
    if (!tplId || qty <= 0) return { error: 'standard_profile scenario missing template_id or qty', rows: [] };
    const tpl = db.prepare('SELECT * FROM rx_profile_templates WHERE id = ?').get(tplId);
    const buckets = db.prepare('SELECT * FROM rx_profile_buckets WHERE template_id = ? ORDER BY pct_of_total DESC').all(tplId);
    if (!tpl || buckets.length === 0) return { error: 'Template has no buckets — populate via backfill or edit', rows: [] };

    // Allocate qty proportionally across buckets; round up so totals don't under-ship
    const allocations = buckets.map(b => ({ b, target: Math.round(qty * b.pct_of_total) }));
    // Correct rounding drift — if the sum isn't exactly qty, adjust the largest bucket
    const allocated = allocations.reduce((s, a) => s + a.target, 0);
    if (allocated !== qty && allocations.length > 0) {
      allocations.sort((a, b) => b.target - a.target);
      allocations[0].target += (qty - allocated);
    }
    for (const { b, target } of allocations) {
      for (let i = 0; i < target; i++) {
        // Row values: midpoint of bucket range, or null for Surfacing template
        const mid = (lo, hi) => (lo != null && hi != null) ? Math.round(((lo + hi) / 2) * 100) / 100 : null;
        const thisLine = lineNo++;
        const ph = pickPlaceholder(thisLine);
        rows.push({
          line_no: thisLine,
          source_sku: '',
          placeholder_sku: ph,
          real_sku: phRealSku.get(ph) || '',
          material: '',
          base_curve: b.base_curve,
          diameter: null,
          lens_type: tpl.lens_type,
          sph: mid(b.sph_min, b.sph_max),
          cyl: mid(b.cyl_min, b.cyl_max),
          axis: null,
          add: mid(b.add_min, b.add_max),
          pd: null,
          confidence: b.sample_count,
        });
      }
    }
    return { rows, scenario, compute, source: 'standard_profile', templateName: tpl.name };
  }

  // Cannibalizing source types — allocate by lost_weekly share, replay historical Rx
  const canns = db.prepare(
    'SELECT * FROM npi_cannibalization WHERE scenario_id = ? AND lost_weekly > 0 ORDER BY lost_weekly DESC'
  ).all(scenarioId);
  if (canns.length === 0) return { error: 'No cannibalization rows — run compute first', rows: [] };

  const totalLost = canns.reduce((s, c) => s + (c.lost_weekly || 0), 0);
  if (totalLost <= 0) return { error: 'Zero total lost_weekly', rows: [] };
  const initialOrderQty = compute.initialOrderQty || 0;

  // Prepared statement to pull Rx samples per source SKU from the jobs table
  const rxStmt = db.prepare(`
    SELECT rx_r_sphere AS sph, rx_r_cylinder AS cyl, rx_r_axis AS axis, rx_r_add AS add_pow, rx_r_pd AS pd, lens_material AS mat, lens_type, lens_style
    FROM jobs WHERE lens_opc_r = ? AND rx_r_sphere IS NOT NULL AND rx_r_sphere != ''
    UNION ALL
    SELECT rx_l_sphere, rx_l_cylinder, rx_l_axis, rx_l_add, rx_l_pd, lens_material, lens_type, lens_style
    FROM jobs WHERE lens_opc_l = ? AND rx_l_sphere IS NOT NULL AND rx_l_sphere != ''
    LIMIT 5000
  `);
  const propsStmt = db.prepare('SELECT material, lens_type_modal, base_curve, diameter, sample_job_count FROM lens_sku_properties WHERE sku = ?');

  for (const c of canns) {
    const shareQty = Math.round((c.lost_weekly / totalLost) * initialOrderQty);
    if (shareQty <= 0) continue;
    const samples = rxStmt.all(c.source_sku, c.source_sku);
    const props = propsStmt.get(c.source_sku) || {};
    for (let i = 0; i < shareQty; i++) {
      const s = samples.length > 0 ? samples[i % samples.length] : {};
      const thisLine = lineNo++;
      const ph = pickPlaceholder(thisLine);
      rows.push({
        line_no: thisLine,
        source_sku: c.source_sku,
        placeholder_sku: ph,
        real_sku: phRealSku.get(ph) || '',
        material: (s.mat || props.material || '').toUpperCase(),
        base_curve: props.base_curve,
        diameter: props.diameter,
        lens_type: s.lens_type || props.lens_type_modal || '',
        sph: parseFloat(s.sph) || null,
        cyl: parseFloat(s.cyl) || null,
        axis: parseFloat(s.axis) || null,
        add: parseFloat(s.add_pow) || null,
        pd: parseFloat(s.pd) || null,
        confidence: props.sample_job_count || samples.length || 0,
      });
    }
  }
  return { rows, scenario, compute, source: 'cannibalizing' };
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV FORMATTER — the per-job Rx list for Excel download
// ─────────────────────────────────────────────────────────────────────────────
// Category classification — derives the ordering bucket for a row:
//   Single Vision  (lens_type S/C + non-blue material)
//   Single Vision Blue Light  (lens_type S/C + BLY/B67 material)
//   Surfacing       (lens_type P + non-blue)
//   Surfacing Blue Light  (lens_type P + BLY/B67)
// Material codes: BLY = Poly Blue Light, B67 = 1.67 Blue Light (both = "blue").
function categorizeRow(lensType, material) {
  const lt = (lensType || '').toUpperCase();
  const mat = (material || '').toUpperCase();
  const isBlue = mat === 'BLY' || mat === 'B67';
  if (lt === 'P' || lt === 'SURFACING' || lt === 'B') {
    return isBlue ? 'Surfacing Blue Light' : 'Surfacing';
  }
  if (lt === 'S' || lt === 'C' || lt === 'SV') {
    return isBlue ? 'Single Vision Blue Light' : 'Single Vision';
  }
  return isBlue ? 'Unknown Blue Light' : 'Unknown';
}

function formatRxListCsv(expandedResult) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = expandedResult.rows || [];
  const scenario = expandedResult.scenario || {};
  const compute = expandedResult.compute || {};

  // Tag each row with a category for grouping + summary
  for (const r of rows) r.category = categorizeRow(r.lens_type, r.material);

  // Aggregate breakdowns for the header so the operator sees totals at the top
  const totalQty = rows.length;
  const byPlaceholder = {};
  const byMaterial = {};
  const byCategory = {};
  const byCategoryMaterial = {}; // e.g. "Single Vision Blue Light / BLY" → 1200
  for (const r of rows) {
    byPlaceholder[r.placeholder_sku] = (byPlaceholder[r.placeholder_sku] || 0) + 1;
    const mat = (r.material || '').toUpperCase();
    if (mat) byMaterial[mat] = (byMaterial[mat] || 0) + 1;
    byCategory[r.category] = (byCategory[r.category] || 0) + 1;
    const key = `${r.category} / ${mat || '—'}`;
    byCategoryMaterial[key] = (byCategoryMaterial[key] || 0) + 1;
  }
  const phLine = Object.entries(byPlaceholder).map(([k, n]) => `${k}=${n}`).join(' | ');
  const matLine = Object.entries(byMaterial).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${n}`).join(' | ');

  // Sort rows by category → placeholder → source_sku so Excel reads cleanly
  const categoryOrder = { 'Single Vision': 0, 'Single Vision Blue Light': 1, 'Surfacing': 2, 'Surfacing Blue Light': 3, 'Unknown': 4, 'Unknown Blue Light': 5 };
  rows.sort((a, b) => {
    const ca = categoryOrder[a.category] ?? 99;
    const cb = categoryOrder[b.category] ?? 99;
    if (ca !== cb) return ca - cb;
    if (a.placeholder_sku !== b.placeholder_sku) return String(a.placeholder_sku).localeCompare(String(b.placeholder_sku));
    return String(a.source_sku || '').localeCompare(String(b.source_sku || ''));
  });

  const lines = [];
  // ── Summary header (Excel treats # as regular text — Phil can filter/delete)
  lines.push(`# NPI Rx List — ${esc(scenario.name || scenario.id || '')}`);
  lines.push(`# Source type: ${scenario.source_type || ''}`);
  lines.push(`# TOTAL LENSES TO ORDER: ${totalQty}`);
  lines.push(`#`);
  lines.push(`# By category:`);
  for (const [cat, n] of Object.entries(byCategory).sort((a, b) => (categoryOrder[a[0]] ?? 99) - (categoryOrder[b[0]] ?? 99))) {
    lines.push(`#   ${cat}: ${n}`);
  }
  lines.push(`#`);
  lines.push(`# By category x material (order detail):`);
  for (const [key, n] of Object.entries(byCategoryMaterial).sort((a, b) => b[1] - a[1])) {
    lines.push(`#   ${key}: ${n}`);
  }
  lines.push(`#`);
  if (phLine) lines.push(`# By placeholder: ${phLine}`);
  if (matLine) lines.push(`# By material: ${matLine}`);
  lines.push(`# Lead time: ${compute.totalLeadTime || ''}wk | Safety: ${compute.safetyWeeks || ''}wk | ABC: ${compute.abcClass || ''}`);
  lines.push(`# Generated: ${new Date().toISOString()}`);
  lines.push('');
  // ── Per-row data
  lines.push(['line','category','placeholder_sku','real_sku','source_sku','lens_type','material','base_curve','diameter','sph','cyl','axis','add','pd','confidence'].join(','));
  for (const r of rows) {
    lines.push([
      r.line_no, esc(r.category), esc(r.placeholder_sku), esc(r.real_sku), esc(r.source_sku), esc(r.lens_type),
      esc(r.material), r.base_curve ?? '', r.diameter ?? '',
      r.sph ?? '', r.cyl ?? '', r.axis ?? '', r.add ?? '', r.pd ?? '',
      r.confidence ?? ''
    ].join(','));
  }
  lines.push('');
  lines.push(`# Grand total lenses: ${totalQty}`);
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// PROJECTED vs ACTUAL CANNIBALIZATION VARIANCE
// Compares each source SKU's projected lost_weekly (set at scenario
// projection time) against its ACTUAL consumption over a recent window.
// Post-activation (status >= on_the_water), source-SKU consumption should
// start dropping by ~adoption_pct as the new product takes its share. If
// the observed drop is much smaller, our projection was too aggressive;
// if much larger, the new product is over-performing.
//
// For v1: on-demand (computed when UI requests), 4-week observation window.
// No auto-adjust — operator reviews variance and decides. Future v2 could
// auto-tune safety_stock_weeks for high-variance source SKUs.
// ─────────────────────────────────────────────────────────────────────────────
function getCannibalizationVariance(db, scenarioId, windowWeeks = 4) {
  const scenario = db.prepare('SELECT * FROM npi_scenarios WHERE id = ?').get(scenarioId);
  if (!scenario) return { error: 'Scenario not found', rows: [] };
  const canns = db.prepare(
    'SELECT source_sku, current_weekly, lost_weekly, new_weekly FROM npi_cannibalization WHERE scenario_id = ? ORDER BY lost_weekly DESC'
  ).all(scenarioId);
  if (canns.length === 0) return { rows: [], note: 'No cannibalization rows yet' };

  // Actual recent-window consumption per source SKU from lens_consumption_weekly
  const recentStmt = db.prepare(`
    SELECT sku, SUM(units_consumed) AS total, COUNT(DISTINCT week_start) AS weeks
    FROM lens_consumption_weekly
    WHERE sku = ? AND week_start >= date('now', ?)
    GROUP BY sku
  `);
  const rows = canns.map(c => {
    const actualWindow = recentStmt.get(c.source_sku, `-${windowWeeks * 7} days`) || { total: 0, weeks: 0 };
    const actualWeekly = actualWindow.weeks > 0 ? Math.round((actualWindow.total / actualWindow.weeks) * 10) / 10 : 0;
    // Expected post-activation: (current - lost) = new_weekly. Compare actual to that.
    const expected = c.new_weekly;
    const deltaPct = expected > 0 ? Math.round(((actualWeekly - expected) / expected) * 100) : null;
    const impliedAdoption = c.current_weekly > 0
      ? Math.round(((c.current_weekly - actualWeekly) / c.current_weekly) * 100)
      : null;
    return {
      source_sku: c.source_sku,
      projected_current_weekly: c.current_weekly,
      projected_lost_weekly: c.lost_weekly,
      projected_new_weekly: c.new_weekly,
      actual_weekly: actualWeekly,
      actual_weeks_sampled: actualWindow.weeks,
      delta_vs_expected_pct: deltaPct,
      implied_adoption_pct: impliedAdoption,
    };
  });
  return {
    scenario,
    rows,
    windowWeeks,
    note: scenario.status === 'draft' || scenario.status === 'approved'
      ? 'Scenario not yet live — variance tracking activates at status=received.'
      : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase M1 — Material-Category Stocking CSVs
// For source_type='material_category' scenarios: aggregate historical Rx
// distribution from the jobs table, bucket it, and emit as CSV. Two files:
//  • SV stocking: sph/cyl/add buckets, per-material, qty per bucket
//  • Semi stocking: base_curve per material, pucks have no Rx
// Initial-order qty is computed per-bucket (CEIL per bucket) so total never
// underruns the projection target.
// ─────────────────────────────────────────────────────────────────────────────

function csvEsc(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Resolve placeholder SKUs for a scenario: ordered code list + real_sku map.
// Falls back to a single synthetic V1 code when the table is empty (covers
// scenarios created before the placeholder table existed or freshly-wiped
// rows). multiVariant flag drives the "verify supplier mapping" CSV warning.
function resolvePlaceholders(db, scenarioId) {
  let phRows = [];
  try {
    phRows = db.prepare(
      `SELECT placeholder_code, real_sku FROM npi_placeholder_skus WHERE scenario_id = ? ORDER BY variant_index`
    ).all(scenarioId);
  } catch { /* table may not exist on first boot — fall through to fallback */ }
  const phCodes = phRows.length > 0
    ? phRows.map(p => p.placeholder_code)
    : [`NPI-${scenarioId}-V1`];
  const phRealSku = new Map();
  for (const p of phRows) if (p.real_sku) phRealSku.set(p.placeholder_code, p.real_sku);
  return { phCodes, phRealSku, multiVariant: phCodes.length > 1 };
}

// Per-donor expansion for material_category scenarios. For each (material × class)
// target row, return one entry per matching SKU in lens_sku_properties, joined to
// lens_inventory_status for the persisted demand-sensing forecast (projected_weekly)
// and computed_at timestamp. Caller decides fallback if projected_weekly is NULL/0.
//
// Returns: [{ sku, material_code, adoption_pct, base_curve, sample_job_count,
//             projected_weekly, computed_at }]
function getDonorSkusForScenario(db, scenarioId, lensTypeClass) {
  const modalClause = lensTypeClass === 'SV'
    ? `p.lens_type_modal IN ('S','C')`
    : `p.lens_type_modal = 'P'`;
  // lens_inventory_status may not exist on first boot — try/catch guards the JOIN.
  try {
    return db.prepare(`
      SELECT
        p.sku                  AS sku,
        t.material_code        AS material_code,
        t.adoption_pct         AS adoption_pct,
        p.base_curve           AS base_curve,
        p.sample_job_count     AS sample_job_count,
        lis.projected_weekly   AS projected_weekly,
        lis.computed_at        AS computed_at
      FROM npi_scenario_material_targets t
      JOIN lens_sku_properties p
        ON p.material = t.material_code
       AND ${modalClause}
      LEFT JOIN lens_inventory_status lis
        ON lis.sku = p.sku
      WHERE t.scenario_id = ?
        AND t.lens_type_class = ?
      ORDER BY t.material_code, p.sku
    `).all(scenarioId, lensTypeClass);
  } catch {
    // Fall back without the LEFT JOIN if lens_inventory_status doesn't exist.
    return db.prepare(`
      SELECT
        p.sku                  AS sku,
        t.material_code        AS material_code,
        t.adoption_pct         AS adoption_pct,
        p.base_curve           AS base_curve,
        p.sample_job_count     AS sample_job_count,
        NULL                   AS projected_weekly,
        NULL                   AS computed_at
      FROM npi_scenario_material_targets t
      JOIN lens_sku_properties p
        ON p.material = t.material_code
       AND ${modalClause}
      WHERE t.scenario_id = ?
        AND t.lens_type_class = ?
      ORDER BY t.material_code, p.sku
    `).all(scenarioId, lensTypeClass);
  }
}

function computeMaterialCategoryScenarioTotals(db, scenarioId) {
  const scenario = db.prepare('SELECT * FROM npi_scenarios WHERE id = ?').get(scenarioId);
  if (!scenario) return { error: 'Scenario not found' };
  const targetsModule = require('./db');
  const projRows = targetsModule.getMaterialCategoryProjection(scenarioId);
  let svWeekly = 0, semiWeekly = 0;
  const byMatClass = {};
  for (const r of projRows) {
    const key = `${r.lens_type_class}|${r.material_code}`;
    byMatClass[key] = r;
    if (r.lens_type_class === 'SV') svWeekly += r.projected_weekly;
    else if (r.lens_type_class === 'SEMI') semiWeekly += r.projected_weekly;
  }
  const totalLeadTime = (scenario.manufacturing_weeks || 13) + (scenario.transit_weeks || 4) + (scenario.fda_hold_weeks || 2);
  const SAFETY_BY_CLASS = { A: 6, B: 4, C: 3 };
  const totalWeekly = Math.round(svWeekly + semiWeekly);
  const monthly = totalWeekly * 4.33;
  const autoAbc = monthly >= 100 ? 'A' : monthly >= 20 ? 'B' : 'C';
  const abcClass = scenario.abc_class || autoAbc;
  const safetyWeeks = scenario.safety_stock_weeks || SAFETY_BY_CLASS[abcClass];
  const weeks = totalLeadTime + safetyWeeks;
  return {
    scenario, projRows, byMatClass,
    svProjectedWeekly: Math.round(svWeekly * 10) / 10,
    semiProjectedWeekly: Math.round(semiWeekly * 10) / 10,
    totalProjectedWeekly: totalWeekly,
    totalLeadTime, safetyWeeks, abcClass,
    weeksMultiplier: weeks,
    svInitialOrder: Math.ceil(svWeekly * weeks),
    semiInitialOrder: Math.ceil(semiWeekly * weeks),
  };
}

// SV stocking CSV — one row per (donor_sku × Rx). Per-donor expansion replaces
// the bulk material aggregate. Each donor's persisted lens-intelligence forecast
// is split across its own historical Rx histogram, then scaled by adoption_pct
// × (lead+safety) weeks. Falls back to lens_consumption_weekly avg if the
// per-donor forecast is missing. Header still uses computeMaterialCategoryScenarioTotals
// for lead/safety/ABC.
function formatSvStockingCsv(db, scenarioId) {
  const totals = computeMaterialCategoryScenarioTotals(db, scenarioId);
  if (totals.error) return { error: totals.error };

  // Pull the raw operator-selected SV materials so we can surface any that
  // were dropped upstream (no lens_sku_properties rows of the right modal).
  const selectedSvMaterials = db.prepare(
    `SELECT material_code FROM npi_scenario_material_targets
     WHERE scenario_id = ? AND lens_type_class = 'SV'
     ORDER BY material_code`
  ).all(scenarioId).map(r => r.material_code);

  const donors = getDonorSkusForScenario(db, scenarioId, 'SV');
  const { phCodes, phRealSku, multiVariant } = resolvePlaceholders(db, scenarioId);
  const firstVariant = phCodes[0];

  // Empty-SV early-out: still emit dropped-selection warnings so the operator
  // knows their material picks were ignored. Warnings go to the sidecar log,
  // not the CSV body — the supplier file stays clean.
  if (donors.length === 0) {
    const droppedSelections = selectedSvMaterials.slice();
    const earlyWarnings = [];
    const headerLines = [`# NPI SV Stocking — ${csvEsc(totals.scenario.name || '')}`];
    for (const m of droppedSelections) {
      const w = `# WARNING: selected material ${m} had ZERO donor SKUs after expansion`;
      earlyWarnings.push(w);
      console.log(`[NPI-Export] ${w}`);
    }
    headerLines.push('# No SV donor SKUs found for selected materials.');
    return { csv: headerLines.join('\n') + '\n', warnings: earlyWarnings, totals };
  }

  // Same Rx normalization as before: int×100 → decimal, snap to 0.25D.
  const norm = (col) => `ROUND(CAST(${col} AS REAL) / 100.0 / 0.25) * 0.25`;
  const entryDateIso = `('20' || substr(entry_date,7,2) || '-' || substr(entry_date,1,2) || '-' || substr(entry_date,4,2))`;

  // Per-donor Rx histogram: UNION R + L matches on lens_opc_r / lens_opc_l.
  const rxStmt = db.prepare(`
    SELECT sph, cyl, add_pwr, COUNT(*) AS sample_count FROM (
      SELECT ${norm('rx_r_sphere')} AS sph,
             COALESCE(${norm('rx_r_cylinder')}, 0) AS cyl,
             COALESCE(${norm('rx_r_add')}, 0)      AS add_pwr
      FROM jobs
      WHERE lens_opc_r = ?
        AND lens_type IN ('S','C')
        AND rx_r_sphere IS NOT NULL AND rx_r_sphere != ''
        AND ${entryDateIso} >= date('now','-12 months','localtime')
      UNION ALL
      SELECT ${norm('rx_l_sphere')},
             COALESCE(${norm('rx_l_cylinder')}, 0),
             COALESCE(${norm('rx_l_add')}, 0)
      FROM jobs
      WHERE lens_opc_l = ?
        AND lens_type IN ('S','C')
        AND rx_l_sphere IS NOT NULL AND rx_l_sphere != ''
        AND ${entryDateIso} >= date('now','-12 months','localtime')
    )
    GROUP BY sph, cyl, add_pwr
  `);

  // Fallback consumption avg per donor when projected_weekly is NULL/0.
  const fallbackAvgStmt = db.prepare(`
    SELECT SUM(units_consumed) * 1.0 / NULLIF(COUNT(DISTINCT week_start), 0) AS avg
    FROM lens_consumption_weekly
    WHERE sku = ? AND week_start >= date('now','-12 months','localtime')
  `);

  const warnings = [];
  const dataRows = [];

  for (const d of donors) {
    let forecast = d.projected_weekly;
    if (forecast === null || forecast === undefined || forecast === 0) {
      const fb = fallbackAvgStmt.get(d.sku);
      const fbAvg = fb && fb.avg != null ? fb.avg : 0;
      if (fbAvg <= 0) {
        warnings.push(`# WARNING: donor_sku ${d.sku} has no consumption — skipped`);
        continue;
      }
      forecast = fbAvg;
      warnings.push(`# WARNING: donor_sku ${d.sku} has no demand-sensing projection — fell back to flat 12mo average`);
    }

    const hist = rxStmt.all(d.sku, d.sku);
    if (hist.length === 0) {
      warnings.push(`# WARNING: donor_sku ${d.sku} has forecast but no Rx history in window — skipped`);
      continue;
    }

    const donorSamples = hist.reduce((s, r) => s + r.sample_count, 0);
    if (donorSamples <= 0) {
      warnings.push(`# WARNING: donor_sku ${d.sku} has forecast but no Rx history in window — skipped`);
      continue;
    }

    for (const rx of hist) {
      const pctOfDonor = rx.sample_count / donorSamples;
      const weeklyForRow = forecast * pctOfDonor * ((d.adoption_pct || 50) / 100);
      const qty = Math.ceil(weeklyForRow * totals.weeksMultiplier);
      dataRows.push({
        placeholder_sku: firstVariant,
        real_sku: phRealSku.get(firstVariant) || '',
        donor_sku: d.sku,
        material: d.material_code,
        sph: rx.sph || 0,
        cyl: rx.cyl || 0,
        add_pwr: rx.add_pwr || 0,
        sample_count: rx.sample_count,
        weeklyForRow,
        qty,
      });
    }
  }

  // Sort: material → donor_sku → sph → cyl → add
  dataRows.sort((a, b) => {
    if (a.material !== b.material) return String(a.material).localeCompare(String(b.material));
    if (a.donor_sku !== b.donor_sku) return String(a.donor_sku).localeCompare(String(b.donor_sku));
    if (a.sph !== b.sph) return a.sph - b.sph;
    if (a.cyl !== b.cyl) return a.cyl - b.cyl;
    return a.add_pwr - b.add_pwr;
  });

  // Header aggregates
  const orderQtyByMat = {};
  for (const r of dataRows) orderQtyByMat[r.material] = (orderQtyByMat[r.material] || 0) + r.qty;
  const grandSum = dataRows.reduce((s, r) => s + r.qty, 0);

  // Missing-material warning: a selected material that produced no donor rows at all.
  const seenMats = new Set(donors.map(d => d.material_code));
  const missingMats = selectedSvMaterials.filter(m => !seenMats.has(m));

  // Forecast freshness — MAX(computed_at) across the donor SKUs in this scenario.
  const donorSkuList = donors.map(d => d.sku);
  let staleDays = null;
  if (donorSkuList.length > 0) {
    try {
      const ph = donorSkuList.map(() => '?').join(',');
      const fr = db.prepare(
        `SELECT MAX(computed_at) AS maxc FROM lens_inventory_status WHERE sku IN (${ph})`
      ).get(...donorSkuList);
      if (fr && fr.maxc) {
        const ageRow = db.prepare(
          `SELECT CAST((julianday('now') - julianday(?)) AS INTEGER) AS days`
        ).get(fr.maxc);
        if (ageRow && ageRow.days != null) staleDays = ageRow.days;
      }
    } catch { /* lens_inventory_status absent — skip freshness check */ }
  }

  // Malformed entry_date probe: count jobs with non-DVI entry_date format that
  // would have been silently dropped by the per-donor Rx history filter.
  let badDates = { n: 0 };
  if (donorSkuList.length > 0) {
    try {
      const ph = donorSkuList.map(() => '?').join(',');
      // Probe is a single read; we measure both opc_r and opc_l.
      badDates = db.prepare(`
        SELECT COUNT(*) AS n FROM jobs
        WHERE lens_type IN ('S','C')
          AND (lens_opc_r IN (${ph}) OR lens_opc_l IN (${ph}))
          AND entry_date IS NOT NULL
          AND entry_date != ''
          AND (
            LENGTH(entry_date) != 8
            OR substr(entry_date, 3, 1) != '/'
            OR substr(entry_date, 6, 1) != '/'
          )
      `).get(...donorSkuList, ...donorSkuList);
    } catch { /* ignore */ }
  }

  // All `# WARNING:` / `# NOTE:` lines are routed to the `warnings` array (and
  // server log) rather than the CSV body. Phil ships these CSVs to suppliers;
  // the body must contain only summary header + column header + data + grand
  // total. Warnings still surface via the sidecar log file written by the
  // export endpoint and via console.log here for live tailing.
  const exportWarnings = warnings.slice(); // donor-loop warnings collected above
  if (staleDays !== null && staleDays > 3) {
    exportWarnings.push(`# WARNING: forecast last computed ${staleDays} days ago — consider running Lens Intelligence model first`);
  }
  if (multiVariant) {
    exportWarnings.push(`# NOTE: scenario has ${phCodes.length} placeholder variants (${phCodes.join(', ')}). All rows stamped with ${phCodes[0]} only.`);
    exportWarnings.push(`# Additional variants are NOT included in this CSV. Map each variant to specific materials`);
    exportWarnings.push(`# or prescriptions in the UI before splitting the order.`);
  }
  if (badDates && badDates.n > 0) {
    exportWarnings.push(`# NOTE: ${badDates.n} jobs with non-DVI entry_date format were skipped from Rx histogram`);
  }
  for (const m of missingMats) {
    exportWarnings.push(`# WARNING: selected material ${m} had ZERO donor SKUs after expansion`);
  }
  for (const w of exportWarnings) console.log(`[NPI-Export] ${w}`);

  const lines = [];
  lines.push(`# NPI SV Stocking — ${csvEsc(totals.scenario.name || '')}`);
  lines.push(`# Source: material_category | Per-donor-SKU × Rx | Window: last 12 months | R+L samples counted separately`);
  lines.push(`# Rx granularity: 0.25D (standard supplier stocking grid)`);
  lines.push(`# Lead time: ${totals.totalLeadTime}wk | Safety: ${totals.safetyWeeks}wk | ABC: ${totals.abcClass}`);
  lines.push(`#`);
  lines.push(`# TOTAL SV INITIAL ORDER: ${grandSum} lenses`);
  lines.push(`# By material (order quantity):`);
  for (const [mat, q] of Object.entries(orderQtyByMat).sort((a, b) => b[1] - a[1])) {
    lines.push(`#   ${mat}: ${q} lenses   (${Math.round((q / (grandSum || 1)) * 100)}%)`);
  }
  lines.push(`# Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push(['placeholder_sku','real_sku','donor_sku','material','sph','cyl','add','sample_count','weekly_projection','initial_order_qty'].join(','));
  for (const r of dataRows) {
    lines.push([
      csvEsc(r.placeholder_sku),
      csvEsc(r.real_sku),
      csvEsc(r.donor_sku),
      csvEsc(r.material),
      (r.sph || 0).toFixed(2),
      (r.cyl || 0).toFixed(2),
      (r.add_pwr || 0).toFixed(2),
      r.sample_count,
      r.weeklyForRow.toFixed(2),
      r.qty,
    ].join(','));
  }
  lines.push('');
  lines.push(`# Grand total SV: ${grandSum} lenses`);
  return { csv: lines.join('\n'), warnings: exportWarnings, totals };
}

// Semi stocking CSV — one row per donor SKU. base_curve comes from
// lens_sku_properties.base_curve. No Rx (pucks are surfaced after stocking).
// Per-donor forecast × adoption_pct × (lead+safety) weeks; same fallback chain
// as SV (lens_inventory_status → lens_consumption_weekly → skip).
function formatSemiStockingCsv(db, scenarioId) {
  const totals = computeMaterialCategoryScenarioTotals(db, scenarioId);
  if (totals.error) return { error: totals.error };

  const selectedSemiMaterials = db.prepare(
    `SELECT material_code FROM npi_scenario_material_targets
     WHERE scenario_id = ? AND lens_type_class = 'SEMI'
     ORDER BY material_code`
  ).all(scenarioId).map(r => r.material_code);

  const donors = getDonorSkusForScenario(db, scenarioId, 'SEMI');
  const { phCodes, phRealSku, multiVariant } = resolvePlaceholders(db, scenarioId);
  const firstVariant = phCodes[0];

  if (donors.length === 0) {
    return { csv: '# No semi-finished materials selected for cannibalization.\n', warnings: [], totals };
  }

  const fallbackAvgStmt = db.prepare(`
    SELECT SUM(units_consumed) * 1.0 / NULLIF(COUNT(DISTINCT week_start), 0) AS avg
    FROM lens_consumption_weekly
    WHERE sku = ? AND week_start >= date('now','-12 months','localtime')
  `);

  const warnings = [];
  const dataRows = [];

  for (const d of donors) {
    let forecast = d.projected_weekly;
    if (forecast === null || forecast === undefined || forecast === 0) {
      const fb = fallbackAvgStmt.get(d.sku);
      const fbAvg = fb && fb.avg != null ? fb.avg : 0;
      if (fbAvg <= 0) {
        warnings.push(`# WARNING: donor_sku ${d.sku} has no consumption — skipped`);
        continue;
      }
      forecast = fbAvg;
      warnings.push(`# WARNING: donor_sku ${d.sku} has no demand-sensing projection — fell back to flat 12mo average`);
    }

    if (d.base_curve === null || d.base_curve === undefined) {
      warnings.push(`# WARNING: donor_sku ${d.sku} has UNKNOWN base_curve`);
    }

    const weeklyForRow = forecast * ((d.adoption_pct || 50) / 100);
    const qty = Math.ceil(weeklyForRow * totals.weeksMultiplier);
    dataRows.push({
      placeholder_sku: firstVariant,
      real_sku: phRealSku.get(firstVariant) || '',
      donor_sku: d.sku,
      material: d.material_code,
      base_curve: d.base_curve,
      sample_count: d.sample_job_count || 0,
      weeklyForRow,
      qty,
    });
  }

  // Sort: material → donor_sku → base_curve
  dataRows.sort((a, b) => {
    if (a.material !== b.material) return String(a.material).localeCompare(String(b.material));
    if (a.donor_sku !== b.donor_sku) return String(a.donor_sku).localeCompare(String(b.donor_sku));
    const ax = a.base_curve == null ? Infinity : a.base_curve;
    const bx = b.base_curve == null ? Infinity : b.base_curve;
    return ax - bx;
  });

  const orderQtyByMat = {};
  for (const r of dataRows) orderQtyByMat[r.material] = (orderQtyByMat[r.material] || 0) + r.qty;
  const grandSum = dataRows.reduce((s, r) => s + r.qty, 0);

  const seenMats = new Set(donors.map(d => d.material_code));
  const missingMats = selectedSemiMaterials.filter(m => !seenMats.has(m));

  // Forecast freshness across donor SKUs
  const donorSkuList = donors.map(d => d.sku);
  let staleDays = null;
  if (donorSkuList.length > 0) {
    try {
      const ph = donorSkuList.map(() => '?').join(',');
      const fr = db.prepare(
        `SELECT MAX(computed_at) AS maxc FROM lens_inventory_status WHERE sku IN (${ph})`
      ).get(...donorSkuList);
      if (fr && fr.maxc) {
        const ageRow = db.prepare(
          `SELECT CAST((julianday('now') - julianday(?)) AS INTEGER) AS days`
        ).get(fr.maxc);
        if (ageRow && ageRow.days != null) staleDays = ageRow.days;
      }
    } catch { /* ignore */ }
  }

  // All `# WARNING:` / `# NOTE:` lines are routed to the `warnings` array (and
  // server log) rather than the CSV body — supplier-facing file stays clean.
  // The `# Note: base_curve=UNKNOWN ...` line below is a content explainer, not
  // a `# NOTE:`-prefixed warning, so it stays in the body.
  const exportWarnings = warnings.slice(); // donor-loop warnings collected above
  if (staleDays !== null && staleDays > 3) {
    exportWarnings.push(`# WARNING: forecast last computed ${staleDays} days ago — consider running Lens Intelligence model first`);
  }
  if (multiVariant) {
    exportWarnings.push(`# NOTE: scenario has ${phCodes.length} placeholder variants (${phCodes.join(', ')}). All rows stamped with ${phCodes[0]} only.`);
    exportWarnings.push(`# Additional variants are NOT included in this CSV. Map each variant to specific materials`);
    exportWarnings.push(`# or prescriptions in the UI before splitting the order.`);
  }
  for (const m of missingMats) {
    exportWarnings.push(`# WARNING: selected material ${m} had ZERO donor SKUs after expansion`);
  }
  for (const w of exportWarnings) console.log(`[NPI-Export] ${w}`);

  const lines = [];
  lines.push(`# NPI Semi-Finished Stocking — ${csvEsc(totals.scenario.name || '')}`);
  lines.push(`# Source: material_category | Per-donor-SKU | Window: last 12 months`);
  lines.push(`# Lead time: ${totals.totalLeadTime}wk | Safety: ${totals.safetyWeeks}wk | ABC: ${totals.abcClass}`);
  lines.push(`#`);
  lines.push(`# TOTAL SEMI INITIAL ORDER: ${grandSum} pucks`);
  lines.push(`# By material (order quantity):`);
  for (const [mat, q] of Object.entries(orderQtyByMat).sort((a, b) => b[1] - a[1])) {
    lines.push(`#   ${mat}: ${q} pucks   (${Math.round((q / (grandSum || 1)) * 100)}%)`);
  }
  lines.push(`#`);
  lines.push(`# Note: base_curve=UNKNOWN means the SKU has no known BC in lens_sku_properties.`);
  lines.push(`# Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push(['placeholder_sku','real_sku','donor_sku','material','base_curve','sample_count','weekly_projection','initial_order_qty'].join(','));
  for (const r of dataRows) {
    lines.push([
      csvEsc(r.placeholder_sku),
      csvEsc(r.real_sku),
      csvEsc(r.donor_sku),
      csvEsc(r.material),
      r.base_curve != null ? r.base_curve.toFixed(2) : 'UNKNOWN',
      r.sample_count,
      r.weeklyForRow.toFixed(2),
      r.qty,
    ].join(','));
  }
  lines.push('');
  lines.push(`# Grand total Semi: ${grandSum} pucks`);
  return { csv: lines.join('\n'), warnings: exportWarnings, totals };
}

module.exports = { createScenario, updateScenario, deleteScenario, getScenarios, getScenario, computeCannibalization, getActiveAdjustments, expandScenarioToPerJobRows, formatRxListCsv, getCannibalizationVariance, computeMaterialCategoryScenarioTotals, formatSvStockingCsv, formatSemiStockingCsv };
