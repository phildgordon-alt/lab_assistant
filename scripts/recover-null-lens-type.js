#!/usr/bin/env node
/**
 * Recover NULL lens_type for active jobs that lost it after the 2026-05-02
 * picks_history canonicalization migration.
 *
 * Background: pre-migration, ItemPath REST was over-counting picks (every
 * request line counted as qty=1 with phantom rows) which incidentally fired
 * the lens_type derivation trigger for lots of jobs. After migration,
 * Power Pick is strict — only fires the trigger on real MotiveType=0
 * confirmed picks. The 9% of jobs where Kardex doesn't have stock never get
 * auto-confirmed → trigger never fires → lens_type stays NULL.
 *
 * Recovery sources, tried in order:
 *   1. Power Pick `History` Type=4 — ANY row (request OR fulfilled), get
 *      Materialreference, lookup in lens_sku_properties. Catches the 9% gap
 *      because requests have the SKU even when never confirmed.
 *   2. DVI XML at data/dvi/jobs/{invoice}.xml — has lens_opc_r/lens_opc_l
 *      for jobs DVI sent us.
 *   3. dvi_shipped_jobs row (rare for ACTIVE jobs but included for safety)
 *
 * Idempotent. Safe to re-run.
 *
 * Usage:
 *   node scripts/recover-null-lens-type.js              # dry run, prints CSV
 *   node scripts/recover-null-lens-type.js --apply      # actually writes UPDATE
 *   node scripts/recover-null-lens-type.js --apply --limit 50   # cap rows for testing
 *
 * Bridges the gap until domain layer step 8 ships, which folds this logic
 * into the canonical picks-derive source automatically.
 */

'use strict';

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: '/Users/Shared/lab_assistant/.env', override: false });
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: false });

const Database = require('better-sqlite3');

let sql = null;
try { sql = require('mssql'); } catch { /* run without Power Pick path */ }

// ── Config ──────────────────────────────────────────────────────────────────
const DB_PATH = process.env.LAB_DB || '/Users/Shared/lab_assistant/data/lab_assistant.db';
const DVI_JOBS_DIR = process.env.DVI_JOBS_DIR || '/Users/Shared/lab_assistant/data/dvi/jobs';

const APPLY  = process.argv.includes('--apply');
const limitArg = process.argv.find(a => a.startsWith('--limit'));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1] || process.argv[process.argv.indexOf('--limit') + 1], 10) || 0 : 0;

const ALL_ACTIVE_STAGES = ['INCOMING','SURFACING','CUTTING','COATING','ASSEMBLY','SHIPPING'];
// INCOMING jobs are pre-pick — they SHOULD have NULL lens_type until Kardex
// is requested. Excluded from recovery attempts by default. Use
// --include-incoming to override.
const RECOVERY_STAGES = process.argv.includes('--include-incoming')
  ? ALL_ACTIVE_STAGES
  : ALL_ACTIVE_STAGES.filter(s => s !== 'INCOMING');
const ACTIVE_STAGES = RECOVERY_STAGES; // backward-compat alias for the rest of the file

// ── Setup ───────────────────────────────────────────────────────────────────
if (!fs.existsSync(DB_PATH)) {
  console.error(`ERROR: DB not found at ${DB_PATH}`);
  process.exit(1);
}
const db = new Database(DB_PATH, { readonly: !APPLY });
db.pragma('journal_mode = WAL');

const log = (...a) => console.log('[recover]', ...a);

// ── Stage breakdown of ALL NULL-lens_type active jobs (incl. INCOMING) ──────
const allPlaceholders = ALL_ACTIVE_STAGES.map(() => '?').join(',');
const stageRows = db.prepare(`
  SELECT current_stage, COUNT(*) AS n
  FROM jobs
  WHERE current_stage IN (${allPlaceholders})
    AND (lens_type IS NULL OR lens_type = '')
  GROUP BY current_stage ORDER BY n DESC
`).all(...ALL_ACTIVE_STAGES);

const totalNull = stageRows.reduce((s, r) => s + r.n, 0);
log(`NULL-lens_type active jobs by stage:`);
for (const r of stageRows) {
  const skipped = !ACTIVE_STAGES.includes(r.current_stage) ? '  [skipped — pre-pick]' : '';
  log(`  ${r.current_stage.padEnd(10)} ${String(r.n).padStart(5)}${skipped}`);
}
log(`  TOTAL      ${String(totalNull).padStart(5)}`);

// ── Find recovery candidates (excludes INCOMING by default) ─────────────────
const placeholders = ACTIVE_STAGES.map(() => '?').join(',');
const candidatesSql = `
  SELECT invoice, current_stage
  FROM jobs
  WHERE current_stage IN (${placeholders})
    AND (lens_type IS NULL OR lens_type = '')
  ORDER BY first_seen_at DESC
  ${LIMIT > 0 ? `LIMIT ${LIMIT}` : ''}
`;
const candidates = db.prepare(candidatesSql).all(...ACTIVE_STAGES);
log('');
log(`Recovery candidates (post-pick stages only): ${candidates.length}`);

