/**
 * Power Pick Database Adapter (Kardex underlying SQL Server)
 *
 * Direct read-only connection to Kardex's Power Pick database — the SQL Server
 * instance ItemPath itself queries. Goal: bypass the ItemPath REST API for
 * pick-event capture and read picks directly from the source. ItemPath REST
 * polling has historically dropped picks (see project memory for the 2026-04-30
 * 1,300-pick gap incident), causing jobs.lens_type to stay NULL until manual
 * backfill. Direct DB read eliminates the whole "did the API capture it" gap class.
 *
 * Architectural pattern mirrors server/som-adapter.js (Schneider/SOM MySQL):
 *   - Optional require — adapter degrades gracefully when `mssql` package not installed
 *   - Persists last-known-good state to disk for offline serve
 *   - recordHeartbeat / recordHeartbeatError for the unified sync_heartbeats table
 *   - Connect / disconnect / reconnect lifecycle with backoff on repeated failures
 *
 * REQUIRED ENV VARS (add to /Users/Shared/lab_assistant/.env on prod):
 *   POWERPICK_HOST=68.15.89.205           # Power Pick SQL Server host (per ItemPath Kardex Settings UI)
 *   POWERPICK_PORT=1433                   # Default MS SQL Server port
 *   POWERPICK_DATABASE=<db_name>          # Power Pick database name (in ItemPath Kardex Settings)
 *   POWERPICK_USER=<readonly_user>        # Read-only SQL user — DO NOT use the test user (`kardextest`)
 *   POWERPICK_PASSWORD=<password>         # SQL user password
 *   POWERPICK_POLL_INTERVAL=30000         # Optional, default 30s
 *   POWERPICK_ENCRYPT=false               # Optional, default false (LAN-local; no TLS expected)
 *
 * REQUIRED PACKAGE: `mssql` — install with:
 *   cd /Users/Shared/lab_assistant && npm install mssql
 *   (Adapter is dormant until this is installed; safe to ship without.)
 *
 * INITIAL DEPLOYMENT — Phase 1 (this file): connection + schema discovery only.
 *   - testConnection()   — verifies credentials work; returns { ok, error?, version? }
 *   - listTables()       — lists Power Pick's tables + column counts (so we can identify
 *                          where pick events live before writing any production query)
 *   - getColumns(table)  — lists columns for a specific table
 *
 * Once schema is mapped, Phase 2 adds:
 *   - pollPicks() — actual pick event polling, mirrors itempath-adapter's pickSync
 *   - Wire into oven-timer-server.js startup (alongside SOM, Looker, etc.)
 *   - Live writes to picks_history via db.upsertPicksHistory() — Trigger A in db.js
 *     fires automatically and derives jobs.lens_type
 *
 * Phase 1 does NOT wire into the server startup. Run interactively first:
 *   node -e "require('./server/powerpick-adapter').testConnection().then(r => console.log(r))"
 *   node -e "require('./server/powerpick-adapter').listTables().then(r => console.log(r))"
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Optional require — same pattern as server/som-adapter.js handles mysql2.
// Adapter remains require()-safe even when `mssql` isn't installed; only the
// connection-using functions throw if you try to call them without the package.
let sql = null;
try {
  sql = require('mssql');
} catch (e) {
  console.warn('[PowerPick] `mssql` package not installed. Install with: npm install mssql');
}

// ── Configuration from env ──────────────────────────────────────────────────
const POWERPICK_HOST     = process.env.POWERPICK_HOST     || '';
const POWERPICK_PORT     = parseInt(process.env.POWERPICK_PORT || '1433', 10);
const POWERPICK_DATABASE = process.env.POWERPICK_DATABASE || '';
const POWERPICK_USER     = process.env.POWERPICK_USER     || '';
const POWERPICK_PASSWORD = process.env.POWERPICK_PASSWORD || '';
const POWERPICK_POLL_INTERVAL = parseInt(process.env.POWERPICK_POLL_INTERVAL || '30000', 10);
const POWERPICK_ENCRYPT  = (process.env.POWERPICK_ENCRYPT || 'false').toLowerCase() === 'true';

const DATA_FILE = path.join(__dirname, 'powerpick-data.json');

// ── State ───────────────────────────────────────────────────────────────────
let pool = null;
let isLive = false;
let connectionError = null;
let failCount = 0;
let lastSuccessfulPoll = null;
// Most-recent in-memory snapshot — kept for offline serve when the connection drops.
let cachedTables = [];
let cachedSchema = {}; // { tableName: [{ column_name, data_type, is_nullable }] }

// ── Persistence ─────────────────────────────────────────────────────────────
function loadFromDisk() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      cachedTables = data.tables || [];
      cachedSchema = data.schema || {};
      lastSuccessfulPoll = data.lastSuccessfulPoll || null;
      console.log(`[PowerPick] Loaded ${cachedTables.length} tables from disk (last update: ${lastSuccessfulPoll || 'never'})`);
      return true;
    }
  } catch (e) {
    console.warn('[PowerPick] Could not load persisted data:', e.message);
  }
  return false;
}

function saveToDisk() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify({
      tables: cachedTables,
      schema: cachedSchema,
      lastSuccessfulPoll,
      savedAt: new Date().toISOString(),
    }, null, 2));
  } catch (e) {
    console.warn('[PowerPick] Could not persist data:', e.message);
  }
}

// ── Config validation ───────────────────────────────────────────────────────
function configReady() {
  return Boolean(POWERPICK_HOST && POWERPICK_DATABASE && POWERPICK_USER && POWERPICK_PASSWORD);
}

function configIssues() {
  const missing = [];
  if (!POWERPICK_HOST)     missing.push('POWERPICK_HOST');
  if (!POWERPICK_DATABASE) missing.push('POWERPICK_DATABASE');
  if (!POWERPICK_USER)     missing.push('POWERPICK_USER');
  if (!POWERPICK_PASSWORD) missing.push('POWERPICK_PASSWORD');
  return missing;
}

// ── Connection lifecycle ────────────────────────────────────────────────────
async function connect() {
  if (!sql) {
    connectionError = 'mssql package not installed';
    return false;
  }
  if (!configReady()) {
    connectionError = `missing env: ${configIssues().join(', ')}`;
    return false;
  }
  if (pool && pool.connected) return true;

  try {
    pool = await sql.connect({
      server:   POWERPICK_HOST,
      port:     POWERPICK_PORT,
      user:     POWERPICK_USER,
      password: POWERPICK_PASSWORD,
      database: POWERPICK_DATABASE,
      options: {
        encrypt: POWERPICK_ENCRYPT,
        trustServerCertificate: true, // Power Pick is LAN-local; self-signed certs expected if any
        connectTimeout: 15000,
        // 2026-05-01: bumped 30s → 120s. 50k-row backfill queries (days >= 20)
        // can run 30-60s on the SQL side. Live polls (5k rows, default) finish
        // in ~1s and never need the headroom, but they don't suffer from it.
        requestTimeout: 120000,
      },
      pool: {
        max: 5,
        min: 0,
        idleTimeoutMillis: 30000,
      },
    });

    pool.on('error', (err) => {
      console.error('[PowerPick] Pool error:', err.message);
      isLive = false;
      connectionError = err.message;
    });

    isLive = true;
    connectionError = null;
    failCount = 0;
    console.log(`[PowerPick] Connected to ${POWERPICK_HOST}:${POWERPICK_PORT}/${POWERPICK_DATABASE} (encrypt=${POWERPICK_ENCRYPT})`);
    return true;
  } catch (err) {
    console.error(`[PowerPick] Connection failed: ${err.message}`);
    isLive = false;
    connectionError = err.message;
    failCount++;
    pool = null;
    return false;
  }
}

async function disconnect() {
  if (pool) {
    try { await pool.close(); } catch { /* ignore */ }
    pool = null;
    isLive = false;
  }
}

