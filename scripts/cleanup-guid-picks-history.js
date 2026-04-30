#!/usr/bin/env node
/**
 * cleanup-guid-picks-history.js — one-shot cleanup of GUID-shaped order_id rows
 *
 * Background: the historical bug in `backfill-picks-history-from-picks.js`
 * (fixed 2026-04-28) wrote 35,589 rows where `order_id` was an ItemPath GUID
 * (length 36, dash-separated hex) instead of the 6-char DVI invoice. Phil's
 * 2026-04-28 repair UPDATE recovered most of them by joining back to the
 * source picks rows on the GUID, but 664 rows could not be recovered (the
 * source picks row was gone or had no `reference` populated). Those rows
 * are unjoinable to `jobs` and pollute analytics.
 *
 * The live writer can no longer produce GUID-shaped rows — backfill-picks-
 * history-from-picks.js:119 has a defense-in-depth check that throws on any
 * GUID-shaped order_id. So deleting these rows is safe; nothing replaces them.
 *
 * Idempotent: a second run is a no-op once the rows are gone.
 *
 * Usage:
 *   node scripts/cleanup-guid-picks-history.js          # dry run (default)
 *   node scripts/cleanup-guid-picks-history.js --apply  # commit
 */

'use strict';

const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'lab_assistant.db');
const APPLY = process.argv.includes('--apply');

const GUID_GLOB = '????????-????-????-????-????????????';

function main() {
  const Database = require('better-sqlite3');
  const db = new Database(DB_PATH);

  console.log(`[cleanup-guid] DB: ${DB_PATH}`);
  console.log(`[cleanup-guid] Mode: ${APPLY ? 'APPLY' : 'DRY RUN — pass --apply to commit'}`);

  const pre = db.prepare(`
    SELECT COUNT(*) AS n FROM picks_history
    WHERE length(order_id) = 36 AND order_id GLOB ?
  `).get(GUID_GLOB).n;
  console.log(`[cleanup-guid] candidates (length=36 GUID-shaped order_id): ${pre}`);

  if (pre === 0) {
    console.log(`[cleanup-guid] nothing to clean — exit clean.`);
    db.close();
    return;
  }

  // Sample 5 candidate rows so the operator can sanity-check before --apply
  const sample = db.prepare(`
    SELECT pick_id, order_id, sku, completed_at, source FROM picks_history
    WHERE length(order_id) = 36 AND order_id GLOB ?
    ORDER BY completed_at DESC LIMIT 5
  `).all(GUID_GLOB);
  console.log(`[cleanup-guid] sample (newest 5):`);
  for (const r of sample) console.log(`   ${r.completed_at} | ${r.pick_id} | ${r.order_id} | ${r.sku} | source=${r.source}`);

  if (!APPLY) {
    console.log(`[cleanup-guid] DRY RUN — no rows deleted. Re-run with --apply.`);
    db.close();
    return;
  }

  const r = db.prepare(`
    DELETE FROM picks_history
    WHERE length(order_id) = 36 AND order_id GLOB ?
  `).run(GUID_GLOB);
  console.log(`[cleanup-guid] deleted: ${r.changes}`);

  const post = db.prepare(`
    SELECT COUNT(*) AS n FROM picks_history
    WHERE length(order_id) = 36 AND order_id GLOB ?
  `).get(GUID_GLOB).n;
  console.log(`[cleanup-guid] post: residual = ${post} (expect 0)`);

  db.close();
}

main();
