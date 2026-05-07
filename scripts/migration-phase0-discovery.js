#!/usr/bin/env node
'use strict';

/**
 * ItemPath → Power Pick migration · PHASE 0 · schema discovery + parity baseline
 *
 * READ-ONLY. No commits to production code. Outputs a markdown spec and a
 * JSON snapshot to data/migration-reports/.
 *
 * Per the planner's review (2026-05-07): the original audit's claim that
 * `powerpick.getMaterials()` exists was wrong — it doesn't. Phase 0 must
 * confirm which Power Pick SQL Server tables back which ItemPath REST
 * shapes (materials, locations, location_contents, orders, warehouses,
 * VLMs, transactions) BEFORE any drop-in replacement is attempted.
 *
 * Run this once today, then again tomorrow and the day after — three
 * consecutive runs are the parity baseline. Diverging counts on any day
 * means the candidate table doesn't actually back what we think it does;
 * investigate before mapping.
 *
 * Usage:
 *   node scripts/migration-phase0-discovery.js               # full report
 *   node scripts/migration-phase0-discovery.js --tables-only # just listTables()
 *   node scripts/migration-phase0-discovery.js --quick       # skip 50-SKU sample diff
 */

const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: '/Users/Shared/lab_assistant/.env', override: false });
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: false });

const REPORTS_DIR = path.join(process.env.LAB_DATA_DIR || '/Users/Shared/lab_assistant/data', 'migration-reports');
const TABLES_ONLY = process.argv.includes('--tables-only');
const QUICK = process.argv.includes('--quick');

const powerpick = require('../server/powerpick-adapter');
const itempath  = require('../server/itempath-adapter');

const today = new Date().toISOString().slice(0, 10);
const reportPath = path.join(REPORTS_DIR, `phase0-discovery-${today}.md`);
const jsonPath   = path.join(REPORTS_DIR, `phase0-discovery-${today}.json`);

function ensureDir() { if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true }); }

// Candidate tables, named by what we *expect* to find. The scan is
// fuzzy-matched so we don't miss case differences or vendor-specific
// naming. Phil + the engineer review the results, decide the actual
// mapping, and that gets recorded as the Phase 1 spec.
const CANDIDATES = {
  materials_inventory:   ['Material', 'Materials', 'Inventory', 'Stock', 'OnHand'],
  locations:             ['Location', 'Locations', 'Bin', 'Bins', 'StorageUnit'],
  location_contents:     ['LocationContent', 'LocationContents', 'BinContent', 'StockLocation', 'MaterialLocation'],
  warehouses:            ['Warehouse', 'Warehouses'],
  vlms:                  ['VLM', 'StorageDevice', 'CarrouselUnit', 'Carousel'],
  orders_picks_puts:     ['Order', 'Orders', 'OrderHeader', 'OrderLine', 'OrderLines'],
  transactions:          ['Transaction', 'Transactions', 'History', 'PickHistory'],
  customers:             ['Customer', 'Customers'],
};

function fuzzyMatch(tables, candidates) {
  const lower = candidates.map(c => c.toLowerCase());
  return tables.filter(t => {
    const tn = t.table_name.toLowerCase();
    return lower.some(c => tn === c || tn.includes(c) || c.includes(tn));
  });
}

