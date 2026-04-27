#!/usr/bin/env node
/**
 * One-shot cleanup: remove ~19 jobs rows whose `invoice` is malformed —
 * non-numeric, too short, or date-shaped (a date string leaked into the
 * INVNUM trace column long ago, before the parseTraceLine guard added in
 * the same PR as this script).
 *
 * Match criteria:
 *   - LENGTH(invoice) < 4                                     // tray-only ('11', '1')
 *   - invoice NOT GLOB '[0-9]*'                               // alphabetic garbage
 *   - LENGTH(invoice) = 8 AND GLOB '20[0-9][0-9][0-9][0-9][0-9][0-9]'  // date YYYYMMDD
 *
 * These rows are harmless individually but pollute the jobs PK space and
 * confuse downstream reports that group by invoice. The trace parser now
 * drops the upstream lines, but historical pollution still needs purging.
 *
 * Usage:
 *   node scripts/cleanup-corrupted-jobs-invoices.js          # dry run (default)
 *   node scripts/cleanup-corrupted-jobs-invoices.js --apply  # commit DELETE
 *
 * Pairs with: scripts/backfill-active-wip-lens-type.js (same `--dry-run` /
 *   `--apply` pattern; same DB; mirrors the report convention).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'lab_assistant.db');
const REPORTS_DIR = path.join(ROOT, 'data', 'backfill-reports');

const APPLY = process.argv.includes('--apply');

const MATCH_WHERE = `
  LENGTH(invoice) < 4
  OR invoice NOT GLOB '[0-9]*'
  OR (LENGTH(invoice) = 8 AND invoice GLOB '20[0-9][0-9][0-9][0-9][0-9][0-9]')
`;

function ensureReportsDir() {
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

function reportPathForToday() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return path.join(REPORTS_DIR, `corrupted-jobs-invoices-${yyyy}-${mm}-${dd}.log`);
}

function main() {
  if (!fs.existsSync(DB_PATH)) { console.error('DB not found:', DB_PATH); process.exit(1); }

  const Database = require('better-sqlite3');
  const db = new Database(DB_PATH);

  const rows = db.prepare(`
    SELECT invoice, current_stage, current_station, status, first_seen_at, has_breakage
    FROM jobs
    WHERE ${MATCH_WHERE}
    ORDER BY invoice
  `).all();

  console.log(`[cleanup/corrupted-jobs] candidates: ${rows.length}`);
  console.log(`[cleanup] Mode: ${APPLY ? 'APPLY (DELETE)' : 'DRY RUN (no writes — pass --apply to commit)'}`);

  if (rows.length === 0) {
    console.log('[cleanup] nothing to do.');
    db.close();
    return;
  }

  ensureReportsDir();
  const reportPath = reportPathForToday();
  const reportLines = [
    `# corrupted-jobs-invoices cleanup — ${new Date().toISOString()}`,
    `# mode=${APPLY ? 'APPLY' : 'DRY-RUN'} candidates=${rows.length}`,
    `# columns: invoice\tcurrent_stage\tcurrent_station\tstatus\tfirst_seen_at\thas_breakage`,
    '',
  ];

  // Print sample (up to 30) to stdout so the operator can sanity-check
  // before re-running with --apply.
  const sample = rows.slice(0, 30);
  console.log('[cleanup] sample of rows that will be DELETED:');
  for (const r of sample) {
    console.log(`  invoice=${JSON.stringify(r.invoice)} stage=${r.current_stage || ''} station=${r.current_station || ''} status=${r.status || ''} firstSeen=${r.first_seen_at || ''} breakage=${r.has_breakage || 0}`);
  }
  if (rows.length > sample.length) {
    console.log(`  ... and ${rows.length - sample.length} more (see report).`);
  }

  for (const r of rows) {
    reportLines.push(`${r.invoice}\t${r.current_stage || ''}\t${r.current_station || ''}\t${r.status || ''}\t${r.first_seen_at || ''}\t${r.has_breakage || 0}`);
  }

  let deleted = 0;
  if (APPLY) {
    const stmt = db.prepare(`DELETE FROM jobs WHERE ${MATCH_WHERE}`);
    const result = stmt.run();
    deleted = result.changes;
    console.log(`[cleanup] deleted ${deleted} rows.`);
  }

  fs.writeFileSync(reportPath, reportLines.join('\n') + '\n');
  console.log(`[cleanup] wrote report: ${reportPath}`);

  if (!APPLY) {
    console.log(`[cleanup] DRY RUN — re-run with --apply to commit the DELETE.`);
  }

  db.close();
}

main();
