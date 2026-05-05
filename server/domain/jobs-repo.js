'use strict';

// server/domain/jobs-repo.js
//
// STEP 2 of Task #19. Single canonical write path for the `jobs` table.
//
// Built on top of jobs-contract.js (Step 1). Every write attempt:
//   1. SELECT current row by invoice
//   2. Call contract.resolve() to determine which fields the source is
//      allowed to write
//   3. Reject the write entirely if it would create a zombie SHIPPED row
//      (status='SHIPPED' with ship_date=NULL) — the bug class we cleaned up
//      on 2026-05-05
//   4. Apply the contract's `changes` to the jobs row (UPDATE or INSERT)
//   5. Write a state_history audit row in the same transaction — including
//      rejection-only writes (no fields applied), so future debugging can
//      see WHY a writer didn't change a row
//
// API:
//   const { createRepo } = require('./jobs-repo');
//   const repo = createRepo(db);                    // pass the better-sqlite3 instance
//   const r = repo.upsert({
//     invoice:    '12345',         // required, must be ≥4-digit numeric
//     patch:      { ... },          // partial jobs row; contract decides what sticks
//     source:     'trace',          // one of contract.SOURCES
//     observedAt: 1715000000000,    // caller's event time in ms (NOT Date.now())
//     actor:      'dvi-trace.js',   // optional; defaults to source
//     metadata:   { ... },          // optional; free-form context for audit log
//   });
//   // r = { applied, skipped, reason, audit_id }
//
// Throws InvalidKeyError, ContractError, or ZombieRowError on hard failures
// (no jobs or state_history rows are written when these throw — full rollback).
//
// NOT YET wired into production. Step 3+ migrate the existing 8 writers to
// call this instead of writing jobs directly.

const contract = require('./jobs-contract');

class InvalidKeyError extends Error {
  constructor(message) { super(message); this.name = 'InvalidKeyError'; this.code = 'INVALID_KEY'; }
}
class ContractError extends Error {
  constructor(message) { super(message); this.name = 'ContractError'; this.code = 'CONTRACT'; }
}
class ZombieRowError extends Error {
  constructor(message) { super(message); this.name = 'ZombieRowError'; this.code = 'ZOMBIE_ROW'; }
}

