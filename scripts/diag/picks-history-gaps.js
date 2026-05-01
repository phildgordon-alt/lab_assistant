#!/usr/bin/env node
/**
 * Read-only probe: measure picks_history coverage on the prod DB.
 * Identifies missing/thin days, confirms Apr 5–10 cliff, flags other anomalous
 * days, and confirms the transactions table does not yet exist.
 *
 * Run on the Mac Studio (prod):
 *   cd /Users/Shared/lab_assistant && node probe_picks_history_gaps.js
 *
 * No writes. Output goes to stdout and /tmp/itempath-gap-report.txt.
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.argv[2] || path.join(__dirname, 'data', 'lab_assistant.db');
const db = new Database(DB_PATH, { readonly: true });

const WEEKDAY_THRESHOLD = 1500;
const SATURDAY_THRESHOLD = 200;
const DAYS_BACK = 60;

const lines = [];
const say = s => { console.log(s); lines.push(s); };

say(`\nProd DB: ${DB_PATH}`);
say(`Probe date: ${new Date().toISOString()}`);
say(`Scan window: last ${DAYS_BACK} days`);

// 1. Transactions table existence
const txTable = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='transactions'`).get();
say(`\n--- Transactions table ---`);
say(txTable ? `EXISTS — unexpected, investigate before Step 2` : `does NOT exist (expected)`);

// 2. picks_history bounds
const bounds = db.prepare(`
  SELECT MIN(date(completed_at)) as earliest,
         MAX(date(completed_at)) as latest,
         COUNT(*) as total
  FROM picks_history
  WHERE completed_at IS NOT NULL
`).get();
say(`\n--- picks_history bounds ---`);
say(`Earliest: ${bounds.earliest}   Latest: ${bounds.latest}   Total rows: ${bounds.total}`);

// 3. Per-day counts, last N days
const perDay = db.prepare(`
  SELECT date(completed_at) as d,
         COUNT(*) as cnt,
         COUNT(DISTINCT pick_id) as distinct_pick_ids,
         SUM(CASE WHEN pick_id LIKE 'hist-%' THEN 1 ELSE 0 END) as hist_prefix,
         SUM(CASE WHEN pick_id LIKE 'backfill%' THEN 1 ELSE 0 END) as backfill_prefix,
         SUM(CASE WHEN pick_id LIKE 'tx-%' THEN 1 ELSE 0 END) as tx_prefix
  FROM picks_history
  WHERE completed_at IS NOT NULL
    AND date(completed_at) >= date('now', ?)
  GROUP BY date(completed_at)
  ORDER BY d
`).all(`-${DAYS_BACK} days`);

say(`\n--- Per-day counts (last ${DAYS_BACK} days) ---`);
say(`date         dow  count    distinct  hist-   backfill  tx-     flag`);
say(`--------------------------------------------------------------------`);

const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
let anomalousDays = [];
for (const r of perDay) {
  const d = new Date(r.d + 'T12:00:00Z');
  const dow = DOW[d.getUTCDay()];
  let flag = '';
  if (dow === 'Sun' && r.cnt > 0) flag = 'SUNDAY-HAS-DATA';
  else if (dow === 'Sat' && r.cnt < SATURDAY_THRESHOLD) flag = 'SAT-LOW';
  else if (dow !== 'Sun' && dow !== 'Sat' && r.cnt < WEEKDAY_THRESHOLD) flag = 'WEEKDAY-LOW';
  const cliff = (r.d >= '2026-04-05' && r.d <= '2026-04-10') ? ' [CLIFF]' : '';
  if (flag || cliff) anomalousDays.push(r.d);
  say(
    `${r.d}   ${dow}  ${String(r.cnt).padStart(5)}   ` +
    `${String(r.distinct_pick_ids).padStart(7)}   ` +
    `${String(r.hist_prefix).padStart(5)}   ` +
    `${String(r.backfill_prefix).padStart(8)}   ` +
    `${String(r.tx_prefix).padStart(5)}   ${flag}${cliff}`
  );
}

// 4. Days completely missing from the window
say(`\n--- Days with ZERO rows in window ---`);
const present = new Set(perDay.map(r => r.d));
const today = new Date();
const missing = [];
for (let i = DAYS_BACK; i >= 0; i--) {
  const d = new Date(today.getTime() - i * 86400000);
  const s = d.toISOString().slice(0, 10);
  if (!present.has(s)) missing.push(s);
}
if (missing.length === 0) say(`(none — every day in window has at least one row)`);
else for (const m of missing) {
  const dow = DOW[new Date(m + 'T12:00:00Z').getUTCDay()];
  say(`${m}   ${dow}`);
}

// 5. Summary
say(`\n--- Summary ---`);
say(`Anomalous days: ${anomalousDays.length}`);
say(`Missing days:   ${missing.length}`);
say(`\nRecommended --from: ${anomalousDays[0] || missing[0] || 'N/A'}`);
say(`Recommended --to:   ${bounds.latest}`);

fs.writeFileSync('/tmp/itempath-gap-report.txt', lines.join('\n'));
say(`\nReport written to /tmp/itempath-gap-report.txt`);
