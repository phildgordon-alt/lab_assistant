#!/usr/bin/env node
/**
 * backfill-breakage-events.js — one-shot ingest of every existing
 * data/dvi/breakage/*.txt file into breakage_events.
 *
 * Pre-2026-04-28 there was no writer — the table existed, indices existed,
 * EWS + QCAgent referenced it, but every query returned 0 rows because
 * nothing ever called INSERT. This script populates the historical rows
 * one time; the live writer in oven-timer-server.js handles new files
 * going forward.
 *
 * Usage:
 *   node scripts/backfill-breakage-events.js           # dry run (default)
 *   node scripts/backfill-breakage-events.js --apply   # commit
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BREAKAGE_DIR = path.join(ROOT, 'data', 'dvi', 'breakage');

const APPLY = process.argv.includes('--apply');

function main() {
  if (!fs.existsSync(BREAKAGE_DIR)) {
    console.error('Breakage dir not found:', BREAKAGE_DIR);
    process.exit(1);
  }

  // Lazy require so this script doesn't crash if run outside repo
  const labDb = require(path.join(ROOT, 'server', 'db.js'));

  const files = fs.readdirSync(BREAKAGE_DIR).filter(f => f.endsWith('.txt'));
  console.log(`[breakage-backfill] found ${files.length} *.txt files in ${BREAKAGE_DIR}`);
  console.log(`[breakage-backfill] mode: ${APPLY ? 'APPLY (commit)' : 'DRY RUN — pass --apply to commit'}`);

  let totalRecords = 0;
  let totalInserted = 0;
  let parseErrors = 0;
  let emptyFiles = 0;
  const reasonCounts = {};
  const departmentCounts = {};

  for (const file of files) {
    const fullPath = path.join(BREAKAGE_DIR, file);
    let text;
    try {
      text = fs.readFileSync(fullPath, 'utf8');
    } catch (e) {
      parseErrors++;
      console.warn(`  read-error: ${file}: ${e.message}`);
      continue;
    }
    let records;
    try {
      records = labDb.parseBreakageFile(text, file);
    } catch (e) {
      parseErrors++;
      console.warn(`  parse-error: ${file}: ${e.message}`);
      continue;
    }
    if (!records.length) { emptyFiles++; continue; }
    totalRecords += records.length;
    for (const r of records) {
      reasonCounts[r.reason || 'NULL'] = (reasonCounts[r.reason || 'NULL'] || 0) + 1;
      departmentCounts[r.department || 'NULL'] = (departmentCounts[r.department || 'NULL'] || 0) + 1;
    }
    if (APPLY) {
      const inserted = labDb.insertBreakageEventsBulk(records);
      totalInserted += inserted;
    }
  }

  console.log('');
  console.log(`[breakage-backfill] files examined: ${files.length}`);
  console.log(`[breakage-backfill] records parsed: ${totalRecords}`);
  console.log(`[breakage-backfill] empty files:    ${emptyFiles}`);
  console.log(`[breakage-backfill] parse errors:   ${parseErrors}`);
  if (APPLY) {
    console.log(`[breakage-backfill] rows inserted: ${totalInserted} (others were duplicates)`);
  } else {
    console.log(`[breakage-backfill] DRY RUN — would attempt ${totalRecords} INSERT OR IGNORE rows`);
  }
  console.log('');
  console.log('[breakage-backfill] reason distribution (top 10):');
  for (const [reason, n] of Object.entries(reasonCounts).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  ${reason.padEnd(20)} ${n}`);
  }
  console.log('');
  console.log('[breakage-backfill] department distribution:');
  for (const [dept, n] of Object.entries(departmentCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${dept.padEnd(6)} ${n}`);
  }

  if (APPLY) {
    const final = labDb.db.prepare(`SELECT COUNT(*) AS n FROM breakage_events`).get().n;
    console.log('');
    console.log(`[breakage-backfill] breakage_events row count after: ${final}`);
  }
}

main();