function createRepo(db) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('createRepo: db must be a better-sqlite3 instance');
  }

  // Prepared statements (per-db-instance; cached for the lifetime of the repo).
  const selectByInvoice = db.prepare('SELECT * FROM jobs WHERE invoice = ?');
  const insertStateHistory = db.prepare(`
    INSERT INTO state_history (
      entity_type, entity_id, source, actor,
      prev_status, next_status, prev_stage, next_stage,
      changes_json, skipped_json, reason_json, metadata_json,
      observed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // UPDATE / INSERT prepared statements are field-set dependent. Cache them
  // keyed on the sorted field list so most calls reuse the same statement.
  const updateCache = new Map();
  const insertCache = new Map();

  function getUpdate(sortedFields) {
    const key = sortedFields.join(',');
    let stmt = updateCache.get(key);
    if (!stmt) {
      const setClauses = sortedFields.map((f) => `${f} = ?`).join(', ');
      stmt = db.prepare(
        `UPDATE jobs SET ${setClauses}, updated_at = datetime('now') WHERE invoice = ?`
      );
      updateCache.set(key, stmt);
    }
    return stmt;
  }

  function getInsert(sortedFields) {
    const key = sortedFields.join(',');
    let stmt = insertCache.get(key);
    if (!stmt) {
      const cols = ['invoice', ...sortedFields, 'updated_at'];
      const placeholders = sortedFields.map(() => '?').join(', ');
      stmt = db.prepare(
        `INSERT INTO jobs (${cols.join(', ')}) VALUES (?, ${placeholders}, datetime('now'))`
      );
      insertCache.set(key, stmt);
    }
    return stmt;
  }

  function upsert({ invoice, patch, source, observedAt, actor, metadata } = {}) {
    // Input validation — fail fast and loud, no silent COALESCE-eats-it.
    if (!contract.numericInvoiceGuard(invoice)) {
      throw new InvalidKeyError(`invalid invoice (must be ≥4-digit numeric): ${invoice}`);
    }
    if (!source || !contract.SOURCES.includes(source)) {
      throw new ContractError(`unknown source: ${source}`);
    }
    if (!patch || typeof patch !== 'object') {
      throw new ContractError('patch must be a non-null object');
    }
    if (typeof observedAt !== 'number' || !Number.isFinite(observedAt)) {
      throw new ContractError('observedAt must be a finite number (ms since epoch)');
    }

    const _actor = actor || source;
    const _metadataJson = metadata ? JSON.stringify(metadata) : null;
    const invoiceStr = String(invoice);

    // One transaction so the jobs row and the state_history row can NEVER disagree.
    const txn = db.transaction(() => {
      const currentRow = selectByInvoice.get(invoiceStr);
      const result = contract.resolve(currentRow, patch, source, observedAt);

      if (result.error) {
        throw new ContractError(result.error);
      }

      // Zombie guard: refuse to write status='SHIPPED' without ship_date.
      // This is the bug class we cleaned up on 2026-05-05 — caught here at the
      // app layer in addition to (eventually) a SQLite trigger in step 3.
      const merged = { ...(currentRow || {}), ...result.changes };
      const willBeShipped = merged.current_stage === 'SHIPPED';
      const noShipDate = merged.ship_date == null;
      if (willBeShipped && noShipDate) {
        throw new ZombieRowError(
          `refusing to write SHIPPED-without-ship_date for invoice ${invoiceStr}`
        );
      }

      // Apply changes to jobs (UPDATE if existing row, INSERT if new). Skip
      // entirely if changes is empty AND we're not creating a new row — that's
      // an identity write (everything the patch said agrees with current row).
      const changedFields = Object.keys(result.changes);
      if (changedFields.length > 0) {
        const sorted = changedFields.slice().sort();
        const values = sorted.map((f) => result.changes[f]);
        if (currentRow) {
          getUpdate(sorted).run(...values, invoiceStr);
        } else {
          getInsert(sorted).run(invoiceStr, ...values);
        }
      }

      // Audit row. Always written when there is something to log — applied
      // changes OR rejected fields. Pure identity writes skip the audit row.
      const hasChanges = changedFields.length > 0;
      const hasSkipped = result.skipped && result.skipped.length > 0;
      let audit_id = null;
      if (hasChanges || hasSkipped) {
        const prevStatus = currentRow ? currentRow.status : null;
        const prevStage = currentRow ? currentRow.current_stage : null;
        const nextStage = merged.current_stage != null ? merged.current_stage : null;
        const nextStatus = nextStage ? contract.deriveStatus(nextStage) : prevStatus;

        const info = insertStateHistory.run(
          'jobs',
          invoiceStr,
          source,
          _actor,
          prevStatus,
          nextStatus,
          prevStage,
          nextStage,
          JSON.stringify(result.changes),
          hasSkipped ? JSON.stringify(result.skipped) : null,
          result.reason && Object.keys(result.reason).length ? JSON.stringify(result.reason) : null,
          _metadataJson,
          observedAt
        );
        audit_id = info.lastInsertRowid;
      }

      return {
        applied: result.changes,
        skipped: result.skipped || [],
        reason: result.reason || {},
        audit_id,
      };
    });

    return txn();
  }

  // Retention. state_history grows by ~25K rows/day once all writers are
  // migrated (Step 6). 90 days = ~2.25M rows, ~50-100 MB. Keeps recent
  // forensic data; older rows go.
  const pruneStmt = db.prepare(
    `DELETE FROM state_history WHERE recorded_at < datetime('now', '-' || ? || ' days')`
  );
  function pruneOldAudit(daysToKeep = 90) {
    if (!Number.isInteger(daysToKeep) || daysToKeep < 1) {
      throw new Error(`pruneOldAudit: daysToKeep must be a positive integer, got ${daysToKeep}`);
    }
    const t0 = Date.now();
    const result = pruneStmt.run(daysToKeep);
    return {
      deleted: result.changes,
      daysToKeep,
      elapsed_ms: Date.now() - t0,
    };
  }

  return { upsert, pruneOldAudit };
}

module.exports = {
  createRepo,
  InvalidKeyError,
  ContractError,
  ZombieRowError,
};
