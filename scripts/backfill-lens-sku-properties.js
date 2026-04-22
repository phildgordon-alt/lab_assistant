#!/usr/bin/env node
/**
 * backfill-lens-sku-properties.js
 *
 * One-shot: walk the last 12 months of jobs (jobs table + DVI XML files) and
 * populate:
 *   - lens_sku_properties (per-SKU: material, lens_type_modal, Rx ranges, sample_count)
 *   - rx_profile_templates + rx_profile_buckets — two auto-derived templates:
 *       "Standard SV" (sph/cyl/add distribution from all S+C jobs)
 *       "Standard Surfacing" (base_curve distribution from all P jobs)
 *
 * Phil's lab runs on PT. All date math is America/Los_Angeles.
 *
 * Usage:
 *   node scripts/backfill-lens-sku-properties.js            # dry run: reports counts, no writes
 *   node scripts/backfill-lens-sku-properties.js --apply    # commit the backfill
 */

'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'lab_assistant.db');
const JOBS_DIR = path.join(ROOT, 'data', 'dvi', 'jobs');
const SHIPPED_DIR = path.join(ROOT, 'data', 'dvi', 'shipped');
const APPLY = process.argv.includes('--apply');

// ── PT-local 12-month cutoff ────────────────────────────────────────────────
function ptDateString(d) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d || new Date());
  const get = (t) => parts.find(p => p.type === t)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
const now = new Date();
const cutoff = new Date(now.getTime() - 365 * 86400000);
const cutoffStr = ptDateString(cutoff);

