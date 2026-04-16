#!/usr/bin/env node
/**
 * migrate-to-unified-jobs.js
 *
 * One-time migration: populates the unified `jobs` table from existing tables.
 * Order matters — richest source first, then progressively enrich:
 *   1. dvi_shipped_jobs  (43 cols, shipped history — the baseline)
 *   2. dvi_jobs           (active WIP — stage, station, status)
 *   3. dvi_trace_jobs     (trace state — events, first_seen, last_event)
 *   4. looker_jobs        (Looker — count_lenses, count_breakages, destination)
 *   5. job_events         (normalize events_json from dvi_trace_jobs)
 *
 * Safe to run multiple times — all writes are INSERT OR IGNORE / UPDATE.
 * Does NOT modify or delete any existing tables.
 */

'use strict';

const db = require('../server/db');
const rawDb = db.db;

const start = Date.now();
let stats = { shipped: 0, wip: 0, trace: 0, looker: 0, events: 0, errors: 0 };

console.log('[migrate] Starting unified jobs table migration...');
console.log('[migrate] Current jobs table:', db.getJobsTableStats());

// ── Step 1: dvi_shipped_jobs → jobs (baseline, richest source) ──────────────
console.log('\n[migrate] Step 1: dvi_shipped_jobs → jobs ...');

const shippedRows = rawDb.prepare('SELECT COUNT(*) as n FROM dvi_shipped_jobs').get();
console.log(`[migrate]   Source rows: ${shippedRows.n}`);

const insertFromShipped = rawDb.prepare(`
  INSERT OR IGNORE INTO jobs (
    invoice, reference, rx_number, tray,
    entry_date, entry_time, ship_date, ship_time, days_in_lab,
    department, job_type, operator, job_origin, machine_id, is_hko, status,
    lens_opc_r, lens_opc_l, lens_style, lens_material, lens_type, lens_pick_r, lens_color,
    coating, coat_type,
    frame_upc, frame_name, frame_style, frame_sku, frame_mfr, frame_color,
    eye_size, bridge, edge_type,
    rx_r_sphere, rx_r_cylinder, rx_r_axis, rx_r_pd, rx_r_add,
    rx_l_sphere, rx_l_cylinder, rx_l_axis, rx_l_pd, rx_l_add,
    created_at, updated_at
  )
  SELECT
    invoice, reference, rx_number, tray,
    entry_date, entry_time, ship_date, ship_time, days_in_lab,
    department, job_type, operator, job_origin, machine_id, is_hko,
    CASE WHEN ship_date IS NOT NULL THEN 'SHIPPED' ELSE 'ACTIVE' END,
    lens_opc_r, lens_opc_l, lens_style, lens_material, lens_type, lens_pick, lens_color,
    coating, coat_type,
    frame_upc, frame_name, frame_style, frame_sku, frame_mfr, frame_color,
    eye_size, bridge, edge_type,
    rx_r_sphere, rx_r_cylinder, rx_r_axis, rx_r_pd, rx_r_add,
    rx_l_sphere, rx_l_cylinder, rx_l_axis, rx_l_pd, rx_l_add,
    recorded_at, recorded_at
  FROM dvi_shipped_jobs
`);

const shippedResult = insertFromShipped.run();
stats.shipped = shippedResult.changes;
console.log(`[migrate]   Inserted: ${stats.shipped} rows`);

// ── Step 2: dvi_jobs → jobs (active WIP enrichment) ─────────────────────────
console.log('\n[migrate] Step 2: dvi_jobs → jobs (active WIP) ...');

const wipRows = rawDb.prepare('SELECT COUNT(*) as n FROM dvi_jobs WHERE archived = 0').get();
console.log(`[migrate]   Source rows: ${wipRows.n}`);

