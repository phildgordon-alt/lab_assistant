#!/usr/bin/env node
'use strict';

/**
 * Phase 0 · Inventory parity check · ItemPath ↔ Power Pick
 *
 * Compares on-hand quantity per (SKU, warehouse) between:
 *   - Power Pick: SQL aggregate over LocContent → Location → Shelf →
 *     Carrier → Storageunit → Warehouse
 *   - ItemPath:   in-memory cache from itempath.getInventory()
 *
 * Per the planner's review (2026-05-07), the gate before Phase 1
 * inventory cutover is: 50-SKU random sample matches at ±0 tolerance
 * for 7 consecutive days. This script runs the check once. Cron it
 * (or re-run by hand) and we'll watch the streak.
 *
 * READ-ONLY — does not modify the lab DB or Power Pick. Output:
 *   data/migration-reports/parity-inventory-YYYY-MM-DD.md
 *   data/migration-reports/parity-inventory-YYYY-MM-DD.json
 *
 * Usage:
 *   node scripts/migration-phase0-parity-inventory.js               # 50 SKUs
 *   node scripts/migration-phase0-parity-inventory.js --sample 200  # 200 SKUs
 *   node scripts/migration-phase0-parity-inventory.js --all         # every SKU
 */

const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: '/Users/Shared/lab_assistant/.env', override: false });
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: false });

const REPORTS_DIR = path.join(process.env.LAB_DATA_DIR || '/Users/Shared/lab_assistant/data', 'migration-reports');
const SAMPLE = (() => {
  const i = process.argv.indexOf('--sample');
  if (i > -1 && process.argv[i + 1]) return parseInt(process.argv[i + 1], 10) || 50;
  if (process.argv.includes('--all')) return Infinity;
  return 50;
})();

const today = new Date().toISOString().slice(0, 10);
const reportPath = path.join(REPORTS_DIR, `parity-inventory-${today}.md`);
const jsonPath   = path.join(REPORTS_DIR, `parity-inventory-${today}.json`);

const powerpick = require('../server/powerpick-adapter');
const itempath  = require('../server/itempath-adapter');

function ensureDir() { if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true }); }

// Power Pick: aggregate on-hand qty BOTH by (SKU, warehouse) AND by
// SKU-only. ItemPath's /api/inventory endpoint emits one row per SKU
// with a single aggregate qty — no per-warehouse split — so the apples-
// to-apples Phase 0 parity check is at the SKU level, not the
// (SKU, warehouse) level. We still capture per-warehouse so we can
// report a per-warehouse table for context.
const PP_QUERY_BY_WH = `
  SELECT
    m.MaterialName       AS sku,
    w.WarehouseName      AS warehouse,
    SUM(lc.QuantityCurrent) AS qty
  FROM dbo.LocContent lc
  JOIN dbo.Materialbase m ON m.MaterialId  = lc.MaterialId
  JOIN dbo.Location loc   ON loc.LocationId = lc.LocationId
  JOIN dbo.Shelf s        ON s.ShelfId      = loc.ShelfId
  JOIN dbo.Carrier c      ON c.CarrierId    = s.CarrierId
  JOIN dbo.Storageunit su ON su.StorageunitId = c.StorageunitId
  JOIN dbo.Warehouse w    ON w.WarehouseId  = su.WarehouseId
  WHERE lc.QuantityCurrent IS NOT NULL
  GROUP BY m.MaterialName, w.WarehouseName
`;
const PP_QUERY_SKU_TOTAL = `
  SELECT
    m.MaterialName        AS sku,
    SUM(lc.QuantityCurrent) AS qty
  FROM dbo.LocContent lc
  JOIN dbo.Materialbase m ON m.MaterialId = lc.MaterialId
  WHERE lc.QuantityCurrent IS NOT NULL
  GROUP BY m.MaterialName
`;

async function pullPowerPickInventory() {
  await powerpick.testConnection(); // ensures pool is live
  let sql;
  try { sql = require('mssql'); } catch { throw new Error('mssql package not installed'); }
  const env = process.env;
  const cfg = {
    server: env.POWERPICK_HOST || env.POWERPICK_SERVER,
    port: parseInt(env.POWERPICK_PORT || '1433', 10),
    database: env.POWERPICK_DATABASE || env.POWERPICK_DB || 'PowerPick',
    user: env.POWERPICK_USER,
    password: env.POWERPICK_PASSWORD,
    options: {
      encrypt: env.POWERPICK_ENCRYPT === 'true',
      trustServerCertificate: env.POWERPICK_TRUST_CERT !== 'false',
      enableArithAbort: true,
    },
  };
  const p = await sql.connect(cfg);
  try {
    const byWh   = (await p.request().query(PP_QUERY_BY_WH)).recordset || [];
    const totals = (await p.request().query(PP_QUERY_SKU_TOTAL)).recordset || [];
    return { byWh, totals };
  } finally {
    try { await p.close(); } catch {}
  }
}

function indexBySkuWh(rows) {
  const idx = new Map();
  for (const r of rows) {
    const key = `${r.sku}::${r.warehouse}`;
    idx.set(key, Number(r.qty) || 0);
  }
  return idx;
}

