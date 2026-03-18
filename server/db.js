/**
 * db.js - SQLite database for Lab_Assistant snapshots
 *
 * Stores snapshots from ItemPath, Limble, and DVI for fast AI agent queries.
 * Source systems remain the truth - this is a cache for fast access.
 */

'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Database file location
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'lab_assistant.db');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Initialize database
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL'); // Better performance for concurrent reads

// ─────────────────────────────────────────────────────────────────────────────
// SCHEMA
// ─────────────────────────────────────────────────────────────────────────────

db.exec(`
  -- Sync log: track when each source was last synced
  CREATE TABLE IF NOT EXISTS sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    synced_at TEXT NOT NULL,
    record_count INTEGER,
    status TEXT,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sync_log_source ON sync_log(source, synced_at);

  -- Inventory materials (ItemPath)
  CREATE TABLE IF NOT EXISTS inventory (
    id TEXT PRIMARY KEY,
    sku TEXT,
    name TEXT,
    qty INTEGER,
    qty_available INTEGER,
    unit TEXT,
    location TEXT,
    warehouse TEXT,
    coating_type TEXT,
    material_index TEXT,
    last_sync TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_inventory_sku ON inventory(sku);
  CREATE INDEX IF NOT EXISTS idx_inventory_qty ON inventory(qty);
  CREATE INDEX IF NOT EXISTS idx_inventory_coating ON inventory(coating_type);

  -- Inventory daily snapshots (for trend analysis)
  CREATE TABLE IF NOT EXISTS inventory_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_date TEXT NOT NULL,
    total_skus INTEGER,
    total_units INTEGER,
    low_stock_count INTEGER,
    out_of_stock_count INTEGER,
    by_coating_json TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_inv_snap_date ON inventory_snapshots(snapshot_date);

  -- Inventory alerts (ItemPath)
  CREATE TABLE IF NOT EXISTS inventory_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sku TEXT,
    name TEXT,
    qty INTEGER,
    threshold INTEGER,
    severity TEXT,
    created_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_alerts_severity ON inventory_alerts(severity);

  -- Picks/Orders (ItemPath) - now with archived flag for soft-delete
  CREATE TABLE IF NOT EXISTS picks (
    id TEXT PRIMARY KEY,
    order_id TEXT,
    reference TEXT,
    sku TEXT,
    name TEXT,
    qty INTEGER,
    picked INTEGER,
    pending INTEGER,
    warehouse TEXT,
    status TEXT,
    started_at TEXT,
    completed_at TEXT,
    archived INTEGER DEFAULT 0,
    synced_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_picks_sku ON picks(sku);
  CREATE INDEX IF NOT EXISTS idx_picks_started ON picks(started_at);
  CREATE INDEX IF NOT EXISTS idx_picks_archived ON picks(archived);
  CREATE INDEX IF NOT EXISTS idx_picks_completed ON picks(completed_at);

  -- Picks history (append-only for AI trend queries)
  CREATE TABLE IF NOT EXISTS picks_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pick_id TEXT,
    order_id TEXT,
    sku TEXT,
    name TEXT,
    qty INTEGER,
    picked INTEGER,
    warehouse TEXT,
    completed_at TEXT,
    recorded_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_picks_hist_sku ON picks_history(sku);
  CREATE INDEX IF NOT EXISTS idx_picks_hist_completed ON picks_history(completed_at);
  CREATE INDEX IF NOT EXISTS idx_picks_hist_recorded ON picks_history(recorded_at);

  -- Maintenance assets (Limble)
  CREATE TABLE IF NOT EXISTS maintenance_assets (
    id TEXT PRIMARY KEY,
    name TEXT,
    status TEXT,
    location TEXT,
    category TEXT,
    last_pm TEXT,
    next_pm TEXT,
    uptime_percent REAL,
    last_sync TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_assets_status ON maintenance_assets(status);

  -- Maintenance tasks/work orders (Limble)
  CREATE TABLE IF NOT EXISTS maintenance_tasks (
    id TEXT PRIMARY KEY,
    asset_id TEXT,
    asset_name TEXT,
    title TEXT,
    description TEXT,
    priority TEXT,
    status TEXT,
    type TEXT,
    assigned_to TEXT,
    due_date TEXT,
    created_at TEXT,
    completed_at TEXT,
    last_sync TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_status ON maintenance_tasks(status);
  CREATE INDEX IF NOT EXISTS idx_tasks_priority ON maintenance_tasks(priority);

  -- Spare parts (Limble)
  CREATE TABLE IF NOT EXISTS spare_parts (
    id TEXT PRIMARY KEY,
    name TEXT,
    part_number TEXT,
    qty INTEGER,
    min_qty INTEGER,
    location TEXT,
    cost REAL,
    last_sync TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_parts_qty ON spare_parts(qty);

  -- DVI Jobs - now with archived flag for soft-delete
  CREATE TABLE IF NOT EXISTS dvi_jobs (
    id TEXT PRIMARY KEY,
    invoice TEXT,
    tray TEXT,
    stage TEXT,
    station TEXT,
    status TEXT,
    rush TEXT,
    entry_date TEXT,
    days_in_lab INTEGER,
    coating TEXT,
    frame_name TEXT,
    data_date TEXT,
    archived INTEGER DEFAULT 0,
    shipped_at TEXT,
    last_sync TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_stage ON dvi_jobs(stage);
  CREATE INDEX IF NOT EXISTS idx_jobs_status ON dvi_jobs(status);
  CREATE INDEX IF NOT EXISTS idx_jobs_rush ON dvi_jobs(rush);
  CREATE INDEX IF NOT EXISTS idx_jobs_days ON dvi_jobs(days_in_lab);
  CREATE INDEX IF NOT EXISTS idx_jobs_archived ON dvi_jobs(archived);
  CREATE INDEX IF NOT EXISTS idx_jobs_shipped ON dvi_jobs(shipped_at);

  -- DVI Jobs history (append-only for completed/shipped jobs)
  CREATE TABLE IF NOT EXISTS dvi_jobs_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT,
    invoice TEXT,
    tray TEXT,
    stage TEXT,
    coating TEXT,
    rush TEXT,
    entry_date TEXT,
    days_in_lab INTEGER,
    shipped_at TEXT,
    recorded_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_hist_invoice ON dvi_jobs_history(invoice);
  CREATE INDEX IF NOT EXISTS idx_jobs_hist_shipped ON dvi_jobs_history(shipped_at);
  CREATE INDEX IF NOT EXISTS idx_jobs_hist_recorded ON dvi_jobs_history(recorded_at);

  -- Daily production stats (aggregate for trend queries)
  CREATE TABLE IF NOT EXISTS daily_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stat_date TEXT NOT NULL UNIQUE,
    jobs_shipped INTEGER DEFAULT 0,
    jobs_entered INTEGER DEFAULT 0,
    picks_completed INTEGER DEFAULT 0,
    picks_qty INTEGER DEFAULT 0,
    avg_days_in_lab REAL,
    rush_jobs_shipped INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_daily_stats_date ON daily_stats(stat_date);
`);

