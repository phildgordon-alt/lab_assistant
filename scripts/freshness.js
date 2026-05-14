#!/usr/bin/env node
// Phil 2026-05-14 — data freshness diagnostic.
//
// One command, one place. Shows the last event we saw from every data
// source so we can spot gaps after a server restart / outage.
//
// Usage:  node scripts/freshness.js
//
// Add new sources here as adapters are added — this is the single
// post-incident diagnostic. No more 9-different-backfill-scripts theater.

'use strict';

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.LAB_DB || path.join(__dirname, '..', 'data', 'lab_assistant.db');
const db = new Database(DB_PATH, { readonly: true });

// Each row: [label, SELECT that returns a single ISO/string timestamp, optional human-tier units]
// All queries return one row, one column = the last-seen timestamp (or NULL).
const SOURCES = [
  // DVI — file-based
  ['DVI TRACE events (job_events)',
   `SELECT datetime(MAX(event_ts)/1000,'unixepoch','localtime') FROM job_events`],
  ['DVI XML jobs (jobs.updated_at)',
   `SELECT MAX(updated_at) FROM jobs`],
  ['DVI SHIPLOG (dvi_shipped_jobs.recorded_at)',
   `SELECT MAX(recorded_at) FROM dvi_shipped_jobs`],
  ['DVI breakage events',
   `SELECT MAX(occurred_at) FROM breakage_events`],

  // Kardex / Power Pick
  ['Power Pick picks (picks_history.completed_at)',
   `SELECT MAX(completed_at) FROM picks_history`],

  // Tablets / operator events — received_at is unix ms
  ['Oven runs (oven_runs)',
   `SELECT datetime(MAX(received_at)/1000,'unixepoch','localtime') FROM oven_runs`],

  // SOM / Schneider
  ['SOM device status (som_devices.last_sync)',
   `SELECT MAX(last_sync) FROM som_devices`],

  // Looker historicals
  ['Looker last_sync (looker_jobs)',
   `SELECT MAX(last_sync) FROM looker_jobs`],

  // Lens inventory
  ['Lens inventory status (last computed)',
   `SELECT MAX(computed_at) FROM lens_inventory_status`],

  // Heartbeats — the meta layer; per-source breakdown
  ['Heartbeat: dvi_sync',
   `SELECT datetime(MAX(last_success_at)/1000,'unixepoch','localtime') FROM sync_heartbeats WHERE source='dvi_sync'`],
  ['Heartbeat: dvi_trace',
   `SELECT datetime(MAX(last_success_at)/1000,'unixepoch','localtime') FROM sync_heartbeats WHERE source='dvi_trace'`],
  ['Heartbeat: itempath',
   `SELECT datetime(MAX(last_success_at)/1000,'unixepoch','localtime') FROM sync_heartbeats WHERE source='itempath'`],
  ['Heartbeat: powerpick',
   `SELECT datetime(MAX(last_success_at)/1000,'unixepoch','localtime') FROM sync_heartbeats WHERE source='powerpick'`],
  ['Heartbeat: som',
   `SELECT datetime(MAX(last_success_at)/1000,'unixepoch','localtime') FROM sync_heartbeats WHERE source='som'`],
  ['Heartbeat: looker',
   `SELECT datetime(MAX(last_success_at)/1000,'unixepoch','localtime') FROM sync_heartbeats WHERE source='looker'`],
];

function ageString(iso) {
  if (!iso) return 'NEVER';
  // Accept both 'YYYY-MM-DD HH:MM:SS' and ISO; sqlite local-time format works with Date()
  const ts = new Date(iso.replace(' ', 'T')).getTime();
  if (Number.isNaN(ts)) return iso;
  const ageS = Math.floor((Date.now() - ts) / 1000);
  if (ageS < 0) return `${Math.abs(ageS)}s ahead?`;
  if (ageS < 90)        return `${ageS}s ago`;
  if (ageS < 90 * 60)   return `${Math.floor(ageS/60)}m ago`;
  if (ageS < 48 * 3600) return `${Math.floor(ageS/3600)}h ago`;
  return `${Math.floor(ageS/86400)}d ago`;
}

console.log('━'.repeat(72));
console.log(`Lab_Assistant data freshness — ${new Date().toLocaleString()}`);
console.log(`db: ${DB_PATH}`);
console.log('━'.repeat(72));

const rows = [];
for (const [label, query] of SOURCES) {
  try {
    const r = db.prepare(query).get();
    const ts = r ? Object.values(r)[0] : null;
    rows.push([label, ts || 'NEVER', ageString(ts)]);
  } catch (e) {
    rows.push([label, '—', `(error: ${e.message})`]);
  }
}

// Print as a table — fixed widths so it stays readable in plain terminals.
const w1 = Math.max(...rows.map(r => r[0].length), 'Source'.length);
const w2 = Math.max(...rows.map(r => String(r[1]).length), 'Last seen'.length);
const fmt = (a, b, c) => `${String(a).padEnd(w1)}  ${String(b).padEnd(w2)}  ${c}`;
console.log(fmt('Source', 'Last seen', 'Age'));
console.log('─'.repeat(w1 + w2 + 12));
for (const r of rows) console.log(fmt(r[0], r[1], r[2]));
console.log('━'.repeat(72));