async function run() {
  ensureDir();
  console.log('[phase0] Power Pick schema discovery starting…');
  console.log('[phase0] Output:', reportPath);

  const out = {
    runAt: new Date().toISOString(),
    today,
    powerpick: { tables: null, schemas: {}, samples: {} },
    itempath:  { cacheCounts: null, sample: null },
    candidateMap: {},
    parityChecks: {},
    notes: [],
  };

  // ── 1. Confirm Power Pick connection ───────────────────────────
  console.log('[phase0] Testing Power Pick connection…');
  const connTest = await powerpick.testConnection();
  if (!connTest.ok) {
    console.error('[phase0] Power Pick connection FAILED:', connTest.error || connTest);
    out.notes.push(`Power Pick connection failed: ${JSON.stringify(connTest)}`);
    fs.writeFileSync(jsonPath, JSON.stringify(out, null, 2));
    fs.writeFileSync(reportPath, `# Phase 0 — ${today}\n\n**ABORTED:** Power Pick connection failed.\n\n\`\`\`\n${JSON.stringify(connTest, null, 2)}\n\`\`\`\n`);
    process.exit(1);
  }
  console.log(`[phase0] connected: ${connTest.server || connTest.database || 'ok'}`);

  // ── 2. List all tables ─────────────────────────────────────────
  console.log('[phase0] Listing tables…');
  const tablesRes = await powerpick.listTables();
  if (!tablesRes.ok) {
    console.error('[phase0] listTables FAILED:', tablesRes.error);
    out.notes.push(`listTables failed: ${tablesRes.error}`);
    fs.writeFileSync(jsonPath, JSON.stringify(out, null, 2));
    process.exit(1);
  }
  out.powerpick.tables = tablesRes.tables;
  console.log(`[phase0] found ${tablesRes.tables.length} tables`);

  if (TABLES_ONLY) {
    writeReport(out);
    return;
  }

  // ── 3. For each candidate group, identify likely tables and inspect ─
  for (const [group, hints] of Object.entries(CANDIDATES)) {
    const matches = fuzzyMatch(tablesRes.tables, hints);
    out.candidateMap[group] = matches.map(m => ({
      schema: m.schema_name,
      table: m.table_name,
      rows:  Number(m.row_count) || 0,
      cols:  m.column_count,
    }));
    for (const m of matches.slice(0, 3)) { // top 3 per group
      const tname = m.table_name;
      console.log(`[phase0] inspecting ${group} → ${tname}…`);
      const cols = await powerpick.getColumns(tname);
      if (cols.ok) out.powerpick.schemas[tname] = cols.columns;
      const rows = await powerpick.sampleRows(tname, 3);
      if (rows.ok) out.powerpick.samples[tname] = rows.rows || rows.sample;
    }
  }

  // ── 4. ItemPath cache counts (read-only, in-memory) ────────────
  console.log('[phase0] Reading ItemPath cache for parity comparison…');
  try {
    const inv = itempath.getInventory();
    const pw  = itempath.getPutWall();
    const wh  = itempath.getWarehouseStock?.() || null;
    const lc  = itempath.getLocationContents?.() || null;
    out.itempath.cacheCounts = {
      materials:        Array.isArray(inv?.materials) ? inv.materials.length : 0,
      activeOrders:     Array.isArray(inv?.orders) ? inv.orders.length : 0,
      warehouseStats:   inv?.warehouseStats ? Object.keys(inv.warehouseStats).length : 0,
      putWallWH1:       pw?.WH1?.activeCount || 0,
      putWallWH2:       pw?.WH2?.activeCount || 0,
      warehouseStock:   Array.isArray(wh) ? wh.length : (wh ? Object.keys(wh).length : 0),
      locationContents: Array.isArray(lc) ? lc.length : (lc ? Object.keys(lc).length : 0),
    };
    if (!QUICK && Array.isArray(inv?.materials) && inv.materials.length) {
      // Sample 50 SKUs and capture qty for the parity check we'll do
      // tomorrow when we know which Power Pick table holds materials.
      const sample = [];
      const step = Math.max(1, Math.floor(inv.materials.length / 50));
      for (let i = 0; i < inv.materials.length; i += step) {
        const m = inv.materials[i];
        sample.push({ sku: m.sku || m.materialName, qty: m.qty, warehouse: m.warehouse, name: m.name });
        if (sample.length >= 50) break;
      }
      out.itempath.sample = sample;
    }
  } catch (e) {
    out.notes.push(`ItemPath cache read failed: ${e.message}`);
  }

  // ── 5. Pick history parity (Power Pick replaced this — verify) ─
  // The migration of picks to Power Pick is supposedly DONE. Verify by
  // checking picks_history for source distribution today and the past
  // 30 days. Surface any day where 'powerpick' rows are missing.
  try {
    const Database = require('better-sqlite3');
    const db = new Database('/Users/Shared/lab_assistant/data/lab_assistant.db', { readonly: true });
    out.parityChecks.picksBySource30d = db.prepare(`
      SELECT date(completed_at) AS d, source, COUNT(*) AS n
      FROM picks_history
      WHERE completed_at >= date('now', '-30 days')
      GROUP BY date(completed_at), source
      ORDER BY d DESC, source
    `).all();
    out.parityChecks.picksBySourceToday = db.prepare(`
      SELECT source, warehouse, COUNT(*) AS n
      FROM picks_history
      WHERE completed_at >= date('now', 'localtime')
      GROUP BY source, warehouse
      ORDER BY source, warehouse
    `).all();
    db.close();
  } catch (e) {
    out.notes.push(`picks_history parity check failed: ${e.message}`);
  }

  writeReport(out);
}

