// Load environment variables from .env file (check both server dir and parent dir)
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

/**
 * oven-timer-server.js — Lab_Assistant Oven Timer Bridge
 * ───────────────────────────────────────────────────────
 * Receives completed runs from OvenTimer.html  →  POST /api/oven-run
 * Receives live timer heartbeats               →  POST /api/oven-live
 * Serves run history to dashboard             →  GET  /api/oven-runs
 * Serves live state to dashboard              →  GET  /api/oven-live
 * Serves computed stats                       →  GET  /api/oven-stats
 * Serves MOBILE STATUS PAGE                   →  GET  /status
 * Health check                                →  GET  /health
 *
 * SETUP:
 *   1. Node.js 18+, zero npm dependencies
 *   2. node oven-timer-server.js
 *   3. In OvenTimer.html Settings → Server URL = http://THIS_PC_IP:3002
 *   4. Phone status page: http://THIS_PC_IP:3002/status
 *
 * BACKGROUND SERVICE:
 *   Windows: nssm install OvenTimer "node" "C:\path\oven-timer-server.js"
 *   Linux:   pm2 start oven-timer-server.js --name oven-timer
 */

const http = require('http');
const fs   = require('fs');
const { URL } = require('url');

// ── SQLite database (shared with gateway MCP tools) ────────────
const labDb = require('./db');

// ── Knowledge Base ──────────────────────────────────────────────
const knowledge = require('./knowledge-adapter');

// ── ItemPath/Kardex inventory integration ─────────────────────
const itempath = require('./itempath-adapter');
itempath.start();

// ── Limble CMMS maintenance integration ───────────────────────
const limble = require('./limble-adapter');
limble.start();

// ── SOM (Schneider) Control Center integration ────────────────
const som = require('./som-adapter');
som.start();

// ── Network (UniFi) integration ─────────────────────────────────
const network = require('./network-adapter');
network.start();

// ── Container Inheritance (Coating Pipeline) ────────────────────
const containers = require('./container-service');

// ── Early Warning System ────────────────────────────────────────
const ews = require('./ews-engine');
const ewsCollectors = require('./ews-collectors');
// Collectors are registered after all adapters are loaded (see setTimeout below)

// ── DVI File Sync integration ─────────────────────────────────
const dviSync = require('./dvi-sync');
// Only start if configured (env vars set)
if (process.env.DVI_SYNC_USER) {
  dviSync.start().then(started => {
    if (started) console.log('[DVI-Sync] File sync service started');
  });
} else {
  console.log('[DVI-Sync] Skipped (DVI_SYNC_USER not set)');
}

// ── DVI Trace Watcher (live tray movement from LT files) ──────
const dviTrace = require('./dvi-trace');
dviTrace.start();
dviTrace.on('data', ({ count, file }) => {
  const status = dviTrace.getStatus();
  console.log(`[DVI-Trace] ${file}: +${count} events (${status.totalEvents} total, ${status.jobCount} jobs)`);
  // Sync all active jobs to SQLite for MCP agent queries
  try {
    const allJobs = dviTrace.getJobs();
    const activeJobs = allJobs.filter(j => j.status !== 'SHIPPED' && j.stage !== 'CANCELED');
    // Enrich with XML index data (coating, rush, frame)
    const enriched = activeJobs.map(j => {
      const xml = dviJobIndex.get(j.job_id);
      return {
        ...j,
        invoice: j.job_id,
        daysInLab: j.daysInLab || (j.firstSeen ? Math.max(0, (Date.now() - j.firstSeen) / 86400000) : 0),
        coating: xml?.coating || xml?.coatR || null,
        rush: xml?.rush || 'N',
        frameName: xml?.frameName || xml?.frame_name || null,
        entryDate: j.firstSeen ? new Date(j.firstSeen).toISOString().split('T')[0] : null,
      };
    });
    const today = new Date().toISOString().split('T')[0];
    labDb.upsertJobs(enriched, today);
    console.log(`[DB] Synced ${enriched.length} DVI jobs to SQLite`);
  } catch (e) { console.warn('[DB] DVI sync error:', e.message); }
});

// ── Initial SQLite sync after startup (give adapters time to load) ──
setTimeout(() => {
  try {
    const allJobs = dviTrace.getJobs();
    const activeJobs = allJobs.filter(j => j.status !== 'SHIPPED' && j.stage !== 'CANCELED');
    const enriched = activeJobs.map(j => {
      const xml = dviJobIndex.get(j.job_id);
      return {
        ...j,
        invoice: j.job_id,
        daysInLab: j.daysInLab || (j.firstSeen ? Math.max(0, (Date.now() - j.firstSeen) / 86400000) : 0),
        coating: xml?.coating || xml?.coatR || null,
        rush: xml?.rush || 'N',
        frameName: xml?.frameName || xml?.frame_name || null,
        entryDate: j.firstSeen ? new Date(j.firstSeen).toISOString().split('T')[0] : null,
      };
    });
    const today = new Date().toISOString().split('T')[0];
    labDb.upsertJobs(enriched, today);
    console.log(`[DB] Initial sync: ${enriched.length} DVI jobs to SQLite`);
  } catch (e) { console.warn('[DB] Initial DVI sync error:', e.message); }
}, 15000); // 15s delay for DVI trace history to load

// ── EWS: Register collectors and start engine (after adapters are up) ──
setTimeout(() => {
  ewsCollectors.register(ews, {
    som,
    itempath,
    dviTrace,
    labDb,
    limble,
    network,
    getOvenState: () => liveTimers,
  });
  ews.start();
}, 20000); // 20s — after adapters have had time to poll

// ── Periodic SQLite sync for inventory + maintenance ────────────
setInterval(() => {
  try {
    const inv = itempath.getInventory();
    if (inv.materials && inv.materials.length > 0) {
      labDb.upsertInventory(inv.materials);
    }
    if (inv.alerts && inv.alerts.length > 0) {
      labDb.upsertAlerts(inv.alerts);
    }
    const picks = itempath.getPicks();
    if (picks.activePicks && picks.activePicks.length > 0) {
      labDb.upsertPicks(picks.activePicks);
    }
  } catch (e) { /* inventory not ready yet */ }
  try {
    const assetsData = limble.getAssets();
    const tasksData = limble.getTasks();
    if (assetsData.assets && assetsData.assets.length > 0) labDb.upsertAssets(assetsData.assets);
    if (tasksData.tasks && tasksData.tasks.length > 0) labDb.upsertTasks(tasksData.tasks);
  } catch (e) { /* maintenance not ready yet */ }
}, 60000); // sync every 60s

// ── DVI Job Index (parsed from synced XML files) ──────────────
const dviJobIndex = new Map(); // dviJob# → {coating, lens, frame, rx, ...}

// Assembly config — persisted to SQLite, loaded on startup
const assemblyConfig = {
  assignments: labDb.getAssemblyConfig('assignments') || {},
  operators: labDb.getAssemblyConfig('operators') || {},
  operatorMap: labDb.getAssemblyConfig('operatorMap') || {},
  lbConfig: labDb.getAssemblyConfig('lbConfig') || null,
  updatedAt: labDb.getAssemblyConfig('updatedAt') || null,
};
const DVI_JOBS_DIR = path.join(__dirname, '..', 'data', 'dvi', 'jobs');
const DVI_SHIPPED_DIR = path.join(__dirname, '..', 'data', 'dvi', 'shipped');
const shippedJobIndex = new Map(); // jobNum → { shipDate, entryDate, coating, ... }

function parseDviXml(xml) {
  // Lightweight XML parser for DVI job files (no dependency needed)
  const get = (tag) => { const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`)); return m ? m[1].trim() : null; };
  const getAttr = (tag, attr) => { const m = xml.match(new RegExp(`<${tag}[^>]*\\s${attr}="([^"]*)"`)); return m ? m[1] : null; };

  // Extract lens-scoped fields from within <Lens> block
  const lensBlock = xml.match(/<Lens[^>]*>([\s\S]*?)<\/Lens>/);
  const lensXml = lensBlock ? lensBlock[0] : '';
  const getLens = (tag) => { const m = lensXml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`)); return m ? m[1].trim() : null; };

  // Extract frame-scoped fields
  const frameBlock = xml.match(/<Frame[^>]*>([\s\S]*?)<\/Frame>/);
  const frameXml = frameBlock ? frameBlock[0] : '';
  const getFrame = (tag) => { const m = frameXml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`)); return m ? m[1].trim() : null; };

  // Extract Rx data for each eye
  const rxBlocks = xml.match(/<Rx\s+Eye="([RL])">([\s\S]*?)<\/Rx>/g) || [];
  const rx = {};
  for (const block of rxBlocks) {
    const eyeMatch = block.match(/Eye="([RL])"/);
    if (!eyeMatch) continue;
    const eye = eyeMatch[1]; // R or L
    const sph = block.match(/<Sphere>([^<]*)<\/Sphere>/);
    const cyl = block.match(/<Cylinder[^>]*>([^<]*)<\/Cylinder>/);
    const axis = block.match(/<Cylinder\s+Axis="([^"]*)"/);
    const pd = block.match(/<PD>([^<]*)<\/PD>/);
    const addPow = block.match(/<Power>([^<]*)<\/Power>/);
    rx[eye] = {
      sphere: sph ? sph[1] : null,
      cylinder: cyl ? cyl[1] : null,
      axis: axis ? axis[1] : null,
      pd: pd ? pd[1] : null,
      add: addPow ? addPow[1] : null,
    };
  }

  // Extract OrderData attributes (ship date, entry date, etc.)
  const shipDate = getAttr('OrderData', 'ShipDate');
  const shipTime = getAttr('OrderData', 'ShipTime');
  const entryDate = getAttr('OrderData', 'EntryDate');
  const invoice = getAttr('OrderData', 'Invoice');
  const daysInLab = getAttr('RxOrder', 'DaysInLab');

  return {
    status: getAttr('Job', 'Status'),
    date: get('Date'),
    shipDate, shipTime, entryDate, invoice, daysInLab,
    rmtInv: get('RmtInv'),
    tray: get('Tray'),
    rxNum: get('RxNum'),
    patient: get('Patient'),
    origin: get('Origin'),
    coating: getLens('Coat') || get('Coat'),
    coatType: getAttr('Coat', 'Type'), // "Lab", "House", etc.
    lensType: getAttr('Lens', 'Type'), // P=progressive, S=SV, B=bifocal
    lensStyle: getLens('Style'),
    lensMat: getLens('Mat'),
    lensThick: getLens('Thick'),
    lensColor: getLens('Color'),
    frameStyle: getFrame('Style'),
    frameSku: getFrame('SKU'),
    frameMfr: getFrame('Mfr'),
    eyeSize: getFrame('EyeSize') || get('EyeSize'),
    bridge: getFrame('Bridge') || get('Bridge'),
    edge: getFrame('Edge') || get('Edge'),
    serviceInstruction: getAttr('Service', 'Instruction'),
    rx, // { R: {sphere,cylinder,axis,pd,add}, L: {sphere,cylinder,axis,pd,add} }
  };
}

function loadDviJobIndex() {
  if (!fs.existsSync(DVI_JOBS_DIR)) return;
  const files = fs.readdirSync(DVI_JOBS_DIR).filter(f => f.endsWith('.xml'));
  let loaded = 0;
  for (const file of files) {
    try {
      const jobNum = path.basename(file, '.xml');
      if (dviJobIndex.has(jobNum)) continue;
      const xml = fs.readFileSync(path.join(DVI_JOBS_DIR, file), 'utf8');
      const parsed = parseDviXml(xml);
      dviJobIndex.set(jobNum, parsed);
      loaded++;
    } catch (e) { /* skip bad files */ }
  }
  if (loaded > 0) console.log(`[DVI-Index] Loaded ${loaded} job files (${dviJobIndex.size} total)`);
}

function loadShippedIndex() {
  if (!fs.existsSync(DVI_SHIPPED_DIR)) return;
  const files = fs.readdirSync(DVI_SHIPPED_DIR).filter(f => f.endsWith('.xml'));
  let loaded = 0;
  for (const file of files) {
    try {
      const jobNum = path.basename(file, '.xml');
      if (shippedJobIndex.has(jobNum)) continue;
      const xml = fs.readFileSync(path.join(DVI_SHIPPED_DIR, file), 'utf8');
      const parsed = parseDviXml(xml);
      // Parse ship date into timestamp
      if (parsed.shipDate) {
        const [mm, dd, yy] = parsed.shipDate.split('/');
        const [hh, min] = (parsed.shipTime || '12:00').split(':');
        parsed.shippedAt = new Date(`20${yy}-${mm}-${dd}T${String(hh).padStart(2,'0')}:${String(min||0).padStart(2,'0')}:00`).getTime();
      }
      if (parsed.entryDate) {
        const [mm, dd, yy] = parsed.entryDate.split('/');
        parsed.enteredAt = new Date(`20${yy}-${mm}-${dd}T00:00:00`).getTime();
      }
      shippedJobIndex.set(jobNum, parsed);
      loaded++;
    } catch (e) { /* skip bad files */ }
  }
  if (loaded > 0) console.log(`[DVI-Shipped] Loaded ${loaded} shipped files (${shippedJobIndex.size} total)`);
}

// Load on startup and refresh every 60s
loadDviJobIndex();
loadShippedIndex();
setInterval(loadDviJobIndex, 60000);
setInterval(loadShippedIndex, 60000);

// Demo mode: seed DVI trace + coating runs when SMB is unreachable
if (process.env.DEMO_MODE === 'true') {
  setTimeout(() => {
    // Seed trace with real jobs distributed across stages
    if (dviJobIndex.size > 0) {
      dviTrace.seedFromIndex(dviJobIndex);
    }

    // Seed active coating runs on EB machines
    const coatingJobs = [...dviJobIndex.keys()].filter(id => {
      const j = dviJobIndex.get(id);
      return j && (j.coating || j.coatType);
    }).slice(0, 80);

    const eb1Jobs = coatingJobs.slice(0, 45);
    const eb2Jobs = coatingJobs.slice(45, 80);
    if (eb1Jobs.length > 0) {
      coatingRuns['EB9001'] = {
        coaterId: 'EB9001', coaterName: 'EB9 #1',
        coating: 'AR',
        startedAt: Date.now() - 42 * 60000, // 42 min into a 2hr run
        targetSec: 7200,
        jobs: eb1Jobs, jobCount: eb1Jobs.length,
        lensCount: eb1Jobs.length * 2,
        orderCount: eb1Jobs.length,
        fillPct: Math.round((eb1Jobs.length * 2 / 114) * 100),
        status: 'running'
      };
      console.log(`[Demo] EB9 #1: ${eb1Jobs.length} jobs, AR, 42 min in`);
    }
    if (eb2Jobs.length > 0) {
      coatingRuns['EB9002'] = {
        coaterId: 'EB9002', coaterName: 'EB9 #2',
        coating: 'BLUE CUT',
        startedAt: Date.now() - 18 * 60000, // 18 min into run
        targetSec: 7200,
        jobs: eb2Jobs, jobCount: eb2Jobs.length,
        lensCount: eb2Jobs.length * 2,
        orderCount: eb2Jobs.length,
        fillPct: Math.round((eb2Jobs.length * 2 / 114) * 100),
        status: 'running'
      };
      console.log(`[Demo] EB9 #2: ${eb2Jobs.length} jobs, BLUE CUT, 18 min in`);
    }
  }, 2000);
}

// Also reload when dvi-sync copies new files
dviSync.on('file', (evt) => {
  if (evt.sync === 'jobs') {
    setTimeout(loadDviJobIndex, 1000);
  }
});

const PORT      = parseInt(process.env.PORT || '3002', 10);
const DATA_FILE = path.join(__dirname, 'oven-runs.json');
const MAX_RUNS  = 20000;
const CORS      = process.env.CORS_ORIGIN || '*';

// ── In-memory state ───────────────────────────────────────────

let runs        = [];
let liveTimers  = {};   // keyed by "ovenId::rack"
let liveUpdated = 0;    // timestamp of last live heartbeat

// ── Oven rack job tracking ──────────────────────────────────────
// Each rack: { ovenId, rackIndex, jobs: [jobId, ...], coating, loadedAt }
const OVEN_RACK_JOBS_FILE = path.join(__dirname, '..', 'data', 'oven-rack-jobs.json');
let ovenRackJobs = {}; // keyed by "Oven N::R<rackIndex>" → { jobs, coating, loadedAt }
try {
  if (fs.existsSync(OVEN_RACK_JOBS_FILE)) {
    ovenRackJobs = JSON.parse(fs.readFileSync(OVEN_RACK_JOBS_FILE, 'utf8'));
    const count = Object.values(ovenRackJobs).reduce((s, r) => s + (r.jobs?.length || 0), 0);
    console.log(`✅ Loaded oven rack jobs: ${count} jobs across ${Object.keys(ovenRackJobs).length} racks`);
  }
} catch (e) { console.warn('⚠️  Could not load oven-rack-jobs.json:', e.message); }
function persistOvenRackJobs() {
  try { fs.writeFileSync(OVEN_RACK_JOBS_FILE, JSON.stringify(ovenRackJobs)); } catch {}
}

// ── Coating run timers (server-authoritative) ──────────────────
// Each active run: { coaterId, coaterName, startedAt, targetSec, jobs, status }
let coatingRuns = {};   // keyed by coaterId
const COATING_RUNS_FILE = path.join(__dirname, '..', 'data', 'coating-runs.json');
let coatingRunHistory = [];
try {
  if (fs.existsSync(COATING_RUNS_FILE)) {
    coatingRunHistory = JSON.parse(fs.readFileSync(COATING_RUNS_FILE, 'utf8'));
    console.log(`✅ Loaded ${coatingRunHistory.length} coating run history`);
  }
} catch (e) { console.warn('⚠️  Could not load coating-runs.json:', e.message); }
function persistCoatingRuns() {
  try { fs.writeFileSync(COATING_RUNS_FILE, JSON.stringify(coatingRunHistory.slice(0, 500))); } catch {}
}

try {
  if (fs.existsSync(DATA_FILE)) {
    runs = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    console.log(`✅ Loaded ${runs.length} historical runs from disk`);
  }
} catch (e) { console.warn('⚠️  Could not load oven-runs.json:', e.message); }

function persist() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(runs.slice(0, MAX_RUNS))); } catch {}
}

// ── Helpers ───────────────────────────────────────────────────

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  CORS);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
function json(res, data, status=200) {
  cors(res);
  res.writeHead(status, {'Content-Type':'application/json'});
  res.end(JSON.stringify(data));
}
function html(res, body) {
  cors(res);
  res.writeHead(200, {'Content-Type':'text/html;charset=utf-8'});
  res.end(body);
}
function readBody(req) {
  return new Promise((ok, fail) => {
    let b='';
    req.on('data', c => b+=c);
    req.on('end', () => { try { ok(JSON.parse(b)); } catch { fail(new Error('Bad JSON')); } });
    req.on('error', fail);
  });
}
// Simple multipart/form-data parser (no dependencies)
function parseMultipart(buf, boundary) {
  const parts = [];
  const delim = Buffer.from('--' + boundary);
  let pos = 0;
  while (pos < buf.length) {
    const start = buf.indexOf(delim, pos);
    if (start === -1) break;
    const nextStart = buf.indexOf(delim, start + delim.length + 2);
    if (nextStart === -1) break;
    const partBuf = buf.slice(start + delim.length + 2, nextStart);
    const headerEnd = partBuf.indexOf('\r\n\r\n');
    if (headerEnd === -1) { pos = nextStart; continue; }
    const headerStr = partBuf.slice(0, headerEnd).toString('utf-8');
    const data = partBuf.slice(headerEnd + 4, partBuf.length - 2); // strip trailing \r\n
    const nameMatch = headerStr.match(/name="([^"]+)"/);
    const filenameMatch = headerStr.match(/filename="([^"]+)"/);
    const ctMatch = headerStr.match(/Content-Type:\s*(\S+)/i);
    parts.push({
      name: nameMatch ? nameMatch[1] : null,
      filename: filenameMatch ? filenameMatch[1] : null,
      contentType: ctMatch ? ctMatch[1] : null,
      data,
    });
    pos = nextStart;
  }
  return parts;
}

function fmtSecs(s) {
  const a=Math.abs(s), m=Math.floor(a/60), sc=a%60;
  return `${s<0?'-':''}${String(m).padStart(2,'0')}:${String(sc).padStart(2,'0')}`;
}
function isToday(ts) {
  return new Date(ts).toDateString() === new Date().toDateString();
}

// ── Mobile status page HTML ───────────────────────────────────