// ── Full DVI XML parser — supports both modern (RightEye attr) and legacy
//    (<Rx Eye> + <Lens Eye>) formats. Port of parseDviXml at
//    server/oven-timer-server.js:254. Extracted here rather than importing
//    the server module because this script runs standalone (no app context).
function parseXml(xml) {
  const get = (tag) => { const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`)); return m ? m[1].trim() : null; };
  const getAttr = (tag, attr) => { const m = xml.match(new RegExp(`<${tag}[^>]*\\s${attr}="([^"]*)"`)); return m ? m[1] : null; };
  const rightEyeBlock = xml.match(/<RightEye[^>]*(?:\/>|>[\s\S]*?<\/RightEye>)/);
  const leftEyeBlock = xml.match(/<LeftEye[^>]*(?:\/>|>[\s\S]*?<\/LeftEye>)/);
  const lensBlock = xml.match(/<Lens[^>]*>([\s\S]*?)<\/Lens>/);
  const eyeXml = rightEyeBlock ? rightEyeBlock[0] : (leftEyeBlock ? leftEyeBlock[0] : '');
  const lensXml = lensBlock ? lensBlock[0] : '';
  const getEyeAttr = (attr) => { const m = eyeXml.match(new RegExp(`\\s${attr}="([^"]*)"`)); return m ? m[1] : null; };
  const getLens = (tag) => {
    const a = getEyeAttr(tag); if (a) return a;
    const ec = eyeXml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`)); if (ec) return ec[1].trim();
    const lc = lensXml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`)); return lc ? lc[1].trim() : null;
  };
  const frameBlock = xml.match(/<Frame[^>]*>([\s\S]*?)<\/Frame>/) || xml.match(/<Frame[^>]*\/>/);
  const frameXml = frameBlock ? frameBlock[0] : '';
  const getFrame = (tag) => { const m = frameXml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`)); return m ? m[1].trim() : null; };

  // Rx — modern format (attrs on RightEye/LeftEye) first, then legacy (<Rx Eye> child elements)
  const rx = {};
  for (const { eye, block } of [{ eye: 'R', block: rightEyeBlock?.[0] }, { eye: 'L', block: leftEyeBlock?.[0] }]) {
    if (!block) continue;
    const a = (name) => { const m = block.match(new RegExp(`\\s${name}="([^"]*)"`)); return m ? m[1] : null; };
    rx[eye] = { sphere: a('Sphere'), cylinder: a('Cylinder'), axis: a('CylAxis') || a('Axis'), pd: a('DistancePD') || a('PD'), add: a('Add') };
  }
  if (!rx.R && !rx.L) {
    const rxBlocks = xml.match(/<Rx\s+Eye="([RL])">([\s\S]*?)<\/Rx>/g) || [];
    for (const block of rxBlocks) {
      const eye = block.match(/Eye="([RL])"/)?.[1]; if (!eye) continue;
      rx[eye] = {
        sphere: block.match(/<Sphere>([^<]*)<\/Sphere>/)?.[1] || null,
        cylinder: block.match(/<Cylinder[^>]*>([^<]*)<\/Cylinder>/)?.[1] || null,
        axis: block.match(/<Cylinder\s+Axis="([^"]*)"/)?.[1] || null,
        pd: block.match(/<PD>([^<]*)<\/PD>/)?.[1] || null,
        add: block.match(/<Power>([^<]*)<\/Power>/)?.[1] || null,
      };
    }
  }

  // Normalize — convert Rx strings to floats. Legacy Add is a Power like "200" meaning +2.00
  const toFloat = (v) => {
    if (v == null || v === '') return null;
    const n = parseFloat(v); if (!isFinite(n)) return null;
    return n;
  };
  for (const eye of ['R', 'L']) {
    if (!rx[eye]) continue;
    const r = rx[eye];
    r.sphere = toFloat(r.sphere);
    r.cylinder = toFloat(r.cylinder);
    r.axis = toFloat(r.axis);
    // Legacy Add "200" → 2.00 diopters; modern Add might already be e.g. "2.00"
    let addN = toFloat(r.add);
    if (addN != null && addN > 10) addN = addN / 100; // legacy Power notation
    r.add = addN;
  }

  return {
    opc: getEyeAttr('OPC') || getLens('OPC'),
    opcL: leftEyeBlock ? ((leftEyeBlock[0].match(/\sOPC="([^"]*)"/) || [])[1] || null) : null,
    lensType: getEyeAttr('Type') || getAttr('Lens', 'Type'),
    lensPick: getEyeAttr('Pick') || getAttr('Lens', 'Pick'),
    material: getEyeAttr('Material') || getLens('Mat'),
    lensStyle: getLens('Style'),
    lensThick: getLens('Thick'),
    coating: getLens('Coat') || get('Coat'),
    eyeSize: getFrame('EyeSize') || get('EyeSize'),
    rxR: rx.R || null,
    rxL: rx.L || null,
    entryDate: getAttr('OrderData', 'EntryDate'),
    origin: get('Origin') || getAttr('OrderData', 'JobOrigin'),
  };
}

