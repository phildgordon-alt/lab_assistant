const db = require('../server/db');
const rows = db.db.prepare('SELECT completed_at, pick_id FROM picks_history ORDER BY completed_at DESC LIMIT 5').all();
console.log('Newest picks:');
rows.forEach(r => console.log(' ', r.completed_at, r.pick_id));
const total = db.db.prepare('SELECT COUNT(*) as n FROM picks_history').get();
console.log('Total:', total.n);
