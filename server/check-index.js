// Direct test: load shipped index the same way the server does, count by date
const fs = require('fs');
const path = require('path');

const DVI_SHIPPED_DIR = path.join(__dirname, '..', 'data', 'dvi', 'shipped');

// Copy the exact parseDviXml function from oven-timer-server.js
function parseDviXml(xml) {
  const get = (tag) => { const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`)); return m ? m[1].trim() : null; };
  const getAttr = (tag, attr) => { const m = xml.match(new RegExp(`<${tag}[^>]*\\s${attr}="([^"]*)"`)); return m ? m[1] : null; };
  const shipDate = getAttr('OrderData', 'ShipDate');
  const shipTime = getAttr('OrderData', 'ShipTime');
  const entryDate = getAttr('OrderData', 'EntryDate');
  const invoice = getAttr('OrderData', 'Invoice');
  return { shipDate, shipTime, entryDate, invoice };
}

const files = fs.readdirSync(DVI_SHIPPED_DIR).filter(f => f.endsWith('.xml'));
console.log('Total XML files:', files.length);

let hasShipDate = 0;
let hasCycleDate = 0;
let hasBoth = 0;
let hasNeither = 0;
let mismatch = 0;
const byShipDate = {};
const byCycleDate = {};
const byFinal = {};

for (const file of files) {
  try {
    const xml = fs.readFileSync(path.join(DVI_SHIPPED_DIR, file), 'utf8');
    const parsed = parseDviXml(xml);
    const cycleDate = (xml.match(/CycleDate="([^"]*)"/)||[])[1] || null;

    const sd = parsed.shipDate;
    const cd = cycleDate;

    if (sd && cd) hasBoth++;
    else if (sd) hasShipDate++;
    else if (cd) hasCycleDate++;
    else hasNeither++;

    if (sd && cd && sd !== cd) mismatch++;

    if (sd) byShipDate[sd] = (byShipDate[sd] || 0) + 1;
    if (cd) byCycleDate[cd] = (byCycleDate[cd] || 0) + 1;

    // What the server currently uses: parsed.shipDate || cycleDate
    const final = sd || cd;
    if (final) byFinal[final] = (byFinal[final] || 0) + 1;
  } catch (e) {}
}

console.log('\nField availability:');
console.log('  Both ShipDate+CycleDate:', hasBoth);
console.log('  ShipDate only:', hasShipDate);
console.log('  CycleDate only:', hasCycleDate);
console.log('  Neither:', hasNeither);
console.log('  Mismatched dates:', mismatch);

console.log('\nBy ShipDate (top 15):');
Object.entries(byShipDate).sort((a,b) => b[0].localeCompare(a[0])).slice(0,15).forEach(([d,c]) => console.log(' ', d, ':', c));

console.log('\nBy CycleDate (top 15):');
Object.entries(byCycleDate).sort((a,b) => b[0].localeCompare(a[0])).slice(0,15).forEach(([d,c]) => console.log(' ', d, ':', c));

console.log('\nBy Final (ShipDate||CycleDate) (top 15):');
Object.entries(byFinal).sort((a,b) => b[0].localeCompare(a[0])).slice(0,15).forEach(([d,c]) => console.log(' ', d, ':', c));