// ── Phase 1 operations ──────────────────────────────────────────────────────

/**
 * Verify credentials work and report the SQL Server version.
 * Safe to call repeatedly. Records heartbeat success/error.
 */
async function testConnection() {
  if (!sql) return { ok: false, error: 'mssql package not installed' };
  if (!configReady()) return { ok: false, error: `missing env: ${configIssues().join(', ')}` };

  try {
    if (!pool || !pool.connected) {
      const ok = await connect();
      if (!ok) return { ok: false, error: connectionError };
    }
    const result = await pool.request().query(`SELECT @@VERSION AS version, DB_NAME() AS database_name, SUSER_SNAME() AS login_name`);
    const row = result.recordset[0] || {};
    try { require('./db').recordHeartbeat('powerpick', 1, 60 * 60 * 1000); } catch {}
    return {
      ok: true,
      version: (row.version || '').split('\n')[0].trim(),
      database: row.database_name,
      login: row.login_name,
      host: POWERPICK_HOST,
      port: POWERPICK_PORT,
    };
  } catch (err) {
    try { require('./db').recordHeartbeatError('powerpick', err.message, 60 * 60 * 1000); } catch {}
    return { ok: false, error: err.message };
  }
}

/**
 * List every user table in the Power Pick database with row count and column count.
 * Read-only INFORMATION_SCHEMA + sys.dm_db_partition_stats — no schema mutation.
 * Used to identify where pick events / orders / inventory live before writing
 * the production polling query in Phase 2.
 */