if (candidates.length === 0) {
  log('Nothing to recover. (All NULL jobs are in pre-pick stages — expected.)');
  db.close();
  process.exit(0);
}

// ── SKU lookup ──────────────────────────────────────────────────────────────
const skuLookupStmt = db.prepare(`
  SELECT sku, lens_type_modal, material
  FROM lens_sku_properties
  WHERE sku = ?
`);

function lensTypeForSku(sku) {
  if (!sku) return null;
  const r = skuLookupStmt.get(String(sku).trim());
  return r ? { sku: r.sku, lens_type: r.lens_type_modal, material: r.material } : null;
}

// ── Source 1: Power Pick History (catches the 9% gap) ───────────────────────
let pool = null;
async function pp_lookupSku(invoice) {
  if (!pool) return null;
  try {
    const r = await pool.request()
      .input('inv', sql.NVarChar, String(invoice))
      .query(`
        SELECT TOP 5 Materialreference, MotiveType, PickWarehouseName, Creationdate
        FROM History
        WHERE Type = 4 AND MasterorderName = @inv AND Materialreference IS NOT NULL
        ORDER BY Creationdate DESC
      `);
    // Try the most recent rows; first SKU that resolves to a known lens type wins.
    // Skip frame UPCs (typically 12-digit non-lens) by checking lens_sku_properties hit.
    for (const row of r.recordset) {
      const hit = lensTypeForSku(row.Materialreference);
      if (hit && hit.lens_type) return hit;
    }
  } catch (e) {
    if (!pp_lookupSku._warned) { console.warn('[recover] Power Pick query failed:', e.message); pp_lookupSku._warned = true; }
  }
  return null;
}

