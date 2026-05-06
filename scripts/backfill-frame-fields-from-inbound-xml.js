#!/usr/bin/env node
'use strict';

/**
 * One-shot backfill: extract frame_upc / frame_name / frame_material /
 * frame_color / edge_type from inbound DVI XMLs (data/dvi/jobs/<invoice>.xml)
 * and apply to existing active jobs in the unified jobs table.
 *
 * Background: pre-2026-05-06, oven-timer-server.js's parseDviXml only
 * extracted frame metadata via attribute regexes (`<Frame UPC="..."`),
 * which works for SHIPLOG XML (post-assembly, attribute-shaped) but
 * misses the inbound per-job XML (which uses child elements like
 * <Frame><SKU>196016455467</SKU>...</Frame>). Result: 2,592 active jobs
 * with frame_upc=NULL on the unified row, even though every one has an
 * XML on disk that contains the frame SKU. This script reparses every
 * inbound XML and routes frame fields through jobsRepo.upsert with
 * source='xml-classification', honoring the contract's first-non-null-
 * wins semantics so SHIPLOG-attributed values aren't overwritten.
 *
 * Usage:
 *   node scripts/backfill-frame-fields-from-inbound-xml.js          # dry run
 *   node scripts/backfill-frame-fields-from-inbound-xml.js --apply  # commit
 *   node scripts/backfill-frame-fields-from-inbound-xml.js --apply --limit 100
 *
 * Targets active rows with NULL frame_upc OR NULL frame_name. Skips
 * jobs whose inbound XML can't be found on disk (some old XMLs rotate
 * off the SMB share).
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.LAB_DB || '/Users/Shared/lab_assistant/data/lab_assistant.db';
const JOBS_DIR = process.env.DVI_JOBS_DIR || '/Users/Shared/lab_assistant/data/dvi/jobs';
const APPLY = process.argv.includes('--apply');
const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg > -1 ? parseInt(process.argv[limitArg + 1], 10) || 0 : 0;

if (!fs.existsSync(DB_PATH))   { console.error('DB not found:', DB_PATH); process.exit(1); }
if (!fs.existsSync(JOBS_DIR))  { console.error('Jobs dir not found:', JOBS_DIR); process.exit(1); }

const db = new Database(DB_PATH);

const { runMigrations } = require('../server/migration-runner');
const { createRepo } = require('../server/domain/jobs-repo');
if (APPLY) runMigrations(db);
const jobsRepo = APPLY ? createRepo(db) : null;

// Inline frame parser — same logic as oven-timer-server.js parseDviXml's
// post-fix frame-field extraction. Kept self-contained so this script
// doesn't have to require the entire server module (which would open
// the prod DB on import and conflict with our own handle).
function parseFrameFromXml(xml) {
  const frameBlock = xml.match(/<Frame[^>]*>([\s\S]*?)<\/Frame>/) || xml.match(/<Frame[^>]*\/>/);
  const frameXml = frameBlock ? frameBlock[0] : '';
  const getFrame = (tag) => {
    const m = frameXml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`));
    return m ? m[1].trim() : null;
  };
  const _trim = v => (typeof v === 'string' ? v.trim() : v) || null;
  return {
    frame_upc:   _trim(((frameXml || '').match(/\sUPC="([^"]*)"/) || [])[1])   || _trim(getFrame('SKU'))      || _trim(getFrame('UPC'))      || null,
    frame_name:  _trim(((frameXml || '').match(/\sName="([^"]*)"/) || [])[1])  || _trim(getFrame('Name'))     || null,
    frame_style: _trim(getFrame('Style')) || null,
    frame_color: _trim(((frameXml || '').match(/\sColor="([^"]*)"/) || [])[1]) || _trim(getFrame('Color'))    || null,
  };
}

const candidates = db.prepare(`
  SELECT invoice
  FROM jobs
  WHERE status IN ('ACTIVE','Active')
    AND (frame_upc IS NULL OR frame_upc = '')
  ORDER BY invoice DESC
  ${LIMIT > 0 ? `LIMIT ${LIMIT}` : ''}
`).all();

console.log(`[frame-backfill] candidates: ${candidates.length}`);
console.log(`[frame-backfill] mode: ${APPLY ? 'APPLY' : 'DRY-RUN — pass --apply to commit'}`);

const stats = {
  examined: 0, xmlMissing: 0, parseError: 0, noFrame: 0,
  wouldFill: 0, filled: 0, errors: 0,
  byKind: { frame_upc: 0, frame_name: 0, frame_style: 0, frame_color: 0 },
};

for (const r of candidates) {
  stats.examined++;
  const xmlPath = path.join(JOBS_DIR, `${r.invoice}.xml`);
  if (!fs.existsSync(xmlPath)) { stats.xmlMissing++; continue; }
  let xml;
  try { xml = fs.readFileSync(xmlPath, 'utf8'); }
  catch { stats.parseError++; continue; }

  let parsed;
  try { parsed = parseFrameFromXml(xml); }
  catch { stats.parseError++; continue; }

  if (!parsed.frame_upc && !parsed.frame_name && !parsed.frame_style && !parsed.frame_color) {
    stats.noFrame++;
    continue;
  }
  stats.wouldFill++;
  for (const k of Object.keys(parsed)) if (parsed[k]) stats.byKind[k]++;

  if (!APPLY) continue;

  try {
    jobsRepo.upsert({
      invoice: String(r.invoice),
      patch: {
        frame_upc: parsed.frame_upc,
        frame_name: parsed.frame_name,
        frame_style: parsed.frame_style,
        frame_color: parsed.frame_color,
      },
      source: 'xml-classification',
      observedAt: Date.now(),
      actor: 'backfill:frame-fields-from-inbound-xml',
      metadata: { xml_source: 'data/dvi/jobs' },
    });
    stats.filled++;
  } catch (e) {
    stats.errors++;
    console.error(`[frame-backfill] upsert failed for ${r.invoice}: ${e.message}`);
  }
}

console.log(`[frame-backfill] examined:    ${stats.examined}`);
console.log(`[frame-backfill] xml missing: ${stats.xmlMissing}`);
console.log(`[frame-backfill] parse-error: ${stats.parseError}`);
console.log(`[frame-backfill] no-frame:    ${stats.noFrame}`);
console.log(`[frame-backfill] would-fill:  ${stats.wouldFill}`);
if (APPLY) {
  console.log(`[frame-backfill] filled:      ${stats.filled}`);
  console.log(`[frame-backfill] errors:      ${stats.errors}`);
}
console.log(`[frame-backfill] by field (count of XMLs that would fill it):`);
for (const [k, n] of Object.entries(stats.byKind)) console.log(`  ${k.padEnd(15)} ${n}`);

db.close();
