// server/domain/jobs-repo.test.js
//
// Run with:  node --test server/domain/
//
// Uses Node's built-in test runner. Each test creates an in-memory SQLite
// database, runs the 001_state_history.sql migration to set up the audit
// table, creates a minimal jobs table, and exercises the repo.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const { createRepo, InvalidKeyError, ContractError, ZombieRowError } = require('./jobs-repo');

// ─────────────────────────────────────────────────────────────────────────────
// Test fixture: minimal jobs table + state_history (from the real migration)
// ─────────────────────────────────────────────────────────────────────────────
const STATE_HISTORY_SQL = fs.readFileSync(
  path.join(__dirname, '..', 'migrations', '001_state_history.sql'),
  'utf8'
);

const JOBS_SQL = `
  CREATE TABLE jobs (
    invoice TEXT PRIMARY KEY,
    reference TEXT,
    tray TEXT,
    current_stage TEXT,
    current_station TEXT,
    operator TEXT,
    status TEXT DEFAULT 'ACTIVE',
    rush TEXT DEFAULT 'N',
    ship_date TEXT,
    ship_time TEXT,
    lens_type TEXT,
    is_hko INTEGER DEFAULT 0,
    has_breakage INTEGER DEFAULT 0,
    updated_at TEXT
  );
`;

function freshDb() {
  const db = new Database(':memory:');
  db.exec(JOBS_SQL);
  db.exec(STATE_HISTORY_SQL);
  return db;
}

const T0 = 1715000000000; // arbitrary fixed observedAt for deterministic tests

// ═════════════════════════════════════════════════════════════════════════════
// SECTION A — basic mechanics (insert, update, identity)
// ═════════════════════════════════════════════════════════════════════════════

test('A1: INSERT path — new invoice creates jobs row + state_history row', () => {
  const db = freshDb();
  const repo = createRepo(db);

  const r = repo.upsert({
    invoice: '450123',
    patch: { tray: 'T-047', current_stage: 'COATING', operator: 'mhernandez' },
    source: 'trace',
    observedAt: T0,
    actor: 'dvi-trace.js',
  });

  assert.equal(typeof r.audit_id, 'number');
  assert.equal(r.applied.tray, 'T-047');
  assert.equal(r.applied.current_stage, 'COATING');
  assert.deepEqual(r.skipped, []);

  const job = db.prepare('SELECT * FROM jobs WHERE invoice=?').get('450123');
  assert.equal(job.tray, 'T-047');
  assert.equal(job.current_stage, 'COATING');

  const audit = db.prepare('SELECT * FROM state_history WHERE id=?').get(r.audit_id);
  assert.equal(audit.entity_type, 'jobs');
  assert.equal(audit.entity_id, '450123');
  assert.equal(audit.source, 'trace');
  assert.equal(audit.actor, 'dvi-trace.js');
  assert.equal(audit.prev_status, null);
  assert.equal(audit.next_stage, 'COATING');
  assert.equal(audit.observed_at, T0);
});

test('A2: UPDATE path — second write only modifies changed fields', () => {
  const db = freshDb();
  const repo = createRepo(db);

  repo.upsert({
    invoice: '450123',
    patch: { tray: 'T-047', current_stage: 'COATING' },
    source: 'trace',
    observedAt: T0,
  });
  const r2 = repo.upsert({
    invoice: '450123',
    patch: { current_stage: 'ASSEMBLY' }, // tray unchanged, stage moved
    source: 'trace',
    observedAt: T0 + 1000,
  });

  assert.equal(r2.applied.current_stage, 'ASSEMBLY');
  assert.equal(r2.applied.tray, undefined); // not in patch, not changed

  const job = db.prepare('SELECT * FROM jobs WHERE invoice=?').get('450123');
  assert.equal(job.current_stage, 'ASSEMBLY');
  assert.equal(job.tray, 'T-047'); // preserved

  const audits = db.prepare('SELECT prev_stage, next_stage FROM state_history ORDER BY id').all();
  assert.equal(audits.length, 2);
  assert.equal(audits[0].prev_stage, null);
  assert.equal(audits[0].next_stage, 'COATING');
  assert.equal(audits[1].prev_stage, 'COATING');
  assert.equal(audits[1].next_stage, 'ASSEMBLY');
});

