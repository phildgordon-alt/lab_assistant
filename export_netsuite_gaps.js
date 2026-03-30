// Compare EVERY ItemPath SKU against NetSuite categories
// Finds the full gap — every SKU where NetSuite is wrong or missing
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

const LENS_RE = /^(4800|062|026|001|5[0-9]{3}|8820|1008|1130|1140|2650|3500|6201|6203|6204|CR39)/;
const FRAME_RE = /^(1960|1969|8100|8503|850[0-9])/;

function ourClassification(sku, name) {
  const n = (name || '').toLowerCase();
  if (LENS_RE.test(sku)) return 'Lenses';
  if (FRAME_RE.test(sku)) {
    if (n.includes('top')) return 'Tops';
    return 'Frames';
  }
  if (n.includes('top') || n.includes('blank top') || n.includes('crystal clear')) return 'Tops';
  if (n.includes('lens') || n.includes('sv ') || n.includes('poly') || n.includes('h67') || n.includes('b67') || n.includes('bly')) return 'Lenses';
  if (n.includes('frame') || n.includes('glasses')) return 'Frames';
  return 'Unknown';
}

async function main() {
  const BASE = 'http://localhost:3002';

  // Get ALL ItemPath materials
  const ipData = await fetch(BASE + '/api/inventory');
  const materials = ipData.materials || [];

  // Get ALL NetSuite categories
  const nsCats = await fetch(BASE + '/api/netsuite/categories');

  const lines = ['sku,name,qty,netsuite_category,our_classification,match,action'];
  let gapCount = 0;
  let matchCount = 0;
  let notInNS = 0;
  let wrongClass = 0;

  for (const m of materials) {
    const sku = m.sku;
    if (!sku) continue;
    const name = (m.name || '').replace(/"/g, '').replace(/,/g, ' ');
    const qty = m.qty || 0;
    const nsRaw = nsCats[sku] || null;
    const ours = ourClassification(sku, m.name);

    if (!nsRaw) {
      // Not in NetSuite at all
      lines.push(sku + ',' + name + ',' + qty + ',NOT IN NETSUITE,' + ours + ',NO,Add to NetSuite as ' + ours);
      gapCount++;
      notInNS++;
    } else if (nsRaw === 'Other') {
      // In NetSuite but wrong class
      lines.push(sku + ',' + name + ',' + qty + ',Other,' + ours + ',NO,Change class to ' + ours);
      gapCount++;
      wrongClass++;
    } else if (nsRaw !== ours && ours !== 'Unknown') {
      // In NetSuite but we disagree on category
      lines.push(sku + ',' + name + ',' + qty + ',' + nsRaw + ',' + ours + ',VERIFY,Check: NS=' + nsRaw + ' vs Computed=' + ours);
      gapCount++;
    } else {
      matchCount++;
    }
  }

  const outPath = os.homedir() + '/Desktop/netsuite_item_master_gaps.csv';
  fs.writeFileSync(outPath, lines.join('\n'));
  console.log('');
  console.log('=== NetSuite Item Master Gap Analysis ===');
  console.log('Total Kardex/ItemPath SKUs: ' + materials.length);
  console.log('NetSuite categories loaded: ' + Object.keys(nsCats).length);
  console.log('');
  console.log('Matches (NetSuite agrees): ' + matchCount);
  console.log('NOT IN NETSUITE: ' + notInNS);
  console.log('Wrong class (Other): ' + wrongClass);
  console.log('Total gaps: ' + gapCount);
  console.log('');
  console.log('Exported to ' + outPath);
}

main().catch(e => console.error(e.message));