// ─────────────────────────────────────────────────────────────────────────────
// TIERED DATA ARCHITECTURE
// Hot: Real-time queries (SOAP when live, current state)
// Warm: Pre-aggregated summaries for agent queries
// Cold: Raw archives for deep analysis
// Reference: SCD Type 2 catalogs for historical accuracy
// ─────────────────────────────────────────────────────────────────────────────

db.exec(`
  -- ═══════════════════════════════════════════════════════════════════════════
  -- COLD LAYER: Raw XML archives (append-only, never queried directly by agents)
  -- ═══════════════════════════════════════════════════════════════════════════

  -- DVI XML imports with raw blob for full context retrieval
  CREATE TABLE IF NOT EXISTS dvi_imports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    import_date TEXT NOT NULL,
    data_date TEXT,                    -- Date the data represents
    job_count INTEGER,
    xml_blob TEXT,                     -- Full raw XML for context retrieval
    xml_hash TEXT,                     -- SHA256 to detect duplicates
    file_size_bytes INTEGER,
    source TEXT DEFAULT 'upload',      -- 'upload', 'email', 'watch_folder'
    processed_at TEXT DEFAULT (datetime('now')),
    UNIQUE(xml_hash)
  );
  CREATE INDEX IF NOT EXISTS idx_imports_date ON dvi_imports(import_date);
  CREATE INDEX IF NOT EXISTS idx_imports_data_date ON dvi_imports(data_date);

  -- ═══════════════════════════════════════════════════════════════════════════
  -- HOT LAYER: Current state (refreshed on each sync, queried for real-time)
  -- ═══════════════════════════════════════════════════════════════════════════

  -- Breakage events extracted from DVI data
  CREATE TABLE IF NOT EXISTS breakage_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT,
    invoice TEXT,
    department TEXT,                   -- S=Surfacing, C=Coating, E=Edging, A=Assembly
    reason TEXT,
    stage TEXT,
    operator TEXT,
    occurred_at TEXT,
    notes TEXT,
    import_id INTEGER,                 -- Link to dvi_imports for full context
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (import_id) REFERENCES dvi_imports(id)
  );
  CREATE INDEX IF NOT EXISTS idx_breakage_dept ON breakage_events(department);
  CREATE INDEX IF NOT EXISTS idx_breakage_reason ON breakage_events(reason);
  CREATE INDEX IF NOT EXISTS idx_breakage_date ON breakage_events(occurred_at);
  CREATE INDEX IF NOT EXISTS idx_breakage_job ON breakage_events(job_id);

  -- Coating queue (jobs currently in coating stages)
  CREATE TABLE IF NOT EXISTS coating_queue (
    id TEXT PRIMARY KEY,
    invoice TEXT,
    tray TEXT,
    coating_type TEXT,                 -- AR, BLUE_CUT, HARD_COAT, MIRROR, etc.
    stage TEXT,                        -- COAT_QUEUE, COATING, COAT_QC
    entered_queue_at TEXT,
    rush TEXT,
    days_in_queue INTEGER,
    machine TEXT,
    operator TEXT,
    last_sync TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_coating_type ON coating_queue(coating_type);
  CREATE INDEX IF NOT EXISTS idx_coating_stage ON coating_queue(stage);
  CREATE INDEX IF NOT EXISTS idx_coating_rush ON coating_queue(rush);

  -- Container registry (tools, oven trays, coating batches)
  CREATE TABLE IF NOT EXISTS containers (
    id TEXT PRIMARY KEY,                    -- e.g. TOOL-006, TRAY-003, BATCH-041
    type TEXT NOT NULL,                     -- tool | oven_tray | coating_batch
    status TEXT NOT NULL DEFAULT 'open',    -- open | closed | consumed
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    closed_at TEXT,
    consumed_at TEXT,
    operator_id TEXT,
    machine_id TEXT,                        -- for batches: which coating machine
    coating_type TEXT,                      -- AR, BLUE_CUT, HARD_COAT, etc.
    notes TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_containers_type_status ON containers(type, status);
  CREATE INDEX IF NOT EXISTS idx_containers_status ON containers(status);

  -- Jobs written once at scan station, tool level only
  CREATE TABLE IF NOT EXISTS container_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    container_id TEXT NOT NULL REFERENCES containers(id),
    job_number TEXT NOT NULL,
    eye_side TEXT NOT NULL,                 -- L or R
    ocr_confidence REAL,                   -- null if manually entered
    entry_method TEXT NOT NULL DEFAULT 'ocr',  -- ocr | manual
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(container_id, job_number, eye_side)
  );
  CREATE INDEX IF NOT EXISTS idx_container_jobs_container ON container_jobs(container_id);
  CREATE INDEX IF NOT EXISTS idx_container_jobs_job ON container_jobs(job_number);

  -- Parent/child container relationships
  CREATE TABLE IF NOT EXISTS container_contents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_id TEXT NOT NULL REFERENCES containers(id),
    child_id TEXT NOT NULL REFERENCES containers(id),
    loaded_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(parent_id, child_id)
  );
  CREATE INDEX IF NOT EXISTS idx_container_contents_parent ON container_contents(parent_id);
  CREATE INDEX IF NOT EXISTS idx_container_contents_child ON container_contents(child_id);
`);

// Container enrichment migration — add coating/material/rush/lens_type to container_jobs
// and material to containers. Safe: try/catch for existing columns.
const containerMigrations = [
  'ALTER TABLE container_jobs ADD COLUMN coating TEXT',
  'ALTER TABLE container_jobs ADD COLUMN material TEXT',
  'ALTER TABLE container_jobs ADD COLUMN rush INTEGER DEFAULT 0',
  'ALTER TABLE container_jobs ADD COLUMN lens_type TEXT',
  'ALTER TABLE containers ADD COLUMN material TEXT',
];
for (const sql of containerMigrations) {
  try { db.exec(sql); } catch (e) { /* column already exists */ }
}

