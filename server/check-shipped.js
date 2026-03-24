const fs = require('fs');
const path = require('path');
const dir = '/Users/Shared/lab_assistant/data/dvi/shipped';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.xml'));
let byDate = {};
let noDate = 0;
let parseErr = 0;
for (const f of files) {
  try {
    const xml = fs.readFileSync(path.join(dir, f), 'utf8');
    const cd = xml.match(/CycleDate="([^"]*)"/);
    if (cd) {
      byDate[cd[1]] = (byDate[cd[1]] || 0) + 1;
    } else {
      noDate++;
    }
  } catch (e) { parseErr++; }
}
console.log('Files:', files.length, 'noDate:', noDate, 'parseErr:', parseErr);
console.log('By CycleDate:');
Object.entries(byDate).sort((a,b) => b[0].localeCompare(a[0])).forEach(([d,c]) => console.log(' ', d, ':', c));
