#!/usr/bin/env node
/**
 * One-shot backfill for the 2026-05-04 CBOB misclassification fix.
 *
 * Background: dvi-trace.js's stationToStage() was matching the substrings
 * 'INHSE FIN' / 'INHSE SF' / 'DIG' anywhere in a station name, including
 * inside DVI's CBOB-prefixed holding queue names. So jobs sitting in
 * 'CBOB - INHSE FIN' (DVI's single-vision finished holding queue) were
 * stamped as CUTTING stage in the jobs table, and 'CBOB - INHSE SF' was
 * stamped as SURFACING. Net effect: ~1,250 active WIP jobs that were
 * actually still queued at DVI showed up as past-pick lab work with NULL
 * lens_type, distorting the Aging dashboard outlier % from ~7% to 55%+.
 *
 * The dvi-trace.js fix (committed in the same PR as this script) adds:
 *   - if (s.startsWith('CBOB')) return 'INCOMING'    — early return
 *   - lensTypeFromStation(station) helper            — FIN→S, SF/DIG→P
 *   - upsertJobFromTrace call passes lensType        — populates on next event
 *
 * For NEW trace events, the fix is automatic. This script fixes the EXISTING
 * rows in the jobs table that were stamped before the patch. For each active
 * job, it re-runs the (patched) stationToStage and lensTypeFromStation on
 * current_station and writes back current_stage + lens_type if they differ.
 *
 * Idempotent. Default dry-run; pass --apply to write.
 *
 * Usage:
 *   node scripts/backfill-cbob-classification.js          # dry run
 *   node scripts/backfill-cbob-classification.js --apply  # actually update
 */

'use strict';

const path = require('path');
const Database = require('better-sqlite3');
const { stationToStage, lensTypeFromStation } = require('../server/dvi-trace');

const DB_PATH = process.env.LAB_DB || '/Users/Shared/lab_assistant/data/lab_assistant.db';
const APPLY = process.argv.includes('--apply');

const log = (...a) => console.log('[backfill-cbob]', ...a);

const db = new Database(DB_PATH, { readonly: !APPLY });
db.pragma('journal_mode = WAL');

// ── Pull every job whose current_station might be misclassified ─────────────
// Scope: all jobs (not just active stages) — there may be stale rows in HOLD/
// COATING/etc. that were stamped from a CBOB station event in the past. The
// re-mapping is safe: we only UPDATE if BOTH the new stage differs AND the
// existing row's terminal-state guards permit it (we mirror the upsert's
// rules below to avoid downgrading SHIPPED/CANCELED).
const rows = db.prepare(`
  SELECT invoice, current_stage, status, current_station, lens_type
  FROM jobs
  WHERE current_station IS NOT NULL AND current_station != ''
`).all();

log(`Scanning ${rows.length} jobs for stage / lens_type corrections…`);

let stageChanged = 0, stageGuardSkipped = 0, lensTypeFilled = 0, unchanged = 0;
const stageDelta = {}; // 'CUTTING→INCOMING' → count

const updateStageStmt = APPLY ? db.prepare(`
  UPDATE jobs SET current_stage = @newStage, updated_at = datetime('now')
  WHERE invoice = @invoice
    AND status NOT IN ('SHIPPED','CANCELED')
    AND current_stage NOT IN ('SHIPPED','CANCELED')
`) : null;

const updateLensTypeStmt = APPLY ? db.prepare(`
  UPDATE jobs SET lens_type = @newLensType, updated_at = datetime('now')
  WHERE invoice = @invoice
    AND (lens_type IS NULL OR lens_type = '')
`) : null;

const tx = APPLY ? db.transaction((rows) => {
  for (const r of rows) {
    const newStage    = stationToStage(r.current_station);
    const newLensType = lensTypeFromStation(r.current_station);

    // Stage update — only if differs AND not in terminal state
    if (newStage && newStage !== r.current_stage) {
      if (r.status === 'SHIPPED' || r.current_stage === 'SHIPPED' ||
          r.status === 'CANCELED' || r.current_stage === 'CANCELED') {
        stageGuardSkipped++;
      } else {
        updateStageStmt.run({ invoice: r.invoice, newStage });
        stageChanged++;
        const k = `${r.current_stage}→${newStage}`;
        stageDelta[k] = (stageDelta[k] || 0) + 1;
      }
    }

    // Lens type fill — only if currently NULL and we can derive from station
    if (newLensType && (r.lens_type === null || r.lens_type === '')) {
      updateLensTypeStmt.run({ invoice: r.invoice, newLensType });
      lensTypeFilled++;
    }
  }
}) : null;

if (APPLY) {
  tx(rows);
} else {
  // Dry-run: just count, don't write
  for (const r of rows) {
    const newStage    = stationToStage(r.current_station);
    const newLensType = lensTypeFromStation(r.current_station);

    if (newStage && newStage !== r.current_stage) {
      if (r.status === 'SHIPPED' || r.current_stage === 'SHIPPED' ||
          r.status === 'CANCELED' || r.current_stage === 'CANCELED') {
        stageGuardSkipped++;
      } else {
        stageChanged++;
        const k = `${r.current_stage}→${newStage}`;
        stageDelta[k] = (stageDelta[k] || 0) + 1;
      }
    }
    if (newLensType && (r.lens_type === null || r.lens_type === '')) {
      lensTypeFilled++;
    }
    if (newStage === r.current_stage && (!newLensType || (r.lens_type !== null && r.lens_type !== ''))) {
      unchanged++;
    }
  }
}

log('');
log(`Mode:                          ${APPLY ? 'APPLY (rows updated)' : 'DRY RUN (no DB writes)'}`);
log(`Total jobs scanned:            ${rows.length}`);
log(`Stage corrections:             ${stageChanged}`);
log(`Stage skipped (terminal guard): ${stageGuardSkipped}`);
log(`Lens type filled (was NULL):   ${lensTypeFilled}`);
log('');
if (Object.keys(stageDelta).length > 0) {
  log(`Stage transitions:`);
  for (const [k, n] of Object.entries(stageDelta).sort((a,b) => b[1]-a[1])) {
    log(`  ${k.padEnd(28)} ${String(n).padStart(5)}`);
  }
}
log('');
if (APPLY) {
  // Verify post-state — show new active-WIP NULL lens_type counts
  const post = db.prepare(`
    SELECT current_stage, COUNT(*) AS n,
           SUM(CASE WHEN lens_type IS NULL OR lens_type='' THEN 1 ELSE 0 END) AS null_lens
    FROM jobs
    WHERE current_stage IN ('SURFACING','CUTTING','COATING','ASSEMBLY','SHIPPING')
    GROUP BY current_stage ORDER BY current_stage
  `).all();
  log(`Active WIP after backfill:`);
  for (const r of post) {
    log(`  ${r.current_stage.padEnd(10)} ${String(r.n).padStart(5)}  (${r.null_lens} NULL lens_type)`);
  }
} else {
  log('To apply: re-run with --apply');
}

db.close();
