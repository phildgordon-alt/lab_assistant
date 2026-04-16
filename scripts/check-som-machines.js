const db = require('../server/db');
const rows = db.db.prepare('SELECT id, category, status, status_label, severity FROM som_devices ORDER BY category, id').all();
console.log('SOM devices in SQLite:', rows.length);
const byCat = {};
rows.forEach(r => {
  if (!byCat[r.category]) byCat[r.category] = [];
  byCat[r.category].push(r.id);
});
Object.entries(byCat).sort().forEach(([cat, ids]) => {
  console.log(`  ${cat} (${ids.length}): ${ids.join(', ')}`);
});
