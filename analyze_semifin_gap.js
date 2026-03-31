#!/usr/bin/env node
// Run on Mac Studio: node analyze_semifin_gap.js
// Compares Kardex picks vs NetSuite for all 31 semi-finished SKUs

const http = require('http');
const path = require('path');
const Database = require('better-sqlite3');
const db = new Database(path.join(__dirname, 'data', 'lab_assistant.db'));

const SEMIFIN = [
  '4800135412','4800135420','4800135438','4800154660',
  '4800135339','4800135347','4800135354','4800135362',
  '4800150924','4800150932','4800135305','4800150940','4800150957',
  '4800150882','4800150890','4800135297','4800150908','4800150916','4800150965',
  '265007922','265007930','265007948','265007955','265007963','265007971','265007989',
  '265008466','265008474','265008482','265008490','265008508',
];

function fetch(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks))); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

async function main() {
  // 1. Kardex picks YTD
  const picks = db.prepare(`
    SELECT sku, SUM(qty) as kardex_picks
    FROM picks_history
    WHERE sku IN (${SEMIFIN.map(() => '?').join(',')})
    AND date(completed_at) >= '2026-01-01'
    GROUP BY sku
  `).all(...SEMIFIN);
  const picksBySku = {};
  for (const r of picks) picksBySku[r.sku] = r.kardex_picks;

  // 2. Live Kardex on-hand from ItemPath
  const inv = await fetch('http://localhost:3002/api/inventory');
  const kardexBySku = {};
  for (const m of (inv.materials || [])) {
    if (SEMIFIN.includes(m.sku)) kardexBySku[m.sku] = m.qty || 0;
  }

  // 3. NetSuite on-hand
  const recon = await fetch('http://localhost:3002/api/netsuite/reconcile');
  const nsBySku = {};
  for (const item of (recon.allItems || [])) {
    if (SEMIFIN.includes(item.sku)) nsBySku[item.sku] = item.netsuite || 0;
  }

  // 4. Build comparison
  const rows = [];
  let totalKardexPicks = 0, totalKardexOnHand = 0, totalNS = 0;
  for (const sku of SEMIFIN) {
    const kPicks = picksBySku[sku] || 0;
    const kOnHand = kardexBySku[sku] || 0;
    const nsOnHand = nsBySku[sku] || 0;
    const gap = kOnHand - nsOnHand;
    totalKardexPicks += kPicks;
    totalKardexOnHand += kOnHand;
    totalNS += nsOnHand;
    if (kPicks === 0 && kOnHand === 0 && nsOnHand === 0) continue;
    rows.push({ sku, kPicks, kOnHand, nsOnHand, gap });
  }
  rows.sort((a, b) => b.kPicks - a.kPicks);

  console.log('\n=== SEMI-FINISHED SKUs: KARDEX vs NETSUITE (YTD 2026) ===\n');
  console.log('SKU            KARDEX PICKS   KARDEX ON-HAND   NETSUITE ON-HAND   GAP');
  console.log('-------------- -------------- ---------------- ------------------ ------');
  for (const r of rows) {
    console.log(
      r.sku.padEnd(15) +
      String(r.kPicks).padStart(13) +
      String(r.kOnHand).padStart(17) +
      String(r.nsOnHand).padStart(19) +
      String(r.gap).padStart(7)
    );
  }
  console.log('-------------- -------------- ---------------- ------------------ ------');
  console.log(
    'TOTAL'.padEnd(15) +
    String(totalKardexPicks).padStart(13) +
    String(totalKardexOnHand).padStart(17) +
    String(totalNS).padStart(19) +
    String(totalKardexOnHand - totalNS).padStart(7)
  );

  // Export HTML
  const html = `<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: 'JetBrains Mono', monospace; font-size: 12px; color: #e5e7eb; background: #070A0F; padding: 20px; }
h3 { font-size: 16px; font-weight: 700; color: #fff; margin-bottom: 4px; }
.sub { font-size: 11px; color: #6b7280; margin-bottom: 16px; }
.row { display: flex; gap: 10px; margin-bottom: 20px; }
.k { flex:1; background:#0D1117; border:1px solid #1e293b; border-radius:8px; padding:12px; }
.kl { font-size:9px; color:#6b7280; text-transform:uppercase; letter-spacing:1px; margin-bottom:4px; }
.kv { font-size:22px; font-weight:800; }
table { width:100%; border-collapse:collapse; font-size:11px; }
thead th { font-size:9px; font-weight:700; color:#6b7280; text-align:left; padding:8px; border-bottom:2px solid #1e293b; text-transform:uppercase; letter-spacing:1px; }
th.r, td.r { text-align:right; }
tbody tr { border-bottom:1px solid #1e293b20; }
tbody tr:hover { background:#1e293b40; }
td { padding:6px 8px; font-variant-numeric:tabular-nums; }
.tot { border-top:2px solid #e5e7eb; font-weight:800; color:#fff; }
.neg { color:#ef4444; } .pos { color:#22c55e; } .amb { color:#f59e0b; } .blu { color:#60a5fa; }
</style>
<h3>Semi-Finished SKUs: Kardex vs NetSuite Reconciliation</h3>
<p class="sub">All 31 semi-finished SKUs &middot; YTD 2026 (Jan 1 &ndash; Mar 30) &middot; Irvine 2</p>
<div class="row">
  <div class="k"><div class="kl">Total Kardex Picks (YTD)</div><div class="kv amb">${totalKardexPicks.toLocaleString()}</div></div>
  <div class="k"><div class="kl">Kardex On-Hand (live)</div><div class="kv pos">${totalKardexOnHand.toLocaleString()}</div></div>
  <div class="k"><div class="kl">NetSuite On-Hand</div><div class="kv blu">${totalNS.toLocaleString()}</div></div>
  <div class="k"><div class="kl">On-Hand Gap</div><div class="kv ${totalKardexOnHand - totalNS > 0 ? 'neg' : 'pos'}">${(totalKardexOnHand - totalNS).toLocaleString()}</div></div>
  <div class="k"><div class="kl">SKUs with Picks</div><div class="kv">${rows.filter(r => r.kPicks > 0).length} / 31</div></div>
</div>
<table>
<thead><tr><th>SKU</th><th class="r">Kardex Picks (YTD)</th><th class="r">Kardex On-Hand</th><th class="r">NetSuite On-Hand</th><th class="r">Gap</th></tr></thead>
<tbody>
${rows.map(r => `<tr>
  <td>${r.sku}</td>
  <td class="r amb">${r.kPicks.toLocaleString()}</td>
  <td class="r pos">${r.kOnHand.toLocaleString()}</td>
  <td class="r blu">${r.nsOnHand.toLocaleString()}</td>
  <td class="r ${r.gap > 0 ? 'neg' : r.gap < 0 ? 'blu' : ''}">${r.gap.toLocaleString()}</td>
</tr>`).join('\n')}
<tr class="tot">
  <td>TOTAL</td>
  <td class="r amb">${totalKardexPicks.toLocaleString()}</td>
  <td class="r pos">${totalKardexOnHand.toLocaleString()}</td>
  <td class="r blu">${totalNS.toLocaleString()}</td>
  <td class="r neg">${(totalKardexOnHand - totalNS).toLocaleString()}</td>
</tr>
</tbody></table>`;

  const outPath = require('os').homedir() + '/Desktop/semifin_kardex_vs_netsuite.html';
  require('fs').writeFileSync(outPath, html);
  console.log(`\nHTML report: ${outPath}`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
