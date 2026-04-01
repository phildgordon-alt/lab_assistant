#!/usr/bin/env node
// Rebuild dvi_jobs from XML files — restores jobs lost during server restarts
// Reads every XML in data/dvi/jobs/, extracts job data, inserts into dvi_jobs
// Uses INSERT OR IGNORE so existing records are preserved

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, 'data', 'lab_assistant.db');
const JOBS_DIR = path.join(__dirname, 'data', 'dvi', 'jobs');

const db = new Database(DB_PATH);

function parseXml(xml, filename) {
  const get = (tag) => { const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`)); return m ? m[1].trim() : null; };
  const invoice = get('RmtInv') || get('Invoice') || filename.replace('.xml', '');
  const tray = get('Tray') || invoice;
  const dateRaw = get('Date');
  let entryDate = null;
  if (dateRaw) {
    const m = dateRaw.match(/(\d{2})\/(\d{2})\/(\d{2})/);
    if (m) entryDate = `20${m[3]}-${m[1]}-${m[2]}`;
  }
  const coating = get('Coat') || 'AR';
  const rush = xml.includes('RUSH') || xml.includes('rush') ? 'Y' : 'N';
  return { invoice, tray, entryDate, coating, rush };
}

function main() {
  const files = fs.readdirSync(JOBS_DIR).filter(f => f.endsWith('.xml'));
  console.log(`Reading ${files.length} XML files from ${JOBS_DIR}`);

  // Count before
  const beforeActive = db.prepare("SELECT COUNT(*) as cnt FROM dvi_jobs WHERE archived=0").get().cnt;
  const beforeHistory = db.prepare("SELECT COUNT(*) as cnt FROM dvi_jobs_history").get().cnt;
  console.log(`Before: ${beforeActive} active, ${beforeHistory} history`);

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO dvi_jobs (id, invoice, tray, stage, station, status, rush, entry_date, days_in_lab, coating, frame_name, data_date, archived, last_sync)
    VALUES (?, ?, ?, 'UNKNOWN', '', 'NEW', ?, ?, 0, ?, '', ?, 0, datetime('now'))
  `);

  let inserted = 0, skipped = 0, errors = 0;
  const run = db.transaction(() => {
    for (const file of files) {
      try {
        const xml = fs.readFileSync(path.join(JOBS_DIR, file), 'utf8');
        const job = parseXml(xml, file);
        if (!job.invoice || !job.entryDate) { skipped++; continue; }
        const result = stmt.run(job.invoice, job.invoice, job.tray, job.rush, job.entryDate, job.coating, job.entryDate);
        if (result.changes > 0) inserted++;
        else skipped++;
      } catch (e) { errors++; }
    }
  });
  run();

  const afterActive = db.prepare("SELECT COUNT(*) as cnt FROM dvi_jobs WHERE archived=0").get().cnt;
  console.log(`\nInserted: ${inserted}, Skipped (already exists): ${skipped}, Errors: ${errors}`);
  console.log(`After: ${afterActive} active (was ${beforeActive})`);

  // Show counts by entry_date
  const byDate = db.prepare(`
    SELECT entry_date, COUNT(*) as cnt FROM dvi_jobs WHERE archived=0 AND entry_date >= '2026-03-01'
    GROUP BY entry_date ORDER BY entry_date
  `).all();
  console.log('\nActive jobs by entry date (March):');
  for (const r of byDate) console.log(`  ${r.entry_date}: ${r.cnt}`);
}

main();
