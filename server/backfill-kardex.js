#!/usr/bin/env node
/**
 * One-time backfill: Load Kardex YTD transactions (before March 6)
 * into picks_history from CSV export.
 *
 * Usage: node server/backfill-kardex.js /path/to/Itempath_Transactions_2026_YTD.csv
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const csvPath = process.argv[2];
if (!csvPath || !fs.existsSync(csvPath)) {
  console.error('Usage: node server/backfill-kardex.js <csv-file>');
  process.exit(1);
}

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'lab_assistant.db');
const db = new Database(DB_FILE);

// Parse CSV
const content = fs.readFileSync(csvPath, 'utf-8');
const lines = content.split('\n');
const headers = lines[0].split(',');
const typeIdx = headers.indexOf('TYPE');
const skuIdx = headers.indexOf('MATERIALNAME');
const dateIdx = headers.indexOf('CREATIONDATE');
const qtyIdx = headers.indexOf('QUANTITYCONFIRMED');
const reqIdx = headers.indexOf('QUANTITYREQUESTED');

console.log(`Parsing ${lines.length - 1} rows...`);

// Aggregate picks (type=4) before March 6
const agg = {};
let parsed = 0;
for (let i = 1; i < lines.length; i++) {
  const cols = lines[i].split(',');
  if (cols[typeIdx] !== '4') continue;
  const sku = cols[skuIdx] || '';
  const date = (cols[dateIdx] || '').slice(0, 10);
  let qty = parseInt(cols[qtyIdx]) || 0;
  if (qty <= 0) qty = parseInt(cols[reqIdx]) || 0;
  if (!sku || !date || qty <= 0) continue;
  if (date >= '2026-03-06') continue; // live data starts March 6
  const key = `${date}|${sku}`;
  if (!agg[key]) agg[key] = { date, sku, qty: 0, picks: 0 };
  agg[key].qty += qty;
  agg[key].picks++;
  parsed++;
}

const entries = Object.values(agg);
const total = entries.reduce((s, e) => s + e.qty, 0);
console.log(`Aggregated: ${entries.length} date+sku combos, ${total.toLocaleString()} total qty (from ${parsed.toLocaleString()} pick lines)`);

// Insert into picks_history
const insert = db.prepare(`
  INSERT OR IGNORE INTO picks_history (pick_id, order_id, sku, name, qty, picked, warehouse, completed_at, recorded_at)
  VALUES (?, 'backfill', ?, ?, ?, ?, '', ? || ' 12:00:00', datetime('now'))
`);

const run = db.transaction(() => {
  let inserted = 0;
  for (const e of entries) {
    const id = `backfill-${e.date}-${e.sku}`;
    const result = insert.run(id, e.sku, e.sku, e.qty, e.qty, e.date);
    inserted += result.changes;
  }
  return inserted;
});

const inserted = run();
console.log(`Inserted: ${inserted} rows into picks_history`);

const row = db.prepare('SELECT COUNT(*) as cnt, SUM(qty) as total FROM picks_history').get();
console.log(`Total picks_history: ${row.cnt} rows, ${row.total.toLocaleString()} qty`);

db.close();
console.log('Done.');
