#!/usr/bin/env node
/**
 * Read-only probe: hit /api/order_lines with varied filter combinations
 * against a known-good date (2026-03-25, which has 2655 picks in
 * picks_history). Find out which filter combination broke.
 *
 * Safe — read-only, ~8 small API calls total, limit=5 each.
 */
const fs = require('fs');
const path = require('path');

if (!process.env.ITEMPATH_TOKEN) {
  try {
    const env = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    const tok = env.match(/ITEMPATH_TOKEN=(.+)/);
    const url = env.match(/ITEMPATH_URL=(.+)/);
    if (tok) process.env.ITEMPATH_TOKEN = tok[1].trim();
    if (url && !process.env.ITEMPATH_URL) process.env.ITEMPATH_URL = url[1].trim();
  } catch {}
}
const BASE = process.env.ITEMPATH_URL;
const TOKEN = process.env.ITEMPATH_TOKEN;
if (!BASE || !TOKEN) { console.error('Missing ITEMPATH_URL/TOKEN'); process.exit(1); }

const KNOWN_DATE = '2026-03-25';   // 2655 picks in picks_history
const TODAY      = new Date().toISOString().slice(0, 10);
const SPACING_MS = 2000;           // gentle — 2s between calls
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function hit(label, params) {
  await sleep(SPACING_MS);
  const url = new URL(`${BASE}/api/order_lines`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  try {
    const resp = await fetch(url.toString(), {
      headers: { 'Authorization': `Bearer ${TOKEN}` },
      signal: AbortSignal.timeout(30000),
    });
    const text = await resp.text();
    let json; try { json = JSON.parse(text); } catch { json = null; }
    const list = json?.order_lines || json?.orderLines || json?.data || (Array.isArray(json) ? json : []);
    const total = json?.total ?? json?.count ?? (Array.isArray(list) ? list.length : '?');
    const firstKeys = list[0] ? Object.keys(list[0]).slice(0, 15).join(',') : '(no records)';
    console.log(`\n--- ${label} — HTTP ${resp.status} — ${text.length} bytes — list.length=${Array.isArray(list) ? list.length : '?'} total=${total}`);
    console.log(`    url: ${url.pathname}${url.search}`);
    console.log(`    firstKeys: ${firstKeys}`);
    if (list[0]) {
      const r = list[0];
      console.log(`    sample: id=${r.id} status=${JSON.stringify(r.status)} directionType=${JSON.stringify(r.directionType)} modifiedDate=${r.modifiedDate} creationDate=${r.creationDate}`);
    }
    return { label, count: Array.isArray(list) ? list.length : 0, sample: list[0] || null };
  } catch (e) {
    console.log(`\n--- ${label} — ERROR: ${e.message}`);
    return { label, error: e.message };
  }
}

(async () => {
  const from = `${KNOWN_DATE}T00:00:00`;
  const to   = `${KNOWN_DATE}T23:59:59`;
  const todayFrom = `${TODAY}T00:00:00`;
  const todayTo   = `${TODAY}T23:59:59`;

  console.log(`Probing /api/order_lines against known-good date ${KNOWN_DATE} (expect ~2655 picks) and today ${TODAY}`);

  const results = [];

  // 1. Endpoint alive at all?
  results.push(await hit('1. BASELINE — no filters, limit=5',
    { limit: 5 }));

  // 2. Current live filter (known broken) against known-good past date
  results.push(await hit('2. CURRENT FILTER (past date) — directionType=2 + status=processed + modifiedDate window',
    { directionType: 2, status: 'processed', 'modifiedDate[gte]': from, 'modifiedDate[lte]': to, limit: 5 }));

  // 3. Current filter against today
  results.push(await hit('3. CURRENT FILTER (today) — directionType=2 + status=processed + modifiedDate window',
    { directionType: 2, status: 'processed', 'modifiedDate[gte]': todayFrom, 'modifiedDate[lte]': todayTo, limit: 5 }));

  // 4. Drop status
  results.push(await hit('4. NO STATUS — directionType=2 + modifiedDate window',
    { directionType: 2, 'modifiedDate[gte]': from, 'modifiedDate[lte]': to, limit: 5 }));

  // 5. Drop directionType
  results.push(await hit('5. NO DIRECTION — status=processed + modifiedDate window',
    { status: 'processed', 'modifiedDate[gte]': from, 'modifiedDate[lte]': to, limit: 5 }));

  // 6. Only date
  results.push(await hit('6. DATE ONLY — modifiedDate window',
    { 'modifiedDate[gte]': from, 'modifiedDate[lte]': to, limit: 5 }));

  // 7. creationDate instead of modifiedDate
  results.push(await hit('7. CREATION DATE — directionType=2 + status=processed + creationDate window',
    { directionType: 2, status: 'processed', 'creationDate[gte]': from, 'creationDate[lte]': to, limit: 5 }));

  // 8. Status capitalized
  results.push(await hit('8. STATUS=Processed — directionType=2 + Processed + modifiedDate window',
    { directionType: 2, status: 'Processed', 'modifiedDate[gte]': from, 'modifiedDate[lte]': to, limit: 5 }));

  // 9. No date, just direction + status (what shapes come back?)
  results.push(await hit('9. NO DATE — directionType=2 + status=processed, limit=5',
    { directionType: 2, status: 'processed', limit: 5 }));

  // 10. directionType as string
  results.push(await hit('10. DIRECTION=\"2\" (string) — status=processed + modifiedDate window',
    { directionType: '2', status: 'processed', 'modifiedDate[gte]': from, 'modifiedDate[lte]': to, limit: 5 }));

  console.log('\n\n=== SUMMARY ===');
  for (const r of results) {
    console.log(`  ${r.count > 0 ? '✓' : '✗'}  count=${r.count ?? 'ERR'}  ${r.label}`);
  }
  console.log('\nLook for the first ✓ — that\'s the filter combination that still works. Compare to the current-live-filter rows to see what changed.');
})().catch(e => { console.error(e); process.exit(1); });
