/**
 * looker-adapter.js — Looker API Integration (Job-Level)
 *
 * Single source of truth for all NetSuite/DVI data from Looker.
 * Pulls individual job records with: job_id, order_number, dvi_id,
 * frame_upc, lens_opc, count_lenses, breakages, sent_from_lab_date.
 *
 * All tabs (Consumption, Pipeline, Transactions) derive from this data.
 *
 * AUTH: OAuth2 Client Credentials (API key pair)
 * ENV: LOOKER_URL, LOOKER_CLIENT_ID, LOOKER_CLIENT_SECRET
 */

'use strict';

const CONFIG = {
  baseUrl:       process.env.LOOKER_URL || '',
  clientId:      process.env.LOOKER_CLIENT_ID || '',
  clientSecret:  process.env.LOOKER_CLIENT_SECRET || '',
  apiPort:       19999,
  pollInterval:  parseInt(process.env.LOOKER_POLL_MS || '300000'), // 5 min
};

let accessToken = null;
let tokenExpiry = 0;
let cache = {
  daily: [],       // derived: [{ date, lenses, breakages, byOpc }]
  frames: [],      // derived: [{ date, frames, byUpc }]
  lastSync: null,
  error: null,
};
let pollTimer = null;

// ─────────────────────────────────────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────────────────────────────────────
async function getToken() {
  if (accessToken && Date.now() < tokenExpiry - 60000) return accessToken;
  const fetch = (await import('node-fetch')).default;
  const resp = await fetch(`${CONFIG.baseUrl}:${CONFIG.apiPort}/api/4.0/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `client_id=${CONFIG.clientId}&client_secret=${CONFIG.clientSecret}`,
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) throw new Error(`Looker login failed: ${resp.status}`);
  const data = await resp.json();
  accessToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in * 1000);
  console.log('[Looker] Authenticated, token expires in', data.expires_in, 's');
  return accessToken;
}

// ─────────────────────────────────────────────────────────────────────────────
// API CALLS
// ─────────────────────────────────────────────────────────────────────────────
async function runQuery(fields, filters, sorts, limit = 5000) {
  const fetch = (await import('node-fetch')).default;
  const token = await getToken();
  const resp = await fetch(`${CONFIG.baseUrl}:${CONFIG.apiPort}/api/4.0/queries/run/json`, {
    method: 'POST',
    headers: { 'Authorization': `token ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'operations', view: 'poms_jobs', fields, filters, sorts, limit }),
    signal: AbortSignal.timeout(60000),
  });
  if (!resp.ok) throw new Error(`Looker query failed: ${resp.status}`);
  return resp.json();
}

