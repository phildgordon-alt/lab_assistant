#!/usr/bin/env node
/**
 * backfill-picks-history-from-picks.js — pickSync rebuild (2026-04-22)
 *
 * One-shot recovery: scans the local `picks` table for archived picks (i.e.
 * picks the dual-writer or upsertPicks flagged as completed) that DON'T have
 * a corresponding picks_history row, and inserts them with source='recovered'.
 *
 * Why this exists:
 *   The dual-writer / pickSync pipeline missed roughly 30% of picks on busy
 *   weekdays because picks that started AND completed within a single 5-min
 *   poll gap never appeared in the diff between consecutive polls. Many of
 *   those picks DID get written into the local `picks` table (because
 *   upsertPicks runs every poll on the active orders snapshot), so we have
 *   a ground-truth-ish local source we can replay into picks_history.
 *
 * pick_id strategy:
 *   `picks.id` is `${order_id}-${sku}` (see db.js upsertPicks at ~1822).
 *   We tag recovered rows with `pick_id = 'rec-' + picks.id` so the
 *   namespace can never collide with 'hist-<line.id>' (live-writer),
 *   'tx-<transaction_id>' (tx-writer + new BACKFILL), or NULL (legacy).
 *
 * Idempotency:
 *   - INSERT OR IGNORE on the unique pick_id index.
 *   - Pre-check: skip rows that already have a matching
 *     (order_id, sku, completed_at) tuple in picks_history (covers any
 *     row written by some other writer with a different pick_id).
 *
 * Scope: last 30 days of `picks.completed_at`.
 *
 * Usage:
 *   node scripts/backfill-picks-history-from-picks.js          # apply
 *   node scripts/backfill-picks-history-from-picks.js --dry-run  # log only
 */

'use strict';

const path = require('path');
const Database = require('better-sqlite3');

const DRY_RUN = process.argv.includes('--dry-run');
const DAYS = 30;

const DB_PATH = path.join(__dirname, '..', 'data', 'lab_assistant.db');

function main() {
  const db = new Database(DB_PATH);
  console.log(`[recovery] Opened ${DB_PATH} ${DRY_RUN ? '(DRY RUN)' : '(APPLY)'}`);

  // Ensure source column exists (no-op if already present — db.js does the
  // ALTER on startup but this script may run before the server has booted).
  try { db.exec(`ALTER TABLE picks_history ADD COLUMN source TEXT DEFAULT NULL`); } catch (e) { /* ok */ }

  // Verify the unique index on pick_id is in place — if missing, this script
  // would write duplicates on every run. Refuse rather than corrupt the table.
  const hasIdx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_picks_hist_pick_id'`).get();
  if (!hasIdx) {
    console.error('[recovery] FATAL: idx_picks_hist_pick_id missing — refusing to run (would create duplicates).');
    process.exit(2);
  }

  // Candidate set: archived picks with a completed_at, last 30 days,
  // with no picks_history row sharing the same (order_id, sku, completed_at)
  // tuple. NOT IN ... is faster than NOT EXISTS for this size with the
  // existing idx_picks_hist_completed index.
  const candidates = db.prepare(`
    SELECT p.id, p.order_id, p.sku, p.name, p.qty, p.warehouse, p.completed_at
    FROM picks p
    WHERE p.archived = 1
      AND p.completed_at IS NOT NULL
      AND p.completed_at >= datetime('now', '-${DAYS} days')
      AND NOT EXISTS (
        SELECT 1 FROM picks_history h
        WHERE h.order_id = p.order_id
          AND h.sku      = p.sku
          AND substr(h.completed_at, 1, 10) = substr(p.completed_at, 1, 10)
      )
    ORDER BY p.completed_at
  `).all();

  console.log(`[recovery] ${candidates.length} candidate picks (archived, last ${DAYS} days, no matching picks_history row)`);

  // Group by date for the per-day log line.
  const byDate = new Map();
  for (const c of candidates) {
    const d = (c.completed_at || '').substring(0, 10) || 'unknown';
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(c);
  }
  const dates = [...byDate.keys()].sort();

  if (DRY_RUN) {
    for (const d of dates) {
      console.log(`[recovery] Would recover ${byDate.get(d).length} picks for date ${d}`);
    }
    console.log(`[recovery] DRY RUN — no rows inserted. Total candidates: ${candidates.length}`);
    return;
  }

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO picks_history
      (pick_id, order_id, sku, name, qty, picked, warehouse, completed_at, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'recovered')
  `);

  let totalInserted = 0;
  const tx = db.transaction(() => {
    for (const c of candidates) {
      const qty = c.qty || 0;
      const result = insertStmt.run(
        `rec-${c.id}`,
        c.order_id,
        c.sku,
        c.name || c.sku,
        qty,
        qty,
        c.warehouse,
        c.completed_at,
      );
      if (result.changes > 0) totalInserted++;
    }
  });
  tx();

  for (const d of dates) {
    console.log(`[recovery] Recovered ${byDate.get(d).length} picks for date ${d}`);
  }
  console.log(`[recovery] DONE — ${totalInserted} rows inserted (source='recovered')`);
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('[recovery] FATAL:', e); process.exit(1); }
}

module.exports = { main };
