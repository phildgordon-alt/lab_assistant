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

// Route writes through jobs-repo (Step 3j of Task #19).
const { runMigrations } = require('../server/migration-runner');
const { createRepo } = require('../server/domain/jobs-repo');
if (APPLY) runMigrations(db);
const jobsRepo = APPLY ? createRepo(db) : null;

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

// The repo's contract handles both guards we used to enforce inline:
//   - terminal-stage guard (SHIPPED/CANCELED never downgrade) — built into
//     current_stage's guards array via terminalStageGuard.
//   - first-non-null-wins on lens_type — preserves any existing value, so a
//     non-null patch is auto-skipped if the current row already has lens_type.
// We still pre-filter terminal stages to keep stageGuardSkipped accounting
// honest and avoid generating no-op audit rows.

const tx = APPLY ? db.transaction((rows) => {
  for (const r of rows) {
    const newStage    = stationToStage(r.current_station);
    const newLensType = lensTypeFromStation(r.current_station);

    const isTerminal = r.status === 'SHIPPED' || r.current_stage === 'SHIPPED' ||
                       r.status === 'CANCELED' || r.current_stage === 'CANCELED';

    // Two distinct semantic writes — different sources, different contract
    // priorities. Stage repair is `self-heal` (in current_stage's priority);
    // lens_type fallback inferred from station naming is `picks-derive`
    // (lowest-priority slot in lens_type's priority list).
    if (newStage && newStage !== r.current_stage && !isTerminal) {
      try {
        jobsRepo.upsert({
          invoice: String(r.invoice),
          patch: { current_stage: newStage },
          source: 'self-heal',
          observedAt: Date.now(),
          actor: 'backfill:cbob-classification',
          metadata: { station: r.current_station, kind: 'stage-repair' },
        });
        stageChanged++;
        const k = `${r.current_stage}→${newStage}`;
        stageDelta[k] = (stageDelta[k] || 0) + 1;
      } catch (e) {
        console.error(`[backfill-cbob] stage upsert failed ${r.invoice}: ${e.message}`);
      }
    } else if (newStage && newStage !== r.current_stage && isTerminal) {
      stageGuardSkipped++;
    }

    if (newLensType && (r.lens_type === null || r.lens_type === '')) {
      try {
        jobsRepo.upsert({
          invoice: String(r.invoice),
          patch: { lens_type: newLensType },
          source: 'picks-derive',
          observedAt: Date.now(),
          actor: 'backfill:cbob-classification',
          metadata: { station: r.current_station, kind: 'lens-type-from-station' },
        });
        lensTypeFilled++;
      } catch (e) {
        console.error(`[backfill-cbob] lens_type upsert failed ${r.invoice}: ${e.message}`);
      }
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
