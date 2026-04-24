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
// SCHEMA MIGRATIONS — safe ALTER TABLE for existing databases
// ─────────────────────────────────────────────────────────────────────────────
try { db.exec('ALTER TABLE netsuite_consumption_daily ADD COLUMN category TEXT'); } catch {}
try { db.exec("ALTER TABLE looker_jobs ADD COLUMN dvi_destination TEXT DEFAULT 'PAIR'"); } catch {}

// NPI — New Product Introduction scenarios
db.exec(`
  CREATE TABLE IF NOT EXISTS npi_scenarios (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    new_sku_prefix TEXT,
    adoption_pct REAL DEFAULT 50,
    source_type TEXT DEFAULT 'prefix',
    source_value TEXT,
    proxy_sku TEXT,
    manufacturing_weeks REAL DEFAULT 13,
    transit_weeks REAL DEFAULT 4,
    fda_hold_weeks REAL DEFAULT 2,
    safety_stock_weeks REAL,  -- optional override; null = derive from ABC class via model
    abc_class TEXT,            -- optional override; null = auto-classify from projected volume
    status TEXT DEFAULT 'planning',
    launch_date TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS npi_cannibalization (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scenario_id TEXT NOT NULL,
    source_sku TEXT NOT NULL,
    current_weekly REAL DEFAULT 0,
    lost_weekly REAL DEFAULT 0,
    new_weekly REAL DEFAULT 0,
    computed_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (scenario_id) REFERENCES npi_scenarios(id)
  );
  CREATE INDEX IF NOT EXISTS idx_npi_cann_scenario ON npi_cannibalization(scenario_id);
`);

// Migrate older databases: add safety_stock_weeks + abc_class columns if missing.
try { db.exec("ALTER TABLE npi_scenarios ADD COLUMN safety_stock_weeks REAL"); } catch (e) { /* already exists */ }
try { db.exec("ALTER TABLE npi_scenarios ADD COLUMN abc_class TEXT"); } catch (e) { /* already exists */ }
// Phase 2: non-cannibalizing NPI — standard_profile source type needs
// template_id + total_qty on the scenario.
try { db.exec("ALTER TABLE npi_scenarios ADD COLUMN standard_profile_template_id INTEGER REFERENCES rx_profile_templates(id)"); } catch (e) { /* already exists */ }
try { db.exec("ALTER TABLE npi_scenarios ADD COLUMN standard_profile_qty INTEGER"); } catch (e) { /* already exists */ }

