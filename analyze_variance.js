#!/usr/bin/env node
// Run on Mac Studio: node analyze_variance.js
// Breaks down the 100K variance between NetSuite and ItemPath

const http = require('http');

function fetch(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks))); }
        catch (e) { reject(new Error('JSON parse failed')); }
      });
    }).on('error', reject);
  });
}

async function main() {
  console.log('Fetching reconciliation data...');
  const data = await fetch('http://localhost:3002/api/netsuite/reconcile');
  if (!data.allItems) { console.error('No data. Keys:', Object.keys(data)); process.exit(1); }

  const items = data.allItems;
  const cats = ['Tops', 'Lenses', 'Frames'];

  for (const cat of cats) {
    const catItems = items.filter(i => i.category === cat);
    const inBoth = catItems.filter(i => (i.itempath || 0) > 0 && (i.netsuite || 0) > 0);
    const ipOnly = catItems.filter(i => (i.itempath || 0) > 0 && (i.netsuite || 0) === 0);
    const nsOnly = catItems.filter(i => (i.itempath || 0) === 0 && (i.netsuite || 0) > 0);
    const zeroZero = catItems.filter(i => (i.itempath || 0) === 0 && (i.netsuite || 0) === 0);

    const bothIP = Math.round(inBoth.reduce((s,i) => s + (i.itempath || 0), 0));
    const bothNS = Math.round(inBoth.reduce((s,i) => s + (i.netsuite || 0), 0));
    const ipOnlyQty = Math.round(ipOnly.reduce((s,i) => s + (i.itempath || 0), 0));
    const nsOnlyQty = Math.round(nsOnly.reduce((s,i) => s + (i.netsuite || 0), 0));

    console.log(`\n${'='.repeat(60)}`);
    console.log(`${cat.toUpperCase()}`);
    console.log(`${'='.repeat(60)}`);
    console.log(`In BOTH systems:     ${inBoth.length} SKUs   IP: ${bothIP.toLocaleString()}   NS: ${bothNS.toLocaleString()}   gap: ${(bothIP - bothNS).toLocaleString()}`);
    console.log(`Kardex ONLY:         ${ipOnly.length} SKUs   IP: ${ipOnlyQty.toLocaleString()}   (NS has 0)`);
    console.log(`NetSuite ONLY:       ${nsOnly.length} SKUs   NS: ${nsOnlyQty.toLocaleString()}   (Kardex has 0)`);
    console.log(`Zero in both:        ${zeroZero.length} SKUs`);

    // Top 10 NS-only by qty
    if (nsOnly.length > 0) {
      console.log(`\n  Top NS-only SKUs (stock NS says is at Irvine 2 but Kardex doesn't have):`);
      nsOnly.sort((a,b) => (b.netsuite || 0) - (a.netsuite || 0));
      for (const i of nsOnly.slice(0, 10)) {
        console.log(`    ${i.sku}  "${(i.name || '').substring(0, 40)}"  NS: ${i.netsuite}`);
      }
    }

    // Top 10 biggest variances in matched SKUs
    if (inBoth.length > 0) {
      console.log(`\n  Top variances in matched SKUs (NS > IP = negative diff):`);
      inBoth.sort((a,b) => (a.diff || 0) - (b.diff || 0));
      for (const i of inBoth.slice(0, 10)) {
        console.log(`    ${i.sku}  "${(i.name || '').substring(0, 40)}"  IP: ${i.itempath}  NS: ${i.netsuite}  diff: ${i.diff}`);
      }
    }
  }

  // Export full detail
  const lines = ['category,sku,name,itempath,netsuite,diff,match_type'];
  for (const i of items.filter(i => cats.includes(i.category)).sort((a,b) => (a.diff || 0) - (b.diff || 0))) {
    const name = (i.name || '').replace(/"/g, '').replace(/,/g, ' ');
    const type = (i.itempath || 0) > 0 && (i.netsuite || 0) > 0 ? 'BOTH' : (i.itempath || 0) > 0 ? 'IP_ONLY' : (i.netsuite || 0) > 0 ? 'NS_ONLY' : 'ZERO';
    lines.push(`${i.category},${i.sku},"${name}",${i.itempath || 0},${i.netsuite || 0},${i.diff || 0},${type}`);
  }
  const outPath = require('os').homedir() + '/Desktop/variance_breakdown.csv';
  require('fs').writeFileSync(outPath, lines.join('\n'));
  console.log(`\nFull CSV: ${outPath}`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
