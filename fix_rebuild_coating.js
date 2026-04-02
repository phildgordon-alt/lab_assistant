#!/usr/bin/env node
/**
 * Fix coating field on dvi_jobs_history rows inserted by rebuild_dvi_from_daily.js.
 * The rebuild script stored Lens Mfr (col 6) as coating instead of actual coating.
 * This script cross-references shipped XML files to get the correct coating value.
 *
 * Targets only rows with recorded_at from the April 1 rebuild batch.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, 'data', 'lab_assistant.db');
const SHIPPED_DIR = path.join(__dirname, 'data', 'dvi', 'shipped');

const db = new Database(DB_PATH);

// Reuse the same XML parsing logic as oven-timer-server.js
function getCoatingFromXml(xml) {
  const rightEyeBlock = xml.match(/<RightEye[^>]*(?:\/>|>[\s\S]*?<\/RightEye>)/);
  const leftEyeBlock = xml.match(/<LeftEye[^>]*(?:\/>|>[\s\S]*?<\/LeftEye>)/);
  const lensBlock = xml.match(/<Lens[^>]*>([\s\S]*?)<\/Lens>/);
  const eyeXml = rightEyeBlock ? rightEyeBlock[0] : (leftEyeBlock ? leftEyeBlock[0] : '');
  const lensXml = lensBlock ? lensBlock[0] : '';

  const getEyeAttr = (attr) => { const m = eyeXml.match(new RegExp(`\\s${attr}="([^"]*)"`)); return m ? m[1] : null; };
  const getLens = (tag) => {
    const attrVal = getEyeAttr(tag);
    if (attrVal) return attrVal;
    const eyeChild = eyeXml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`));
    if (eyeChild) return eyeChild[1].trim();
    const lensChild = lensXml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`));
    return lensChild ? lensChild[1].trim() : null;
  };
  const get = (tag) => { const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`)); return m ? m[1].trim() : null; };

  return getLens('Coat') || get('Coat') || '';
}

function main() {
  // Get all rebuild rows that need coating fixed
  const rows = db.prepare(
    "SELECT id, job_id, coating FROM dvi_jobs_history WHERE recorded_at LIKE '2026-04-01 14:28%'"
  ).all();

  console.log(`Found ${rows.length} rebuild rows to check`);

  // Build a map of XML coatings from shipped files
  const xmlCoatings = new Map();
  if (fs.existsSync(SHIPPED_DIR)) {
    const files = fs.readdirSync(SHIPPED_DIR).filter(f => f.endsWith('.xml'));
    console.log(`Reading ${files.length} shipped XML files...`);
    for (const file of files) {
      try {
        const jobNum = path.basename(file, '.xml');
        const xml = fs.readFileSync(path.join(SHIPPED_DIR, file), 'utf8');
        const coating = getCoatingFromXml(xml);
        if (coating) xmlCoatings.set(jobNum, coating);
      } catch (e) { /* skip bad files */ }
    }
    console.log(`Parsed coatings for ${xmlCoatings.size} jobs from XML files`);
  } else {
    console.log(`WARNING: ${SHIPPED_DIR} not found`);
  }

  // Update coating from XML data
  const updateStmt = db.prepare("UPDATE dvi_jobs_history SET coating = ? WHERE id = ?");
  let updated = 0, notFound = 0, alreadyCorrect = 0;

  const run = db.transaction(() => {
    for (const row of rows) {
      const xmlCoating = xmlCoatings.get(row.job_id);
      if (xmlCoating) {
        if (row.coating === xmlCoating) {
          alreadyCorrect++;
        } else {
          updateStmt.run(xmlCoating, row.id);
          updated++;
        }
      } else {
        // No XML file — clear the bad manufacturer value
        if (row.coating && row.coating !== '') {
          updateStmt.run('', row.id);
          updated++;
        }
        notFound++;
      }
    }
  });
  run();

  console.log(`\n=== RESULTS ===`);
  console.log(`Updated coating: ${updated}`);
  console.log(`Already correct: ${alreadyCorrect}`);
  console.log(`No XML file found (coating cleared): ${notFound}`);

  // Show coating distribution after fix
  const dist = db.prepare(
    "SELECT coating, COUNT(*) as cnt FROM dvi_jobs_history WHERE recorded_at LIKE '2026-04-01 14:28%' GROUP BY coating ORDER BY cnt DESC"
  ).all();
  console.log('\nCoating distribution (rebuild rows after fix):');
  for (const r of dist) console.log(`  ${r.coating || '(empty)'}: ${r.cnt}`);
}

main();
