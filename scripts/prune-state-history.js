#!/usr/bin/env node
'use strict';

// Prune old state_history rows. Default keeps 90 days. Run via cron/launchd.
//
// Usage:
//   node scripts/prune-state-history.js                       # 90-day default
//   node scripts/prune-state-history.js 60                    # keep 60 days
//   node scripts/prune-state-history.js 30 /path/to/db.sqlite # custom DB

const Database = require('better-sqlite3');
const { createRepo } = require('../server/domain/jobs-repo');

const days = process.argv[2] ? parseInt(process.argv[2], 10) : 90;
const dbPath = process.argv[3] || '/Users/Shared/lab_assistant/data/lab_assistant.db';

if (!Number.isInteger(days) || days < 1) {
  console.error(`prune-state-history: days must be a positive integer (got '${process.argv[2]}')`);
  process.exit(1);
}

const db = new Database(dbPath);
const repo = createRepo(db);

const result = repo.pruneOldAudit(days);
console.log(
  `[prune-state-history] deleted=${result.deleted} daysToKeep=${result.daysToKeep} elapsed=${result.elapsed_ms}ms`
);

db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').run();