// Phase M1 (material-category NPI): checkbox-driven cannibalization by material
// class instead of per-SKU paste. source_type='material_category' + one row per
// checked (material, lens_type_class) in npi_scenario_material_targets. Feature-
// flagged via model_params.npi_material_category_ui_enabled (default false).
db.exec(`
  CREATE TABLE IF NOT EXISTS npi_scenario_material_targets (
    scenario_id     TEXT NOT NULL,
    material_code   TEXT NOT NULL,      -- 'PLY','BLY','H67','B67' (extensible)
    lens_type_class TEXT NOT NULL CHECK (lens_type_class IN ('SV','SEMI')),
    adoption_pct    REAL NOT NULL DEFAULT 50 CHECK (adoption_pct BETWEEN 0 AND 100),
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (scenario_id, material_code, lens_type_class),
    FOREIGN KEY (scenario_id) REFERENCES npi_scenarios(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_nsmt_scenario ON npi_scenario_material_targets(scenario_id);
  CREATE INDEX IF NOT EXISTS idx_nsmt_material ON npi_scenario_material_targets(material_code, lens_type_class);
`);
// Composite index on jobs to speed the SV Rx bucket query (predicate on
// lens_type + lens_material + entry_date). Not critical at current row count
// but future-proof.
try { db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_type_mat_entry ON jobs(lens_type, lens_material, entry_date)"); } catch {}

// Phase 4: placeholder SKUs for NPI ordering — the real supplier SKUs don't
// exist until after the order is placed and received. Orders reference
// placeholder codes; operator maps placeholder → real SKU when the supplier
// sends the receiving manifest. On mapping, a lens_sku_params row is created
// for the real SKU inheriting the scenario's abc_class + safety + lead times.
// Placeholder is preserved after mapping for audit trail.
db.exec(`
  CREATE TABLE IF NOT EXISTS npi_placeholder_skus (
    placeholder_code  TEXT PRIMARY KEY,        -- e.g. 'NPI-{scenario_id}-V1'
    scenario_id       TEXT NOT NULL,
    variant_index     INTEGER NOT NULL,         -- 1-based
    label             TEXT,                     -- optional descriptive label (material + BC etc.)
    real_sku          TEXT,                     -- null until mapped
    supplier_sku      TEXT,                     -- optional
    status            TEXT DEFAULT 'pending',   -- 'pending' | 'mapped'
    created_at        TEXT DEFAULT (datetime('now')),
    mapped_at         TEXT,
    notes             TEXT,
    UNIQUE (scenario_id, variant_index),
    FOREIGN KEY (scenario_id) REFERENCES npi_scenarios(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_npi_ph_scenario ON npi_placeholder_skus(scenario_id);
  CREATE INDEX IF NOT EXISTS idx_npi_ph_real_sku ON npi_placeholder_skus(real_sku);
`);

// Phase 5: quarantine inventory — physical lenses received under a placeholder
// SKU before the supplier's real SKU code has been assigned. Held in
// quarantine; on mapping placeholder → real SKU, the quarantine stock is
// 'released' and the operator confirms the merge with any existing ItemPath
// qty (dedup) to get it to 'reconciled'. Does NOT write to ItemPath — that's
// the vendor's source of truth. The badge / status is read-side only.
db.exec(`
  CREATE TABLE IF NOT EXISTS npi_quarantine_receipts (
    id                        INTEGER PRIMARY KEY AUTOINCREMENT,
    scenario_id               TEXT NOT NULL,
    placeholder_code          TEXT NOT NULL,
    received_qty              INTEGER NOT NULL,
    received_at               TEXT NOT NULL,         -- PT-local ISO
    received_by               TEXT,                  -- operator id
    supplier_sku              TEXT,                  -- optional pre-mapping
    notes                     TEXT,
    status                    TEXT DEFAULT 'quarantined',  -- 'quarantined' | 'released' | 'reconciled'
    released_at               TEXT,
    release_real_sku          TEXT,
    itempath_qty_at_release   INTEGER,
    reconciled_at             TEXT,
    reconciled_by             TEXT,
    FOREIGN KEY (scenario_id) REFERENCES npi_scenarios(id) ON DELETE CASCADE,
    FOREIGN KEY (placeholder_code) REFERENCES npi_placeholder_skus(placeholder_code) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_npi_qr_scenario ON npi_quarantine_receipts(scenario_id);
  CREATE INDEX IF NOT EXISTS idx_npi_qr_placeholder ON npi_quarantine_receipts(placeholder_code);
  CREATE INDEX IF NOT EXISTS idx_npi_qr_status ON npi_quarantine_receipts(status);
  CREATE INDEX IF NOT EXISTS idx_npi_qr_real_sku ON npi_quarantine_receipts(release_real_sku);
`);

// Lens Intelligence — SKU planning parameters (configurable per SKU)
db.exec(`
  CREATE TABLE IF NOT EXISTS lens_sku_params (
    sku TEXT PRIMARY KEY,
    supplier TEXT,
    manufacturing_weeks REAL DEFAULT 13.0,
    transit_weeks REAL DEFAULT 4.0,
    fda_hold_weeks REAL DEFAULT 2.0,
    total_lead_time_weeks REAL GENERATED ALWAYS AS (manufacturing_weeks + transit_weeks + fda_hold_weeks) STORED,
    safety_stock_weeks REAL DEFAULT 4.0,
    abc_class TEXT DEFAULT 'B',
    min_order_qty INTEGER DEFAULT 0,
    notes TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);
// Add routing column for long-tail stock/surface decisions
try { db.exec("ALTER TABLE lens_sku_params ADD COLUMN routing TEXT DEFAULT 'STOCK'"); } catch {}
try { db.exec("ALTER TABLE lens_sku_params ADD COLUMN sku_type TEXT"); } catch {}

// Seed well-known semi-finished SKUs (historical hardcoded list — still used for
// the very first bootstrap when lens_sku_properties is empty; after the 12-month
// aggregation backfill runs, lens_sku_properties.lens_type_modal='P' becomes the
// authoritative source). See also: getSemifinishedSkus() below.
const SEED_SEMIFINISHED = [
  '4800135412', '4800135420', '4800135438', '4800154660',
  '4800135339', '4800135347', '4800135354', '4800135362',
  '4800150924', '4800150932', '4800135305', '4800150940', '4800150957',
  '4800150882', '4800150890', '4800135297', '4800150908', '4800150916', '4800150965',
  '265007922', '265007930', '265007948', '265007955', '265007963', '265007971', '265007989',
  '265008466', '265008474', '265008482', '265008490', '265008508',
];
try {
  const upsert = db.prepare(`INSERT INTO lens_sku_params (sku, sku_type, routing) VALUES (?, 'semifinished', 'STOCK')
    ON CONFLICT(sku) DO UPDATE SET sku_type = 'semifinished'`);
  const run = db.transaction(() => { for (const sku of SEED_SEMIFINISHED) upsert.run(sku); });
  run();
} catch (e) { console.error('[DB] Failed to seed semi-finished SKUs:', e.message); }

// ─────────────────────────────────────────────────────────────────────────────
// LENS SKU PROPERTIES — aggregated from 12 months of live DVI XML / jobs data
// Populated by scripts/backfill-lens-sku-properties.js. Holds EMPIRICAL per-SKU
// material / base curve / Rx ranges. Different from lens_sku_params (parametric
// planning) — this is observational truth from actual jobs.
// ─────────────────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS lens_sku_properties (
    sku                 TEXT PRIMARY KEY,
    material            TEXT,           -- modal lens_material (coded enum: BLY, PLY, B67, H67, SPY)
    material_conf       REAL,           -- 0..1 fraction of jobs agreeing on modal material
    lens_type_modal     TEXT,           -- S, P, or C — drives SV/Surfacing classification
    base_curve          REAL,           -- parsed from lensStyle or provided via lens_sku_params
    diameter            INTEGER,        -- semi-finished blank diameter (not frame eye_size)
    sph_min             REAL,
    sph_max             REAL,
    cyl_min             REAL,
    cyl_max             REAL,
    add_min             REAL,           -- progressive/bifocal only — null for SV
    add_max             REAL,
    eye_size_min        INTEGER,        -- frame eye size range this SKU has been cut to
    eye_size_max        INTEGER,
    common_coatings     TEXT,           -- JSON array of top coatings with counts
    typical_thick       TEXT,
    sample_job_count    INTEGER NOT NULL DEFAULT 0,   -- confidence signal
    first_seen          TEXT,           -- MIN(entry_date) in aggregation window
    last_seen           TEXT,           -- MAX(entry_date)
    last_aggregated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_lsp_material      ON lens_sku_properties(material);
  CREATE INDEX IF NOT EXISTS idx_lsp_lens_type     ON lens_sku_properties(lens_type_modal);
  CREATE INDEX IF NOT EXISTS idx_lsp_last_agg      ON lens_sku_properties(last_aggregated_at);
`);

// Seed lens_sku_properties with known semi-finished SKUs + base curves from
// server/lib/semifinished-seed.js (one-time transcription of Phil's
// Lens_Planning_V3.xlsx Semi_finSkus sheet). Runs on startup. Upserts:
// material + base_curve + lens_type_modal='P' (pucks). Preserves any already-
// populated sample_job_count / Rx range data from the backfill.
try {
  const { SEMI_FINISHED_SEED } = require('./lib/semifinished-seed');
  const upsertSeed = db.prepare(`
    INSERT INTO lens_sku_properties (sku, material, lens_type_modal, base_curve, sample_job_count, last_aggregated_at)
    VALUES (?, ?, 'P', ?, 0, datetime('now'))
    ON CONFLICT(sku) DO UPDATE SET
      -- material/base_curve: COALESCE preserves existing (backfill from DVI XML
      -- may have richer data than the seed transcription).
      -- lens_type_modal: SEED IS AUTHORITATIVE — Phil's XLS is the source of
      -- truth for puck-vs-stock classification. The DVI backfill can mis-label
      -- a semi-finished puck as 'S' if it gets cut as SV in DVI for any reason
      -- (mis-route, tool error, etc.); without forcing 'P' here, that
      -- mis-label sticks forever and the SKU gets pulled into SV NPI scenarios
      -- as a donor (inflating order with high-myopia outliers) AND excluded
      -- from semi NPI scenarios. Force 'P' on every startup.
      material        = COALESCE(lens_sku_properties.material, excluded.material),
      lens_type_modal = excluded.lens_type_modal,
      base_curve      = COALESCE(excluded.base_curve, lens_sku_properties.base_curve)
  `);
  db.transaction(() => {
    for (const s of SEMI_FINISHED_SEED) upsertSeed.run(s.sku, s.material, s.base_curve);
  })();
} catch (e) {
  console.warn('[DB] Failed to seed semi-finished properties:', e.message);
}

// ─────────────────────────────────────────────────────────────────────────────
// RX PROFILE TEMPLATES — standard prescription distribution for non-cannibalizing
// NPI. Two default templates: "Standard SV" and "Standard Surfacing" auto-derived
// from 12 months of live consumption. Editable in the UI after derivation.
//
// Expansion: to emit N per-job rows for a scenario of type='standard_profile',
// sample N buckets weighted by pct_of_total and emit a row per sample.
// ─────────────────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS rx_profile_templates (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    lens_type   TEXT NOT NULL,              -- 'SV' or 'Surfacing'
    description TEXT,
    is_default  INTEGER DEFAULT 0,          -- 1 = the system-derived default for its lens_type
    source      TEXT,                        -- 'auto_12mo', 'manual', 'imported'
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS rx_profile_buckets (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    template_id   INTEGER NOT NULL,
    sph_min       REAL,                      -- SV: populated; Surfacing: null (pucks have no Rx)
    sph_max       REAL,
    cyl_min       REAL,
    cyl_max       REAL,
    add_min       REAL,
    add_max       REAL,
    base_curve    REAL,                      -- Surfacing: populated; SV: null
    pct_of_total  REAL NOT NULL,             -- 0..1 share of total demand
    sample_count  INTEGER DEFAULT 0,
    FOREIGN KEY (template_id) REFERENCES rx_profile_templates(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_rxpb_template ON rx_profile_buckets(template_id);
`);

// Lens Intelligence — inventory health, stockout prediction, reorder recommendations
db.exec(`
  CREATE TABLE IF NOT EXISTS lens_inventory_status (
    sku TEXT PRIMARY KEY,
    description TEXT,
    category TEXT,
    on_hand INTEGER DEFAULT 0,
    avg_weekly_consumption REAL DEFAULT 0,
    consumption_trend_pct REAL DEFAULT 0,
    weeks_of_supply REAL DEFAULT 0,
    weeks_of_supply_with_po REAL DEFAULT 0,
    safety_stock_weeks REAL DEFAULT 4.0,
    lead_time_weeks REAL DEFAULT 6.0,
    dynamic_reorder_point INTEGER DEFAULT 0,
    open_po_qty INTEGER DEFAULT 0,
    next_po_date TEXT,
    runout_date TEXT,
    runout_date_with_po TEXT,
    will_stockout INTEGER DEFAULT 0,
    days_at_risk INTEGER DEFAULT 0,
    status TEXT DEFAULT 'OK',
    order_recommended INTEGER DEFAULT 0,
    order_qty_recommended INTEGER DEFAULT 0,
    computed_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_lis_status ON lens_inventory_status(status);
  CREATE INDEX IF NOT EXISTS idx_lis_wos ON lens_inventory_status(weeks_of_supply);

  CREATE TABLE IF NOT EXISTS lens_consumption_weekly (
    sku TEXT NOT NULL,
    week_start TEXT NOT NULL,
    units_consumed INTEGER DEFAULT 0,
    PRIMARY KEY(sku, week_start)
  );
  CREATE INDEX IF NOT EXISTS idx_lcw_sku ON lens_consumption_weekly(sku);
`);

// Looker job-level data (single source of truth for NetSuite/DVI data)
db.exec(`
  CREATE TABLE IF NOT EXISTS looker_jobs (
    job_id TEXT NOT NULL,
    order_number TEXT,
    dvi_id TEXT,
    sent_from_lab_date TEXT NOT NULL,
    dvi_destination TEXT DEFAULT 'PAIR',
    frame_upc TEXT,
    opc TEXT,
    count_lenses INTEGER DEFAULT 0,
    count_breakages INTEGER DEFAULT 0,
    last_sync TEXT DEFAULT (datetime('now')),
    PRIMARY KEY(job_id, opc)
  );
  CREATE INDEX IF NOT EXISTS idx_lj_date ON looker_jobs(sent_from_lab_date);
  CREATE INDEX IF NOT EXISTS idx_lj_order ON looker_jobs(order_number);
  CREATE INDEX IF NOT EXISTS idx_lj_opc ON looker_jobs(opc);
  CREATE INDEX IF NOT EXISTS idx_lj_upc ON looker_jobs(frame_upc);
`);

// Shipped jobs unified (DVI + Looker cross-reference)
db.exec(`
  CREATE TABLE IF NOT EXISTS shipped_jobs (
    reference TEXT NOT NULL,
    date TEXT NOT NULL,
    invoice TEXT,
    dvi_id TEXT,
    coating TEXT,
    lens_type TEXT,
    lens_opc TEXT,
    frame_upc TEXT,
    frame_style TEXT,
    department TEXT,
    days_in_lab TEXT,
    entry_date TEXT,
    rush TEXT,
    in_dvi INTEGER DEFAULT 0,
    in_looker INTEGER DEFAULT 0,
    last_sync TEXT DEFAULT (datetime('now')),
    PRIMARY KEY(reference, date)
  );
  CREATE INDEX IF NOT EXISTS idx_shipped_date ON shipped_jobs(date);
  CREATE INDEX IF NOT EXISTS idx_shipped_source ON shipped_jobs(in_dvi, in_looker);
`);

// PO tables
db.exec(`
  CREATE TABLE IF NOT EXISTS purchase_orders (
    id TEXT PRIMARY KEY,
    po_number TEXT,
    date TEXT,
    status TEXT,
    status_code TEXT,
    vendor TEXT,
    memo TEXT,
    line_count INTEGER,
    total_qty INTEGER,
    total_received INTEGER,
    total_remaining INTEGER,
    total_amount REAL,
    lines_json TEXT,
    last_sync TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_po_status ON purchase_orders(status_code);
  CREATE INDEX IF NOT EXISTS idx_po_date ON purchase_orders(date);

  CREATE TABLE IF NOT EXISTS purchase_orders_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    po_id TEXT,
    po_number TEXT,
    status TEXT,
    total_qty INTEGER,
    total_received INTEGER,
    vendor TEXT,
    recorded_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_po_hist_number ON purchase_orders_history(po_number);
`);
try { db.exec('ALTER TABLE tops_inventory ADD COLUMN upc TEXT'); } catch {}
try { db.exec('ALTER TABLE tops_inventory ADD COLUMN model_name TEXT'); } catch {}
try { db.exec('ALTER TABLE tops_inventory ADD COLUMN top_code TEXT'); } catch {}
try { db.exec('ALTER TABLE tops_inventory ADD COLUMN location TEXT'); } catch {}
try { db.exec('ALTER TABLE tops_inventory ADD COLUMN count_date TEXT'); } catch {}

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

  -- Sync heartbeats: one row per adapter/source. Updated on every successful
  -- sync. The 01:30 data-health-check launchd job reads this table and Slacks
  -- when any source hasn't checked in within its stale threshold. Catches the
  -- exact silent-failure pattern that left picks_history frozen for 5 days.
  CREATE TABLE IF NOT EXISTS sync_heartbeats (
    source TEXT PRIMARY KEY,
    last_success_at INTEGER NOT NULL,
    last_row_count INTEGER,
    last_error TEXT,
    consecutive_errors INTEGER DEFAULT 0,
    stale_threshold_ms INTEGER,
    updated_at INTEGER DEFAULT (unixepoch() * 1000)
  );

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
`);
// Add unique constraint on pick_id (dedup existing records first)
try {
  // Remove duplicates keeping lowest id
  db.exec(`DELETE FROM picks_history WHERE id NOT IN (SELECT MIN(id) FROM picks_history GROUP BY pick_id)`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_picks_hist_pick_id ON picks_history(pick_id)`);
} catch (e) { /* index may already exist */ }

// pickSync rebuild (2026-04-22): tag every row with the writer that produced it.
// Values: 'live' (dual-writer), 'tx' (transaction-writer, gap closer),
// 'backfill' (pickSync historical), 'recovered' (one-shot picks→picks_history).
// NULL = legacy rows written before this column existed.
try { db.exec(`ALTER TABLE picks_history ADD COLUMN source TEXT DEFAULT NULL`); } catch (e) { /* already exists */ }
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_picks_hist_source ON picks_history(source)`); } catch (e) { /* already exists */ }

// Delta-poll cursor persistence (2026-04-23 §3 fix): single-row-per-type cursor
// store so the in-memory cursor survives process restarts AND so consecutive
// all-dupe ticks can advance past the stuck max(completed_at) cliff.
// Keys: type=4 (picks), type=3 (puts).
db.exec(`
  CREATE TABLE IF NOT EXISTS delta_poll_cursor (
    type INTEGER PRIMARY KEY,
    cursor TEXT,
    updated_at INTEGER
  );
`);

// Transactions — persistent mirror of ItemPath /api/transactions (append-only, forever retention).
// Split: hot table (scalar columns) + transactions_raw (JSON blob) to keep hot-table scan-friendly.
db.exec(`
  CREATE TABLE IF NOT EXISTS transactions (
    transaction_id TEXT PRIMARY KEY,
    type INTEGER,
    motive_type TEXT,
    number TEXT,
    order_id TEXT,
    order_line_id TEXT,
    order_name TEXT,
    material_name TEXT,
    user_name TEXT,
    warehouse_name TEXT,
    location_name TEXT,
    bin_name TEXT,
    station_name TEXT,
    qty_requested REAL,
    qty_confirmed REAL,
    qty_deviated REAL,
    lot TEXT,
    serial_number TEXT,
    reason_code TEXT,
    creation_date TEXT,
    recorded_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_tx_creation ON transactions(creation_date);
  CREATE INDEX IF NOT EXISTS idx_tx_order_name ON transactions(order_name);
  CREATE INDEX IF NOT EXISTS idx_tx_order_line ON transactions(order_line_id);
  CREATE INDEX IF NOT EXISTS idx_tx_material ON transactions(material_name);
  CREATE INDEX IF NOT EXISTS idx_tx_type ON transactions(type);
  CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_name);
  CREATE INDEX IF NOT EXISTS idx_tx_recorded ON transactions(recorded_at);

  CREATE TABLE IF NOT EXISTS transactions_raw (
    transaction_id TEXT PRIMARY KEY,
    raw_json TEXT,
    FOREIGN KEY (transaction_id) REFERENCES transactions(transaction_id)
  );
`);
db.exec(`

  -- Binning Intelligence
  CREATE TABLE IF NOT EXISTS bin_contents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    location_name TEXT NOT NULL,
    carousel TEXT,
    shelf TEXT,
    position TEXT,
    warehouse TEXT,
    material_id TEXT,
    sku TEXT,
    qty REAL DEFAULT 0,
    last_sync TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_bin_sku ON bin_contents(sku);
  CREATE INDEX IF NOT EXISTS idx_bin_carousel ON bin_contents(carousel);
  CREATE INDEX IF NOT EXISTS idx_bin_wh ON bin_contents(warehouse);

  CREATE TABLE IF NOT EXISTS pick_sequences (
    sku_a TEXT NOT NULL,
    sku_b TEXT NOT NULL,
    co_pick_count INTEGER DEFAULT 1,
    avg_gap_seconds REAL,
    last_seen TEXT,
    PRIMARY KEY(sku_a, sku_b)
  );
  CREATE INDEX IF NOT EXISTS idx_seq_count ON pick_sequences(co_pick_count DESC);

  CREATE TABLE IF NOT EXISTS binning_recommendations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    priority TEXT DEFAULT 'recommended',
    description TEXT,
    details_json TEXT,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now')),
    resolved_at TEXT
  );

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

  -- SOM devices (Schneider machine status)
  CREATE TABLE IF NOT EXISTS som_devices (
    id TEXT PRIMARY KEY,
    model TEXT,
    type_description TEXT,
    category TEXT,
    department_id INTEGER,
    status INTEGER,
    status_label TEXT,
    severity TEXT,
    event TEXT,
    last_order TEXT,
    count1 INTEGER DEFAULT 0,
    count2 INTEGER DEFAULT 0,
    count3 INTEGER DEFAULT 0,
    cycle_time REAL DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    last_sync TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_som_dev_category ON som_devices(category);
  CREATE INDEX IF NOT EXISTS idx_som_dev_status ON som_devices(status);

  -- SOM conveyors (Schneider conveyor positions)
  CREATE TABLE IF NOT EXISTS som_conveyors (
    id TEXT PRIMARY KEY,
    status INTEGER,
    status_label TEXT,
    severity TEXT,
    event TEXT,
    last_update TEXT,
    last_sync TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_som_conv_status ON som_conveyors(status);

  -- SOM device history (append-only status changes)
  CREATE TABLE IF NOT EXISTS som_device_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    status INTEGER,
    status_label TEXT,
    severity TEXT,
    event TEXT,
    recorded_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_som_hist_device ON som_device_history(device_id);
  CREATE INDEX IF NOT EXISTS idx_som_hist_time ON som_device_history(recorded_at);

  -- Downtime records (Limble)
  CREATE TABLE IF NOT EXISTS downtime_records (
    id TEXT PRIMARY KEY,
    asset_id TEXT,
    asset_name TEXT,
    start_time TEXT,
    end_time TEXT,
    duration_mins INTEGER,
    reason TEXT,
    planned INTEGER DEFAULT 0,
    category TEXT,
    last_sync TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_downtime_start ON downtime_records(start_time);
  CREATE INDEX IF NOT EXISTS idx_downtime_asset ON downtime_records(asset_id);
  CREATE INDEX IF NOT EXISTS idx_downtime_planned ON downtime_records(planned);

  -- Oven runs (migrated from oven-runs.json)
  CREATE TABLE IF NOT EXISTS oven_runs (
    id INTEGER PRIMARY KEY,
    oven_id TEXT,
    oven_name TEXT,
    rack TEXT,
    rack_label TEXT,
    coating TEXT,
    target_secs INTEGER,
    actual_secs INTEGER,
    operator TEXT,
    received_at INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_oven_runs_oven ON oven_runs(oven_id);
  CREATE INDEX IF NOT EXISTS idx_oven_runs_received ON oven_runs(received_at);
  CREATE INDEX IF NOT EXISTS idx_oven_runs_coating ON oven_runs(coating);

  -- Coating runs (migrated from coating-runs.json)
  CREATE TABLE IF NOT EXISTS coating_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    coater_id TEXT,
    coater_name TEXT,
    started_at INTEGER,
    stopped_at INTEGER,
    target_sec INTEGER,
    elapsed_sec INTEGER,
    job_count INTEGER,
    jobs_json TEXT,
    status TEXT,
    rating INTEGER,
    feedback TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_coating_runs_coater ON coating_runs(coater_id);
  CREATE INDEX IF NOT EXISTS idx_coating_runs_started ON coating_runs(started_at);
  CREATE INDEX IF NOT EXISTS idx_coating_runs_status ON coating_runs(status);

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
  CREATE INDEX IF NOT EXISTS idx_jobs_entry ON dvi_jobs(entry_date);

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

  -- DVI Shipped Jobs — full XML ground truth (Phase 1)
  CREATE TABLE IF NOT EXISTS dvi_shipped_jobs (
    invoice TEXT PRIMARY KEY,
    reference TEXT,
    tray TEXT,
    rx_number TEXT,
    entry_date TEXT,
    entry_time TEXT,
    ship_date TEXT,
    ship_time TEXT,
    days_in_lab INTEGER,
    department TEXT,
    job_type TEXT,
    operator TEXT,
    job_origin TEXT,
    machine_id TEXT,
    is_hko INTEGER DEFAULT 0,
    lens_opc_r TEXT,
    lens_opc_l TEXT,
    lens_style TEXT,
    lens_material TEXT,
    lens_type TEXT,
    lens_pick TEXT,
    lens_color TEXT,
    coating TEXT,
    coat_type TEXT,
    frame_upc TEXT,
    frame_name TEXT,
    frame_style TEXT,
    frame_sku TEXT,
    frame_mfr TEXT,
    frame_color TEXT,
    eye_size TEXT,
    bridge TEXT,
    edge_type TEXT,
    rx_r_sphere TEXT,
    rx_r_cylinder TEXT,
    rx_r_axis TEXT,
    rx_r_pd TEXT,
    rx_r_add TEXT,
    rx_l_sphere TEXT,
    rx_l_cylinder TEXT,
    rx_l_axis TEXT,
    rx_l_pd TEXT,
    rx_l_add TEXT,
    recorded_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_dsj_ship ON dvi_shipped_jobs(ship_date);
  CREATE INDEX IF NOT EXISTS idx_dsj_entry ON dvi_shipped_jobs(entry_date);
  CREATE INDEX IF NOT EXISTS idx_dsj_ref ON dvi_shipped_jobs(reference);
  CREATE INDEX IF NOT EXISTS idx_dsj_opc_r ON dvi_shipped_jobs(lens_opc_r);
  CREATE INDEX IF NOT EXISTS idx_dsj_opc_l ON dvi_shipped_jobs(lens_opc_l);
  CREATE INDEX IF NOT EXISTS idx_dsj_frame ON dvi_shipped_jobs(frame_upc);
  CREATE INDEX IF NOT EXISTS idx_dsj_dept ON dvi_shipped_jobs(department);
  CREATE INDEX IF NOT EXISTS idx_dsj_op ON dvi_shipped_jobs(operator);

  -- Daily ship targets — SLA-based target snapshot + actual shipped, captured once/day
  CREATE TABLE IF NOT EXISTS daily_ship_targets (
    date TEXT PRIMARY KEY,           -- YYYY-MM-DD
    is_workday INTEGER DEFAULT 1,    -- 0 for weekends
    sv_wip INTEGER DEFAULT 0,        -- SV WIP at snapshot time (start of day)
    surf_wip INTEGER DEFAULT 0,      -- Surfacing WIP at snapshot time
    sv_target INTEGER DEFAULT 0,
    surf_target INTEGER DEFAULT 0,
    total_target INTEGER DEFAULT 0,
    shipped_actual INTEGER DEFAULT 0,
    variance INTEGER DEFAULT 0,       -- actual - target
    variance_pct REAL DEFAULT 0,      -- variance / target * 100
    captured_at TEXT DEFAULT (datetime('now')),
    finalized_at TEXT                 -- when end-of-day shipped count was locked in
  );

  -- DVI Trace persistence — survives server restarts
  CREATE TABLE IF NOT EXISTS dvi_trace_jobs (
    job_id TEXT PRIMARY KEY,
    tray TEXT,
    station TEXT,
    station_num INTEGER,
    stage TEXT,
    category TEXT,
    status TEXT DEFAULT 'Active',
    first_seen_ms INTEGER,
    last_seen_ms INTEGER,
    operator TEXT,
    machine_id TEXT,
    has_breakage INTEGER DEFAULT 0,
    event_count INTEGER DEFAULT 0,
    events_json TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_trace_stage ON dvi_trace_jobs(stage);
  CREATE INDEX IF NOT EXISTS idx_trace_firstseen ON dvi_trace_jobs(first_seen_ms);
  CREATE INDEX IF NOT EXISTS idx_trace_status ON dvi_trace_jobs(status);

  -- DVI Trace per-file byte offsets — survives server restarts so cold-start
  -- can tail-forward from the last successfully-processed byte instead of
  -- replaying the whole file (which corrupts WIP if any read fails).
  CREATE TABLE IF NOT EXISTS dvi_trace_offsets (
    filename TEXT PRIMARY KEY,
    byte_offset INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );

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

  -- Production daily summary (pre-computed, one row per day, all stages)
  CREATE TABLE IF NOT EXISTS production_daily (
    date TEXT PRIMARY KEY,
    label TEXT,
    dow INTEGER,
    picked INTEGER DEFAULT 0,
    incoming INTEGER DEFAULT 0,
    surfacing INTEGER DEFAULT 0,
    coating INTEGER DEFAULT 0,
    cutting INTEGER DEFAULT 0,
    assembly INTEGER DEFAULT 0,
    shipping INTEGER DEFAULT 0,
    hko INTEGER DEFAULT 0,
    bottleneck_stage TEXT,
    bottleneck_rate REAL,
    bottleneck_upstream_rate REAL,
    hourly_json TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  -- NetSuite consumption (transaction lines, negative qty = consumed)
  CREATE TABLE IF NOT EXISTS netsuite_consumption (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sku TEXT NOT NULL,
    qty INTEGER NOT NULL,
    tran_date TEXT NOT NULL,
    tran_type TEXT,
    synced_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ns_consume_sku ON netsuite_consumption(sku);
  CREATE INDEX IF NOT EXISTS idx_ns_consume_date ON netsuite_consumption(tran_date);

  -- NetSuite consumption daily aggregates (faster queries)
  CREATE TABLE IF NOT EXISTS netsuite_consumption_daily (
    tran_date TEXT NOT NULL,
    sku TEXT NOT NULL,
    qty INTEGER NOT NULL,
    lines INTEGER NOT NULL,
    category TEXT,
    PRIMARY KEY(tran_date, sku)
  );
  CREATE INDEX IF NOT EXISTS idx_ns_cd_date ON netsuite_consumption_daily(tran_date);
  CREATE INDEX IF NOT EXISTS idx_ns_cd_sku ON netsuite_consumption_daily(sku);

  -- NetSuite inventory snapshot (current on-hand at Irvine 2)
  CREATE TABLE IF NOT EXISTS netsuite_inventory (
    sku TEXT PRIMARY KEY,
    item_id TEXT,
    upc TEXT,
    name TEXT,
    qty REAL DEFAULT 0,
    available REAL DEFAULT 0,
    category TEXT,
    class_name TEXT,
    class_id TEXT,
    last_sync TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ns_inv_category ON netsuite_inventory(category);
  CREATE INDEX IF NOT EXISTS idx_ns_inv_qty ON netsuite_inventory(qty);

  -- Looker lens usage (cached from Look 1118)
  CREATE TABLE IF NOT EXISTS looker_lens_daily (
    tran_date TEXT NOT NULL,
    opc TEXT NOT NULL,
    lenses INTEGER NOT NULL,
    breakages INTEGER DEFAULT 0,
    PRIMARY KEY(tran_date, opc)
  );
  CREATE INDEX IF NOT EXISTS idx_lk_lens_date ON looker_lens_daily(tran_date);

  -- Looker frame usage (cached from Look 495)
  CREATE TABLE IF NOT EXISTS looker_frame_daily (
    tran_date TEXT NOT NULL,
    upc TEXT NOT NULL,
    jobs INTEGER NOT NULL,
    PRIMARY KEY(tran_date, upc)
  );
  CREATE INDEX IF NOT EXISTS idx_lk_frame_date ON looker_frame_daily(tran_date);

  -- TOPS manual count uploads
  CREATE TABLE IF NOT EXISTS tops_inventory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sku TEXT NOT NULL,
    upc TEXT,
    model_name TEXT,
    top_code TEXT,
    qty INTEGER NOT NULL,
    location TEXT,
    upload_id TEXT NOT NULL,
    count_date TEXT,
    uploaded_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_tops_sku ON tops_inventory(sku);
  CREATE INDEX IF NOT EXISTS idx_tops_upload ON tops_inventory(upload_id);
  CREATE INDEX IF NOT EXISTS idx_tops_upc ON tops_inventory(upc);

  CREATE TABLE IF NOT EXISTS tops_uploads (
    id TEXT PRIMARY KEY,
    filename TEXT,
    row_count INTEGER,
    total_qty INTEGER,
    uploaded_at TEXT DEFAULT (datetime('now'))
  );
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

// Vision self-training system tables
db.exec(`
  -- Every scan attempt from LensScanner app (persistent)
  CREATE TABLE IF NOT EXISTS vision_reads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    capture_id TEXT UNIQUE,
    job_number TEXT,
    eye_side TEXT,
    ocr_confidence REAL,
    raw_text TEXT,
    device TEXT,
    station_id TEXT,
    operator_id TEXT,
    tool_id TEXT,
    matched INTEGER DEFAULT 0,
    matched_job_id TEXT,
    matched_stage TEXT,
    validation_reason TEXT,
    correct_job TEXT,
    resolution_type TEXT,
    image_path TEXT,
    model_version TEXT,
    scanned_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_vr_job ON vision_reads(job_number);
  CREATE INDEX IF NOT EXISTS idx_vr_matched ON vision_reads(matched);
  CREATE INDEX IF NOT EXISTS idx_vr_scanned ON vision_reads(scanned_at);
  CREATE INDEX IF NOT EXISTS idx_vr_station ON vision_reads(station_id);

  -- Labeled images for training pipeline
  CREATE TABLE IF NOT EXISTS vision_labels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    capture_id TEXT NOT NULL,
    label TEXT NOT NULL,
    label_source TEXT NOT NULL,
    image_path TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_vl_label ON vision_labels(label);

  -- Model version tracking
  CREATE TABLE IF NOT EXISTS vision_models (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version TEXT NOT NULL,
    trained_at TEXT,
    sample_count INTEGER,
    precision_score REAL,
    recall_score REAL,
    f1_score REAL,
    status TEXT DEFAULT 'candidate',
    promoted_at TEXT,
    notes TEXT
  );

  -- Confidence model sync (shared across iPads)
  CREATE TABLE IF NOT EXISTS vision_confidence_sync (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    threshold REAL DEFAULT 0.5,
    samples TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );
  INSERT OR IGNORE INTO vision_confidence_sync (id, threshold, samples) VALUES (1, 0.5, '[]');
`);

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

  -- Users (synced from Okta, or created manually for dev)
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    name TEXT,
    role TEXT DEFAULT 'viewer',
    okta_id TEXT,
    avatar_url TEXT,
    last_login TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
  CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

  -- Sessions (login/logout tracking)
  CREATE TABLE IF NOT EXISTS user_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token TEXT UNIQUE NOT NULL,
    source TEXT DEFAULT 'okta',
    ip_address TEXT,
    user_agent TEXT,
    started_at TEXT DEFAULT (datetime('now')),
    last_activity TEXT DEFAULT (datetime('now')),
    ended_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_token ON user_sessions(token);
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON user_sessions(user_id);

  -- Activity log (page views, actions)
  CREATE TABLE IF NOT EXISTS user_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    session_id INTEGER,
    action TEXT NOT NULL,
    detail TEXT,
    metadata TEXT,
    timestamp TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_activity_user ON user_activity(user_id);
  CREATE INDEX IF NOT EXISTS idx_activity_action ON user_activity(action);
  CREATE INDEX IF NOT EXISTS idx_activity_ts ON user_activity(timestamp);
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
// SYNC HEARTBEATS — one row per adapter. Updated on every successful run.
// data-health-check.js reads this at 01:30 daily and Slacks on staleness.
// ─────────────────────────────────────────────────────────────────────────────
const recordHeartbeatSuccessStmt = db.prepare(`
  INSERT INTO sync_heartbeats (source, last_success_at, last_row_count, last_error, consecutive_errors, stale_threshold_ms, updated_at)
  VALUES (?, unixepoch() * 1000, ?, NULL, 0, ?, unixepoch() * 1000)
  ON CONFLICT(source) DO UPDATE SET
    last_success_at = unixepoch() * 1000,
    last_row_count = excluded.last_row_count,
    last_error = NULL,
    consecutive_errors = 0,
    stale_threshold_ms = COALESCE(excluded.stale_threshold_ms, sync_heartbeats.stale_threshold_ms),
    updated_at = unixepoch() * 1000
`);

const recordHeartbeatErrorStmt = db.prepare(`
  INSERT INTO sync_heartbeats (source, last_success_at, last_row_count, last_error, consecutive_errors, stale_threshold_ms, updated_at)
  VALUES (?, 0, NULL, ?, 1, ?, unixepoch() * 1000)
  ON CONFLICT(source) DO UPDATE SET
    last_error = excluded.last_error,
    consecutive_errors = sync_heartbeats.consecutive_errors + 1,
    stale_threshold_ms = COALESCE(excluded.stale_threshold_ms, sync_heartbeats.stale_threshold_ms),
    updated_at = unixepoch() * 1000
`);

function recordHeartbeat(source, rowCount = null, staleThresholdMs = null) {
  try { recordHeartbeatSuccessStmt.run(source, rowCount, staleThresholdMs); } catch (e) { /* ignore */ }
}
function recordHeartbeatError(source, errorMsg, staleThresholdMs = null) {
  try { recordHeartbeatErrorStmt.run(source, String(errorMsg || 'unknown').slice(0, 500), staleThresholdMs); } catch (e) { /* ignore */ }
}
function getStaleHeartbeats() {
  return db.prepare(`
    SELECT source, last_success_at, last_row_count, last_error, consecutive_errors, stale_threshold_ms
    FROM sync_heartbeats
    WHERE stale_threshold_ms IS NOT NULL
      AND (unixepoch() * 1000 - last_success_at) > stale_threshold_ms
    ORDER BY last_success_at ASC
  `).all();
}

// ─────────────────────────────────────────────────────────────────────────────
// SEMI-FINISHED SKU LOOKUP — replaces the three hardcoded KNOWN_SEMIFINISHED
// Sets that used to exist in db.js, long-tail-analysis.js, lens-intelligence.js.
// Primary source: lens_sku_properties.lens_type_modal = 'P' (aggregated from
// 12 months of live data by backfill-lens-sku-properties.js).
// Union with the bootstrap seed list so the app works before backfill runs.
// Returns a Set for O(1) membership checks.
// ─────────────────────────────────────────────────────────────────────────────
function getSemifinishedSkus() {
  const set = new Set(SEED_SEMIFINISHED);
  try {
    const rows = db.prepare(
      `SELECT sku FROM lens_sku_properties WHERE lens_type_modal = 'P'`
    ).all();
    for (const r of rows) set.add(r.sku);
  } catch { /* lens_sku_properties may not exist on first boot */ }
  try {
    const rows = db.prepare(
      `SELECT sku FROM lens_sku_params WHERE sku_type = 'semifinished'`
    ).all();
    for (const r of rows) set.add(r.sku);
  } catch { /* fine */ }
  return set;
}

function getSkuProperties(sku) {
  return db.prepare(`SELECT * FROM lens_sku_properties WHERE sku = ?`).get(sku);
}

function getRxProfileTemplate(id) {
  const tpl = db.prepare(`SELECT * FROM rx_profile_templates WHERE id = ?`).get(id);
  if (!tpl) return null;
  tpl.buckets = db.prepare(
    `SELECT * FROM rx_profile_buckets WHERE template_id = ? ORDER BY pct_of_total DESC`
  ).all(id);
  return tpl;
}

function listRxProfileTemplates() {
  return db.prepare(`SELECT * FROM rx_profile_templates ORDER BY lens_type, name`).all();
}

// ─────────────────────────────────────────────────────────────────────────────
// NPI PLACEHOLDER SKU helpers
// ─────────────────────────────────────────────────────────────────────────────
function listPlaceholders(scenarioId) {
  return db.prepare(
    `SELECT * FROM npi_placeholder_skus WHERE scenario_id = ? ORDER BY variant_index`
  ).all(scenarioId);
}

// Auto-generate one placeholder for a scenario. Called on scenario create.
// Returns the placeholder_code.
function createPlaceholder(scenarioId, { label = null } = {}) {
  const existing = db.prepare(
    `SELECT MAX(variant_index) AS m FROM npi_placeholder_skus WHERE scenario_id = ?`
  ).get(scenarioId);
  const nextIdx = (existing?.m || 0) + 1;
  const code = `NPI-${scenarioId}-V${nextIdx}`;
  db.prepare(
    `INSERT INTO npi_placeholder_skus (placeholder_code, scenario_id, variant_index, label, status)
     VALUES (?, ?, ?, ?, 'pending')`
  ).run(code, scenarioId, nextIdx, label);
  return code;
}

// Map a placeholder → real SKU. Creates a lens_sku_params row for the real SKU
// inheriting the scenario's abc_class, safety_stock_weeks, mfg/transit/fda.
// INSERT OR IGNORE so if the real SKU already has a params row (prior receipt,
// pre-existing catalog entry), we don't clobber it.
function mapPlaceholder(scenarioId, placeholderCode, realSku, supplierSku = null, itempathQtySnapshot = null) {
  const scenario = db.prepare(`SELECT * FROM npi_scenarios WHERE id = ?`).get(scenarioId);
  if (!scenario) throw new Error('Scenario not found');
  const ph = db.prepare(
    `SELECT * FROM npi_placeholder_skus WHERE placeholder_code = ? AND scenario_id = ?`
  ).get(placeholderCode, scenarioId);
  if (!ph) throw new Error('Placeholder not found');
  if (!realSku || !/^[A-Za-z0-9._-]+$/.test(realSku)) throw new Error('Invalid real SKU format');

  let quarantineReleased = 0;
  let quarantineTotalQty = 0;
  db.transaction(() => {
    db.prepare(
      `UPDATE npi_placeholder_skus SET real_sku = ?, supplier_sku = ?, status = 'mapped', mapped_at = datetime('now')
       WHERE placeholder_code = ?`
    ).run(realSku, supplierSku, placeholderCode);
    // Inherit scenario params — INSERT OR IGNORE preserves any existing row
    db.prepare(
      `INSERT OR IGNORE INTO lens_sku_params
       (sku, manufacturing_weeks, transit_weeks, fda_hold_weeks, safety_stock_weeks, abc_class, routing)
       VALUES (?, ?, ?, ?, ?, ?, 'STOCK')`
    ).run(
      realSku,
      scenario.manufacturing_weeks || 13,
      scenario.transit_weeks || 4,
      scenario.fda_hold_weeks || 2,
      scenario.safety_stock_weeks || 4,
      scenario.abc_class || 'B'
    );
    // Auto-release any quarantined stock for this placeholder. Caller passes
    // the ItemPath qty snapshot so we capture what dedup baseline looked like
    // at release time. Operator still needs to confirm-reconcile per receipt.
    const quarantined = db.prepare(
      `SELECT id, received_qty FROM npi_quarantine_receipts WHERE placeholder_code = ? AND status = 'quarantined'`
    ).all(placeholderCode);
    quarantineReleased = quarantined.length;
    quarantineTotalQty = quarantined.reduce((s, r) => s + (r.received_qty || 0), 0);
    if (quarantined.length > 0) {
      const now = ptNowIso();
      const stmt = db.prepare(
        `UPDATE npi_quarantine_receipts
         SET status = 'released', released_at = ?, release_real_sku = ?, itempath_qty_at_release = ?
         WHERE id = ?`
      );
      for (const r of quarantined) stmt.run(now, realSku, itempathQtySnapshot, r.id);
    }
  })();
  return {
    placeholder_code: placeholderCode,
    real_sku: realSku,
    quarantineReleased,
    quarantineTotalQty,
    itempathQtySnapshot,
    proposedTotal: (itempathQtySnapshot || 0) + quarantineTotalQty,
    needsReconcile: quarantineReleased > 0 && (itempathQtySnapshot || 0) > 0,
  };
}

function removePlaceholder(scenarioId, placeholderCode) {
  const res = db.prepare(
    `DELETE FROM npi_placeholder_skus WHERE placeholder_code = ? AND scenario_id = ?`
  ).run(placeholderCode, scenarioId);
  return { deleted: res.changes };
}

// ─────────────────────────────────────────────────────────────────────────────
// NPI QUARANTINE RECEIPTS — physical inventory received under a placeholder
// ─────────────────────────────────────────────────────────────────────────────
function listQuarantineReceipts(scenarioId) {
  return db.prepare(
    `SELECT * FROM npi_quarantine_receipts WHERE scenario_id = ? ORDER BY received_at DESC, id DESC`
  ).all(scenarioId);
}

function ptNowIso() {
  // Lab PT local ISO timestamp (matches feedback_lab_day_window pattern)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const g = (t) => parts.find(p => p.type === t)?.value;
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}:${g('second')}`;
}

function receiveQuarantine(scenarioId, placeholderCode, { received_qty, received_by = null, supplier_sku = null, notes = null }) {
  const qty = Number(received_qty);
  if (!Number.isInteger(qty) || qty <= 0) throw new Error('received_qty must be a positive integer');
  const ph = db.prepare(
    `SELECT * FROM npi_placeholder_skus WHERE placeholder_code = ? AND scenario_id = ?`
  ).get(placeholderCode, scenarioId);
  if (!ph) throw new Error('Placeholder not found');
  const info = db.prepare(
    `INSERT INTO npi_quarantine_receipts (scenario_id, placeholder_code, received_qty, received_at, received_by, supplier_sku, notes, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'quarantined')`
  ).run(scenarioId, placeholderCode, qty, ptNowIso(), received_by, supplier_sku, notes);
  return { id: info.lastInsertRowid, scenarioId, placeholderCode, received_qty: qty };
}

function removeQuarantineReceipt(scenarioId, receiptId) {
  const res = db.prepare(
    `DELETE FROM npi_quarantine_receipts WHERE id = ? AND scenario_id = ?`
  ).run(receiptId, scenarioId);
  return { deleted: res.changes };
}

// Called by mapPlaceholder. Flips any 'quarantined' receipts for this
// placeholder → 'released', stamps real_sku + itempath qty snapshot. Does NOT
// mark reconciled — operator must confirm the merge first.
function releaseQuarantineForPlaceholder(placeholderCode, realSku, itempathQtySnapshot) {
  const now = ptNowIso();
  const res = db.prepare(
    `UPDATE npi_quarantine_receipts
     SET status = 'released', released_at = ?, release_real_sku = ?, itempath_qty_at_release = ?
     WHERE placeholder_code = ? AND status = 'quarantined'`
  ).run(now, realSku, itempathQtySnapshot, placeholderCode);
  return { released: res.changes };
}

// ─────────────────────────────────────────────────────────────────────────────
// NPI Material-Category Targets — Phase M1 helpers
// ─────────────────────────────────────────────────────────────────────────────
function listMaterialTargets(scenarioId) {
  return db.prepare(
    `SELECT * FROM npi_scenario_material_targets WHERE scenario_id = ? ORDER BY lens_type_class, material_code`
  ).all(scenarioId);
}

function setMaterialTargets(scenarioId, targets) {
  // targets: array of {material_code, lens_type_class, adoption_pct}
  db.transaction(() => {
    db.prepare(`DELETE FROM npi_scenario_material_targets WHERE scenario_id = ?`).run(scenarioId);
    const ins = db.prepare(
      `INSERT INTO npi_scenario_material_targets (scenario_id, material_code, lens_type_class, adoption_pct)
       VALUES (?, ?, ?, ?)`
    );
    for (const t of targets) {
      if (!t.material_code || !t.lens_type_class) continue;
      if (!['SV', 'SEMI'].includes(t.lens_type_class)) throw new Error('Invalid lens_type_class');
      ins.run(scenarioId, t.material_code.toUpperCase(), t.lens_type_class, Number(t.adoption_pct) || 50);
    }
  })();
  return { updated: targets.length };
}

// Materialize cannibalized consumption for a scenario. Reads
// lens_sku_properties + lens_consumption_weekly. Returns per-target row:
// { scenario_id, material_code, lens_type_class, sku_count, weekly_avg,
//   adoption_pct, projected_weekly }.
// 12-month window matches lens_sku_properties backfill convention.
function getMaterialCategoryProjection(scenarioId) {
  try {
    return db.prepare(`
      SELECT
        t.scenario_id,
        t.material_code,
        t.lens_type_class,
        COUNT(DISTINCT p.sku)                                               AS sku_count,
        ROUND(COALESCE(SUM(cw.weekly_avg), 0), 1)                           AS weekly_avg,
        t.adoption_pct,
        ROUND(COALESCE(SUM(cw.weekly_avg), 0) * t.adoption_pct / 100.0, 1)  AS projected_weekly
      FROM npi_scenario_material_targets t
      JOIN lens_sku_properties p
        ON p.material = t.material_code
       AND ((t.lens_type_class = 'SV'   AND p.lens_type_modal IN ('S','C'))
         OR (t.lens_type_class = 'SEMI' AND p.lens_type_modal = 'P'))
      LEFT JOIN (
        SELECT sku,
               SUM(units_consumed) * 1.0 / NULLIF(COUNT(DISTINCT week_start), 0) AS weekly_avg
        FROM lens_consumption_weekly
        WHERE week_start >= date('now', '-12 months', 'localtime')
        GROUP BY sku
      ) cw ON cw.sku = p.sku
      WHERE t.scenario_id = ?
      GROUP BY t.scenario_id, t.material_code, t.lens_type_class, t.adoption_pct
      ORDER BY t.lens_type_class, t.material_code
    `).all(scenarioId);
  } catch (e) {
    return [];
  }
}

// Simple key/value model_params feature flag — default false (rollback safe)
function getModelFlag(key) {
  try {
    const row = db.prepare(`SELECT value FROM model_params WHERE key = ?`).get(key);
    if (!row) return null;
    if (row.value === 'true') return true;
    if (row.value === 'false') return false;
    return row.value;
  } catch { return null; }
}
function setModelFlag(key, value) {
  try {
    db.exec("CREATE TABLE IF NOT EXISTS model_params (key TEXT PRIMARY KEY, value TEXT)");
    db.prepare(`INSERT INTO model_params (key, value) VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));
  } catch { /* ignore */ }
}

function confirmQuarantineReconcile(scenarioId, receiptId, reconciledBy = null) {
  const res = db.prepare(
    `UPDATE npi_quarantine_receipts
     SET status = 'reconciled', reconciled_at = ?, reconciled_by = ?
     WHERE id = ? AND scenario_id = ? AND status = 'released'`
  ).run(ptNowIso(), reconciledBy, receiptId, scenarioId);
  return { reconciled: res.changes };
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
  // SAFETY: Filter out put orders (receiving INTO Kardex) — only track consumption (picks)
  // Put references contain "put" (e.g., "ManualPut-LAPTOP-...")
  const filteredPicks = picks.filter(o => {
    const ref = (o.reference || '').toLowerCase();
    return !ref.includes('put');
  });
  if (filteredPicks.length < picks.length) {
    console.log(`[DB] upsertPicks: filtered ${picks.length - filteredPicks.length} put orders, processing ${filteredPicks.length} picks`);
  }
  picks = filteredPicks;

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
  // NOTE: No longer writes to picks_history here — pick history is now recorded
  // via /api/order_lines transaction recording in itempath-adapter.js and
  // periodic imports from ItemPath History List exports.
  const archiveStmt = db.prepare(`
    UPDATE picks SET archived = 1, completed_at = datetime('now') WHERE id = ?
  `);

  const archiveCompleted = db.transaction(() => {
    for (const existing of existingPicks) {
      if (!currentIds.has(existing.id)) {
        archiveStmt.run(existing.id);
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
// PICKS HISTORY — append-only log of completed ItemPath order_lines.
// Shared by live pickSync (itempath-adapter.js) and backfill scripts.
// pick_id convention: 'hist-' + line.id (ItemPath order_line GUID).
// UNIQUE constraint on pick_id makes INSERT OR IGNORE fully idempotent.
// ─────────────────────────────────────────────────────────────────────────────
const { normalizeWarehouse } = require('./itempath-normalize');

const upsertPicksHistoryStmt = db.prepare(`
  INSERT OR IGNORE INTO picks_history (pick_id, order_id, sku, name, qty, picked, warehouse, completed_at, source)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const PICKS_HISTORY_MAX_QTY = 10000; // sanity clamp: no legitimate pick is 10k+ units

// pickSync rebuild (2026-04-22): callers now pass `source` so we can
// distinguish real-time captures ('live'/'tx') from after-the-fact
// recovery ('backfill'/'recovered'). Default null preserves callers
// that haven't been migrated yet (none should remain in tree).
function upsertPicksHistory(lines, source) {
  let inserted = 0, skipped = 0, rejected = 0;
  const src = source || null;
  // Allow callers to pass a custom pick_id prefix per line via line.pickId.
  // (Used by tx-writer to dedupe against live-writer rows on the same pick.)
  const save = db.transaction(() => {
    for (const line of lines) {
      const sku = line.materialName || '';
      const qty = Math.abs(parseFloat(line.quantityConfirmed) || 0);
      if (!sku || qty <= 0) { skipped++; continue; }
      if (qty > PICKS_HISTORY_MAX_QTY) {
        rejected++;
        console.warn(`[DB] upsertPicksHistory: rejecting qty=${qty} sku=${sku} id=${line.id} (over ${PICKS_HISTORY_MAX_QTY} clamp — probable data error)`);
        continue;
      }
      const orderName = line.orderName || line.orderId || '';
      const wh = normalizeWarehouse(line.warehouseName || line.costCenterName || '');
      const completedAt = line.modifiedDate || line.creationDate || new Date().toISOString();
      // Caller may supply a fully-formed pickId (tx-writer / recovery script) — honor it.
      // Otherwise fall back to the legacy 'hist-<order_line.id>' shape.
      const pickId = line.pickId || `hist-${line.id || line.orderLineId || ''}`;
      const result = upsertPicksHistoryStmt.run(pickId, orderName, sku, orderName, qty, qty, wh, completedAt, src);
      if (result.changes > 0) inserted++;
    }
  });
  save();
  return { inserted, skipped, rejected, total: lines.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// TRANSACTIONS — persistent mirror of ItemPath /api/transactions.
// Stub: returns early until the `transactions` table is created (Phase 5).
// When the table exists, populates via INSERT OR IGNORE on transaction_id PK.
// ─────────────────────────────────────────────────────────────────────────────
let _transactionsTableChecked = false;
let _transactionsTableExists = false;

function _checkTransactionsTable() {
  if (_transactionsTableChecked) return _transactionsTableExists;
  const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='transactions'`).get();
  _transactionsTableExists = !!row;
  _transactionsTableChecked = true;
  return _transactionsTableExists;
}

function upsertTransactions(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return { inserted: 0, skipped: 0, total: 0 };
  if (!_checkTransactionsTable()) return { inserted: 0, skipped: rows.length, total: rows.length, reason: 'transactions table not created yet' };

  const txStmt = db.prepare(`
    INSERT OR IGNORE INTO transactions (
      transaction_id, type, motive_type, number,
      order_id, order_line_id, order_name,
      material_name, user_name,
      warehouse_name, location_name, bin_name, station_name,
      qty_requested, qty_confirmed, qty_deviated,
      lot, serial_number, reason_code,
      creation_date
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const rawStmt = db.prepare(`INSERT OR IGNORE INTO transactions_raw (transaction_id, raw_json) VALUES (?, ?)`);

  let inserted = 0, skipped = 0;
  const save = db.transaction(() => {
    for (const r of rows) {
      if (!r || !r.id) { skipped++; continue; }
      const result = txStmt.run(
        r.id,
        r.type ?? null,
        r.motiveType ?? null,
        r.number ?? null,
        r.orderId ?? null,
        r.orderLineId ?? null,
        r.orderName ?? null,
        r.materialName ?? null,
        r.userName ?? null,
        r.warehouseName ?? null,
        r.locationName ?? null,
        r.binName ?? null,
        r.stationName ?? null,
        r.quantityRequested ?? null,
        r.quantityConfirmed ?? null,
        r.quantityDeviated ?? null,
        r.lot ?? null,
        r.serialNumber ?? null,
        r.reasonCode ?? null,
        r.creationDate ?? null,
      );
      if (result.changes > 0) {
        inserted++;
        rawStmt.run(r.id, JSON.stringify(r));
      }
    }
  });
  save();
  return { inserted, skipped, total: rows.length };
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

function upsertDowntime(records) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO downtime_records (id, asset_id, asset_name, start_time, end_time, duration_mins, reason, planned, category, last_sync)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  const upsertMany = db.transaction((items) => {
    for (const d of items) {
      stmt.run(
        d.id, d.assetId, d.assetName,
        d.startTime, d.endTime, d.durationMins,
        d.reason, d.planned ? 1 : 0, d.category
      );
    }
  });

  upsertMany(records);
  logSync('downtime', records.length);
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
      tray = COALESCE(excluded.tray, dvi_jobs.tray),
      rush = CASE WHEN dvi_jobs.rush IS NULL OR dvi_jobs.rush = 'N' THEN COALESCE(excluded.rush, dvi_jobs.rush) ELSE dvi_jobs.rush END,
      entry_date = COALESCE(dvi_jobs.entry_date, excluded.entry_date),
      coating = COALESCE(dvi_jobs.coating, excluded.coating),
      frame_name = COALESCE(dvi_jobs.frame_name, excluded.frame_name),
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
    WHERE shipped_at >= datetime('now', '-' || ? || ' days')
    ORDER BY shipped_at DESC
  `).all(days);
}

function queryShippedStats(days = 7) {
  // dvi_jobs_history.shipped_at is stored naive UTC via datetime('now').
  // date('localtime') shifts to the server's local TZ (Mac Studio = PT at lab).
  const daily = db.prepare(`
    SELECT date(shipped_at, 'localtime') as ship_date, COUNT(*) as count,
           SUM(CASE WHEN rush = 'Y' THEN 1 ELSE 0 END) as rush_count,
           AVG(days_in_lab) as avg_days
    FROM dvi_jobs_history
    WHERE shipped_at >= datetime('now', '-' || ? || ' days')
    GROUP BY date(shipped_at, 'localtime')
    ORDER BY ship_date DESC
  `).all(days);

  const total = db.prepare(`
    SELECT COUNT(*) as count FROM dvi_jobs_history
    WHERE shipped_at >= datetime('now', '-' || ? || ' days')
  `).get(days);

  return { daily, total: total.count, days };
}

function queryCompletedPicks(days = 7) {
  // picks_history.completed_at is offset-form or naive PT — substr(col,1,10)
  // reads the PT date literal. date(col) would evaluate in UTC and mis-bucket.
  const daily = db.prepare(`
    SELECT substr(completed_at, 1, 10) as pick_date, COUNT(*) as order_count,
           SUM(qty) as total_qty, COUNT(DISTINCT sku) as unique_skus
    FROM picks_history
    WHERE completed_at >= datetime('now', '-${days} days')
    GROUP BY substr(completed_at, 1, 10)
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

/**
 * SKU-level consumption with daily averages and days-of-supply calculation
 * Used by InventoryAgent for stocking plans
 */
function queryConsumption(days = 7) {
  // Per-SKU consumption over the period. substr(col,1,10) = PT-local date;
  // date() in UTC would double-count cross-midnight-UTC evening picks.
  const skuConsumption = db.prepare(`
    SELECT
      ph.sku,
      ph.name,
      SUM(ph.qty) as total_consumed,
      COUNT(DISTINCT substr(ph.completed_at, 1, 10)) as active_days,
      ROUND(CAST(SUM(ph.qty) AS REAL) / NULLIF(COUNT(DISTINCT substr(ph.completed_at, 1, 10)), 0), 1) as avg_daily_usage,
      ph.warehouse
    FROM picks_history ph
    WHERE ph.completed_at >= datetime('now', '-' || ? || ' days')
    GROUP BY ph.sku, ph.warehouse
    ORDER BY total_consumed DESC
  `).all(days);

  // Current stock levels for each SKU across ALL warehouses
  const stockLevels = db.prepare(`
    SELECT sku, name, qty, coating_type, warehouse
    FROM inventory
  `).all();

  // Build lookups: by SKU+warehouse, and WH3 extended inventory by SKU
  const stockMap = {};
  const wh3Stock = {};
  for (const s of stockLevels) {
    const wh = s.warehouse || 'WH1';
    const key = `${s.sku}|${wh}`;
    stockMap[key] = s;
    if (wh === 'WH3') {
      wh3Stock[s.sku] = (wh3Stock[s.sku] || 0) + (s.qty || 0);
    }
  }

  // Combine consumption with current stock + WH3 availability
  const stockingPlan = skuConsumption.map(c => {
    const key = `${c.sku}|${c.warehouse || 'WH1'}`;
    const stock = stockMap[key];
    const currentQty = stock ? stock.qty : 0;
    const wh3Qty = wh3Stock[c.sku] || 0;
    const daysOfSupply = c.avg_daily_usage > 0 ? Math.round(currentQty / c.avg_daily_usage * 10) / 10 : null;
    const wh3DaysOfSupply = c.avg_daily_usage > 0 ? Math.round(wh3Qty / c.avg_daily_usage * 10) / 10 : null;
    return {
      sku: c.sku,
      name: c.name,
      warehouse: c.warehouse,
      coating: stock?.coating_type || null,
      current_qty: currentQty,
      wh3_qty: wh3Qty,
      wh3_days_of_supply: wh3DaysOfSupply,
      total_consumed: c.total_consumed,
      active_days: c.active_days,
      avg_daily_usage: c.avg_daily_usage,
      days_of_supply: daysOfSupply,
      priority: daysOfSupply === null ? 'UNKNOWN' :
                daysOfSupply <= 2 ? 'URGENT' :
                daysOfSupply <= 5 ? 'ORDER_SOON' :
                daysOfSupply <= 10 ? 'MONITOR' : 'ADEQUATE',
      action: daysOfSupply !== null && daysOfSupply <= 5
        ? (wh3Qty > 0 ? 'TRANSFER_FROM_WH3' : 'REORDER')
        : 'ADEQUATE',
    };
  });

  // Daily totals for the period
  const dailyTotals = db.prepare(`
    SELECT date(completed_at) as pick_date, SUM(qty) as total_qty, COUNT(*) as pick_count
    FROM picks_history
    WHERE completed_at >= datetime('now', '-' || ? || ' days')
    GROUP BY date(completed_at)
    ORDER BY pick_date DESC
  `).all(days);

  return {
    period_days: days,
    stocking_plan: stockingPlan,
    daily_totals: dailyTotals,
    summary: {
      total_skus: skuConsumption.length,
      total_consumed: skuConsumption.reduce((s, c) => s + c.total_consumed, 0),
      urgent_count: stockingPlan.filter(s => s.priority === 'URGENT').length,
      order_soon_count: stockingPlan.filter(s => s.priority === 'ORDER_SOON').length,
    }
  };
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
  // Use PT-local date, not UTC. The lab runs 5 AM - midnight PT; evening picks
  // (5 PM PT onward) land on "tomorrow" in UTC. toISOString().split('T')[0]
  // gives UTC date which is wrong for lab-local daily stats.
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).reduce((acc, p) => {
    if (p.type === 'year') acc.y = p.value;
    else if (p.type === 'month') acc.m = p.value;
    else if (p.type === 'day') acc.d = p.value;
    return acc;
  }, {});
  const todayPt = `${today.y}-${today.m}-${today.d}`;

  // Count completed picks for today from history. substr(col,1,10) reads the
  // PT-local date from the stored string (offset-form and naive rows both
  // have YYYY-MM-DD prefix that's already PT).
  const stats = db.prepare(`
    SELECT COUNT(*) as count, SUM(qty) as qty
    FROM picks_history
    WHERE substr(completed_at, 1, 10) = ?
  `).get(todayPt);

  if (stats.count > 0) {
    db.prepare(`
      INSERT INTO daily_stats (stat_date, picks_completed, picks_qty)
      VALUES (?, ?, ?)
      ON CONFLICT(stat_date) DO UPDATE SET
        picks_completed = excluded.picks_completed,
        picks_qty = excluded.picks_qty
    `).run(todayPt, stats.count, stats.qty || 0);
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
  // PT-local 'today' — UTC date would miss jobs shipped 5 PM - midnight PT.
  const todayParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).reduce((acc, p) => {
    if (p.type === 'year') acc.y = p.value;
    else if (p.type === 'month') acc.m = p.value;
    else if (p.type === 'day') acc.d = p.value;
    return acc;
  }, {});
  const today = `${todayParts.y}-${todayParts.m}-${todayParts.d}`;

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

  // dvi_jobs_history.shipped_at is naive UTC — use 'localtime' to get PT date.
  const shipped = db.prepare(`
    SELECT COUNT(*) as count, SUM(CASE WHEN rush = 'Y' THEN 1 ELSE 0 END) as rush
    FROM dvi_jobs_history WHERE date(shipped_at, 'localtime') = ?
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
  const daysParam = [sinceDays];
  const deptFilter = dept ? 'AND department = ?' : '';
  const params = dept ? [sinceDays, dept] : daysParam;

  const summary = db.prepare(`
    SELECT department, reason, COUNT(*) as count
    FROM breakage_events
    WHERE occurred_at >= datetime('now', '-' || ? || ' days') ${deptFilter}
    GROUP BY department, reason
    ORDER BY count DESC
    LIMIT 15
  `).all(...params);

  const recent = db.prepare(`
    SELECT job_id, invoice, department, reason, occurred_at
    FROM breakage_events
    WHERE occurred_at >= datetime('now', '-' || ? || ' days') ${deptFilter}
    ORDER BY occurred_at DESC
    LIMIT 5
  `).all(...params);

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
// DVI SHIPPED JOBS (XML ground truth)
// ─────────────────────────────────────────────────────────────────────────────

const upsertShippedJobStmt = db.prepare(`
  INSERT OR REPLACE INTO dvi_shipped_jobs (
    invoice, reference, tray, rx_number, entry_date, entry_time,
    ship_date, ship_time, days_in_lab, department, job_type, operator,
    job_origin, machine_id, is_hko,
    lens_opc_r, lens_opc_l, lens_style, lens_material, lens_type, lens_pick, lens_color,
    coating, coat_type,
    frame_upc, frame_name, frame_style, frame_sku, frame_mfr, frame_color,
    eye_size, bridge, edge_type,
    rx_r_sphere, rx_r_cylinder, rx_r_axis, rx_r_pd, rx_r_add,
    rx_l_sphere, rx_l_cylinder, rx_l_axis, rx_l_pd, rx_l_add
  ) VALUES (
    ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?, ?,
    ?, ?, ?,
    ?, ?, ?, ?, ?, ?, ?,
    ?, ?,
    ?, ?, ?, ?, ?, ?,
    ?, ?, ?,
    ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?
  )
`);

function convertDate(raw) {
  // Convert MM/DD/YY → YYYY-MM-DD, pass through if already YYYY-MM-DD or null
  if (!raw) return null;
  const m = raw.match(/^(\d{2})\/(\d{2})\/(\d{2})$/);
  if (m) return `20${m[3]}-${m[1]}-${m[2]}`;
  return raw; // already ISO or unknown format
}

function upsertShippedJob(p) {
  if (!p || !p.invoice) return;
  const rx = p.rx || {};
  const R = rx.R || {};
  const L = rx.L || {};
  upsertShippedJobStmt.run(
    p.invoice, p.reference || null, p.tray || null, p.rxNum || null,
    convertDate(p.entryDate), p.entryTime || null,
    convertDate(p.shipDate), p.shipTime || null,
    p.daysInLab ? parseInt(p.daysInLab, 10) : null,
    p.department || null, p.jobType || null, p.operator || null,
    p.jobOrigin || null, p.machineId || null, p.isHko ? 1 : 0,
    p.lensOpc || null, p.lensOpcL || null,
    p.lensStyle || null, p.lensMat || null, p.lensType || null, p.lensPick || null, p.lensColor || null,
    p.coating || null, p.coatType || null,
    p.frameUpc || null, p.frameName || null, p.frameStyle || null, p.frameSku || null, p.frameMfr || null, p.frameColor || null,
    p.eyeSize || null, p.bridge || null, p.edgeType || null,
    R.sphere || null, R.cylinder || null, R.axis || null, R.pd || null, R.add || null,
    L.sphere || null, L.cylinder || null, L.axis || null, L.pd || null, L.add || null
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SOM DEVICES & CONVEYORS
// ─────────────────────────────────────────────────────────────────────────────

const upsertSomDeviceStmt = db.prepare(`
  INSERT OR REPLACE INTO som_devices (id, model, type_description, category, department_id, status, status_label, severity, event, last_order, count1, count2, count3, cycle_time, is_active, last_sync)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
`);

const upsertSomConveyorStmt = db.prepare(`
  INSERT OR REPLACE INTO som_conveyors (id, status, status_label, severity, event, last_update, last_sync)
  VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
`);

// Only log status changes — don't flood with identical snapshots
const _lastDeviceStatus = new Map();

const insertSomDeviceHistoryStmt = db.prepare(`
  INSERT INTO som_device_history (device_id, status, status_label, severity, event)
  VALUES (?, ?, ?, ?, ?)
`);

function upsertSomDevices(devices) {
  const save = db.transaction(() => {
    for (const d of devices) {
      upsertSomDeviceStmt.run(
        String(d.id || ''), d.model || null, d.typeDescription || null, d.category || null,
        typeof d.departmentId === 'number' ? d.departmentId : null,
        d.status || null, d.statusLabel || null, d.severity || null,
        d.event || null, d.lastOrder || null,
        d.counts?.count1 || 0, d.counts?.count2 || 0, d.counts?.count3 || 0,
        d.cycleTime || 0, d.isActive ? 1 : 0
      );
      // Log status changes to history
      const prevStatus = _lastDeviceStatus.get(d.id);
      if (prevStatus !== d.status) {
        insertSomDeviceHistoryStmt.run(d.id, d.status, d.statusLabel, d.severity, d.event);
        _lastDeviceStatus.set(d.id, d.status);
      }
    }
  });
  save();
}

function upsertSomConveyors(conveyors) {
  const save = db.transaction(() => {
    for (const c of conveyors) {
      upsertSomConveyorStmt.run(
        String(c.id || ''), c.status || null, c.statusLabel || null, c.severity || null,
        c.event || null, c.lastUpdate ? String(c.lastUpdate) : null
      );
    }
  });
  save();
}

// ─────────────────────────────────────────────────────────────────────────────
// OVEN & COATING RUNS (SQLite persistence alongside JSON files)
// ─────────────────────────────────────────────────────────────────────────────

const insertOvenRunStmt = db.prepare(`
  INSERT OR IGNORE INTO oven_runs (id, oven_id, oven_name, rack, rack_label, coating, target_secs, actual_secs, operator, received_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

function insertOvenRun(run) {
  if (!run || !run.id) return;
  insertOvenRunStmt.run(
    run.id, run.ovenId || null, run.ovenName || null,
    run.rack || null, run.rackLabel || null, run.coating || null,
    run.targetSecs || null, run.actualSecs || null,
    run.operator || null, run.receivedAt || Date.now()
  );
}

const insertCoatingRunStmt = db.prepare(`
  INSERT INTO coating_runs (coater_id, coater_name, started_at, stopped_at, target_sec, elapsed_sec, job_count, jobs_json, status)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

function insertCoatingRun(run) {
  if (!run) return;
  insertCoatingRunStmt.run(
    run.coaterId || null, run.coaterName || null,
    run.startedAt || null, run.stoppedAt || null,
    run.targetSec || null, run.elapsedSec || null,
    run.jobCount || 0, JSON.stringify(run.jobs || []),
    run.status || 'completed'
  );
}

function getOvenRuns(limit) {
  return db.prepare('SELECT * FROM oven_runs ORDER BY received_at DESC LIMIT ?').all(limit || 500);
}

function getCoatingRuns(limit) {
  return db.prepare('SELECT * FROM coating_runs ORDER BY started_at DESC LIMIT ?').all(limit || 500);
}

// ─────────────────────────────────────────────────────────────────────────────
// UNIFIED JOBS TABLE — single source of truth for all job data
// Every source enriches the same row: trace → XML → SOM → Looker
// ─────────────────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    -- Identity
    invoice TEXT PRIMARY KEY,
    reference TEXT,
    rx_number TEXT,
    som_order TEXT,
    tray TEXT,

    -- Lifecycle
    entry_date TEXT,
    entry_time TEXT,
    ship_date TEXT,
    ship_time TEXT,
    days_in_lab INTEGER,
    current_stage TEXT,
    current_station TEXT,
    current_station_num INTEGER,
    current_dept INTEGER,
    previous_dept INTEGER,
    status TEXT DEFAULT 'ACTIVE',
    job_type TEXT,
    rush TEXT DEFAULT 'N',

    -- Operator & Machine
    operator TEXT,
    machine_id TEXT,
    is_hko INTEGER DEFAULT 0,
    department TEXT,
    job_origin TEXT,

    -- Lens Rx - Right
    rx_r_sphere TEXT,
    rx_r_cylinder TEXT,
    rx_r_axis TEXT,
    rx_r_pd TEXT,
    rx_r_add TEXT,
    lens_opc_r TEXT,
    lens_pick_r TEXT,

    -- Lens Rx - Left
    rx_l_sphere TEXT,
    rx_l_cylinder TEXT,
    rx_l_axis TEXT,
    rx_l_pd TEXT,
    rx_l_add TEXT,
    lens_opc_l TEXT,
    lens_pick_l TEXT,

    -- Lens Common
    lens_style TEXT,
    lens_material TEXT,
    lens_type TEXT,
    lens_color TEXT,
    coating TEXT,
    coat_type TEXT,

    -- Frame
    frame_upc TEXT,
    frame_name TEXT,
    frame_style TEXT,
    frame_sku TEXT,
    frame_mfr TEXT,
    frame_color TEXT,
    eye_size TEXT,
    bridge TEXT,
    edge_type TEXT,

    -- SOM enrichment
    som_frame_no TEXT,
    som_frame_ref TEXT,
    som_lds TEXT,
    som_side TEXT,
    som_entry_date TEXT,

    -- Looker enrichment
    looker_job_id TEXT,
    dvi_destination TEXT,
    count_lenses INTEGER,
    count_breakages INTEGER,

    -- Trace state
    has_breakage INTEGER DEFAULT 0,
    first_seen_at TEXT,
    last_event_at TEXT,
    event_count INTEGER DEFAULT 0,
    events_json TEXT,

    -- System
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);

// Indices for hot query patterns
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_jobs_reference ON jobs(reference);
  CREATE INDEX IF NOT EXISTS idx_jobs_rx_number ON jobs(rx_number);
  CREATE INDEX IF NOT EXISTS idx_jobs_som_order ON jobs(som_order);
  CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
  CREATE INDEX IF NOT EXISTS idx_jobs_stage ON jobs(current_stage);
  CREATE INDEX IF NOT EXISTS idx_jobs_entry_date ON jobs(entry_date);
  CREATE INDEX IF NOT EXISTS idx_jobs_ship_date ON jobs(ship_date);
  CREATE INDEX IF NOT EXISTS idx_jobs_coating ON jobs(coating);
  CREATE INDEX IF NOT EXISTS idx_jobs_frame_upc ON jobs(frame_upc);
  CREATE INDEX IF NOT EXISTS idx_jobs_lens_opc_r ON jobs(lens_opc_r);
  CREATE INDEX IF NOT EXISTS idx_jobs_department ON jobs(department);
  CREATE INDEX IF NOT EXISTS idx_jobs_operator ON jobs(operator);
  CREATE INDEX IF NOT EXISTS idx_jobs_days_in_lab ON jobs(days_in_lab);
  CREATE INDEX IF NOT EXISTS idx_jobs_rush ON jobs(rush);
  CREATE INDEX IF NOT EXISTS idx_jobs_updated ON jobs(updated_at);
`);

// Append-only stage transition log — replaces events_json blob for queryable history
db.exec(`
  CREATE TABLE IF NOT EXISTS job_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice TEXT NOT NULL,
    station TEXT,
    station_num INTEGER,
    stage TEXT,
    operator TEXT,
    machine_id TEXT,
    event_time TEXT,
    event_ts INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_je_invoice ON job_events(invoice);
  CREATE INDEX IF NOT EXISTS idx_je_stage ON job_events(stage);
  CREATE INDEX IF NOT EXISTS idx_je_time ON job_events(event_ts);
  CREATE INDEX IF NOT EXISTS idx_je_operator ON job_events(operator);
`);

// ── Prepared statements for jobs table ──────────────────────────────────────

const upsertJobFromTraceStmt = db.prepare(`
  INSERT INTO jobs (invoice, tray, current_stage, current_station, current_station_num,
                    operator, machine_id, status, has_breakage, first_seen_at, last_event_at,
                    event_count, events_json, rush,
                    reference, rx_number, entry_date, entry_time, department, job_type,
                    is_hko, lens_type, lens_material, lens_style, lens_color, coating,
                    coat_type, lens_opc_r, lens_opc_l, frame_upc, frame_name, frame_style,
                    updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?,
          datetime('now'))
  ON CONFLICT(invoice) DO UPDATE SET
    tray = COALESCE(excluded.tray, jobs.tray),
    current_stage = excluded.current_stage,
    current_station = excluded.current_station,
    current_station_num = excluded.current_station_num,
    operator = COALESCE(excluded.operator, jobs.operator),
    machine_id = COALESCE(excluded.machine_id, jobs.machine_id),
    status = excluded.status,
    has_breakage = MAX(jobs.has_breakage, excluded.has_breakage),
    last_event_at = excluded.last_event_at,
    event_count = excluded.event_count,
    events_json = excluded.events_json,
    rush = CASE WHEN jobs.rush IS NULL OR jobs.rush = 'N' THEN COALESCE(excluded.rush, jobs.rush) ELSE jobs.rush END,
    reference = COALESCE(jobs.reference, excluded.reference),
    rx_number = COALESCE(jobs.rx_number, excluded.rx_number),
    entry_date = COALESCE(jobs.entry_date, excluded.entry_date),
    entry_time = COALESCE(jobs.entry_time, excluded.entry_time),
    department = COALESCE(jobs.department, excluded.department),
    job_type = COALESCE(jobs.job_type, excluded.job_type),
    is_hko = MAX(jobs.is_hko, excluded.is_hko),
    lens_type = COALESCE(jobs.lens_type, excluded.lens_type),
    lens_material = COALESCE(jobs.lens_material, excluded.lens_material),
    lens_style = COALESCE(jobs.lens_style, excluded.lens_style),
    lens_color = COALESCE(jobs.lens_color, excluded.lens_color),
    coating = COALESCE(jobs.coating, excluded.coating),
    coat_type = COALESCE(jobs.coat_type, excluded.coat_type),
    lens_opc_r = COALESCE(jobs.lens_opc_r, excluded.lens_opc_r),
    lens_opc_l = COALESCE(jobs.lens_opc_l, excluded.lens_opc_l),
    frame_upc = COALESCE(jobs.frame_upc, excluded.frame_upc),
    frame_name = COALESCE(jobs.frame_name, excluded.frame_name),
    frame_style = COALESCE(jobs.frame_style, excluded.frame_style),
    updated_at = datetime('now')
`);

function upsertJobFromTrace(j) {
  if (!j || !j.invoice) return;
  // Derive status from stage — stage is source of truth. Don't let stale 'ACTIVE'
  // from the caller outlive a CANCELED/SHIPPED stage transition.
  const stage = (j.stage || '').toUpperCase();
  let status = (j.status || 'ACTIVE').toUpperCase();
  if (stage === 'CANCELED') status = 'CANCELED';
  else if (stage === 'SHIPPED' || stage === 'COMPLETE') status = 'SHIPPED';
  upsertJobFromTraceStmt.run(
    j.invoice, j.tray || null, j.stage || null, j.station || null, j.stationNum || null,
    j.operator || null, j.machineId || null, status,
    j.hasBreakage ? 1 : 0, j.firstSeenAt || null, j.lastEventAt || null,
    j.eventCount || 0, j.eventsJson || null, j.rush || null,
    j.reference || null, j.rxNumber || null, j.entryDate || null, j.entryTime || null,
    j.department || null, j.jobType || null,
    j.isHko ? 1 : 0, j.lensType || null, j.lensMaterial || null, j.lensStyle || null,
    j.lensColor || null, j.coating || null,
    j.coatType || null, j.lensOpcR || null, j.lensOpcL || null, j.frameUpc || null,
    j.frameName || null, j.frameStyle || null
  );
}

const upsertJobFromXMLStmt = db.prepare(`
  INSERT INTO jobs (invoice, reference, rx_number, tray, entry_date, entry_time,
                    ship_date, ship_time, days_in_lab, department, job_type, operator,
                    job_origin, machine_id, is_hko, status,
                    lens_opc_r, lens_opc_l, lens_style, lens_material, lens_type,
                    lens_pick_r, lens_color, coating, coat_type,
                    frame_upc, frame_name, frame_style, frame_sku, frame_mfr, frame_color,
                    eye_size, bridge, edge_type,
                    rx_r_sphere, rx_r_cylinder, rx_r_axis, rx_r_pd, rx_r_add,
                    rx_l_sphere, rx_l_cylinder, rx_l_axis, rx_l_pd, rx_l_add,
                    updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SHIPPED',
          ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          datetime('now'))
  ON CONFLICT(invoice) DO UPDATE SET
    reference = COALESCE(excluded.reference, jobs.reference),
    rx_number = COALESCE(excluded.rx_number, jobs.rx_number),
    tray = COALESCE(excluded.tray, jobs.tray),
    entry_date = COALESCE(excluded.entry_date, jobs.entry_date),
    entry_time = COALESCE(excluded.entry_time, jobs.entry_time),
    ship_date = excluded.ship_date,
    ship_time = excluded.ship_time,
    days_in_lab = COALESCE(excluded.days_in_lab, jobs.days_in_lab),
    department = COALESCE(excluded.department, jobs.department),
    job_type = COALESCE(excluded.job_type, jobs.job_type),
    operator = COALESCE(excluded.operator, jobs.operator),
    job_origin = COALESCE(excluded.job_origin, jobs.job_origin),
    machine_id = COALESCE(excluded.machine_id, jobs.machine_id),
    is_hko = excluded.is_hko,
    status = CASE WHEN excluded.ship_date IS NOT NULL THEN 'SHIPPED' ELSE jobs.status END,
    lens_opc_r = COALESCE(excluded.lens_opc_r, jobs.lens_opc_r),
    lens_opc_l = COALESCE(excluded.lens_opc_l, jobs.lens_opc_l),
    lens_style = COALESCE(excluded.lens_style, jobs.lens_style),
    lens_material = COALESCE(excluded.lens_material, jobs.lens_material),
    lens_type = COALESCE(excluded.lens_type, jobs.lens_type),
    lens_pick_r = COALESCE(excluded.lens_pick_r, jobs.lens_pick_r),
    lens_color = COALESCE(excluded.lens_color, jobs.lens_color),
    coating = COALESCE(excluded.coating, jobs.coating),
    coat_type = COALESCE(excluded.coat_type, jobs.coat_type),
    frame_upc = COALESCE(excluded.frame_upc, jobs.frame_upc),
    frame_name = COALESCE(excluded.frame_name, jobs.frame_name),
    frame_style = COALESCE(excluded.frame_style, jobs.frame_style),
    frame_sku = COALESCE(excluded.frame_sku, jobs.frame_sku),
    frame_mfr = COALESCE(excluded.frame_mfr, jobs.frame_mfr),
    frame_color = COALESCE(excluded.frame_color, jobs.frame_color),
    eye_size = COALESCE(excluded.eye_size, jobs.eye_size),
    bridge = COALESCE(excluded.bridge, jobs.bridge),
    edge_type = COALESCE(excluded.edge_type, jobs.edge_type),
    rx_r_sphere = COALESCE(excluded.rx_r_sphere, jobs.rx_r_sphere),
    rx_r_cylinder = COALESCE(excluded.rx_r_cylinder, jobs.rx_r_cylinder),
    rx_r_axis = COALESCE(excluded.rx_r_axis, jobs.rx_r_axis),
    rx_r_pd = COALESCE(excluded.rx_r_pd, jobs.rx_r_pd),
    rx_r_add = COALESCE(excluded.rx_r_add, jobs.rx_r_add),
    rx_l_sphere = COALESCE(excluded.rx_l_sphere, jobs.rx_l_sphere),
    rx_l_cylinder = COALESCE(excluded.rx_l_cylinder, jobs.rx_l_cylinder),
    rx_l_axis = COALESCE(excluded.rx_l_axis, jobs.rx_l_axis),
    rx_l_pd = COALESCE(excluded.rx_l_pd, jobs.rx_l_pd),
    rx_l_add = COALESCE(excluded.rx_l_add, jobs.rx_l_add),
    updated_at = datetime('now')
`);

function upsertJobFromXML(p) {
  if (!p || !p.invoice) return;
  const rx = p.rx || {};
  const R = rx.R || {};
  const L = rx.L || {};
  upsertJobFromXMLStmt.run(
    p.invoice, p.reference || null, p.rxNum || null, p.tray || null,
    p.entryDate || null, p.entryTime || null, p.shipDate || null, p.shipTime || null,
    p.daysInLab || null, p.department || null, p.jobType || null, p.operator || null,
    p.jobOrigin || null, p.machineId || null, p.isHko ? 1 : 0,
    p.lensOpcR || null, p.lensOpcL || null, p.lensStyle || null, p.lensMaterial || null,
    p.lensType || null, p.lensPick || null, p.lensColor || null,
    p.coating || null, p.coatType || null,
    p.frameUpc || null, p.frameName || null, p.frameStyle || null, p.frameSku || null,
    p.frameMfr || null, p.frameColor || null,
    p.eyeSize || null, p.bridge || null, p.edgeType || null,
    R.sphere || null, R.cylinder || null, R.axis || null, R.pd || null, R.add || null,
    L.sphere || null, L.cylinder || null, L.axis || null, L.pd || null, L.add || null
  );
}

const upsertJobFromSOMStmt = db.prepare(`
  UPDATE jobs SET
    som_order = ?,
    current_dept = ?,
    previous_dept = ?,
    som_side = ?,
    som_entry_date = ?,
    som_frame_no = ?,
    som_frame_ref = ?,
    som_lds = ?,
    reference = COALESCE(?, jobs.reference),
    updated_at = datetime('now')
  WHERE invoice = ?
`);

function upsertJobFromSOM(j) {
  if (!j || !j.dviJob) return;
  upsertJobFromSOMStmt.run(
    j.somOrder || null, j.dept || null, j.prevDept || null,
    j.side || null, j.entryDate || null, j.frameNo || null,
    j.frameRef || null, j.lds || null, j.reference || null,
    j.dviJob
  );
}

const upsertJobFromLookerStmt = db.prepare(`
  UPDATE jobs SET
    looker_job_id = ?,
    dvi_destination = ?,
    count_lenses = ?,
    count_breakages = ?,
    updated_at = datetime('now')
  WHERE reference = ?
`);

function upsertJobFromLooker(j) {
  if (!j || !j.order_number) return;
  upsertJobFromLookerStmt.run(
    j.job_id || null, j.dvi_destination || null,
    j.count_lenses || 0, j.count_breakages || 0,
    j.order_number
  );
}

const insertJobEventStmt = db.prepare(`
  INSERT INTO job_events (invoice, station, station_num, stage, operator, machine_id, event_time, event_ts)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

function insertJobEvent(e) {
  if (!e || !e.invoice) return;
  insertJobEventStmt.run(
    e.invoice, e.station || null, e.stationNum || null, e.stage || null,
    e.operator || null, e.machineId || null, e.eventTime || null, e.eventTs || null
  );
}

// Bulk insert events inside a transaction for migration
const insertJobEventsBulk = db.transaction((events) => {
  for (const e of events) insertJobEvent(e);
});

// ── Query functions for unified jobs table ──────────────────────────────────

function getJob(invoice) {
  return db.prepare('SELECT * FROM jobs WHERE invoice = ?').get(invoice);
}

function getJobByReference(reference) {
  return db.prepare('SELECT * FROM jobs WHERE reference = ?').get(reference);
}

function queryJobsWip() {
  return db.prepare(`
    SELECT current_stage, status, rush, COUNT(*) as count,
           AVG(days_in_lab) as avg_days, MAX(days_in_lab) as max_days
    FROM jobs WHERE status IN ('ACTIVE','Active')
    GROUP BY current_stage
    ORDER BY count DESC
  `).all();
}

function queryJobsShipped(days) {
  return db.prepare(`
    SELECT * FROM jobs
    WHERE status = 'SHIPPED' AND ship_date >= date('now', '-' || ? || ' days')
    ORDER BY ship_date DESC, ship_time DESC
  `).all(days);
}

function queryJobsShippedStats(days) {
  return db.prepare(`
    SELECT ship_date, COUNT(*) as count, SUM(CASE WHEN rush='Y' THEN 1 ELSE 0 END) as rush_count,
           ROUND(AVG(days_in_lab), 1) as avg_days, SUM(CASE WHEN is_hko=1 THEN 1 ELSE 0 END) as hko_count
    FROM jobs
    WHERE status = 'SHIPPED' AND ship_date >= date('now', '-' || ? || ' days')
    GROUP BY ship_date ORDER BY ship_date DESC
  `).all(days);
}

function queryJobsAging(thresholdDays) {
  return db.prepare(`
    SELECT invoice, tray, current_stage, current_station, days_in_lab, entry_date,
           coating, rush, operator, lens_style, frame_name
    FROM jobs WHERE status IN ('ACTIVE','Active') AND days_in_lab >= ?
    ORDER BY days_in_lab DESC
  `).all(thresholdDays);
}

function queryJobsByCoating(coatingType) {
  return db.prepare(`
    SELECT invoice, tray, current_stage, days_in_lab, entry_date, rush, status
    FROM jobs WHERE coating = ? AND status IN ('ACTIVE','Active')
    ORDER BY days_in_lab DESC
  `).all(coatingType);
}

function queryJobEvents(invoice, limit) {
  return db.prepare(`
    SELECT * FROM job_events WHERE invoice = ? ORDER BY event_ts DESC LIMIT ?
  `).all(invoice, limit || 50);
}

function queryStageTimings(days) {
  return db.prepare(`
    SELECT stage, COUNT(*) as transitions,
           ROUND(AVG(duration_ms) / 60000, 1) as avg_minutes
    FROM (
      SELECT je1.invoice, je1.stage,
             (je2.event_ts - je1.event_ts) as duration_ms
      FROM job_events je1
      INNER JOIN job_events je2 ON je1.invoice = je2.invoice
        AND je2.id = (SELECT MIN(id) FROM job_events WHERE invoice = je1.invoice AND id > je1.id)
      WHERE je1.event_ts >= (strftime('%s','now') - ? * 86400) * 1000
    )
    GROUP BY stage ORDER BY avg_minutes DESC
  `).all(days);
}

function getJobsTableStats() {
  return db.prepare(`
    SELECT
      COUNT(*) as total_rows,
      SUM(CASE WHEN status IN ('ACTIVE','Active') THEN 1 ELSE 0 END) as active,
      SUM(CASE WHEN status='SHIPPED' THEN 1 ELSE 0 END) as shipped,
      MIN(entry_date) as oldest_entry,
      MAX(ship_date) as newest_ship,
      SUM(CASE WHEN reference IS NOT NULL THEN 1 ELSE 0 END) as has_reference,
      SUM(CASE WHEN som_order IS NOT NULL THEN 1 ELSE 0 END) as has_som,
      SUM(CASE WHEN looker_job_id IS NOT NULL THEN 1 ELSE 0 END) as has_looker
    FROM jobs
  `).get();
}

// ── Extended query functions for endpoint migration ──────────────────────────

/**
 * All active WIP jobs with full detail — replaces dviTrace.getJobsForKPI() + enrichment
 */
function queryJobsActiveWip() {
  return db.prepare(`
    SELECT invoice, reference, rx_number, tray, current_stage, current_station,
           current_station_num, status, rush, days_in_lab, entry_date, entry_time,
           operator, machine_id, coating, coat_type, lens_type, lens_style, lens_material,
           lens_color, frame_style, frame_sku, frame_mfr, frame_name, frame_upc,
           eye_size, bridge, edge_type, rx_number as rxNum, has_breakage,
           first_seen_at, last_event_at, event_count, events_json,
           department, job_type, is_hko,
           rx_r_sphere, rx_r_cylinder, rx_r_axis, rx_r_pd, rx_r_add,
           rx_l_sphere, rx_l_cylinder, rx_l_axis, rx_l_pd, rx_l_add
    FROM jobs
    WHERE status IN ('ACTIVE','Active')
    ORDER BY last_event_at DESC
  `).all();
}

/**
 * Shipped jobs for a given date range — replaces shippedJobIndex reads in /api/shipping/detail
 * Accepts an array of ISO date strings (YYYY-MM-DD)
 */
function queryJobsShippedByDates(dates) {
  if (!dates || dates.length === 0) return [];
  const placeholders = dates.map(() => '?').join(',');
  return db.prepare(`
    SELECT invoice, tray, coating, lens_type, lens_material, lens_style,
           frame_style, frame_sku, frame_name, department, days_in_lab,
           entry_date, ship_date, ship_time, rush, is_hko
    FROM jobs
    WHERE status = 'SHIPPED' AND ship_date IN (${placeholders})
    ORDER BY ship_date DESC, invoice ASC
  `).all(...dates);
}

/**
 * Shipped counts for today/yesterday/week — replaces getShippedCounts() in-memory
 */
function queryJobsShippedCounts(weekStartDate) {
  const rows = db.prepare(`
    SELECT ship_date, COUNT(*) as cnt, SUM(CASE WHEN is_hko=1 THEN 1 ELSE 0 END) as hko_cnt
    FROM jobs
    WHERE status = 'SHIPPED' AND ship_date >= ?
    GROUP BY ship_date
  `).all(weekStartDate);
  return rows;
}

/**
 * Full aging report with zone/SLA calculations — replaces /api/aging/jobs in-memory computation
 */
function queryJobsAgingFull() {
  // Double-filter: BOTH status AND current_stage. status should already be
  // 'CANCELED'/'SHIPPED' for those rows (per upsertJobFromTrace derivation and
  // the backfill-jobs-classification one-shot), but belt-and-suspenders — if
  // any stale row has status='ACTIVE' with current_stage='CANCELED' it still
  // gets filtered out of the aging dashboard.
  return db.prepare(`
    SELECT invoice, tray, current_stage, current_station, days_in_lab, entry_date,
           coating, rush, operator, lens_style, lens_type, frame_name, first_seen_at,
           status
    FROM jobs
    WHERE status IN ('ACTIVE','Active')
      AND (current_stage IS NULL OR current_stage NOT IN ('CANCELED','SHIPPED','COMPLETE'))
    ORDER BY days_in_lab DESC
  `).all();
}

/**
 * Daily shipped history — replaces /api/shipping/history dvi_shipped_jobs query
 */
function queryJobsShippedHistory(days) {
  return db.prepare(`
    SELECT ship_date, COUNT(*) as shipped,
           SUM(CASE WHEN rush='Y' THEN 1 ELSE 0 END) as rush_count
    FROM jobs
    WHERE status = 'SHIPPED' AND is_hko = 0 AND ship_date >= date('now', '-' || ? || ' days')
    GROUP BY ship_date
    ORDER BY ship_date DESC
  `).all(days);
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

// ── Production Daily Summary ─────────────────────────────────────────────────
const upsertProductionDailyStmt = db.prepare(`
  INSERT OR REPLACE INTO production_daily
  (date, label, dow, picked, incoming, surfacing, coating, cutting, assembly, shipping, hko,
   bottleneck_stage, bottleneck_rate, bottleneck_upstream_rate, hourly_json, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
`);

function upsertProductionDaily(day) {
  const t = day.totals || {};
  const bn = day.bottleneck;
  upsertProductionDailyStmt.run(
    day.date, day.label, day.dow,
    t.PICKING || 0, t.INCOMING || 0, t.SURFACING || 0, t.COATING || 0,
    t.CUTTING || 0, t.ASSEMBLY || 0, t.SHIPPING || 0, day.hko || 0,
    bn?.stage || null, bn?.avgRate || null, bn?.upstreamRate || null,
    day.hourly_json || null
  );
}

function getProductionDaily(days = 14) {
  return db.prepare(`
    SELECT date, label, dow, picked, incoming, surfacing, coating, cutting, assembly, shipping, hko,
           bottleneck_stage, bottleneck_rate, bottleneck_upstream_rate, hourly_json, updated_at
    FROM production_daily
    ORDER BY date DESC
    LIMIT ?
  `).all(days).map(row => ({
    date: row.date,
    label: row.label,
    dow: row.dow,
    totals: {
      PICKING: row.picked, INCOMING: row.incoming, SURFACING: row.surfacing,
      COATING: row.coating, CUTTING: row.cutting, ASSEMBLY: row.assembly, SHIPPING: row.shipping
    },
    hko: row.hko,
    bottleneck: row.bottleneck_stage ? {
      stage: row.bottleneck_stage,
      avgRate: row.bottleneck_rate,
      upstreamRate: row.bottleneck_upstream_rate
    } : null,
    updated_at: row.updated_at
  }));
}

// ── Hourly pick/put stats (DB-backed, replaces in-memory counters) ──────────
// picks_history has mixed `completed_at` formats:
//   - Suffixed (-07:00 / -08:00 / Z): SQLite parses as a UTC-anchored moment.
//     Use 'localtime' modifier to convert to the server's local TZ. Mac Studio
//     runs in America/Los_Angeles, so 'localtime' is PT and handles DST
//     automatically (was hardcoded -7 which breaks when PST kicks in Nov).
//   - Bare ISO (no suffix): already PT-local. strftime('%H') returns the
//     literal hour component without converting.
// CASE handles both. No more hardcoded offset → no more DST-flip bug.
//
// Lab day = 5 AM PT → 5 AM PT next day. Caller passes both bounds as ISO.
// Result shape: { WH1: {0..23: N}, WH2: {...}, WH3: {...} } — zeros omitted.

function _labHourFromCompletedAt() {
  return `CAST(
    CASE
      WHEN completed_at LIKE '%-0%' OR completed_at LIKE '%+0%' OR completed_at LIKE '%Z'
      THEN strftime('%H', datetime(completed_at, 'localtime'))
      ELSE strftime('%H', completed_at)
    END AS INTEGER
  )`;
}
function _labHourFromCreationDate() {
  return `CAST(
    CASE
      WHEN creation_date LIKE '%-0%' OR creation_date LIKE '%+0%' OR creation_date LIKE '%Z'
      THEN strftime('%H', datetime(creation_date, 'localtime'))
      ELSE strftime('%H', creation_date)
    END AS INTEGER
  )`;
}

let _hourlyCache = { at: 0, ttlMs: 30000, picks: null, puts: null, window: null };

function _emptyHourlyShape() {
  const wh = { WH1: {}, WH2: {}, WH3: {} };
  for (const w of Object.keys(wh)) for (let h = 0; h < 24; h++) wh[w][h] = 0;
  return wh;
}

function getHourlyPickStats(labDayStartUtcIso, labDayEndUtcIso) {
  const sql = `
    SELECT warehouse, ${_labHourFromCompletedAt()} AS hr, COUNT(*) AS n
    FROM picks_history
    WHERE completed_at IS NOT NULL
      AND warehouse IN ('WH1','WH2','WH3')
      AND datetime(completed_at) >= datetime(?)
      AND datetime(completed_at) <  datetime(?)
    GROUP BY warehouse, hr
  `;
  const rows = db.prepare(sql).all(labDayStartUtcIso, labDayEndUtcIso);
  const out = _emptyHourlyShape();
  for (const r of rows) if (r.hr !== null && out[r.warehouse]) out[r.warehouse][r.hr] = r.n;
  return out;
}

function getHourlyPutStats(labDayStartUtcIso, labDayEndUtcIso) {
  // Puts live in transactions table, type=3. Warehouse from warehouse_name
  // already normalized (may be blank or free-form — map to WH1/2/3).
  const sql = `
    SELECT warehouse_name AS wh, ${_labHourFromCreationDate()} AS hr, COUNT(*) AS n
    FROM transactions
    WHERE type = 3
      AND creation_date IS NOT NULL
      AND datetime(creation_date) >= datetime(?)
      AND datetime(creation_date) <  datetime(?)
    GROUP BY wh, hr
  `;
  const rows = db.prepare(sql).all(labDayStartUtcIso, labDayEndUtcIso);
  const out = _emptyHourlyShape();
  for (const r of rows) {
    const w = (r.wh || '').toUpperCase();
    let norm = null;
    if (/KITCHEN|WH3/.test(w)) norm = 'WH3';
    else if (/WH2/.test(w)) norm = 'WH2';
    else if (/WH1/.test(w)) norm = 'WH1';
    if (norm && r.hr !== null) out[norm][r.hr] = (out[norm][r.hr] || 0) + r.n;
  }
  return out;
}

function getHourlyStatsCached(labDayStartUtcIso, labDayEndUtcIso) {
  const key = labDayStartUtcIso + '|' + labDayEndUtcIso;
  const now = Date.now();
  if (_hourlyCache.window === key && (now - _hourlyCache.at) < _hourlyCache.ttlMs) {
    return { picks: _hourlyCache.picks, puts: _hourlyCache.puts, cached: true, ageMs: now - _hourlyCache.at };
  }
  const picks = getHourlyPickStats(labDayStartUtcIso, labDayEndUtcIso);
  let puts;
  try { puts = getHourlyPutStats(labDayStartUtcIso, labDayEndUtcIso); }
  catch { puts = _emptyHourlyShape(); } // transactions table may not have data yet
  _hourlyCache = { at: now, ttlMs: 30000, picks, puts, window: key };
  return { picks, puts, cached: false, ageMs: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// DELTA POLL CURSOR (2026-04-23 §3): per-type cursor persistence so the
// itempath-adapter delta-poll can resume after restart AND can advance past
// all-dupe ticks (where MAX(completed_at) doesn't move because every fetched
// row hit INSERT OR IGNORE).
// ─────────────────────────────────────────────────────────────────────────────
const _getDeltaCursorStmt = db.prepare(`SELECT cursor FROM delta_poll_cursor WHERE type = ?`);
const _setDeltaCursorStmt = db.prepare(`
  INSERT INTO delta_poll_cursor (type, cursor, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT(type) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at
`);
function getDeltaCursor(type) {
  try {
    const row = _getDeltaCursorStmt.get(type);
    return row && row.cursor ? row.cursor : null;
  } catch (e) {
    return null;
  }
}
function setDeltaCursor(type, isoString, ms) {
  if (!isoString) return;
  try {
    _setDeltaCursorStmt.run(type, isoString, ms || Date.now());
  } catch (e) {
    // non-fatal — next tick will try again
  }
}

// ── DVI Trace per-file byte offsets ─────────────────────────────────────────
// Cold-start uses these to tail-forward from the last successfully-processed
// byte rather than replaying the file. UPSERT, no transaction overhead.
const _getDviTraceOffsetStmt = db.prepare(
  `SELECT byte_offset FROM dvi_trace_offsets WHERE filename = ?`
);
const _setDviTraceOffsetStmt = db.prepare(`
  INSERT INTO dvi_trace_offsets (filename, byte_offset, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT(filename) DO UPDATE SET byte_offset = excluded.byte_offset, updated_at = excluded.updated_at
`);
function getDviTraceOffset(filename) {
  if (!filename) return null;
  try {
    const row = _getDviTraceOffsetStmt.get(filename);
    return row && Number.isFinite(row.byte_offset) ? row.byte_offset : null;
  } catch (e) {
    return null;
  }
}
function setDviTraceOffset(filename, offset) {
  if (!filename) return;
  const off = Number.isFinite(offset) ? offset : 0;
  try {
    _setDviTraceOffsetStmt.run(filename, off, Date.now());
  } catch (e) {
    // non-fatal — next poll will try again
  }
}

module.exports = {
  db,
  logSync,
  getLastSync,
  recordHeartbeat,
  recordHeartbeatError,
  getStaleHeartbeats,
  getSemifinishedSkus,
  getSkuProperties,
  getRxProfileTemplate,
  listRxProfileTemplates,
  listPlaceholders,
  createPlaceholder,
  mapPlaceholder,
  removePlaceholder,
  listQuarantineReceipts,
  receiveQuarantine,
  removeQuarantineReceipt,
  releaseQuarantineForPlaceholder,
  confirmQuarantineReconcile,
  listMaterialTargets,
  setMaterialTargets,
  getMaterialCategoryProjection,
  getModelFlag,
  setModelFlag,
  SEED_SEMIFINISHED,
  // Upsert functions (called by adapters)
  upsertInventory,
  upsertAlerts,
  upsertPicks,
  upsertPicksHistory,
  // Delta-poll cursor persistence (itempath-adapter)
  getDeltaCursor,
  setDeltaCursor,
  // DVI Trace per-file byte offset persistence (cold-start tail-forward)
  getDviTraceOffset,
  setDviTraceOffset,
  upsertTransactions,
  // DB-backed hourly stats (side-by-side with in-memory; see verify endpoint)
  getHourlyPickStats,
  getHourlyPutStats,
  getHourlyStatsCached,
  upsertAssets,
  upsertTasks,
  upsertParts,
  upsertDowntime,
  upsertSomDevices,
  upsertSomConveyors,
  insertOvenRun,
  insertCoatingRun,
  getOvenRuns,
  getCoatingRuns,
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
  queryConsumption,
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
  getAllAssemblyConfig,
  // DVI Shipped Jobs (XML ground truth)
  upsertShippedJob,
  // Production daily summary
  upsertProductionDaily,
  getProductionDaily,
  // Unified jobs table
  upsertJobFromTrace,
  upsertJobFromXML,
  upsertJobFromSOM,
  upsertJobFromLooker,
  insertJobEvent,
  insertJobEventsBulk,
  getJob,
  getJobByReference,
  queryJobsWip,
  queryJobsShipped,
  queryJobsShippedStats,
  queryJobsAging,
  queryJobsByCoating,
  queryJobEvents,
  queryStageTimings,
  getJobsTableStats,
  // Extended queries for endpoint migration
  queryJobsActiveWip,
  queryJobsShippedByDates,
  queryJobsShippedCounts,
  queryJobsAgingFull,
  queryJobsShippedHistory,
};
