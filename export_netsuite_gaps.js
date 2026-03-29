const d = require('/tmp/recon_export.json');
const all = d.items || d.discrepancies || d.allItems || [];

// Find every SKU where we had to use prefix/name detection because NetSuite
// didn't classify it correctly. These need fixing in NetSuite's item master.
//
// NetSuite categories come from CLASS_MAP: 1/2=Frames, 3/4=Lenses, 5/6/7/9=Tops, 8/10-13=Other
// If our system classified it via prefix/name but NetSuite has it as 'Other' or doesn't have it,
// that's a gap in the NetSuite item master.

const lines = ['sku,name,our_classification,netsuite_has_it,kardex_qty,netsuite_qty,variance,action_needed'];
let count = 0;

for (const i of all) {
  // We only care about items that are NOT classified by NetSuite as Lenses/Frames/Tops
  // but our system classified them as something real
  const ourCat = i.category;
  const nsQty = i.netsuite || 0;
  const ipQty = i.itempath || 0;

  // If NetSuite has qty > 0, it knows about this SKU (might just have wrong class)
  // If NetSuite has qty = 0, it doesn't have this SKU at all
  const nsHasIt = nsQty > 0 ? 'Yes' : 'No';

  // Skip items already correctly classified in NetSuite (they wouldn't need our prefix logic)
  // We want items where WE classified it but NetSuite either doesn't have it or has it as Other
  if (ourCat === 'Uncategorized' || ourCat === 'Accessories') {
    const name = (i.name || '').replace(/"/g, '').replace(/,/g, ' ');
    const action = nsQty > 0 ? 'Fix class in NetSuite' : 'Add to NetSuite';
    lines.push(i.sku + ',' + name + ',' + ourCat + ',' + nsHasIt + ',' + ipQty + ',' + nsQty + ',' + (i.diff || 0) + ',' + action);
    count++;
  }
}

// Now find SKUs where NetSuite has them but with wrong class (Other)
// These show up as Lenses/Frames/Tops in our system because prefix detection overrode NetSuite
// But NetSuite still has the wrong class
const fs = require('fs');
const reconRaw = fs.readFileSync('/tmp/recon_export.json', 'utf8');

// Count items per our-category that NetSuite doesn't have
const gaps = { Lenses: 0, Frames: 0, Tops: 0 };
for (const i of all) {
  if ((i.category === 'Lenses' || i.category === 'Frames' || i.category === 'Tops') && (i.netsuite || 0) === 0 && (i.itempath || 0) > 0) {
    gaps[i.category] = (gaps[i.category] || 0) + 1;
    const name = (i.name || '').replace(/"/g, '').replace(/,/g, ' ');
    lines.push(i.sku + ',' + name + ',' + i.category + ',No,' + (i.itempath || 0) + ',0,' + (i.itempath || 0) + ',Add to NetSuite as ' + i.category);
    count++;
  }
}

const outPath = require('os').homedir() + '/Desktop/netsuite_item_master_gaps.csv';
fs.writeFileSync(outPath, lines.join('\n'));
console.log(count + ' total gaps exported to ' + outPath);
console.log('Breakdown: Lenses=' + gaps.Lenses + ' Frames=' + gaps.Frames + ' Tops=' + gaps.Tops);
console.log('Plus uncategorized/accessories from above');
