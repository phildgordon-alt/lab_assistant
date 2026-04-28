#!/usr/bin/env node
/**
 * backfill-active-wip-lens-type-from-daily.js — Tier 4
 *
 * Last-resort fill for active-WIP jobs with NULL lens_type that the existing
 * 3-tier backfill (XML / SHIPLOG / picks_history) couldn't resolve. Walks the
 * DVI daily export files at data/dvi/daily/260*_D_a_jobdta.txt — those files
 * carry one row per (DVI Job# × lens) with the lens SKU embedded. We join
 * that SKU to lens_sku_properties to derive lens_type_modal and material.
 *
 * Daily file column layout (tab-delimited, 0-indexed) — verified 2026-04-28:
 *    0  (empty / leading tab)
 *    1  Shopify #
 *    2  Enter Date     MM/DD/YY
 *    3  Ship Date      MM/DD/YY  (empty if active)
 *    4  Days In Proc
 *    5  Fin lens Breakage
 *    6  Lens Mfr       e.g. HK
 *    7  Blank Size
 *    8  Sphere Power
 *    9  Cylinder Power
 *   10  Subcon Vendor
 *   11  # Jobs
 *   12  % Breakage
 *   13  (empty)
 *   14  Lens cost
 *   15  Subcontrac cost
 *   16  DVI Job#       6-digit, joins to jobs.invoice
 *   17  (Pair internal code — e.g. D438801310)
 *   18  Lens SKU       e.g. 4800135354, joins to lens_sku_properties.sku
 *
 * Build a single in-memory index over every daily file (O(files+rows)) then
 * resolve each candidate by lookup (O(1) per job). Same INNER-JOIN-with-
 * lens_sku_properties trick the Tier 3 backfill uses, so frame UPCs in the
 * SKU column are silently skipped.
 *
 * Usage:
 *   node scripts/backfill-active-wip-lens-type-from-daily.js           # dry run
 *   node scripts/backfill-active-wip-lens-type-from-daily.js --apply   # commit
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'lab_assistant.db');
const DAILY_DIR = path.join(ROOT, 'data', 'dvi', 'daily');
const REPORTS_DIR = path.join(ROOT, 'data', 'backfill-reports');

const APPLY = process.argv.includes('--apply');

function ensureReportsDir() {
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

function reportPathForToday() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return path.join(REPORTS_DIR, `tier4-daily-export-${yyyy}-${mm}-${dd}.log`);
}

function main() {
  if (!fs.existsSync(DB_PATH))    { console.error('DB not found:', DB_PATH); process.exit(1); }
  if (!fs.existsSync(DAILY_DIR))  { console.error('Daily dir not found:', DAILY_DIR); process.exit(1); }

  const Database = require('better-sqlite3');
  const db = new Database(DB_PATH);

  console.log(`[tier4] Mode: ${APPLY ? 'APPLY' : 'DRY RUN — pass --apply to commit'}`);

  // ── Step 1: build DVI Job# → [lens SKUs] index from every daily file ──
  const files = fs.readdirSync(DAILY_DIR).filter(f => /^\d{6}_D_a_jobdta\.txt$/.test(f)).sort();
  console.log(`[tier4] Found ${files.length} daily export files`);

  // index: dviJobNum → Set of lens SKUs seen for that job (across all daily files)
  const jobToSkus = new Map();
  // sphere/cyl per job (R = first row, L = second row)
  const jobToRx = new Map();

  let rowsRead = 0;
  for (const file of files) {
    const filePath = path.join(DAILY_DIR, file);
    const text = fs.readFileSync(filePath, 'utf8');
    const lines = text.split(/\r?\n/);
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const cols = line.split('\t');
      if (cols.length < 19) continue;
      const dviJob = (cols[16] || '').trim();
      const lensSku = (cols[18] || '').trim();
      if (!dviJob || !lensSku) continue;
      // Only numeric DVI Job#s — defense against header rows
      if (!/^\d{4,}$/.test(dviJob)) continue;
      rowsRead++;
      if (!jobToSkus.has(dviJob)) jobToSkus.set(dviJob, []);
      jobToSkus.get(dviJob).push(lensSku);
      // First row = R eye, second row = L eye (per Phil's domain rule:
      // "right frame, left lens, right lens, left frame" minus right frame).
      // The daily file emits one row per lens, so position is the eye signal.
      const sphere = (cols[8] || '').trim() || null;
      const cyl    = (cols[9] || '').trim() || null;
      const cur = jobToRx.get(dviJob) || { r_sphere: null, r_cyl: null, l_sphere: null, l_cyl: null, eyesSeen: 0 };
      if (cur.eyesSeen === 0) { cur.r_sphere = sphere; cur.r_cyl = cyl; }
      else if (cur.eyesSeen === 1) { cur.l_sphere = sphere; cur.l_cyl = cyl; }
      cur.eyesSeen++;
      jobToRx.set(dviJob, cur);
    }
  }
  console.log(`[tier4] Indexed ${jobToSkus.size} unique DVI Job#s from ${rowsRead} rows across ${files.length} files`);

  // ── Step 2: for each candidate active-WIP NULL-lens_type job, look up SKU,
  //           join to lens_sku_properties, take the first row that resolves.
  const candidates = db.prepare(`
    SELECT invoice, current_stage, current_station, status
    FROM jobs
    WHERE status = 'ACTIVE' AND (lens_type IS NULL OR lens_type = '')
  `).all();
  console.log(`[tier4] Active-WIP NULL lens_type candidates: ${candidates.length}`);

  const skuLookup = db.prepare(`
    SELECT material, lens_type_modal
    FROM lens_sku_properties
    WHERE sku = ?
  `);

  const updateStmt = db.prepare(`
    UPDATE jobs SET
      lens_type     = COALESCE(lens_type, @lens_type),
      lens_material = COALESCE(lens_material, @lens_material),
      lens_opc_r    = COALESCE(lens_opc_r, @lens_opc_r),
      lens_opc_l    = COALESCE(lens_opc_l, @lens_opc_l),
      rx_r_sphere   = COALESCE(rx_r_sphere, @r_sphere),
      rx_r_cylinder = COALESCE(rx_r_cylinder, @r_cyl),
      rx_l_sphere   = COALESCE(rx_l_sphere, @l_sphere),
      rx_l_cylinder = COALESCE(rx_l_cylinder, @l_cyl),
      updated_at    = datetime('now')
    WHERE invoice = @invoice
  `);

  ensureReportsDir();
  const reportPath = reportPathForToday();
  const reportLines = [
    `# tier4-daily-export-backfill — ${new Date().toISOString()}`,
    `# mode=${APPLY ? 'APPLY' : 'DRY-RUN'} candidates=${candidates.length}`,
    `# columns: invoice\tcurrent_stage\treason`,
    '',
  ];

  const stats = {
    examined: 0, filled: 0, noDailyRow: 0, noSkuMatch: 0,
    byType: {}, errors: 0,
  };

  const tx = db.transaction(() => {
    for (const row of candidates) {
      stats.examined++;
      const skus = jobToSkus.get(row.invoice);
      if (!skus || skus.length === 0) {
        stats.noDailyRow++;
        reportLines.push(`${row.invoice}\t${row.current_stage || ''}\tno-daily-row`);
        continue;
      }
      // Try each SKU until one resolves in lens_sku_properties.
      let resolved = null;
      let resolvedSku = null;
      let resolvedSkuL = null;
      for (let i = 0; i < skus.length; i++) {
        const r = skuLookup.get(skus[i]);
        if (r && (r.material || r.lens_type_modal)) {
          resolved = r;
          resolvedSku  = skus[0]; // R eye = first row
          resolvedSkuL = skus[1] || null;
          break;
        }
      }
      if (!resolved) {
        stats.noSkuMatch++;
        reportLines.push(`${row.invoice}\t${row.current_stage || ''}\tno-sku-match (skus=${skus.join(',')})`);
        continue;
      }
      const rx = jobToRx.get(row.invoice) || {};
      stats.filled++;
      const lt = resolved.lens_type_modal || null;
      stats.byType[lt || 'NULL'] = (stats.byType[lt || 'NULL'] || 0) + 1;

      if (!APPLY) continue;
      try {
        updateStmt.run({
          invoice:       row.invoice,
          lens_type:     lt,
          lens_material: resolved.material || null,
          lens_opc_r:    resolvedSku,
          lens_opc_l:    resolvedSkuL,
          r_sphere:      rx.r_sphere,
          r_cyl:         rx.r_cyl,
          l_sphere:      rx.l_sphere,
          l_cyl:         rx.l_cyl,
        });
      } catch (e) {
        stats.errors++;
        reportLines.push(`${row.invoice}\t${row.current_stage || ''}\twrite-error:${e.message}`);
      }
    }
  });
  tx();

  fs.writeFileSync(reportPath, reportLines.join('\n') + '\n');
  console.log(`[tier4] wrote report: ${reportPath}`);
  console.log(`[tier4] examined: ${stats.examined}`);
  console.log(`[tier4] filled:   ${stats.filled}`);
  console.log(`[tier4]   by lens_type:`, stats.byType);
  console.log(`[tier4] no-daily-row:  ${stats.noDailyRow}  (job not in any daily file — DVI never recorded it)`);
  console.log(`[tier4] no-sku-match:  ${stats.noSkuMatch}  (lens SKU exists but not in lens_sku_properties)`);
  console.log(`[tier4] write-errors:  ${stats.errors}`);
  if (!APPLY) console.log(`[tier4] DRY RUN — re-run with --apply to commit.`);

  db.close();
}

main();