db.exec(`

  -- ═══════════════════════════════════════════════════════════════════════════
  -- WARM LAYER: Pre-aggregated summaries (auto-refresh on hot layer writes)
  -- Agent queries hit these, not raw data
  -- ═══════════════════════════════════════════════════════════════════════════

  -- Daily throughput summary (refreshed on each DVI import)
  CREATE TABLE IF NOT EXISTS throughput_daily (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stat_date TEXT NOT NULL UNIQUE,
    jobs_entered INTEGER DEFAULT 0,
    jobs_shipped INTEGER DEFAULT 0,
    jobs_in_surfacing INTEGER DEFAULT 0,
    jobs_in_coating INTEGER DEFAULT 0,
    jobs_in_cutting INTEGER DEFAULT 0,
    jobs_in_assembly INTEGER DEFAULT 0,
    rush_entered INTEGER DEFAULT 0,
    rush_shipped INTEGER DEFAULT 0,
    avg_days_in_lab REAL,
    max_days_in_lab INTEGER,
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_throughput_date ON throughput_daily(stat_date);

  -- Breakage summary by department/reason (rolled up daily)
  CREATE TABLE IF NOT EXISTS breakage_daily (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stat_date TEXT NOT NULL,
    department TEXT NOT NULL,
    reason TEXT,
    count INTEGER DEFAULT 0,
    jobs_affected INTEGER DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(stat_date, department, reason)
  );
  CREATE INDEX IF NOT EXISTS idx_breakage_daily_date ON breakage_daily(stat_date);
  CREATE INDEX IF NOT EXISTS idx_breakage_daily_dept ON breakage_daily(department);

  -- WIP aging buckets (pre-computed for fast agent queries)
  CREATE TABLE IF NOT EXISTS aging_buckets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_date TEXT NOT NULL,
    bucket TEXT NOT NULL,              -- '0-1d', '1-2d', '2-3d', '3-5d', '5-7d', '7d+'
    stage TEXT,
    job_count INTEGER DEFAULT 0,
    rush_count INTEGER DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(snapshot_date, bucket, stage)
  );
  CREATE INDEX IF NOT EXISTS idx_aging_date ON aging_buckets(snapshot_date);

  -- Coating yield summary (daily by coating type)
  CREATE TABLE IF NOT EXISTS coating_yield_daily (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stat_date TEXT NOT NULL,
    coating_type TEXT NOT NULL,
    jobs_attempted INTEGER DEFAULT 0,
    jobs_passed INTEGER DEFAULT 0,
    jobs_failed INTEGER DEFAULT 0,
    yield_percent REAL,
    avg_cycle_time_min REAL,
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(stat_date, coating_type)
  );
  CREATE INDEX IF NOT EXISTS idx_yield_date ON coating_yield_daily(stat_date);
  CREATE INDEX IF NOT EXISTS idx_yield_coating ON coating_yield_daily(coating_type);

  -- ═══════════════════════════════════════════════════════════════════════════
  -- REFERENCE LAYER: SCD Type 2 catalogs (valid_from/valid_to for history)
  -- ═══════════════════════════════════════════════════════════════════════════

  -- Lens catalog with SCD Type 2 for historical accuracy
  CREATE TABLE IF NOT EXISTS lens_catalog (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    opc TEXT NOT NULL,                 -- Optical Product Code
    material TEXT,                     -- CR39, POLY, HI_INDEX, TRIVEX
    style TEXT,                        -- SV, PROG, BIFOCAL
    coating_type TEXT,
    base_curve REAL,
    diameter INTEGER,
    manufacturer TEXT,
    cost REAL,
    valid_from TEXT NOT NULL,
    valid_to TEXT,                     -- NULL = currently active
    deprecated_reason TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_lens_opc ON lens_catalog(opc);
  CREATE INDEX IF NOT EXISTS idx_lens_valid ON lens_catalog(valid_from, valid_to);
  CREATE INDEX IF NOT EXISTS idx_lens_active ON lens_catalog(valid_to) WHERE valid_to IS NULL;

  -- Frame catalog with SCD Type 2
  CREATE TABLE IF NOT EXISTS frame_catalog (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    frame_code TEXT NOT NULL,
    frame_name TEXT,
    brand TEXT,
    style TEXT,
    color TEXT,
    size TEXT,                         -- e.g., "52-18-140"
    material TEXT,
    cost REAL,
    valid_from TEXT NOT NULL,
    valid_to TEXT,                     -- NULL = currently active
    discontinued_reason TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_frame_code ON frame_catalog(frame_code);
  CREATE INDEX IF NOT EXISTS idx_frame_valid ON frame_catalog(valid_from, valid_to);

  -- Operators with SCD Type 2 (track role/dept changes)
  CREATE TABLE IF NOT EXISTS operators (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id TEXT NOT NULL,
    name TEXT,
    department TEXT,                   -- SURFACING, COATING, CUTTING, ASSEMBLY, QC
    role TEXT,                         -- OPERATOR, LEAD, SUPERVISOR
    shift TEXT,                        -- AM, PM, NIGHT
    trained_on TEXT,                   -- JSON array of certifications
    valid_from TEXT NOT NULL,
    valid_to TEXT,                     -- NULL = currently active
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_operator_id ON operators(employee_id);
  CREATE INDEX IF NOT EXISTS idx_operator_dept ON operators(department);
  CREATE INDEX IF NOT EXISTS idx_operator_active ON operators(valid_to) WHERE valid_to IS NULL;

  -- Assembly Dashboard config (operators, assignments, operator map, leaderboard)
  -- Key-value store for JSON blobs — simple and flexible
  CREATE TABLE IF NOT EXISTS assembly_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

console.log('[DB] SQLite database initialized:', DB_FILE);

// ─────────────────────────────────────────────────────────────────────────────
// SYNC LOG
// ─────────────────────────────────────────────────────────────────────────────

function logSync(source, recordCount, status = 'ok', error = null) {
  const stmt = db.prepare(`
    INSERT INTO sync_log (source, synced_at, record_count, status, error)
    VALUES (?, datetime('now'), ?, ?, ?)
  `);
  stmt.run(source, recordCount, status, error);
}

function getLastSync(source) {
  const stmt = db.prepare(`
    SELECT * FROM sync_log WHERE source = ? ORDER BY synced_at DESC LIMIT 1
  `);
  return stmt.get(source);
}

// ─────────────────────────────────────────────────────────────────────────────
// INVENTORY (ItemPath)
// ─────────────────────────────────────────────────────────────────────────────

function upsertInventory(materials) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO inventory (id, sku, name, qty, qty_available, unit, location, warehouse, coating_type, material_index, last_sync)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  const upsertMany = db.transaction((items) => {
    for (const m of items) {
      stmt.run(
        m.id || m.sku,
        m.sku,
        m.name,
        m.qty || 0,
        m.qtyAvailable || m.qty || 0,
        m.unit,
        m.location,
        m.warehouse,
        m.coatingType,
        m.index
      );
    }
  });

  upsertMany(materials);
  logSync('inventory', materials.length);
}

function upsertAlerts(alerts) {
  // Clear old alerts and insert new ones
  db.prepare('DELETE FROM inventory_alerts').run();

  const stmt = db.prepare(`
    INSERT INTO inventory_alerts (sku, name, qty, threshold, severity, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `);

  const insertMany = db.transaction((items) => {
    for (const a of items) {
      stmt.run(a.sku, a.name, a.qty, a.threshold, a.severity);
    }
  });

  insertMany(alerts);
  logSync('alerts', alerts.length);
}

function upsertPicks(picks) {
  // Build set of current pick IDs
  const currentIds = new Set();
  for (const order of picks) {
    for (const line of (order.lines || [])) {
      currentIds.add(`${order.orderId}-${line.sku}`);
    }
  }

  // Get existing active picks to detect completions
  const existingPicks = db.prepare(`
    SELECT id, order_id, sku, name, qty, picked, warehouse FROM picks WHERE archived = 0
  `).all();

  // Archive picks that are no longer in the current set (they were completed)
  const archiveStmt = db.prepare(`
    UPDATE picks SET archived = 1, completed_at = datetime('now') WHERE id = ?
  `);
  const historyStmt = db.prepare(`
    INSERT INTO picks_history (pick_id, order_id, sku, name, qty, picked, warehouse, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  const archiveCompleted = db.transaction(() => {
    for (const existing of existingPicks) {
      if (!currentIds.has(existing.id)) {
        // This pick is no longer active - archive it and record history
        archiveStmt.run(existing.id);
        historyStmt.run(
          existing.id,
          existing.order_id,
          existing.sku,
          existing.name,
          existing.qty,
          existing.picked,
          existing.warehouse
        );
      }
    }
  });
  archiveCompleted();

  // Upsert current picks (update existing or insert new)
  const upsertStmt = db.prepare(`
    INSERT INTO picks (id, order_id, reference, sku, name, qty, picked, pending, warehouse, status, started_at, archived, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      qty = excluded.qty,
      picked = excluded.picked,
      pending = excluded.pending,
      status = excluded.status,
      archived = 0,
      synced_at = datetime('now')
  `);

  const upsertMany = db.transaction((orders) => {
    for (const order of orders) {
      for (const line of (order.lines || [])) {
        upsertStmt.run(
          `${order.orderId}-${line.sku}`,
          order.orderId,
          order.reference,
          line.sku,
          line.name,
          line.qty,
          line.picked || 0,
          line.pending || 0,
          order.warehouse,
          order.status,
          order.startedAt
        );
      }
    }
  });

  upsertMany(picks);
  logSync('picks', picks.length);
}

// ─────────────────────────────────────────────────────────────────────────────
// MAINTENANCE (Limble)
// ─────────────────────────────────────────────────────────────────────────────

function upsertAssets(assets) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO maintenance_assets (id, name, status, location, category, last_pm, next_pm, uptime_percent, last_sync)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  const upsertMany = db.transaction((items) => {
    for (const a of items) {
      stmt.run(
        a.id,
        a.name,
        a.status,
        a.location,
        a.category,
        a.lastPM,
        a.nextPM,
        a.uptimePercent
      );
    }
  });

  upsertMany(assets);
  logSync('assets', assets.length);
}

function upsertTasks(tasks) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO maintenance_tasks (id, asset_id, asset_name, title, description, priority, status, type, assigned_to, due_date, created_at, completed_at, last_sync)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  const upsertMany = db.transaction((items) => {
    for (const t of items) {
      stmt.run(
        t.id,
        t.assetId,
        t.assetName,
        t.title || t.name,
        t.description,
        t.priority,
        t.status,
        t.type,
        t.assignedTo,
        t.dueDate,
        t.createdAt,
        t.completedAt
      );
    }
  });

  upsertMany(tasks);
  logSync('tasks', tasks.length);
}

