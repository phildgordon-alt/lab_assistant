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
        requestTimeout: 30000,
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

// ── Phase 2 stub (NOT wired in startup yet) ─────────────────────────────────
// Once the schema is known, replace this stub with the real polling query that
// reads completed picks from Power Pick and writes them via db.upsertPicksHistory.
// The live Trigger A in db.js then fires automatically and derives jobs.lens_type.
async function pollPicks() {
  return { ok: false, error: 'pollPicks not implemented — Phase 2. Run listTables() + getColumns() to map schema first.' };
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
  getStatus,
  // Phase 2 stub
  pollPicks,
};
