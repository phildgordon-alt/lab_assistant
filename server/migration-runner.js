'use strict';

// Forward-only migration runner. Reads server/migrations/NNN_*.sql, runs
// unapplied ones in order. Each migration runs in a single transaction;
// failure stops the runner and leaves the DB in its prior state.
//
// Convention:
//   - File name format: NNN_short_description.sql (e.g., 001_state_history.sql)
//   - Three-digit prefix sorts naturally; description is informational only.
//   - Version key in schema_migrations = filename without .sql extension.
//   - Forward-only: no DOWN migrations. Manual revert if needed.
//   - Migrations should be idempotent within their own transaction
//     (use IF NOT EXISTS where possible).
//
// Existing inline DDL in db.js continues to work unchanged. Only NEW schema
// changes from 2026-05-05 onward go through this runner. The intent is that
// over time, schema evolution becomes fully tracked here without forcing a
// big-bang refactor of the existing inline DDL.

const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function runMigrations(db, opts = {}) {
  const log = opts.log || ((s) => console.log(`[migrations] ${s}`));

  // Tracking table — the one piece of schema we always need before reading
  // state. Idempotent.
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Read what's already applied
  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version)
  );

  // List migration files (sorted lexicographically — relies on NNN_ prefix)
  let files;
  try {
    files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();
  } catch (e) {
    if (e.code === 'ENOENT') {
      log('no migrations/ directory yet — nothing to run');
      return;
    }
    throw e;
  }

  const pending = files.filter((f) => !applied.has(f.replace(/\.sql$/, '')));
  if (pending.length === 0) {
    log(`up to date (${applied.size} applied, 0 pending)`);
    return;
  }
  log(`${pending.length} pending: ${pending.join(', ')}`);

  const insertVersion = db.prepare('INSERT INTO schema_migrations (version) VALUES (?)');

  for (const file of pending) {
    const version = file.replace(/\.sql$/, '');
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');

    const t0 = Date.now();
    log(`applying ${version}...`);
    try {
      db.transaction(() => {
        db.exec(sql);
        insertVersion.run(version);
      })();
    } catch (e) {
      log(`FAILED: ${version} — ${e.message}`);
      throw new Error(`Migration ${version} failed: ${e.message}`);
    }
    log(`applied ${version} in ${Date.now() - t0}ms`);
  }

  log(`all migrations up to date (${pending.length} new)`);
}

module.exports = { runMigrations };
