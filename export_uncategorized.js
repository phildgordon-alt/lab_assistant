const d = require('/tmp/recon_export.json');
const items = (d.items || []).filter(i => i.category === 'Uncategorized');
const lines = ['sku,name,kardex_qty,netsuite_qty,variance'];
for (const i of items) {
  const name = (i.name || '').replace(/"/g, '').replace(/,/g, ' ');
  lines.push(i.sku + ',' + name + ',' + (i.itempath || 0) + ',' + (i.netsuite || 0) + ',' + (i.diff || 0));
}
const outPath = require('os').homedir() + '/Desktop/uncategorized_skus.csv';
require('fs').writeFileSync(outPath, lines.join('\n'));
console.log(items.length + ' SKUs exported to ' + outPath);
