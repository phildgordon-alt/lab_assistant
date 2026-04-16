const db = require('../server/db');
const rows = db.db.prepare(`
  SELECT date(completed_at) as d, COUNT(*) as picks, COUNT(DISTINCT sku) as skus, SUM(qty) as total_qty
  FROM picks_history
  WHERE completed_at >= date('now', '-20 days')
  GROUP BY date(completed_at)
  ORDER BY d DESC
`).all();
console.log('Date          Picks   SKUs   TotalQty');
console.log('─'.repeat(45));
rows.forEach(r => {
  const flag = r.picks > 5000 ? ' ← HIGH' : '';
  console.log(`${r.d}   ${String(r.picks).padStart(5)}   ${String(r.skus).padStart(4)}   ${String(r.total_qty).padStart(8)}${flag}`);
});