function writeReport(out) {
  fs.writeFileSync(jsonPath, JSON.stringify(out, null, 2));
  console.log(`[phase0] JSON snapshot: ${jsonPath}`);

  let md = `# Phase 0 — ItemPath → Power Pick Discovery — ${out.today}\n\n`;
  md += `_Run: ${out.runAt}_\n\n`;
  md += `**This is a read-only diagnostic. No production code was modified.**\n\n`;

  md += `## Power Pick — Tables (top 30 by row count)\n\n`;
  md += `| Schema | Table | Rows | Cols |\n|---|---|---:|---:|\n`;
  for (const t of (out.powerpick.tables || []).slice(0, 30)) {
    md += `| ${t.schema_name} | ${t.table_name} | ${(Number(t.row_count) || 0).toLocaleString()} | ${t.column_count} |\n`;
  }
  md += `\n_Total tables: ${(out.powerpick.tables || []).length}_\n\n`;

  md += `## Candidate Mapping (fuzzy match — engineer must confirm)\n\n`;
  for (const [group, matches] of Object.entries(out.candidateMap || {})) {
    md += `### ${group}\n\n`;
    if (!matches.length) { md += `_No candidate tables matched._\n\n`; continue; }
    md += `| Schema | Table | Rows | Cols |\n|---|---|---:|---:|\n`;
    for (const m of matches) md += `| ${m.schema} | ${m.table} | ${m.rows.toLocaleString()} | ${m.cols} |\n`;
    md += `\n`;
    for (const m of matches.slice(0, 3)) {
      const cols = out.powerpick.schemas[m.table];
      if (cols && cols.length) {
        md += `<details><summary>${m.table} columns</summary>\n\n`;
        md += `| Column | Type | Nullable |\n|---|---|---|\n`;
        for (const c of cols) md += `| ${c.column_name} | ${c.data_type}${c.character_maximum_length ? `(${c.character_maximum_length})` : ''} | ${c.is_nullable} |\n`;
        md += `\n</details>\n\n`;
      }
    }
  }

  md += `## ItemPath Cache Snapshot (live, in-memory)\n\n`;
  if (out.itempath.cacheCounts) {
    md += `| Shape | Count |\n|---|---:|\n`;
    for (const [k, v] of Object.entries(out.itempath.cacheCounts)) md += `| ${k} | ${v.toLocaleString()} |\n`;
    md += `\n`;
  } else {
    md += `_No ItemPath cache available — adapter may not be running or token missing._\n\n`;
  }

  md += `## Picks-History Parity (last 30 days)\n\n`;
  const todayBySrc = out.parityChecks.picksBySourceToday || [];
  if (todayBySrc.length) {
    md += `### Today\n\n| Source | Warehouse | Picks |\n|---|---|---:|\n`;
    for (const r of todayBySrc) md += `| ${r.source || '(null)'} | ${r.warehouse || '(null)'} | ${r.n.toLocaleString()} |\n`;
    md += `\n`;
  }
  const last30 = out.parityChecks.picksBySource30d || [];
  if (last30.length) {
    md += `### Daily (last 30 days)\n\n| Date | Source | Picks |\n|---|---|---:|\n`;
    for (const r of last30) md += `| ${r.d} | ${r.source || '(null)'} | ${r.n.toLocaleString()} |\n`;
    md += `\n`;
  }

  md += `## Notes / Issues\n\n`;
  if (out.notes && out.notes.length) for (const n of out.notes) md += `- ${n}\n`;
  else md += `_None._\n`;

  md += `\n---\n\n`;
  md += `## Next Steps (per planner review 2026-05-07)\n\n`;
  md += `1. **Eyeball the candidate map.** Each ItemPath shape should map cleanly to ONE Power Pick table. If a row in this report shows zero candidates for "materials_inventory" or "location_contents", the migration cannot proceed — investigate.\n`;
  md += `2. **Re-run this script tomorrow and the day after.** Any change in row counts >2% on the same day-over-day comparison is a flag.\n`;
  md += `3. **Once the mapping is confirmed**, write a sample-50-SKU diff script that queries Power Pick directly for those SKUs and compares qty to the cached ItemPath sample. Tolerance: ±0 units.\n`;
  md += `4. **No production code changes** until items 1–3 pass.\n`;

  fs.writeFileSync(reportPath, md);
  console.log(`[phase0] Markdown report: ${reportPath}`);
  console.log('[phase0] DONE.');
}

run().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
