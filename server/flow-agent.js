/**
 * flow-agent.js — Work Release Control System
 *
 * Models the production pipeline as a wave propagation system.
 * Predicts when each stage drains and when the next wave arrives,
 * then recommends what to push, how much, and by when.
 *
 * Two paths:
 *   Surfacing: blocking → surfacing → detray → dip_coat → oven → coating → cutting → assembly
 *   SV:        cutting → assembly
 *
 * Both converge at cutting + assembly. The agent balances SV pushes
 * (fast, bridges gaps) against surfacing pushes (slow, creates tomorrow's waves).
 *
 * USAGE in oven-timer-server.js:
 *   const flowAgent = require('./flow-agent');
 *   flowAgent.start({ dviTrace, dviJobIndex, som, itempath, timeAtLab, getOvenState, ews });
 *   // Then wire /api/flow/* endpoints
 */

'use strict';

const { db } = require('./db');

// ─── SCHEMA ────────────────────────────────────────────────────────────────

db.exec(`
  -- Stage configuration (the pipeline model)
  CREATE TABLE IF NOT EXISTS flow_stage_config (
    stage_id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    cycle_time_min REAL NOT NULL,
    cycle_time_max REAL,
    is_batch INTEGER DEFAULT 0,
    typical_batch_size INTEGER,
    feeds_stage TEXT,
    path TEXT,
    sort_order INTEGER DEFAULT 0,
    enabled INTEGER DEFAULT 1,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  -- Line config (SV path, Surfacing path, etc.)
  CREATE TABLE IF NOT EXISTS flow_line_config (
    line_id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    dvi_lens_types TEXT,
    dvi_queue_name TEXT,
    stages TEXT,
    target_daily_output INTEGER,
    sla_days REAL DEFAULT 2,
    sla_pct REAL DEFAULT 95,
    enabled INTEGER DEFAULT 1,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  -- Snapshots (every 60s, 30-day retention)
  CREATE TABLE IF NOT EXISTS flow_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stage_id TEXT NOT NULL,
    line_id TEXT,
    current_count INTEGER NOT NULL,
    drain_time_minutes REAL,
    next_wave_eta_minutes REAL,
    gap_minutes REAL,
    completion_rate REAL,
    machines_active INTEGER,
    machines_down INTEGER,
    machines_no_demand INTEGER,
    status TEXT NOT NULL,
    ts TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_flow_snap_ts ON flow_snapshots(ts);
  CREATE INDEX IF NOT EXISTS idx_flow_snap_stage ON flow_snapshots(stage_id, ts);

  -- Push recommendations (hourly output)
  CREATE TABLE IF NOT EXISTS flow_recommendations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    line_id TEXT NOT NULL,
    push_qty INTEGER NOT NULL,
    urgency TEXT NOT NULL,
    push_by TEXT,
    reason TEXT,
    available_in_queue INTEGER,
    constrained_by TEXT,
    priority_jobs TEXT,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now')),
    acknowledged_at TEXT,
    completed_at TEXT,
    operator TEXT,
    note TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_flow_rec_status ON flow_recommendations(status);

  -- Push history (audit log)
  CREATE TABLE IF NOT EXISTS flow_push_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    line_id TEXT NOT NULL,
    push_qty INTEGER NOT NULL,
    operator TEXT,
    note TEXT,
    ts TEXT DEFAULT (datetime('now'))
  );
`);

db.exec(`
  -- Persisted catch-up scenario inputs per line
  CREATE TABLE IF NOT EXISTS flow_catchup_scenario (
    line_id TEXT PRIMARY KEY,
    assemblers INTEGER,
    jobs_per_assembler_hr REAL,
    shift_hours REAL,
    shifts INTEGER,
    incoming_per_day INTEGER,
    target_days REAL,
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

// Safe migration: add expires_at column to existing databases
try { db.exec('ALTER TABLE flow_recommendations ADD COLUMN expires_at TEXT'); } catch {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_flow_rec_expires ON flow_recommendations(expires_at)'); } catch {}

// ─── DEFAULT STAGE CONFIG ──────────────────────────────────────────────────

const DEFAULT_STAGES = [
  { stage_id: 'blocking',   label: 'Blocking',       cycle_time_min: 45, cycle_time_max: 50,  is_batch: 0, typical_batch_size: null, feeds_stage: 'surfacing', path: 'surfacing', sort_order: 1 },
  { stage_id: 'surfacing',  label: 'Surfacing',      cycle_time_min: 35, cycle_time_max: 50,  is_batch: 0, typical_batch_size: null, feeds_stage: 'detray',    path: 'surfacing', sort_order: 2 },
  { stage_id: 'detray',     label: 'De-tray',        cycle_time_min: 15, cycle_time_max: 20,  is_batch: 0, typical_batch_size: null, feeds_stage: 'dip_coat',  path: 'surfacing', sort_order: 3 },
  { stage_id: 'dip_coat',   label: 'Dip Coating',    cycle_time_min: 35, cycle_time_max: 45,  is_batch: 0, typical_batch_size: null, feeds_stage: 'oven',      path: 'surfacing', sort_order: 4 },
  { stage_id: 'oven',       label: 'Oven',           cycle_time_min: 210, cycle_time_max: 240, is_batch: 1, typical_batch_size: 40,  feeds_stage: 'coating',   path: 'surfacing', sort_order: 5 },
  { stage_id: 'coating',    label: 'Coating (CCL)',   cycle_time_min: 70, cycle_time_max: 70,  is_batch: 1, typical_batch_size: 40,  feeds_stage: 'cutting',   path: 'surfacing', sort_order: 6 },
  { stage_id: 'cutting',    label: 'Cutting/Edging', cycle_time_min: 15, cycle_time_max: 30,  is_batch: 0, typical_batch_size: null, feeds_stage: 'assembly',  path: 'both',      sort_order: 7 },
  { stage_id: 'assembly',   label: 'Assembly',       cycle_time_min: 5,  cycle_time_max: 10,  is_batch: 0, typical_batch_size: null, feeds_stage: 'qc_ship',   path: 'both',      sort_order: 8 },
];

const DEFAULT_LINES = [
  { line_id: 'sv',         label: 'Single Vision',  dvi_lens_types: 'S',   dvi_queue_name: 'Single Vision',  stages: 'cutting,assembly',                                                          target_daily_output: 0, sla_days: 2, sla_pct: 95 },
  { line_id: 'surfacing',  label: 'Surfacing',      dvi_lens_types: 'P,B', dvi_queue_name: 'Semi-Finished',  stages: 'blocking,surfacing,detray,dip_coat,oven,coating,cutting,assembly',            target_daily_output: 0, sla_days: 3, sla_pct: 95 },
  { line_id: 'edits',      label: 'Edits',          dvi_lens_types: '',    dvi_queue_name: 'Edits',          stages: 'cutting,assembly',                                                          target_daily_output: 0, sla_days: 2, sla_pct: 95 },
];

// Seed defaults if empty
const stageCount = db.prepare('SELECT COUNT(*) as n FROM flow_stage_config').get().n;
if (stageCount === 0) {
  const ins = db.prepare(`INSERT OR IGNORE INTO flow_stage_config
    (stage_id, label, cycle_time_min, cycle_time_max, is_batch, typical_batch_size, feeds_stage, path, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const s of DEFAULT_STAGES) {
    ins.run(s.stage_id, s.label, s.cycle_time_min, s.cycle_time_max, s.is_batch, s.typical_batch_size, s.feeds_stage, s.path, s.sort_order);
  }
}

