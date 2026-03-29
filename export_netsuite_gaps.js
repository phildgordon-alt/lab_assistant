// Fetches NetSuite raw categories AND our computed categories
// Finds every SKU where they disagree — those are the NetSuite item master gaps
const http = require('http');
const fs = require('fs');
const os = require('os');

function fetch(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

async function main() {
  const BASE = 'http://localhost:3002';

  // 1. NetSuite raw categories (what NetSuite thinks each SKU is)
  const nsCats = await fetch(BASE + '/api/netsuite/categories');

  // 2. Reconciliation (what our system computed, plus ItemPath qtys)
  const recon = await fetch(BASE + '/api/netsuite/reconcile');
  const allItems = recon.items || recon.discrepancies || recon.allItems || [];

  const lines = ['sku,name,netsuite_raw_category,our_computed_category,match,kardex_qty,netsuite_qty,action'];
  let gapCount = 0;

  for (const item of allItems) {
    const sku = item.sku;
    const nsRaw = nsCats[sku] || 'NOT IN NETSUITE';
    const ours = item.category || 'Unknown';
    const ipQty = item.itempath || 0;
    const nsQty = item.netsuite || 0;
    const name = (item.name || '').replace(/"/g, '').replace(/,/g, ' ');

    // Gap = NetSuite doesn't match what we computed
    const isMatch = nsRaw === ours;

    if (!isMatch) {
      let action = '';
      if (nsRaw === 'NOT IN NETSUITE') action = 'Add to NetSuite as ' + ours;
      else if (nsRaw === 'Other') action = 'Change class from Other to ' + ours;
      else action = 'Verify: NS says ' + nsRaw + ' but we computed ' + ours;

      lines.push(sku + ',' + name + ',' + nsRaw + ',' + ours + ',NO,' + ipQty + ',' + nsQty + ',' + action);
      gapCount++;
    }
  }

  const outPath = os.homedir() + '/Desktop/netsuite_item_master_gaps.csv';
  fs.writeFileSync(outPath, lines.join('\n'));
  console.log('Total SKUs checked: ' + allItems.length);
  console.log('NetSuite gaps: ' + gapCount);
  console.log('Exported to ' + outPath);
}

main().catch(e => console.error(e.message));
