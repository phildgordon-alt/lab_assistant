#!/usr/bin/env node
/**
 * reconcile-shipped-jobs.js — 2026-04-28 reconcile pass
 *
 * Two passes, both idempotent:
 *
 * (1) Back-prop: for every row in dvi_shipped_jobs, ensure jobs.status='SHIPPED'.
 *     This was supposed to be wired by commit 1a48b31 but stale rows remain.
 *
 * (2) No-xref flip: for jobs stuck in stage='SHIPPING' for >7 days that have
 *     NO matching dvi_shipped_jobs row, mark them status='SHIPPED' + set the
 *     new flag column shipped_no_xref=1 so dashboards can distinguish them
 *     from properly-xrefed shipped rows. This handles the manual-ship /
 *     SHIPLOG-never-landed edge cases without polluting active-WIP queries.
 *
 * Adds the flag column on first run if missing.
 *
 * Usage:
 *   node scripts/reconcile-shipped-jobs.js           # dry run (default)
 *   node scripts/reconcile-shipped-jobs.js --apply   # commit
 */

'use strict';

const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'lab_assistant.db');

const APPLY = process.argv.includes('--apply');
const STALE_DAYS = 7;

function main() {
  const Database = require('better-sqlite3');
  const db = new Database(DB_PATH);

  console.log(`[reconcile] Mode: ${APPLY ? 'APPLY' : 'DRY RUN — pass --apply to commit'}`);

  // ── ensure flag column exists ──────────────────────────────────────────
  const cols = db.prepare(`PRAGMA table_info(jobs)`).all().map(r => r.name);
  if (!cols.includes('shipped_no_xref')) {
    if (APPLY) {
      db.exec(`ALTER TABLE jobs ADD COLUMN shipped_no_xref INTEGER DEFAULT 0`);
      console.log(`[reconcile] added column jobs.shipped_no_xref (default 0)`);
    } else {
      console.log(`[reconcile] WOULD add column jobs.shipped_no_xref (DRY RUN)`);
    }
  } else {
    console.log(`[reconcile] column jobs.shipped_no_xref already present`);
  }

  // ── Pass 1: back-prop dvi_shipped_jobs → jobs.status='SHIPPED' ─────────
  const pass1Pre = db.prepare(`
    SELECT COUNT(*) AS n FROM dvi_shipped_jobs dsj
    JOIN jobs j ON j.invoice = dsj.invoice
    WHERE j.status != 'SHIPPED'
  `).get().n;
  console.log(`[reconcile] pass1 candidates (xref+jobs.status!=SHIPPED): ${pass1Pre}`);

  // ── Pass 2: SHIPPING-stuck >7d with no xref ────────────────────────────
  const pass2Pre = db.prepare(`
    SELECT COUNT(*) AS n FROM jobs j
    WHERE j.current_stage = 'SHIPPING'
      AND j.status != 'SHIPPED'
      AND (j.last_event_at IS NULL OR j.last_event_at < datetime('now', '-${STALE_DAYS} days'))
      AND NOT EXISTS (SELECT 1 FROM dvi_shipped_jobs dsj WHERE dsj.invoice = j.invoice)
  `).get().n;
  console.log(`[reconcile] pass2 candidates (SHIPPING >${STALE_DAYS}d, no xref): ${pass2Pre}`);

  if (!APPLY) {
    console.log(`[reconcile] DRY RUN — no writes. Re-run with --apply.`);
    db.close();
    return;
  }

  const tx = db.transaction(() => {
    // Pass 1 — back-prop
    const r1 = db.prepare(`
      UPDATE jobs
      SET status = 'SHIPPED',
          ship_date = COALESCE(ship_date,
                               (SELECT ship_date FROM dvi_shipped_jobs WHERE invoice = jobs.invoice)),
          shipped_no_xref = 0,
          updated_at = datetime('now')
      WHERE invoice IN (SELECT invoice FROM dvi_shipped_jobs)
        AND status != 'SHIPPED'
    `).run();
    console.log(`[reconcile] pass1 rows updated: ${r1.changes}`);

    // Pass 2 — flag-and-flip stale SHIPPING-no-xref
    const r2 = db.prepare(`
      UPDATE jobs
      SET status = 'SHIPPED',
          shipped_no_xref = 1,
          updated_at = datetime('now')
      WHERE current_stage = 'SHIPPING'
        AND status != 'SHIPPED'
        AND (last_event_at IS NULL OR last_event_at < datetime('now', '-${STALE_DAYS} days'))
        AND NOT EXISTS (SELECT 1 FROM dvi_shipped_jobs dsj WHERE dsj.invoice = jobs.invoice)
    `).run();
    console.log(`[reconcile] pass2 rows updated: ${r2.changes}`);
  });
  tx();

  // ── Verification ───────────────────────────────────────────────────────
  const pass1Post = db.prepare(`
    SELECT COUNT(*) AS n FROM dvi_shipped_jobs dsj
    JOIN jobs j ON j.invoice = dsj.invoice
    WHERE j.status != 'SHIPPED'
  `).get().n;
  const pass2Post = db.prepare(`
    SELECT COUNT(*) AS n FROM jobs j
    WHERE j.current_stage = 'SHIPPING'
      AND j.status != 'SHIPPED'
      AND (j.last_event_at IS NULL OR j.last_event_at < datetime('now', '-${STALE_DAYS} days'))
      AND NOT EXISTS (SELECT 1 FROM dvi_shipped_jobs dsj WHERE dsj.invoice = j.invoice)
  `).get().n;
  const flaggedTotal = db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE shipped_no_xref = 1`).get().n;

  console.log(`[reconcile] post: pass1 residual = ${pass1Post} (expect 0)`);
  console.log(`[reconcile] post: pass2 residual = ${pass2Post} (expect 0)`);
  console.log(`[reconcile] post: total shipped_no_xref=1 rows = ${flaggedTotal}`);

  db.close();
}

main();
