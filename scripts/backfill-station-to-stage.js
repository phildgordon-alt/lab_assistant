#!/usr/bin/env node
// Phil 2026-05-15 — backfill job_events.stage using corrected
// stationToStage mapping in dvi-trace.js.
//
// Trigger: CCL/CCP/LCU were mis-mapped to COATING (they're SURFACING
// stations: laser marker / polisher / cleaner). RECEIVED COAT was
// mis-mapped to COATING (it's actually "left coating, queued for
// cutting"). The mapping is now corrected for new events; this script
// fixes ~all existing rows so historical dashboards align with DVI.
//
// Two-phase by design — DRY RUN first, then --apply.
//
// Usage:
//   node scripts/backfill-station-to-stage.js               # dry run
//   node scripts/backfill-station-to-stage.js --apply       # do it
//
// Idempotent: re-running --apply won't re-update rows already correct.

'use strict';

const path = require('path');
const Database = require('better-sqlite3');
const { stationToStage } = require(path.join(__dirname, '..', 'server', 'dvi-trace'));

const DB_PATH = process.env.LAB_DB || path.join(__dirname, '..', 'data', 'lab_assistant.db');
const APPLY   = process.argv.includes('--apply');

console.log('━'.repeat(72));
console.log(`Backfill job_events.stage from corrected stationToStage mapping`);
console.log(`db: ${DB_PATH}`);
console.log(`mode: ${APPLY ? 'APPLY (writes will happen)' : 'DRY RUN (read-only)'}`);
console.log('━'.repeat(72));

const db = new Database(DB_PATH, { readonly: !APPLY });
db.pragma('journal_mode = WAL');

// Fetch every distinct (station, current_stage) pair in job_events
// so we can compute per-pair correction count without scanning all rows.
const pairs = db.prepare(`
  SELECT station, stage AS current_stage, COUNT(*) AS n
  FROM job_events
  WHERE station IS NOT NULL AND station != ''
  GROUP BY station, stage
`).all();

const corrections = [];
for (const p of pairs) {
  const correctStage = stationToStage(p.station);
  if (correctStage !== p.current_stage) {
    corrections.push({ station: p.station, oldStage: p.current_stage, newStage: correctStage, n: p.n });
  }
}

if (corrections.length === 0) {
  console.log('All rows already match corrected mapping. Nothing to do.');
  process.exit(0);
}

console.log(`\n${corrections.length} (station, stage) pairs to correct:\n`);
console.log(`  ${'STATION'.padEnd(28)} ${'OLD'.padEnd(12)} → ${'NEW'.padEnd(12)} ROWS`);
console.log(`  ${'─'.repeat(28)} ${'─'.repeat(12)}   ${'─'.repeat(12)} ${'─'.repeat(8)}`);
let totalRows = 0;
for (const c of corrections.sort((a, b) => b.n - a.n)) {
  console.log(`  ${String(c.station).padEnd(28)} ${c.oldStage.padEnd(12)} → ${c.newStage.padEnd(12)} ${c.n}`);
  totalRows += c.n;
}
console.log(`\nTotal rows to update: ${totalRows.toLocaleString()}`);

if (!APPLY) {
  console.log('\nDRY RUN complete. Re-run with --apply to write the changes.');
  process.exit(0);
}

console.log('\nApplying...');
const upd = db.prepare(`UPDATE job_events SET stage = ? WHERE station = ? AND stage = ?`);
let updated = 0;
const tx = db.transaction(() => {
  for (const c of corrections) {
    const r = upd.run(c.newStage, c.station, c.oldStage);
    updated += r.changes;
  }
});
tx();
console.log(`✅ Updated ${updated.toLocaleString()} rows.`);
console.log('Run dwell-estimator + freshness diagnostics to verify downstream:');
console.log('  node scripts/freshness.js');
console.log('  curl -sS http://localhost:3002/api/analytics/dept-rates | python3 -m json.tool | head -50');