test('A3: identity write — no changes, no audit row, no jobs UPDATE', () => {
  const db = freshDb();
  const repo = createRepo(db);

  repo.upsert({
    invoice: '450123',
    patch: { tray: 'T-047', current_stage: 'COATING' },
    source: 'trace',
    observedAt: T0,
  });
  const r2 = repo.upsert({
    invoice: '450123',
    patch: { tray: 'T-047', current_stage: 'COATING' }, // same as current
    source: 'trace',
    observedAt: T0 + 1000,
  });

  assert.deepEqual(r2.applied, {});
  assert.deepEqual(r2.skipped, []);
  assert.equal(r2.audit_id, null);

  const auditCount = db.prepare('SELECT COUNT(*) AS c FROM state_history').get().c;
  assert.equal(auditCount, 1, 'only the first write should have audited');
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION B — rejection paths and zombie prevention
// ═════════════════════════════════════════════════════════════════════════════

test('B1: rejection-only write — fields blocked but audit row IS written', () => {
  const db = freshDb();
  const repo = createRepo(db);

  // Set up a SHIPPED row.
  repo.upsert({
    invoice: '450123',
    patch: { current_stage: 'SHIPPED', ship_date: '2026-05-05' },
    source: 'xml-shiplog',
    observedAt: T0,
  });

  // Trace tries to revert SHIPPED → COATING (terminal-stage guard rejects).
  const r = repo.upsert({
    invoice: '450123',
    patch: { current_stage: 'COATING' },
    source: 'trace',
    observedAt: T0 + 1000,
  });

  assert.deepEqual(r.applied, {});
  assert.ok(r.skipped.includes('current_stage'));
  assert.ok(r.reason.current_stage.startsWith('guarded:'));
  assert.equal(typeof r.audit_id, 'number', 'audit row MUST exist for rejection-only writes');

  const job = db.prepare('SELECT current_stage FROM jobs WHERE invoice=?').get('450123');
  assert.equal(job.current_stage, 'SHIPPED', 'jobs row MUST NOT have changed');

  const audit = db.prepare('SELECT * FROM state_history WHERE id=?').get(r.audit_id);
  assert.equal(audit.changes_json, '{}');
  const skipped = JSON.parse(audit.skipped_json);
  assert.ok(skipped.includes('current_stage'));
  const reason = JSON.parse(audit.reason_json);
  assert.ok(reason.current_stage.startsWith('guarded:'));
});

test('B2: zombie guard — refuses to write SHIPPED with no ship_date, full rollback', () => {
  const db = freshDb();
  const repo = createRepo(db);

  // Set up an ACTIVE row.
  repo.upsert({
    invoice: '450123',
    patch: { current_stage: 'COATING' },
    source: 'trace',
    observedAt: T0,
  });
  const auditBefore = db.prepare('SELECT COUNT(*) AS c FROM state_history').get().c;

  assert.throws(
    () => repo.upsert({
      invoice: '450123',
      patch: { current_stage: 'SHIPPED' }, // no ship_date — zombie path
      source: 'xml-shiplog',
      observedAt: T0 + 1000,
    }),
    ZombieRowError
  );

  const job = db.prepare('SELECT current_stage, ship_date FROM jobs WHERE invoice=?').get('450123');
  assert.equal(job.current_stage, 'COATING', 'jobs row unchanged after zombie throw');
  assert.equal(job.ship_date, null);

  const auditAfter = db.prepare('SELECT COUNT(*) AS c FROM state_history').get().c;
  assert.equal(auditAfter, auditBefore, 'no audit row should be written when zombie throws');
});

test('B3: zombie guard positive case — SHIPPED + ship_date together OK', () => {
  const db = freshDb();
  const repo = createRepo(db);

  const r = repo.upsert({
    invoice: '450123',
    patch: { current_stage: 'SHIPPED', ship_date: '2026-05-05' },
    source: 'xml-shiplog',
    observedAt: T0,
  });

  assert.equal(r.applied.current_stage, 'SHIPPED');
  assert.equal(r.applied.ship_date, '2026-05-05');
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION C — input validation (loud failures)
// ═════════════════════════════════════════════════════════════════════════════

test('C1: invalid invoice throws InvalidKeyError, no writes', () => {
  const db = freshDb();
  const repo = createRepo(db);

  assert.throws(
    () => repo.upsert({
      invoice: 'GUID-shape-key', patch: { tray: 'T-001' }, source: 'trace', observedAt: T0,
    }),
    InvalidKeyError
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM jobs').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM state_history').get().c, 0);
});

test('C2: unknown source throws ContractError, no writes', () => {
  const db = freshDb();
  const repo = createRepo(db);

  assert.throws(
    () => repo.upsert({
      invoice: '450123', patch: { tray: 'T-001' }, source: 'mystery', observedAt: T0,
    }),
    ContractError
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM jobs').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM state_history').get().c, 0);
});

test('C3: missing observedAt throws ContractError', () => {
  const db = freshDb();
  const repo = createRepo(db);

  assert.throws(
    () => repo.upsert({ invoice: '450123', patch: { tray: 'T-001' }, source: 'trace' }),
    ContractError
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION D — audit metadata + actor passthrough
// ═════════════════════════════════════════════════════════════════════════════

test('D1: actor defaults to source when omitted', () => {
  const db = freshDb();
  const repo = createRepo(db);

  const r = repo.upsert({
    invoice: '450123', patch: { tray: 'T-001' }, source: 'trace', observedAt: T0,
  });
  const audit = db.prepare('SELECT actor FROM state_history WHERE id=?').get(r.audit_id);
  assert.equal(audit.actor, 'trace');
});

test('D2: metadata serialized into metadata_json', () => {
  const db = freshDb();
  const repo = createRepo(db);

  const r = repo.upsert({
    invoice: '450123',
    patch: { current_stage: 'SHIPPED', ship_date: '2026-05-05' },
    source: 'xml-shiplog',
    observedAt: T0,
    metadata: { file: 'shiplog-450123.xml', shipDate: '2026-05-05' },
  });
  const audit = db.prepare('SELECT metadata_json FROM state_history WHERE id=?').get(r.audit_id);
  const meta = JSON.parse(audit.metadata_json);
  assert.equal(meta.file, 'shiplog-450123.xml');
  assert.equal(meta.shipDate, '2026-05-05');
});

test('D3: observed_at preserved (not Date.now())', () => {
  const db = freshDb();
  const repo = createRepo(db);

  const eventTimeFromCaller = 1700000000000; // a year before T0
  const r = repo.upsert({
    invoice: '450123', patch: { tray: 'T-001' }, source: 'trace',
    observedAt: eventTimeFromCaller,
  });
  const audit = db.prepare('SELECT observed_at, recorded_at FROM state_history WHERE id=?').get(r.audit_id);
  assert.equal(audit.observed_at, eventTimeFromCaller);
  // recorded_at is db-side datetime('now'); not eventTimeFromCaller
  assert.ok(audit.recorded_at, 'recorded_at populated by DB default');
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION E — retention prune
// ═════════════════════════════════════════════════════════════════════════════

test('E1: pruneOldAudit removes rows older than N days, keeps recent', () => {
  const db = freshDb();
  const repo = createRepo(db);

  // Seed audit rows with mixed recorded_at timestamps. Bypass the repo for
  // setup so we can plant old rows directly.
  const insert = db.prepare(`
    INSERT INTO state_history (entity_type, entity_id, source, actor, changes_json, observed_at, recorded_at)
    VALUES ('jobs', ?, 'trace', 'test', '{}', ?, ?)
  `);
  insert.run('A', T0, "datetime('now', '-100 days')");
  insert.run('B', T0, "datetime('now', '-95 days')");
  insert.run('C', T0, "datetime('now', '-30 days')");
  insert.run('D', T0, "datetime('now')");

  // Note the test rows above use string literals — they're stored as the
  // literal string. Re-insert with proper datetime computation:
  db.exec(`DELETE FROM state_history`);
  db.exec(`
    INSERT INTO state_history (entity_type, entity_id, source, actor, changes_json, observed_at, recorded_at)
      VALUES ('jobs', 'A', 'trace', 'test', '{}', ${T0}, datetime('now', '-100 days'));
    INSERT INTO state_history (entity_type, entity_id, source, actor, changes_json, observed_at, recorded_at)
      VALUES ('jobs', 'B', 'trace', 'test', '{}', ${T0}, datetime('now', '-95 days'));
    INSERT INTO state_history (entity_type, entity_id, source, actor, changes_json, observed_at, recorded_at)
      VALUES ('jobs', 'C', 'trace', 'test', '{}', ${T0}, datetime('now', '-30 days'));
    INSERT INTO state_history (entity_type, entity_id, source, actor, changes_json, observed_at, recorded_at)
      VALUES ('jobs', 'D', 'trace', 'test', '{}', ${T0}, datetime('now'));
  `);

  const result = repo.pruneOldAudit(90);
  assert.equal(result.deleted, 2, 'should drop the 100-day and 95-day rows');
  assert.equal(result.daysToKeep, 90);

  const remaining = db.prepare('SELECT entity_id FROM state_history ORDER BY entity_id').all();
  assert.deepEqual(remaining.map((r) => r.entity_id), ['C', 'D']);
});

test('E2: pruneOldAudit rejects invalid daysToKeep', () => {
  const db = freshDb();
  const repo = createRepo(db);
  assert.throws(() => repo.pruneOldAudit(0), /positive integer/);
  assert.throws(() => repo.pruneOldAudit(-1), /positive integer/);
  assert.throws(() => repo.pruneOldAudit(1.5), /positive integer/);
  assert.throws(() => repo.pruneOldAudit('90'), /positive integer/);
});
