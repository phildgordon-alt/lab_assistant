#!/usr/bin/env node
/**
 * Rebuild dvi_jobs and dvi_jobs_history from daily export files.
 * These files are tab-delimited snapshots of ALL jobs in the lab each day.
 * Jobs with Ship Date → dvi_jobs_history (shipped)
 * Jobs without Ship Date → dvi_jobs (active)
 *
 * Uses the LATEST appearance of each job (most recent daily file) as the source of truth.
 * INSERT OR IGNORE so existing records from XML rebuild are preserved.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, 'data', 'lab_assistant.db');
const DAILY_DIR = path.join(__dirname, 'data', 'dvi', 'daily');

const db = new Database(DB_PATH);

function parseDate(dateStr) {
  if (!dateStr) return null;
  const m = dateStr.trim().match(/(\d{2})\/(\d{2})\/(\d{2})/);
  if (!m) return null;
  return `20${m[3]}-${m[1]}-${m[2]}`;
}

function main() {
  const files = fs.readdirSync(DAILY_DIR).filter(f => f.endsWith('.txt')).sort();
  console.log(`Reading ${files.length} daily export files from ${DAILY_DIR}`);

  // Count before
  const beforeActive = db.prepare("SELECT COUNT(*) as cnt FROM dvi_jobs").get().cnt;
  const beforeHistory = db.prepare("SELECT COUNT(*) as cnt FROM dvi_jobs_history").get().cnt;
  console.log(`Before: ${beforeActive} in dvi_jobs, ${beforeHistory} in dvi_jobs_history`);

  // Parse ALL daily files — build a map of job_id → latest record
  // Process files in chronological order so latest file wins
  const allJobs = {}; // job_id → { entryDate, shipDate, daysInLab, coating, rush, dataDate }

  for (const file of files) {
    const filePath = path.join(DAILY_DIR, file);
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    // Extract data date from filename: 260311_D_a_jobdta.txt → 2026-03-11
    const fm = file.match(/(\d{2})(\d{2})(\d{2})/);
    const dataDate = fm ? `20${fm[1]}-${fm[2]}-${fm[3]}` : null;

    let parsed = 0;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const cols = line.split('\t');
      if (cols.length < 17) continue;

      // Column mapping (tab-delimited, 0-indexed):
      // 0: (empty), 1: Shopify #, 2: Enter Date, 3: Ship Date, 4: Days In Proc
      // 5: Fin lens Breakage, 6: Lens Mfr, 7: Blank Size, 8: Sphere Power
      // 9: Cylinder Power, 10: Subcon Vendor, 11: # Jobs, 12: % Breakage
      // 13: (empty), 14: Lens cost, 15: Subcontrac cost, 16: DVI Job#
      const jobId = (cols[16] || '').trim();
      const entryDate = parseDate(cols[2]);
      const shipDate = parseDate(cols[3]);
      const daysInLab = parseFloat(cols[4]) || 0;
      const coating = ''; // col 6 is Lens Mfr, not coating — daily exports have no coating column
      const rush = ''; // not in daily export

      if (!jobId || !entryDate) continue;

      allJobs[jobId] = { jobId, entryDate, shipDate, daysInLab, coating, rush, dataDate };
      parsed++;
    }
    if (parsed > 0) console.log(`  ${file}: ${parsed} job records`);
  }

  const totalJobs = Object.keys(allJobs).length;
  const shipped = Object.values(allJobs).filter(j => j.shipDate);
  const active = Object.values(allJobs).filter(j => !j.shipDate);
  console.log(`\nTotal unique jobs: ${totalJobs} (${active.length} active, ${shipped.length} shipped)`);

  // Insert shipped jobs into dvi_jobs_history (if not already there)
  const histStmt = db.prepare(`
    INSERT OR IGNORE INTO dvi_jobs_history (job_id, invoice, tray, stage, coating, rush, entry_date, days_in_lab, shipped_at)
    VALUES (?, ?, ?, 'SHIPPED', ?, ?, ?, ?, ?)
  `);

  // Insert active jobs into dvi_jobs (if not already there)
  const jobStmt = db.prepare(`
    INSERT OR IGNORE INTO dvi_jobs (id, invoice, tray, stage, station, status, rush, entry_date, days_in_lab, coating, frame_name, data_date, archived, last_sync)
    VALUES (?, ?, ?, 'UNKNOWN', '', 'NEW', ?, ?, ?, ?, '', ?, 0, datetime('now'))
  `);

  // Also update entry_date on existing records that might have wrong dates
  const updateJobDate = db.prepare(`UPDATE dvi_jobs SET entry_date = ? WHERE id = ? AND (entry_date IS NULL OR entry_date = '')`);
  const updateHistDate = db.prepare(`UPDATE dvi_jobs_history SET entry_date = ? WHERE job_id = ? AND (entry_date IS NULL OR entry_date = '')`);

  let insertedHist = 0, insertedJobs = 0, updatedDates = 0;

  const run = db.transaction(() => {
    for (const j of shipped) {
      const r = histStmt.run(j.jobId, j.jobId, j.jobId, j.coating, j.rush, j.entryDate, Math.round(j.daysInLab), j.shipDate);
      if (r.changes > 0) insertedHist++;
      const u = updateHistDate.run(j.entryDate, j.jobId);
      if (u.changes > 0) updatedDates++;
    }
    for (const j of active) {
      const r = jobStmt.run(j.jobId, j.jobId, j.jobId, j.rush, j.entryDate, Math.round(j.daysInLab), j.coating, j.dataDate);
      if (r.changes > 0) insertedJobs++;
      const u = updateJobDate.run(j.entryDate, j.jobId);
      if (u.changes > 0) updatedDates++;
    }
  });
  run();

  const afterActive = db.prepare("SELECT COUNT(*) as cnt FROM dvi_jobs").get().cnt;
  const afterHistory = db.prepare("SELECT COUNT(*) as cnt FROM dvi_jobs_history").get().cnt;

  console.log(`\n=== RESULTS ===`);
  console.log(`Inserted to dvi_jobs: ${insertedJobs}`);
  console.log(`Inserted to dvi_jobs_history: ${insertedHist}`);
  console.log(`Updated entry_dates: ${updatedDates}`);
  console.log(`dvi_jobs: ${beforeActive} → ${afterActive}`);
  console.log(`dvi_jobs_history: ${beforeHistory} → ${afterHistory}`);

  // Show incoming by date for verification
  const byDate = db.prepare(`
    SELECT entry_date,
           SUM(CASE WHEN src='active' THEN cnt ELSE 0 END) as active,
           SUM(CASE WHEN src='history' THEN cnt ELSE 0 END) as shipped,
           SUM(cnt) as total
    FROM (
      SELECT entry_date, COUNT(*) as cnt, 'active' as src FROM dvi_jobs WHERE entry_date >= '2026-03-01' GROUP BY entry_date
      UNION ALL
      SELECT entry_date, COUNT(*) as cnt, 'history' as src FROM dvi_jobs_history WHERE entry_date >= '2026-03-01' GROUP BY entry_date
    ) GROUP BY entry_date ORDER BY entry_date
  `).all();
  console.log('\nIncoming by date (March):');
  for (const r of byDate) console.log(`  ${r.entry_date}: ${r.total} (${r.active} active + ${r.shipped} shipped)`);
}

main();