// First INSERT any WIP jobs not already in jobs table (they may not have shipped XML)
const insertFromWip = rawDb.prepare(`
  INSERT OR IGNORE INTO jobs (
    invoice, tray, current_stage, current_station, status, rush,
    entry_date, days_in_lab, coating, frame_name,
    created_at, updated_at
  )
  SELECT
    COALESCE(invoice, id), tray, stage, station,
    CASE WHEN archived = 1 THEN 'SHIPPED' ELSE 'ACTIVE' END,
    rush, entry_date, days_in_lab, coating, frame_name,
    datetime('now'), datetime('now')
  FROM dvi_jobs
`);
const wipInserted = insertFromWip.run();

// Then UPDATE existing rows with current stage/station/status
const updateFromWip = rawDb.prepare(`
  UPDATE jobs SET
    current_stage = dj.stage,
    current_station = dj.station,
    status = CASE WHEN dj.archived = 1 THEN jobs.status ELSE 'ACTIVE' END,
    rush = COALESCE(dj.rush, jobs.rush),
    days_in_lab = COALESCE(dj.days_in_lab, jobs.days_in_lab),
    updated_at = datetime('now')
  FROM dvi_jobs dj
  WHERE jobs.invoice = COALESCE(dj.invoice, dj.id)
    AND dj.archived = 0
`);
const wipUpdated = updateFromWip.run();
stats.wip = wipInserted.changes + wipUpdated.changes;
console.log(`[migrate]   Inserted: ${wipInserted.changes}, Updated: ${wipUpdated.changes}`);

// ── Step 3: dvi_trace_jobs → jobs (trace enrichment) ────────────────────────
console.log('\n[migrate] Step 3: dvi_trace_jobs → jobs (trace state) ...');

const traceRows = rawDb.prepare('SELECT COUNT(*) as n FROM dvi_trace_jobs').get();
console.log(`[migrate]   Source rows: ${traceRows.n}`);

// INSERT any trace jobs not already in jobs (edge case: trace saw it but no XML/WIP record)
const insertFromTrace = rawDb.prepare(`
  INSERT OR IGNORE INTO jobs (
    invoice, tray, current_stage, current_station, current_station_num,
    operator, machine_id, status, has_breakage,
    first_seen_at, last_event_at, event_count, events_json,
    created_at, updated_at
  )
  SELECT
    job_id, tray, stage, station, station_num,
    operator, machine_id, status, has_breakage,
    datetime(first_seen_ms / 1000, 'unixepoch'),
    datetime(last_seen_ms / 1000, 'unixepoch'),
    event_count, events_json,
    datetime('now'), datetime('now')
  FROM dvi_trace_jobs
`);
const traceInserted = insertFromTrace.run();

// UPDATE existing rows with trace fields
const updateFromTrace = rawDb.prepare(`
  UPDATE jobs SET
    current_stage = COALESCE(dtj.stage, jobs.current_stage),
    current_station = COALESCE(dtj.station, jobs.current_station),
    current_station_num = dtj.station_num,
    has_breakage = MAX(COALESCE(jobs.has_breakage, 0), COALESCE(dtj.has_breakage, 0)),
    first_seen_at = COALESCE(datetime(dtj.first_seen_ms / 1000, 'unixepoch'), jobs.first_seen_at),
    last_event_at = COALESCE(datetime(dtj.last_seen_ms / 1000, 'unixepoch'), jobs.last_event_at),
    event_count = COALESCE(dtj.event_count, jobs.event_count),
    events_json = COALESCE(dtj.events_json, jobs.events_json),
    updated_at = datetime('now')
  FROM dvi_trace_jobs dtj
  WHERE jobs.invoice = dtj.job_id
`);
const traceUpdated = updateFromTrace.run();
stats.trace = traceInserted.changes + traceUpdated.changes;
console.log(`[migrate]   Inserted: ${traceInserted.changes}, Updated: ${traceUpdated.changes}`);

// ── Step 4: looker_jobs → jobs (Looker enrichment) ──────────────────────────
console.log('\n[migrate] Step 4: looker_jobs → jobs (Looker enrichment) ...');