// ── Source 2: DVI XML file ──────────────────────────────────────────────────
// DVI XML uses <RightEye OPC="..." Type="..." Material="..." /> attribute
// format (modern) or a legacy <Lens><OPC>…</OPC></Lens> child-element format.
// The `Type` attribute IS the lens_type ('S'/'P'/'B'/'C') — preferred over
// SKU→lens_sku_properties lookup. Mirrors parseDviXml() in oven-timer-server.js
// (line 323) — same precedence rules.
function dvi_lookupSku(invoice) {
  const xmlPath = path.join(DVI_JOBS_DIR, `${invoice}.xml`);
  if (!fs.existsSync(xmlPath)) return null;
  try {
    const xml = fs.readFileSync(xmlPath, 'utf8');

    const eyeBlock =
      (xml.match(/<RightEye[^>]*(?:\/>|>[\s\S]*?<\/RightEye>)/) || [])[0] ||
      (xml.match(/<LeftEye[^>]*(?:\/>|>[\s\S]*?<\/LeftEye>)/)  || [])[0] || '';
    const lensBlock = (xml.match(/<Lens[^>]*>([\s\S]*?)<\/Lens>/) || [])[0] || '';

    const fromEyeAttr = (attr) => {
      const m = eyeBlock.match(new RegExp(`\\s${attr}="([^"]*)"`));
      return m ? m[1].trim() : null;
    };
    const fromBlockChild = (block, tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`));
      return m ? m[1].trim() : null;
    };
    // Try eye-attribute first, fall back to <Lens> child element
    const get = (attr) => fromEyeAttr(attr) || fromBlockChild(eyeBlock, attr) || fromBlockChild(lensBlock, attr);

    const xmlType     = get('Type');     // 'S' | 'P' | 'B' | 'C' if present
    const xmlOpc      = get('OPC');      // SKU
    const xmlMaterial = get('Material'); // 'BLY' | 'PLY' | etc.

    // Preferred: take lens_type directly from the XML's `Type` attribute.
    // 'B' (bifocal) maps to 'P' (progressive/surfacing) per the existing
    // classifier in oven-timer-server.js:2956 (P or B → Surfacing).
    if (xmlType) {
      const normalizedType = (xmlType === 'B') ? 'P' : xmlType;
      if (['S','P','C'].includes(normalizedType)) {
        return { sku: xmlOpc || null, lens_type: normalizedType, material: xmlMaterial || null };
      }
    }

    // Fallback: derive lens_type from OPC via lens_sku_properties lookup
    if (xmlOpc) {
      const hit = lensTypeForSku(xmlOpc);
      if (hit && hit.lens_type) return hit;
    }
  } catch { /* unreadable / malformed — skip */ }
  return null;
}

// ── Source 3: dvi_shipped_jobs (rare for active jobs but cheap) ─────────────
// dvi_shipped_jobs has lens_type and lens_material columns directly — no SKU
// lookup needed. Apply 'B' → 'P' normalization per oven-timer-server.js:2956.
const shippedLookupStmt = db.prepare(`
  SELECT lens_opc_r, lens_material, lens_type FROM dvi_shipped_jobs WHERE invoice = ?
`);
function shipped_lookupSku(invoice) {
  const row = shippedLookupStmt.get(String(invoice));
  if (!row) return null;
  if (row.lens_type) {
    const t = row.lens_type === 'B' ? 'P' : row.lens_type;
    if (['S','P','C'].includes(t)) {
      return { sku: row.lens_opc_r || null, lens_type: t, material: row.lens_material || null };
    }
  }
  // Fallback: derive from SKU
  const hit = lensTypeForSku(row.lens_opc_r);
  if (hit && hit.lens_type) return hit;
  return null;
}

// ── Apply update (only when --apply) ────────────────────────────────────────
const updateStmt = APPLY ? db.prepare(`
  UPDATE jobs SET
    lens_type     = COALESCE(lens_type,     @lens_type),
    lens_material = COALESCE(lens_material, @lens_material),
    lens_opc_r    = COALESCE(lens_opc_r,    @lens_opc_r),
    updated_at    = datetime('now')
  WHERE invoice = @invoice
    AND (lens_type IS NULL OR lens_type = '')
`) : null;

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  // Connect to Power Pick if configured
  if (sql && process.env.POWERPICK_HOST) {
    try {
      pool = await sql.connect({
        server:   process.env.POWERPICK_HOST,
        port:     parseInt(process.env.POWERPICK_PORT || '1433', 10),
        user:     process.env.POWERPICK_USER,
        password: process.env.POWERPICK_PASSWORD,
        database: process.env.POWERPICK_DATABASE,
        options: { encrypt: false, trustServerCertificate: true, connectTimeout: 10000, requestTimeout: 30000 },
      });
      log(`Power Pick connected: ${process.env.POWERPICK_HOST}/${process.env.POWERPICK_DATABASE}`);
    } catch (e) {
      console.warn('[recover] Power Pick connect failed:', e.message);
    }
  } else {
    log('Power Pick adapter not configured — skipping Source 1');
  }

  let recovered = 0, byPP = 0, byDVI = 0, byShipped = 0, unresolved = 0;
  const unresolvedByStage = {};
  const csvLines = ['invoice,stage,source,sku,lens_type,material'];

  for (const job of candidates) {
    let hit = await pp_lookupSku(job.invoice);
    let source = 'powerpick-request';
    if (hit) byPP++;
    else { hit = dvi_lookupSku(job.invoice); source = 'dvi-xml'; if (hit) byDVI++; }
    if (!hit) { hit = shipped_lookupSku(job.invoice); source = 'dvi-shipped'; if (hit) byShipped++; }

    if (!hit) {
      unresolved++;
      unresolvedByStage[job.current_stage] = (unresolvedByStage[job.current_stage] || 0) + 1;
      csvLines.push(`${job.invoice},${job.current_stage},NONE,,,`);
      continue;
    }

    csvLines.push(`${job.invoice},${job.current_stage},${source},${hit.sku || ''},${hit.lens_type},${hit.material || ''}`);

    if (APPLY) {
      try {
        const r = updateStmt.run({
          invoice: job.invoice,
          lens_type: hit.lens_type,
          lens_material: hit.material || null,
          lens_opc_r: hit.sku || null,
        });
        if (r.changes > 0) recovered++;
      } catch (e) {
        console.error(`[recover] UPDATE failed for ${job.invoice}: ${e.message}`);
      }
    } else {
      recovered++; // count as "would recover" in dry run
    }
  }

  // Write CSV report
  const stamp = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
  const csvPath = `/tmp/recover-null-lens-type-${stamp}${APPLY ? '' : '-DRYRUN'}.csv`;
  fs.writeFileSync(csvPath, csvLines.join('\n') + '\n');

  log('');
  log(`Mode:           ${APPLY ? 'APPLY (rows updated)' : 'DRY RUN (no DB writes)'}`);
  log(`Candidates:     ${candidates.length}`);
  log(`Resolved by PowerPick:    ${byPP}`);
  log(`Resolved by DVI XML:      ${byDVI}`);
  log(`Resolved by dvi_shipped:  ${byShipped}`);
  log(`Unresolved (no source):   ${unresolved}`);
  if (unresolved > 0) {
    log(`Unresolved by stage:`);
    for (const [stage, n] of Object.entries(unresolvedByStage).sort((a,b) => b[1]-a[1])) {
      log(`  ${stage.padEnd(10)} ${String(n).padStart(5)}`);
    }
  }
  log(`Total recoverable:        ${recovered}`);
  log(`CSV written to:           ${csvPath}`);

  // Post-state if --apply
  if (APPLY) {
    const after = db.prepare(`
      SELECT COUNT(*) AS n FROM jobs
      WHERE current_stage IN (${placeholders}) AND (lens_type IS NULL OR lens_type = '')
    `).get(...ACTIVE_STAGES);
    log('');
    log(`NULL-lens_type active jobs remaining: ${after.n}`);
  } else {
    log('');
    log('To apply: re-run with --apply');
  }

  if (pool) { try { await pool.close(); } catch {} }
  db.close();
}

main().catch(e => { console.error('[recover] FATAL:', e); process.exit(1); });
