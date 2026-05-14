#!/usr/bin/env node
// Phil 2026-05-13 — NPI tier-floor impact report.
//
// Runs formatSvStockingCsv against a scenario and prints a tier-by-tier
// breakdown of the new bump-up behavior. Compares to what the order
// would have been WITHOUT the tier floor (originalQty per row).
//
// Usage:  node scripts/npi-tier-floor-report.js <scenario_id>
// Default scenario: mo9bz9s54dly  (1.74 NPI)

'use strict';

const path = require('path');
const Database = require('better-sqlite3');
const { formatSvStockingCsv, classifyRxTier } = require(path.join(__dirname, '..', 'server', 'npi-engine'));

const DB_PATH = process.env.LAB_DB || path.join(__dirname, '..', 'data', 'lab_assistant.db');
const SCENARIO_ID = process.argv[2] || 'mo9bz9s54dly';

const db = new Database(DB_PATH, { readonly: false });
db.pragma('journal_mode = WAL');

const result = formatSvStockingCsv(db, SCENARIO_ID);
if (result.error) {
  console.error('ERROR:', result.error);
  process.exit(1);
}

// formatSvStockingCsv returns { csv, warnings, totals, surfacingRows? } —
// to get per-row details, parse the CSV body. Easier path: re-invoke the
// internal pieces. The CSV header summary already includes the tier
// breakdown — fish the SUMMARY lines out.

const warns = (result.warnings || []).filter(w => /SUMMARY|NOTE/.test(w));
const tierLine = warns.find(w => /tier floor/.test(w));
const ltLine   = warns.find(w => /long-tail/.test(w));
const minLine  = warns.find(w => /below min-stock/.test(w));

console.log('━'.repeat(72));
console.log(`NPI tier-floor report — scenario ${SCENARIO_ID}`);
console.log(`db: ${DB_PATH}`);
console.log('━'.repeat(72));

// Pull data rows from the CSV (skip comment + header lines).
const lines = (result.csv || '').split('\n').filter(l => l && !l.startsWith('#'));
const header = (lines[0] || '').split(',');
const idx = (k) => header.indexOf(k);
const dataRows = lines.slice(1).map(l => {
  const cols = l.split(',');
  return {
    sph: parseFloat(cols[idx('sph')] || 0),
    cyl: parseFloat(cols[idx('cyl')] || 0),
    qty: parseInt(cols[idx('initial_order_qty')] || cols[idx('qty')] || 0, 10),
  };
});

const tierAgg = {
  simple:   { rows: 0, qty: 0 },
  moderate: { rows: 0, qty: 0 },
  hard:     { rows: 0, qty: 0 },
};
for (const r of dataRows) {
  const t = classifyRxTier(r.sph, r.cyl);
  tierAgg[t].rows++;
  tierAgg[t].qty += r.qty;
}

const grand = dataRows.reduce((s, r) => s + r.qty, 0);

console.log('');
console.log(`Total SV order:        ${grand} lenses across ${dataRows.length} rows`);
console.log('');
console.log('Tier breakdown (engine output, post-bump):');
console.log(`  simple    rows=${String(tierAgg.simple.rows).padStart(5)}  qty=${String(tierAgg.simple.qty).padStart(6)}`);
console.log(`  moderate  rows=${String(tierAgg.moderate.rows).padStart(5)}  qty=${String(tierAgg.moderate.qty).padStart(6)}`);
console.log(`  hard      rows=${String(tierAgg.hard.rows).padStart(5)}  qty=${String(tierAgg.hard.qty).padStart(6)}`);
console.log('');
if (tierLine) console.log(tierLine.replace(/^# /, ''));
if (minLine)  console.log(minLine.replace(/^# /, ''));
if (ltLine)   console.log(ltLine.replace(/^# /, ''));
console.log('');
console.log('Compare to xlsx review (Claude Desktop):');
console.log('  As submitted (raw):       20327');
console.log('  Paired only (no floors):  21002');
console.log('  Paired + tiered floors:   21812   <- target');
console.log('');
console.log('━'.repeat(72));