const lineCount = db.prepare('SELECT COUNT(*) as n FROM flow_line_config').get().n;
if (lineCount === 0) {
  const ins = db.prepare(`INSERT OR IGNORE INTO flow_line_config
    (line_id, label, dvi_lens_types, dvi_queue_name, stages, target_daily_output, sla_days, sla_pct)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const l of DEFAULT_LINES) {
    ins.run(l.line_id, l.label, l.dvi_lens_types, l.dvi_queue_name, l.stages, l.target_daily_output, l.sla_days, l.sla_pct);
  }
}

// ─── PREPARED STATEMENTS ───────────────────────────────────────────────────

const stmts = {
  getStages:    db.prepare('SELECT * FROM flow_stage_config WHERE enabled=1 ORDER BY sort_order'),
  getStage:     db.prepare('SELECT * FROM flow_stage_config WHERE stage_id=?'),
  updateStage:  db.prepare(`UPDATE flow_stage_config SET label=coalesce(?,label), cycle_time_min=coalesce(?,cycle_time_min),
    cycle_time_max=coalesce(?,cycle_time_max), is_batch=coalesce(?,is_batch), typical_batch_size=coalesce(?,typical_batch_size),
    feeds_stage=coalesce(?,feeds_stage), path=coalesce(?,path), enabled=coalesce(?,enabled),
    updated_at=datetime('now') WHERE stage_id=?`),
  getLines:     db.prepare('SELECT * FROM flow_line_config WHERE enabled=1'),
  getLine:      db.prepare('SELECT * FROM flow_line_config WHERE line_id=?'),
  updateLine:   db.prepare(`UPDATE flow_line_config SET label=coalesce(?,label), dvi_lens_types=coalesce(?,dvi_lens_types),
    dvi_queue_name=coalesce(?,dvi_queue_name), stages=coalesce(?,stages), target_daily_output=coalesce(?,target_daily_output),
    sla_days=coalesce(?,sla_days), sla_pct=coalesce(?,sla_pct), enabled=coalesce(?,enabled),
    updated_at=datetime('now') WHERE line_id=?`),
  insertSnapshot: db.prepare(`INSERT INTO flow_snapshots
    (stage_id, line_id, current_count, drain_time_minutes, next_wave_eta_minutes, gap_minutes,
     completion_rate, machines_active, machines_down, machines_no_demand, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  getSnapshots: db.prepare(`SELECT * FROM flow_snapshots WHERE ts > datetime('now', ?) ORDER BY ts DESC`),
  getStageSnapshots: db.prepare(`SELECT * FROM flow_snapshots WHERE stage_id=? AND ts > datetime('now', ?) ORDER BY ts`),
  insertRec:    db.prepare(`INSERT INTO flow_recommendations
    (line_id, push_qty, urgency, push_by, reason, available_in_queue, constrained_by, priority_jobs, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  getPendingRecs: db.prepare(`SELECT * FROM flow_recommendations WHERE status='pending' ORDER BY created_at DESC`),
  getRecentRecs:  db.prepare(`SELECT * FROM flow_recommendations WHERE created_at > datetime('now', ?) ORDER BY created_at DESC`),
  getExpiredRecs: db.prepare(`SELECT * FROM flow_recommendations WHERE status='expired' AND created_at > datetime('now', ?) ORDER BY created_at DESC`),
  expirePending:  db.prepare(`UPDATE flow_recommendations SET status='expired' WHERE status='pending' AND expires_at IS NOT NULL AND expires_at < datetime('now')`),
  ackRec:       db.prepare(`UPDATE flow_recommendations SET status='acknowledged', acknowledged_at=datetime('now'), operator=? WHERE id=?`),
  completeRec:  db.prepare(`UPDATE flow_recommendations SET status='completed', completed_at=datetime('now'), operator=coalesce(?,operator), note=? WHERE id=?`),
  saveCatchUpScenario: db.prepare(`INSERT OR REPLACE INTO flow_catchup_scenario
    (line_id, assemblers, jobs_per_assembler_hr, shift_hours, shifts, incoming_per_day, target_days, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`),
  getCatchUpScenario: db.prepare(`SELECT * FROM flow_catchup_scenario WHERE line_id=?`),
  insertPush:   db.prepare(`INSERT INTO flow_push_history (line_id, push_qty, operator, note) VALUES (?, ?, ?, ?)`),
  getPushHistory: db.prepare(`SELECT * FROM flow_push_history WHERE ts > datetime('now', ?) ORDER BY ts DESC`),
  pruneSnapshots: db.prepare(`DELETE FROM flow_snapshots WHERE ts < datetime('now', '-30 days')`),
  pruneRecs:      db.prepare(`DELETE FROM flow_recommendations WHERE created_at < datetime('now', '-30 days') AND status IN ('completed','acknowledged','expired')`),
};

// ─── STAGE → DVI TRACE STAGE MAPPING ───────────────────────────────────────
// Maps flow_stage_config stage_ids to dvi-trace.js stage values

const FLOW_TO_TRACE_STAGE = {
  blocking:   ['SURFACING'],   // blocking is the entry to surfacing zone
  surfacing:  ['SURFACING'],
  detray:     ['SURFACING'],   // detray is post-surfacing, still counted in SURFACING zone
  dip_coat:   ['COATING'],     // dip coat is pre-oven coating prep
  oven:       ['COATING'],     // oven is in coating zone
  coating:    ['COATING'],     // CCL machines in coating zone
  cutting:    ['CUTTING'],
  assembly:   ['ASSEMBLY'],
};

// ─── STATE ─────────────────────────────────────────────────────────────────

let adapters = {};      // { dviTrace, dviJobIndex, som, itempath, timeAtLab, getOvenState, ews }
let pollTimer = null;
let lastSnapshot = null;  // most recent computed snapshot
let lastRecs = [];        // most recent recommendations
let pollCount = 0;
let lastPollMs = 0;

// Rate tracking: rolling window of stage exit counts
const RATE_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours
let stageExits = {};  // stage_id → [{ts, count}]
let lastEventCounts = {}; // stage → count at last check (for delta)

// ─── CORE COMPUTE ──────────────────────────────────────────────────────────

/**
 * Classify a job into a line (sv, surfacing, edits) based on lens type
 */
function classifyJob(job, dviJobIndex) {
  const xml = dviJobIndex ? dviJobIndex.get(job.job_id) : null;
  const lensType = job.lensType || xml?.lensType || '';

  if (lensType === 'S') return 'sv';
  if (lensType === 'P' || lensType === 'B') return 'surfacing';
  // Fallback: check stage — if it's in surfacing stages, it's surfacing path
  if (['SURFACING'].includes(job.stage)) return 'surfacing';
  return 'sv'; // default to SV if unknown
}

/**
 * Map a DVI trace stage to the most specific flow stage for that job's current position.
 * For surfacing-path jobs in COATING zone, we try to distinguish oven vs coating vs dip_coat
 * using SOM device data and oven timer state.
 */
function mapToFlowStage(job, ovenState) {
  const stage = (job.stage || '').toUpperCase();
  const station = (job.station || '').toUpperCase();

  // Assembly is assembly
  if (stage === 'ASSEMBLY') return 'assembly';

  // Cutting/edging
  if (stage === 'CUTTING') return 'cutting';

  // QC/Shipping — beyond our pipeline
  if (stage === 'QC' || stage === 'SHIPPING' || stage === 'SHIPPED') return null;

  // Surfacing zone — try to narrow down
  if (stage === 'SURFACING') {
    if (station.includes('BLOCK') || station.includes('CBB') || station.includes('TAPE')) return 'blocking';
    if (station.includes('GENERATOR') || station.includes('GEN') || station.includes('HSC')) return 'surfacing';
    if (station.includes('DBA') || station.includes('DEBLOCK')) return 'detray';
    if (station.includes('POLISH') || station.includes('CCP') || station.includes('FIN')) return 'surfacing';
    return 'surfacing'; // default for surfacing zone
  }

  // Coating zone — distinguish sub-stages
  if (stage === 'COATING') {
    if (station.includes('DIP')) return 'dip_coat';
    if (station.includes('OVEN') || station.includes('CURE')) return 'oven';
    if (station.includes('CCL') || station.includes('COAT') || station.includes('DHC') || station.includes('EBC')) return 'coating';
    return 'coating'; // default for coating zone
  }

  // Incoming — not in pipeline yet
  if (stage === 'INCOMING') return null;

  return null;
}

/**
 * Count jobs per flow stage per line from DVI trace data
 */
function countJobsByStage(dviTrace, dviJobIndex, ovenState) {
  const jobs = dviTrace.getJobs();
  const activeJobs = jobs.filter(j => j.status !== 'SHIPPED' && j.stage !== 'CANCELED');

  // stage_id → { sv: count, surfacing: count, edits: count, total: count, jobs: [] }
  const counts = {};
  const stages = stmts.getStages.all();
  for (const s of stages) {
    counts[s.stage_id] = { sv: 0, surfacing: 0, edits: 0, total: 0, jobs: [] };
  }

  for (const job of activeJobs) {
    const line = classifyJob(job, dviJobIndex);
    const flowStage = mapToFlowStage(job, ovenState);
    if (!flowStage || !counts[flowStage]) continue;

    counts[flowStage][line] = (counts[flowStage][line] || 0) + 1;
    counts[flowStage].total++;
    counts[flowStage].jobs.push({
      job_id: job.job_id,
      line,
      station: job.station,
      rush: job.rush,
      daysInLab: job.daysInLab,
      firstSeen: job.firstSeen,
    });
  }

  return counts;
}

/**
 * Measure completion rates from DVI trace events (exits per stage in last 2 hours)
 */
function measureRates(dviTrace) {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  const jobs = dviTrace.getJobs();
  const rates = {}; // stage → { total: jobs/hr, sv: jobs/hr, surfacing: jobs/hr }

  // Count jobs that have exited each stage in the window
  // A job "exited" a stage when its current stage is downstream from it
  // We use stage_transitions from time-at-lab if available, or estimate from event timestamps

  const stageOrder = ['blocking', 'surfacing', 'detray', 'dip_coat', 'oven', 'coating', 'cutting', 'assembly'];

  // Use shipped + stage transitions from the last 2 hours
  try {
    const recentTransitions = db.prepare(`
      SELECT to_stage, COUNT(*) as cnt FROM stage_transitions
      WHERE transition_at > ? GROUP BY to_stage
    `).all(cutoff);

    for (const t of recentTransitions) {
      const toStage = (t.to_stage || '').toLowerCase();
      // A transition TO a stage means the upstream stage completed
      const fromIdx = stageOrder.indexOf(toStage) - 1;
      if (fromIdx >= 0) {
        const fromStage = stageOrder[fromIdx];
        if (!rates[fromStage]) rates[fromStage] = { total: 0 };
        rates[fromStage].total = (t.cnt / 2); // per hour (2-hour window)
      }
    }
  } catch (e) {
    // stage_transitions may not exist yet — fall back to estimation
  }

  // Assembly rate: use shipped count from DVI trace
  const stats = dviTrace.getStats();
  const shippedToday = stats?.byStage?.SHIPPED || 0;
  const now = new Date();
  const hoursToday = Math.max(1, now.getHours() + now.getMinutes() / 60 - 7); // hours since 7 AM
  // Assembly rate — use the known 20-25/hr rate as a floor, measured data as override
  const measuredAssemblyRate = shippedToday / hoursToday;
  rates.assembly = { total: Math.max(measuredAssemblyRate, 0) };

  // Cutting rate — typically matches or exceeds assembly (not the bottleneck)
  if (!rates.cutting) rates.cutting = { total: rates.assembly?.total || 20 };

  // For stages with no transition data, use configured cycle times
  const stages = stmts.getStages.all();
  for (const s of stages) {
    if (!rates[s.stage_id]) {
      // Estimate: 60 / avg_cycle_time = jobs per machine per hour
      const avgCycle = (s.cycle_time_min + (s.cycle_time_max || s.cycle_time_min)) / 2;
      rates[s.stage_id] = { total: 60 / avgCycle };
    }
  }

  return rates;
}

/**
 * Get machine status per stage from SOM data
 */
function getMachineStatus(som) {
  if (!som) return {};
  const deviceData = som.getDevices();
  if (!deviceData.isLive) return {};

  const result = {};
  for (const d of deviceData.devices || []) {
    const cat = d.category;
    // Map SOM categories to flow stages
    let stageId = null;
    if (cat === 'blocking') stageId = 'blocking';
    else if (cat === 'generators' || cat === 'polishing' || cat === 'fining' || cat === 'detaper') stageId = 'surfacing';
    else if (cat === 'deblocking') stageId = 'detray';
    else if (cat === 'coating' || cat === 'cleaning' || cat === 'ar_room') stageId = 'coating';
    else if (cat === 'cutters' || cat === 'edging') stageId = 'cutting';
    else if (cat === 'assembly') stageId = 'assembly';
    else continue;

    if (!result[stageId]) result[stageId] = { active: 0, down: 0, no_demand: 0, idle: 0, blocked: 0, total: 0 };
    result[stageId].total++;

    const led = d.led || {};
    const status = d.status || '';

    if (status === 'SERR') result[stageId].down++;
    else if (status === 'SIDL' && led.status === 'idle') result[stageId].no_demand++;
    else if (status === 'SIDL') result[stageId].idle++;
    else if (status === 'SBLK') result[stageId].blocked++;
    else result[stageId].active++;
  }

  return result;
}

/**
 * Get oven batch ETAs from live oven timer state
 */
function getOvenETAs(getOvenState) {
  if (!getOvenState) return [];
  const timers = getOvenState();
  if (!timers || typeof timers !== 'object') return [];

  const etas = [];
  for (const [key, timer] of Object.entries(timers)) {
    if (!timer || !timer.startedAt || !timer.targetSec) continue;
    const elapsed = (Date.now() - timer.startedAt) / 1000;
    const remaining = Math.max(0, timer.targetSec - elapsed);
    const etaMinutes = remaining / 60;
    etas.push({
      key,
      ovenId: timer.ovenId || key.split('::')[0],
      rackIndex: timer.rackIndex || key.split('::')[1],
      coating: timer.coating,
      jobs: timer.jobs || timer.jobCount || 0,
      etaMinutes,
      etaTime: new Date(Date.now() + remaining * 1000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
    });
  }
  return etas.sort((a, b) => a.etaMinutes - b.etaMinutes);
}

/**
 * Compute drain time for a stage (minutes until empty at current rate)
 */
function computeDrainMinutes(count, ratePerHour) {
  if (!count || count <= 0) return 0;
  if (!ratePerHour || ratePerHour <= 0) return Infinity;
  return (count / ratePerHour) * 60;
}

/**
 * Compute next wave arrival for a stage.
 * For batch stages (oven, coating): use oven timer ETAs.
 * For continuous stages: upstream drain time is when flow stops.
 */
function computeNextWaveETA(stageId, stageCounts, rates, ovenETAs, stageConfigs) {
  // Oven → coating: coating gets its next wave when oven releases
  if (stageId === 'coating') {
    if (ovenETAs.length > 0) return ovenETAs[0].etaMinutes;
    // If no active oven timers, estimate from oven count + rate
    const ovenCount = stageCounts.oven?.total || 0;
    const ovenRate = rates.oven?.total || (60 / 225); // ~0.27/hr per batch
    return computeDrainMinutes(ovenCount, ovenRate);
  }

  // Cutting gets two streams:
  // 1. SV: from put wall (fast, ~15 min)
  // 2. Surfaced: from coating (when coating batch releases)
  if (stageId === 'cutting') {
    // Next surfacing wave = when coating releases
    const coatingCount = stageCounts.coating?.total || 0;
    const coatingConfig = stageConfigs.find(s => s.stage_id === 'coating');
    const coatingCycle = coatingConfig ? coatingConfig.cycle_time_min : 70;
    const surfWaveETA = coatingCount > 0 ? coatingCycle : null;

    // If there are oven batches, they'll feed coating → cutting
    if (ovenETAs.length > 0) {
      const ovenETA = ovenETAs[0].etaMinutes;
      const coatingTime = coatingConfig ? coatingConfig.cycle_time_min : 70;
      return ovenETA + coatingTime; // oven → coating → cutting
    }
    return surfWaveETA;
  }

  // Assembly: fed by cutting (continuous)
  if (stageId === 'assembly') {
    const cuttingCount = stageCounts.cutting?.total || 0;
    const cuttingRate = rates.cutting?.total || 20;
    // Assembly drains when cutting drains (upstream dries up)
    // But cutting is also fed by coating waves
    return computeDrainMinutes(cuttingCount, cuttingRate);
  }

  // For surfacing-path continuous stages: upstream feeds continuously
  const config = stageConfigs.find(s => s.stage_id === stageId);
  if (!config) return null;

  // Find upstream stage
  const upstream = stageConfigs.find(s => s.feeds_stage === stageId);
  if (!upstream) return null; // no upstream = it's the entry point

  const upstreamCount = stageCounts[upstream.stage_id]?.total || 0;
  const upstreamRate = rates[upstream.stage_id]?.total || 1;
  return computeDrainMinutes(upstreamCount, upstreamRate);
}

/**
 * Determine status from gap
 */
function gapToStatus(gapMinutes) {
  if (gapMinutes === null || gapMinutes === undefined) return 'healthy';
  if (gapMinutes >= 120) return 'critical';   // 2+ hours of starvation predicted
  if (gapMinutes >= 60) return 'warning';     // 1+ hour gap
  if (gapMinutes >= 30) return 'watch';       // 30+ min gap
  return 'healthy';
}

/**
 * SLA pacing: compute how many jobs we should be pushing per hour to hit SLA targets
 */
function computeSLAPacing(dviTrace, dviJobIndex, timeAtLab) {
  const pacing = {};

  // Get at-risk jobs from time-at-lab
  let atRisk = [];
  try {
    atRisk = timeAtLab?.getAtRisk() || [];
  } catch {}

  // Count active WIP by line
  const jobs = dviTrace.getJobs();
  const active = jobs.filter(j => j.status !== 'SHIPPED' && j.stage !== 'CANCELED');

  let svCount = 0, surfCount = 0;
  for (const j of active) {
    const line = classifyJob(j, dviJobIndex);
    if (line === 'sv') svCount++;
    else if (line === 'surfacing') surfCount++;
  }

  // Get today's shipped count
  const stats = dviTrace.getStats();
  const shipped = stats?.byStage?.SHIPPED || 0;
  const now = new Date();
  const hoursWorked = Math.max(1, now.getHours() + now.getMinutes() / 60 - 7);
  const hoursRemaining = Math.max(0.5, 17 - (now.getHours() + now.getMinutes() / 60)); // until 5 PM

  // SV: 2-day SLA, 95% → need to output ~50% of SV WIP per day
  // Surfacing: 3-day SLA, 95% → need to output ~33% of surf WIP per day
  const svDailyTarget = Math.ceil(svCount * 0.5);
  const surfDailyTarget = Math.ceil(surfCount * 0.33);

  pacing.sv = {
    wip: svCount,
    dailyTarget: svDailyTarget,
    hourlyTarget: Math.ceil(svDailyTarget / 8), // 8-hour shift
    shippedToday: shipped, // total shipped (both lines)
    atRiskCount: atRisk.filter(j => classifyJob(j, dviJobIndex) === 'sv').length,
    hoursRemaining,
  };

  pacing.surfacing = {
    wip: surfCount,
    dailyTarget: surfDailyTarget,
    hourlyTarget: Math.ceil(surfDailyTarget / 8),
    atRiskCount: atRisk.filter(j => classifyJob(j, dviJobIndex) === 'surfacing').length,
    hoursRemaining,
  };

  return pacing;
}

/**
 * Get stock constraints from ItemPath
 */
function getStockConstraints(itempath) {
  if (!itempath) return { constrained: false };
  try {
    const inv = itempath.getInventory();
    const alerts = inv.alerts || [];
    const critical = alerts.filter(a => a.severity === 'CRITICAL');
    return {
      constrained: critical.length > 0,
      criticalStockouts: critical.map(a => a.material || a.sku || a.description).slice(0, 5),
      totalAlerts: alerts.length,
    };
  } catch {
    return { constrained: false };
  }
}

/**
 * Compute expiration timestamp from push_by string.
 * 'NOW' → 30 min from now. '2:00 PM' → that time today (or +30 min if already past).
 */
function computeExpiresAt(pushBy, urgency) {
  const now = new Date();
  if (urgency === 'now' || pushBy === 'NOW') {
    return new Date(now.getTime() + 30 * 60 * 1000).toISOString();
  }
  // Parse "2:00 PM" style times
  try {
    const match = pushBy.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (match) {
      let hours = parseInt(match[1]);
      const minutes = parseInt(match[2]);
      const ampm = match[3].toUpperCase();
      if (ampm === 'PM' && hours < 12) hours += 12;
      if (ampm === 'AM' && hours === 12) hours = 0;
      const target = new Date(now);
      target.setHours(hours, minutes, 0, 0);
      // If target is already past, expire in 30 min instead
      if (target <= now) return new Date(now.getTime() + 30 * 60 * 1000).toISOString();
      return target.toISOString();
    }
  } catch {}
  // Default: expire in 60 min
  return new Date(now.getTime() + 60 * 60 * 1000).toISOString();
}

/**
 * Generate push recommendations based on gap analysis + SLA pacing
 */
function generateRecommendations(stageCounts, rates, ovenETAs, machineStatus, slaPacing, stockConstraints, stageConfigs) {
  const recs = [];
  const now = new Date();

  // --- Assembly gap analysis ---
  const assemblyCount = stageCounts.assembly?.total || 0;
  const assemblyRate = rates.assembly?.total || 22; // 20-25/hr default
  const assemblyDrainMin = computeDrainMinutes(assemblyCount, assemblyRate);

  // Cutting feeds assembly
  const cuttingCount = stageCounts.cutting?.total || 0;
  const cuttingRate = rates.cutting?.total || 25;
  const cuttingDrainMin = computeDrainMinutes(cuttingCount, cuttingRate);

  // Combined: assembly runs out of work when both assembly buffer + cutting buffer drain
  const combinedDrainMin = assemblyDrainMin + computeDrainMinutes(cuttingCount, cuttingRate) * (assemblyRate / cuttingRate);

  // Next coating wave
  const nextCoatingWave = ovenETAs.length > 0
    ? ovenETAs[0].etaMinutes + 70 // oven release + coating cycle → cutting
    : null;

  // Gap at assembly/cutting
  const gapAtCutting = nextCoatingWave !== null
    ? (nextCoatingWave - cuttingDrainMin)
    : null;

  // SV push to bridge gaps
  if (cuttingDrainMin < 60 || assemblyDrainMin < 60) {
    // How many SV jobs to push to bridge until coating wave?
    let bridgeHours = 2; // default: keep 2 hours of buffer
    if (nextCoatingWave !== null) {
      bridgeHours = Math.max(0, (nextCoatingWave - Math.min(cuttingDrainMin, assemblyDrainMin)) / 60);
    }
    const svPush = Math.ceil(bridgeHours * cuttingRate);
    if (svPush > 0) {
      const drainTime = new Date(now.getTime() + Math.min(cuttingDrainMin, assemblyDrainMin) * 60000);
      const urgency = Math.min(cuttingDrainMin, assemblyDrainMin) < 30 ? 'now' : 'by_time';
      const pushBy = urgency === 'now' ? 'NOW' :
        drainTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

      const feedHours = Math.round((75 / assemblyRate) * 10) / 10;
      let reason = '';
      if (cuttingDrainMin < assemblyDrainMin) {
        reason = `Cutting drains at ${drainTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
      } else {
        reason = `Assembly drains at ${drainTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
      }
      reason += ` — 75 SV keeps assembly busy ~${feedHours}h at ${Math.round(assemblyRate)}/hr`;
      if (nextCoatingWave !== null) {
        const waveTime = new Date(now.getTime() + nextCoatingWave * 60000);
        reason += `, coating wave at ${waveTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
      }

      const constraint = stockConstraints.constrained ? 'stock' : 'none';

      recs.push({
        line_id: 'sv',
        push_qty: 75, // put wall = 75 positions, always push a full wall
        urgency,
        push_by: pushBy,
        expires_at: computeExpiresAt(pushBy, urgency),
        reason,
        constrained_by: constraint,
      });
    }
  }

  // Surfacing push for tomorrow's coating feed
  const surfacingCount = (stageCounts.blocking?.total || 0) + (stageCounts.surfacing?.total || 0) +
    (stageCounts.detray?.total || 0) + (stageCounts.dip_coat?.total || 0);
  const ovenCount = stageCounts.oven?.total || 0;
  const coatingCount = stageCounts.coating?.total || 0;

  // If surfacing pipeline is getting thin, push more
  const totalSurfPipeline = surfacingCount + ovenCount + coatingCount;
  const surfPacing = slaPacing.surfacing || {};

  if (totalSurfPipeline < (surfPacing.dailyTarget || 40)) {
    const deficit = (surfPacing.dailyTarget || 40) - totalSurfPipeline;
    if (deficit > 5) {
      recs.push({
        line_id: 'surfacing',
        push_qty: 75, // put wall = 75 positions, always push a full wall
        urgency: 'by_time',
        push_by: '2:00 PM',
        expires_at: computeExpiresAt('2:00 PM', 'by_time'),
        reason: `Surfacing pipeline thin (${totalSurfPipeline} jobs) — needs feed for tomorrow's coating`,
        constrained_by: stockConstraints.constrained ? 'stock' : 'none',
      });
    }
  }

  return recs;
}

/**
 * Catch-up calculator: pure what-if planning tool.
 *
 * LIVE DATA (read-only, from DVI trace):
 *   - Current WIP by line
 *   - Incoming jobs/day (new jobs entering lab today, extrapolated)
 *
 * USER INPUTS (all scenario fields — the knobs to turn):
 *   - assemblers: number of assembly people
 *   - jobsPerAssemblerHr: output per person per hour
 *   - shiftHours: hours per shift
 *   - shifts: shifts per day
 *   - incomingPerDay: override incoming if desired
 *   - targetDays: "I want to clear in N days"
 *
 * CALCULATED from inputs:
 *   - Output per day, net per day, days to clear
 *   - Required ship/day and assemblers to hit target
 */
function computeCatchUp(lineId, scenario = {}) {
  const line = stmts.getLine.get(lineId);
  if (!line) return null;

  // ── Load saved scenario as defaults, merge with any new inputs ──
  const saved = stmts.getCatchUpScenario.get(lineId);
  if (saved) {
    // Saved values become defaults — scenario overrides take precedence
    if (scenario.assemblers == null && saved.assemblers != null) scenario.assemblers = saved.assemblers;
    if (scenario.jobsPerAssemblerHr == null && saved.jobs_per_assembler_hr != null) scenario.jobsPerAssemblerHr = saved.jobs_per_assembler_hr;
    if (scenario.shiftHours == null && saved.shift_hours != null) scenario.shiftHours = saved.shift_hours;
    if (scenario.shifts == null && saved.shifts != null) scenario.shifts = saved.shifts;
    if (scenario.incomingPerDay == null && saved.incoming_per_day != null) scenario.incomingPerDay = saved.incoming_per_day;
    if (scenario.targetDays == null && saved.target_days != null) scenario.targetDays = saved.target_days;
  }

  // ── LIVE DATA: Current WIP from DVI trace ──
  const { dviTrace, dviJobIndex } = adapters;
  let totalWip = 0;
  let svWip = 0, surfWip = 0;
  if (dviTrace) {
    const allJobs = dviTrace.getJobs();
    const active = allJobs.filter(j =>
      j.status !== 'SHIPPED' && j.stage !== 'CANCELED' &&
      j.stage !== 'SHIPPED' && j.status !== 'CANCELED'
    );
    for (const j of active) {
      const jobLine = classifyJob(j, dviJobIndex);
      if (jobLine === 'sv') svWip++;
      else if (jobLine === 'surfacing') surfWip++;
    }
  }
  if (lineId === 'sv') totalWip = svWip;
  else if (lineId === 'surfacing') totalWip = surfWip;
  else totalWip = svWip + surfWip;

  // ── LIVE DATA: Incoming jobs/day from DVI trace ──
  let liveIncomingPerDay = 0;
  try {
    if (dviTrace) {
      const allJobs = dviTrace.getJobs();
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayMs = todayStart.getTime();
      const newToday = allJobs.filter(j => j.firstSeen && j.firstSeen >= todayMs).length;
      const now = new Date();
      const hoursWorked = Math.max(1, now.getHours() + now.getMinutes() / 60 - 7);
      if (hoursWorked >= 1 && newToday > 0) {
        liveIncomingPerDay = Math.round((newToday / hoursWorked) * 16); // assume 16hr day for extrapolation
      }
    }
  } catch {}

  // ── USER INPUTS (with defaults) ──
  const assemblers = scenario.assemblers ?? 6;
  const jobsPerAssemblerHr = scenario.jobsPerAssemblerHr ?? 4;
  const shiftHours = scenario.shiftHours ?? 8;
  const shifts = scenario.shifts ?? 2;
  const incomingPerDay = scenario.incomingPerDay ?? liveIncomingPerDay;
  const targetDays = scenario.targetDays ?? (line.sla_days || 2);

  // ── CALCULATIONS ──
  const hoursPerDay = shiftHours * shifts;
  const outputPerHr = assemblers * jobsPerAssemblerHr;
  const outputPerDay = outputPerHr * hoursPerDay;
  const netPerDay = outputPerDay - incomingPerDay;
  const daysToClear = netPerDay > 0 ? Math.round((totalWip / netPerDay) * 10) / 10 : null;

  // To clear in targetDays: how much do we need to ship per day?
  const requiredPerDay = Math.ceil((totalWip / Math.max(1, targetDays)) + incomingPerDay);
  const requiredPerHr = Math.round((requiredPerDay / Math.max(1, hoursPerDay)) * 10) / 10;
  const requiredAssemblers = Math.ceil(requiredPerHr / Math.max(1, jobsPerAssemblerHr));

  // Weekly milestones — show projected WIP at end of each week
  // Also show daily ship target for that week
  const milestones = [1, 2, 3, 4, 5].map(w => {
    const projWip = Math.max(0, Math.round(totalWip - (netPerDay * 5 * w)));
    // If clearing faster than target, show "cleared" status
    const daysToClearFromHere = netPerDay > 0 ? Math.round(projWip / netPerDay) : null;
    return {
      week: w,
      projectedWip: projWip,
      shipPerDay: Math.round(outputPerDay),
      daysToClearRemaining: daysToClearFromHere,
      cleared: projWip === 0,
    };
  });

  // Persist scenario inputs for next load
  stmts.saveCatchUpScenario.run(lineId, assemblers, jobsPerAssemblerHr, shiftHours, shifts, incomingPerDay, targetDays);

  return {
    line_id: lineId,
    label: line.label,
    // Live data
    currentWip: totalWip,
    liveIncomingPerDay,
    // User inputs (echoed back so UI stays in sync)
    assemblers,
    jobsPerAssemblerHr,
    shiftHours,
    shifts,
    incomingPerDay: Math.round(incomingPerDay),
    targetDays,
    // Calculated
    hoursPerDay,
    outputPerHr: Math.round(outputPerHr * 10) / 10,
    outputPerDay: Math.round(outputPerDay),
    netPerDay: Math.round(netPerDay),
    daysToClear,
    // What's needed to hit target
    requiredPerDay,
    requiredPerHr,
    requiredAssemblers,
    slaDays: line.sla_days,
    weeklyMilestones: milestones,
  };
}

// ─── MAIN POLL CYCLE ───────────────────────────────────────────────────────

function poll() {
  const t0 = Date.now();
  try {
    const { dviTrace, dviJobIndex, som, itempath, timeAtLab, getOvenState } = adapters;
    if (!dviTrace) return; // not started yet

    const stageConfigs = stmts.getStages.all();
    const ovenState = getOvenState ? getOvenState() : {};
    const ovenETAs = getOvenETAs(getOvenState);
    const stageCounts = countJobsByStage(dviTrace, dviJobIndex, ovenState);
    const rates = measureRates(dviTrace);
    const machineStatus = getMachineStatus(som);
    const slaPacing = computeSLAPacing(dviTrace, dviJobIndex, timeAtLab);
    const stockConstraints = getStockConstraints(itempath);

    // Compute drain + gap per stage
    const stageSnapshots = [];
    for (const config of stageConfigs) {
      const count = stageCounts[config.stage_id]?.total || 0;
      const rate = rates[config.stage_id]?.total || 0;
      const drainMin = computeDrainMinutes(count, rate);
      const nextWaveETA = computeNextWaveETA(config.stage_id, stageCounts, rates, ovenETAs, stageConfigs);
      const gapMin = (nextWaveETA !== null && drainMin !== Infinity)
        ? nextWaveETA - drainMin
        : null;
      const ms = machineStatus[config.stage_id] || {};
      const status = gapToStatus(gapMin);

      const snap = {
        stage_id: config.stage_id,
        label: config.label,
        current_count: count,
        drain_time_minutes: drainMin === Infinity ? null : Math.round(drainMin),
        next_wave_eta_minutes: nextWaveETA !== null ? Math.round(nextWaveETA) : null,
        gap_minutes: gapMin !== null ? Math.round(gapMin) : null,
        completion_rate: Math.round(rate * 10) / 10,
        machines_active: ms.active || 0,
        machines_down: ms.down || 0,
        machines_no_demand: ms.no_demand || 0,
        status,
        // Extra fields not persisted but available in snapshot
        by_line: {
          sv: stageCounts[config.stage_id]?.sv || 0,
          surfacing: stageCounts[config.stage_id]?.surfacing || 0,
          edits: stageCounts[config.stage_id]?.edits || 0,
        },
        machines: ms,
      };

      stageSnapshots.push(snap);

      // Persist to SQLite
      stmts.insertSnapshot.run(
        snap.stage_id, null, snap.current_count, snap.drain_time_minutes,
        snap.next_wave_eta_minutes, snap.gap_minutes, snap.completion_rate,
        snap.machines_active, snap.machines_down, snap.machines_no_demand, snap.status
      );
    }

    // Expire stale pending recommendations whose push_by time has passed
    const expired = stmts.expirePending.run();
    if (expired.changes > 0) {
      console.log(`[Flow] Expired ${expired.changes} unacknowledged recommendation(s)`);
    }

    // Generate recommendations (throttled: only if last rec is >30 min old)
    const lastRecTime = db.prepare(`SELECT MAX(created_at) as t FROM flow_recommendations`).get()?.t;
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    let recs = [];
    if (!lastRecTime || lastRecTime < thirtyMinAgo) {
      recs = generateRecommendations(stageCounts, rates, ovenETAs, machineStatus, slaPacing, stockConstraints, stageConfigs);
      for (const r of recs) {
        stmts.insertRec.run(
          r.line_id, r.push_qty, r.urgency, r.push_by,
          r.reason, r.available_in_queue || null, r.constrained_by || 'none',
          r.priority_jobs ? JSON.stringify(r.priority_jobs) : null,
          r.expires_at || null
        );
      }
    }

    // Build last snapshot
    lastSnapshot = {
      ts: new Date().toISOString(),
      stages: stageSnapshots,
      ovenETAs,
      rates,
      machineStatus,
      slaPacing,
      stockConstraints,
      recommendations: recs.length > 0 ? recs : (stmts.getPendingRecs.all() || []),
    };
    lastRecs = lastSnapshot.recommendations;

    // Feed EWS
    feedEWS(stageSnapshots);

    // Periodic cleanup
    pollCount++;
    if (pollCount % 60 === 0) { // every ~60 minutes
      stmts.pruneSnapshots.run();
      stmts.pruneRecs.run();
    }

    lastPollMs = Date.now() - t0;
    if (pollCount <= 3 || pollCount % 10 === 0) {
      const stageSum = stageSnapshots.map(s => `${s.stage_id}:${s.current_count}`).join(' ');
      console.log(`[Flow] Poll #${pollCount} (${lastPollMs}ms) — ${stageSum}`);
    }
  } catch (err) {
    console.error('[Flow] Poll error:', err.message);
  }
}

// ─── EWS FEED ──────────────────────────────────────────────────────────────

let ewsRegistered = false;

function feedEWS(stageSnapshots) {
  const { ews } = adapters;
  if (!ews || ewsRegistered) return;

  // Register the collector once — it will be polled by EWS on its own schedule
  ewsRegistered = true;
  ews.registerCollector('flow_pipeline', async () => {
    if (!lastSnapshot) return [];
    const readings = [];
    for (const snap of lastSnapshot.stages) {
      // Gap metric (HIGH_BAD: positive gap = stage will starve)
      if (snap.gap_minutes !== null) {
        readings.push({
          metric: `flow_gap_${snap.stage_id}`,
          system: 'Flow',
          value: snap.gap_minutes,
          unit: 'minutes',
        });
      }
      // Drain metric (LOW_BAD: low drain time = stage about to empty)
      if (snap.drain_time_minutes !== null) {
        readings.push({
          metric: `flow_drain_${snap.stage_id}`,
          system: 'Flow',
          value: snap.drain_time_minutes,
          unit: 'minutes',
        });
      }
    }
    return readings;
  });
}

// ─── PUBLIC API ────────────────────────────────────────────────────────────

module.exports = {
  /**
   * Start the flow agent polling cycle.
   * @param {object} deps — { dviTrace, dviJobIndex, som, itempath, timeAtLab, getOvenState, ews }
   */
  start(deps) {
    adapters = deps;
    console.log('[Flow] Starting flow agent (60s poll)');

    // Initial poll after 5s to let adapters warm up
    setTimeout(() => {
      poll();
      pollTimer = setInterval(poll, 60000);
    }, 5000);
  },

  stop() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    console.log('[Flow] Stopped');
  },

  // ── Snapshot ──

  getSnapshot() {
    if (!lastSnapshot) return { ts: null, stages: [], ovenETAs: [], recommendations: [] };
    return lastSnapshot;
  },

  getStageDetail(stageId) {
    const config = stmts.getStage.get(stageId);
    if (!config) return null;
    const snap = lastSnapshot?.stages?.find(s => s.stage_id === stageId);
    const recent = stmts.getStageSnapshots.all(stageId, '-8 hours');
    return { config, current: snap || null, trend: recent };
  },

  getLineDetail(lineId) {
    const line = stmts.getLine.get(lineId);
    if (!line) return null;
    const stageIds = (line.stages || '').split(',').filter(Boolean);
    const stages = stageIds.map(id => {
      const snap = lastSnapshot?.stages?.find(s => s.stage_id === id);
      return snap || { stage_id: id, current_count: 0 };
    });
    const pacing = lastSnapshot?.slaPacing?.[lineId] || null;
    return { line, stages, pacing };
  },

  getLineTrend(lineId, hours = 8) {
    const line = stmts.getLine.get(lineId);
    if (!line) return null;
    const stageIds = (line.stages || '').split(',').filter(Boolean);
    const interval = `-${hours} hours`;
    const trends = {};
    for (const id of stageIds) {
      trends[id] = stmts.getStageSnapshots.all(id, interval);
    }
    return { line_id: lineId, hours, trends };
  },

  // ── Recommendations ──

  getRecommendations(status) {
    if (status === 'pending') return stmts.getPendingRecs.all();
    if (status === 'expired') return stmts.getExpiredRecs.all('-24 hours');
    return stmts.getRecentRecs.all('-24 hours');
  },

  acknowledgeRec(id, operator) {
    stmts.ackRec.run(operator, id);
    return { ok: true };
  },

  completeRec(id, operator, note, actualQty) {
    stmts.completeRec.run(operator, note, id);
    if (actualQty) {
      // Also log to push history
      const rec = db.prepare('SELECT * FROM flow_recommendations WHERE id=?').get(id);
      if (rec) {
        stmts.insertPush.run(rec.line_id, actualQty, operator, note);
      }
    }
    return { ok: true };
  },

  // ── Push History ──

  logPush(lineId, qty, operator, note) {
    stmts.insertPush.run(lineId, qty, operator, note);
    return { ok: true };
  },

  getPushHistory(hours = 24) {
    return stmts.getPushHistory.all(`-${hours} hours`);
  },

  // ── Config ──

  getStageConfigs() {
    return stmts.getStages.all();
  },

  updateStageConfig(stageId, updates) {
    stmts.updateStage.run(
      updates.label || null, updates.cycle_time_min || null,
      updates.cycle_time_max || null, updates.is_batch ?? null,
      updates.typical_batch_size || null, updates.feeds_stage || null,
      updates.path || null, updates.enabled ?? null, stageId
    );
    return stmts.getStage.get(stageId);
  },

  getLineConfigs() {
    return stmts.getLines.all();
  },

  updateLineConfig(lineId, updates) {
    stmts.updateLine.run(
      updates.label || null, updates.dvi_lens_types || null,
      updates.dvi_queue_name || null, updates.stages || null,
      updates.target_daily_output || null, updates.sla_days || null,
      updates.sla_pct || null, updates.enabled ?? null, lineId
    );
    return stmts.getLine.get(lineId);
  },

  // ── Catch-up ──

  getCatchUp(lineId, scenario) {
    return computeCatchUp(lineId, scenario);
  },

  // ── Health ──

  getHealth() {
    return {
      running: !!pollTimer,
      pollCount,
      lastPollMs,
      lastSnapshot: lastSnapshot?.ts || null,
      pendingRecs: stmts.getPendingRecs.all().length,
    };
  },

  // ── AI Context ──

  getAIContext() {
    if (!lastSnapshot) return { status: 'not_started', message: 'Flow agent has not completed first poll yet' };

    const snap = lastSnapshot;
    const lines = [];
    for (const stage of snap.stages) {
      lines.push(`${stage.label}: ${stage.current_count} jobs, drains in ${stage.drain_time_minutes ?? '?'}min, ` +
        `rate ${stage.completion_rate}/hr, status=${stage.status}` +
        (stage.gap_minutes !== null ? `, gap=${stage.gap_minutes}min` : ''));
    }

    const recLines = (snap.recommendations || []).map(r =>
      `${r.urgency === 'now' ? '🚨' : '📋'} ${r.line_id}: push ${r.push_qty} ${r.urgency === 'now' ? 'NOW' : `by ${r.push_by}`} — ${r.reason}`
    );

    const ovenLines = snap.ovenETAs.map(e =>
      `Oven ${e.ovenId} rack ${e.rackIndex}: ${e.jobs} jobs, ${e.coating || '?'}, ETA ${e.etaTime} (${Math.round(e.etaMinutes)}min)`
    );

    return {
      status: 'running',
      lastPoll: snap.ts,
      pipeline: lines.join('\n'),
      recommendations: recLines.join('\n') || 'No pending recommendations',
      ovenETAs: ovenLines.join('\n') || 'No active oven timers',
      slaPacing: snap.slaPacing,
      stockConstraints: snap.stockConstraints,
    };
  },
};
