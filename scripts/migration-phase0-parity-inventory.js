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

// Power Pick: aggregate on-hand qty by (SKU, warehouse). One row per
// (Materialreference, WarehouseName) — sums across all VLMs / shelves /
// locations within the warehouse.
const PP_QUERY = `
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

async function pullPowerPickInventory() {
  // Use the adapter's connect/pool wiring rather than re-implementing
  await powerpick.testConnection(); // ensures pool is live
  const pool = powerpick._getPool ? powerpick._getPool() : null;
  // The adapter doesn't export the pool directly. Use sampleRows-style
  // direct query through mssql package.
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
    const r = await p.request().query(PP_QUERY);
    return r.recordset || [];
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
  let ppRows;
  try { ppRows = await pullPowerPickInventory(); }
  catch (e) {
    console.error('[parity-inv] Power Pick query failed:', e.message);
    fs.writeFileSync(reportPath, `# Parity Inventory ${today}\n\n**ABORTED:** Power Pick query failed: ${e.message}\n`);
    process.exit(1);
  }
  const ppByKey = indexBySkuWh(ppRows);
  const ppSkus = new Set(ppRows.map(r => r.sku));
  console.log(`[parity-inv] Power Pick: ${ppRows.length} (sku, warehouse) rows · ${ppSkus.size} distinct SKUs`);

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
    const msg = 'ItemPath returned 0 materials. Possible causes: (1) ITEMPATH_TOKEN not set on lab server, (2) ItemPath REST API down, (3) adapter in mock mode. CANNOT validate parity without a populated ItemPath cache.';
    console.error(`[parity-inv] ${msg}`);
    fs.writeFileSync(reportPath, `# Parity Inventory ${today}\n\n**ABORTED:** ${msg}\n\nLab server response:\n\n\`\`\`\n${JSON.stringify(invJson, null, 2).slice(0, 1000)}\n\`\`\`\n`);
    process.exit(2);
  }
  // ItemPath material shape varies — handle both flattened-per-warehouse
  // (one row per (sku, warehouse) with .qty) and aggregated (one row per
  // sku with .warehouseStock {WH1: qty, WH2: qty}).
  const ipByKey = new Map();
  for (const m of ipMaterials) {
    const sku = m.sku || m.materialName || m.MaterialName;
    if (!sku) continue;
    if (m.warehouse && (m.qty != null)) {
      ipByKey.set(`${sku}::${m.warehouse}`, Number(m.qty) || 0);
    } else if (m.warehouseStock && typeof m.warehouseStock === 'object') {
      for (const [wh, q] of Object.entries(m.warehouseStock)) {
        ipByKey.set(`${sku}::${wh}`, Number(q) || 0);
      }
    } else if (m.qty != null) {
      // No warehouse breakdown — aggregate under unknown
      ipByKey.set(`${sku}::(unspecified)`, Number(m.qty) || 0);
    }
  }
  const ipSkus = new Set([...ipByKey.keys()].map(k => k.split('::')[0]));
  console.log(`[parity-inv] ItemPath: ${ipByKey.size} (sku, warehouse) keys · ${ipSkus.size} distinct SKUs`);

  // ── 3. Sample SKUs (intersection by default) ───────────────────
  const intersection = [...ppSkus].filter(s => ipSkus.has(s)).sort();
  const sampleSkus = pickSample(intersection, SAMPLE);
  console.log(`[parity-inv] comparing ${sampleSkus.length} SKUs (intersection of ${intersection.length})`);

  // ── 4. Diff (sku, warehouse) → qty ─────────────────────────────
  const diffs = [];
  const matches = [];
  const onlyPp = [];
  const onlyIp = [];
  for (const sku of sampleSkus) {
    // gather all warehouses present in either side for this SKU
    const wh = new Set();
    for (const k of ppByKey.keys()) if (k.startsWith(sku + '::')) wh.add(k.split('::')[1]);
    for (const k of ipByKey.keys()) if (k.startsWith(sku + '::')) wh.add(k.split('::')[1]);
    for (const w of wh) {
      const k = `${sku}::${w}`;
      const ppQ = ppByKey.has(k) ? ppByKey.get(k) : null;
      const ipQ = ipByKey.has(k) ? ipByKey.get(k) : null;
      if (ppQ === null && ipQ !== null) onlyIp.push({ sku, warehouse: w, ipQ });
      else if (ipQ === null && ppQ !== null) onlyPp.push({ sku, warehouse: w, ppQ });
      else if (Math.abs((ppQ || 0) - (ipQ || 0)) >= 1) diffs.push({ sku, warehouse: w, ppQ, ipQ, delta: (ppQ || 0) - (ipQ || 0) });
      else matches.push({ sku, warehouse: w, qty: ppQ });
    }
  }

  // ── 5. Universe-level totals (every SKU, not just sample) ──────
  const ppTotalsByWh = {};
  for (const [k, q] of ppByKey) {
    const w = k.split('::')[1];
    ppTotalsByWh[w] = (ppTotalsByWh[w] || 0) + q;
  }
  const ipTotalsByWh = {};
  for (const [k, q] of ipByKey) {
    const w = k.split('::')[1];
    ipTotalsByWh[w] = (ipTotalsByWh[w] || 0) + q;
  }

  const out = {
    runAt: new Date().toISOString(),
    today,
    sampleSize: sampleSkus.length,
    intersectionSize: intersection.length,
    counts: {
      ppRows: ppRows.length,
      ppSkus: ppSkus.size,
      ipMaterials: ipMaterials.length,
      ipSkus: ipSkus.size,
      matches: matches.length,
      diffs: diffs.length,
      onlyPp: onlyPp.length,
      onlyIp: onlyIp.length,
    },
    ppTotalsByWh, ipTotalsByWh,
    sampleSkus, diffs, onlyPp, onlyIp,
  };
  fs.writeFileSync(jsonPath, JSON.stringify(out, null, 2));

  // ── 6. Markdown report ─────────────────────────────────────────
  let md = `# Parity Inventory · ItemPath ↔ Power Pick · ${today}\n\n`;
  md += `_Run: ${out.runAt}_\n\n`;
  md += `## Summary\n\n`;
  md += `| Metric | Value |\n|---|---:|\n`;
  md += `| Sample size | ${out.sampleSize} |\n`;
  md += `| Intersection (SKUs in both sources) | ${out.intersectionSize} |\n`;
  md += `| ✅ Matches (qty equal within ±1) | **${out.counts.matches}** |\n`;
  md += `| ❌ Differences | **${out.counts.diffs}** |\n`;
  md += `| Only in Power Pick | ${out.counts.onlyPp} |\n`;
  md += `| Only in ItemPath | ${out.counts.onlyIp} |\n`;
  md += `\n`;
  const verdict = (out.counts.diffs === 0 && out.counts.onlyPp === 0 && out.counts.onlyIp === 0)
    ? '✅ **PASS** — exact parity for sampled SKUs.'
    : '❌ **FAIL** — investigate divergences before Phase 1 cutover.';
  md += `### Verdict: ${verdict}\n\n`;
  md += `## Universe Totals (every SKU, not just sample)\n\n`;
  md += `| Warehouse | Power Pick total qty | ItemPath total qty | Δ |\n|---|---:|---:|---:|\n`;
  const allWh = new Set([...Object.keys(ppTotalsByWh), ...Object.keys(ipTotalsByWh)]);
  for (const w of [...allWh].sort()) {
    const pp = Math.round(ppTotalsByWh[w] || 0);
    const ip = Math.round(ipTotalsByWh[w] || 0);
    const pct = ip > 0 ? (((pp - ip) / ip) * 100).toFixed(1) : '∞';
    md += `| ${w} | ${pp.toLocaleString()} | ${ip.toLocaleString()} | ${(pp - ip).toLocaleString()} (${pct}%) |\n`;
  }
  md += `\n`;
  if (diffs.length) {
    md += `## Differences (sample)\n\n`;
    md += `| SKU | Warehouse | Power Pick | ItemPath | Δ |\n|---|---|---:|---:|---:|\n`;
    for (const d of diffs.slice(0, 100)) {
      md += `| ${d.sku} | ${d.warehouse} | ${(d.ppQ ?? 'null').toString()} | ${(d.ipQ ?? 'null').toString()} | ${d.delta} |\n`;
    }
    if (diffs.length > 100) md += `\n_…${diffs.length - 100} more diffs in JSON._\n`;
    md += `\n`;
  }
  if (onlyPp.length) {
    md += `## Only in Power Pick (top 50)\n\n`;
    md += `| SKU | Warehouse | Qty |\n|---|---|---:|\n`;
    for (const r of onlyPp.slice(0, 50)) md += `| ${r.sku} | ${r.warehouse} | ${r.ppQ} |\n`;
    md += `\n`;
  }
  if (onlyIp.length) {
    md += `## Only in ItemPath (top 50)\n\n`;
    md += `| SKU | Warehouse | Qty |\n|---|---|---:|\n`;
    for (const r of onlyIp.slice(0, 50)) md += `| ${r.sku} | ${r.warehouse} | ${r.ipQ} |\n`;
    md += `\n`;
  }
  fs.writeFileSync(reportPath, md);
  console.log(`[parity-inv] report: ${reportPath}`);
  console.log(`[parity-inv] ${verdict.replace(/\*\*/g, '')}`);
  console.log('[parity-inv] DONE.');
}

run().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
