const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const db = new Database(path.join(__dirname, 'data', 'lab_assistant.db'));

// Pass file path as argument, or place in data/ directory
const FILE = process.argv[2] || path.join(__dirname, 'data', 'History_List_YTD_All.txt');

function parseCSV(text) {
  const lines = text.split('\n');
  const headers = lines[0].split(',');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const vals = line.split(',');
    const row = {};
    for (let j = 0; j < headers.length; j++) row[headers[j].trim()] = (vals[j] || '').trim();
    rows.push(row);
  }
  return rows;
}

function main() {
  const raw = fs.readFileSync(FILE, 'utf8');
  const rows = parseCSV(raw);
  console.log(`Loaded ${rows.length} rows from CSV`);

  // Filter: type=4, confirmed qty > 0
  const picks = rows.filter(r => r.Type === '4' && parseFloat(r['Confirmed Quantity']) > 0);
  console.log(`Confirmed type-4 picks: ${picks.length}`);

  const jobPicks = picks.filter(r => /^\d+$/.test(r['Order Name']));
  const manualPicks = picks.filter(r => !/^\d+$/.test(r['Order Name']));
  console.log(`  Job picks (numeric order name): ${jobPicks.length}`);
  console.log(`  Manual/special picks: ${manualPicks.length}`);

  // Delete old backfill records for the date range
  const dates = picks.map(r => r.Date.slice(0, 10)).sort();
  const minDate = dates[0];
  const maxDate = dates[dates.length - 1];
  console.log(`\nDate range: ${minDate} to ${maxDate}`);

  const oldBackfill = db.prepare(`SELECT COUNT(*) as cnt FROM picks_history WHERE order_id = 'backfill' AND date(completed_at) >= ? AND date(completed_at) <= ?`).get(minDate, maxDate);
  console.log(`Old backfill records to remove: ${oldBackfill.cnt}`);

  // Also count old tx- records from the live adapter
  const oldTx = db.prepare(`SELECT COUNT(*) as cnt FROM picks_history WHERE pick_id LIKE 'tx-%' AND date(completed_at) >= ? AND date(completed_at) <= ?`).get(minDate, maxDate);
  console.log(`Old tx- records to remove: ${oldTx.cnt}`);

  // Count existing non-backfill, non-tx records
  const existingOther = db.prepare(`SELECT COUNT(*) as cnt FROM picks_history WHERE order_id != 'backfill' AND pick_id NOT LIKE 'tx-%' AND date(completed_at) >= ? AND date(completed_at) <= ?`).get(minDate, maxDate);
  console.log(`Existing other records (keep): ${existingOther.cnt}`);

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO picks_history (pick_id, order_id, sku, name, qty, picked, warehouse, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let inserted = 0;
  let skipped = 0;

  const doImport = db.transaction(() => {
    // Remove old backfill and tx- records
    db.prepare(`DELETE FROM picks_history WHERE order_id = 'backfill' AND date(completed_at) >= ? AND date(completed_at) <= ?`).run(minDate, maxDate);
    db.prepare(`DELETE FROM picks_history WHERE pick_id LIKE 'tx-%' AND date(completed_at) >= ? AND date(completed_at) <= ?`).run(minDate, maxDate);

    for (const r of picks) {
      const sku = r['Material Reference'] || '';
      const qty = parseFloat(r['Confirmed Quantity']) || 0;
      if (!sku || qty <= 0) { skipped++; continue; }

      const id = r.Id || '';
      const orderName = r['Order Name'] || '';
      const historyMasterId = r['HistoryMasterOrder ID'] || '';
      const storageUnit = r['Storage Unit Name'] || '';
      const completedAt = r.Date || '';

      // Determine warehouse from Storage Unit Name
      let wh = '';
      if (/CAR-1|CAR-2|CAR-3/i.test(storageUnit)) wh = 'WH1';
      else if (/CAR-4|CAR-5|CAR-6/i.test(storageUnit)) wh = 'WH2';
      else if (/KITCHEN/i.test(storageUnit)) wh = 'WH3';

      // Pick ID: use the unique transaction Id
      const pickId = `hist-${id}`;

      // Order ID: job number for job picks, historyMasterId for manual
      const orderId = /^\d+$/.test(orderName) ? orderName : historyMasterId || orderName;

      const result = insertStmt.run(pickId, orderId, sku, orderName, qty, qty, wh, completedAt);
      if (result.changes > 0) inserted++;
      else skipped++;
    }
  });

  doImport();

  console.log(`\n=== RESULTS ===`);
  console.log(`Inserted: ${inserted}`);
  console.log(`Skipped (duplicate or invalid): ${skipped}`);

  // Verify by month
  const byMonth = db.prepare(`
    SELECT substr(date(completed_at),1,7) as month, COUNT(*) as cnt, SUM(qty) as total
    FROM picks_history
    WHERE date(completed_at) >= ? AND date(completed_at) <= ?
    GROUP BY month ORDER BY month
  `).all(minDate, maxDate);
  console.log('\nPicks by month after import:');
  for (const r of byMonth) console.log(`  ${r.month}: ${r.cnt} picks, ${r.total} units`);

  // Check a specific SKU
  const check = db.prepare(`
    SELECT COUNT(*) as cnt, SUM(qty) as total FROM picks_history WHERE sku = '4800150916' AND date(completed_at) >= ?
  `).get(minDate);
  console.log(`\n4800150916 check: ${check.cnt} picks, ${check.total} units`);
}

main();
