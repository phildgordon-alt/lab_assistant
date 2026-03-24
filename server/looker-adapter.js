/**
 * looker-adapter.js — Looker API Integration
 *
 * Pulls lens usage & breakage data from Looker (Look 1118).
 * Compares against ItemPath picks and NetSuite inventory.
 *
 * AUTH: OAuth2 Client Credentials (API key pair)
 * ENV: LOOKER_URL, LOOKER_CLIENT_ID, LOOKER_CLIENT_SECRET
 *
 * USAGE in oven-timer-server.js:
 *   const looker = require('./looker-adapter');
 *   looker.start();
 *   app.get('/api/looker/usage', (req, res) => res.json(looker.getUsage()));
 */

'use strict';

const CONFIG = {
  baseUrl:       process.env.LOOKER_URL || '',
  clientId:      process.env.LOOKER_CLIENT_ID || '',
  clientSecret:  process.env.LOOKER_CLIENT_SECRET || '',
  apiPort:       19999,
  pollInterval:  parseInt(process.env.LOOKER_POLL_MS || '300000'), // 5 min
  lookId:        1118, // Lens Usage & Breakage (NS Download)
};

let accessToken = null;
let tokenExpiry = 0;
let cache = {
  daily: [],       // [{ date, lenses, breakages, byOpc: { opc: { lenses, breakages } } }]
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
    headers: {
      'Authorization': `token ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'operations',
      view: 'poms_jobs',
      fields,
      filters,
      sorts,
      limit,
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!resp.ok) throw new Error(`Looker query failed: ${resp.status}`);
  return resp.json();
}

// ─────────────────────────────────────────────────────────────────────────────
// FETCH LENS USAGE
// ─────────────────────────────────────────────────────────────────────────────
async function fetchUsage() {
  // YTD — from Jan 1 of current year to today
  const year = new Date().getFullYear();
  const rows = await runQuery(
    ['dvi_jobs.sent_from_lab_date', 'dvi_job_lenses.opc', 'dvi_job_lenses.count_lenses', 'item_breakages.count_breakages'],
    {
      'dvi_jobs.dvi_destination': 'PAIR',
      'dvi_jobs.sent_from_lab_date': `${year}-01-01 to today`,
    },
    ['dvi_jobs.sent_from_lab_date desc', 'dvi_job_lenses.count_lenses desc'],
    50000  // YTD could be large
  );

  // Group by date
  const byDate = {};
  for (const r of rows) {
    const date = r['dvi_jobs.sent_from_lab_date'];
    const opc = r['dvi_job_lenses.opc'] || '';
    const lenses = r['dvi_job_lenses.count_lenses'] || 0;
    const breakages = r['item_breakages.count_breakages'] || 0;

    if (!byDate[date]) byDate[date] = { date, lenses: 0, breakages: 0, byOpc: {} };
    byDate[date].lenses += lenses;
    byDate[date].breakages += breakages;
    if (opc) {
      if (!byDate[date].byOpc[opc]) byDate[date].byOpc[opc] = { lenses: 0, breakages: 0 };
      byDate[date].byOpc[opc].lenses += lenses;
      byDate[date].byOpc[opc].breakages += breakages;
    }
  }

  return Object.values(byDate).sort((a, b) => b.date.localeCompare(a.date));
}

// ─────────────────────────────────────────────────────────────────────────────
// POLL
// ─────────────────────────────────────────────────────────────────────────────
async function poll() {
  try {
    cache.daily = await fetchUsage();
    cache.lastSync = new Date().toISOString();
    cache.error = null;
    console.log(`[Looker] Synced ${cache.daily.length} days of usage data`);
  } catch (e) {
    cache.error = e.message;
    console.error('[Looker] Poll error:', e.message);
  }
}

function start() {
  if (!CONFIG.clientId || !CONFIG.clientSecret || !CONFIG.baseUrl) {
    console.log('[Looker] No credentials configured — skipping');
    return;
  }
  console.log('[Looker] Starting — polling every', CONFIG.pollInterval / 1000, 's');
  // Initial fetch after 5s delay (let other adapters start first)
  setTimeout(() => poll(), 5000);
  pollTimer = setInterval(() => poll(), CONFIG.pollInterval);
}

function stop() {
  if (pollTimer) clearInterval(pollTimer);
}

// ─────────────────────────────────────────────────────────────────────────────
// GETTERS
// ─────────────────────────────────────────────────────────────────────────────
function getUsage(days = 30) {
  const daily = cache.daily.slice(0, days);
  const totalLenses = daily.reduce((s, d) => s + d.lenses, 0);
  const totalBreakages = daily.reduce((s, d) => s + d.breakages, 0);
  const avg = daily.length > 0 ? Math.round(totalLenses / daily.length) : 0;

  return {
    daily,
    totalLenses,
    totalBreakages,
    breakageRate: totalLenses > 0 ? Math.round((totalBreakages / totalLenses) * 1000) / 10 : 0,
    avgDaily: avg,
    dayCount: daily.length,
    lastSync: cache.lastSync,
    error: cache.error,
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

function getHealth() {
  return {
    connected: !!cache.lastSync && !cache.error,
    lastSync: cache.lastSync,
    error: cache.error,
    daysCached: cache.daily.length,
  };
}

module.exports = { start, stop, poll, getUsage, getTopOPCs, getHealth };
