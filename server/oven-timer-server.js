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

// ── ItemPath/Kardex inventory integration ─────────────────────
const itempath = require('./itempath-adapter');
itempath.start();

// ── Limble CMMS maintenance integration ───────────────────────
const limble = require('./limble-adapter');
limble.start();

// ── SOM (Schneider) Control Center integration ────────────────
const som = require('./som-adapter');
som.start();

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
});

// ── DVI Job Index (parsed from synced XML files) ──────────────
const dviJobIndex = new Map(); // dviJob# → {coating, lens, frame, rx, ...}
const DVI_JOBS_DIR = path.join(__dirname, '..', 'data', 'dvi', 'jobs');

function parseDviXml(xml) {
  // Lightweight XML parser for DVI job files (no dependency needed)
  const get = (tag) => { const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`)); return m ? m[1].trim() : null; };
  const getAttr = (tag, attr) => { const m = xml.match(new RegExp(`<${tag}[^>]*\\s${attr}="([^"]*)"`)); return m ? m[1] : null; };

  return {
    status: getAttr('Job', 'Status'),
    date: get('Date'),
    rmtInv: get('RmtInv'),
    tray: get('Tray'),
    rxNum: get('RxNum'),
    patient: get('Patient'),
    origin: get('Origin'),
    coating: getAttr('Coat', 'Type') ? `${get('Coat')}` : get('Coat'),
    lensStyle: get('Style'),
    lensMat: get('Mat'),
    lensThick: get('Thick'),
    lensColor: get('Color'),
    frameStyle: getAttr('Frame', 'Status') ? get('Style') : null,
    frameSku: get('SKU'),
    frameMfr: get('Mfr'),
    frameColor: getAttr('Frame', 'Status') ? null : null, // parsed separately below
    eyeSize: get('EyeSize'),
    bridge: get('Bridge'),
    edge: get('Edge'),
    serviceInstruction: getAttr('Service', 'Instruction'),
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

// Load on startup and refresh every 60s
loadDviJobIndex();
setInterval(loadDviJobIndex, 60000);

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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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

// ── Request handler ───────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return; }

  // ── Health ──────────────────────────────────────────────────
  if (req.method==='GET' && url.pathname==='/health') {
    return json(res, {ok:true,service:'oven-timer-server',port:PORT,runs:runs.length,liveRacks:Object.keys(liveTimers).length});
  }

  // ── Mobile status page ──────────────────────────────────────
  if (req.method==='GET' && (url.pathname==='/status' || url.pathname==='/')) {
    return html(res, buildStatusPage());
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

  // ── ItemPath/Kardex inventory endpoints ─────────────────────
  if (req.method==='GET' && url.pathname==='/api/inventory') {
    return json(res, itempath.getInventory());
  }
  if (req.method==='GET' && url.pathname==='/api/inventory/picks') {
    return json(res, itempath.getPicks());
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
        j.lensStyle = xml.lensStyle;
        j.lensMat = xml.lensMat;
        j.frameStyle = xml.frameStyle;
        j.frameSku = xml.frameSku;
        j.rxNum = xml.rxNum;
      }
      return j;
    });

    // Add unreleased queue jobs — jobs in XML index with no trace events.
    // These are jobs sitting in DVI queues (NEL, FRMHOLD, Edits, At Kardex)
    // that haven't been released to the floor yet. They still count as WIP.
    let queueJobCount = 0;
    for (const [jobNum, xml] of dviJobIndex) {
      if (traceJobIds.has(jobNum)) continue; // already tracked by trace
      if (xml.status !== 'NEW') continue; // only count active/new jobs
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
    if (queueJobCount > 0) console.log(`[DVI-Jobs] Added ${queueJobCount} unreleased queue jobs from XML index`);

    const shipped = enriched.filter(j => j.status === 'SHIPPED');
    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    const shippedToday = shipped.filter(j => j.lastSeen && j.lastSeen >= todayStart.getTime());
    return json(res, {
      jobs: enriched,
      shipped: {
        today: shippedToday.length,
        yesterday: 0,
        thisWeek: shipped.length
      },
      stats: dviTrace.getStats(),
      source: 'dvi-trace+xml',
      jobCount: enriched.length,
      traceJobs: traceJobIds.size,
      queueJobs: queueJobCount,
      dviIndexSize: dviJobIndex.size
    });
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
        LevelFormat, Header, Footer, PageNumber
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
                new TextRun({ children: [new PageNumber()], font: 'Arial', size: 16, color: '888888' }),
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

    } catch(e) {
      console.error('Report generation error:', e);
      return json(res,{ok:false,error:e.message},500);
    }
  }


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
