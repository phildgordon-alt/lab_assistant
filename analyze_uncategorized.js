#!/usr/bin/env node
// Run on Mac Studio: node analyze_uncategorized.js
// Hits localhost:3002 reconcile API and breaks down the 29K uncategorized

const http = require('http');

function fetch(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks))); }
        catch (e) { reject(new Error('JSON parse failed: ' + e.message)); }
      });
    }).on('error', reject);
  });
}

async function main() {
  console.log('Fetching reconciliation data...');
  const data = await fetch('http://localhost:3002/api/netsuite/reconcile');

  if (!data.allItems) {
    console.error('No allItems in response. Keys:', Object.keys(data));
    process.exit(1);
  }

  const uncat = data.allItems.filter(i => i.category === 'Uncategorized');
  console.log(`\nTotal uncategorized: ${uncat.length} SKUs, ${Math.round(uncat.reduce((s,i) => s + (i.itempath || 0), 0)).toLocaleString()} units\n`);

  // 1. In NetSuite vs not
  const inNS = uncat.filter(i => (i.netsuite || 0) > 0 || i.className);
  const notInNS = uncat.filter(i => !i.netsuite && !i.className);
  console.log(`In NetSuite (has NS qty or class): ${inNS.length} SKUs`);
  console.log(`NOT in NetSuite: ${notInNS.length} SKUs\n`);

  // 2. GUIDs vs numeric SKUs
  const guidPattern = /^[0-9A-F]{8}-[0-9A-F]{4}/i;
  const guids = uncat.filter(i => guidPattern.test(i.sku));
  const numeric = uncat.filter(i => !guidPattern.test(i.sku));
  console.log(`GUID-format SKUs: ${guids.length} (${Math.round(guids.reduce((s,i) => s + (i.itempath || 0), 0)).toLocaleString()} units)`);
  console.log(`Numeric/other SKUs: ${numeric.length} (${Math.round(numeric.reduce((s,i) => s + (i.itempath || 0), 0)).toLocaleString()} units)\n`);

  // 3. Group numeric by prefix (first 4 chars)
  const byPrefix = {};
  for (const i of numeric) {
    const prefix = (i.sku || '').substring(0, 4);
    if (!byPrefix[prefix]) byPrefix[prefix] = { count: 0, qty: 0, nsQty: 0, samples: [] };
    byPrefix[prefix].count++;
    byPrefix[prefix].qty += (i.itempath || 0);
    byPrefix[prefix].nsQty += (i.netsuite || 0);
    if (byPrefix[prefix].samples.length < 5) byPrefix[prefix].samples.push({ sku: i.sku, name: i.name, ipQty: i.itempath || 0, nsQty: i.netsuite || 0 });
  }
  const sorted = Object.entries(byPrefix).sort((a,b) => b[1].qty - a[1].qty);

  console.log('=== NUMERIC SKUs BY PREFIX (sorted by qty) ===');
  console.log('PREFIX   SKUs    IP QTY       NS QTY       SAMPLE SKUs');
  console.log('------   ----    ----------   ----------   -----------');
  for (const [prefix, d] of sorted) {
    const samples = d.samples.map(s => `${s.sku} "${(s.name || '').substring(0, 35)}" IP:${s.ipQty} NS:${s.nsQty}`).join('\n                                                  ');
    console.log(`${prefix.padEnd(9)}${String(d.count).padEnd(8)}${String(Math.round(d.qty)).padStart(10)}   ${String(Math.round(d.nsQty)).padStart(10)}   ${samples}`);
  }

  // 4. GUID samples
  if (guids.length > 0) {
    console.log('\n=== GUID SKU SAMPLES (top 10 by qty) ===');
    guids.sort((a,b) => (b.itempath || 0) - (a.itempath || 0));
    for (const g of guids.slice(0, 10)) {
      console.log(`  ${g.sku}  name="${g.name || ''}"  IP:${g.itempath || 0}  NS:${g.netsuite || 0}`);
    }
  }

  // 5. Items with qty > 0 (the ones that actually matter)
  const withQty = uncat.filter(i => (i.itempath || 0) > 0 || (i.netsuite || 0) > 0);
  const zeroQty = uncat.filter(i => (i.itempath || 0) === 0 && (i.netsuite || 0) === 0);
  console.log(`\n=== SUMMARY ===`);
  console.log(`With inventory (IP or NS > 0): ${withQty.length} SKUs, ${Math.round(withQty.reduce((s,i) => s + (i.itempath || 0), 0)).toLocaleString()} IP units`);
  console.log(`Zero inventory everywhere:     ${zeroQty.length} SKUs (safe to exclude)`);

  // 6. Export to CSV
  const lines = ['sku,name,category,className,itempath,netsuite,diff,wh1,wh2,wh3'];
  for (const i of uncat.sort((a,b) => (b.itempath || 0) - (a.itempath || 0))) {
    const name = (i.name || '').replace(/"/g, '').replace(/,/g, ' ');
    lines.push(`${i.sku},"${name}",${i.category},${i.className || ''},${i.itempath || 0},${i.netsuite || 0},${i.diff || 0},${i.wh1 || 0},${i.wh2 || 0},${i.wh3 || 0}`);
  }
  const outPath = require('os').homedir() + '/Desktop/uncategorized_breakdown.csv';
  require('fs').writeFileSync(outPath, lines.join('\n'));
  console.log(`\nFull CSV exported to: ${outPath}`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