// DVI EntryDate is MM/DD/YY — convert to YYYY-MM-DD for comparison
function dviDateToIso(d) {
  if (!d) return null;
  const [mm, dd, yy] = d.split('/');
  if (!mm || !dd || !yy) return null;
  return `20${yy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}

// Sanity filter — reject obvious bad Rx
function validSph(v) { return typeof v === 'number' && isFinite(v) && Math.abs(v) <= 20; }
function validCyl(v) { return typeof v === 'number' && isFinite(v) && Math.abs(v) <= 8; }
function validAdd(v) { return typeof v === 'number' && isFinite(v) && v >= 0.75 && v <= 4.0; }

// Bucket Rx to nearest 0.5D for SV template
function svBucket(sph, cyl, add) {
  const sphStep = 0.5;
  const cylStep = 0.5;
  const addStep = 0.5;
  const b = (v, step) => Math.round(v / step) * step;
  return {
    sph_min: b(sph, sphStep) - sphStep / 2,
    sph_max: b(sph, sphStep) + sphStep / 2,
    cyl_min: validCyl(cyl) ? b(cyl, cylStep) - cylStep / 2 : null,
    cyl_max: validCyl(cyl) ? b(cyl, cylStep) + cylStep / 2 : null,
    add_min: validAdd(add) ? b(add, addStep) - addStep / 2 : null,
    add_max: validAdd(add) ? b(add, addStep) + addStep / 2 : null,
  };
}

// ── Accumulators ────────────────────────────────────────────────────────────
const perSku = new Map();   // sku → { mat:{}, styles:{}, ltype:{}, coat:{}, sphs:[], cyls:[], adds:[], eyes:[], thicks:{}, first, last, count }
const svBuckets = new Map(); // "sph|cyl|add" → count
const surfBuckets = new Map(); // base_curve → count  (semifinished jobs, base curve parsed from lensStyle or SKU → lens_sku_params)

function bump(acc, key) { acc[key] = (acc[key] || 0) + 1; }

function accumulateJob(parsed) {
  const opc = parsed.opc;
  if (!opc) return;
  if (!perSku.has(opc)) {
    perSku.set(opc, { mat: {}, styles: {}, ltype: {}, coat: {}, sphs: [], cyls: [], adds: [], eyes: [], thicks: {}, first: null, last: null, count: 0 });
  }
  const a = perSku.get(opc);
  a.count++;
  if (parsed.material) bump(a.mat, parsed.material);
  if (parsed.lensStyle) bump(a.styles, parsed.lensStyle);
  if (parsed.lensType) bump(a.ltype, parsed.lensType);
  if (parsed.coating) bump(a.coat, parsed.coating);
  if (parsed.lensThick) bump(a.thicks, parsed.lensThick);
  for (const rx of [parsed.rxR, parsed.rxL]) {
    if (!rx) continue;
    if (validSph(rx.sphere)) a.sphs.push(rx.sphere);
    if (validCyl(rx.cylinder)) a.cyls.push(rx.cylinder);
    if (validAdd(rx.add)) a.adds.push(rx.add);
  }
  if (parsed.eyeSize && parsed.eyeSize > 30 && parsed.eyeSize < 80) a.eyes.push(parsed.eyeSize);
  const iso = dviDateToIso(parsed.entryDate);
  if (iso) {
    if (!a.first || iso < a.first) a.first = iso;
    if (!a.last || iso > a.last) a.last = iso;
  }

  // Template accumulators — lens_type drives SV vs Surfacing
  const lt = parsed.lensType;
  if (lt === 'S' || lt === 'C') {
    const rxR = parsed.rxR;
    if (rxR && validSph(rxR.sphere)) {
      const b = svBucket(rxR.sphere, rxR.cylinder, rxR.add);
      const key = `${b.sph_min}|${b.sph_max}|${b.cyl_min}|${b.cyl_max}|${b.add_min}|${b.add_max}`;
      svBuckets.set(key, { ...b, count: (svBuckets.get(key)?.count || 0) + 1 });
    }
    // (also count left eye)
    const rxL = parsed.rxL;
    if (rxL && validSph(rxL.sphere)) {
      const b = svBucket(rxL.sphere, rxL.cylinder, rxL.add);
      const key = `${b.sph_min}|${b.sph_max}|${b.cyl_min}|${b.cyl_max}|${b.add_min}|${b.add_max}`;
      svBuckets.set(key, { ...b, count: (svBuckets.get(key)?.count || 0) + 1 });
    }
  }
  // Surfacing bucket: parse base curve from lensStyle if possible
  // Pucks have no Rx; just count by base curve
  if (lt === 'P') {
    const bc = parseBaseCurve(parsed.lensStyle, opc);
    if (bc != null) {
      surfBuckets.set(bc, (surfBuckets.get(bc) || 0) + 1);
    }
  }
}

function parseBaseCurve(lensStyle, sku) {
  // Try lensStyle first — may encode BC like "SF PLY BC 4.5"
  if (lensStyle) {
    const m = lensStyle.match(/BC\s*(\d+(?:\.\d+)?)/i);
    if (m) return parseFloat(m[1]);
  }
  // Else try the lens_sku_params.notes / description lookup later (skip for now)
  return null;
}

function mode(obj) {
  let best = null, bestN = 0, total = 0;
  for (const [k, n] of Object.entries(obj)) {
    total += n;
    if (n > bestN) { bestN = n; best = k; }
  }
  return { value: best, conf: total > 0 ? bestN / total : 0, total };
}

function processDir(dir, seen) {
  if (!fs.existsSync(dir)) return 0;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.xml'));
  let processed = 0, skippedOld = 0;
  for (const f of files) {
    if (seen.has(f)) continue;
    seen.add(f);
    try {
      const xml = fs.readFileSync(path.join(dir, f), 'utf8');
      const parsed = parseXml(xml);
      const iso = dviDateToIso(parsed.entryDate);
      // 12-month cutoff — accept if date known and within window, or if date missing (rare)
      if (iso && iso < cutoffStr) { skippedOld++; continue; }
      accumulateJob(parsed);
      processed++;
    } catch { /* skip bad XML */ }
  }
  return { processed, skippedOld };
}

// ── Main ────────────────────────────────────────────────────────────────────
function main() {
  if (!fs.existsSync(DB_PATH)) { console.error('DB not found:', DB_PATH); process.exit(1); }
  const db = new Database(DB_PATH);

  console.log(`[backfill] Cutoff: ${cutoffStr} PT (12-month window)`);
  console.log(`[backfill] Mode: ${APPLY ? 'APPLY (commit)' : 'DRY RUN (no writes — pass --apply to commit)'}`);

  const seen = new Set();
  const jobsStats = processDir(JOBS_DIR, seen);
  const shippedStats = processDir(SHIPPED_DIR, seen);
  console.log(`[backfill] Scanned jobs/: ${jobsStats.processed} accepted, ${jobsStats.skippedOld} >12mo`);
  console.log(`[backfill] Scanned shipped/: ${shippedStats.processed} accepted, ${shippedStats.skippedOld} >12mo`);
  console.log(`[backfill] Distinct SKUs: ${perSku.size}`);
  console.log(`[backfill] SV template buckets: ${svBuckets.size}`);
  console.log(`[backfill] Surfacing template buckets (base curves): ${surfBuckets.size}`);

  if (!APPLY) {
    // Show top 10 SV buckets by count + top surfacing
    const svTop = [...svBuckets.values()].sort((a, b) => b.count - a.count).slice(0, 10);
    console.log('[backfill] Top 10 SV Rx buckets:');
    for (const b of svTop) console.log(`   sph ${b.sph_min}..${b.sph_max} / cyl ${b.cyl_min}..${b.cyl_max} / add ${b.add_min}..${b.add_max} → ${b.count}`);
    const surfTop = [...surfBuckets.entries()].sort((a, b) => b[1] - a[1]);
    console.log('[backfill] Surfacing base curve distribution:');
    for (const [bc, n] of surfTop) console.log(`   BC ${bc} → ${n}`);
    console.log('[backfill] DRY RUN — no writes. Re-run with --apply to commit.');
    db.close();
    return;
  }

  // ─── Write lens_sku_properties ─────────────────────────────────────────────
  const upsertProps = db.prepare(`
    INSERT INTO lens_sku_properties (
      sku, material, material_conf, lens_type_modal, base_curve, diameter,
      sph_min, sph_max, cyl_min, cyl_max, add_min, add_max,
      eye_size_min, eye_size_max, common_coatings, typical_thick,
      sample_job_count, first_seen, last_seen, last_aggregated_at
    ) VALUES (
      @sku, @material, @material_conf, @lens_type_modal, @base_curve, @diameter,
      @sph_min, @sph_max, @cyl_min, @cyl_max, @add_min, @add_max,
      @eye_size_min, @eye_size_max, @common_coatings, @typical_thick,
      @sample_job_count, @first_seen, @last_seen, datetime('now')
    )
    ON CONFLICT(sku) DO UPDATE SET
      material = excluded.material,
      material_conf = excluded.material_conf,
      lens_type_modal = excluded.lens_type_modal,
      base_curve = COALESCE(lens_sku_properties.base_curve, excluded.base_curve),
      diameter = COALESCE(lens_sku_properties.diameter, excluded.diameter),
      sph_min = excluded.sph_min,
      sph_max = excluded.sph_max,
      cyl_min = excluded.cyl_min,
      cyl_max = excluded.cyl_max,
      add_min = excluded.add_min,
      add_max = excluded.add_max,
      eye_size_min = excluded.eye_size_min,
      eye_size_max = excluded.eye_size_max,
      common_coatings = excluded.common_coatings,
      typical_thick = excluded.typical_thick,
      sample_job_count = excluded.sample_job_count,
      first_seen = excluded.first_seen,
      last_seen = excluded.last_seen,
      last_aggregated_at = datetime('now')
  `);

  const mn = (arr) => arr.length ? Math.min(...arr) : null;
  const mx = (arr) => arr.length ? Math.max(...arr) : null;

  let propsWritten = 0;
  db.transaction(() => {
    for (const [sku, a] of perSku) {
      const matMode = mode(a.mat);
      const ltMode = mode(a.ltype);
      const coatTop = Object.entries(a.coat).sort((a, b) => b[1] - a[1]).slice(0, 3);
      upsertProps.run({
        sku,
        material: matMode.value,
        material_conf: matMode.conf,
        lens_type_modal: ltMode.value,
        base_curve: parseBaseCurve(mode(a.styles).value, sku),
        diameter: null, // blank diameter not in DVI XML; populate later from catalog
        sph_min: mn(a.sphs), sph_max: mx(a.sphs),
        cyl_min: mn(a.cyls), cyl_max: mx(a.cyls),
        add_min: mn(a.adds), add_max: mx(a.adds),
        eye_size_min: mn(a.eyes), eye_size_max: mx(a.eyes),
        common_coatings: JSON.stringify(coatTop),
        typical_thick: mode(a.thicks).value,
        sample_job_count: a.count,
        first_seen: a.first,
        last_seen: a.last,
      });
      propsWritten++;
    }
  })();
  console.log(`[backfill] lens_sku_properties: wrote ${propsWritten} rows`);

  // ─── Write standard Rx profile templates ───────────────────────────────────
  const insertTpl = db.prepare(`
    INSERT INTO rx_profile_templates (name, lens_type, description, is_default, source)
    VALUES (?, ?, ?, 1, 'auto_12mo')
    ON CONFLICT(name) DO UPDATE SET updated_at = datetime('now')
  `);
  const clearBuckets = db.prepare(`DELETE FROM rx_profile_buckets WHERE template_id = ?`);
  const insertBucket = db.prepare(`
    INSERT INTO rx_profile_buckets (
      template_id, sph_min, sph_max, cyl_min, cyl_max, add_min, add_max, base_curve, pct_of_total, sample_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const findTpl = db.prepare(`SELECT id FROM rx_profile_templates WHERE name = ?`);

  db.transaction(() => {
    // SV template
    insertTpl.run('Standard SV', 'SV', `Auto-derived from ${cutoffStr}→today SV jobs`);
    const svId = findTpl.get('Standard SV').id;
    clearBuckets.run(svId);
    const svTotal = [...svBuckets.values()].reduce((s, b) => s + b.count, 0) || 1;
    for (const b of svBuckets.values()) {
      insertBucket.run(
        svId, b.sph_min, b.sph_max, b.cyl_min, b.cyl_max, b.add_min, b.add_max,
        null, b.count / svTotal, b.count
      );
    }
    console.log(`[backfill] Standard SV template: ${svBuckets.size} buckets, ${svTotal} samples`);

    // Surfacing template
    insertTpl.run('Standard Surfacing', 'Surfacing', `Auto-derived from ${cutoffStr}→today Surfacing jobs`);
    const surfId = findTpl.get('Standard Surfacing').id;
    clearBuckets.run(surfId);
    const surfTotal = [...surfBuckets.values()].reduce((s, n) => s + n, 0) || 1;
    for (const [bc, n] of surfBuckets) {
      insertBucket.run(
        surfId, null, null, null, null, null, null,
        bc, n / surfTotal, n
      );
    }
    console.log(`[backfill] Standard Surfacing template: ${surfBuckets.size} buckets, ${surfTotal} samples`);
  })();

  db.close();
  console.log('[backfill] Done.');
}

main();
