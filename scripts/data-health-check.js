#!/usr/bin/env node
/**
 * data-health-check.js — Self-Healing Data Monitor for Lab_Assistant
 * ──────────────────────────────────────────────────────────────────
 * Detects gaps in production data (picks, shipped XMLs, daily exports)
 * and automatically backfills from source systems.
 *
 * Designed to run via launchd at 1:30 AM daily.
 * Can also be run manually: node scripts/data-health-check.js
 *
 * Standalone script — runs and exits. No server dependency.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// ── Paths ────────────────────────────────────────────────────────────────────
const REPO_ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(REPO_ROOT, 'data', 'lab_assistant.db');
const SHIPPED_DIR = path.join(REPO_ROOT, 'data', 'dvi', 'shipped');
const DAILY_DIR = path.join(REPO_ROOT, 'data', 'dvi', 'daily');

// ── Load .env ────────────────────────────────────────────────────────────────
function loadEnv() {
  try {
    const envFile = fs.readFileSync(path.join(REPO_ROOT, '.env'), 'utf8');
    for (const line of envFile.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {}
}
loadEnv();

const ITEMPATH_URL = process.env.ITEMPATH_URL || 'https://paireyewear.itempath.com';
const ITEMPATH_TOKEN = process.env.ITEMPATH_TOKEN || '';
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || '';
const DVI_TRACE_LOCAL_PATH = process.env.DVI_TRACE_LOCAL_PATH || '';

// ── Logging ──────────────────────────────────────────────────────────────────
function log(msg) {
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
  console.log(`[${ts}] ${msg}`);
}

function logError(msg) {
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
  console.error(`[${ts}] ERROR: ${msg}`);
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function isWeekday(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const dow = d.getDay();
  return dow >= 1 && dow <= 6; // Mon-Sat
}

function getWeekdaysInRange(days) {
  const dates = [];
  const today = new Date();
  for (let i = 1; i <= days; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const str = d.toISOString().slice(0, 10);
    if (isWeekday(str)) dates.push(str);
  }
  return dates;
}

// ── Database Setup ───────────────────────────────────────────────────────────
let db;
try {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
} catch (e) {
  logError(`Cannot open database at ${DB_PATH}: ${e.message}`);
  process.exit(1);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS data_health_log (
    id INTEGER PRIMARY KEY,
    check_date TEXT,
    source TEXT,
    gap_date TEXT,
    action TEXT,
    result TEXT,
    details TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

const logHealthStmt = db.prepare(`
  INSERT INTO data_health_log (check_date, source, gap_date, action, result, details)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const checkAlreadyAttempted = db.prepare(`
  SELECT 1 FROM data_health_log WHERE check_date = date('now') AND source = ? AND gap_date = ?
`);

// ── Results Tracker ──────────────────────────────────────────────────────────
const results = {
  picks: { gaps: [], backfilled: [], failed: [] },
  shipped: { gaps: [], backfilled: [], failed: [] },
  daily: { gaps: [], backfilled: [], failed: [] },
};

// ═════════════════════════════════════════════════════════════════════════════
// 1. PICKS GAP DETECTION & BACKFILL
// ═════════════════════════════════════════════════════════════════════════════

function detectPickGaps() {
  log('--- Picks Gap Detection ---');
  const rows = db.prepare(`
    SELECT substr(completed_at,1,10) as day, COUNT(*) as cnt
    FROM picks_history GROUP BY day ORDER BY day DESC LIMIT 30
  `).all();

  const countByDay = {};
  for (const r of rows) countByDay[r.day] = r.cnt;

  const weekdays = getWeekdaysInRange(14);
  const gaps = [];

  for (const day of weekdays) {
    const cnt = countByDay[day] || 0;
    if (cnt < 50) {
      gaps.push({ day, count: cnt, reason: cnt === 0 ? 'missing' : `low (${cnt})` });
      log(`  GAP: ${day} — ${cnt === 0 ? 'missing' : `only ${cnt} picks`}`);
    }
  }

  if (gaps.length === 0) log('  No pick gaps detected');
  return gaps;
}

async function backfillPicks(gaps) {
  if (!ITEMPATH_TOKEN) {
    log('  SKIP: No ITEMPATH_TOKEN — cannot backfill picks');
    for (const g of gaps) {
      results.picks.gaps.push(g.day);
      results.picks.failed.push(`${g.day} (no token)`);
    }
    return;
  }

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO picks_history (pick_id, order_id, sku, name, qty, picked, warehouse, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const gap of gaps) {
    results.picks.gaps.push(gap.day);

    // Check if already attempted today
    if (checkAlreadyAttempted.get('picks', gap.day)) {
      log(`  SKIP: ${gap.day} — already attempted today`);
      continue;
    }

    log(`  Backfilling picks for ${gap.day}...`);
    let totalInserted = 0;
    let failed = false;

    for (let page = 0; page < 3; page++) {
      await sleep(3000);
      try {
        const url = new URL(`${ITEMPATH_URL}/api/order_lines`);
        url.searchParams.set('directionType', '2');
        url.searchParams.set('status', 'processed');
        url.searchParams.set('modifiedDate[gte]', `${gap.day}T05:00:00`);
        url.searchParams.set('modifiedDate[lte]', `${gap.day}T23:59:59`);
        url.searchParams.set('limit', '1000');
        url.searchParams.set('page', page.toString());

        const resp = await fetch(url.toString(), {
          headers: { 'Authorization': `Bearer ${ITEMPATH_TOKEN}` },
          signal: AbortSignal.timeout(120000),
        });

        if (!resp.ok) {
          const status = resp.status;
          logError(`  ${gap.day} page ${page}: HTTP ${status}`);
          logHealthStmt.run(new Date().toISOString().slice(0, 10), 'picks', gap.day, 'backfill', 'failed', `HTTP ${status}`);
          results.picks.failed.push(`${gap.day} (${status})`);
          failed = true;
          break;
        }

        const data = await resp.json();
        const lines = data.order_lines || [];
        if (lines.length === 0) break;

        const save = db.transaction(() => {
          for (const line of lines) {
            const sku = line.materialName || '';
            const name = line.Info1 || line.info1 || '';
            const qty = Math.abs(parseFloat(line.quantityConfirmed) || parseFloat(line.quantity) || 0);
            if (!sku || qty <= 0) continue;

            let wh = line.warehouseName || line.costCenterName || '';
            if (/kitchen/i.test(wh) || /wh3/i.test(wh)) wh = 'WH3';
            else if (/wh2/i.test(wh)) wh = 'WH2';
            else wh = 'WH1';

            const completedAt = line.modifiedDate || line.creationDate || `${gap.day}T12:00:00`;
            const pickId = `ol-${line.id || line.orderLineId || ''}`;
            // order_id joins to jobs.invoice — must be the DVI invoice (line.orderName),
            // NOT the ItemPath GUID (line.orderId). Mirror of db.js:1943 validation in
            // upsertPicksHistory: reject empty, GUID-shaped, or non-numeric. Without this,
            // picks_history rows are unjoinable to jobs and pollute the table — the bug
            // that produced the 9,125 GUID rows cleaned up on 2026-05-01.
            const orderId = (line.orderName || '').trim();
            if (!orderId || /^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(orderId) || !/^\d{4,}$/.test(orderId)) {
              continue;
            }

            const result = insertStmt.run(pickId, orderId, sku, name, qty, qty, wh, completedAt);
            if (result.changes > 0) totalInserted++;
          }
        });
        save();

        if (lines.length < 1000) break; // last page
      } catch (e) {
        logError(`  ${gap.day} page ${page}: ${e.message}`);
        logHealthStmt.run(new Date().toISOString().slice(0, 10), 'picks', gap.day, 'backfill', 'failed', e.message);
        results.picks.failed.push(`${gap.day} (${e.message.slice(0, 50)})`);
        failed = true;
        break;
      }
    }

    if (!failed) {
      log(`  ${gap.day}: inserted ${totalInserted} picks`);
      logHealthStmt.run(new Date().toISOString().slice(0, 10), 'picks', gap.day, 'backfill', 'ok', `${totalInserted} inserted`);
      if (totalInserted > 0) results.picks.backfilled.push(gap.day);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. SHIPPED XML GAP DETECTION & BACKFILL
// ═════════════════════════════════════════════════════════════════════════════

function detectShippedGaps() {
  log('--- Shipped XML Gap Detection ---');

  // Check if dvi_shipped_jobs table exists
  const tableExists = db.prepare(`
    SELECT name FROM sqlite_master WHERE type='table' AND name='dvi_shipped_jobs'
  `).get();

  if (!tableExists) {
    log('  SKIP: dvi_shipped_jobs table does not exist');
    return [];
  }

  const rows = db.prepare(`
    SELECT ship_date, COUNT(*) as cnt FROM dvi_shipped_jobs WHERE is_hko=0
    GROUP BY ship_date ORDER BY ship_date DESC LIMIT 30
  `).all();

  const countByDay = {};
  for (const r of rows) countByDay[r.ship_date] = r.cnt;

  const weekdays = getWeekdaysInRange(14);
  const gaps = [];

  for (const day of weekdays) {
    const cnt = countByDay[day] || 0;
    if (cnt < 100) {
      gaps.push({ day, count: cnt, reason: cnt === 0 ? 'missing' : `low (${cnt})` });
      log(`  GAP: ${day} — ${cnt === 0 ? 'missing' : `only ${cnt} shipped jobs`}`);
    }
  }

  if (gaps.length === 0) log('  No shipped XML gaps detected');
  return gaps;
}

function backfillShipped(gaps) {
  if (gaps.length === 0) return;

  // Determine mount base path
  let mountBase = '';
  if (DVI_TRACE_LOCAL_PATH) {
    // Strip /TRACE or similar suffix to get the mount root
    mountBase = DVI_TRACE_LOCAL_PATH.replace(/\/TRACE\/?$/i, '');
  } else {
    mountBase = '/Users/Shared/lab_assistant/data/dvi/visdir';
  }

  const shiplogDir = path.join(mountBase, 'VISION', 'SHIPLOG');

  if (!fs.existsSync(shiplogDir)) {
    log(`  SKIP: Mount not available at ${shiplogDir}`);
    for (const g of gaps) {
      results.shipped.gaps.push(g.day);
      results.shipped.failed.push(`${g.day} (mount unavailable)`);
    }
    return;
  }

  // Ensure local shipped dir exists
  if (!fs.existsSync(SHIPPED_DIR)) {
    fs.mkdirSync(SHIPPED_DIR, { recursive: true });
  }

  // Get list of local files for comparison
  const localFiles = new Set(fs.readdirSync(SHIPPED_DIR).filter(f => f.endsWith('.xml')));

  // Get list of mount files
  let mountFiles;
  try {
    mountFiles = fs.readdirSync(shiplogDir).filter(f => f.endsWith('.xml'));
  } catch (e) {
    logError(`  Cannot read ${shiplogDir}: ${e.message}`);
    for (const g of gaps) {
      results.shipped.gaps.push(g.day);
      results.shipped.failed.push(`${g.day} (read error)`);
    }
    return;
  }

  // Find files on mount not in local dir and copy them
  let copiedCount = 0;
  for (const file of mountFiles) {
    if (!localFiles.has(file)) {
      try {
        fs.copyFileSync(path.join(shiplogDir, file), path.join(SHIPPED_DIR, file));
        copiedCount++;
      } catch (e) {
        logError(`  Failed to copy ${file}: ${e.message}`);
      }
    }
  }

  for (const g of gaps) {
    results.shipped.gaps.push(g.day);

    if (checkAlreadyAttempted.get('shipped', g.day)) {
      log(`  SKIP: ${g.day} — already attempted today`);
      continue;
    }

    logHealthStmt.run(new Date().toISOString().slice(0, 10), 'shipped', g.day, 'backfill', 'ok', `${copiedCount} total files copied from mount`);
  }

  if (copiedCount > 0) {
    log(`  Copied ${copiedCount} XML files from mount — server will index on next 60s cycle`);
    for (const g of gaps) results.shipped.backfilled.push(g.day);
  } else {
    log('  No new XML files found on mount');
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. DAILY EXPORT GAP DETECTION & BACKFILL
// ═════════════════════════════════════════════════════════════════════════════

function detectDailyGaps() {
  log('--- Daily Export Gap Detection ---');

  if (!fs.existsSync(DAILY_DIR)) {
    fs.mkdirSync(DAILY_DIR, { recursive: true });
  }

  const localFiles = new Set(fs.readdirSync(DAILY_DIR));
  const weekdays = getWeekdaysInRange(14);
  const gaps = [];

  for (const day of weekdays) {
    // Convert YYYY-MM-DD to YYMMDD
    const yy = day.slice(2, 4);
    const mm = day.slice(5, 7);
    const dd = day.slice(8, 10);
    const expectedFile = `${yy}${mm}${dd}_D_a_jobdta.txt`;

    if (!localFiles.has(expectedFile)) {
      gaps.push({ day, file: expectedFile });
      log(`  GAP: ${day} — missing ${expectedFile}`);
    }
  }

  if (gaps.length === 0) log('  No daily export gaps detected');
  return gaps;
}

function backfillDaily(gaps) {
  if (gaps.length === 0) return;

  // Determine mount base path
  let mountBase = '';
  if (DVI_TRACE_LOCAL_PATH) {
    mountBase = DVI_TRACE_LOCAL_PATH.replace(/\/TRACE\/?$/i, '');
  } else {
    mountBase = '/Users/Shared/lab_assistant/data/dvi/visdir';
  }

  const exportDir = path.join(mountBase, 'EXPORT', 'D');

  if (!fs.existsSync(exportDir)) {
    log(`  SKIP: Mount not available at ${exportDir}`);
    for (const g of gaps) {
      results.daily.gaps.push(g.day);
      results.daily.failed.push(`${g.day} (mount unavailable)`);
    }
    return;
  }

  for (const gap of gaps) {
    results.daily.gaps.push(gap.day);

    if (checkAlreadyAttempted.get('daily', gap.day)) {
      log(`  SKIP: ${gap.day} — already attempted today`);
      continue;
    }

    const srcPath = path.join(exportDir, gap.file);
    const destPath = path.join(DAILY_DIR, gap.file);

    if (fs.existsSync(srcPath)) {
      try {
        fs.copyFileSync(srcPath, destPath);
        log(`  Copied ${gap.file} from mount`);
        results.daily.backfilled.push(gap.day);
        logHealthStmt.run(new Date().toISOString().slice(0, 10), 'daily', gap.day, 'backfill', 'ok', `copied ${gap.file}`);
      } catch (e) {
        logError(`  Failed to copy ${gap.file}: ${e.message}`);
        results.daily.failed.push(`${gap.day} (${e.message.slice(0, 50)})`);
        logHealthStmt.run(new Date().toISOString().slice(0, 10), 'daily', gap.day, 'backfill', 'failed', e.message);
      }
    } else {
      log(`  ${gap.file} not found on mount`);
      logHealthStmt.run(new Date().toISOString().slice(0, 10), 'daily', gap.day, 'detect', 'gap', 'not on mount either');
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// 4. SLACK NOTIFICATION
// ═════════════════════════════════════════════════════════════════════════════

async function sendSlackSummary() {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 16).replace('T', ' ');

  const lines = [`Data Health Check -- ${dateStr}`];
  lines.push('');

  // Picks summary
  const pg = results.picks.gaps.length;
  const pb = results.picks.backfilled.length;
  const pf = results.picks.failed.length;
  if (pg === 0) {
    lines.push('Picks: No gaps');
  } else {
    let msg = `Picks: ${pg} gaps detected`;
    if (pb > 0) msg += `, ${pb} backfilled`;
    if (pf > 0) msg += `, ${pf} failed (${results.picks.failed.join(', ')})`;
    lines.push(msg);
  }

  // Shipped summary
  const sg = results.shipped.gaps.length;
  const sb = results.shipped.backfilled.length;
  const sf = results.shipped.failed.length;
  if (sg === 0) {
    lines.push('Shipped: No gaps');
  } else {
    let msg = `Shipped: ${sg} gaps detected`;
    if (sb > 0) msg += `, ${sb} backfilled`;
    if (sf > 0) msg += `, ${sf} failed`;
    lines.push(msg);
  }

  // Daily summary
  const dg = results.daily.gaps.length;
  const dbf = results.daily.backfilled.length;
  const df = results.daily.failed.length;
  if (dg === 0) {
    lines.push('Daily Exports: No gaps');
  } else {
    let msg = `Daily Exports: ${dg} gaps detected`;
    if (dbf > 0) msg += `, ${dbf} backfilled`;
    if (df > 0) msg += `, ${df} failed`;
    lines.push(msg);
  }

  const message = lines.join('\n');

  // Print to stdout
  console.log('\n' + '='.repeat(50));
  console.log(message);
  console.log('='.repeat(50));

  // Send to Slack if configured
  if (SLACK_WEBHOOK_URL) {
    try {
      const resp = await fetch(SLACK_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: message }),
      });
      if (resp.ok) {
        log('Slack notification sent');
      } else {
        logError(`Slack notification failed: HTTP ${resp.status}`);
      }
    } catch (e) {
      logError(`Slack notification error: ${e.message}`);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// STALE HEARTBEAT CHECK — every adapter that writes to sync_heartbeats gets
// audited here. If any source hasn't succeeded within its stale_threshold_ms,
// fire a Slack alert naming the source + staleness + last error. This is the
// safety net that would have caught the 2026-04-17 pickSync 5-day cliff.
// ═════════════════════════════════════════════════════════════════════════════

async function checkStaleHeartbeats() {
  log('Checking sync heartbeats');
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT source, last_success_at, last_row_count, last_error, consecutive_errors, stale_threshold_ms
      FROM sync_heartbeats
      WHERE stale_threshold_ms IS NOT NULL
    `).all();
  } catch (e) {
    log(`  heartbeat table not yet populated: ${e.message}`);
    return;
  }

  if (rows.length === 0) {
    log('  no heartbeats recorded yet — adapters have not run since last restart');
    return;
  }

  const now = Date.now();
  const stale = [];
  const ok = [];
  for (const r of rows) {
    const ageMs = now - r.last_success_at;
    const entry = {
      source: r.source,
      age_min: Math.round(ageMs / 60000),
      threshold_min: Math.round(r.stale_threshold_ms / 60000),
      consecutive_errors: r.consecutive_errors || 0,
      last_error: r.last_error,
      last_row_count: r.last_row_count,
    };
    if (ageMs > r.stale_threshold_ms) stale.push(entry);
    else ok.push(entry);
  }

  for (const r of ok) log(`  ✓ ${r.source}: ${r.age_min}m ago (${r.last_row_count ?? '?'} rows, threshold ${r.threshold_min}m)`);
  for (const r of stale) log(`  ✗ STALE ${r.source}: ${r.age_min}m ago (threshold ${r.threshold_min}m, ${r.consecutive_errors} consecutive errors, lastErr: ${r.last_error || 'none'})`);

  if (stale.length > 0 && SLACK_WEBHOOK_URL) {
    const bullets = stale.map(s =>
      `• *${s.source}* — stale ${s.age_min} min (threshold ${s.threshold_min} min), ${s.consecutive_errors} consecutive errors${s.last_error ? `, lastErr: ${s.last_error}` : ''}`
    ).join('\n');
    const msg = `:rotating_light: *Lab_Assistant stale sync sources:*\n${bullets}\n\nAdapters should be self-rescheduling. Stale = silent death. Investigate now.`;
    try {
      await fetch(SLACK_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: msg }),
      });
      log(`  Slack alert fired for ${stale.length} stale source(s)`);
    } catch (e) {
      logError(`  Slack stale-heartbeat alert failed: ${e.message}`);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// MAIN
// ═════════════════════════════════════════════════════════════════════════════

async function main() {
  const startTime = Date.now();
  log('Data Health Check starting');
  log(`Database: ${DB_PATH}`);
  log(`ItemPath: ${ITEMPATH_URL} (token ${ITEMPATH_TOKEN ? 'present' : 'MISSING'})`);
  log('');

  try {
    // 1. Picks
    const pickGaps = detectPickGaps();
    await backfillPicks(pickGaps);
    log('');

    // 2. Shipped XMLs
    const shippedGaps = detectShippedGaps();
    backfillShipped(shippedGaps);
    log('');

    // 3. Daily exports
    const dailyGaps = detectDailyGaps();
    backfillDaily(dailyGaps);
    log('');

    // 4. Stale sync heartbeats (catches silent-dead adapters like the 2026-04-17 pickSync cliff)
    await checkStaleHeartbeats();
    log('');

    // 5. Summary & notification
    await sendSlackSummary();
  } catch (e) {
    logError(`Unhandled error: ${e.message}`);
    console.error(e.stack);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log(`Completed in ${elapsed}s`);

  db.close();
  process.exit(0);
}

main();
