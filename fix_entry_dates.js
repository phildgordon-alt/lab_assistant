#!/usr/bin/env node
// Fix entry_dates in dvi_jobs_history from XML source data
// Reads <Date> from each job XML and updates the history table

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.argv[2] || path.join(__dirname, 'data', 'lab_assistant.db');
const JOBS_DIR = path.join(path.dirname(DB_PATH), 'dvi', 'jobs');

const db = new Database(DB_PATH);

function parseDate(dateStr) {
  // Format: MM/DD/YY
  const m = dateStr.match(/(\d{2})\/(\d{2})\/(\d{2})/);
  if (!m) return null;
  return `2026-${m[1]}-${m[2]}`;  // Assuming 20XX century
}

function main() {
  const files = fs.readdirSync(JOBS_DIR).filter(f => f.endsWith('.xml'));
  console.log(`Reading ${files.length} XML files from ${JOBS_DIR}`);

  // Build job_id → entry_date map from XMLs
  const dateMap = {};
  let parsed = 0, failed = 0;
  for (const file of files) {
    try {
      const xml = fs.readFileSync(path.join(JOBS_DIR, file), 'utf8');
      const dateMatch = xml.match(/<Date>([^<]+)<\/Date>/);
      const invoiceMatch = xml.match(/<RmtInv>([^<]+)<\/RmtInv>/) || xml.match(/<Invoice>([^<]+)<\/Invoice>/);
      if (dateMatch && invoiceMatch) {
        const entryDate = parseDate(dateMatch[1].trim());
        const jobId = invoiceMatch[1].trim();
        if (entryDate) {
          dateMap[jobId] = entryDate;
          parsed++;
        }
      }
    } catch { failed++; }
  }
  console.log(`Parsed ${parsed} dates, ${failed} failed`);

  // Show current state
  const before = db.prepare(`
    SELECT entry_date, COUNT(*) as cnt FROM dvi_jobs_history
    WHERE entry_date >= '2026-03-01' GROUP BY entry_date ORDER BY entry_date
  `).all();
  console.log('\nBEFORE (history):');
  for (const r of before) console.log(`  ${r.entry_date}: ${r.cnt}`);

  // Update dvi_jobs_history
  const updateHist = db.prepare('UPDATE dvi_jobs_history SET entry_date = ? WHERE invoice = ?');
  const updateJobs = db.prepare('UPDATE dvi_jobs SET entry_date = ? WHERE invoice = ?');
  let updated = 0;
  const run = db.transaction(() => {
    for (const [jobId, entryDate] of Object.entries(dateMap)) {
      const r1 = updateHist.run(entryDate, jobId);
      const r2 = updateJobs.run(entryDate, jobId);
      if (r1.changes > 0 || r2.changes > 0) updated++;
    }
  });
  run();
  console.log(`\nUpdated ${updated} jobs`);

  // Show after
  const after = db.prepare(`
    SELECT entry_date, COUNT(*) as cnt FROM dvi_jobs_history
    WHERE entry_date >= '2026-03-01' GROUP BY entry_date ORDER BY entry_date
  `).all();
  console.log('\nAFTER (history):');
  for (const r of after) console.log(`  ${r.entry_date}: ${r.cnt}`);
}

main();
