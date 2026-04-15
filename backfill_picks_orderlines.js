#!/usr/bin/env node
/**
 * Backfill picks_history from ItemPath /api/order_lines endpoint.
 * Uses server-side date filtering (modifiedDate[gte]) and pagination.
 *
 * Usage: node backfill_picks_orderlines.js [from_date] [to_date]
 * Default: YTD (2026-01-01 to today)
 *
 * Throttles to ~1 request per 2 seconds to stay under ItemPath's 20K/day limit.
 * Uses INSERT OR IGNORE so safe to re-run — won't duplicate.
 */

const path = require('path');
const Database = require('better-sqlite3');
const db = new Database(path.join(__dirname, 'data', 'lab_assistant.db'));

const ITEMPATH_URL = process.env.ITEMPATH_URL || 'https://paireyewear.itempath.com';
const ITEMPATH_TOKEN = process.env.ITEMPATH_TOKEN || '';

// Read token from .env if not in environment
if (!ITEMPATH_TOKEN) {
  try {
    const envFile = require('fs').readFileSync(path.join(__dirname, '.env'), 'utf8');
    const match = envFile.match(/ITEMPATH_TOKEN=(.+)/);
    if (match) process.env.ITEMPATH_TOKEN = match[1].trim();
  } catch {}
}
const TOKEN = process.env.ITEMPATH_TOKEN || ITEMPATH_TOKEN;
if (!TOKEN) { console.error('No ITEMPATH_TOKEN found'); process.exit(1); }

// ItemPath /api/order_lines times out above limit~50 (empirically verified 2026-04-15).
const PAGE_SIZE = 50;
const DELAY_MS = 2000; // 2 seconds between API calls
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchPage(dateFrom, dateTo, page) {
  const url = new URL(`${ITEMPATH_URL}/api/order_lines`);
  url.searchParams.set('directionType', '2'); // picks
  url.searchParams.set('status', 'processed');
  url.searchParams.set('modifiedDate[gte]', `${dateFrom}T00:00:00`);
  url.searchParams.set('modifiedDate[lte]', `${dateTo}T23:59:59`);
  url.searchParams.set('limit', PAGE_SIZE.toString());
  url.searchParams.set('page', page.toString());

  const resp = await fetch(url.toString(), {
    headers: { 'Authorization': `Bearer ${TOKEN}` },
    signal: AbortSignal.timeout(120000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  return resp.json();
}

async function countPicks(dateFrom, dateTo) {
  const url = new URL(`${ITEMPATH_URL}/api/order_lines`);
  url.searchParams.set('directionType', '2');
  url.searchParams.set('status', 'processed');
  url.searchParams.set('modifiedDate[gte]', `${dateFrom}T00:00:00`);
  url.searchParams.set('modifiedDate[lte]', `${dateTo}T23:59:59`);
  url.searchParams.set('countOnly', 'true');

  const resp = await fetch(url.toString(), {
    headers: { 'Authorization': `Bearer ${TOKEN}` },
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`Count failed: ${resp.status}`);
  const data = await resp.json();
  return data.count || 0;
}

async function main() {
  const fromDate = process.argv[2] || '2026-01-01';
  const toDate = process.argv[3] || new Date().toISOString().slice(0, 10);

  console.log(`\nBackfill picks_history: ${fromDate} to ${toDate}`);
  console.log(`API: ${ITEMPATH_URL}/api/order_lines (directionType=2, status=processed)`);
  console.log(`Throttle: ${DELAY_MS}ms between calls\n`);

  // Count existing
  const existingCount = db.prepare(`
    SELECT COUNT(*) as cnt FROM picks_history WHERE date(completed_at) >= ? AND date(completed_at) <= ?
  `).get(fromDate, toDate).cnt;
  console.log(`Existing picks_history records in range: ${existingCount}`);

  // Process day by day to keep each request manageable
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO picks_history (pick_id, order_id, sku, name, qty, picked, warehouse, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let totalFetched = 0;
  let totalInserted = 0;
  let apiCalls = 0;

  const start = new Date(fromDate);
  const end = new Date(toDate);

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dayStr = d.toISOString().slice(0, 10);

    // Skip Sundays only (Saturdays often have 200-1500 picks)
    const dow = d.getDay();
    if (dow === 0) { console.log(`${dayStr}: Sunday — skipping`); continue; }

    // Paginate directly — no count call (avoids timeout on large datasets)
    let dayFetched = 0;
    let dayInserted = 0;
    let page = 0;

    while (true) {
      await sleep(DELAY_MS);
      try {
        const data = await fetchPage(dayStr, dayStr, page);
        apiCalls++;
        const lines = data.order_lines || [];
        if (lines.length === 0) break; // no more pages
        dayFetched += lines.length;

        const save = db.transaction(() => {
          for (const line of lines) {
            const sku = line.materialName || '';
            const name = line.Info1 || line.info1 || '';
            const qty = Math.abs(parseFloat(line.quantityConfirmed) || parseFloat(line.quantity) || 0);
            if (!sku || qty <= 0) continue;

            let wh = line.warehouseName || line.costCenterName || '';
            if (/kitchen/i.test(wh) || /wh3/i.test(wh)) wh = 'WH3';
            else if (/wh2/i.test(wh)) wh = 'WH2';
            else if (/wh1/i.test(wh)) wh = 'WH1';

            const completedAt = line.modifiedDate || line.creationDate || `${dayStr}T12:00:00`;
            const pickId = `hist-${line.id || line.orderLineId || ''}`; // unified with live pickSync
            const orderId = line.orderId || '';

            const result = insertStmt.run(pickId, orderId, sku, name, qty, qty, wh, completedAt);
            if (result.changes > 0) dayInserted++;
          }
        });
        save();

        if (lines.length < PAGE_SIZE) break; // last page
        page++;
      } catch (e) {
        console.error(`\n  ERROR on ${dayStr} page ${page}: ${e.message}`);
        console.error(`  Waiting 60s before retrying...`);
        await sleep(60000);
        // retry same page
      }
    }

    totalFetched += dayFetched;
    totalInserted += dayInserted;
    console.log(`${dayStr}: ${dayFetched} fetched, ${dayInserted} new (${apiCalls} API calls total)`);
  }

  // Final count
  const newCount = db.prepare(`
    SELECT COUNT(*) as cnt FROM picks_history WHERE date(completed_at) >= ? AND date(completed_at) <= ?
  `).get(fromDate, toDate).cnt;

  console.log(`\n=== DONE ===`);
  console.log(`API calls made: ${apiCalls}`);
  console.log(`Records fetched: ${totalFetched}`);
  console.log(`New records inserted: ${totalInserted}`);
  console.log(`picks_history in range: ${existingCount} → ${newCount} (+${newCount - existingCount})`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