function upsertParts(parts) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO spare_parts (id, name, part_number, qty, min_qty, location, cost, last_sync)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  const upsertMany = db.transaction((items) => {
    for (const p of items) {
      stmt.run(
        p.id,
        p.name,
        p.partNumber,
        p.qty || p.qtyOnHand || 0,
        p.minQty || p.minimumQuantity || 0,
        p.location,
        p.cost
      );
    }
  });

  upsertMany(parts);
  logSync('parts', parts.length);
}

// ─────────────────────────────────────────────────────────────────────────────
// DVI JOBS
// ─────────────────────────────────────────────────────────────────────────────

function upsertJobs(jobs, dataDate) {
  // Build set of current job IDs
  const currentIds = new Set();
  for (const j of jobs) {
    const id = j.job_id || j.invoice || `${dataDate}-${j.station}-${Math.random()}`;
    currentIds.add(id);
  }

  // Get existing active jobs to detect shipped/completed
  const existingJobs = db.prepare(`
    SELECT id, invoice, tray, stage, coating, rush, entry_date, days_in_lab FROM dvi_jobs WHERE archived = 0
  `).all();

  // Archive jobs that are no longer in the current set AND were in SHIPPING stage
  // Only SHIPPING-stage jobs should be considered "shipped" — other disappearances
  // are data glitches, restarts, or canceled jobs (not real shipments)
  const archiveStmt = db.prepare(`
    UPDATE dvi_jobs SET archived = 1, shipped_at = datetime('now') WHERE id = ?
  `);
  const historyStmt = db.prepare(`
    INSERT INTO dvi_jobs_history (job_id, invoice, tray, stage, coating, rush, entry_date, days_in_lab, shipped_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  const archiveCancelStmt = db.prepare(`
    UPDATE dvi_jobs SET archived = 1 WHERE id = ?
  `);

  // Update daily stats
  const today = new Date().toISOString().split('T')[0];
  let shippedCount = 0;
  let rushShipped = 0;
  let totalDaysInLab = 0;

  const archiveCompleted = db.transaction(() => {
    for (const existing of existingJobs) {
      if (!currentIds.has(existing.id)) {
        // Only count as shipped if the job was in SHIPPING stage
        const wasShipping = (existing.stage || '').toUpperCase() === 'SHIPPING';
        if (wasShipping) {
          archiveStmt.run(existing.id);
          historyStmt.run(
            existing.id,
            existing.invoice,
            existing.tray,
            existing.stage,
            existing.coating,
            existing.rush,
            existing.entry_date,
            existing.days_in_lab
          );
          shippedCount++;
          if (existing.rush === 'Y') rushShipped++;
          if (existing.days_in_lab) totalDaysInLab += existing.days_in_lab;
        } else {
          // Not shipping — just archive, don't record as shipped
          archiveCancelStmt.run(existing.id);
        }
      }
    }
  });
  archiveCompleted();

  // Upsert current jobs
  const upsertStmt = db.prepare(`
    INSERT INTO dvi_jobs (id, invoice, tray, stage, station, status, rush, entry_date, days_in_lab, coating, frame_name, data_date, archived, last_sync)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      stage = excluded.stage,
      station = excluded.station,
      status = excluded.status,
      days_in_lab = excluded.days_in_lab,
      data_date = excluded.data_date,
      archived = 0,
      shipped_at = NULL,
      last_sync = datetime('now')
  `);

  const upsertMany = db.transaction((items) => {
    for (const j of items) {
      upsertStmt.run(
        j.job_id || j.invoice || `${dataDate}-${j.station}-${Math.random()}`,
        j.invoice,
        j.tray,
        j.stage || j.Stage,
        j.station,
        j.status,
        j.rush || j.Rush,
        j.entryDate || j.entry_date || j.date,
        j.daysInLab || j.days_in_lab,
        j.coating || j.coatR,
        j.frameName || j.frame_name,
        dataDate
      );
    }
  });

  upsertMany(jobs);

  // Update daily stats if we shipped any jobs
  if (shippedCount > 0) {
    const avgDays = shippedCount > 0 ? totalDaysInLab / shippedCount : null;
    db.prepare(`
      INSERT INTO daily_stats (stat_date, jobs_shipped, rush_jobs_shipped, avg_days_in_lab)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(stat_date) DO UPDATE SET
        jobs_shipped = jobs_shipped + excluded.jobs_shipped,
        rush_jobs_shipped = rush_jobs_shipped + excluded.rush_jobs_shipped,
        avg_days_in_lab = COALESCE(excluded.avg_days_in_lab, avg_days_in_lab)
    `).run(today, shippedCount, rushShipped, avgDays);
  }

  logSync('dvi_jobs', jobs.length);
}

// ─────────────────────────────────────────────────────────────────────────────
// QUERY FUNCTIONS (for AI agents)
// ─────────────────────────────────────────────────────────────────────────────

function queryInventorySummary() {
  const total = db.prepare('SELECT COUNT(*) as count, SUM(qty) as total_qty FROM inventory').get();
  const lowStock = db.prepare('SELECT COUNT(*) as count FROM inventory WHERE qty <= 5').get();
  const outOfStock = db.prepare('SELECT COUNT(*) as count FROM inventory WHERE qty = 0').get();
  const byCoating = db.prepare(`
    SELECT coating_type, COUNT(*) as sku_count, SUM(qty) as total_qty
    FROM inventory
    WHERE coating_type IS NOT NULL
    GROUP BY coating_type
  `).all();

  return {
    totalSkus: total.count,
    totalUnits: total.total_qty,
    lowStock: lowStock.count,
    outOfStock: outOfStock.count,
    byCoatingType: byCoating.reduce((acc, r) => { acc[r.coating_type] = r.total_qty; return acc; }, {})
  };
}

function queryAlerts() {
  return db.prepare('SELECT * FROM inventory_alerts ORDER BY severity, qty').all();
}

function queryTodaysPicks() {
  const picks = db.prepare(`
    SELECT sku, name, SUM(qty) as total_qty, SUM(picked) as total_picked, SUM(pending) as total_pending
    FROM picks
    WHERE archived = 0 AND date(started_at) = date('now')
    GROUP BY sku
    ORDER BY total_qty DESC
  `).all();

  return {
    picks,
    totalOrders: db.prepare('SELECT COUNT(DISTINCT order_id) as c FROM picks WHERE archived = 0').get().c,
    totalLines: db.prepare('SELECT COUNT(*) as c FROM picks WHERE archived = 0').get().c
  };
}

function queryWipSummary() {
  const total = db.prepare(`
    SELECT COUNT(*) as count FROM dvi_jobs
    WHERE archived = 0 AND stage NOT IN ('CANCELED', 'SHIPPED') AND (status IS NULL OR status != 'CANCELED')
  `).get();

  const byStage = db.prepare(`
    SELECT stage, COUNT(*) as count FROM dvi_jobs
    WHERE archived = 0 AND stage NOT IN ('CANCELED', 'SHIPPED') AND (status IS NULL OR status != 'CANCELED')
    GROUP BY stage ORDER BY count DESC
  `).all();

  const rushJobs = db.prepare(`
    SELECT COUNT(*) as count FROM dvi_jobs
    WHERE archived = 0 AND rush = 'Y' AND stage NOT IN ('CANCELED', 'SHIPPED')
  `).get();

  const oldest = db.prepare(`
    SELECT * FROM dvi_jobs
    WHERE archived = 0 AND stage NOT IN ('CANCELED', 'SHIPPED') AND (status IS NULL OR status != 'CANCELED')
    ORDER BY days_in_lab DESC, entry_date ASC
    LIMIT 20
  `).all();

  const lastSync = getLastSync('dvi_jobs');

  return {
    totalWIP: total.count,
    byStage: byStage.reduce((acc, r) => { acc[r.stage] = r.count; return acc; }, {}),
    rushJobs: rushJobs.count,
    oldestJobs: oldest,
    lastSync: lastSync?.synced_at
  };
}

function queryMaintenanceStats() {
  const openTasks = db.prepare(`
    SELECT COUNT(*) as count FROM maintenance_tasks WHERE status NOT IN ('Complete', 'Closed', 'Completed')
  `).get();

  const criticalTasks = db.prepare(`
    SELECT COUNT(*) as count FROM maintenance_tasks
    WHERE priority IN ('Critical', 'High', 'Urgent') AND status NOT IN ('Complete', 'Closed', 'Completed')
  `).get();

  const lowParts = db.prepare(`
    SELECT COUNT(*) as count FROM spare_parts WHERE qty <= min_qty
  `).get();

  return {
    openTasks: openTasks.count,
    criticalTasks: criticalTasks.count,
    lowStockParts: lowParts.count
  };
}

function queryRaw(sql) {
  // For AI agents to run custom queries (read-only)
  if (!sql.trim().toLowerCase().startsWith('select')) {
    throw new Error('Only SELECT queries allowed');
  }
  return db.prepare(sql).all();
}

// ─────────────────────────────────────────────────────────────────────────────
// HISTORICAL QUERIES (for AI trend analysis)
// ─────────────────────────────────────────────────────────────────────────────

function queryShippedJobs(days = 7) {
  return db.prepare(`
    SELECT * FROM dvi_jobs_history
    WHERE shipped_at >= datetime('now', '-${days} days')
    ORDER BY shipped_at DESC
  `).all();
}

function queryShippedStats(days = 7) {
  const daily = db.prepare(`
    SELECT date(shipped_at) as ship_date, COUNT(*) as count,
           SUM(CASE WHEN rush = 'Y' THEN 1 ELSE 0 END) as rush_count,
           AVG(days_in_lab) as avg_days
    FROM dvi_jobs_history
    WHERE shipped_at >= datetime('now', '-${days} days')
    GROUP BY date(shipped_at)
    ORDER BY ship_date DESC
  `).all();

  const total = db.prepare(`
    SELECT COUNT(*) as count FROM dvi_jobs_history
    WHERE shipped_at >= datetime('now', '-${days} days')
  `).get();

  return { daily, total: total.count, days };
}

function queryCompletedPicks(days = 7) {
  const daily = db.prepare(`
    SELECT date(completed_at) as pick_date, COUNT(*) as order_count,
           SUM(qty) as total_qty, COUNT(DISTINCT sku) as unique_skus
    FROM picks_history
    WHERE completed_at >= datetime('now', '-${days} days')
    GROUP BY date(completed_at)
    ORDER BY pick_date DESC
  `).all();

  const topSkus = db.prepare(`
    SELECT sku, name, SUM(qty) as total_qty, COUNT(*) as pick_count
    FROM picks_history
    WHERE completed_at >= datetime('now', '-${days} days')
    GROUP BY sku
    ORDER BY total_qty DESC
    LIMIT 20
  `).all();

  return { daily, topSkus, days };
}

function queryDailyStats(days = 30) {
  return db.prepare(`
    SELECT * FROM daily_stats
    WHERE stat_date >= date('now', '-${days} days')
    ORDER BY stat_date DESC
  `).all();
}

function queryInventoryTrend(days = 30) {
  return db.prepare(`
    SELECT * FROM inventory_snapshots
    WHERE snapshot_date >= date('now', '-${days} days')
    ORDER BY snapshot_date DESC
  `).all();
}

// ─────────────────────────────────────────────────────────────────────────────
// DAILY SNAPSHOT FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

function takeInventorySnapshot() {
  const today = new Date().toISOString().split('T')[0];

  // Check if we already have a snapshot for today
  const existing = db.prepare('SELECT id FROM inventory_snapshots WHERE snapshot_date = ?').get(today);
  if (existing) {
    console.log('[DB] Inventory snapshot already exists for today');
    return;
  }

  const total = db.prepare('SELECT COUNT(*) as count, SUM(qty) as qty FROM inventory').get();
  const lowStock = db.prepare('SELECT COUNT(*) as c FROM inventory WHERE qty <= 5').get();
  const outOfStock = db.prepare('SELECT COUNT(*) as c FROM inventory WHERE qty = 0').get();
  const byCoating = db.prepare(`
    SELECT coating_type, SUM(qty) as qty
    FROM inventory WHERE coating_type IS NOT NULL
    GROUP BY coating_type
  `).all();

  db.prepare(`
    INSERT INTO inventory_snapshots (snapshot_date, total_skus, total_units, low_stock_count, out_of_stock_count, by_coating_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    today,
    total.count,
    total.qty || 0,
    lowStock.c,
    outOfStock.c,
    JSON.stringify(byCoating)
  );

  console.log(`[DB] Inventory snapshot saved for ${today}`);
}

function updateDailyPickStats() {
  const today = new Date().toISOString().split('T')[0];

  // Count completed picks for today from history
  const stats = db.prepare(`
    SELECT COUNT(*) as count, SUM(qty) as qty
    FROM picks_history
    WHERE date(completed_at) = ?
  `).get(today);

  if (stats.count > 0) {
    db.prepare(`
      INSERT INTO daily_stats (stat_date, picks_completed, picks_qty)
      VALUES (?, ?, ?)
      ON CONFLICT(stat_date) DO UPDATE SET
        picks_completed = excluded.picks_completed,
        picks_qty = excluded.picks_qty
    `).run(today, stats.count, stats.qty || 0);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// COLD LAYER: DVI Import with XML Blob
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');

function storeDviImport(filename, xmlContent, dataDate, jobCount, source = 'upload') {
  const xmlHash = crypto.createHash('sha256').update(xmlContent).digest('hex');

  // Check for duplicate
  const existing = db.prepare('SELECT id FROM dvi_imports WHERE xml_hash = ?').get(xmlHash);
  if (existing) {
    console.log(`[DB] DVI import already exists (hash: ${xmlHash.slice(0, 8)}...)`);
    return { duplicate: true, id: existing.id };
  }

  const result = db.prepare(`
    INSERT INTO dvi_imports (filename, import_date, data_date, job_count, xml_blob, xml_hash, file_size_bytes, source)
    VALUES (?, date('now'), ?, ?, ?, ?, ?, ?)
  `).run(
    filename,
    dataDate,
    jobCount,
    xmlContent,
    xmlHash,
    Buffer.byteLength(xmlContent, 'utf8'),
    source
  );

  console.log(`[DB] DVI import stored: ${filename} (${jobCount} jobs, ${result.lastInsertRowid})`);
  return { duplicate: false, id: result.lastInsertRowid };
}

function getDviImport(importId) {
  return db.prepare('SELECT * FROM dvi_imports WHERE id = ?').get(importId);
}

function getRecentDviImports(days = 30) {
  return db.prepare(`
    SELECT id, filename, import_date, data_date, job_count, file_size_bytes, source, processed_at
    FROM dvi_imports
    WHERE import_date >= date('now', '-${days} days')
    ORDER BY import_date DESC
  `).all();
}

// ─────────────────────────────────────────────────────────────────────────────
// WARM LAYER: Refresh Summary Tables
// Called after hot layer updates to pre-compute agent-friendly aggregates
// ─────────────────────────────────────────────────────────────────────────────

function refreshWarmLayer() {
  const today = new Date().toISOString().split('T')[0];

  // Refresh throughput_daily
  const throughput = db.prepare(`
    SELECT
      COUNT(*) as total_wip,
      SUM(CASE WHEN stage LIKE '%SURF%' THEN 1 ELSE 0 END) as in_surfacing,
      SUM(CASE WHEN stage LIKE '%COAT%' THEN 1 ELSE 0 END) as in_coating,
      SUM(CASE WHEN stage LIKE '%CUT%' OR stage LIKE '%EDGE%' THEN 1 ELSE 0 END) as in_cutting,
      SUM(CASE WHEN stage LIKE '%ASSEM%' THEN 1 ELSE 0 END) as in_assembly,
      SUM(CASE WHEN rush = 'Y' THEN 1 ELSE 0 END) as rush_count,
      AVG(days_in_lab) as avg_days,
      MAX(days_in_lab) as max_days
    FROM dvi_jobs
    WHERE archived = 0 AND stage NOT IN ('CANCELED', 'SHIPPED')
  `).get();

  const shipped = db.prepare(`
    SELECT COUNT(*) as count, SUM(CASE WHEN rush = 'Y' THEN 1 ELSE 0 END) as rush
    FROM dvi_jobs_history WHERE date(shipped_at) = ?
  `).get(today);

  db.prepare(`
    INSERT INTO throughput_daily (stat_date, jobs_in_surfacing, jobs_in_coating, jobs_in_cutting, jobs_in_assembly, rush_entered, jobs_shipped, rush_shipped, avg_days_in_lab, max_days_in_lab)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(stat_date) DO UPDATE SET
      jobs_in_surfacing = excluded.jobs_in_surfacing,
      jobs_in_coating = excluded.jobs_in_coating,
      jobs_in_cutting = excluded.jobs_in_cutting,
      jobs_in_assembly = excluded.jobs_in_assembly,
      rush_entered = excluded.rush_entered,
      jobs_shipped = excluded.jobs_shipped,
      rush_shipped = excluded.rush_shipped,
      avg_days_in_lab = excluded.avg_days_in_lab,
      max_days_in_lab = excluded.max_days_in_lab,
      updated_at = datetime('now')
  `).run(
    today,
    throughput.in_surfacing || 0,
    throughput.in_coating || 0,
    throughput.in_cutting || 0,
    throughput.in_assembly || 0,
    throughput.rush_count || 0,
    shipped.count || 0,
    shipped.rush || 0,
    throughput.avg_days,
    throughput.max_days
  );

  // Refresh aging_buckets
  const buckets = [
    { name: '0-1d', min: 0, max: 1 },
    { name: '1-2d', min: 1, max: 2 },
    { name: '2-3d', min: 2, max: 3 },
    { name: '3-5d', min: 3, max: 5 },
    { name: '5-7d', min: 5, max: 7 },
    { name: '7d+', min: 7, max: 9999 }
  ];

  const agingStmt = db.prepare(`
    INSERT INTO aging_buckets (snapshot_date, bucket, stage, job_count, rush_count)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(snapshot_date, bucket, stage) DO UPDATE SET
      job_count = excluded.job_count,
      rush_count = excluded.rush_count,
      updated_at = datetime('now')
  `);

  for (const bucket of buckets) {
    const byStage = db.prepare(`
      SELECT stage, COUNT(*) as count, SUM(CASE WHEN rush = 'Y' THEN 1 ELSE 0 END) as rush
      FROM dvi_jobs
      WHERE archived = 0 AND stage NOT IN ('CANCELED', 'SHIPPED')
        AND days_in_lab >= ? AND days_in_lab < ?
      GROUP BY stage
    `).all(bucket.min, bucket.max);

    for (const row of byStage) {
      agingStmt.run(today, bucket.name, row.stage, row.count, row.rush);
    }
  }

  console.log(`[DB] Warm layer refreshed for ${today}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// NARROW QUERY FUNCTIONS (for MCP tools - agent-sized results)
// ─────────────────────────────────────────────────────────────────────────────

// Get WIP snapshot - summary only, ~10 rows
function getWipSnapshot(summaryOnly = true) {
  if (summaryOnly) {
    const stats = db.prepare(`
      SELECT
        COUNT(*) as total_wip,
        SUM(CASE WHEN rush = 'Y' THEN 1 ELSE 0 END) as rush_count,
        AVG(days_in_lab) as avg_days,
        MAX(days_in_lab) as max_days
      FROM dvi_jobs
      WHERE archived = 0 AND stage NOT IN ('CANCELED', 'SHIPPED')
    `).get();

    const byStage = db.prepare(`
      SELECT stage, COUNT(*) as count
      FROM dvi_jobs
      WHERE archived = 0 AND stage NOT IN ('CANCELED', 'SHIPPED')
      GROUP BY stage ORDER BY count DESC LIMIT 10
    `).all();

    return { ...stats, byStage, source: 'sqlite' };
  }
}

// Get coating queue with optional age filter - max ~20 rows
function getCoatingQueueAged(minDays = 0) {
  return db.prepare(`
    SELECT id, invoice, tray, coating_type, stage, days_in_lab, rush, entry_date
    FROM dvi_jobs
    WHERE archived = 0
      AND stage LIKE '%COAT%'
      AND days_in_lab >= ?
    ORDER BY days_in_lab DESC
    LIMIT 25
  `).all(minDays);
}

// Get breakage summary by department - summary + top 5 events
function getBreakageByDept(dept = null, sinceDays = 7) {
  const whereClause = dept ? `AND department = '${dept}'` : '';

  const summary = db.prepare(`
    SELECT department, reason, COUNT(*) as count
    FROM breakage_events
    WHERE occurred_at >= datetime('now', '-${sinceDays} days') ${whereClause}
    GROUP BY department, reason
    ORDER BY count DESC
    LIMIT 15
  `).all();

  const recent = db.prepare(`
    SELECT job_id, invoice, department, reason, occurred_at
    FROM breakage_events
    WHERE occurred_at >= datetime('now', '-${sinceDays} days') ${whereClause}
    ORDER BY occurred_at DESC
    LIMIT 5
  `).all();

  return { summary, recentEvents: recent, source: 'sqlite' };
}

// Get single job detail with full context (can retrieve XML blob if needed)
function getJobDetail(invoice) {
  const job = db.prepare(`
    SELECT * FROM dvi_jobs WHERE invoice = ?
  `).get(invoice);

  if (!job) {
    // Check history
    const historical = db.prepare(`
      SELECT * FROM dvi_jobs_history WHERE invoice = ? ORDER BY shipped_at DESC LIMIT 1
    `).get(invoice);

    if (historical) {
      return { job: historical, status: 'shipped', source: 'sqlite' };
    }
    return { job: null, status: 'not_found', source: 'sqlite' };
  }

  // Get breakage events for this job
  const breakages = db.prepare(`
    SELECT * FROM breakage_events WHERE invoice = ? ORDER BY occurred_at DESC
  `).all(invoice);

  return { job, breakages, status: job.archived ? 'archived' : 'active', source: 'sqlite' };
}

// Get aging report with threshold - bucketed summary
function getAgingReport(thresholdHours = 48) {
  const thresholdDays = thresholdHours / 24;

  const buckets = db.prepare(`
    SELECT bucket, SUM(job_count) as count, SUM(rush_count) as rush
    FROM aging_buckets
    WHERE snapshot_date = date('now')
    GROUP BY bucket
    ORDER BY
      CASE bucket
        WHEN '0-1d' THEN 1
        WHEN '1-2d' THEN 2
        WHEN '2-3d' THEN 3
        WHEN '3-5d' THEN 4
        WHEN '5-7d' THEN 5
        ELSE 6
      END
  `).all();

  const overThreshold = db.prepare(`
    SELECT invoice, stage, days_in_lab, rush, entry_date
    FROM dvi_jobs
    WHERE archived = 0 AND days_in_lab >= ?
    ORDER BY days_in_lab DESC
    LIMIT 20
  `).all(thresholdDays);

  return { buckets, overThreshold, thresholdDays, source: 'sqlite' };
}

// Get throughput trend - daily rollup
function getThroughputTrend(days = 7) {
  return db.prepare(`
    SELECT stat_date, jobs_shipped, jobs_in_surfacing, jobs_in_coating,
           jobs_in_cutting, jobs_in_assembly, avg_days_in_lab
    FROM throughput_daily
    WHERE stat_date >= date('now', '-${days} days')
    ORDER BY stat_date DESC
  `).all();
}

// ─────────────────────────────────────────────────────────────────────────────
// REFERENCE LAYER: SCD Type 2 Catalog Queries
// ─────────────────────────────────────────────────────────────────────────────

// Get current active lens by OPC
function getLensInfo(opc) {
  return db.prepare(`
    SELECT * FROM lens_catalog WHERE opc = ? AND valid_to IS NULL
  `).get(opc);
}

// Get lens info as of a specific date (for historical job analysis)
function getLensInfoAsOf(opc, asOfDate) {
  return db.prepare(`
    SELECT * FROM lens_catalog
    WHERE opc = ? AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)
  `).get(opc, asOfDate, asOfDate);
}

// Upsert lens catalog with SCD Type 2 logic
function upsertLensCatalog(lens) {
  const current = db.prepare(`
    SELECT * FROM lens_catalog WHERE opc = ? AND valid_to IS NULL
  `).get(lens.opc);

  if (current) {
    // Check if anything changed
    const changed = current.material !== lens.material ||
                    current.coating_type !== lens.coating_type ||
                    current.cost !== lens.cost;

    if (changed) {
      // Close current record
      db.prepare(`UPDATE lens_catalog SET valid_to = date('now') WHERE id = ?`).run(current.id);
      // Insert new record
      db.prepare(`
        INSERT INTO lens_catalog (opc, material, style, coating_type, base_curve, diameter, manufacturer, cost, valid_from)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, date('now'))
      `).run(lens.opc, lens.material, lens.style, lens.coating_type, lens.base_curve, lens.diameter, lens.manufacturer, lens.cost);
    }
  } else {
    // New OPC
    db.prepare(`
      INSERT INTO lens_catalog (opc, material, style, coating_type, base_curve, diameter, manufacturer, cost, valid_from)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, date('now'))
    `).run(lens.opc, lens.material, lens.style, lens.coating_type, lens.base_curve, lens.diameter, lens.manufacturer, lens.cost);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// ASSEMBLY DASHBOARD CONFIG (persisted key-value store)
// ─────────────────────────────────────────────────────────────────────────────

function getAssemblyConfig(key) {
  const row = db.prepare('SELECT value FROM assembly_config WHERE key = ?').get(key);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

function setAssemblyConfig(key, value) {
  db.prepare(`
    INSERT INTO assembly_config (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, JSON.stringify(value));
}

function getAllAssemblyConfig() {
  const rows = db.prepare('SELECT key, value, updated_at FROM assembly_config').all();
  const result = {};
  for (const row of rows) {
    try { result[row.key] = JSON.parse(row.value); } catch { result[row.key] = row.value; }
  }
  return result;
}

module.exports = {
  db,
  logSync,
  getLastSync,
  // Upsert functions (called by adapters)
  upsertInventory,
  upsertAlerts,
  upsertPicks,
  upsertAssets,
  upsertTasks,
  upsertParts,
  upsertJobs,
  // Query functions (for AI/MCP) - legacy
  queryInventorySummary,
  queryAlerts,
  queryTodaysPicks,
  queryWipSummary,
  queryMaintenanceStats,
  queryRaw,
  // Historical queries
  queryShippedJobs,
  queryShippedStats,
  queryCompletedPicks,
  queryDailyStats,
  queryInventoryTrend,
  // Snapshot functions
  takeInventorySnapshot,
  updateDailyPickStats,
  // Cold layer (XML archives)
  storeDviImport,
  getDviImport,
  getRecentDviImports,
  // Warm layer (summary refresh)
  refreshWarmLayer,
  // Narrow MCP queries (agent-sized results)
  getWipSnapshot,
  getCoatingQueueAged,
  getBreakageByDept,
  getJobDetail,
  getAgingReport,
  getThroughputTrend,
  // Reference layer (SCD Type 2)
  getLensInfo,
  getLensInfoAsOf,
  upsertLensCatalog,
  // Assembly Dashboard config
  getAssemblyConfig,
  setAssemblyConfig,
  getAllAssemblyConfig
};