async function listTables() {
  if (!sql) return { ok: false, error: 'mssql package not installed' };
  try {
    if (!pool || !pool.connected) {
      const ok = await connect();
      if (!ok) return { ok: false, error: connectionError };
    }
    const result = await pool.request().query(`
      SELECT
        s.name AS schema_name,
        t.name AS table_name,
        (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS c
           WHERE c.TABLE_SCHEMA = s.name AND c.TABLE_NAME = t.name) AS column_count,
        SUM(p.rows) AS row_count
      FROM sys.tables t
      JOIN sys.schemas s ON s.schema_id = t.schema_id
      JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
      GROUP BY s.name, t.name
      ORDER BY row_count DESC, t.name ASC
    `);
    cachedTables = result.recordset || [];
    lastSuccessfulPoll = new Date().toISOString();
    saveToDisk();
    return { ok: true, count: cachedTables.length, tables: cachedTables };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Inspect a specific table's columns. Phil/the engineer eyeballs the output
 * to decide which table holds picks (look for OrderNumber, SKU, Quantity,
 * CompletedDate / TimestampCompleted patterns).
 */
async function getColumns(tableName) {
  if (!sql) return { ok: false, error: 'mssql package not installed' };
  if (!tableName || !/^[A-Za-z0-9_]+$/.test(tableName)) {
    return { ok: false, error: 'invalid tableName (alphanumeric + underscore only)' };
  }
  try {
    if (!pool || !pool.connected) {
      const ok = await connect();
      if (!ok) return { ok: false, error: connectionError };
    }
    const result = await pool.request()
      .input('tableName', sql.NVarChar, tableName)
      .query(`
        SELECT column_name, data_type, character_maximum_length, is_nullable
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_NAME = @tableName
        ORDER BY ORDINAL_POSITION
      `);
    cachedSchema[tableName] = result.recordset || [];
    saveToDisk();
    return { ok: true, table: tableName, columns: cachedSchema[tableName] };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Sample a few rows from a specific table. Read-only; LIMIT 5 by default.
 * Used during schema exploration to see actual values, not just types.
 */
async function sampleRows(tableName, limit = 5) {
  if (!sql) return { ok: false, error: 'mssql package not installed' };
  if (!tableName || !/^[A-Za-z0-9_]+$/.test(tableName)) {
    return { ok: false, error: 'invalid tableName (alphanumeric + underscore only)' };
  }
  const lim = Math.max(1, Math.min(50, parseInt(limit, 10) || 5));
  try {
    if (!pool || !pool.connected) {
      const ok = await connect();
      if (!ok) return { ok: false, error: connectionError };
    }
    // SQL Server uses TOP, not LIMIT. Identifier interpolation is safe because
    // tableName is regex-validated above.
    const result = await pool.request().query(`SELECT TOP ${lim} * FROM [${tableName}]`);
    return { ok: true, table: tableName, rows: result.recordset || [] };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 2 — pick polling
//
// Query: History table, Type=4 = pick events (verified empirically 2026-05-01:
// MasterorderName matches DVI invoice format, PickWarehouseName populated,
// PutWarehouseName null). Type=1 is operator restocking puts ("ManualPut-LAPTOP-…")
// — we ignore those.
//
// Mapping Power Pick `History` → our `picks_history` (via db.upsertPicksHistory):
//   HistoryId            → pickId      (`pp-${HistoryId}`)
//   MasterorderName      → orderName   (DVI invoice)
//   Materialreference    → materialName (lens / frame SKU)
//   QuantityConfirmed    → quantityConfirmed
//   PickWarehouseName    → warehouseName
//   Creationdate         → modifiedDate (ISO string)
//
// Cursor: lastSyncCreationdate persisted in powerpick-data.json. Initial run
// without state pulls last 24h. Each poll uses `Creationdate > @lastSync`.
// ─────────────────────────────────────────────────────────────────────────────

let lastSyncCreationdate = null; // ISO string of the most-recent History row already ingested

// Restore cursor from disk on boot (loadFromDisk does this generically; this is the picks-side init)
function _initPickCursor() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (data.lastSyncCreationdate) lastSyncCreationdate = data.lastSyncCreationdate;
    }
  } catch { /* ignore — fresh start is fine */ }
}
_initPickCursor();

function _savePickCursor() {
  try {
    let data = {};
    try { if (fs.existsSync(DATA_FILE)) data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch {}
    data.lastSyncCreationdate = lastSyncCreationdate;
    data.savedAt = new Date().toISOString();
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.warn('[PowerPick] Could not persist pick cursor:', e.message);
  }
}

// Convert a Power Pick `History` row to the line object shape that
// `db.upsertPicksHistory` expects. The function tolerates missing/null fields;
// upsertPicksHistory does the final validation (rejects bad order_id shapes,
// clamps qty, etc.).
function _historyRowToPickLine(row) {
  const orderName = (row.MasterorderName || '').trim();
  return {
    pickId: `pp-${row.HistoryId}`,
    id: row.HistoryId,
    orderName,
    materialName: row.Materialreference || row.MaterialName || '',
    quantityConfirmed: row.QuantityConfirmed,
    warehouseName: row.PickWarehouseName || '',
    costCenterName: row.CostcenterName || '',
    modifiedDate: row.Creationdate ? new Date(row.Creationdate).toISOString() : new Date().toISOString(),
    creationDate: row.Creationdate ? new Date(row.Creationdate).toISOString() : new Date().toISOString(),
  };
}

/**
 * Poll for new completed picks since lastSyncCreationdate. Writes via
 * db.upsertPicksHistory (with source='powerpick'), which fires Trigger A and
 * derives jobs.lens_type automatically. Idempotent — pick_id is the unique key
 * on picks_history, so re-polling overlapping windows is harmless.
 *
 * @param {object} opts
 * @param {Date|string} [opts.since] — explicit lower bound; defaults to lastSyncCreationdate
 * @param {number} [opts.limit] — TOP N rows per poll (default 5000); guards against
 *                                runaway result sets if cursor is way behind
 */
async function pollPicks(opts = {}) {
  if (!sql) return { ok: false, error: 'mssql package not installed' };
  if (!configReady()) return { ok: false, error: `missing env: ${configIssues().join(', ')}` };

  // Default: pull last 24h on first ever run
  const since = opts.since
    ? new Date(opts.since).toISOString()
    : (lastSyncCreationdate || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
  const limit = Math.max(100, Math.min(50000, parseInt(opts.limit, 10) || 5000));

  try {
    if (!pool || !pool.connected) {
      const ok = await connect();
      if (!ok) return { ok: false, error: connectionError };
    }

    const result = await pool.request()
      .input('since', sql.DateTime, new Date(since))
      .query(`
        SELECT TOP ${limit}
          HistoryId,
          MasterorderName,
          Materialreference,
          MaterialName,
          QuantityConfirmed,
          PickWarehouseName,
          CostcenterName,
          Creationdate
        FROM History
        WHERE Type = 4
          AND Creationdate > @since
          AND MasterorderName IS NOT NULL
        ORDER BY Creationdate ASC
      `);

    const rows = result.recordset || [];
    if (rows.length === 0) {
      try { require('./db').recordHeartbeat('powerpick', 0, 60 * 60 * 1000); } catch {}
      return { ok: true, fetched: 0, inserted: 0, since };
    }

    // Convert to upsertPicksHistory line shape and write. The Tier-3 Trigger A
    // inside upsertPicksHistory (db.js commit 76a3564) will derive lens_type
    // automatically for each invoice that just received a pick.
    const lines = rows.map(_historyRowToPickLine);
    let inserted = 0, rejected = 0, badKey = 0;
    try {
      const r = require('./db').upsertPicksHistory(lines, 'powerpick');
      inserted = r.inserted;
      rejected = r.rejected || 0;
      badKey = r.badKey || 0;
    } catch (e) {
      try { require('./db').recordHeartbeatError('powerpick', e.message, 60 * 60 * 1000); } catch {}
      return { ok: false, error: `upsertPicksHistory failed: ${e.message}`, fetched: rows.length };
    }

    // Advance the cursor to the newest row we just processed
    const newestCreationdate = rows[rows.length - 1].Creationdate;
    if (newestCreationdate) {
      lastSyncCreationdate = new Date(newestCreationdate).toISOString();
      _savePickCursor();
    }

    isLive = true;
    failCount = 0;
    lastSuccessfulPoll = new Date().toISOString();
    try { require('./db').recordHeartbeat('powerpick', inserted, 60 * 60 * 1000); } catch {}

    return {
      ok: true,
      fetched: rows.length,
      inserted,
      rejected,
      badKey,
      since,
      newestCreationdate: lastSyncCreationdate,
    };
  } catch (err) {
    isLive = false;
    failCount++;
    connectionError = err.message;
    try { require('./db').recordHeartbeatError('powerpick', err.message, 60 * 60 * 1000); } catch {}
    return { ok: false, error: err.message, since };
  }
}

/**
 * One-shot historical recovery — pulls Type=4 picks for the last N days and
 * ingests them. Used to backfill the existing 141 NULL-lens_type active jobs
 * from 2026-05-01 onward without waiting for ItemPath. Larger limit because
 * a 7-day backfill on a busy lab can be 30K+ rows.
 *
 * NOTE: re-running is safe — INSERT OR IGNORE on pick_id dedupes against
 * any rows already populated by ItemPath REST.
 */
async function backfillRecentPicks(days = 7) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  console.log(`[PowerPick] backfillRecentPicks: pulling Type=4 picks since ${since}`);
  const result = await pollPicks({ since, limit: 50000 });
  console.log(`[PowerPick] backfillRecentPicks: ${JSON.stringify(result)}`);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle — start / stop
// Mirrors server/som-adapter.js pattern: schedule a self-rescheduling poll
// timer; reconnect on failure with exponential-ish backoff via failCount.
// ─────────────────────────────────────────────────────────────────────────────

let pollTimer = null;
let pollInFlight = false;

async function _pollTick() {
  if (pollInFlight) return; // skip if previous poll still running
  pollInFlight = true;
  try {
    await pollPicks();
  } catch (e) {
    console.error('[PowerPick] poll tick error:', e.message);
  } finally {
    pollInFlight = false;
  }
}

async function start() {
  if (!sql) {
    console.warn('[PowerPick] start() skipped — mssql package not installed (run: npm install mssql)');
    return false;
  }
  if (!configReady()) {
    console.warn(`[PowerPick] start() skipped — missing env: ${configIssues().join(', ')}`);
    return false;
  }
  if (pollTimer) {
    console.log('[PowerPick] start() called but already running — no-op');
    return true;
  }

  console.log(`[PowerPick] Starting — ${POWERPICK_HOST}:${POWERPICK_PORT}/${POWERPICK_DATABASE}, poll every ${POWERPICK_POLL_INTERVAL / 1000}s`);
  console.log(`[PowerPick] Pick cursor: ${lastSyncCreationdate || 'fresh (will pull last 24h on first poll)'}`);

  // First poll on a 5s delay so the server boot finishes first; then self-reschedule
  pollTimer = setTimeout(async function tick() {
    await _pollTick();
    if (pollTimer !== null) {
      pollTimer = setTimeout(tick, POWERPICK_POLL_INTERVAL);
    }
  }, 5000);

  return true;
}

async function stop() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  await disconnect();
  console.log('[PowerPick] Stopped.');
}

// ── Status (mirrors som-adapter.js getStatus pattern) ───────────────────────
function getStatus() {
  return {
    isLive,
    connectionError,
    failCount,
    lastSuccessfulPoll,
    host: POWERPICK_HOST || null,
    port: POWERPICK_PORT,
    database: POWERPICK_DATABASE || null,
    configReady: configReady(),
    missingEnv: configIssues(),
    mssqlInstalled: Boolean(sql),
    cachedTableCount: cachedTables.length,
  };
}

// Boot: try to load any persisted state so getStatus() returns something useful
// before the first connection.
loadFromDisk();

module.exports = {
  // Phase 1 (schema discovery)
  testConnection,
  listTables,
  getColumns,
  sampleRows,
  // Lifecycle
  connect,
  disconnect,
  start,
  stop,
  getStatus,
  // Phase 2 — picks
  pollPicks,
  backfillRecentPicks,
};