// ─────────────────────────────────────────────────────────────────────────────
// FETCH JOB-LEVEL DATA (single query — replaces fetchUsage + fetchFrameUsage)
// ─────────────────────────────────────────────────────────────────────────────
async function fetchJobs() {
  const year = new Date().getFullYear();
  const rows = await runQuery(
    [
      'poms_jobs.job_id',
      'poms_jobs.order_number',
      'poms_jobs.dvi_id',
      'dvi_jobs.sent_from_lab_date',
      'dvi_jobs.dvi_destination',
      'dvi_jobs.frame_upc',
      'dvi_job_lenses.opc',
      'dvi_job_lenses.count_lenses',
      'item_breakages.count_breakages',
    ],
    {
      'dvi_jobs.sent_from_lab_date': `${year}-01-01 to today`,
    },
    ['dvi_jobs.sent_from_lab_date desc', 'poms_jobs.job_id'],
    500000
  );
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// REBUILD CACHE — derive lens/frame aggregations from raw job rows
// Keeps getUsage() and getFrameUsage() return shapes identical for compatibility
// ─────────────────────────────────────────────────────────────────────────────
function rebuildCache(rows) {
  // Filter OUT HKO for consumption — HKO jobs don't consume from the Irvine lab
  const pairRows = rows.filter(r => (r['dvi_jobs.dvi_destination'] || r.dvi_destination || 'PAIR') !== 'HKO');

  // Lens usage by date — PAIR only (same shape as old fetchUsage)
  const byDate = {};
  for (const r of pairRows) {
    const date = r['dvi_jobs.sent_from_lab_date'] || r.sent_from_lab_date;
    const opc = r['dvi_job_lenses.opc'] || r.opc || '';
    const lenses = r['dvi_job_lenses.count_lenses'] || r.count_lenses || 0;
    const breakages = r['item_breakages.count_breakages'] || r.count_breakages || 0;
    if (!date) continue;
    if (!byDate[date]) byDate[date] = { date, lenses: 0, breakages: 0, byOpc: {} };
    byDate[date].lenses += lenses;
    byDate[date].breakages += breakages;
    if (opc) {
      if (!byDate[date].byOpc[opc]) byDate[date].byOpc[opc] = { lenses: 0, breakages: 0 };
      byDate[date].byOpc[opc].lenses += lenses;
      byDate[date].byOpc[opc].breakages += breakages;
    }
  }
  cache.daily = Object.values(byDate).sort((a, b) => b.date.localeCompare(a.date));

  // Frame usage by date — PAIR only
  const jobsByDateUpc = {};
  for (const r of pairRows) {
    const date = r['dvi_jobs.sent_from_lab_date'] || r.sent_from_lab_date;
    const upc = r['dvi_jobs.frame_upc'] || r.frame_upc || '';
    const jobId = r['poms_jobs.job_id'] || r.job_id || '';
    if (!date || !upc || !jobId) continue;
    if (!jobsByDateUpc[date]) jobsByDateUpc[date] = {};
    if (!jobsByDateUpc[date][upc]) jobsByDateUpc[date][upc] = new Set();
    jobsByDateUpc[date][upc].add(jobId);
  }
  const frameByDate = {};
  for (const [date, upcs] of Object.entries(jobsByDateUpc)) {
    frameByDate[date] = { date, frames: 0, byUpc: {} };
    for (const [upc, jobSet] of Object.entries(upcs)) {
      const count = jobSet.size;
      frameByDate[date].frames += count;
      frameByDate[date].byUpc[upc] = count;
    }
  }
  cache.frames = Object.values(frameByDate).sort((a, b) => b.date.localeCompare(a.date));
}

// ─────────────────────────────────────────────────────────────────────────────
// POLL — fetch from Looker API, save to SQLite, rebuild cache
// ─────────────────────────────────────────────────────────────────────────────
async function poll() {
  const db = require('./db');
  try {
    const rows = await fetchJobs();
    console.log(`[Looker] Fetched ${rows.length} job-lens rows from API`);

    // Save to SQLite
    const del = db.db.prepare('DELETE FROM looker_jobs');
    const ins = db.db.prepare(`INSERT OR REPLACE INTO looker_jobs
      (job_id, order_number, dvi_id, sent_from_lab_date, dvi_destination, frame_upc, opc, count_lenses, count_breakages)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const save = db.db.transaction(() => {
      del.run();
      for (const r of rows) {
        ins.run(
          r['poms_jobs.job_id'] || '',
          r['poms_jobs.order_number'] || '',
          r['poms_jobs.dvi_id'] || '',
          r['dvi_jobs.sent_from_lab_date'] || '',
          r['dvi_jobs.dvi_destination'] || 'PAIR',
          r['dvi_jobs.frame_upc'] || '',
          r['dvi_job_lenses.opc'] || '',
          r['dvi_job_lenses.count_lenses'] || 0,
          r['item_breakages.count_breakages'] || 0,
        );
      }
    });
    save();

    rebuildCache(rows);
    cache.lastSync = new Date().toISOString();
    cache.error = null;
    console.log(`[Looker] Synced ${rows.length} rows → SQLite, ${cache.daily.length} days, ${cache.frames.length} frame days`);
  } catch (e) {
    cache.error = e.message;
    console.error('[Looker] Poll error:', e.message);
  }
}

// Load from SQLite on startup
function loadFromSQLite() {
  try {
    const db = require('./db');
    const rows = db.db.prepare('SELECT * FROM looker_jobs').all();
    if (rows.length > 0) {
      rebuildCache(rows);
      cache.lastSync = 'sqlite';
      console.log(`[Looker] Loaded ${rows.length} job-lens rows from SQLite`);
    }
  } catch (e) {
    console.error('[Looker] SQLite load error:', e.message);
  }
}

function start() {
  loadFromSQLite();
  if (!CONFIG.clientId || !CONFIG.clientSecret || !CONFIG.baseUrl) {
    console.log('[Looker] No credentials configured — serving from SQLite only');
    return;
  }
  console.log('[Looker] Starting — polling every', CONFIG.pollInterval / 1000, 's');
  setTimeout(() => poll(), 10000);
  pollTimer = setInterval(() => poll(), CONFIG.pollInterval);
}

function stop() {
  if (pollTimer) clearInterval(pollTimer);
}

// ─────────────────────────────────────────────────────────────────────────────
// GETTERS — same return shapes for compatibility with existing endpoints
// ─────────────────────────────────────────────────────────────────────────────
function getUsage(days = 30) {
  const daily = cache.daily.slice(0, days);
  const totalLenses = daily.reduce((s, d) => s + d.lenses, 0);
  const totalBreakages = daily.reduce((s, d) => s + d.breakages, 0);
  const avg = daily.length > 0 ? Math.round(totalLenses / daily.length) : 0;
  return {
    daily, totalLenses, totalBreakages,
    breakageRate: totalLenses > 0 ? Math.round((totalBreakages / totalLenses) * 1000) / 10 : 0,
    avgDaily: avg, dayCount: daily.length, lastSync: cache.lastSync, error: cache.error,
  };
}

function getTopOPCs(days = 30, limit = 20) {
  const daily = cache.daily.slice(0, days);
  const opcTotals = {};
  for (const d of daily) {
    for (const [opc, v] of Object.entries(d.byOpc || {})) {
      if (!opcTotals[opc]) opcTotals[opc] = { opc, lenses: 0, breakages: 0 };
      opcTotals[opc].lenses += v.lenses;
      opcTotals[opc].breakages += v.breakages;
    }
  }
  return Object.values(opcTotals)
    .sort((a, b) => b.lenses - a.lenses)
    .slice(0, limit)
    .map(o => ({ ...o, breakageRate: o.lenses > 0 ? Math.round((o.breakages / o.lenses) * 1000) / 10 : 0 }));
}

function getFrameUsage() {
  const daily = cache.frames || [];
  const totalFrames = daily.reduce((s, d) => s + d.frames, 0);
  const upcTotals = {};
  for (const d of daily) {
    for (const [upc, count] of Object.entries(d.byUpc || {})) {
      upcTotals[upc] = (upcTotals[upc] || 0) + count;
    }
  }
  return {
    daily, totalFrames, dayCount: daily.length, upcCount: Object.keys(upcTotals).length,
    topUPCs: Object.entries(upcTotals).map(([upc, count]) => ({ upc, count })).sort((a, b) => b.count - a.count).slice(0, 50),
    lastSync: cache.lastSync,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// NEW: Job-level getters (for Pipeline comparison + direct access)
// ─────────────────────────────────────────────────────────────────────────────
function getJobs(from, to) {
  const db = require('./db');
  return db.db.prepare(
    'SELECT * FROM looker_jobs WHERE sent_from_lab_date >= ? AND sent_from_lab_date <= ? ORDER BY sent_from_lab_date DESC, job_id'
  ).all(from, to);
}

function getJobsByOrder(orderNumber) {
  const db = require('./db');
  return db.db.prepare('SELECT * FROM looker_jobs WHERE order_number = ? ORDER BY job_id').all(orderNumber);
}

function getJobCountByDay(days = 30) {
  const db = require('./db');
  return db.db.prepare(`
    SELECT sent_from_lab_date as date,
           COUNT(DISTINCT job_id) as jobs,
           COUNT(DISTINCT CASE WHEN dvi_destination = 'HKO' THEN job_id END) as hko_jobs
    FROM looker_jobs
    GROUP BY sent_from_lab_date
    ORDER BY sent_from_lab_date DESC
    LIMIT ?
  `).all(days);
}

function getHealth() {
  return {
    connected: !!cache.lastSync && !cache.error,
    lastSync: cache.lastSync,
    error: cache.error,
    daysCached: cache.daily.length,
    frameDaysCached: (cache.frames || []).length,
  };
}

module.exports = { start, stop, poll, getUsage, getTopOPCs, getFrameUsage, getHealth, getJobs, getJobsByOrder, getJobCountByDay };