function buildStatusPage() {
  const liveEntries = Object.values(liveTimers);
  const stale = (Date.now() - liveUpdated) > 15000;  // no heartbeat in 15s
  const todayRuns = runs.filter(r => isToday(r.startedAt));

  // Group live timers by oven
  const byOven = {};
  liveEntries.forEach(t => {
    if (!byOven[t.ovenId]) byOven[t.ovenId] = { name:t.ovenName, racks:[] };
    byOven[t.ovenId].racks.push(t);
  });

  const ovenCards = Object.entries(byOven).map(([ovenId, oven]) => {
    const racks = oven.racks.map(t => {
      const isOT   = t.target > 0 && t.elapsed >= t.target;
      const pct    = t.target > 0 ? Math.min(100, Math.round(t.elapsed/t.target*100)) : 0;
      const color  = isOT ? '#EF4444' : t.state==='paused' ? '#F59E0B' : '#10B981';
      const label  = isOT ? 'OVERTIME' : t.state.toUpperCase();
      const rem    = t.target > 0 ? Math.max(0, t.target - t.elapsed) : null;
      return `
        <div style="background:#0D1117;border:1px solid ${color}30;border-radius:10px;padding:12px 14px;margin-bottom:8px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
            <div style="font-family:monospace;font-size:12px;font-weight:800;color:#E8EDF2;">${t.rackLabel||t.rack}</div>
            <div style="font-family:monospace;font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px;background:${color}20;color:${color};">${label}</div>
          </div>
          <div style="font-family:monospace;font-size:38px;font-weight:900;color:${color};letter-spacing:2px;line-height:1;margin:4px 0;">${fmtSecs(t.elapsed)}</div>
          ${t.target>0 ? `
            <div style="height:4px;background:#1C2733;border-radius:2px;overflow:hidden;margin:8px 0 4px;">
              <div style="height:100%;width:${pct}%;background:${color};border-radius:2px;"></div>
            </div>
            <div style="font-family:monospace;font-size:10px;color:#8899AA;">${rem!==null?`${fmtSecs(rem)} remaining · `:''}Target: ${fmtSecs(t.target)}</div>
          ` : ''}
          ${t.batchId ? `<div style="font-family:monospace;font-size:10px;color:#445566;margin-top:4px;">Batch: ${t.batchId}${t.coating?' · '+t.coating:''}</div>` : ''}
          ${t.presets&&t.presets.length ? `<div style="font-family:monospace;font-size:10px;color:#3B82F6;margin-top:3px;">${t.presets.join(' + ')}</div>` : ''}
        </div>`;
    }).join('');

    return `
      <div style="background:#111820;border:1px solid #1C2733;border-radius:12px;margin-bottom:14px;overflow:hidden;">
        <div style="padding:10px 14px;border-bottom:1px solid #1C2733;display:flex;justify-content:space-between;align-items:center;">
          <div style="font-family:monospace;font-size:14px;font-weight:800;color:#F59E0B;">${oven.name}</div>
          <div style="font-family:monospace;font-size:10px;color:#445566;">${oven.racks.length} running</div>
        </div>
        <div style="padding:10px;">${racks}</div>
      </div>`;
  }).join('');

  const noActivity = liveEntries.length === 0;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<meta http-equiv="refresh" content="8"/>
<title>Oven Status — Pair Eyewear</title>
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=JetBrains+Mono:wght@400;700;800&family=DM+Sans:wght@400;600;700&display=swap" rel="stylesheet"/>
<style>
  *{box-sizing:border-box;margin:0;padding:0;}
  body{background:#070A0F;color:#E8EDF2;font-family:'DM Sans',sans-serif;min-height:100vh;max-width:500px;margin:0 auto;padding:0 0 32px;}
  .hdr{background:#0D1117;border-bottom:1px solid #1C2733;padding:14px 16px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:10;}
  .logo{display:flex;align-items:center;gap:10px;}
  .lm{width:36px;height:36px;background:linear-gradient(135deg,#F59E0B,#B45309);border-radius:8px;display:flex;align-items:center;justify-content:center;font-family:monospace;font-weight:800;font-size:13px;color:#000;}
  .lt{font-size:16px;font-weight:700;}
  .ls{font-family:monospace;font-size:8px;color:#8899AA;letter-spacing:2px;}
  .clock{font-family:monospace;font-size:16px;font-weight:700;color:#F59E0B;letter-spacing:2px;}
  .kpi-row{display:flex;gap:0;margin:12px 16px;background:#111820;border:1px solid #1C2733;border-radius:10px;overflow:hidden;}
  .kpi{flex:1;padding:10px 8px;text-align:center;border-right:1px solid #1C2733;}
  .kpi:last-child{border-right:none;}
  .kpi-v{font-family:monospace;font-size:20px;font-weight:800;}
  .kpi-l{font-family:monospace;font-size:8px;color:#8899AA;letter-spacing:1px;margin-top:1px;}
  .section{padding:8px 16px 0;font-family:monospace;font-size:9px;color:#445566;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px;}
  .idle-msg{margin:0 16px;padding:20px;background:#111820;border:1px solid #1C2733;border-radius:10px;text-align:center;font-family:monospace;font-size:12px;color:#445566;}
  .refresh{text-align:center;margin-top:20px;font-family:monospace;font-size:9px;color:#1C2733;}
  .today-run{display:flex;justify-content:space-between;align-items:center;padding:8px 12px;border-bottom:1px solid #1C2733;}
  .today-run:last-child{border-bottom:none;}
  ${stale ? '.stale-warn{background:#3F0A0A;border:1px solid #EF4444;border-radius:8px;padding:8px 12px;margin:10px 16px;font-family:monospace;font-size:10px;color:#EF4444;text-align:center;}':''}
</style>
</head>
<body>
<div class="hdr">
  <div class="logo">
    <div class="lm">OT</div>
    <div><div class="lt">Oven Status</div><div class="ls">Pair Eyewear · Lab</div></div>
  </div>
  <div class="clock" id="clk">${new Date().toLocaleTimeString('en-US',{hour12:false})}</div>
</div>

${stale && liveEntries.length ? '<div class="stale-warn">⚠ Timer app may be offline — data may be stale</div>' : ''}

<div class="kpi-row">
  <div class="kpi"><div class="kpi-v" style="color:${liveEntries.length?'#10B981':'#445566'}">${liveEntries.length}</div><div class="kpi-l">RUNNING</div></div>
  <div class="kpi"><div class="kpi-v" style="color:#F59E0B">${todayRuns.length}</div><div class="kpi-l">TODAY RUNS</div></div>
  <div class="kpi"><div class="kpi-v" style="color:#06B6D4">${(todayRuns.reduce((s,r)=>s+r.actualSecs,0)/3600).toFixed(1)}h</div><div class="kpi-l">TODAY HRS</div></div>
</div>

<div class="section">Active Ovens</div>
<div style="padding:0 16px;">
  ${noActivity
    ? '<div class="idle-msg">All racks idle</div>'
    : ovenCards
  }
</div>

${todayRuns.length ? `
<div class="section" style="margin-top:16px;">Today's Completed Runs</div>
<div style="margin:0 16px;background:#111820;border:1px solid #1C2733;border-radius:10px;overflow:hidden;">
  ${todayRuns.slice(0,15).map(r=>{
    const vc = r.variance===null ? '#445566' : r.variance>120 ? '#EF4444' : r.variance<-120 ? '#10B981' : '#445566';
    return `<div class="today-run">
      <div>
        <div style="font-family:monospace;font-size:11px;font-weight:700;color:#F59E0B;">${r.ovenName} · ${r.rackLabel||r.rack}</div>
        <div style="font-family:monospace;font-size:9px;color:#445566;">${r.batchId}${r.coating?' · '+r.coating:''}</div>
      </div>
      <div style="text-align:right;">
        <div style="font-family:monospace;font-size:13px;font-weight:800;color:#E8EDF2;">${fmtSecs(r.actualSecs)}</div>
        ${r.variance!==null?`<div style="font-family:monospace;font-size:9px;color:${vc};font-weight:700;">${r.variance>0?'+':''}${fmtSecs(r.variance)}</div>`:''}
      </div>
    </div>`;
  }).join('')}
</div>
` : ''}

<div class="refresh">Auto-refreshes every 8 seconds · ${new Date().toLocaleTimeString('en-US',{hour12:false})}</div>

<script>
  function tick(){document.getElementById('clk').textContent=new Date().toLocaleTimeString('en-US',{hour12:false});}
  setInterval(tick,1000);
</script>
</body>
</html>`;
}

function buildLandingPage() {
  const now = new Date();
  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  const todayMs = todayStart.getTime();

  // Shift starts at 5 AM
  const shiftStart = new Date(); shiftStart.setHours(5,0,0,0);
  const shiftH = Math.max(0, (now - shiftStart) / 3600000);

  // Get live stats from trace
  const allJobs = dviTrace.getJobs();
  const shippedToday = allJobs.filter(j => j.stage === 'SHIPPING' && j.lastSeen >= todayMs).length;
  const wipCount = allJobs.filter(j => j.stage !== 'SHIPPING' && j.stage !== 'CANCELED').length;

  // Assembly completions (count ASSEMBLY PASS/FAIL events today)
  let assembledToday = 0;
  for (const j of allJobs) {
    const history = dviTrace.getJobHistory(j.job_id);
    if (!history || !history.events) continue;
    for (const e of history.events) {
      if (e.timestamp >= todayMs && (e.station === 'ASSEMBLY PASS' || e.station === 'ASSEMBLY FAIL')) {
        assembledToday++;
      }
    }
  }
  const avgRate = shiftH > 0 ? (assembledToday / shiftH).toFixed(1) : '—';

  const apps = [
    { name:'Assembly Dashboard', icon:'🔧', desc:'Live assembly floor — stations, operators, leaderboard', path:'/standalone/AssemblyDashboard.html', color:'#8B5CF6' },
    { name:'Oven Timer', icon:'🔥', desc:'Coating oven rack timers — 6 racks per oven', path:'/standalone/OvenTimer.html', color:'#F59E0B' },
    { name:'Coating Timer', icon:'⏱', desc:'Per-coater timer — single large display', path:'/standalone/CoatingTimer.html', color:'#06B6D4' },
  ];
  const cards = apps.map(a => `
    <a href="${a.path}" style="text-decoration:none;display:block;background:#111820;border:2px solid #1C2733;border-radius:14px;padding:28px 24px;transition:border-color .15s;cursor:pointer;" onmouseover="this.style.borderColor='${a.color}'" onmouseout="this.style.borderColor='#1C2733'">
      <div style="font-size:36px;margin-bottom:12px;">${a.icon}</div>
      <div style="font-family:'Bebas Neue',sans-serif;font-size:22px;color:${a.color};letter-spacing:1px;">${a.name.toUpperCase()}</div>
      <div style="font-family:'JetBrains Mono',monospace;font-size:10px;color:#8899AA;margin-top:6px;">${a.desc}</div>
    </a>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<meta http-equiv="refresh" content="30"/>
<title>Lab Assistant — Pair Eyewear</title>
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=JetBrains+Mono:wght@400;700;800&family=DM+Sans:wght@400;600;700&display=swap" rel="stylesheet"/>
<style>
  *{box-sizing:border-box;margin:0;padding:0;}
  body{background:#070A0F;color:#E8EDF2;font-family:'DM Sans',sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 20px;}
</style>
</head>
<body>
  <div style="text-align:center;margin-bottom:24px;">
    <div style="width:56px;height:56px;background:linear-gradient(135deg,#10B981,#059669);border-radius:12px;display:inline-flex;align-items:center;justify-content:center;font-family:'JetBrains Mono',monospace;font-weight:800;font-size:16px;color:#fff;margin-bottom:12px;">LA</div>
    <div style="font-family:'Bebas Neue',sans-serif;font-size:36px;letter-spacing:2px;">LAB ASSISTANT</div>
    <div style="font-family:'JetBrains Mono',monospace;font-size:10px;color:#445566;letter-spacing:3px;">PAIR EYEWEAR · IRVINE</div>
  </div>
  <div style="display:flex;gap:24px;justify-content:center;margin-bottom:32px;">
    <div style="text-align:center;">
      <div style="font-family:'JetBrains Mono',monospace;font-size:48px;font-weight:800;color:#8B5CF6;line-height:1;">${assembledToday}</div>
      <div style="font-family:'JetBrains Mono',monospace;font-size:9px;color:#8899AA;letter-spacing:2px;margin-top:4px;">ASSEMBLED TODAY</div>
    </div>
    <div style="text-align:center;">
      <div style="font-family:'JetBrains Mono',monospace;font-size:48px;font-weight:800;color:#06B6D4;line-height:1;">${avgRate}</div>
      <div style="font-family:'JetBrains Mono',monospace;font-size:9px;color:#8899AA;letter-spacing:2px;margin-top:4px;">JOBS / HOUR</div>
    </div>
    <div style="text-align:center;">
      <div style="font-family:'JetBrains Mono',monospace;font-size:48px;font-weight:800;color:#3B82F6;line-height:1;">${shippedToday}</div>
      <div style="font-family:'JetBrains Mono',monospace;font-size:9px;color:#8899AA;letter-spacing:2px;margin-top:4px;">SHIPPED TODAY</div>
    </div>
    <div style="text-align:center;">
      <div style="font-family:'JetBrains Mono',monospace;font-size:48px;font-weight:800;color:#10B981;line-height:1;">${wipCount}</div>
      <div style="font-family:'JetBrains Mono',monospace;font-size:9px;color:#8899AA;letter-spacing:2px;margin-top:4px;">TOTAL WIP</div>
    </div>
  </div>
  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px;max-width:900px;width:100%;">
    ${cards}
  </div>
  <div style="margin-top:40px;font-family:'JetBrains Mono',monospace;font-size:9px;color:#1C2733;">
    <a href="/oven" style="color:#445566;text-decoration:none;margin-right:16px;">Oven Status</a>
    <a href="/api/dvi/trace/status" style="color:#445566;text-decoration:none;margin-right:16px;">Trace API</a>
    <a href="/api/assembly/jobs" style="color:#445566;text-decoration:none;">Assembly API</a>
  </div>
</body>
</html>`;
}

// ── Request handler ───────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return; }

  // ── Health ──────────────────────────────────────────────────
  if (req.method==='GET' && url.pathname==='/health') {
    return json(res, {ok:true,service:'oven-timer-server',port:PORT,runs:runs.length,liveRacks:Object.keys(liveTimers).length});
  }

  // ── Mobile status page ──────────────────────────────────────
  if (req.method==='GET' && url.pathname==='/oven') {
    return html(res, buildStatusPage());
  }
  if (req.method==='GET' && (url.pathname==='/' || url.pathname==='/status')) {
    return html(res, buildLandingPage());
  }

  // ── POST completed run ──────────────────────────────────────
  if (req.method==='POST' && url.pathname==='/api/oven-run') {
    try {
      const run = await readBody(req);
      if (!run.ovenId || typeof run.actualSecs !== 'number') return json(res,{ok:false,error:'Missing fields'},400);
      run.receivedAt = Date.now();
      run.id = run.id || Date.now();
      if (!runs.find(r=>r.id===run.id)) {
        runs.unshift(run);
        persist();
        console.log(`📥 ${run.ovenName||run.ovenId} ${run.rackLabel||run.rack} | ${run.coating} | ${fmtSecs(run.actualSecs)}`);
      }
      return json(res,{ok:true,total:runs.length});
    } catch(e) { return json(res,{ok:false,error:e.message},400); }
  }

  // ── POST live heartbeat ─────────────────────────────────────
  if (req.method==='POST' && url.pathname==='/api/oven-live') {
    try {
      liveTimers  = await readBody(req);
      liveUpdated = Date.now();
      return json(res,{ok:true});
    } catch(e) { return json(res,{ok:false,error:e.message},400); }
  }

  // ── GET run history ─────────────────────────────────────────
  if (req.method==='GET' && url.pathname==='/api/oven-runs') {
    let result = [...runs];
    const oven   = url.searchParams.get('oven');
    const rack   = url.searchParams.get('rack');
    const coating= url.searchParams.get('coating');
    const limit  = parseInt(url.searchParams.get('limit')||'500');
    const since  = parseInt(url.searchParams.get('since')||'0');
    if (oven)    result = result.filter(r=>r.ovenId===oven||r.ovenName===oven);
    if (rack)    result = result.filter(r=>r.rack===rack);
    if (coating) result = result.filter(r=>r.coating===coating);
    if (since)   result = result.filter(r=>r.startedAt>=since);
    return json(res,{ok:true,runs:result.slice(0,limit),total:runs.length});
  }

  // ── GET live state ──────────────────────────────────────────
  if (req.method==='GET' && url.pathname==='/api/oven-live') {
    return json(res,{ok:true,timers:liveTimers,asOf:liveUpdated,stale:(Date.now()-liveUpdated)>15000});
  }

  // ── GET stats ───────────────────────────────────────────────
  if (req.method==='GET' && url.pathname==='/api/oven-stats') {
    const today = new Date(); today.setHours(0,0,0,0);
    const todayRuns = runs.filter(r=>r.startedAt>=today.getTime());

    // Per-oven stats
    const byOven = {};
    runs.forEach(r=>{
      const k=r.ovenId;
      if(!byOven[k]) byOven[k]={ovenId:k,ovenName:r.ovenName||k,count:0,totalSecs:0,byRack:{},byCoating:{}};
      byOven[k].count++; byOven[k].totalSecs+=r.actualSecs;
      if(!byOven[k].byRack[r.rack]) byOven[k].byRack[r.rack]={count:0,totalSecs:0};
      byOven[k].byRack[r.rack].count++; byOven[k].byRack[r.rack].totalSecs+=r.actualSecs;
      const c=r.coating||'Unknown';
      if(!byOven[k].byCoating[c]) byOven[k].byCoating[c]={count:0,totalSecs:0};
      byOven[k].byCoating[c].count++; byOven[k].byCoating[c].totalSecs+=r.actualSecs;
    });

    // Per-coating stats
    const byCoating={};
    runs.forEach(r=>{
      const c=r.coating||'Unknown';
      if(!byCoating[c]) byCoating[c]={coating:c,count:0,totalSecs:0,times:[]};
      byCoating[c].count++; byCoating[c].totalSecs+=r.actualSecs; byCoating[c].times.push(r.actualSecs);
    });
    const coatingStats=Object.values(byCoating).map(c=>({
      coating:c.coating, count:c.count,
      avgSecs:Math.round(c.totalSecs/c.count),
      minSecs:Math.min(...c.times), maxSecs:Math.max(...c.times),
    }));

    return json(res,{
      ok:true,
      totalRuns:runs.length,
      todayRuns:todayRuns.length,
      todayHours:parseFloat((todayRuns.reduce((s,r)=>s+r.actualSecs,0)/3600).toFixed(2)),
      overtimeRuns:runs.filter(r=>r.variance!==null&&r.variance>120).length,
      byOven:Object.values(byOven),
      coatingStats,
    });
  }

  // ── DELETE history ──────────────────────────────────────────
  if (req.method==='DELETE' && url.pathname==='/api/oven-runs') {
    runs=[]; persist(); return json(res,{ok:true,message:'History cleared'});
  }

  // ── POST coating run completed ───────────────────────────────
  // Body: { coater, slot, coatingType, coatingLabel, trays, targetMin,
  //         durationSec, operator, notes, completedAt }
  if (req.method==='POST' && url.pathname==='/api/coating-run') {
    const body = await readBody(req);
    const entry = {
      id: Date.now(),
      coater:       body.coater       || 'C?',
      slot:         body.slot         || '',
      coatingType:  body.coatingType  || '',
      coatingLabel: body.coatingLabel || body.coatingType || '',
      trays:        Number(body.trays)||0,
      targetMin:    Number(body.targetMin)||0,
      durationSec:  Number(body.durationSec)||0,
      onTime:       Number(body.durationSec) <= Number(body.targetMin)*60,
      operator:     body.operator     || '',
      notes:        body.notes        || '',
      completedAt:  body.completedAt  || new Date().toISOString(),
    };
    if (!global.coatingRuns) global.coatingRuns = [];
    global.coatingRuns.unshift(entry);
    global.coatingRuns = global.coatingRuns.slice(0, 5000);
    console.log(`[Coating] ${entry.coater} ${entry.slot} — ${entry.coatingLabel} · ${entry.trays}T · ${Math.round(entry.durationSec/60)}min`);
    return json(res, { ok:true, id:entry.id });
  }

  // ── POST coating live heartbeat ──────────────────────────────
  if (req.method==='POST' && url.pathname==='/api/coating-live') {
    const body = await readBody(req);
    global.coatingLive = { ...body, receivedAt: Date.now() };
    return json(res, { ok:true });
  }

  // ── GET coating runs history ─────────────────────────────────
  if (req.method==='GET' && url.pathname==='/api/coating-runs') {
    const limit = parseInt(new URL('http://x'+req.url).searchParams.get('limit')||'200');
    return json(res, { ok:true, runs: (global.coatingRuns||[]).slice(0,limit) });
  }

  // ── GET coating live state ───────────────────────────────────
  if (req.method==='GET' && url.pathname==='/api/coating-live') {
    return json(res, { ok:true, ...( global.coatingLive || { live:[], timestamp:null } ) });
  }

  // ── Oven Rack Job Tracking ──────────────────────────────────
  // POST /api/oven/rack/jobs — set jobs on a specific oven rack
  // Body: { ovenId: "Oven 1", rackIndex: 1, jobs: ["408201","408202"], coating: "AR" }
  if (req.method==='POST' && url.pathname==='/api/oven/rack/jobs') {
    try {
      const body = await readBody(req);
      const { ovenId, rackIndex, jobs, coating } = body;
      if (!ovenId || !rackIndex) return json(res, {ok:false, error:'ovenId and rackIndex required'}, 400);
      const key = `${ovenId}::R${rackIndex}`;
      if (!jobs || jobs.length === 0) {
        // Clear rack
        delete ovenRackJobs[key];
      } else {
        ovenRackJobs[key] = {
          ovenId, rackIndex, jobs: jobs.filter(j => j),
          coating: coating || 'AR', loadedAt: Date.now(),
        };
      }
      persistOvenRackJobs();
      console.log(`[Oven] ${ovenId} R${rackIndex}: ${jobs?.length || 0} jobs ${jobs?.length ? 'loaded' : 'cleared'}`);
      return json(res, {ok:true, rack: ovenRackJobs[key] || null});
    } catch(e) { return json(res, {ok:false, error:e.message}, 400); }
  }

  // GET /api/oven/rack/jobs — get all oven rack job assignments
  if (req.method==='GET' && url.pathname==='/api/oven/rack/jobs') {
    return json(res, {ok:true, racks: ovenRackJobs});
  }

  // DELETE /api/oven/rack/jobs — clear a specific rack
  if (req.method==='DELETE' && url.pathname==='/api/oven/rack/jobs') {
    try {
      const body = await readBody(req);
      const { ovenId, rackIndex } = body;
      const key = `${ovenId}::R${rackIndex}`;
      delete ovenRackJobs[key];
      persistOvenRackJobs();
      return json(res, {ok:true});
    } catch(e) { return json(res, {ok:false, error:e.message}, 400); }
  }

  // ── Coating Run Timer Management (server-authoritative) ─────
  // POST /api/coating/run/start — start a coating run (requires full batch)
  if (req.method==='POST' && url.pathname==='/api/coating/run/start') {
    try {
      const body = await readBody(req);
      const { coaterId, coaterName, jobs, targetSec } = body;
      if (!coaterId) return json(res, {ok:false, error:'coaterId required'}, 400);
      if (!jobs || !Array.isArray(jobs) || jobs.length === 0) return json(res, {ok:false, error:'jobs array required — batch must be full'}, 400);
      if (coatingRuns[coaterId] && coatingRuns[coaterId].status === 'running') {
        return json(res, {ok:false, error:`${coaterName||coaterId} already has a running timer`}, 400);
      }
      coatingRuns[coaterId] = {
        coaterId, coaterName: coaterName || coaterId,
        startedAt: Date.now(),
        targetSec: targetSec || 7200, // default 2hr
        jobs: jobs.map(j => typeof j === 'string' ? j : j.jobId || j),
        jobCount: jobs.length,
        status: 'running',
      };
      console.log(`[Coating] Started run on ${coaterName||coaterId}: ${jobs.length} jobs, ${(targetSec||7200)/3600}h target`);
      return json(res, {ok:true, run: coatingRuns[coaterId]});
    } catch(e) { return json(res, {ok:false, error:e.message}, 400); }
  }

  // POST /api/coating/run/stop — stop/complete a coating run
  if (req.method==='POST' && url.pathname==='/api/coating/run/stop') {
    try {
      const body = await readBody(req);
      const { coaterId } = body;
      if (!coaterId || !coatingRuns[coaterId]) return json(res, {ok:false, error:'No active run for this coater'}, 400);
      const run = coatingRuns[coaterId];
      const elapsed = Math.round((Date.now() - run.startedAt) / 1000);
      const completed = { ...run, status: 'completed', stoppedAt: Date.now(), elapsedSec: elapsed };
      coatingRunHistory.unshift(completed);
      persistCoatingRuns();
      delete coatingRuns[coaterId];
      console.log(`[Coating] Stopped run on ${run.coaterName}: ${elapsed}s elapsed, ${run.jobCount} jobs`);
      return json(res, {ok:true, run: completed});
    } catch(e) { return json(res, {ok:false, error:e.message}, 400); }
  }

  // POST /api/coating/run/feedback — operator rates a completed batch
  if (req.method==='POST' && url.pathname==='/api/coating/run/feedback') {
    try {
      const body = await readBody(req);
      const { runId, rating, feedback } = body;
      // Find in history and update
      const run = coatingRunHistory.find(r => r.startedAt === runId || r.coaterId === runId);
      if (run) {
        run.feedbackRating = rating;
        run.feedbackText = feedback || '';
        run.feedbackAt = Date.now();
        persistCoatingRuns();
      }
      console.log(`[Coating] Feedback: ${rating}/5 — ${feedback || 'no comment'}`);
      return json(res, {ok:true, message: `Feedback recorded: ${rating}/5`});
    } catch(e) { return json(res, {ok:false, error:e.message}, 400); }
  }

  // GET /api/coating/runs — active runs + elapsed time (computed server-side)
  if (req.method==='GET' && url.pathname==='/api/coating/runs') {
    const now = Date.now();
    const active = {};
    for (const [id, run] of Object.entries(coatingRuns)) {
      const elapsed = Math.round((now - run.startedAt) / 1000);
      const remaining = Math.max(0, run.targetSec - elapsed);
      active[id] = { ...run, elapsedSec: elapsed, remainingSec: remaining, remainingMin: Math.round(remaining / 60) };
    }
    return json(res, {ok:true, active, history: coatingRunHistory.slice(0, 50)});
  }

  // ── GET coating intelligence ──────────────────────────────
  // Combines: DVI trace (coating queue), oven live state, oven runs,
  // coating runs, DVI XML (coating types) into a single coaching payload
  if (req.method==='GET' && url.pathname==='/api/coating/intelligence') {
    // All capacity/threshold values can be overridden via query params
    const p = (k, def) => parseInt(url.searchParams.get(k)) || def;

    // Coater definitions — each coater has its own lens capacity
    const COATERS = [
      { id: 'EB9001', name: 'EB9 #1', somId: 'EB9001', lensCapacity: p('eb9Capacity', 114), orderCapacity: 57, runHours: 2 },
      { id: 'EB9002', name: 'EB9 #2', somId: 'EB9002', lensCapacity: p('eb9Capacity', 114), orderCapacity: 57, runHours: 2 },
      { id: 'E14001', name: 'E1400',  somId: 'E14001', lensCapacity: p('e14Capacity', 274), orderCapacity: 137, runHours: 2 },
    ];

    // Oven capacity
    const RACK_CAPACITY = p('rackSize', 36);
    const OVEN_COUNT = p('ovenCount', 6);
    const RACKS_PER_OVEN = p('racksPerOven', 7);
    const TOTAL_RACKS = OVEN_COUNT * RACKS_PER_OVEN;
    const OVEN_RUN_HOURS = p('ovenRunHours', 3);

    // Thresholds for recommendations
    const RUN_NOW_PCT = p('runNowPct', 75);
    const RUN_PARTIAL_PCT = p('runPartialPct', 50);
    const WAIT_WINDOW_MIN = p('waitWindowMin', 30);

    const today = new Date(); today.setHours(0,0,0,0);
    const todayMs = today.getTime();
    const now = Date.now();

    // ── 1. FULL PIPELINE — every active job by stage ──────────────
    const allJobs = dviTrace.getJobs();
    const pipeline = { INCOMING: [], AT_KARDEX: [], NEL: [], SURFACING: [], CUTTING: [], COATING: [], ASSEMBLY: [], QC: [], HOLD: [], BREAKAGE: [] };
    const rushJobs = [];
    for (const j of allJobs) {
      if (j.status === 'SHIPPED' || j.stage === 'SHIPPING' || j.stage === 'CANCELED') continue;
      const xml = dviJobIndex.get(j.job_id) || {};
      const enriched = {
        jobId: j.job_id, station: j.station, stage: j.stage,
        tray: j.tray, operator: j.operator,
        coating: xml.coating || 'AR',
        lensType: xml.lensType || null, // P=progressive, S=SV, B=bifocal
        lensStyle: xml.lensStyle, lensMat: xml.lensMat,
        eyeSize: xml.eyeSize || null,
        rush: j.rush || false,
        firstSeen: j.firstSeen, lastSeen: j.lastSeen,
        minutesInStage: j.lastSeen ? Math.round((now - j.lastSeen) / 60000) : 0,
        daysInLab: j.firstSeen ? Math.round((now - j.firstSeen) / 86400000 * 10) / 10 : 0,
      };
      if (pipeline[j.stage]) pipeline[j.stage].push(enriched);
      else if (!pipeline.OTHER) pipeline.OTHER = [enriched]; else pipeline.OTHER.push(enriched);
      if (enriched.rush) rushJobs.push(enriched);
    }

    // ── 2. STAGE DWELL TIMES — compute from job event histories ───
    // Sample completed jobs to get average time spent in each stage
    const stageDwells = {}; // stage → [durationMs, ...]
    const STAGES_ORDERED = ['INCOMING','AT_KARDEX','NEL','SURFACING','CUTTING','COATING','ASSEMBLY','QC'];
    for (const job of allJobs) {
      if (!job.eventCount || job.eventCount < 2) continue;
      // Get full event list for this job
      const fullJob = dviTrace.getJobHistory ? dviTrace.getJobHistory(job.job_id) : null;
      if (!fullJob || !fullJob.events || fullJob.events.length < 2) continue;
      const evts = fullJob.events;
      for (let i = 0; i < evts.length - 1; i++) {
        const stage = evts[i].stage;
        const dur = evts[i+1].timestamp - evts[i].timestamp;
        if (dur > 0 && dur < 86400000 && stage) { // skip >24h outliers
          if (!stageDwells[stage]) stageDwells[stage] = [];
          if (stageDwells[stage].length < 500) stageDwells[stage].push(dur); // cap samples
        }
      }
    }
    const avgStageMins = {};
    for (const [stage, durations] of Object.entries(stageDwells)) {
      if (durations.length < 3) continue; // need at least 3 samples
      // Use median for robustness
      durations.sort((a,b) => a - b);
      const median = durations[Math.floor(durations.length / 2)];
      avgStageMins[stage] = Math.round(median / 60000);
    }

    // ── 3. UPSTREAM FLOW — jobs heading toward coating with ETA ───
    // Pipeline: Surfacing → COATING → Cutting → Assembly
    // Only semi-finished lenses come to coating. SV goes direct surfacing → cutting.
    const surfacingCount = pipeline.SURFACING.length;
    const cuttingCount = pipeline.CUTTING.length;
    const coatingCount = pipeline.COATING.length;
    const surfacingAvgMin = avgStageMins.SURFACING || 45;
    // Upstream to coating = surfacing only (coating is right after surfacing)
    const upstreamFlow = {
      surfacing: { count: surfacingCount, lenses: surfacingCount * 2, etaMin: surfacingAvgMin },
      totalUpstream: surfacingCount,
      totalUpstreamLenses: surfacingCount * 2,
    };
    // Downstream from coating = cutting + assembly (for visibility)
    const downstreamFlow = {
      cutting: { count: cuttingCount, lenses: cuttingCount * 2 },
      assembly: { count: pipeline.ASSEMBLY.length, lenses: pipeline.ASSEMBLY.length * 2 },
      qc: { count: pipeline.QC.length, lenses: pipeline.QC.length * 2 },
    };

    // ── 4. COATING QUEUE — all jobs at coating stage ──────────────
    // Sub-categorize by DVI station name within the COATING stage
    // Typical stations: SENT TO COAT (queue), CCL 1/2/3 (in coater), CCP (prep), COAT QC, etc.
    const coatingQueue = pipeline.COATING.map(j => {
      const stn = (j.station || '').toUpperCase();
      let subStage = 'QUEUE'; // default: waiting for coating (SENT TO COAT, RECEIVED COAT)
      if (stn.includes('CCL') || stn.includes('CCP')) subStage = 'IN_COATER';
      else if (stn.includes('COAT QC') || stn.includes('COAT INSP') || stn.includes('COAT CHECK')) subStage = 'COAT_QC';
      else if (stn.includes('OVEN') || stn.includes('CURE') || stn.includes('BAKE')) subStage = 'IN_OVEN';
      return { ...j, waitMin: j.minutesInStage, subStage };
    });
    // Sort: rush first, then by longest wait
    coatingQueue.sort((a,b) => (b.rush ? 1 : 0) - (a.rush ? 1 : 0) || (b.waitMin - a.waitMin));
    const rushInQueue = coatingQueue.filter(j => j.rush).length;

    // Station breakdown for visibility
    const byStation = {};
    coatingQueue.forEach(j => {
      const stn = j.station || 'Unknown';
      byStation[stn] = (byStation[stn] || 0) + 1;
    });
    const bySubStage = {};
    coatingQueue.forEach(j => {
      bySubStage[j.subStage] = (bySubStage[j.subStage] || 0) + 1;
    });

    // Group by coating type (for when multiple AR types are live)
    const queueByType = {};
    coatingQueue.forEach(j => {
      const ct = j.coating || 'AR';
      if (!queueByType[ct]) queueByType[ct] = { type: ct, jobs: [], rushCount: 0 };
      queueByType[ct].jobs.push(j);
      if (j.rush) queueByType[ct].rushCount++;
    });

    // ── 5. OVEN LIVE STATE ────────────────────────────────────────
    // OvenTimer.html sends heartbeat as flat object keyed by "ovenId::rack" → {state, elapsed, target, jobs, ...}
    const ovenLive = liveTimers || {};
    const ovenStale = (now - liveUpdated) > 15000;
    const runningRacks = [];
    let hasLiveTimers = false;
    if (ovenLive && typeof ovenLive === 'object') {
      // Handle flat heartbeat format: { "oven1::rack1": {ovenId, ovenName, rack, state, ...}, ... }
      const entries = Object.entries(ovenLive);
      if (entries.length > 0 && entries[0][1] && typeof entries[0][1] === 'object' && entries[0][1].state) {
        // Flat heartbeat format from OvenTimer.html
        for (const [key, timer] of entries) {
          if (timer.state === 'running' || timer.state === 'paused') {
            hasLiveTimers = true;
            const elapsed = timer.elapsed || 0;
            const target = timer.target || OVEN_RUN_HOURS * 3600;
            const remaining = Math.max(0, target - elapsed);
            const rackNum = parseInt(String(timer.rack || '').replace('rack', '')) || 0;
            runningRacks.push({
              ovenId: timer.ovenName || timer.ovenId,
              rackIndex: rackNum,
              rackLabel: timer.rackLabel || `R${rackNum}`,
              coating: timer.coating || 'AR',
              state: timer.state, elapsed, target, remainingSec: remaining,
              remainingMin: Math.round(remaining / 60),
              batchId: timer.batchId,
              jobs: timer.jobs || [],
            });
          }
        }
      } else {
        // Array-of-ovens format (fallback)
        const ovens = Array.isArray(ovenLive) ? ovenLive :
                      ovenLive.ovens ? ovenLive.ovens :
                      Object.values(ovenLive).filter(v => typeof v === 'object');
        ovens.forEach((oven, oi) => {
          const ovenId = oven.ovenId || oven.id || `oven-${oi + 1}`;
          const racks = oven.racks || oven.timers || [];
          racks.forEach((rack, ri) => {
            if (rack.state === 'running' || rack.state === 'paused') {
              hasLiveTimers = true;
              const elapsed = rack.elapsed || 0;
              const target = rack.target || OVEN_RUN_HOURS * 3600;
              const remaining = Math.max(0, target - elapsed);
              runningRacks.push({
                ovenId, rackIndex: ri + 1, rackLabel: rack.label || `R${ri + 1}`,
                coating: rack.coating || 'AR',
                state: rack.state, elapsed, target, remainingSec: remaining,
                remainingMin: Math.round(remaining / 60),
                batchId: rack.batchId,
                jobs: rack.jobs || [],
              });
            }
          });
        });
      }
    }
    // No mock data — if no OvenTimer heartbeat, ovens show empty (real state)
    const racksInUse = runningRacks.length;
    const racksAvailable = TOTAL_RACKS - racksInUse;
    const nextFinishing = runningRacks.length > 0
      ? runningRacks.reduce((a,b) => a.remainingSec < b.remainingSec ? a : b)
      : null;

    // ── 6. TODAY'S COMPLETED RUNS ─────────────────────────────────
    const todayOvenRuns = runs.filter(r => (r.startedAt || r.receivedAt || 0) >= todayMs);
    const todayCoatingRuns = (global.coatingRuns || []).filter(r => {
      const t = r.completedAt ? new Date(r.completedAt).getTime() : 0;
      return t >= todayMs;
    });

    // ── 7. BATCHING RECOMMENDATION — single unified (all AR) ──────
    const totalCoaterCapacity = COATERS.reduce((s,c) => s + c.lensCapacity, 0);
    const totalCoaterOrders = COATERS.reduce((s,c) => s + c.orderCapacity, 0);
    const jobCount = coatingQueue.length;
    const lensCount = jobCount * 2;
    const hasRush = rushInQueue > 0;

    // Per-coater fill plan — largest first (E1400 then EB9s)
    const coaterPlan = [];
    let remaining = lensCount;
    const sortedCoaters = [...COATERS].sort((a,b) => b.lensCapacity - a.lensCapacity);
    for (const coater of sortedCoaters) {
      if (remaining <= 0) { coaterPlan.push({ ...coater, fill: 0, fillPct: 0, orders: 0 }); continue; }
      const fill = Math.min(remaining, coater.lensCapacity);
      const fillPct = Math.round((fill / coater.lensCapacity) * 100);
      coaterPlan.push({ ...coater, fill, fillPct, orders: Math.ceil(fill / 2) });
      remaining -= fill;
    }
    const overallFillPct = Math.round(Math.min(lensCount, totalCoaterCapacity) / totalCoaterCapacity * 100);
    const racksNeeded = Math.ceil(lensCount / RACK_CAPACITY);
    const runsNeeded = Math.ceil(lensCount / totalCoaterCapacity);

    // How long until more jobs arrive from upstream (surfacing → coating)?
    const nextBatchFromSurfacing = surfacingCount > 0 ? surfacingAvgMin : null;
    const rackFinishingSoon = runningRacks
      .filter(r => r.remainingMin <= WAIT_WINDOW_MIN)
      .sort((a,b) => a.remainingSec - b.remainingSec);

    const lastCoaterFill = coaterPlan.length > 0 ? coaterPlan[coaterPlan.length - 1].fillPct : 0;
    let action, reason;
    if (hasRush) {
      action = 'RUN NOW';
      reason = `${rushInQueue} rush job(s) — run immediately`;
    } else if (lensCount >= totalCoaterCapacity) {
      action = 'RUN NOW';
      reason = `${lensCount} lenses fills all coaters (${totalCoaterCapacity} capacity)`;
    } else if (lastCoaterFill >= RUN_NOW_PCT) {
      action = 'RUN NOW';
      reason = `${overallFillPct}% total fill — above ${RUN_NOW_PCT}% threshold`;
    } else if (lastCoaterFill >= RUN_PARTIAL_PCT) {
      if (nextBatchFromSurfacing && nextBatchFromSurfacing <= WAIT_WINDOW_MIN) {
        action = 'WAIT';
        reason = `${surfacingCount} jobs in surfacing arriving in ~${nextBatchFromSurfacing}min — wait to fill coaters`;
      } else {
        action = 'RUN PARTIAL';
        reason = `${overallFillPct}% fill — above ${RUN_PARTIAL_PCT}% partial threshold, no upstream arriving soon`;
      }
    } else {
      if (nextBatchFromSurfacing && surfacingCount >= 20) {
        action = 'WAIT';
        reason = `Only ${overallFillPct}% fill. ${surfacingCount} jobs in surfacing arriving in ~${nextBatchFromSurfacing}min`;
      } else {
        action = 'WAIT';
        reason = `Only ${overallFillPct}% fill. Accumulate more jobs (${upstreamFlow.totalUpstream} in surfacing)`;
      }
    }

    // ── 7b. PER-TYPE BATCH SUGGESTIONS — group by coating type + material (HARD constraint) ──
    // Material is a hard batching constraint: PLY with PLY, H67 with H67, B67 with B67, etc.
    // Each batch group = one coating type + one material
    const batchSuggestions = [];
    // Only use QUEUE jobs for batch suggestions (not jobs already in a coater)
    const queueOnly = coatingQueue.filter(j => j.subStage === 'QUEUE');
    const groupKey = (j) => `${j.coating || 'AR'}::${j.lensMat || '?'}`;
    const batchGroups = {};
    queueOnly.forEach(j => {
      const k = groupKey(j);
      if (!batchGroups[k]) batchGroups[k] = { coating: j.coating || 'AR', material: j.lensMat || '?', jobs: [], rushCount: 0 };
      batchGroups[k].jobs.push(j);
      if (j.rush) batchGroups[k].rushCount++;
    });

    for (const [key, group] of Object.entries(batchGroups)) {
      const count = group.jobs.length;
      const lenses = count * 2;
      const rushCount = group.rushCount;
      const avgWait = count > 0 ? Math.round(group.jobs.reduce((s,j) => s + (j.waitMin || 0), 0) / count) : 0;
      const maxWait = count > 0 ? Math.max(...group.jobs.map(j => j.waitMin || 0)) : 0;

      // Lens type breakdown within this material group
      const lensTypeBreakdown = {};
      group.jobs.forEach(j => { const t = j.lensType || '?'; lensTypeBreakdown[t] = (lensTypeBreakdown[t] || 0) + 1; });

      // Which coater fits best?
      let suggestedCoater = 'E1400';
      if (count <= 57) suggestedCoater = rushCount > 0 ? 'EB9 #1' : 'EB9 #2';
      else if (count <= 114) suggestedCoater = count > 57 ? 'E1400' : 'EB9 #1';

      const coaterDef = COATERS.find(c => c.name === suggestedCoater) || COATERS[2];
      const fillPct = Math.round(lenses / coaterDef.lensCapacity * 100);

      // Estimate time until threshold hit
      const incomingRate = surfacingCount > 0 && surfacingAvgMin > 0
        ? Math.round(surfacingCount / (surfacingAvgMin / 60))
        : 0;
      const ordersToFill = coaterDef.orderCapacity - count;
      const etaToFullMin = incomingRate > 0 && ordersToFill > 0
        ? Math.round(ordersToFill / incomingRate * 60)
        : null;

      // Job IDs for this batch group (sorted: rush first, then longest wait)
      const sortedJobs = [...group.jobs].sort((a,b) => (b.rush?1:0)-(a.rush?1:0) || (b.waitMin-a.waitMin));

      batchSuggestions.push({
        coatingType: group.coating,
        material: group.material,
        jobCount: count, lensCount: lenses, rushCount, avgWaitMin: avgWait, maxWaitMin: maxWait,
        lensTypeBreakdown,
        suggestedCoater, fillPct,
        etaToFullMin,
        ready: fillPct >= RUN_NOW_PCT || rushCount > 0,
        jobs: sortedJobs.map(j => ({
          jobId: j.jobId, lensType: j.lensType, eyeSize: j.eyeSize,
          rush: j.rush, waitMin: j.waitMin, station: j.station,
        })),
      });
    }
    // Sort: ready first, then by job count desc
    batchSuggestions.sort((a,b) => (b.ready?1:0)-(a.ready?1:0) || b.jobCount-a.jobCount);

    const recommendation = {
      action, reason, jobCount, lensCount, rushCount: rushInQueue,
      coaterPlan: coaterPlan.sort((a,b) => b.lensCapacity - a.lensCapacity),
      overallFillPct, racksNeeded, runsNeeded,
      upstreamEta: nextBatchFromSurfacing,
      batchSuggestions, // Per-type batch analysis
    };

    // ── 8. PIPELINE SUMMARY — counts per stage ───────────────────
    const pipelineSummary = {};
    for (const [stage, jobs] of Object.entries(pipeline)) {
      pipelineSummary[stage] = { count: jobs.length, lenses: jobs.length * 2 };
    }
    const totalWip = Object.values(pipeline).reduce((s, jobs) => s + jobs.length, 0);

    return json(res, {
      ok: true,
      timestamp: now,
      capacity: { rackSize: RACK_CAPACITY, ovenCount: OVEN_COUNT, racksPerOven: RACKS_PER_OVEN, totalRacks: TOTAL_RACKS, ovenRunHours: OVEN_RUN_HOURS },
      coaters: COATERS.map(c => ({ id: c.id, name: c.name, somId: c.somId, lensCapacity: c.lensCapacity, orderCapacity: c.orderCapacity, runHours: c.runHours })),
      totalCoaterCapacity,
      totalCoaterOrders,
      thresholds: { runNowPct: RUN_NOW_PCT, runPartialPct: RUN_PARTIAL_PCT, waitWindowMin: WAIT_WINDOW_MIN },
      // Full pipeline visibility
      pipeline: pipelineSummary,
      totalWip,
      // Upstream flow toward coating (surfacing → coating)
      upstream: upstreamFlow,
      // Downstream from coating (coating → cutting → assembly)
      downstream: downstreamFlow,
      avgStageMins,
      // Coating queue — all jobs in coating stage (broken down by sub-stage and station)
      queue: { total: coatingQueue.length, rushCount: rushInQueue, byStation, bySubStage, jobs: coatingQueue,
        byType: Object.values(queueByType).map(g => ({ type: g.type, count: g.jobs.length, rushCount: g.rushCount })),
      },
      // Oven status — full grid layout: 6 ovens × 7 racks with job tracking
      ovens: {
        stale: ovenStale, racksRunning: runningRacks, racksInUse, racksAvailable, nextFinishing,
        todayRuns: todayOvenRuns.length,
        // Jobs finishing within 30 min — these feed the coaters next
        ovenIncoming: runningRacks
          .filter(r => r.remainingMin <= 30)
          .map(r => {
            const key = `${r.ovenId}::R${r.rackIndex}`;
            const tracked = ovenRackJobs[key];
            return {
              ovenId: r.ovenId, rackIndex: r.rackIndex,
              remainingMin: r.remainingMin, coating: r.coating,
              jobs: tracked ? tracked.jobs : (r.jobs || []),
              jobCount: tracked ? tracked.jobs.length : (r.jobs?.length || 0),
            };
          })
          .sort((a, b) => a.remainingMin - b.remainingMin),
        layout: Array.from({length: OVEN_COUNT}, (_, oi) => {
          const ovenId = `Oven ${oi+1}`;
          const ovenRacks = Array.from({length: RACKS_PER_OVEN}, (_, ri) => {
            const running = runningRacks.find(r => r.ovenId === ovenId && r.rackIndex === ri+1);
            const key = `${ovenId}::R${ri+1}`;
            const tracked = ovenRackJobs[key];
            const base = running || { ovenId, rackIndex: ri+1, rackLabel: `R${ri+1}`, state: 'empty', jobs: [] };
            // Merge tracked job numbers onto the rack
            if (tracked) {
              base.jobs = tracked.jobs;
              base.coating = tracked.coating || base.coating;
              base.loadedAt = tracked.loadedAt;
            }
            return base;
          });
          return { ovenId, racks: ovenRacks };
        }),
      },
      // Single unified recommendation (all jobs are AR)
      recommendation,
      // Rush jobs across all stages
      rushJobs: rushJobs.slice(0, 50),
      // Stats
      stats: { totalOvenRuns: runs.length, todayOvenRuns: todayOvenRuns.length, todayCoatingRuns: todayCoatingRuns.length },
    });
  }

  // ── AI Batch Recommendation — Claude agent analyzes WIP and recommends batching ──
  if (req.method==='POST' && url.pathname==='/api/coating/ai-batch') {
    try {
      const body = await readBody(req);
      const gatewayUrl = body.gatewayUrl || process.env.GATEWAY_URL || 'http://localhost:3001';

      // Gather full coating context by calling our own intelligence endpoint internally
      const allJobs = dviTrace.getJobs();
      const now = Date.now();
      const COATERS = [
        { id: 'EB9001', name: 'EB9 #1', lensCapacity: 114, orderCapacity: 57, runHours: 2, notes: 'Smaller chamber. Good for small/rush batches.' },
        { id: 'EB9002', name: 'EB9 #2', lensCapacity: 114, orderCapacity: 57, runHours: 2, notes: 'Smaller chamber. Good for small/rush batches.' },
        { id: 'E14001', name: 'E1400', lensCapacity: 274, orderCapacity: 137, runHours: 2, notes: 'Large chamber. Best for bulk AR runs.' },
      ];

      // Build enriched job list for coating queue + upstream
      const coatingQueue = [];
      const surfacingJobs = [];
      const ovenJobs = [];
      for (const j of allJobs) {
        if (j.status === 'SHIPPED' || j.stage === 'SHIPPING' || j.stage === 'CANCELED') continue;
        const xml = dviJobIndex.get(j.job_id) || {};
        const enriched = {
          jobId: j.job_id, station: j.station, stage: j.stage,
          coating: xml.coating || 'AR',
          lensType: xml.lensType || '?', // P=progressive, S=SV, B=bifocal
          lensStyle: xml.lensStyle || '?',
          lensMat: xml.lensMat || '?',
          eyeSize: xml.eyeSize || '?',
          rush: j.rush || false,
          minutesInStage: j.lastSeen ? Math.round((now - j.lastSeen) / 60000) : 0,
          daysInLab: j.firstSeen ? Math.round((now - j.firstSeen) / 86400000 * 10) / 10 : 0,
        };
        if (j.stage === 'COATING') coatingQueue.push(enriched);
        else if (j.stage === 'SURFACING') surfacingJobs.push(enriched);
      }
      coatingQueue.sort((a,b) => (b.rush?1:0)-(a.rush?1:0) || b.minutesInStage-a.minutesInStage);

      // Oven racks finishing soon
      const runningRacksData = [];
      const ovenLiveData = liveTimers || {};
      // Check mock oven data from ovenRackJobs
      for (const [key, rack] of Object.entries(ovenRackJobs)) {
        runningRacksData.push({ location: key, jobs: rack.jobs, coating: rack.coating });
      }

      // Build the AI prompt context
      const contextSummary = `
## Current Coating Department Status (${new Date().toLocaleString()})

### Coating Queue: ${coatingQueue.length} jobs (${coatingQueue.length * 2} lenses)
${coatingQueue.length > 0 ? `Breakdown by coating type:
${Object.entries(coatingQueue.reduce((g,j) => { g[j.coating]=(g[j.coating]||0)+1; return g; }, {})).map(([t,c]) => `  - ${t}: ${c} jobs`).join('\n')}

Breakdown by lens type:
${Object.entries(coatingQueue.reduce((g,j) => { const k = j.lensType==='P'?'Progressive':j.lensType==='S'?'Single Vision':j.lensType==='B'?'Bifocal':'Unknown'; g[k]=(g[k]||0)+1; return g; }, {})).map(([t,c]) => `  - ${t}: ${c} jobs`).join('\n')}

Breakdown by lens material:
${Object.entries(coatingQueue.reduce((g,j) => { g[j.lensMat]=(g[j.lensMat]||0)+1; return g; }, {})).map(([t,c]) => `  - ${t}: ${c} jobs`).join('\n')}

Rush jobs: ${coatingQueue.filter(j=>j.rush).length}
Longest wait: ${coatingQueue[0]?.minutesInStage || 0} minutes
` : 'No jobs in queue.'}

### Incoming from Surfacing: ${surfacingJobs.length} jobs (${surfacingJobs.length * 2} lenses)
${surfacingJobs.length > 0 ? `These will arrive at coating within ~45 minutes.
Coating types: ${Object.entries(surfacingJobs.reduce((g,j) => { g[j.coating]=(g[j.coating]||0)+1; return g; }, {})).map(([t,c]) => `${t}:${c}`).join(', ')}
` : ''}

### Oven Rack Loads (jobs currently curing):
${runningRacksData.length > 0 ? runningRacksData.map(r => `  - ${r.location}: ${r.jobs.length} jobs [${r.jobs.join(', ')}]`).join('\n') : 'No tracked oven loads.'}

### Available Coaters:
${COATERS.map(c => `  - ${c.name} (${c.id}): ${c.lensCapacity} lens capacity (${c.orderCapacity} orders), ${c.runHours}h run. ${c.notes}`).join('\n')}

### Full Job List in Coating Queue:
${coatingQueue.slice(0, 300).map(j => `${j.jobId} | ${j.coating} | ${j.lensType==='P'?'Prog':j.lensType==='S'?'SV':j.lensType==='B'?'BF':'?'} | ${j.lensMat} | eye:${j.eyeSize} | ${j.rush?'RUSH':'std'} | wait:${j.minutesInStage}m | ${j.daysInLab}d in lab`).join('\n')}
`;

      // Call gateway AI
      const aiQuestion = `Analyze the current coating queue and recommend optimal batching.

${contextSummary}

## Instructions:
1. Group jobs by coating type first (AR, Blue Cut, etc.)
2. Within each coating type, consider lens material and size for optimal grouping
3. Assign to specific coaters (E1400 for largest batches, EB9s for smaller/rush)
4. Prioritize rush jobs — they should go in the earliest batch
5. Consider what's incoming from surfacing when deciding whether to wait or run now
6. Consider oven rack loads — these will need oven space after coating
7. Give specific job IDs for each coater assignment
8. Note any timing recommendations (run now vs wait for more jobs)
9. Flag any efficiency concerns or unusual patterns

Respond with a structured batching plan in this format:
- For each coater: which specific jobs to load, why this grouping makes sense
- Whether to run now or wait, and why
- Any notes about timing, upcoming capacity constraints, or efficiency tips`;

      const aiRes = await fetch(`${gatewayUrl}/web/ask-sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: aiQuestion,
          agent: 'coating',
          userId: 'coating-intel',
          context: { source: 'coating-intelligence-panel' },
        }),
      }).then(r => r.json()).catch(e => ({ error: e.message }));

      return json(res, {
        ok: true,
        recommendation: aiRes.response || aiRes.error || 'AI unavailable',
        context: {
          queueSize: coatingQueue.length,
          surfacingIncoming: surfacingJobs.length,
          ovenLoads: runningRacksData.length,
          coaters: COATERS.map(c => c.name),
        },
      });
    } catch(e) { return json(res, {ok:false, error:e.message}, 500); }
  }

  // ── ItemPath/Kardex inventory endpoints ─────────────────────
  if (req.method==='GET' && url.pathname==='/api/inventory') {
    return json(res, itempath.getInventory());
  }
  if (req.method==='GET' && url.pathname==='/api/inventory/picks') {
    return json(res, itempath.getPicks());
  }
  if (req.method==='POST' && url.pathname==='/api/inventory/picks/set') {
    const body = await readBody(req);
    itempath.setDailyPicks(body.WH1 || 0, body.WH2 || 0);
    return json(res, { ok: true, ...itempath.getDailyPicks() });
  }
  if (req.method==='GET' && url.pathname==='/api/inventory/picks/daily') {
    return json(res, itempath.getDailyPicks());
  }
  if (req.method==='GET' && url.pathname==='/api/inventory/alerts') {
    return json(res, itempath.getAlerts());
  }
  if (req.method==='GET' && url.pathname==='/api/inventory/warehouses') {
    return json(res, itempath.getWarehouses());
  }
  if (req.method==='GET' && url.pathname==='/api/inventory/vlms') {
    return json(res, itempath.getVLMs());
  }
  if (req.method==='GET' && url.pathname==='/api/inventory/putwall') {
    return json(res, itempath.getPutWall());
  }
  if (req.method==='GET' && url.pathname==='/api/inventory/ai-context') {
    return json(res, itempath.getAIContext());
  }

  // ── Limble CMMS maintenance endpoints ──────────────────────────
  if (req.method==='GET' && url.pathname==='/api/maintenance/assets') {
    return json(res, limble.getAssets());
  }
  if (req.method==='GET' && url.pathname==='/api/maintenance/tasks') {
    return json(res, limble.getTasks());
  }
  if (req.method==='GET' && url.pathname==='/api/maintenance/downtime') {
    return json(res, limble.getDowntime());
  }
  if (req.method==='GET' && url.pathname==='/api/maintenance/parts') {
    return json(res, limble.getParts());
  }
  if (req.method==='GET' && url.pathname==='/api/maintenance/stats') {
    return json(res, limble.getStats());
  }
  if (req.method==='GET' && url.pathname==='/api/maintenance/ai-context') {
    return json(res, limble.getAIContext());
  }

  // ── SOM (Schneider) Control Center endpoints ─────────────────
  if (req.method==='GET' && url.pathname==='/api/som/devices') {
    return json(res, som.getDevices());
  }
  if (req.method==='GET' && url.pathname==='/api/som/conveyors') {
    return json(res, som.getConveyors());
  }
  if (req.method==='GET' && url.pathname==='/api/som/alerts') {
    return json(res, som.getAlerts());
  }
  // ── Cross-referenced jobs: SOM department + DVI job details ──
  if (req.method==='GET' && url.pathname==='/api/jobs/active') {
    const somData = som.getActiveJobs();
    const enriched = somData.jobs.map(job => {
      const dvi = dviJobIndex.get(job.dviJob) || null;
      return {
        ...job,
        dvi: dvi ? {
          coating: dvi.coating,
          lensStyle: dvi.lensStyle,
          lensMat: dvi.lensMat,
          frameStyle: dvi.frameStyle,
          frameSku: dvi.frameSku,
          rxNum: dvi.rxNum,
          serviceInstruction: dvi.serviceInstruction,
        } : null
      };
    });
    // Group by department zone
    const byZone = {};
    enriched.forEach(j => {
      const z = j.zone || 'unknown';
      if (!byZone[z]) byZone[z] = { zone: z, deptName: j.deptName, jobs: [] };
      byZone[z].jobs.push(j);
    });
    return json(res, {
      total: enriched.length,
      dviIndexSize: dviJobIndex.size,
      matchRate: enriched.filter(j => j.dvi).length,
      byZone,
      isLive: somData.isLive,
      lastPoll: somData.lastPoll
    });
  }
  if (req.method==='GET' && url.pathname==='/api/som/health') {
    return json(res, som.getHealth());
  }
  if (req.method==='GET' && url.pathname==='/api/som/ai-context') {
    return json(res, som.getAIContext());
  }
  if (req.method==='POST' && url.pathname==='/api/som/refresh') {
    try {
      const result = await som.refresh();
      return json(res, result);
    } catch (e) {
      return json(res, { ok: false, error: e.message }, 500);
    }
  }
  if (req.method==='GET' && url.pathname==='/api/som/orders') {
    return json(res, som.getOrders());
  }
  if (req.method==='GET' && url.pathname==='/api/som/oee') {
    return json(res, som.getOEE());
  }

  // ── DVI File Sync endpoints ───────────────────────────────────
  if (req.method==='GET' && url.pathname==='/api/dvi-sync/status') {
    return json(res, dviSync.getStatus());
  }
  if (req.method==='POST' && url.pathname==='/api/dvi-sync/poll') {
    try {
      const body = await readBody(req);
      const syncId = body.syncId || 'jobs';
      const result = await dviSync.forcePoll(syncId);
      return json(res, result);
    } catch (e) {
      return json(res, { ok: false, error: e.message }, 500);
    }
  }
  if (req.method==='POST' && url.pathname==='/api/dvi-sync/start') {
    try {
      const started = await dviSync.start();
      return json(res, { ok: started, message: started ? 'Sync service started' : 'Failed to start or already running' });
    } catch (e) {
      return json(res, { ok: false, error: e.message }, 500);
    }
  }
  if (req.method==='POST' && url.pathname==='/api/dvi-sync/stop') {
    try {
      await dviSync.stop();
      return json(res, { ok: true, message: 'Sync service stopped' });
    } catch (e) {
      return json(res, { ok: false, error: e.message }, 500);
    }
  }

  // ── DVI Trace (live tray movement) endpoints ─────────────────
  if (req.method==='GET' && url.pathname==='/api/dvi/jobs') {
    // Primary job data endpoint — feeds KPIs and department views
    const jobs = dviTrace.getJobsForKPI();
    const traceJobIds = new Set(jobs.map(j => j.job_id));

    // Enrich trace jobs with DVI XML data (coating, lens, frame)
    const enriched = jobs.map(j => {
      const xml = dviJobIndex.get(j.job_id);
      if (xml) {
        j.coating = xml.coating;
        j.coatType = xml.coatType;
        j.lensType = xml.lensType; // P=progressive, S=SV, B=bifocal
        j.lensStyle = xml.lensStyle;
        j.lensMat = xml.lensMat;
        j.lensThick = xml.lensThick;
        j.lensColor = xml.lensColor;
        j.frameStyle = xml.frameStyle;
        j.frameSku = xml.frameSku;
        j.frameMfr = xml.frameMfr;
        j.eyeSize = xml.eyeSize;
        j.bridge = xml.bridge;
        j.edge = xml.edge;
        j.rxNum = xml.rxNum;
        j.patient = xml.patient;
        j.rx = xml.rx; // { R: {sphere,cylinder,axis,pd,add}, L: {...} }
      }
      return j;
    });

    // Add unreleased queue jobs — jobs in XML index with no trace events
    // and NOT in the shipped archive. DVI exports all jobs with Status="NEW"
    // regardless of actual state, so we must cross-reference shipped index
    // to avoid counting completed jobs as WIP.
    let queueJobCount = 0;
    let skippedShipped = 0;
    for (const [jobNum, xml] of dviJobIndex) {
      if (traceJobIds.has(jobNum)) continue;      // already tracked by trace
      if (shippedJobIndex.has(jobNum)) { skippedShipped++; continue; } // already shipped
      queueJobCount++;
      enriched.push({
        job_id: jobNum,
        invoice: jobNum,
        stage: 'INCOMING',
        status: 'Queued',
        station: xml.status || 'NEW',
        coating: xml.coating,
        lensStyle: xml.lensStyle,
        lensMat: xml.lensMat,
        frameStyle: xml.frameStyle,
        frameSku: xml.frameSku,
        rxNum: xml.rxNum,
        rush: 'N',
        Rush: 'N',
        priority: 'NORMAL',
        firstSeen: null,
        lastSeen: null,
        source: 'dvi-xml'
      });
    }
    if (queueJobCount > 0 || skippedShipped > 0) console.log(`[DVI-Jobs] Queue: ${queueJobCount} unreleased jobs added, ${skippedShipped} skipped (already shipped)`);

    // Get shipped stats from BOTH trace (today's movements) AND shipped XML index (archived files)
    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    const yesterdayStart = new Date(todayStart); yesterdayStart.setDate(yesterdayStart.getDate() - 1);
    const weekStart = new Date(todayStart); weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
    const todayMs = todayStart.getTime();
    const yesterdayMs = yesterdayStart.getTime();
    const weekMs = weekStart.getTime();

    // Source 1: Trace jobs with SHIPPED status (from today's trace file)
    const allTracedJobs = dviTrace.getJobs ? dviTrace.getJobs() : [];
    const traceShipped = allTracedJobs.filter(j => j.status === 'SHIPPED' || j.stage === 'SHIPPED');
    const traceShippedIds = new Set(traceShipped.map(j => j.job_id));

    // Source 2: Shipped XML archive (persistent — all shipped jobs with parsed dates)
    const xmlShipped = [];
    for (const [jobNum, xml] of shippedJobIndex) {
      if (traceShippedIds.has(jobNum)) continue; // already counted from trace
      if (!xml.shippedAt) continue;
      xmlShipped.push({
        job_id: jobNum, invoice: xml.invoice || jobNum, tray: xml.tray || jobNum,
        station: 'SH CONVEY', stage: 'SHIPPING', status: 'SHIPPED',
        coating: xml.coating, lensStyle: xml.lensStyle, lensMat: xml.lensMat,
        frameStyle: xml.frameStyle, frameSku: xml.frameSku, rxNum: xml.rxNum,
        rush: 'N', Rush: 'N',
        firstSeen: xml.enteredAt || null, lastSeen: xml.shippedAt,
        daysInLab: xml.daysInLab ? parseFloat(xml.daysInLab) : 0,
        source: 'dvi-shipped-xml'
      });
    }

    // Merge both sources
    const allShipped = [...traceShipped, ...xmlShipped];
    const shippedToday = allShipped.filter(j => j.lastSeen && j.lastSeen >= todayMs);
    const shippedYesterday = allShipped.filter(j => j.lastSeen && j.lastSeen >= yesterdayMs && j.lastSeen < todayMs);
    const shippedThisWeek = allShipped.filter(j => j.lastSeen && j.lastSeen >= weekMs);

    return json(res, {
      jobs: enriched,
      shipped: {
        today: shippedToday.length,
        yesterday: shippedYesterday.length,
        thisWeek: shippedThisWeek.length,
        todayJobs: shippedToday,
        yesterdayJobs: shippedYesterday,
        total: allShipped.length
      },
      stats: dviTrace.getStats(),
      source: 'dvi-trace+xml+shipped',
      jobCount: enriched.length,
      traceJobs: traceJobIds.size,
      queueJobs: queueJobCount,
      dviIndexSize: dviJobIndex.size,
      shippedIndexSize: shippedJobIndex.size
    });
  }
  // ── Assembly-specific endpoint for AssemblyDashboard ──────────
  if (req.method==='GET' && url.pathname==='/api/assembly/jobs') {
    const allJobs = dviTrace.getJobs();
    const now = Date.now();
    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    const todayMs = todayStart.getTime();

    // Assembly jobs: currently at ASSEMBLY stage
    const assemblyJobs = allJobs.filter(j => j.stage === 'ASSEMBLY');

    // Scan all jobs for assembly completions today.
    // For each ASSEMBLY PASS/FAIL event, find the preceding ASSEMBLY #N
    // event to determine which station completed the job.
    const completedToday = [];
    const passFailToday = { pass: 0, fail: 0 };
    const stationCompletions = {}; // 'ASSEMBLY #7' → count

    for (const j of allJobs) {
      const history = dviTrace.getJobHistory(j.job_id);
      if (!history || !history.events) continue;
      const events = history.events;
      for (let i = 0; i < events.length; i++) {
        const e = events[i];
        if (e.timestamp < todayMs) continue;
        if (e.station !== 'ASSEMBLY PASS' && e.station !== 'ASSEMBLY FAIL') continue;

        if (e.station === 'ASSEMBLY PASS') passFailToday.pass++;
        if (e.station === 'ASSEMBLY FAIL') passFailToday.fail++;

        // Look backward for the ASSEMBLY #N station this job came from
        let fromStation = null;
        let fromOperator = e.operator || null;
        for (let k = i - 1; k >= 0; k--) {
          if (/^ASSEMBLY #\d+/.test(events[k].station)) {
            fromStation = events[k].station;
            if (!fromOperator && events[k].operator) fromOperator = events[k].operator;
            break;
          }
          // Only grab operator from ASSEMBLY-stage events (not shipping/QC)
          if (!fromOperator && events[k].operator && /ASSEMBL|RECOMBOB/i.test(events[k].station)) {
            fromOperator = events[k].operator;
          }
        }
        // Do NOT fall back to j.operator — that could be a shipping/QC operator

        if (fromStation) {
          stationCompletions[fromStation] = (stationCompletions[fromStation] || 0) + 1;
        }

        completedToday.push({
          id: j.job_id,
          result: e.station,
          operator: fromOperator,
          fromStation,
          timestamp: e.timestamp
        });
      }
    }

    // Build per-station breakdown for active jobs
    const byStation = {};
    for (const j of assemblyJobs) {
      const stn = j.station || 'UNKNOWN';
      if (!byStation[stn]) byStation[stn] = { station: stn, jobs: [], operators: new Set(), completedToday: 0 };
      byStation[stn].jobs.push(j.job_id);
      if (j.operator) byStation[stn].operators.add(j.operator);
    }
    // Add completion counts and ensure all stations with completions appear
    for (const [stn, count] of Object.entries(stationCompletions)) {
      if (!byStation[stn]) byStation[stn] = { station: stn, jobs: [], operators: new Set(), completedToday: 0 };
      byStation[stn].completedToday = count;
    }
    for (const s of Object.values(byStation)) {
      s.operators = [...s.operators];
      s.jobCount = s.jobs.length;
    }

    // Build per-operator stats — from completions with known operators
    const operatorStats = {};
    // Also track which operator did the most jobs at each station
    const stationOperatorTally = {}; // 'ASSEMBLY #7' → { 'AF': 5, 'EY': 3 }
    for (const c of completedToday) {
      if (!c.operator) continue;
      if (!operatorStats[c.operator]) operatorStats[c.operator] = { initials: c.operator, jobs: 0, rush: 0, firstJob: null, lastJob: null };
      operatorStats[c.operator].jobs++;
      if (!operatorStats[c.operator].firstJob || c.timestamp < operatorStats[c.operator].firstJob)
        operatorStats[c.operator].firstJob = c.timestamp;
      if (!operatorStats[c.operator].lastJob || c.timestamp > operatorStats[c.operator].lastJob)
        operatorStats[c.operator].lastJob = c.timestamp;
      if (c.fromStation) {
        if (!stationOperatorTally[c.fromStation]) stationOperatorTally[c.fromStation] = {};
        stationOperatorTally[c.fromStation][c.operator] = (stationOperatorTally[c.fromStation][c.operator] || 0) + 1;
      }
    }
    // Determine primary operator per station (whoever completed the most jobs there today)
    const stationOperators = {}; // 'ASSEMBLY #7' → 'AF'
    for (const [stn, tally] of Object.entries(stationOperatorTally)) {
      const sorted = Object.entries(tally).sort((a,b) => b[1] - a[1]);
      if (sorted.length > 0) stationOperators[stn] = sorted[0][0]; // top operator
    }
    // Calculate jobs/hour using shift hours (not first-to-last job span)
    const shiftStart = new Date(); shiftStart.setHours(7, 0, 0, 0); // 7 AM shift start
    const shiftHours = Math.max(0.5, (Date.now() - shiftStart.getTime()) / 3600000);
    for (const op of Object.values(operatorStats)) {
      op.jobsPerHour = op.jobs / shiftHours;
    }

    // Enrich assembly jobs with XML data
    const enrichedAssembly = assemblyJobs.map(j => {
      const xml = dviJobIndex.get(j.job_id);
      return {
        id: j.job_id,
        tray: j.tray,
        station: j.station,
        stationNum: j.stationNum,
        operator: j.operator,
        status: 'active',
        coating: xml?.coating || '',
        lensStyle: xml?.lensStyle || '',
        lensMat: xml?.lensMat || '',
        frameStyle: xml?.frameStyle || '',
        rxNum: xml?.rxNum || '',
        isRush: false,
        firstSeen: j.firstSeen,
        lastSeen: j.lastSeen,
        minutesAtStation: j.lastSeen ? Math.round((now - j.lastSeen) / 60000) : null,
        daysInLab: j.daysInLab || 0,
      };
    });

    return json(res, {
      jobs: enrichedAssembly,
      assemblyWip: assemblyJobs.length,
      completedToday: passFailToday.pass + passFailToday.fail,
      passFailToday,
      byStation,
      stationCompletions,
      operatorStats,
      stationOperators,
      shippedToday: allJobs.filter(j => j.stage === 'SHIPPING' && j.lastSeen >= todayMs).length,
      incomingToday: allJobs.filter(j => j.stage === 'INCOMING' && j.lastSeen >= todayMs).length,
      totalWip: allJobs.filter(j => j.stage !== 'SHIPPING' && j.stage !== 'CANCELED').length,
      source: 'dvi-trace',
      timestamp: new Date().toISOString()
    });
  }

  // ── Assembly config (operator assignments + name map) ──────────
  // Synced from standalone AssemblyDashboard.html so main app can read them
  // ── Shipped history — daily shipped counts from trace + shipped XML ─────
  if (req.method==='GET' && url.pathname==='/api/shipping/history') {
    const days = parseInt(url.searchParams.get('days') || '30');
    const byDay = {};
    const now = Date.now();
    // Initialize days
    for (let d = 0; d < days; d++) {
      const date = new Date(now - d * 86400000);
      const key = date.toISOString().slice(0, 10);
      byDay[key] = { date: key, shipped: 0, rush: 0 };
    }
    // Source 1: Trace jobs
    const traceJobs = dviTrace.getJobs();
    const countedIds = new Set();
    for (const j of traceJobs) {
      if (j.status !== 'SHIPPED' || !j.lastSeen) continue;
      const key = new Date(j.lastSeen).toISOString().slice(0, 10);
      if (byDay[key]) {
        byDay[key].shipped++;
        if (j.rush === 'Y' || j.Rush === 'Y') byDay[key].rush++;
        countedIds.add(j.job_id);
      }
    }
    // Source 2: Shipped XML archive
    for (const [jobNum, xml] of shippedJobIndex) {
      if (countedIds.has(jobNum) || !xml.shippedAt) continue;
      const key = new Date(xml.shippedAt).toISOString().slice(0, 10);
      if (byDay[key]) {
        byDay[key].shipped++;
      }
    }
    const history = Object.values(byDay).sort((a, b) => b.date.localeCompare(a.date));
    return json(res, { history, days, shippedIndexSize: shippedJobIndex.size });
  }

  if (req.method==='GET' && url.pathname==='/api/assembly/config') {
    return json(res, {
      assignments: assemblyConfig.assignments,
      operatorMap: assemblyConfig.operatorMap,
      updatedAt: assemblyConfig.updatedAt
    });
  }
  if (req.method==='POST' && url.pathname==='/api/assembly/config') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (data.assignments) {
          assemblyConfig.assignments = data.assignments;
          labDb.setAssemblyConfig('assignments', data.assignments);
        }
        if (data.operatorMap) {
          assemblyConfig.operatorMap = data.operatorMap;
          labDb.setAssemblyConfig('operatorMap', data.operatorMap);
        }
        assemblyConfig.updatedAt = Date.now();
        labDb.setAssemblyConfig('updatedAt', assemblyConfig.updatedAt);
        console.log(`[Assembly] Config saved: ${Object.keys(data.assignments||{}).length} assignments, ${Object.keys(data.operatorMap||{}).length} operator mappings`);
        return json(res, { ok: true });
      } catch(e) { return json(res, { error: e.message }, 400); }
    });
    return;
  }

  // ── System Health — unified status for all connections ──────
  if (req.method==='GET' && url.pathname==='/api/health') {
    const trace = dviTrace.getStatus();
    const somStatus = som.getHealth ? som.getHealth() : null;
    const ipStatus = itempath.getHealth ? itempath.getHealth() : null;

    const systems = {
      dvi_trace: {
        status: trace.connected && !trace.stale ? 'ok' : trace.connected && trace.stale ? 'stale' : 'down',
        message: !trace.running ? 'Not started' :
                 !trace.connected ? `Connection errors (${trace.consecutiveErrors})` :
                 trace.stale ? `No events for ${Math.round(trace.lastEventAgeSec/60)}m` :
                 `Live — ${trace.lastEventAgeSec}s ago`,
        lastEvent: trace.lastEvent,
        jobs: trace.jobCount,
        file: trace.currentFile,
      },
      itempath: {
        status: ipStatus?.connected ? 'ok' : ipStatus?.lastError ? 'error' : 'unknown',
        message: ipStatus?.connected ? `Synced ${ipStatus.materials || 0} materials` : ipStatus?.lastError || 'Not polled yet',
        lastSync: ipStatus?.lastSync || null,
      },
      som: {
        status: somStatus?.isLive ? 'ok' : somStatus?.connectionError ? 'error' : 'unknown',
        message: somStatus?.isLive ? `${somStatus.deviceCount || 0} devices, ${somStatus.conveyorCount || 0} conveyors` : somStatus?.connectionError || 'Not connected',
        lastSync: somStatus?.lastSuccessfulPoll || null,
      },
      server: {
        status: 'ok',
        uptime: Math.round(process.uptime()),
        memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      },
    };

    const overall = Object.values(systems).every(s => s.status === 'ok') ? 'ok' :
                    Object.values(systems).some(s => s.status === 'down' || s.status === 'error') ? 'degraded' : 'ok';

    return json(res, { status: overall, systems, timestamp: new Date().toISOString() });
  }

  if (req.method==='GET' && url.pathname==='/api/dvi/trace/status') {
    const status = dviTrace.getStatus();
    // Add queue job count from XML index (jobs not in trace)
    const traceJobIds = new Set(dviTrace.getJobs().map(j => j.job_id));
    let queueJobs = 0;
    for (const [jobNum, xml] of dviJobIndex) {
      if (!traceJobIds.has(jobNum) && xml.status === 'NEW') queueJobs++;
    }
    status.queueJobs = queueJobs;
    status.totalWip = (status.jobCount || 0) + queueJobs - (status.byStage?.SHIPPING || 0) - (status.byStage?.CANCELED || 0);
    return json(res, status);
  }
  if (req.method==='GET' && url.pathname==='/api/dvi/trace/events') {
    const limit = parseInt(url.searchParams.get('limit') || '100');
    return json(res, dviTrace.getRecentEvents(limit));
  }
  if (req.method==='GET' && url.pathname==='/api/dvi/trace/stats') {
    return json(res, dviTrace.getStats());
  }
  if (req.method==='GET' && url.pathname.startsWith('/api/dvi/trace/job/')) {
    const jobId = url.pathname.split('/').pop();
    const history = dviTrace.getJobHistory(jobId);
    if (!history) return json(res, { error: 'Job not found' }, 404);
    return json(res, history);
  }

  // ── Analytics: daily throughput from DVI trace ─────────────────
  if (req.method==='GET' && url.pathname==='/api/analytics/throughput') {
    const days = parseInt(url.searchParams.get('days') || '30');
    const allJobs = dviTrace.getJobs();
    const now = Date.now();
    const cutoff = now - days * 86400000;

    // Daily throughput: jobs entering each stage per day
    const byDay = {};
    for (let d = 0; d < days; d++) {
      const date = new Date(now - d * 86400000);
      const key = date.toISOString().slice(0, 10);
      byDay[key] = { date: key, incoming: 0, shipped: 0, surfacing: 0, coating: 0, edging: 0, assembly: 0, breakage: 0, total: 0 };
    }

    // Count jobs by stage based on firstSeen/lastSeen dates
    for (const j of allJobs) {
      if (!j.firstSeen || j.firstSeen < cutoff) continue;
      const entryKey = new Date(j.firstSeen).toISOString().slice(0, 10);
      if (byDay[entryKey]) {
        byDay[entryKey].incoming++;
        byDay[entryKey].total++;
      }
      if (j.status === 'SHIPPED' && j.lastSeen) {
        const shipKey = new Date(j.lastSeen).toISOString().slice(0, 10);
        if (byDay[shipKey]) byDay[shipKey].shipped++;
      }
      if (j.hasBreakage) {
        const brkKey = new Date(j.lastSeen || j.firstSeen).toISOString().slice(0, 10);
        if (byDay[brkKey]) byDay[brkKey].breakage++;
      }
    }

    // Helper: is job still active WIP?
    const isWip = j => j.stage !== 'SHIPPING' && j.stage !== 'CANCELED' && j.status !== 'SHIPPED';

    // Current WIP by stage
    const stageCount = {};
    for (const j of allJobs) {
      if (!isWip(j)) continue;
      const s = j.stage || 'UNKNOWN';
      stageCount[s] = (stageCount[s] || 0) + 1;
    }

    // By station (top 20)
    const stationCount = {};
    for (const j of allJobs) {
      if (!isWip(j)) continue;
      const s = j.station || 'UNKNOWN';
      stationCount[s] = (stationCount[s] || 0) + 1;
    }
    const topStations = Object.entries(stationCount).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([s, c]) => ({ station: s, jobs: c }));

    // Coating breakdown from current WIP
    const coatingCount = {};
    for (const j of allJobs) {
      if (!isWip(j)) continue;
      const ct = j.coatType || 'Unknown';
      if (!coatingCount[ct]) coatingCount[ct] = { total: 0, stages: {} };
      coatingCount[ct].total++;
      const s = j.stage || 'UNKNOWN';
      coatingCount[ct].stages[s] = (coatingCount[ct].stages[s] || 0) + 1;
    }

    // Cycle time stats (days from firstSeen to lastSeen for shipped jobs)
    const cycleTimes = [];
    for (const j of allJobs) {
      if (j.status === 'SHIPPED' && j.firstSeen && j.lastSeen) {
        const days_ = (j.lastSeen - j.firstSeen) / 86400000;
        if (days_ > 0 && days_ < 30) cycleTimes.push(days_);
      }
    }
    cycleTimes.sort((a, b) => a - b);
    const avgCycle = cycleTimes.length ? (cycleTimes.reduce((s, d) => s + d, 0) / cycleTimes.length).toFixed(2) : 0;
    const medianCycle = cycleTimes.length ? cycleTimes[Math.floor(cycleTimes.length / 2)].toFixed(2) : 0;
    const p90Cycle = cycleTimes.length ? cycleTimes[Math.floor(cycleTimes.length * 0.9)].toFixed(2) : 0;

    // Operator leaderboard (by station completions today)
    const operatorStats = {};
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const recentEvents = dviTrace.getRecentEvents(5000);
    for (const ev of recentEvents) {
      if (ev.timestamp < todayStart.getTime()) continue;
      const op = ev.operator || '?';
      if (!operatorStats[op]) operatorStats[op] = { events: 0, stations: {} };
      operatorStats[op].events++;
      const st = ev.station || '?';
      operatorStats[op].stations[st] = (operatorStats[op].stations[st] || 0) + 1;
    }
    const topOperators = Object.entries(operatorStats)
      .sort((a, b) => b[1].events - a[1].events)
      .slice(0, 15)
      .map(([op, data]) => ({ operator: op, events: data.events, topStation: Object.entries(data.stations).sort((a, b) => b[1] - a[1])[0]?.[0] || '?' }));

    const daily = Object.values(byDay).sort((a, b) => a.date.localeCompare(b.date));

    return json(res, {
      daily,
      stageCount,
      topStations,
      coatingCount,
      cycleTime: { avg: parseFloat(avgCycle), median: parseFloat(medianCycle), p90: parseFloat(p90Cycle), samples: cycleTimes.length },
      topOperators,
      totalJobs: allJobs.length,
      activeWIP: allJobs.filter(isWip).length,
      shipped: allJobs.filter(j => j.status === 'SHIPPED' || j.stage === 'SHIPPING').length,
      incoming: allJobs.filter(j => {
        const s = (j.station || '').toUpperCase();
        return s.includes('INHSE FIN') || s.includes('INHSE SF');
      }).length,
    });
  }

  // ── Breakage endpoint — real data from DVI Trace ─────────────
  if (req.method==='GET' && url.pathname==='/api/breakage') {
    const allJobs = dviTrace.getJobs();
    const breakageJobs = [];
    for (const j of allJobs) {
      if (!j.hasBreakage) continue;
      const xml = dviJobIndex.get(j.job_id) || {};
      // Find the breakage event in the job's history
      const detail = dviTrace.getJobHistory ? dviTrace.getJobHistory(j.job_id) : null;
      const events = detail?.events || [];
      const brkEvent = events.find(e => e.stage === 'BREAKAGE');
      // Find the station just before breakage for "dept" info
      const brkIdx = events.findIndex(e => e.stage === 'BREAKAGE');
      const prevEvent = brkIdx > 0 ? events[brkIdx - 1] : null;
      breakageJobs.push({
        id: `BRK-${j.job_id}`,
        job: j.job_id,
        dept: prevEvent?.stage || j.stage || 'UNKNOWN',
        station: j.station,
        currentStage: j.stage,
        type: 'Breakage',
        lens: xml.lensType === 'P' ? 'Both' : xml.lensType === 'S' ? 'OD' : 'OS',
        coating: xml.coating || 'Unknown',
        lensStyle: xml.lensStyle || null,
        lensMat: xml.lensMat || null,
        time: brkEvent?.timestamp ? new Date(brkEvent.timestamp) : new Date(j.lastSeen || j.firstSeen),
        operator: brkEvent?.operator || j.operator || '?',
        resolved: j.stage !== 'BREAKAGE',
        daysInLab: j.daysInLab || 0,
        note: j.stage === 'BREAKAGE' ? 'Currently at breakage station' : `Resolved — now at ${j.stage}`,
      });
    }
    breakageJobs.sort((a, b) => new Date(b.time) - new Date(a.time));

    // Aggregate by day for history
    const byDay = {};
    for (const b of breakageJobs) {
      const d = new Date(b.time);
      if (isNaN(d.getTime())) continue;
      const key = d.toISOString().slice(0, 10);
      if (!byDay[key]) byDay[key] = { date: key, total: 0, active: 0, resolved: 0, byStage: {}, byCoating: {}, jobs: [] };
      byDay[key].total++;
      if (b.resolved) byDay[key].resolved++; else byDay[key].active++;
      const st = b.dept || 'UNKNOWN';
      byDay[key].byStage[st] = (byDay[key].byStage[st] || 0) + 1;
      const ct = b.coating || 'Unknown';
      byDay[key].byCoating[ct] = (byDay[key].byCoating[ct] || 0) + 1;
      byDay[key].jobs.push({ job: b.job, dept: b.dept, coating: b.coating, operator: b.operator, resolved: b.resolved });
    }
    const dailyHistory = Object.values(byDay).sort((a, b) => b.date.localeCompare(a.date));

    // Persist daily history to disk so it survives beyond trace file window
    const histPath = path.join(__dirname, 'data', 'breakage-history.json');
    try {
      let saved = {};
      if (fs.existsSync(histPath)) saved = JSON.parse(fs.readFileSync(histPath, 'utf8'));
      for (const day of dailyHistory) {
        saved[day.date] = { total: day.total, active: day.active, resolved: day.resolved, byStage: day.byStage, byCoating: day.byCoating };
      }
      fs.mkdirSync(path.dirname(histPath), { recursive: true });
      fs.writeFileSync(histPath, JSON.stringify(saved, null, 2));
    } catch (e) { /* non-critical */ }

    return json(res, {
      breakage: breakageJobs,
      total: breakageJobs.length,
      active: breakageJobs.filter(b => !b.resolved).length,
      today: breakageJobs.filter(b => new Date(b.time).toDateString() === new Date().toDateString()).length,
      dailyHistory,
    });
  }

  // Breakage history — full persisted daily record
  if (req.method==='GET' && url.pathname==='/api/breakage/history') {
    const histPath = path.join(__dirname, 'data', 'breakage-history.json');
    let saved = {};
    try { if (fs.existsSync(histPath)) saved = JSON.parse(fs.readFileSync(histPath, 'utf8')); } catch(e) {}
    const days = Object.entries(saved).map(([date, data]) => ({ date, ...data })).sort((a, b) => b.date.localeCompare(a.date));
    return json(res, { history: days, totalDays: days.length });
  }

  // ── SQLite Backup & Restore ──────────────────────────────────
  if (req.method==='GET' && url.pathname==='/api/db/backup') {
    const dbDir = path.join(__dirname, '..', 'data');
    const backupDir = path.join(dbDir, 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const results = [];
    for (const dbName of ['lab_assistant.db', 'gateway.db']) {
      const src = path.join(dbDir, dbName);
      if (!fs.existsSync(src)) continue;
      const dest = path.join(backupDir, `${dbName.replace('.db','')}_${ts}.db`);
      try {
        // Use SQLite VACUUM INTO for a clean, consistent backup
        const Database = require('better-sqlite3');
        const db = new Database(src, { readonly: true });
        db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
        db.close();
        const stat = fs.statSync(dest);
        results.push({ db: dbName, file: path.basename(dest), size: stat.size, ok: true });
      } catch(e) {
        // Fallback: simple file copy
        try {
          fs.copyFileSync(src, dest);
          results.push({ db: dbName, file: path.basename(dest), size: fs.statSync(dest).size, ok: true, method: 'copy' });
        } catch(e2) {
          results.push({ db: dbName, ok: false, error: e2.message });
        }
      }
    }
    return json(res, { success: true, timestamp: ts, backups: results, dir: backupDir });
  }

  if (req.method==='GET' && url.pathname==='/api/db/backups') {
    const backupDir = path.join(__dirname, '..', 'data', 'backups');
    if (!fs.existsSync(backupDir)) return json(res, { backups: [] });
    const files = fs.readdirSync(backupDir)
      .filter(f => f.endsWith('.db'))
      .map(f => {
        const stat = fs.statSync(path.join(backupDir, f));
        return { file: f, size: stat.size, created: stat.mtime.toISOString() };
      })
      .sort((a, b) => b.created.localeCompare(a.created));
    return json(res, { backups: files, dir: backupDir });
  }

  if (req.method==='POST' && url.pathname==='/api/db/restore') {
    const body = await readBody(req);
    const { file } = body;
    if (!file) return json(res, { success: false, error: 'Missing file parameter' }, 400);
    // Sanitize filename
    const safe = path.basename(file);
    const backupDir = path.join(__dirname, '..', 'data', 'backups');
    const backupPath = path.join(backupDir, safe);
    if (!fs.existsSync(backupPath)) return json(res, { success: false, error: 'Backup file not found' }, 404);
    // Determine target DB
    const targetName = safe.startsWith('lab_assistant') ? 'lab_assistant.db' : safe.startsWith('gateway') ? 'gateway.db' : null;
    if (!targetName) return json(res, { success: false, error: 'Cannot determine target DB from filename' }, 400);
    const targetPath = path.join(__dirname, '..', 'data', targetName);
    try {
      // Auto-backup current before restore
      const preTs = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
      const preBackup = path.join(backupDir, `${targetName.replace('.db','')}_pre-restore_${preTs}.db`);
      if (fs.existsSync(targetPath)) fs.copyFileSync(targetPath, preBackup);
      // Delete WAL/SHM files to avoid corruption
      for (const ext of ['-wal', '-shm']) {
        const f = targetPath + ext;
        if (fs.existsSync(f)) fs.unlinkSync(f);
      }
      fs.copyFileSync(backupPath, targetPath);
      return json(res, { success: true, restored: targetName, from: safe, preBackup: path.basename(preBackup) });
    } catch(e) {
      return json(res, { success: false, error: e.message }, 500);
    }
  }

  if (req.method==='GET' && url.pathname==='/api/db/status') {
    const dbPath = path.join(__dirname, '..', 'data', 'lab_assistant.db');
    const gwDbPath = path.join(__dirname, '..', 'data', 'gateway.db');
    const backupDir = path.join(__dirname, '..', 'data', 'backups');
    const result = { databases: [], backups: { count: 0, latest: null, dir: backupDir } };
    for (const [name, dbFile] of [['lab_assistant.db', dbPath], ['gateway.db', gwDbPath]]) {
      if (!fs.existsSync(dbFile)) { result.databases.push({ name, exists: false }); continue; }
      try {
        const Database = require('better-sqlite3');
        const d = new Database(dbFile, { readonly: true });
        const tables = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
        const tableStats = tables.map(t => {
          const count = d.prepare(`SELECT COUNT(*) as c FROM "${t.name}"`).get().c;
          return { name: t.name, rows: count };
        });
        const stat = fs.statSync(dbFile);
        d.close();
        result.databases.push({ name, exists: true, size: stat.size, modified: stat.mtime.toISOString(), tables: tableStats });
      } catch(e) {
        result.databases.push({ name, exists: true, error: e.message });
      }
    }
    if (fs.existsSync(backupDir)) {
      const files = fs.readdirSync(backupDir).filter(f => f.endsWith('.db')).sort().reverse();
      result.backups.count = files.length;
      if (files.length > 0) {
        const stat = fs.statSync(path.join(backupDir, files[0]));
        result.backups.latest = { file: files[0], size: stat.size, created: stat.mtime.toISOString() };
      }
    }
    return json(res, result);
  }

  if (req.method==='GET' && url.pathname==='/api/db/export') {
    // Export all tables as JSON for portability
    const dbPath = path.join(__dirname, '..', 'data', 'lab_assistant.db');
    if (!fs.existsSync(dbPath)) return json(res, { error: 'Database not found' }, 404);
    try {
      const Database = require('better-sqlite3');
      const db = new Database(dbPath, { readonly: true });
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
      const dump = {};
      for (const { name } of tables) {
        dump[name] = { rows: db.prepare(`SELECT * FROM "${name}"`).all(), count: db.prepare(`SELECT COUNT(*) as c FROM "${name}"`).get().c };
      }
      db.close();
      return json(res, { tables: Object.keys(dump), data: dump, exportedAt: new Date().toISOString() });
    } catch(e) {
      return json(res, { error: e.message }, 500);
    }
  }

  // ── Vision Scanner API — iPad LensScanner app endpoints ─────
  if (req.method==='GET' && url.pathname==='/api/vision/health') {
    return json(res, { ok: true, jobs: dviTrace.getJobs().length, timestamp: new Date().toISOString() });
  }

  if (req.method==='POST' && url.pathname==='/api/vision/scan') {
    const body = await readBody(req);
    const { jobNumber } = body;
    if (!jobNumber) return json(res, { success: false, message: 'Missing jobNumber' }, 400);
    const allJobs = dviTrace.getJobs();
    const job = allJobs.find(j => j.job_id === jobNumber);
    if (!job) {
      return json(res, { success: false, message: 'Job not found in DVI', jobId: jobNumber });
    }
    const xml = dviJobIndex.get(jobNumber) || {};
    return json(res, {
      success: true,
      message: `Found at ${job.stage}`,
      jobId: job.job_id,
      trayId: job.tray,
      stage: job.stage,
      station: job.station,
      operator: job.operator,
      coating: xml.coating || null,
      daysInLab: job.daysInLab,
    });
  }

  if (req.method==='POST' && url.pathname==='/api/vision/batch-scan') {
    const body = await readBody(req);
    const { jobNumbers } = body;
    if (!Array.isArray(jobNumbers)) return json(res, { success: false, message: 'Missing jobNumbers array' }, 400);
    const allJobs = dviTrace.getJobs();
    const jobMap = new Map(allJobs.map(j => [j.job_id, j]));
    const results = jobNumbers.map(num => {
      const job = jobMap.get(num);
      if (!job) return { jobNumber: num, success: false, message: 'Not found in DVI', stage: null, station: null };
      const xml = dviJobIndex.get(num) || {};
      return {
        jobNumber: num,
        success: true,
        message: `${job.stage} — ${job.station}`,
        stage: job.stage,
        station: job.station,
        coating: xml.coating || null,
        daysInLab: job.daysInLab,
      };
    });
    const matched = results.filter(r => r.success).length;
    return json(res, { success: true, results, matched, total: jobNumbers.length });
  }

  // Slack test endpoint
  if (req.method==='POST' && url.pathname==='/api/slack/test') {
    try {
      const body = await readBody(req);
      const message = body.message || '✅ Test message from Lab_Assistant';
      const success = await limble.sendSlackMessage(message);
      return json(res, { ok: success, message: success ? 'Message sent to Slack' : 'Failed to send - check Slack config' });
    } catch (e) {
      return json(res, { ok: false, error: e.message }, 500);
    }
  }

  // Slack messages proxy (reads channel history)
  if (req.method==='GET' && url.pathname==='/api/slack/messages') {
    const token = process.env.SLACK_BOT_TOKEN;
    const channelId = url.searchParams.get('channel') || process.env.SLACK_CHANNEL_ID || '';
    if (!token) return json(res, { ok: false, error: 'SLACK_BOT_TOKEN not configured' });
    if (!channelId) return json(res, { ok: false, error: 'No channel ID - set SLACK_CHANNEL_ID in .env' });
    try {
      const oldest = url.searchParams.get('oldest') || '';
      const params = new URLSearchParams({ channel: channelId, limit: '20' });
      if (oldest) params.set('oldest', oldest);
      const slackRes = await fetch(`https://slack.com/api/conversations.history?${params}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await slackRes.json();
      return json(res, data);
    } catch (e) {
      return json(res, { ok: false, error: e.message }, 500);
    }
  }

  // Slack send message
  if (req.method==='POST' && url.pathname==='/api/slack/send') {
    const token = process.env.SLACK_BOT_TOKEN;
    const channel = process.env.SLACK_CHANNEL || 'lab-assistant';
    if (!token) return json(res, { ok: false, error: 'SLACK_BOT_TOKEN not configured' });
    try {
      const body = await readBody(req);
      const slackRes = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, text: body.text || body.message })
      });
      const data = await slackRes.json();
      return json(res, data);
    } catch (e) {
      return json(res, { ok: false, error: e.message }, 500);
    }
  }

  // Slack channel info (get channel ID by name)
  if (req.method==='GET' && url.pathname==='/api/slack/channel') {
    const token = process.env.SLACK_BOT_TOKEN;
    const name = url.searchParams.get('name') || process.env.SLACK_CHANNEL || 'lab-assistant';
    if (!token) return json(res, { ok: false, error: 'SLACK_BOT_TOKEN not configured' });
    try {
      const slackRes = await fetch('https://slack.com/api/conversations.list?types=public_channel&limit=200', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await slackRes.json();
      if (data.ok && data.channels) {
        const ch = data.channels.find(c => c.name === name);
        return json(res, { ok: true, channel: ch || null, name });
      }
      return json(res, { ok: false, error: data.error });
    } catch (e) {
      return json(res, { ok: false, error: e.message }, 500);
    }
  }

  // ── Knowledge Base API ─────────────────────────────────────────
  if (req.method==='GET' && url.pathname==='/api/knowledge/list') {
    const agent = url.searchParams.get('agent') || undefined;
    const category = url.searchParams.get('category') || undefined;
    const tag = url.searchParams.get('tag') || undefined;
    const docs = knowledge.listDocuments({ agent, category, tag });
    return json(res, { docs, total: docs.length });
  }

  if (req.method==='GET' && url.pathname==='/api/knowledge/search') {
    const q = url.searchParams.get('q') || '';
    const agent = url.searchParams.get('agent') || undefined;
    const category = url.searchParams.get('category') || undefined;
    const limit = parseInt(url.searchParams.get('limit') || '10');
    if (!q.trim()) return json(res, { results: [], query: q });
    const results = knowledge.searchDocuments(q, { agent, category, limit });
    return json(res, { results, query: q, total: results.length });
  }

  if (req.method==='GET' && url.pathname==='/api/knowledge/context') {
    const agent = url.searchParams.get('agent') || 'LabAgent';
    const context = knowledge.getAlwaysOnContext(agent);
    const aiCtx = knowledge.getAIContext(agent);
    return json(res, { context, ...aiCtx });
  }

  if (req.method==='GET' && url.pathname.startsWith('/api/knowledge/doc/')) {
    const id = url.pathname.split('/').pop();
    const doc = knowledge.getDocument(id);
    if (!doc) return json(res, { error: 'Not found' }, 404);
    const text = knowledge.getDocumentText(id);
    return json(res, { ...doc, textContent: text ? text.substring(0, 10000) : null });
  }

  if (req.method==='GET' && url.pathname.startsWith('/api/knowledge/file/')) {
    const id = url.pathname.split('/').pop();
    const filePath = knowledge.getFilePath(id);
    const doc = knowledge.getDocument(id);
    if (!filePath || !doc || !fs.existsSync(filePath)) return json(res, { error: 'Not found' }, 404);
    const stat = fs.statSync(filePath);
    res.writeHead(200, {
      'Content-Type': doc.mimeType || 'application/octet-stream',
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename="${doc.originalName}"`,
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  if (req.method==='GET' && url.pathname.startsWith('/api/knowledge/download/')) {
    const id = url.pathname.split('/').pop();
    const file = knowledge.getGeneratedFile(id);
    if (!file || !fs.existsSync(file.path)) return json(res, { error: 'Not found' }, 404);
    const stat = fs.statSync(file.path);
    res.writeHead(200, {
      'Content-Type': 'text/csv',
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename="${file.filename}"`,
    });
    fs.createReadStream(file.path).pipe(res);
    return;
  }

  if (req.method==='DELETE' && url.pathname.startsWith('/api/knowledge/doc/')) {
    const id = url.pathname.split('/').pop();
    const ok = knowledge.deleteDocument(id);
    return json(res, { ok, id });
  }

  if (req.method==='PATCH' && url.pathname.startsWith('/api/knowledge/doc/')) {
    const id = url.pathname.split('/').pop();
    const body = await readBody(req);
    const doc = knowledge.updateDocument(id, body);
    if (!doc) return json(res, { error: 'Not found' }, 404);
    return json(res, { ok: true, doc });
  }

  if (req.method==='POST' && url.pathname==='/api/knowledge/upload') {
    // Parse multipart form data manually (no deps)
    const contentType = req.headers['content-type'] || '';
    if (contentType.includes('multipart/form-data')) {
      const boundary = contentType.split('boundary=')[1];
      if (!boundary) return json(res, { error: 'No boundary in multipart' }, 400);
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        try {
          const buf = Buffer.concat(chunks);
          const parts = parseMultipart(buf, boundary);
          const filePart = parts.find(p => p.filename);
          if (!filePart) return json(res, { error: 'No file uploaded' }, 400);
          const meta = {};
          for (const p of parts) {
            if (!p.filename && p.name) meta[p.name] = p.data.toString('utf-8');
          }
          const doc = knowledge.addDocument({
            filename: filePart.filename,
            category: meta.category || 'general',
            title: meta.title || filePart.filename,
            description: meta.description || '',
            agents: meta.agents ? JSON.parse(meta.agents) : [],
            tags: meta.tags ? JSON.parse(meta.tags) : [],
            alwaysOn: meta.alwaysOn === 'true',
            content: filePart.data,
            mimeType: filePart.contentType || 'application/octet-stream',
          });
          json(res, { ok: true, doc });
        } catch (e) {
          json(res, { error: e.message }, 500);
        }
      });
      return;
    }
    // JSON upload (for text content)
    const body = await readBody(req);
    if (!body.title || !body.content) return json(res, { error: 'title and content required' }, 400);
    const doc = knowledge.addDocument({
      filename: (body.title || 'doc').replace(/[^a-zA-Z0-9_-]/g, '_') + '.txt',
      category: body.category || 'general',
      title: body.title,
      description: body.description || '',
      agents: body.agents || [],
      tags: body.tags || [],
      alwaysOn: body.alwaysOn || false,
      content: body.content,
      mimeType: 'text/plain',
    });
    return json(res, { ok: true, doc });
  }

  if (req.method==='POST' && url.pathname==='/api/knowledge/generate-csv') {
    const body = await readBody(req);
    if (!body.title || !body.headers || !body.rows) return json(res, { error: 'title, headers, rows required' }, 400);
    const result = knowledge.generateCSV({
      title: body.title,
      headers: body.headers,
      rows: body.rows,
      agent: body.agent || 'LabAgent',
    });
    return json(res, { ok: true, ...result });
  }

  // AI Query endpoint - processes questions with lab context
  if (req.method==='POST' && url.pathname==='/api/ai/query') {
    const apiKey = process.env.VITE_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return json(res, { ok: false, error: 'No Anthropic API key configured' });
    try {
      const body = await readBody(req);
      const question = body.question || body.text || '';
      if (!question.trim()) return json(res, { ok: false, error: 'No question provided' });

      // Gather lab context
      const inventoryCtx = itempath.getAIContext ? itempath.getAIContext() : { summary: 'Inventory data not available' };
      const maintenanceCtx = limble.getAIContext ? limble.getAIContext() : { summary: 'Maintenance data not available' };
      const somCtx = som.getAIContext ? som.getAIContext() : { machines: {}, conveyors: {} };
      const ovenStats = computeStats ? computeStats() : {};

      const systemPrompt = `You are Lab_Assistant AI, an expert assistant for an optical lens laboratory. You have access to live data:

INVENTORY (Kardex/ItemPath):
${inventoryCtx.summary || 'No inventory data'}
${inventoryCtx.alerts ? `- ${inventoryCtx.alerts.length} low stock alerts` : ''}

MAINTENANCE (Limble CMMS):
${maintenanceCtx.summary || 'No maintenance data'}

SCHNEIDER MACHINES (SOM Control Center):
- ${somCtx.machines?.total || 0} machines, ${somCtx.machines?.running || 0} running
- ${somCtx.conveyors?.errors || 0} conveyor errors
${somCtx.activeAlerts?.slice(0,3).map(a => `- ${a.source}: ${a.message}`).join('\n') || ''}

OVEN STATUS:
${ovenStats.activeTimers || 0} active oven timers, ${ovenStats.totalRuns || 0} runs on record

Answer questions concisely and helpfully. If asked about specific inventory items, maintenance tasks, or equipment, use the data above. Keep responses under 300 words unless more detail is requested.`;

      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1024,
          system: systemPrompt,
          messages: [{ role: 'user', content: question }]
        })
      });

      const claudeData = await claudeRes.json();
      const answer = claudeData?.content?.[0]?.text || claudeData?.error?.message || 'Sorry, I could not process that question.';
      return json(res, { ok: true, question, answer });
    } catch (e) {
      return json(res, { ok: false, error: e.message }, 500);
    }
  }

  // Slack AI auto-responder - checks for /ai or @ai messages and responds
  if (req.method==='POST' && url.pathname==='/api/slack/ai-respond') {
    const token = process.env.SLACK_BOT_TOKEN;
    const apiKey = process.env.VITE_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
    const channelId = process.env.SLACK_CHANNEL_ID;
    if (!token) return json(res, { ok: false, error: 'SLACK_BOT_TOKEN not configured' });
    if (!apiKey) return json(res, { ok: false, error: 'No Anthropic API key configured' });

    try {
      const body = await readBody(req);
      const text = body.text || '';
      const threadTs = body.thread_ts || body.ts; // Reply in thread if available

      // Extract question after /ai or @ai trigger
      const match = text.match(/(?:\/ai|@ai|ai:)\s*(.+)/i);
      if (!match) return json(res, { ok: false, error: 'No AI query found in message' });
      const question = match[1].trim();

      // Get AI response
      const inventoryCtx = itempath.getAIContext ? itempath.getAIContext() : {};
      const maintenanceCtx = limble.getAIContext ? limble.getAIContext() : {};

      const systemPrompt = `You are Lab_Assistant AI for an optical lens lab. Answer concisely (under 200 words). Use this live data:
INVENTORY: ${inventoryCtx.summary || 'N/A'}
MAINTENANCE: ${maintenanceCtx.summary || 'N/A'}`;

      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 512,
          system: systemPrompt,
          messages: [{ role: 'user', content: question }]
        })
      });

      const claudeData = await claudeRes.json();
      const answer = claudeData?.content?.[0]?.text || 'Sorry, I could not process that question.';

      // Post response to Slack
      const slackPayload = {
        channel: body.channel || channelId,
        text: `🤖 *Lab_Assistant AI*\n${answer}`,
      };
      if (threadTs) slackPayload.thread_ts = threadTs;

      const slackRes = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(slackPayload)
      });
      const slackData = await slackRes.json();

      return json(res, { ok: slackData.ok, question, answer, slackResponse: slackData });
    } catch (e) {
      return json(res, { ok: false, error: e.message }, 500);
    }
  }

  // ── Visual Shift Report (HTML with charts) ────────────────────
  // POST /api/report/visual — collects live data, returns standalone HTML
  if (req.method==='POST' && url.pathname==='/api/report/visual') {
    try {
      const body = await readBody(req);
      const { title = 'Shift Report', narrative = '' } = body;
      const now = new Date();
      const todayStart = new Date(); todayStart.setHours(0,0,0,0);
      const todayMs = todayStart.getTime();
      const weekStart = new Date(todayStart); weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));

      // ── Collect all live data ──────────────────────────────
      const allTraceJobs = dviTrace.getJobs ? dviTrace.getJobs() : [];
      const wipJobs = allTraceJobs.filter(j => j.status !== 'SHIPPED' && j.stage !== 'CANCELED');

      // WIP by stage
      const stages = ['INCOMING','AT_KARDEX','NEL','SURFACING','COATING','CUTTING','ASSEMBLY','QC','HOLD','BREAKAGE','SHIPPING'];
      const wipByStage = {};
      for (const s of stages) wipByStage[s] = 0;
      for (const j of wipJobs) { wipByStage[j.stage] = (wipByStage[j.stage] || 0) + 1; }

      // Shipped stats
      const allShipped = [];
      for (const j of allTraceJobs) {
        if (j.status === 'SHIPPED' && j.lastSeen) allShipped.push(j);
      }
      for (const [jobNum, xml] of shippedJobIndex) {
        if (!xml.shippedAt) continue;
        if (allShipped.find(j => j.job_id === jobNum)) continue;
        allShipped.push({ job_id: jobNum, lastSeen: xml.shippedAt, status: 'SHIPPED' });
      }
      const shippedToday = allShipped.filter(j => j.lastSeen >= todayMs).length;
      const shippedThisWeek = allShipped.filter(j => j.lastSeen >= weekStart.getTime()).length;

      // Shipped history (14 days)
      const shippedByDay = [];
      for (let d = 13; d >= 0; d--) {
        const dayDate = new Date(Date.now() - d * 86400000);
        const key = dayDate.toISOString().slice(0, 10);
        const label = dayDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
        let count = 0;
        for (const j of allShipped) {
          if (new Date(j.lastSeen).toISOString().slice(0, 10) === key) count++;
        }
        shippedByDay.push({ date: key, label, count });
      }

      // Coating runs
      const activeCoating = Object.values(coatingRuns).map(r => ({
        name: r.coaterName, coating: r.coating,
        elapsed: Math.round((Date.now() - r.startedAt) / 60000),
        target: Math.round(r.targetSec / 60),
        jobs: r.jobCount || 0, status: r.status
      }));

      // Breakage
      const breakageJobs = allTraceJobs.filter(j => j.hasBreakage || j.stage === 'BREAKAGE');
      const breakageRate = wipJobs.length > 0 ? ((breakageJobs.length / wipJobs.length) * 100).toFixed(1) : '0.0';

      // Rush jobs
      const rushJobs = wipJobs.filter(j => j.rush === 'Y' || j.Rush === 'Y');

      // Aging (jobs >24h)
      const agedJobs = wipJobs.filter(j => j.daysInLab > 1).length;
      const criticalAged = wipJobs.filter(j => j.daysInLab > 3).length;

      // SOM machine status
      let somDevices = [], machineAlerts = [];
      try {
        const somResult = som.getDevices ? som.getDevices() : {};
        somDevices = Array.isArray(somResult.devices) ? somResult.devices : (Array.isArray(somResult) ? somResult : []);
        machineAlerts = somDevices.filter(d => d.severity === 'error' || d.severity === 'warning');
      } catch(e) { console.warn('[Report] SOM data unavailable:', e.message); }

      // Inventory alerts
      let invAlerts = [];
      try { invAlerts = itempath.getAlerts ? itempath.getAlerts() : []; }
      catch(e) { console.warn('[Report] ItemPath alerts unavailable:', e.message); }

      // ── KPI summary ────────────────────────────────────────
      const kpis = [
        { label: 'Total WIP', value: wipJobs.length, target: null, color: '#3B82F6' },
        { label: 'Shipped Today', value: shippedToday, target: 850, color: '#10B981' },
        { label: 'Shipped This Week', value: shippedThisWeek, target: 5100, color: '#10B981' },
        { label: 'Rush Active', value: rushJobs.length, target: 0, color: rushJobs.length > 0 ? '#EF4444' : '#10B981' },
        { label: 'Breakage Rate', value: `${breakageRate}%`, target: '<2%', color: parseFloat(breakageRate) > 2 ? '#EF4444' : '#10B981' },
        { label: 'WIP >24h', value: agedJobs, target: 0, color: agedJobs > 5 ? '#EF4444' : agedJobs > 0 ? '#F59E0B' : '#10B981' },
        { label: 'Critical (>3d)', value: criticalAged, target: 0, color: criticalAged > 0 ? '#EF4444' : '#10B981' },
        { label: 'Machine Alerts', value: machineAlerts.length, target: 0, color: machineAlerts.length > 0 ? '#F59E0B' : '#10B981' },
      ];

      // ── Generate HTML ──────────────────────────────────────
      const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
      const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

      const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} — ${dateStr}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"><\/script>
<style>
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&family=JetBrains+Mono:wght@400;700&display=swap');
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:#070A0F; color:#E8ECF1; font-family:'DM Sans',sans-serif; padding:40px; min-height:100vh; }
  .mono { font-family:'JetBrains Mono',monospace; }
  .container { max-width:1200px; margin:0 auto; }
  .header { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:32px; padding-bottom:24px; border-bottom:1px solid #1E2A3A; }
  .header h1 { font-size:32px; font-weight:800; letter-spacing:-0.5px; }
  .header .subtitle { color:#8899AA; font-size:14px; margin-top:4px; }
  .logo { text-align:right; }
  .logo .company { font-size:18px; font-weight:700; color:#3B82F6; }
  .logo .dept { font-size:11px; color:#556677; letter-spacing:2px; text-transform:uppercase; }
  .section { margin-bottom:32px; }
  .section-title { font-size:11px; font-weight:700; letter-spacing:2px; text-transform:uppercase; color:#556677; margin-bottom:12px; padding-bottom:8px; border-bottom:1px solid #1E2A3A; }
  .kpi-grid { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin-bottom:32px; }
  .kpi-card { background:#0D1117; border:1px solid #1E2A3A; border-radius:10px; padding:16px; text-align:center; }
  .kpi-card .label { font-size:10px; letter-spacing:1.5px; text-transform:uppercase; color:#556677; margin-bottom:6px; }
  .kpi-card .value { font-size:32px; font-weight:800; font-family:'JetBrains Mono',monospace; line-height:1.1; }
  .kpi-card .target { font-size:10px; color:#556677; margin-top:4px; }
  .chart-grid { display:grid; grid-template-columns:2fr 1fr; gap:16px; margin-bottom:32px; }
  .chart-card { background:#0D1117; border:1px solid #1E2A3A; border-radius:10px; padding:20px; }
  .chart-card h3 { font-size:12px; font-weight:700; letter-spacing:1px; text-transform:uppercase; color:#8899AA; margin-bottom:16px; }
  .pipeline { display:flex; gap:4px; margin-bottom:32px; align-items:flex-end; height:120px; }
  .pipeline .bar { flex:1; background:#1E2A3A; border-radius:4px 4px 0 0; position:relative; min-height:4px; display:flex; flex-direction:column; justify-content:flex-end; align-items:center; }
  .pipeline .bar .count { font-size:14px; font-weight:800; font-family:'JetBrains Mono',monospace; color:#E8ECF1; margin-bottom:4px; }
  .pipeline .bar .name { position:absolute; bottom:-20px; font-size:8px; letter-spacing:0.5px; text-transform:uppercase; color:#556677; white-space:nowrap; }
  .coater-row { display:flex; gap:12px; margin-bottom:12px; }
  .coater-card { flex:1; background:#0D1117; border:1px solid #1E2A3A; border-radius:8px; padding:14px; }
  .coater-card.active { border-color:#10B981; }
  .coater-card .name { font-size:13px; font-weight:700; }
  .coater-card .status { font-size:11px; margin-top:4px; }
  .coater-card .timer { font-size:24px; font-weight:800; font-family:'JetBrains Mono',monospace; color:#10B981; }
  .bar-progress { height:6px; background:#1E2A3A; border-radius:3px; overflow:hidden; margin-top:8px; }
  .bar-fill { height:100%; border-radius:3px; }
  .alert-list { list-style:none; }
  .alert-list li { padding:8px 12px; border-left:3px solid; margin-bottom:4px; background:#0D1117; border-radius:0 6px 6px 0; font-size:12px; }
  .alert-list li.red { border-color:#EF4444; }
  .alert-list li.amber { border-color:#F59E0B; }
  .alert-list li.green { border-color:#10B981; }
  .narrative { background:#0D1117; border:1px solid #1E2A3A; border-radius:10px; padding:24px; font-size:13px; line-height:1.7; white-space:pre-wrap; color:#C8D2DC; }
  .narrative h2 { font-size:16px; font-weight:700; color:#E8ECF1; margin:16px 0 8px; }
  .narrative h3 { font-size:14px; font-weight:700; color:#8899AA; margin:12px 0 6px; }
  .narrative strong { color:#E8ECF1; }
  .narrative ul { padding-left:20px; }
  .footer { margin-top:48px; padding-top:16px; border-top:1px solid #1E2A3A; display:flex; justify-content:space-between; font-size:10px; color:#334455; }
  @media print { body { background:#fff; color:#111; padding:20px; } .kpi-card,.chart-card,.coater-card,.narrative { border-color:#ddd; background:#fafafa; } .section-title,.kpi-card .label,.coater-card .status { color:#666; } .kpi-card .value { color:#111; } .footer { color:#999; } }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <div>
      <h1>${title}</h1>
      <div class="subtitle">${dateStr} · ${timeStr}</div>
    </div>
    <div class="logo">
      <div class="company">PAIR EYEWEAR</div>
      <div class="dept">Irvine Lens Lab — Lab_Assistant</div>
    </div>
  </div>

  <!-- KPI Cards -->
  <div class="section">
    <div class="section-title">Key Performance Indicators</div>
    <div class="kpi-grid">
      ${kpis.map(k => `
      <div class="kpi-card">
        <div class="label">${k.label}</div>
        <div class="value" style="color:${k.color}">${k.value}</div>
        ${k.target !== null ? `<div class="target">Target: ${k.target}</div>` : ''}
      </div>`).join('')}
    </div>
  </div>

  <!-- WIP Pipeline -->
  <div class="section">
    <div class="section-title">Production Pipeline — WIP by Stage</div>
    <div style="position:relative;margin-bottom:40px;">
      <div class="pipeline">
        ${stages.filter(s => s !== 'HOLD').map(s => {
          const count = wipByStage[s] || 0;
          const maxWip = Math.max(1, ...stages.map(st => wipByStage[st] || 0));
          const pct = Math.max(3, (count / maxWip) * 100);
          const colors = { INCOMING:'#3B82F6', AT_KARDEX:'#8B5CF6', NEL:'#F59E0B', SURFACING:'#06B6D4', COATING:'#10B981', CUTTING:'#F97316', ASSEMBLY:'#A855F7', QC:'#14B8A6', BREAKAGE:'#EF4444', SHIPPING:'#10B981' };
          return `<div class="bar" style="height:${pct}%;background:${colors[s]||'#1E2A3A'}">
            <span class="count">${count}</span>
            <span class="name">${s.replace('_',' ')}</span>
          </div>`;
        }).join('')}
      </div>
    </div>
  </div>

  <!-- Charts Row -->
  <div class="chart-grid">
    <div class="chart-card">
      <h3>Shipped — 14 Day Trend</h3>
      <canvas id="shippedChart" height="200"></canvas>
    </div>
    <div class="chart-card">
      <h3>WIP Distribution</h3>
      <canvas id="wipDonut" height="200"></canvas>
    </div>
  </div>

  <!-- Coating Machines -->
  <div class="section">
    <div class="section-title">Coating Machines</div>
    <div class="coater-row">
      ${['EB9 #1','EB9 #2','E1400'].map(name => {
        const run = activeCoating.find(r => r.name === name);
        if (run && run.status === 'running') {
          const pct = Math.min(100, Math.round((run.elapsed / run.target) * 100));
          const mm = String(run.target - run.elapsed).padStart(2,'0');
          return `<div class="coater-card active">
            <div class="name" style="color:#E8ECF1">${name} <span class="mono" style="font-size:10px;color:#556677;background:#070A0F;padding:2px 6px;border-radius:4px;margin-left:4px">${run.coating}</span></div>
            <div class="timer">${mm}m remaining</div>
            <div class="status" style="color:#8899AA">${run.jobs} jobs · ${run.elapsed}m elapsed of ${run.target}m</div>
            <div class="bar-progress"><div class="bar-fill" style="width:${pct}%;background:#10B981"></div></div>
          </div>`;
        }
        return `<div class="coater-card">
          <div class="name" style="color:#556677">${name}</div>
          <div class="status" style="color:#334455">IDLE</div>
        </div>`;
      }).join('')}
    </div>
  </div>

  <!-- Alerts & Issues -->
  <div class="chart-grid">
    <div class="chart-card">
      <h3>Active Alerts</h3>
      <ul class="alert-list">
        ${breakageJobs.length > 0 ? `<li class="red">🔴 ${breakageJobs.length} breakage job${breakageJobs.length>1?'s':''} (${breakageRate}% rate)</li>` : ''}
        ${criticalAged > 0 ? `<li class="red">🔴 ${criticalAged} job${criticalAged>1?'s':''} aging >3 days — requires escalation</li>` : ''}
        ${agedJobs > 0 ? `<li class="amber">🟡 ${agedJobs} job${agedJobs>1?'s':''} aging >24 hours</li>` : ''}
        ${rushJobs.length > 0 ? `<li class="amber">🟡 ${rushJobs.length} rush job${rushJobs.length>1?'s':''} active</li>` : ''}
        ${machineAlerts.length > 0 ? `<li class="amber">🟡 ${machineAlerts.length} machine alert${machineAlerts.length>1?'s':''}</li>` : ''}
        ${invAlerts.length > 0 ? `<li class="amber">🟡 ${invAlerts.length} low-stock alert${invAlerts.length>1?'s':''}</li>` : ''}
        ${breakageJobs.length===0 && criticalAged===0 && agedJobs===0 && rushJobs.length===0 && machineAlerts.length===0 && invAlerts.length===0 ? '<li class="green">✅ No active alerts — all systems nominal</li>' : ''}
      </ul>
    </div>
    <div class="chart-card">
      <h3>Quick Stats</h3>
      <div style="display:flex;flex-direction:column;gap:10px;margin-top:8px;">
        <div style="display:flex;justify-content:space-between;"><span style="color:#8899AA;font-size:12px">Total Tracked Jobs</span><span class="mono" style="font-size:14px;font-weight:700">${allTraceJobs.length}</span></div>
        <div style="display:flex;justify-content:space-between;"><span style="color:#8899AA;font-size:12px">Active WIP</span><span class="mono" style="font-size:14px;font-weight:700">${wipJobs.length}</span></div>
        <div style="display:flex;justify-content:space-between;"><span style="color:#8899AA;font-size:12px">Shipped (XML Archive)</span><span class="mono" style="font-size:14px;font-weight:700">${shippedJobIndex.size}</span></div>
        <div style="display:flex;justify-content:space-between;"><span style="color:#8899AA;font-size:12px">DVI Job Index</span><span class="mono" style="font-size:14px;font-weight:700">${dviJobIndex.size}</span></div>
        <div style="display:flex;justify-content:space-between;"><span style="color:#8899AA;font-size:12px">SOM Devices</span><span class="mono" style="font-size:14px;font-weight:700">${somDevices.length}</span></div>
      </div>
    </div>
  </div>

  ${narrative ? `
  <!-- AI Narrative -->
  <div class="section">
    <div class="section-title">AI Analysis</div>
    <div class="narrative">${narrative.replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/^## (.+)$/gm,'<h2>$1</h2>').replace(/^### (.+)$/gm,'<h3>$1</h3>').replace(/^- (.+)$/gm,'• $1')}</div>
  </div>` : ''}

  <div class="footer">
    <span>CONFIDENTIAL — Pair Eyewear Internal Operations</span>
    <span>Generated by Lab_Assistant · ${dateStr} ${timeStr}</span>
  </div>
</div>

<script>
  const shippedData = ${JSON.stringify(shippedByDay)};
  const wipData = ${JSON.stringify(stages.filter(s => (wipByStage[s]||0) > 0).map(s => ({ stage: s, count: wipByStage[s] })))};

  // Shipped trend chart
  new Chart(document.getElementById('shippedChart'), {
    type: 'bar',
    data: {
      labels: shippedData.map(d => d.label),
      datasets: [{
        label: 'Shipped',
        data: shippedData.map(d => d.count),
        backgroundColor: shippedData.map(d => d.date === '${now.toISOString().slice(0,10)}' ? '#3B82F6' : '#10B98140'),
        borderColor: shippedData.map(d => d.date === '${now.toISOString().slice(0,10)}' ? '#3B82F6' : '#10B981'),
        borderWidth: 1,
        borderRadius: 4,
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#556677', font: { size: 9 } }, grid: { color: '#1E2A3A' } },
        y: { ticks: { color: '#556677' }, grid: { color: '#1E2A3A' }, beginAtZero: true }
      }
    }
  });

  // WIP donut
  const wipColors = { INCOMING:'#3B82F6', AT_KARDEX:'#8B5CF6', NEL:'#F59E0B', SURFACING:'#06B6D4', COATING:'#10B981', CUTTING:'#F97316', ASSEMBLY:'#A855F7', QC:'#14B8A6', BREAKAGE:'#EF4444', SHIPPING:'#10B981', HOLD:'#6B7280', OTHER:'#334455' };
  new Chart(document.getElementById('wipDonut'), {
    type: 'doughnut',
    data: {
      labels: wipData.map(d => d.stage.replace('_',' ')),
      datasets: [{
        data: wipData.map(d => d.count),
        backgroundColor: wipData.map(d => wipColors[d.stage] || '#334455'),
        borderWidth: 0,
      }]
    },
    options: {
      responsive: true,
      cutout: '60%',
      plugins: {
        legend: { position: 'right', labels: { color: '#8899AA', font: { size: 10 }, padding: 8, usePointStyle: true } }
      }
    }
  });
<\/script>
</body>
</html>`;

      cors(res);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Disposition': `attachment; filename="ShiftReport_${now.toISOString().slice(0,10)}_${now.toISOString().slice(11,16).replace(':','')}.html"`,
      });
      res.end(html);
      console.log(`[Report] Visual shift report generated (${(html.length/1024).toFixed(1)}KB)`);
      return;
    } catch(e) {
      console.error('[Report] Visual report error:', e);
      return json(res, { ok:false, error: e.message }, 500);
    }
  }

  // ── CSV Shift Report ─────────────────────────────────────────
  // POST /api/report/csv — returns CSV with KPI + WIP pipeline data
  if (req.method==='POST' && url.pathname==='/api/report/csv') {
    try {
      const body = await readBody(req);
      const { title = 'Shift Report' } = body;
      const now = new Date();
      const todayStart = new Date(); todayStart.setHours(0,0,0,0);
      const todayMs = todayStart.getTime();
      const weekStart = new Date(todayStart); weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));

      const allTraceJobs = dviTrace.getJobs ? dviTrace.getJobs() : [];
      const wipJobs = allTraceJobs.filter(j => j.status !== 'SHIPPED' && j.stage !== 'CANCELED');

      // WIP by stage
      const stages = ['INCOMING','AT_KARDEX','NEL','SURFACING','COATING','CUTTING','ASSEMBLY','QC','HOLD','BREAKAGE','SHIPPING'];
      const wipByStage = {};
      for (const s of stages) wipByStage[s] = 0;
      for (const j of wipJobs) { wipByStage[j.stage] = (wipByStage[j.stage] || 0) + 1; }

      // Shipped
      const allShipped = [];
      for (const j of allTraceJobs) {
        if (j.status === 'SHIPPED' && j.lastSeen) allShipped.push(j);
      }
      for (const [jobNum, xml] of shippedJobIndex) {
        if (!xml.shippedAt) continue;
        if (allShipped.find(j => j.job_id === jobNum)) continue;
        allShipped.push({ job_id: jobNum, lastSeen: xml.shippedAt, status: 'SHIPPED' });
      }
      const shippedToday = allShipped.filter(j => j.lastSeen >= todayMs).length;
      const shippedThisWeek = allShipped.filter(j => j.lastSeen >= weekStart.getTime()).length;

      // Breakage / Rush / Aging
      const breakageJobs = allTraceJobs.filter(j => j.hasBreakage || j.stage === 'BREAKAGE');
      const breakageRate = wipJobs.length > 0 ? ((breakageJobs.length / wipJobs.length) * 100).toFixed(1) : '0.0';
      const rushJobs = wipJobs.filter(j => j.rush === 'Y' || j.Rush === 'Y');
      const agedJobs = wipJobs.filter(j => j.daysInLab > 1).length;
      const criticalAged = wipJobs.filter(j => j.daysInLab > 3).length;

      // SOM
      let somDeviceCount = 0, machineAlertCount = 0;
      try {
        const somResult = som.getDevices ? som.getDevices() : {};
        const somDevices = Array.isArray(somResult.devices) ? somResult.devices : (Array.isArray(somResult) ? somResult : []);
        somDeviceCount = somDevices.length;
        machineAlertCount = somDevices.filter(d => d.severity === 'error' || d.severity === 'warning').length;
      } catch(e) { /* SOM unavailable */ }

      const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
      const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

      // Build CSV
      const rows = [
        ['Pair Eyewear — Irvine Lens Lab — ' + title],
        ['Generated', dateStr + ' ' + timeStr],
        [''],
        ['KEY PERFORMANCE INDICATORS'],
        ['Metric', 'Value'],
        ['Total WIP', wipJobs.length],
        ['Shipped Today', shippedToday],
        ['Shipped This Week', shippedThisWeek],
        ['Rush Active', rushJobs.length],
        ['Breakage Rate', breakageRate + '%'],
        ['WIP >24h', agedJobs],
        ['Critical (>3d)', criticalAged],
        ['Machine Alerts', machineAlertCount],
        ['SOM Devices', somDeviceCount],
        [''],
        ['WIP BY STAGE'],
        ['Stage', 'Count'],
        ...stages.map(s => [s, wipByStage[s] || 0]),
        [''],
        ['SHIPPED — 14 DAY HISTORY'],
        ['Date', 'Day', 'Count'],
      ];

      // 14-day shipped history
      for (let d = 13; d >= 0; d--) {
        const dayDate = new Date(Date.now() - d * 86400000);
        const key = dayDate.toISOString().slice(0, 10);
        const label = dayDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
        let count = 0;
        for (const j of allShipped) {
          if (new Date(j.lastSeen).toISOString().slice(0, 10) === key) count++;
        }
        rows.push([key, label, count]);
      }

      // WIP detail
      rows.push(['']);
      rows.push(['WIP JOB DETAIL']);
      rows.push(['Job ID', 'Stage', 'Days In Lab', 'Rush', 'Last Seen']);
      for (const j of wipJobs) {
        rows.push([
          j.job_id || j.jobId || '',
          j.stage || '',
          (j.daysInLab || 0).toFixed(1),
          (j.rush === 'Y' || j.Rush === 'Y') ? 'Y' : 'N',
          j.lastSeen ? new Date(j.lastSeen).toISOString() : ''
        ]);
      }

      // CSV escape
      const csvContent = rows.map(row =>
        row.map(cell => {
          const s = String(cell);
          return s.includes(',') || s.includes('"') || s.includes('\n') ? '"' + s.replace(/"/g, '""') + '"' : s;
        }).join(',')
      ).join('\r\n');

      cors(res);
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="ShiftReport_${now.toISOString().slice(0,10)}.csv"`,
      });
      res.end(csvContent);
      console.log(`[Report] CSV shift report generated (${(csvContent.length/1024).toFixed(1)}KB, ${wipJobs.length} WIP jobs)`);
      return;
    } catch(e) {
      console.error('[Report] CSV report error:', e);
      return json(res, { ok:false, error: e.message }, 500);
    }
  }

  // Body: { title, content, sections, generatedBy, timestamp }
  // Returns: .docx binary stream
  if (req.method==='POST' && url.pathname==='/api/report') {
    try {
      const body = await readBody(req);
      let docxModule;
      try { docxModule = require('docx'); }
      catch(e) { return json(res,{ok:false,error:'docx package not installed. Run: npm install -g docx'},500); }

      const {
        Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
        HeadingLevel, AlignmentType, BorderStyle, WidthType, ShadingType,
        LevelFormat, Header, Footer, PageNumber, PageNumberElement
      } = docxModule;

      const title   = body.title   || 'Lab Report';
      const content = body.content || '';
      const meta    = body.meta    || {};
      const ts      = new Date(body.timestamp || Date.now());
      const dateStr = ts.toLocaleDateString('en-US',{weekday:'long',year:'numeric',month:'long',day:'numeric'});
      const timeStr = ts.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'});

      // Parse markdown-ish content into docx paragraphs
      function parseContent(text) {
        const paras = [];
        const lines = (text||'').split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) { paras.push(new Paragraph({})); continue; }
          if (trimmed.startsWith('### ')) {
            paras.push(new Paragraph({ heading: HeadingLevel.HEADING_3, children: [new TextRun({ text: trimmed.slice(4), bold: true, font: 'Arial' })] }));
          } else if (trimmed.startsWith('## ')) {
            paras.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: trimmed.slice(3), bold: true, font: 'Arial' })] }));
          } else if (trimmed.startsWith('# ')) {
            paras.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: trimmed.slice(2), bold: true, font: 'Arial' })] }));
          } else if (trimmed.startsWith('- ') || trimmed.startsWith('• ')) {
            paras.push(new Paragraph({ numbering: { reference: 'bullets', level: 0 }, children: [new TextRun({ text: trimmed.slice(2), font: 'Arial', size: 24 })] }));
          } else if (/^\d+\.\s/.test(trimmed)) {
            paras.push(new Paragraph({ numbering: { reference: 'numbers', level: 0 }, children: [new TextRun({ text: trimmed.replace(/^\d+\.\s/,''), font: 'Arial', size: 24 })] }));
          } else if (trimmed.startsWith('**') && trimmed.endsWith('**')) {
            paras.push(new Paragraph({ children: [new TextRun({ text: trimmed.slice(2,-2), bold: true, font: 'Arial', size: 24 })] }));
          } else {
            // Handle inline bold **text**
            const parts = trimmed.split(/(\*\*[^*]+\*\*)/);
            const runs = parts.map(p => p.startsWith('**') && p.endsWith('**')
              ? new TextRun({ text: p.slice(2,-2), bold: true, font: 'Arial', size: 24 })
              : new TextRun({ text: p, font: 'Arial', size: 24 }));
            paras.push(new Paragraph({ children: runs }));
          }
        }
        return paras;
      }

      const border = { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' };
      const borders = { top: border, bottom: border, left: border, right: border };

      // KPI table if meta.kpis provided
      const kpiTable = meta.kpis && meta.kpis.length > 0 ? [
        new Paragraph({ children: [new TextRun({ text: '', size: 12 })] }),
        new Table({
          width: { size: 9360, type: WidthType.DXA },
          columnWidths: Array(Math.min(meta.kpis.length, 4)).fill(Math.floor(9360/Math.min(meta.kpis.length,4))),
          rows: [
            new TableRow({ children: meta.kpis.slice(0,4).map(k => new TableCell({
              borders, width: { size: Math.floor(9360/meta.kpis.slice(0,4).length), type: WidthType.DXA },
              shading: { fill: 'D5E8F0', type: ShadingType.CLEAR },
              margins: { top: 120, bottom: 120, left: 160, right: 160 },
              children: [
                new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: k.label, size: 18, color: '555555', font: 'Arial' })] }),
                new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: k.value, size: 36, bold: true, font: 'Arial', color: '1E3A5F' })] }),
              ]
            }))}),
          ]
        }),
        new Paragraph({ children: [new TextRun({ text: '', size: 12 })] }),
      ] : [];

      const doc = new Document({
        numbering: {
          config: [
            { reference: 'bullets', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
            { reference: 'numbers', levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
          ]
        },
        styles: {
          default: { document: { run: { font: 'Arial', size: 24 } } },
          paragraphStyles: [
            { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true,
              run: { size: 36, bold: true, font: 'Arial', color: '1E3A5F' },
              paragraph: { spacing: { before: 360, after: 180 }, outlineLevel: 0 } },
            { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true,
              run: { size: 28, bold: true, font: 'Arial', color: '2E5FA3' },
              paragraph: { spacing: { before: 240, after: 120 }, outlineLevel: 1 } },
            { id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', quickFormat: true,
              run: { size: 24, bold: true, font: 'Arial', color: '444444' },
              paragraph: { spacing: { before: 180, after: 80 }, outlineLevel: 2 } },
          ]
        },
        sections: [{
          properties: {
            page: {
              size: { width: 12240, height: 15840 },
              margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 }
            }
          },
          headers: { default: new Header({ children: [
            new Paragraph({
              border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: '1E3A5F', space: 1 } },
              children: [
                new TextRun({ text: 'Pair Eyewear — Lab_Assistant  ', bold: true, font: 'Arial', size: 18, color: '1E3A5F' }),
                new TextRun({ text: title, font: 'Arial', size: 18, color: '555555' }),
                new TextRun({ text: `  |  ${dateStr}  ${timeStr}`, font: 'Arial', size: 16, color: '888888' }),
              ]
            })
          ]})},
          footers: { default: new Footer({ children: [
            new Paragraph({
              border: { top: { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC', space: 1 } },
              children: [
                new TextRun({ text: 'CONFIDENTIAL — Pair Eyewear Internal Operations  ', font: 'Arial', size: 16, color: '888888' }),
                new TextRun({ children: [PageNumber.CURRENT], font: 'Arial', size: 16, color: '888888' }),
              ]
            })
          ]})},
          children: [
            // Title block
            new Paragraph({
              children: [new TextRun({ text: title, bold: true, font: 'Arial', size: 52, color: '1E3A5F' })],
              spacing: { after: 120 }
            }),
            new Paragraph({
              border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '1E3A5F', space: 4 } },
              children: [
                new TextRun({ text: `Generated by Lab_Assistant AI  ·  ${dateStr} at ${timeStr}`, font: 'Arial', size: 20, color: '666666' }),
                ...(body.generatedBy ? [new TextRun({ text: `  ·  Requested by ${body.generatedBy}`, font: 'Arial', size: 20, color: '666666' })] : []),
              ],
              spacing: { after: 360 }
            }),

            // KPI summary table
            ...kpiTable,

            // Main content
            ...parseContent(content),

            // Footer note
            new Paragraph({ spacing: { before: 480 }, border: { top: { style: BorderStyle.SINGLE, size: 2, color: 'EEEEEE', space: 4 } },
              children: [new TextRun({ text: `Report generated automatically by Lab_Assistant AI. Data reflects real-time lab state at time of generation.`, font: 'Arial', size: 18, color: '999999', italics: true })]
            }),
          ]
        }]
      });

      const buffer = await Packer.toBuffer(doc);
      const filename = `LabReport_${title.replace(/[^a-z0-9]/gi,'_')}_${ts.toISOString().slice(0,10)}.docx`;

      cors(res);
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': buffer.length,
      });
      res.end(buffer);
      console.log(`📄 Report generated: ${filename} (${(buffer.length/1024).toFixed(1)}KB)`);
      return;

    } catch(e) {
      console.error('Report generation error:', e);
      return json(res,{ok:false,error:e.message},500);
    }
  }

  // ── Serve standalone HTML apps ──────────────────────────────
  if (req.method==='GET' && url.pathname.startsWith('/standalone/')) {
    const safeName = path.basename(url.pathname);
    if (!safeName.endsWith('.html')) { cors(res); res.writeHead(404); res.end('Not found'); return; }
    const filePath = path.join(__dirname, '..', 'standalone', safeName);
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      cors(res);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(content);
    } catch (e) {
      cors(res); res.writeHead(404); res.end('Not found');
    }
    return;
  }

  // ── Vision Scanner API ──────────────────────────────────────
  // POST /api/vision/scan — receive scanned job number from iPad LensScanner app
  // If tool_id is included, also adds the job to the container inheritance system
  if (req.method==='POST' && url.pathname==='/api/vision/scan') {
    try {
      const body = await readBody(req);
      const { jobNumber, confidence, scannedAt, device, tool_id, eye_side } = body;
      if (!jobNumber) return json(res,{success:false,message:'Missing jobNumber'},400);

      // Try to match against known DVI jobs
      const allJobs = dviTrace.getJobs();
      const match = allJobs.find(j =>
        j.job_id === jobNumber ||
        j.job_id === jobNumber.replace(/[^a-zA-Z0-9]/g, '') ||
        jobNumber.includes(j.job_id) ||
        j.job_id.includes(jobNumber)
      );

      // Log the scan
      if (!global._visionScans) global._visionScans = [];
      const scan = {
        id: Date.now(),
        jobNumber,
        confidence: confidence || 0,
        scannedAt: scannedAt || new Date().toISOString(),
        device: device || 'unknown',
        matched: !!match,
        matchedJobId: match ? match.job_id : null,
        matchedStage: match ? match.stage : null,
        matchedTray: match ? match.tray : null,
        tool_id: tool_id || null
      };
      global._visionScans.unshift(scan);
      if (global._visionScans.length > 500) global._visionScans.length = 500;

      // Container inheritance: if tool_id provided, add job to that tool's session
      let containerResult = null;
      if (tool_id) {
        try {
          // Auto-open tool session if not already open
          try { containers.openToolSession(tool_id, device || 'scanner'); } catch(e) {
            if (e.code !== 'TOOL_ALREADY_OPEN') throw e;
          }
          // Add job to tool
          containerResult = containers.addJobToTool(
            tool_id,
            jobNumber,
            eye_side || 'L',  // default to L if not specified
            confidence || null,
            'ocr'
          );
          console.log(`🔗 Container: ${jobNumber} (${eye_side||'L'}) → ${tool_id}`);
        } catch(e) {
          containerResult = { error: e.message, code: e.code };
          console.log(`🔗 Container error: ${e.message}`);
        }
      }

      console.log(`👁 Vision scan: ${jobNumber} (${Math.round((confidence||0)*100)}%) → ${match ? `MATCHED ${match.job_id} @ ${match.stage}` : 'NO MATCH'}${tool_id ? ` → ${tool_id}` : ''}`);

      return json(res, {
        success: true,
        message: match ? `Matched job ${match.job_id} — currently in ${match.stage}` : `Scan logged. No matching job found for "${jobNumber}".`,
        jobId: match ? match.job_id : null,
        trayId: match ? match.tray : null,
        stage: match ? match.stage : null,
        station: match ? match.station : null,
        operator: match ? match.operator : null,
        container: containerResult
      });
    } catch(e) { return json(res,{success:false,message:e.message},400); }
  }

  // GET /api/vision/scans — recent scan log
  if (req.method==='GET' && url.pathname==='/api/vision/scans') {
    const limit = parseInt(url.searchParams.get('limit') || '50');
    const scans = (global._visionScans || []).slice(0, limit);
    return json(res, { scans, total: (global._visionScans || []).length });
  }

  // GET /api/vision/health — vision system status
  if (req.method==='GET' && url.pathname==='/api/vision/health') {
    const scans = global._visionScans || [];
    const lastScan = scans[0] || null;
    return json(res, {
      ok: true,
      totalScans: scans.length,
      matchRate: scans.length > 0 ? Math.round(scans.filter(s => s.matched).length / scans.length * 100) : 0,
      lastScan: lastScan ? { jobNumber: lastScan.jobNumber, matched: lastScan.matched, at: lastScan.scannedAt } : null
    });
  }

  // ── Containers (Coating Pipeline Inheritance) ──────────────

  // GET /api/containers/active — all active containers grouped by type
  if (req.method==='GET' && url.pathname==='/api/containers/active') {
    try { return json(res, containers.getActiveContainers()); }
    catch(e) { return json(res, {error:e.message}, 500); }
  }

  // GET /api/containers/:id/manifest — job manifest for any container
  if (req.method==='GET' && url.pathname.match(/^\/api\/containers\/[^/]+\/manifest$/)) {
    const id = decodeURIComponent(url.pathname.split('/')[3]);
    try { return json(res, { container_id:id, ...containers.getContainerDetails(id), jobs:containers.getManifest(id) }); }
    catch(e) { return json(res, {error:e.message}, e.code==='NOT_FOUND'?404:500); }
  }

  // GET /api/containers/:id/location?job_number=X — find job in pipeline
  if (req.method==='GET' && url.pathname.match(/^\/api\/containers\/[^/]+\/location$/)) {
    const jobNumber = url.searchParams.get('job_number');
    if (!jobNumber) { return json(res, {error:'job_number required'}, 400); }
    try { return json(res, containers.getJobLocation(jobNumber)); }
    catch(e) { return json(res, {error:e.message}, e.code==='NOT_FOUND'?404:500); }
  }

  // GET /api/containers/:id — container details
  if (req.method==='GET' && url.pathname.match(/^\/api\/containers\/[^/]+$/) && !url.pathname.includes('/active')) {
    const id = decodeURIComponent(url.pathname.split('/')[3]);
    try { return json(res, containers.getContainerDetails(id)); }
    catch(e) { return json(res, {error:e.message}, e.code==='NOT_FOUND'?404:500); }
  }

  // POST /api/containers/tool-session/open
  if (req.method==='POST' && url.pathname==='/api/containers/tool-session/open') {
    const body = await readBody(req);
    try { return json(res, containers.openToolSession(body.tool_id, body.operator_id)); }
    catch(e) { return json(res, {error:e.message, code:e.code}, e.code==='TOOL_ALREADY_OPEN'?409:400); }
  }

  // POST /api/containers/tool-session/add-job
  if (req.method==='POST' && url.pathname==='/api/containers/tool-session/add-job') {
    const body = await readBody(req);
    try { return json(res, containers.addJobToTool(body.tool_id, body.job_number, body.eye_side, body.ocr_confidence, body.entry_method||'ocr')); }
    catch(e) { return json(res, {error:e.message, code:e.code}, e.code==='DUPLICATE_JOB'?409:400); }
  }

  // POST /api/containers/tool-session/close
  if (req.method==='POST' && url.pathname==='/api/containers/tool-session/close') {
    const body = await readBody(req);
    try { return json(res, containers.closeToolSession(body.tool_id)); }
    catch(e) { return json(res, {error:e.message}, 400); }
  }

  // POST /api/containers/transfer/tool-to-tray
  if (req.method==='POST' && url.pathname==='/api/containers/transfer/tool-to-tray') {
    const body = await readBody(req);
    try { return json(res, containers.transferToolsToTray(body.tray_id, body.tool_ids, body.operator_id)); }
    catch(e) { return json(res, {error:e.message, code:e.code}, 400); }
  }

  // POST /api/containers/tray/close
  if (req.method==='POST' && url.pathname==='/api/containers/tray/close') {
    const body = await readBody(req);
    try { return json(res, containers.closeTray(body.tray_id)); }
    catch(e) { return json(res, {error:e.message}, 400); }
  }

  // POST /api/containers/transfer/tray-to-batch
  if (req.method==='POST' && url.pathname==='/api/containers/transfer/tray-to-batch') {
    const body = await readBody(req);
    try { return json(res, containers.transferTraysToBatch(body.batch_id, body.tray_ids, body.machine_id, body.coating_type, body.operator_id)); }
    catch(e) { return json(res, {error:e.message, code:e.code}, 400); }
  }

  // GET /api/containers/orphaned?hours=4 — find orphaned tool sessions
  if (req.method==='GET' && url.pathname==='/api/containers/orphaned') {
    const hours = parseInt(url.searchParams.get('hours') || '4');
    try { return json(res, containers.findOrphanedSessions(hours)); }
    catch(e) { return json(res, {error:e.message}, 500); }
  }

  // ── Network (UniFi) ───────────────────────────────────────

  // GET /api/network/status — both sites summary
  if (req.method==='GET' && url.pathname==='/api/network/status') {
    return json(res, network.getStatus());
  }

  // GET /api/network/devices — device list (optional ?site=irvine1)
  if (req.method==='GET' && url.pathname==='/api/network/devices') {
    const site = url.searchParams.get('site');
    return json(res, network.getDevices(site));
  }

  // GET /api/network/clients — client counts per site/VLAN
  if (req.method==='GET' && url.pathname==='/api/network/clients') {
    const site = url.searchParams.get('site');
    return json(res, network.getClients(site));
  }

  // GET /api/network/vlans — VLAN health and utilization
  if (req.method==='GET' && url.pathname==='/api/network/vlans') {
    return json(res, network.getVlans());
  }

  // GET /api/network/events — recent events
  if (req.method==='GET' && url.pathname==='/api/network/events') {
    return json(res, network.getEvents());
  }

  // GET /api/network/alerts — active alarms + bleed violations
  if (req.method==='GET' && url.pathname==='/api/network/alerts') {
    return json(res, network.getAlerts());
  }

  // GET /api/network/health — adapter health
  if (req.method==='GET' && url.pathname==='/api/network/health') {
    return json(res, network.getHealth());
  }

  // GET /api/network/teleport — VPN session data
  if (req.method==='GET' && url.pathname==='/api/network/teleport') {
    return json(res, network.getTeleport());
  }

  // GET /api/network/wan — WAN health per site
  if (req.method==='GET' && url.pathname==='/api/network/wan') {
    return json(res, network.getWan());
  }

  // GET /api/network/switch-ports — port detail for a switch (by mac)
  if (req.method==='GET' && url.pathname==='/api/network/switch-ports') {
    const mac = url.searchParams.get('mac');
    return json(res, network.getSwitchPorts(mac));
  }

  // GET /api/network/ai-context — AI-ready summary
  if (req.method==='GET' && url.pathname==='/api/network/ai-context') {
    return json(res, network.getAIContext());
  }

  // POST /api/network/refresh — force poll
  if (req.method==='POST' && url.pathname==='/api/network/refresh') {
    await network.refresh();
    return json(res, { ok: true, health: network.getHealth() });
  }

  // ── EWS (Early Warning System) ──────────────────────────────

  // GET /api/ews/alerts — active alerts (or ?filter=all for all)
  if (req.method==='GET' && url.pathname==='/api/ews/alerts') {
    const filter = url.searchParams.get('filter') || 'active';
    return json(res, ews.getAlerts(filter));
  }

  // GET /api/ews/baselines — current baseline values
  if (req.method==='GET' && url.pathname==='/api/ews/baselines') {
    return json(res, ews.getBaselines());
  }

  // GET /api/ews/history?metric=X&limit=24 — metric reading history
  if (req.method==='GET' && url.pathname==='/api/ews/history') {
    const metric = url.searchParams.get('metric');
    const limit = parseInt(url.searchParams.get('limit') || '24');
    if (!metric) { cors(res); res.writeHead(400); res.end('{"error":"metric required"}'); return; }
    return json(res, ews.getMetricHistory(metric, limit));
  }

  // POST /api/ews/alerts/:id/ack — acknowledge alert
  if (req.method==='POST' && url.pathname.startsWith('/api/ews/alerts/') && url.pathname.endsWith('/ack')) {
    const id = decodeURIComponent(url.pathname.split('/')[4]);
    ews.acknowledge(id);
    return json(res, { ok: true, id });
  }

  // POST /api/ews/alerts/:id/resolve — resolve alert
  if (req.method==='POST' && url.pathname.startsWith('/api/ews/alerts/') && url.pathname.endsWith('/resolve')) {
    const id = decodeURIComponent(url.pathname.split('/')[4]);
    ews.resolve(id);
    return json(res, { ok: true, id });
  }

  // GET /api/ews/health — EWS engine health
  if (req.method==='GET' && url.pathname==='/api/ews/health') {
    return json(res, ews.getHealth());
  }

  // GET /api/ews/ai-context — AI-ready EWS context
  if (req.method==='GET' && url.pathname==='/api/ews/ai-context') {
    return json(res, ews.getAIContext());
  }

  // POST /api/ews/refresh — force poll
  if (req.method==='POST' && url.pathname==='/api/ews/refresh') {
    await ews.poll();
    return json(res, { ok: true, health: ews.getHealth() });
  }

  // ── 404 ─────────────────────────────────────────────────────
  cors(res);
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found', path: url.pathname }));

});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🌡  Lab_Assistant Server`);
  console.log(`   Local:   http://localhost:${PORT}`);
  console.log(`   Network: http://YOUR_IP:${PORT}`);
  console.log(`\n   📱 Phone status: http://YOUR_IP:${PORT}/status`);
  console.log(`\n   Endpoints:`);
  console.log(`     GET  /status               ← Phone-friendly live status page`);
  console.log(`     POST /api/oven-run         ← OvenTimer.html completed runs`);
  console.log(`     POST /api/oven-live        ← Heartbeat (every 6s)`);
  console.log(`     GET  /api/oven-runs        ← Dashboard history`);
  console.log(`     GET  /api/oven-live        ← Dashboard live state`);
  console.log(`     GET  /api/oven-stats       ← Dashboard KPIs`);
  console.log(`     GET  /api/inventory            ← Kardex lens blank inventory`);
  console.log(`     GET  /api/inventory/picks      ← Active pick orders`);
  console.log(`     GET  /api/inventory/alerts     ← Low stock alerts`);
  console.log(`     GET  /api/inventory/warehouses ← Warehouse breakdown (WH1, WH2, WH3)`);
  console.log(`     GET  /api/inventory/vlms       ← VLM inventory breakdown`);
  console.log(`     GET  /api/inventory/putwall   ← Put Wall positions by warehouse`);
  console.log(`     GET  /api/maintenance/assets   ← Equipment from Limble CMMS`);
  console.log(`     GET  /api/maintenance/tasks    ← Work orders & PMs`);
  console.log(`     GET  /api/maintenance/downtime ← Downtime records`);
  console.log(`     GET  /api/maintenance/stats    ← Maintenance KPIs`);
  console.log(`     GET  /api/som/devices          ← Schneider machine status`);
  console.log(`     GET  /api/som/conveyors        ← Conveyor belt positions`);
  console.log(`     GET  /api/som/orders           ← Jobs by department`);
  console.log(`     GET  /api/jobs/active          ← Active WIP: SOM + DVI cross-ref`);
  console.log(`     GET  /api/som/alerts           ← Machine/conveyor alerts`);
  console.log(`     GET  /api/dvi/jobs             ← Live WIP jobs (trace watcher)`);
  console.log(`     GET  /api/dvi/trace/status     ← Trace watcher status`);
  console.log(`     GET  /api/dvi/trace/events     ← Recent movement events`);
  console.log(`     GET  /api/dvi/trace/stats      ← Today's movement stats`);
  console.log(`     GET  /api/dvi/trace/job/:id    ← Job movement history`);
  console.log(`     GET  /api/dvi-sync/status      ← DVI file sync status`);
  console.log(`     POST /api/dvi-sync/poll        ← Force sync poll`);
  console.log(`     GET  /api/knowledge/list        ← Knowledge base documents`);
  console.log(`     GET  /api/knowledge/search      ← Search knowledge base`);
  console.log(`     POST /api/knowledge/upload      ← Upload document`);
  console.log(`     POST /api/knowledge/generate-csv← Generate CSV report`);
  console.log(`     POST /api/ai/query             ← AI query with lab context`);
  console.log(`     POST /api/slack/ai-respond     ← Process Slack AI query`);

  // Start Slack AI auto-responder polling
  startSlackAIPolling();
});

// ── Slack AI Auto-Responder ───────────────────────────────────────
let lastProcessedTs = null;
const processedMessages = new Set(); // Track processed message IDs

async function startSlackAIPolling() {
  const token = process.env.SLACK_BOT_TOKEN;
  const apiKey = process.env.VITE_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
  const channelId = process.env.SLACK_CHANNEL_ID;

  if (!token || !apiKey || !channelId) {
    console.log('[Slack AI] Disabled — missing SLACK_BOT_TOKEN, ANTHROPIC_API_KEY, or SLACK_CHANNEL_ID');
    return;
  }

  console.log('[Slack AI] Auto-responder enabled — polling every 10s for /ai queries');

  // Poll every 10 seconds
  setInterval(async () => {
    try {
      // Fetch recent messages
      const params = new URLSearchParams({ channel: channelId, limit: '10' });
      if (lastProcessedTs) params.set('oldest', lastProcessedTs);

      const slackRes = await fetch(`https://slack.com/api/conversations.history?${params}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await slackRes.json();

      if (!data.ok || !data.messages) return;

      // Process messages (newest first, so reverse to process oldest first)
      const messages = data.messages.reverse();

      for (const msg of messages) {
        // Skip if already processed, is a bot message, or doesn't have AI trigger
        if (processedMessages.has(msg.ts)) continue;
        if (msg.bot_id) continue;

        const text = msg.text || '';
        const aiMatch = text.match(/(?:\/ai|@ai|ai:)\s*(.+)/i);
        if (!aiMatch) continue;

        // Mark as processed immediately to avoid duplicates
        processedMessages.add(msg.ts);
        lastProcessedTs = msg.ts;

        const question = aiMatch[1].trim();
        console.log(`[Slack AI] Query from ${msg.user}: ${question.slice(0, 50)}...`);

        // Handle "AI?" - show available preset queries
        if (question === '?' || question.toLowerCase() === 'help') {
          const helpText = `🤖 *Lab_Assistant AI — Quick Commands*

*Reports:*
• \`/ai end of day report\` — Shift summary with KPIs
• \`/ai aging report\` — WIP aging analysis
• \`/ai yield report\` — Coating yield analysis
• \`/ai maintenance report\` — Equipment health summary

*Quick Queries:*
• \`/ai low stock\` — Critical inventory alerts
• \`/ai open work orders\` — Active maintenance tasks
• \`/ai pm schedule\` — Upcoming preventive maintenance
• \`/ai equipment status\` — Asset health overview

*Or ask any question:*
• \`/ai what blanks are running low?\`
• \`/ai any critical maintenance issues?\`
• \`/ai how many jobs in coating?\``;

          await fetch('https://slack.com/api/chat.postMessage', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              channel: channelId,
              text: helpText,
              thread_ts: msg.ts
            })
          });
          console.log('[Slack AI] Sent help menu');
          continue;
        }

        // Get AI response
        const inventoryCtx = itempath.getAIContext ? itempath.getAIContext() : {};
        const maintenanceCtx = limble.getAIContext ? limble.getAIContext() : {};

        const systemPrompt = `You are Lab_Assistant AI for an optical lens lab. Answer concisely (under 200 words). Use this live data:
INVENTORY: ${inventoryCtx.summary || 'N/A'}
MAINTENANCE: ${maintenanceCtx.summary || 'N/A'}`;

        try {
          const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
              model: 'claude-sonnet-4-20250514',
              max_tokens: 512,
              system: systemPrompt,
              messages: [{ role: 'user', content: question }]
            })
          });

          const claudeData = await claudeRes.json();
          const answer = claudeData?.content?.[0]?.text || 'Sorry, I could not process that question.';

          // Post response to Slack (in thread)
          await fetch('https://slack.com/api/chat.postMessage', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              channel: channelId,
              text: `🤖 *Lab_Assistant AI*\n${answer}`,
              thread_ts: msg.ts // Reply in thread
            })
          });

          console.log(`[Slack AI] Responded to query`);
        } catch (e) {
          console.error('[Slack AI] Error processing query:', e.message);
        }
      }

      // Cleanup old processed messages (keep last 100)
      if (processedMessages.size > 100) {
        const arr = Array.from(processedMessages);
        arr.slice(0, arr.length - 100).forEach(ts => processedMessages.delete(ts));
      }
    } catch (e) {
      // Silent fail on poll errors
    }
  }, 10000); // Poll every 10 seconds
}
