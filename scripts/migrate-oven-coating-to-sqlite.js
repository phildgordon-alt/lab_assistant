#!/usr/bin/env node
/**
 * migrate-oven-coating-to-sqlite.js
 *
 * One-time migration: backfills oven_runs and coating_runs tables
 * from existing JSON files. Safe to run multiple times (INSERT OR IGNORE).
 */

'use strict';

const db = require('../server/db');
const fs = require('fs');
const path = require('path');

console.log('[migrate] Backfilling oven/coating runs from JSON → SQLite...');

// ── Oven runs ───────────────────────────────────────────────────
const ovenFile = path.join(__dirname, '..', 'server', 'oven-runs.json');
let ovenCount = 0;
try {
  if (fs.existsSync(ovenFile)) {
    const runs = JSON.parse(fs.readFileSync(ovenFile, 'utf8'));
    console.log(`[migrate] Found ${runs.length} oven runs in JSON`);
    for (const run of runs) {
      try { db.insertOvenRun(run); ovenCount++; } catch (e) { /* dupe — ignore */ }
    }
  } else {
    console.log('[migrate] No oven-runs.json found — skipping');
  }
} catch (e) { console.error('[migrate] Oven runs error:', e.message); }

// ── Coating runs ────────────────────────────────────────────────
const coatingFile = path.join(__dirname, '..', 'data', 'coating-runs.json');
let coatingCount = 0;
try {
  if (fs.existsSync(coatingFile)) {
    const runs = JSON.parse(fs.readFileSync(coatingFile, 'utf8'));
    console.log(`[migrate] Found ${runs.length} coating runs in JSON`);
    for (const run of runs) {
      try { db.insertCoatingRun(run); coatingCount++; } catch (e) { /* dupe — ignore */ }
    }
  } else {
    console.log('[migrate] No coating-runs.json found — skipping');
  }
} catch (e) { console.error('[migrate] Coating runs error:', e.message); }

console.log(`[migrate] Done: ${ovenCount} oven runs, ${coatingCount} coating runs → SQLite`);

// Verify
const ovenRows = db.db.prepare('SELECT COUNT(*) as n FROM oven_runs').get();
const coatingRows = db.db.prepare('SELECT COUNT(*) as n FROM coating_runs').get();
console.log(`[migrate] SQLite totals: oven_runs=${ovenRows.n}, coating_runs=${coatingRows.n}`);