const lookerRows = rawDb.prepare('SELECT COUNT(*) as n FROM looker_jobs').get();
console.log(`[migrate]   Source rows: ${lookerRows.n}`);

// Looker joins on reference = order_number
// Aggregate per order_number since looker_jobs can have multiple rows per job (one per OPC)
const updateFromLooker = rawDb.prepare(`
  UPDATE jobs SET
    looker_job_id = lj.job_id,
    dvi_destination = lj.dvi_destination,
    count_lenses = lj.total_lenses,
    count_breakages = lj.total_breakages,
    updated_at = datetime('now')
  FROM (
    SELECT order_number, MIN(job_id) as job_id, MIN(dvi_destination) as dvi_destination,
           SUM(count_lenses) as total_lenses, SUM(count_breakages) as total_breakages
    FROM looker_jobs
    WHERE order_number IS NOT NULL
    GROUP BY order_number
  ) lj
  WHERE jobs.reference = lj.order_number
`);
const lookerUpdated = updateFromLooker.run();
stats.looker = lookerUpdated.changes;
console.log(`[migrate]   Updated: ${stats.looker}`);

// ── Step 5: Normalize events_json → job_events ─────────────────────────────
console.log('\n[migrate] Step 5: events_json → job_events (normalize) ...');

const traceJobsWithEvents = rawDb.prepare(`
  SELECT job_id, events_json FROM dvi_trace_jobs WHERE events_json IS NOT NULL
`).all();

let eventCount = 0;
let eventErrors = 0;

const insertEventBatch = rawDb.transaction((batch) => {
  const stmt = rawDb.prepare(`
    INSERT OR IGNORE INTO job_events (invoice, station, station_num, stage, operator, machine_id, event_time, event_ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const e of batch) {
    stmt.run(e.invoice, e.station, e.stationNum, e.stage, e.operator, e.machineId, e.eventTime, e.eventTs);
  }
});

const BATCH_SIZE = 1000;
let batch = [];

for (const row of traceJobsWithEvents) {
  try {
    const events = JSON.parse(row.events_json);
    if (!Array.isArray(events)) continue;
    for (const evt of events) {
      batch.push({
        invoice: row.job_id,
        station: evt.station || null,
        stationNum: evt.station_num || null,
        stage: evt.stage || null,
        operator: evt.operator || null,
        machineId: evt.machine_id || null,
        eventTime: evt.time || null,
        eventTs: evt.timestamp || null,
      });
      eventCount++;
      if (batch.length >= BATCH_SIZE) {
        insertEventBatch(batch);
        batch = [];
      }
    }
  } catch (e) {
    eventErrors++;
  }
}
if (batch.length > 0) insertEventBatch(batch);

stats.events = eventCount;
stats.errors = eventErrors;
console.log(`[migrate]   Events inserted: ${eventCount} (parse errors: ${eventErrors})`);

// ── Summary ─────────────────────────────────────────────────────────────────
const elapsed = ((Date.now() - start) / 1000).toFixed(1);
const finalStats = db.getJobsTableStats();

console.log('\n[migrate] ═══════════════════════════════════════════════════');
console.log(`[migrate] Migration complete in ${elapsed}s`);
console.log(`[migrate]   Shipped XML → jobs:  ${stats.shipped}`);
console.log(`[migrate]   Active WIP → jobs:   ${stats.wip}`);
console.log(`[migrate]   Trace → jobs:        ${stats.trace}`);
console.log(`[migrate]   Looker → jobs:       ${stats.looker}`);
console.log(`[migrate]   Events normalized:   ${stats.events}`);
console.log(`[migrate]   Parse errors:        ${stats.errors}`);
console.log('[migrate] Final jobs table stats:', JSON.stringify(finalStats, null, 2));
console.log('[migrate] ═══════════════════════════════════════════════════');

const eventsCount = rawDb.prepare('SELECT COUNT(*) as n FROM job_events').get();
console.log(`[migrate] job_events table: ${eventsCount.n} rows`);
