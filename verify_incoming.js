#!/usr/bin/env node
// Compare incoming counts: daily export files vs database
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, 'data', 'lab_assistant.db');
const DAILY_DIR = path.join(__dirname, 'data', 'dvi', 'daily');
const db = new Database(DB_PATH);

function parseDate(s) {
  const m = (s||'').trim().match(/(\d{2})\/(\d{2})\/(\d{2})/);
  return m ? `20${m[3]}-${m[1]}-${m[2]}` : null;
}

// Build truth from daily files: unique jobs by Enter Date
const jobsByEntryDate = {};
const seenJobs = new Set();
const files = fs.readdirSync(DAILY_DIR).filter(f => f.endsWith('.txt')).sort();
for (const file of files) {
  const lines = fs.readFileSync(path.join(DAILY_DIR, file), 'utf8').split('\n');
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t');
    if (cols.length < 17) continue;
    const jobId = (cols[16] || '').trim();  // Column 17 (0-indexed: 16) = DVI Job#
    const entryDate = parseDate(cols[2]);   // Column 3 (0-indexed: 2) = Enter Date
    if (!jobId || !entryDate || seenJobs.has(jobId)) continue;
    seenJobs.add(jobId);
    jobsByEntryDate[entryDate] = (jobsByEntryDate[entryDate] || 0) + 1;
  }
}

// Get database counts (same query as the /api/dvi/incoming endpoint)
const active = db.prepare("SELECT entry_date, COUNT(*) as cnt FROM dvi_jobs WHERE entry_date IS NOT NULL GROUP BY entry_date").all();
const history = db.prepare("SELECT entry_date, COUNT(*) as cnt FROM dvi_jobs_history WHERE entry_date IS NOT NULL GROUP BY entry_date").all();
const dbCounts = {};
for (const r of active) dbCounts[r.entry_date] = (dbCounts[r.entry_date] || 0) + r.cnt;
for (const r of history) dbCounts[r.entry_date] = (dbCounts[r.entry_date] || 0) + r.cnt;

// Compare
const allDates = [...new Set([...Object.keys(jobsByEntryDate), ...Object.keys(dbCounts)])].sort();
console.log('DATE         DAILY FILES   DATABASE   DIFF');
console.log('-----------  -----------   --------   ----');
for (const d of allDates) {
  if (d < '2026-01-01') continue;
  const truth = jobsByEntryDate[d] || 0;
  const db_ = dbCounts[d] || 0;
  const diff = db_ - truth;
  const flag = Math.abs(diff) > 10 ? ' <<<' : '';
  console.log(`${d}  ${String(truth).padStart(11)}   ${String(db_).padStart(8)}   ${(diff >= 0 ? '+' : '') + diff}${flag}`);
}