function pickSample(skus, n) {
  if (n === Infinity) return skus;
  if (skus.length <= n) return skus;
  // Deterministic random by date so reruns same-day give the same sample
  const seed = Number(today.replace(/-/g, ''));
  const rng = (i) => ((seed * 9301 + 49297 + i * 233) % 233280) / 233280;
  const out = new Set();
  let i = 0;
  while (out.size < n && i < skus.length * 2) {
    out.add(skus[Math.floor(rng(i) * skus.length)]);
    i++;
  }
  return [...out];
}

async function run() {
  ensureDir();
  console.log('[parity-inv] starting…');

  // ── 1. Pull Power Pick ─────────────────────────────────────────
  console.log('[parity-inv] querying Power Pick (LocContent join)…');
  let ppData;
  try { ppData = await pullPowerPickInventory(); }
  catch (e) {
    console.error('[parity-inv] Power Pick query failed:', e.message);
    fs.writeFileSync(reportPath, `# Parity Inventory ${today}\n\n**ABORTED:** Power Pick query failed: ${e.message}\n`);
    process.exit(1);
  }
  const ppByKey = indexBySkuWh(ppData.byWh);
  const ppSkuTotal = new Map(ppData.totals.map(r => [r.sku, Number(r.qty) || 0]));
  const ppSkus = new Set([...ppSkuTotal.keys()]);
  console.log(`[parity-inv] Power Pick: ${ppData.byWh.length} (sku, warehouse) rows · ${ppSkus.size} distinct SKUs`);

  // ── 2. Pull ItemPath data from the running lab server ─────────
  // Reading itempath.getInventory() in this child process gives an
  // empty cache because the adapter needs start() + poll cycle. The
  // PRODUCTION ItemPath cache lives in the long-running lab-server
  // process — fetch via its HTTP endpoint instead.
  console.log('[parity-inv] fetching ItemPath data from lab server (/api/inventory)…');
  const labUrl = process.env.LAB_SERVER_URL || 'http://localhost:3002';
  let invJson = {};
  try {
    const resp = await fetch(`${labUrl}/api/inventory`, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    invJson = await resp.json();
  } catch (e) {
    console.error(`[parity-inv] lab-server fetch failed: ${e.message}`);
    fs.writeFileSync(reportPath, `# Parity Inventory ${today}\n\n**ABORTED:** could not reach ${labUrl}/api/inventory — is the lab server running?\n\n\`\`\`\n${e.message}\n\`\`\`\n`);
    process.exit(1);
  }
  const ipMaterials = Array.isArray(invJson.materials) ? invJson.materials : [];
  console.log(`[parity-inv] ItemPath (via lab server): ${ipMaterials.length} materials`);
  if (ipMaterials.length === 0) {
    const msg = 'ItemPath returned 0 materials. Possible causes: (1) ITEMPATH_TOKEN not set on lab server, (2) ItemPath REST API down, (3) adapter in mock mode.';
    console.error(`[parity-inv] ${msg}`);
    fs.writeFileSync(reportPath, `# Parity Inventory ${today}\n\n**ABORTED:** ${msg}\n`);
    process.exit(2);
  }
  // ItemPath /api/inventory emits one row per SKU with `qty` already
  // aggregated across all warehouses (see m.warehouse=null in sample
  // 0620034231). For Phase 0 parity, compare SKU-level totals.
  const ipSkuTotal = new Map();
  for (const m of ipMaterials) {
    const sku = m.sku || m.materialName || m.MaterialName;
    if (!sku) continue;
    const q = Number(m.qty) || 0;
    ipSkuTotal.set(sku, (ipSkuTotal.get(sku) || 0) + q);
  }
  const ipSkus = new Set([...ipSkuTotal.keys()]);
  console.log(`[parity-inv] ItemPath SKU-totals: ${ipSkuTotal.size} distinct SKUs`);

  // ── 3. Sample SKUs from the intersection ───────────────────────
  const intersection = [...ppSkus].filter(s => ipSkus.has(s)).sort();
  const sampleSkus = pickSample(intersection, SAMPLE);
  console.log(`[parity-inv] comparing ${sampleSkus.length} SKUs (intersection of ${intersection.length})`);

  // ── 4. Diff at SKU-total level ─────────────────────────────────
  const diffs = [];
  const matches = [];
  const onlyPp = [];
  const onlyIp = [];
  for (const sku of sampleSkus) {
    const ppQ = ppSkuTotal.has(sku) ? ppSkuTotal.get(sku) : null;
    const ipQ = ipSkuTotal.has(sku) ? ipSkuTotal.get(sku) : null;
    if (ppQ === null && ipQ !== null) onlyIp.push({ sku, ipQ });
    else if (ipQ === null && ppQ !== null) onlyPp.push({ sku, ppQ });
    else if (Math.abs((ppQ || 0) - (ipQ || 0)) >= 1) diffs.push({ sku, ppQ, ipQ, delta: (ppQ || 0) - (ipQ || 0) });
    else matches.push({ sku, qty: ppQ });
  }

  // ── 5. Universe-level totals ──────────────────────────────────
  const ppTotalsByWh = {};
  for (const [k, q] of ppByKey) {
    const w = k.split('::')[1];
    ppTotalsByWh[w] = (ppTotalsByWh[w] || 0) + q;
  }
  const ppGrand = [...ppSkuTotal.values()].reduce((s, q) => s + q, 0);
  const ipGrand = [...ipSkuTotal.values()].reduce((s, q) => s + q, 0);

  const out = {
    runAt: new Date().toISOString(),
    today,
    sampleSize: sampleSkus.length,
    intersectionSize: intersection.length,
    counts: {
      ppByWhRows: ppData.byWh.length,
      ppSkus: ppSkus.size,
      ipMaterials: ipMaterials.length,
      ipSkus: ipSkus.size,
      matches: matches.length,
      diffs: diffs.length,
      onlyPp: onlyPp.length,
      onlyIp: onlyIp.length,
    },
    ppTotalsByWh, ppGrand, ipGrand,
    sampleSkus, diffs, onlyPp, onlyIp,
  };
  fs.writeFileSync(jsonPath, JSON.stringify(out, null, 2));

  // ── 6. Markdown report ─────────────────────────────────────────
  let md = `# Parity Inventory · ItemPath ↔ Power Pick · ${today}\n\n`;
  md += `_Run: ${out.runAt}_\n\n`;
  md += `_Comparison key: SKU-total qty (ItemPath /api/inventory emits per-SKU aggregate; Power Pick LocContent summed across all warehouses for the same shape)._\n\n`;
  md += `## Summary\n\n`;
  md += `| Metric | Value |\n|---|---:|\n`;
  md += `| Sample size | ${out.sampleSize} |\n`;
  md += `| Intersection (SKUs in both sources) | ${out.intersectionSize} |\n`;
  md += `| ✅ Matches (qty equal within ±1) | **${out.counts.matches}** |\n`;
  md += `| ❌ Differences | **${out.counts.diffs}** |\n`;
  md += `| Only in Power Pick | ${out.counts.onlyPp} |\n`;
  md += `| Only in ItemPath  | ${out.counts.onlyIp} |\n`;
  md += `\n`;
  const verdict = (out.counts.diffs === 0 && out.counts.onlyPp === 0 && out.counts.onlyIp === 0)
    ? '✅ **PASS** — exact parity for sampled SKUs.'
    : '❌ **FAIL** — investigate divergences before Phase 1 cutover.';
  md += `### Verdict: ${verdict}\n\n`;
  md += `## Grand Totals (every SKU, every warehouse)\n\n`;
  md += `| Source | Total qty |\n|---|---:|\n`;
  md += `| Power Pick (sum LocContent.QuantityCurrent) | ${Math.round(ppGrand).toLocaleString()} |\n`;
  md += `| ItemPath (sum materials[].qty)              | ${Math.round(ipGrand).toLocaleString()} |\n`;
  const grandDelta = Math.round(ppGrand - ipGrand);
  const grandPct = ipGrand > 0 ? ((grandDelta / ipGrand) * 100).toFixed(2) : '∞';
  md += `| **Δ**                                       | **${grandDelta.toLocaleString()} (${grandPct}%)** |\n\n`;
  md += `## Per-Warehouse (Power Pick only — ItemPath endpoint doesn't break out by warehouse)\n\n`;
  md += `| Warehouse | Power Pick total qty |\n|---|---:|\n`;
  for (const w of Object.keys(ppTotalsByWh).sort()) {
    md += `| ${w} | ${Math.round(ppTotalsByWh[w]).toLocaleString()} |\n`;
  }
  md += `\n`;
  if (diffs.length) {
    md += `## Differences (sample, SKU-total level)\n\n`;
    md += `| SKU | Power Pick | ItemPath | Δ |\n|---|---:|---:|---:|\n`;
    for (const d of diffs.slice(0, 100)) {
      md += `| ${d.sku} | ${(d.ppQ ?? 'null').toString()} | ${(d.ipQ ?? 'null').toString()} | ${d.delta} |\n`;
    }
    if (diffs.length > 100) md += `\n_…${diffs.length - 100} more diffs in JSON._\n`;
    md += `\n`;
  }
  if (onlyPp.length) {
    md += `## Only in Power Pick (top 50)\n\n`;
    md += `| SKU | Qty |\n|---|---:|\n`;
    for (const r of onlyPp.slice(0, 50)) md += `| ${r.sku} | ${r.ppQ} |\n`;
    md += `\n`;
  }
  if (onlyIp.length) {
    md += `## Only in ItemPath (top 50)\n\n`;
    md += `| SKU | Qty |\n|---|---:|\n`;
    for (const r of onlyIp.slice(0, 50)) md += `| ${r.sku} | ${r.ipQ} |\n`;
    md += `\n`;
  }
  fs.writeFileSync(reportPath, md);
  console.log(`[parity-inv] report: ${reportPath}`);
  console.log(`[parity-inv] ${verdict.replace(/\*\*/g, '')}`);
  console.log('[parity-inv] DONE.');
}

run().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
