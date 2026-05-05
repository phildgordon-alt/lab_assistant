#!/usr/bin/env node
'use strict';

// One-shot cleanup of junk invoices in the jobs table.
//
// "Junk" matches what the trace parser now rejects (after today's
// dvi-trace.js patch):
//   1. Non-numeric invoices            ('8 :25', 'LOG LENSES SF', etc.)
//   2. Too-short numerics              (<4 digits)
//   3. Date-shaped 8-digit YYYYMMDD    (year 2020-2099, valid month/day)
//
// These are pure data corruption from before the parser fix landed —
// they have no XML, no SHIPLOG entry, and no real lab work attached.
//
// SAFETY: defaults to DRY-RUN. Pass --apply to actually delete. Also
// cascades to job_events and stage_transitions so we don't leave orphan
// audit rows pointing to deleted invoices.
//
// Usage:
//   node scripts/cleanup-junk-invoices.js               # dry run
//   node scripts/cleanup-junk-invoices.js --apply       # do it
//   node scripts/cleanup-junk-invoices.js --apply /path/to/db

const Database = require('better-sqlite3');

const APPLY = process.argv.includes('--apply');
const DB_PATH = process.argv.find((a) => a.startsWith('/')) ||
                '/Users/Shared/lab_assistant/data/lab_assistant.db';

const db = new Database(DB_PATH);
console.log(`[cleanup-junk] DB: ${DB_PATH}`);
console.log(`[cleanup-junk] mode: ${APPLY ? 'APPLY (will delete)' : 'DRY RUN'}`);

// SQL predicate matching the same criteria as parseTraceLine's reject path.
// `glob` is SQLite's LIKE-with-? metachars; '[0-9]' character classes give us
// digit-shape matching without a regex. Combined with substring/CAST checks
// for the YYYYMMDD date filter.
const JUNK_WHERE = `
  -- Non-numeric (anything with a non-digit char somewhere)
  invoice GLOB '*[^0-9]*'
  OR length(invoice) < 4
  OR (
    -- 8-digit numeric AND parses as YYYYMMDD with year 2020-2099
    length(invoice) = 8
    AND invoice GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
    AND CAST(substr(invoice, 1, 4) AS INTEGER) BETWEEN 2020 AND 2099
    AND CAST(substr(invoice, 5, 2) AS INTEGER) BETWEEN 1 AND 12
    AND CAST(substr(invoice, 7, 2) AS INTEGER) BETWEEN 1 AND 31
  )
`;

// Preview
const total = db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE ${JUNK_WHERE}`).get().n;
console.log(`[cleanup-junk] junk rows in jobs: ${total}`);

if (total === 0) {
  console.log('[cleanup-junk] nothing to clean — already healthy');
  process.exit(0);
}

const samples = db.prepare(
  `SELECT invoice, status, current_stage, current_station FROM jobs WHERE ${JUNK_WHERE} LIMIT 10`
).all();
console.log(`[cleanup-junk] sample (up to 10):`);
for (const s of samples) {
  console.log(`[cleanup-junk]   '${s.invoice}'  status=${s.status}  stage=${s.current_stage}  station=${s.current_station}`);
}

// Cascade counts (informational)
const eventsCount = db.prepare(
  `SELECT COUNT(*) AS n FROM job_events WHERE invoice IN (SELECT invoice FROM jobs WHERE ${JUNK_WHERE})`
).get().n;
const transCount = db.prepare(
  `SELECT COUNT(*) AS n FROM stage_transitions WHERE job_id IN (SELECT invoice FROM jobs WHERE ${JUNK_WHERE})`
).get().n;
console.log(`[cleanup-junk] cascade: job_events ${eventsCount}, stage_transitions ${transCount}`);

if (!APPLY) {
  console.log('');
  console.log('[cleanup-junk] DRY RUN — no rows modified.');
  console.log('[cleanup-junk] To apply: re-run with --apply');
  process.exit(0);
}

// Apply
console.log('');
console.log('[cleanup-junk] APPLYING — deleting in single transaction...');
const t0 = Date.now();
db.transaction(() => {
  // Capture invoices first (subquery would re-evaluate after first DELETE)
  const invoices = db.prepare(`SELECT invoice FROM jobs WHERE ${JUNK_WHERE}`).all().map((r) => r.invoice);
  if (invoices.length === 0) return;

  const placeholders = invoices.map(() => '?').join(',');
  const r1 = db.prepare(`DELETE FROM job_events       WHERE invoice IN (${placeholders})`).run(...invoices);
  const r2 = db.prepare(`DELETE FROM stage_transitions WHERE job_id  IN (${placeholders})`).run(...invoices);
  const r3 = db.prepare(`DELETE FROM jobs              WHERE invoice IN (${placeholders})`).run(...invoices);
  console.log(`[cleanup-junk]   jobs              -${r3.changes}`);
  console.log(`[cleanup-junk]   job_events        -${r1.changes}`);
  console.log(`[cleanup-junk]   stage_transitions -${r2.changes}`);
})();
console.log(`[cleanup-junk] DONE in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log('[cleanup-junk] Aging dashboard refreshes on next 60s poll.');
