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
    target_backlog INTEGER,
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);
try { db.exec('ALTER TABLE flow_catchup_scenario ADD COLUMN target_backlog INTEGER'); } catch {}
try { db.exec("ALTER TABLE flow_catchup_scenario ADD COLUMN work_days TEXT DEFAULT '[1,2,3,4,5]'"); } catch {}

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
  expirePending:  db.prepare(`UPDATE flow_recommendations SET status='expired' WHERE status='pending' AND (
    (expires_at IS NOT NULL AND expires_at < datetime('now')) OR
    (expires_at IS NULL AND created_at < datetime('now', '-60 minutes'))
  )`),
  ackRec:       db.prepare(`UPDATE flow_recommendations SET status='acknowledged', acknowledged_at=datetime('now'), operator=? WHERE id=?`),
  completeRec:  db.prepare(`UPDATE flow_recommendations SET status='completed', completed_at=datetime('now'), operator=coalesce(?,operator), note=? WHERE id=?`),
  saveCatchUpScenario: db.prepare(`INSERT OR REPLACE INTO flow_catchup_scenario
    (line_id, assemblers, jobs_per_assembler_hr, shift_hours, shifts, incoming_per_day, target_days, target_backlog, work_days, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`),
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
 * Generate the put-then-pick plan — WAREHOUSE AWARE.
 *
 * WH1 = Carousels 1,2,3 + Put Wall 1 (75 positions)
 * WH2 = Carousels 4,5,6 + Put Wall 2 (75 positions)
 *
 * No mirroring — each job is assigned to ONE warehouse.
 * The put list tells operators which warehouse to stock,
 * and jobs are routed to the warehouse with the best stock match.
 *
 * Put-then-pick cycles are per-warehouse, sized to put wall capacity (75).
 */
function computePutList() {
  const { dviTrace, dviJobIndex, itempath } = adapters;
  if (!dviTrace || !dviJobIndex) return null;

  const PUT_WALL_SIZE = 75;
  const PUT_MINUTES_PER_LENS = 2;
  const PICK_MINUTES_PER_JOB = 1.5; // 3 picks × 0.5 min

  const allJobs = dviTrace.getJobs();

  // Get per-warehouse stock: { WH1: { sku: qty }, WH2: { sku: qty } }
  let whStock = { WH1: {}, WH2: {}, WH3: {} };
  try {
    if (itempath?.getWarehouseStock) whStock = itempath.getWarehouseStock();
  } catch (e) { console.error('[PutList] getWarehouseStock error:', e.message); }
  const wh1Stock = whStock.WH1 || {};
  const wh2Stock = whStock.WH2 || {};
  console.log(`[PutList] WH stock: WH1=${Object.keys(wh1Stock).length} SKUs, WH2=${Object.keys(wh2Stock).length} SKUs`);

  // Also get full materials list for metadata (name, coatingType)
  const inv = itempath ? itempath.getInventory() : { materials: [] };
  const allMaterials = inv.materials || [];
  const matMeta = {};
  for (const m of allMaterials) {
    if (m.sku) matMeta[m.sku] = { name: m.name, coatingType: m.coatingType, warehouse: m.warehouse };
  }

  // 1. Load discontinued/deprecated SKUs — skip these entirely
  const discontinuedSkus = new Set();
  try {
    const disc = db.prepare("SELECT sku FROM lens_sku_params WHERE abc_class = 'X'").all();
    for (const r of disc) discontinuedSkus.add(r.sku);
  } catch {}
  // Also check lens_catalog for deprecated OPCs
  try {
    const dep = db.prepare("SELECT opc FROM lens_catalog WHERE valid_to IS NOT NULL").all();
    for (const r of dep) discontinuedSkus.add(r.opc);
  } catch {}

  // Get demand jobs — INCOMING + DVI production queues only
  // NOT AT_KARDEX (already reserved) and NOT NEL (handled elsewhere)
  // These are jobs we need to PUT lenses for before they reach the Kardex
  const demandStages = ['INCOMING'];
  // Also include jobs in DVI surfacing/SV queues that haven't been picked yet
  const queueStages = ['SURFACING', 'COATING', 'CUTTING', 'ASSEMBLY'];
  const demandJobs = allJobs.filter(j => {
    if (j.status === 'SHIPPED' || j.status === 'CANCELED') return false;
    if (j.stage === 'AT_KARDEX' || j.stage === 'NEL') return false; // already reserved / handled elsewhere
    if (j.stage === 'SHIPPED' || j.stage === 'SHIPPING') return false;
    return demandStages.includes(j.stage);
  });

  // 2. For each job, check stock per warehouse and assign to the best one
  const assignments = { WH1: [], WH2: [] };
  const putNeeded = { WH1: {}, WH2: {} }; // sku → qty to put
  let totalLensesNeeded = 0, totalInStock = 0, totalShortfall = 0;

  let skippedDiscontinued = 0;
  const dviDiscontinuedAlerts = {}; // OPCs DVI is sending that we've marked discontinued
  for (const j of demandJobs) {
    const xml = dviJobIndex.get(j.job_id);
    if (!xml) continue;

    let opc = xml.lensOpc || null;

    // If OPC is discontinued on our side but DVI is still routing to it — flag it
    let replacedFrom = null;
    if (opc && discontinuedSkus.has(opc)) {
      replacedFrom = opc;
      skippedDiscontinued++;
      // Track for alert
      if (!dviDiscontinuedAlerts[opc]) dviDiscontinuedAlerts[opc] = { opc, coating: xml.coating, material: xml.lensMat, jobCount: 0, firstSeen: j.job_id };
      dviDiscontinuedAlerts[opc].jobCount++;
      // Search for active SKU with same material in stock
      const mat = (xml.lensMat || '').toUpperCase();
      let bestAlt = null, bestQty = 0;
      for (const m of (inv.materials || [])) {
        if (m.qty <= 0 || !m.sku || discontinuedSkus.has(m.sku)) continue;
        if (mat && (m.name || '').toUpperCase().includes(mat)) {
          if (m.qty > bestQty) { bestAlt = m.sku; bestQty = m.qty; }
        }
      }
      opc = bestAlt; // use the replacement, or null if nothing found
    }

    const coating = xml.coating || 'Unknown';
    const material = xml.lensMat || 'Unknown';
    const style = xml.lensStyle || '';
    const lensType = xml.lensType || 'S';
    const line = lensType === 'S' ? 'sv' : 'surfacing';
    const rush = j.rush === 'Y' || xml.rush === 'Y';
    const lensesNeeded = 2; // R + L
    totalLensesNeeded += lensesNeeded;

    // Check stock in each warehouse for this OPC
    const wh1Qty = opc ? (wh1Stock[opc] || 0) : 0;
    const wh2Qty = opc ? (wh2Stock[opc] || 0) : 0;
    const totalQty = wh1Qty + wh2Qty;

    if (totalQty >= lensesNeeded) totalInStock += lensesNeeded;
    else { totalInStock += totalQty; totalShortfall += (lensesNeeded - totalQty); }

    // Assign to warehouse: prefer the one with more stock of this OPC,
    // break ties by balancing job count between warehouses
    let assignedWh;
    if (wh1Qty >= lensesNeeded && wh2Qty < lensesNeeded) {
      assignedWh = 'WH1';
    } else if (wh2Qty >= lensesNeeded && wh1Qty < lensesNeeded) {
      assignedWh = 'WH2';
    } else if (wh1Qty >= lensesNeeded && wh2Qty >= lensesNeeded) {
      // Both have stock — balance by current assignment count
      assignedWh = assignments.WH1.length <= assignments.WH2.length ? 'WH1' : 'WH2';
    } else {
      // Neither has enough — assign to the one with fewer jobs (balance load)
      assignedWh = assignments.WH1.length <= assignments.WH2.length ? 'WH1' : 'WH2';
      // Track what needs to be put
      if (opc) {
        const whQty = assignedWh === 'WH1' ? wh1Qty : wh2Qty;
        const deficit = Math.max(0, lensesNeeded - whQty);
        if (deficit > 0) {
          putNeeded[assignedWh][opc] = (putNeeded[assignedWh][opc] || 0) + deficit;
        }
      }
    }

    assignments[assignedWh].push({
      jobId: j.job_id, stage: j.stage, line, coating, material, style, opc,
      lensesNeeded, rush, daysInLab: j.daysInLab || 0,
      stockInWh: assignedWh === 'WH1' ? wh1Qty : wh2Qty,
      replacedFrom, // original discontinued OPC, null if no replacement needed
    });
  }

  // 3. Identify out-of-stock OPCs — zero across ALL warehouses
  const outOfStock = {};  // opc → { opc, coating, material, style, lensType, jobCount, lensesNeeded, rushCount }
  for (const j of demandJobs) {
    const xml = dviJobIndex.get(j.job_id);
    if (!xml) continue;
    let opc = xml.lensOpc || null;
    if (!opc) continue;
    // For discontinued OPCs, check stock of the original — if 0, it's truly out of stock
    // (replacement would have been handled in the assignment loop above)
    if (discontinuedSkus.has(opc)) opc = null; // don't check stock for deprecated OPC
    if (!opc) continue;
    const totalAcrossWh = (wh1Stock[opc] || 0) + (wh2Stock[opc] || 0) + ((whStock.WH3 || {})[opc] || 0);
    if (totalAcrossWh <= 0) {
      if (!outOfStock[opc]) {
        outOfStock[opc] = {
          opc, coating: xml.coating || 'Unknown', material: xml.lensMat || 'Unknown',
          style: xml.lensStyle || '', lensType: xml.lensType || 'S',
          jobCount: 0, lensesNeeded: 0, rushCount: 0,
          // For surfacing jobs, suggest looking for same-material alternatives
          canSubstitute: xml.lensType !== 'S', // surfacing can use different base
          action: xml.lensType === 'S' ? 'REORDER' : 'FIND ALTERNATIVE OR REORDER',
        };
      }
      outOfStock[opc].jobCount++;
      outOfStock[opc].lensesNeeded += 2;
      if (j.rush === 'Y' || xml.rush === 'Y') outOfStock[opc].rushCount++;
    }
  }

  // For substitutable OPCs (surfacing), find same-material alternatives in stock
  for (const oos of Object.values(outOfStock)) {
    if (!oos.canSubstitute) continue;
    const mat = oos.material.toUpperCase();
    const alts = [];
    for (const m of allMaterials) {
      if (m.qty <= 0 || m.sku === oos.opc) continue;
      const mMat = (m.coatingType || '').toUpperCase();
      // Same material family match
      if (mat && (m.name || '').toUpperCase().includes(mat)) {
        alts.push({ sku: m.sku, name: m.name, qty: m.qty, warehouse: m.warehouse });
      }
    }
    if (alts.length > 0) {
      alts.sort((a, b) => b.qty - a.qty);
      oos.alternatives = alts.slice(0, 5);
      oos.action = `SUBSTITUTE: ${alts[0].sku} (${alts[0].qty} in ${alts[0].warehouse})`;
    }
  }

  const outOfStockList = Object.values(outOfStock).sort((a, b) => {
    if (a.rushCount > 0 && b.rushCount === 0) return -1;
    if (a.rushCount === 0 && b.rushCount > 0) return 1;
    return b.jobCount - a.jobCount;
  });

  // 4. Build per-warehouse put list and pick batches
  function buildWarehousePlan(wh, jobs, puts) {
    // Sort jobs: rush first, then NEL, then by daysInLab desc
    jobs.sort((a, b) => {
      if (a.rush && !b.rush) return -1;
      if (!a.rush && b.rush) return 1;
      if (a.stage === 'NEL' && b.stage !== 'NEL') return -1;
      if (a.stage !== 'NEL' && b.stage === 'NEL') return 1;
      return b.daysInLab - a.daysInLab;
    });

    // Build put items list
    const putItems = [];
    for (const [sku, qty] of Object.entries(puts)) {
      const meta = matMeta[sku] || {};
      putItems.push({
        opc: sku, coating: meta.coatingType || 'Unknown', name: meta.name || sku,
        putQty: qty, warehouse: wh,
      });
    }
    putItems.sort((a, b) => b.putQty - a.putQty);

    const totalPutLenses = putItems.reduce((s, p) => s + p.putQty, 0);
    const totalJobs = jobs.length;

    // Build put-then-pick cycles, sized to put wall (75 jobs per wall)
    const cycles = [];
    let jobIdx = 0;
    let putIdx = 0;
    let putRemaining = putItems.map(p => ({ ...p })); // clone
    let cycleNum = 1;

    while (jobIdx < jobs.length || putRemaining.some(p => p.putQty > 0)) {
      // PUT phase — enough to fill next batch of picks
      let putMinutes = 0;
      const putBatch = [];
      const putTarget = 30; // 30 min put phase
      for (let i = 0; i < putRemaining.length && putMinutes < putTarget; i++) {
        const p = putRemaining[i];
        if (p.putQty <= 0) continue;
        const qty = Math.min(p.putQty, Math.floor((putTarget - putMinutes) / PUT_MINUTES_PER_LENS));
        if (qty <= 0) continue;
        putBatch.push({ opc: p.opc, coating: p.coating, name: p.name, putQty: qty });
        putMinutes += qty * PUT_MINUTES_PER_LENS;
        p.putQty -= qty;
      }
      putRemaining = putRemaining.filter(p => p.putQty > 0);

      // PICK phase — up to put wall size (75 jobs)
      const pickBatch = [];
      let pickMinutes = 0;
      const pickLimit = PUT_WALL_SIZE;
      while (jobIdx < jobs.length && pickBatch.length < pickLimit) {
        pickBatch.push(jobs[jobIdx]);
        pickMinutes += PICK_MINUTES_PER_JOB;
        jobIdx++;
      }

      if (putBatch.length === 0 && pickBatch.length === 0) break;

      // Aggregate pick batch by coating for display
      const pickByCoating = {};
      for (const j of pickBatch) {
        const k = j.coating || 'Unknown';
        if (!pickByCoating[k]) pickByCoating[k] = { coating: k, jobs: 0, rush: 0 };
        pickByCoating[k].jobs++;
        if (j.rush) pickByCoating[k].rush++;
      }

      cycles.push({
        cycle: cycleNum++,
        putPhase: {
          items: putBatch,
          totalLenses: putBatch.reduce((s, p) => s + p.putQty, 0),
          estimatedMinutes: Math.round(putMinutes),
        },
        pickPhase: {
          jobs: pickBatch.length,
          byCoating: Object.values(pickByCoating),
          rushCount: pickBatch.filter(j => j.rush).length,
          estimatedMinutes: Math.round(pickMinutes),
        },
        totalMinutes: Math.round(putMinutes + pickMinutes),
      });

      if (cycleNum > 20) break;
    }

    // Aggregate by coating + material for summary
    const byCoating = {};
    for (const j of jobs) {
      const k = `${j.coating}|${j.material}`;
      if (!byCoating[k]) byCoating[k] = { coating: j.coating, material: j.material, jobs: 0, lenses: 0, rush: 0 };
      byCoating[k].jobs++;
      byCoating[k].lenses += 2;
      if (j.rush) byCoating[k].rush++;
    }

    return {
      warehouse: wh,
      carousels: wh === 'WH1' ? '1, 2, 3' : '4, 5, 6',
      putWall: wh === 'WH1' ? 'Put Wall 1' : 'Put Wall 2',
      putWallSize: PUT_WALL_SIZE,
      totalJobs: jobs.length,
      totalLenses: jobs.length * 2,
      svJobs: jobs.filter(j => j.line === 'sv').length,
      surfJobs: jobs.filter(j => j.line === 'surfacing').length,
      rushJobs: jobs.filter(j => j.rush).length,
      nelJobs: jobs.filter(j => j.stage === 'NEL').length,
      putItems,
      totalPutLenses,
      byCoating: Object.values(byCoating).sort((a, b) => b.jobs - a.jobs),
      cycles,
      totalMinutes: cycles.reduce((s, c) => s + c.totalMinutes, 0),
      wallLoads: Math.ceil(jobs.length / PUT_WALL_SIZE),
    };
  }

  console.log(`[PutList] Assigned: WH1=${assignments.WH1.length} jobs, WH2=${assignments.WH2.length} jobs, demandJobs=${demandJobs.length}`);
  const wh1Plan = buildWarehousePlan('WH1', assignments.WH1, putNeeded.WH1);
  const wh2Plan = buildWarehousePlan('WH2', assignments.WH2, putNeeded.WH2);

  const nelJobs = demandJobs.filter(j => j.stage === 'NEL');

  return {
    summary: {
      totalDemandJobs: demandJobs.length,
      totalLensesNeeded,
      totalInStock,
      totalShortfall,
      nelCount: nelJobs.length,
      fulfillablePct: totalLensesNeeded > 0 ? Math.round((totalInStock / totalLensesNeeded) * 100) : 100,
      wh1Jobs: wh1Plan.totalJobs,
      wh2Jobs: wh2Plan.totalJobs,
      outOfStockCount: outOfStockList.length,
      outOfStockJobs: outOfStockList.reduce((s, o) => s + o.jobCount, 0),
      discontinuedReplaced: skippedDiscontinued,
      dviDiscontinuedAlerts: Object.values(dviDiscontinuedAlerts).length,
    },
    warehouses: [wh1Plan, wh2Plan],
    outOfStock: outOfStockList.slice(0, 50),
    dviDiscontinuedAlerts: Object.values(dviDiscontinuedAlerts).sort((a, b) => b.jobCount - a.jobCount),
    totalEstimatedMinutes: wh1Plan.totalMinutes + wh2Plan.totalMinutes,
    totalEstimatedHours: Math.round((wh1Plan.totalMinutes + wh2Plan.totalMinutes) / 60 * 10) / 10,
  };
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

  // SV push to bridge gaps — sized for TODAY only, not multi-day
  if (cuttingDrainMin < 60 || assemblyDrainMin < 60) {
    // How many hours left in today's shift?
    const shiftEndHour = 17; // 5 PM
    const hoursLeftInShift = Math.max(1, shiftEndHour - now.getHours() - now.getMinutes() / 60);

    // Bridge until next coating wave or end of shift, whichever is sooner
    let bridgeHours = Math.min(hoursLeftInShift, 4); // max 4 hours at a time
    if (nextCoatingWave !== null) {
      const gapHours = Math.max(0, (nextCoatingWave - Math.min(cuttingDrainMin, assemblyDrainMin)) / 60);
      bridgeHours = Math.min(bridgeHours, gapHours);
    }
    bridgeHours = Math.max(1, bridgeHours); // at least 1 hour

    const svPushRaw = Math.ceil(bridgeHours * assemblyRate);
    // Round up to nearest 75 (full put wall), minimum 75, max 3 walls (225) per push
    const svPush = Math.min(225, Math.max(75, Math.ceil(svPushRaw / 75) * 75));
    const walls = svPush / 75;
    const drainTime = new Date(now.getTime() + Math.min(cuttingDrainMin, assemblyDrainMin) * 60000);
    const urgency = Math.min(cuttingDrainMin, assemblyDrainMin) < 30 ? 'now' : 'by_time';
    const pushBy = urgency === 'now' ? 'NOW' :
      drainTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

    const feedHours = Math.round((svPush / assemblyRate) * 10) / 10;
    let reason = '';
    if (cuttingDrainMin < assemblyDrainMin) {
      reason = `Cutting drains at ${drainTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
    } else {
      reason = `Assembly drains at ${drainTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
    }
    reason += ` — ${svPush} SV (${walls} wall${walls>1?'s':''}) keeps assembly busy ~${feedHours}h at ${Math.round(assemblyRate)}/hr`;
    if (nextCoatingWave !== null) {
      const waveTime = new Date(now.getTime() + nextCoatingWave * 60000);
      reason += `, coating wave at ${waveTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
    }

    const constraint = stockConstraints.constrained ? 'stock' : 'none';

    recs.push({
      line_id: 'sv',
      push_qty: svPush,
      urgency,
      push_by: pushBy,
      expires_at: computeExpiresAt(pushBy, urgency),
      reason,
      constrained_by: constraint,
    });
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
      // Size to deficit, rounded up to full walls, minimum 75
      const surfPush = Math.max(75, Math.ceil(deficit / 75) * 75);
      const surfWalls = surfPush / 75;
      const surfDeadline = new Date(now.getTime() + 60 * 60 * 1000);
      const surfPushBy = surfDeadline.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      recs.push({
        line_id: 'surfacing',
        push_qty: surfPush,
        urgency: 'by_time',
        push_by: surfPushBy,
        expires_at: computeExpiresAt(surfPushBy, 'by_time'),
        reason: `Surfacing pipeline thin (${totalSurfPipeline} jobs, need ${surfPacing.dailyTarget || 40}) — ${surfPush} jobs (${surfWalls} wall${surfWalls>1?'s':''}) for tomorrow's coating`,
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
  // "all" = combined SV + surfacing
  const isAll = lineId === 'all';
  const line = isAll ? { line_id: 'all', label: 'All Jobs', sla_days: 2, stages: '' } : stmts.getLine.get(lineId);
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
    if (scenario.targetBacklog == null && saved.target_backlog != null) scenario.targetBacklog = saved.target_backlog;
    if (scenario.workDays == null && saved.work_days != null) {
      try { scenario.workDays = JSON.parse(saved.work_days); } catch {}
    }
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
  if (isAll) totalWip = svWip + surfWip;
  else if (lineId === 'sv') totalWip = svWip;
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
  const targetBacklog = scenario.targetBacklog ?? 500;
  // Work days: 0=Sun, 1=Mon, ..., 6=Sat. Default Mon-Fri
  const workDays = scenario.workDays ?? [1, 2, 3, 4, 5];

  // ── CALCULATIONS ──
  const hoursPerDay = shiftHours * shifts;
  const outputPerHr = assemblers * jobsPerAssemblerHr;
  const outputPerDay = outputPerHr * hoursPerDay; // output on a WORK day
  const workDaysPerWeek = workDays.length;
  const offDaysPerWeek = 7 - workDaysPerWeek;

  // Incoming only arrives on work days (DVI doesn't send orders on weekends)
  // Net per work day = output - incoming
  // Off days: nothing in, nothing out (lab is closed)
  // Net per week = workDays × (output - incoming)
  const netPerWorkDay = outputPerDay - incomingPerDay;
  const netPerWeek = workDaysPerWeek * netPerWorkDay;
  const netPerCalendarDay = netPerWeek / 7; // average for calendar projection

  // How much WIP needs to be burned down to reach target backlog
  const wipToClear = Math.max(0, totalWip - targetBacklog);

  // Days to clear in calendar days (includes weekends)
  const daysToClear = netPerWorkDay > 0 && wipToClear > 0
    ? Math.round((wipToClear / netPerCalendarDay) * 10) / 10
    : netPerWorkDay > 0 ? 0 : null;

  // To clear in targetDays WORK days: how much do we need to ship per work day?
  //
  // Steady-state: just to keep up with incoming on work days
  //   steady = incomingPerDay
  // Burn-down: clear the backlog over targetDays work days
  //   burn = wipToClear / targetDays
  // Total required per work day = steady + burn
  const steadyStatePerWorkDay = Math.round(incomingPerDay * 10) / 10;
  const burnDownPerWorkDay = targetDays > 0 ? Math.round((wipToClear / targetDays) * 10) / 10 : 0;
  const requiredPerWorkDay = Math.ceil(steadyStatePerWorkDay + burnDownPerWorkDay);
  const requiredPerHr = Math.round((requiredPerWorkDay / Math.max(1, hoursPerDay)) * 10) / 10;
  const requiredAssemblers = Math.ceil(requiredPerHr / Math.max(1, jobsPerAssemblerHr));

  // Weekly milestones — day-by-day projection for 5 weeks
  // Track actual calendar days, applying work/off logic
  const milestones = [];
  const today = new Date();
  let projWip = totalWip;
  for (let w = 1; w <= 5; w++) {
    // Simulate 7 days for this week
    for (let d = 0; d < 7; d++) {
      const calDay = (w - 1) * 7 + d;
      const date = new Date(today);
      date.setDate(date.getDate() + calDay);
      const dow = date.getDay(); // 0=Sun ... 6=Sat
      if (workDays.includes(dow)) {
        // Work day: ship output, receive incoming
        projWip = projWip - outputPerDay + incomingPerDay;
      }
      // Off day: lab closed, no output, no incoming
      projWip = Math.max(0, projWip);
    }
    milestones.push({
      week: w,
      projectedWip: Math.round(projWip),
      atTarget: projWip <= targetBacklog,
    });
  }

  // Persist scenario inputs for next load
  stmts.saveCatchUpScenario.run(lineId, assemblers, jobsPerAssemblerHr, shiftHours, shifts, incomingPerDay, targetDays, targetBacklog, JSON.stringify(workDays));

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
    targetBacklog,
    workDays,
    wipToClear,
    // Calculated
    hoursPerDay,
    workDaysPerWeek,
    offDaysPerWeek,
    outputPerHr: Math.round(outputPerHr * 10) / 10,
    outputPerDay: Math.round(outputPerDay),
    netPerWeek: Math.round(netPerWeek),
    daysToClear, // calendar days including weekends
    // What's needed to hit target (per WORK day)
    steadyStatePerWorkDay,  // just to keep up with incoming
    burnDownPerWorkDay,     // extra on top to clear the backlog
    requiredPerWorkDay,     // total = steady + burn
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

    // Expire ALL pending recs — each cycle generates fresh ones with current times
    const expireAll = db.prepare(`UPDATE flow_recommendations SET status='expired' WHERE status='pending'`);
    const expired = expireAll.run();
    if (expired.changes > 0) {
      console.log(`[Flow] Expired ${expired.changes} stale recommendation(s)`);
    }

    // Generate fresh recommendations every cycle with current timestamps
    const recs = generateRecommendations(stageCounts, rates, ovenETAs, machineStatus, slaPacing, stockConstraints, stageConfigs);
    for (const r of recs) {
      stmts.insertRec.run(
        r.line_id, r.push_qty, r.urgency, r.push_by,
        r.reason, r.available_in_queue || null, r.constrained_by || 'none',
        r.priority_jobs ? JSON.stringify(r.priority_jobs) : null,
        r.expires_at || null
      );
    }

    // Build last snapshot
    // Compute put list (every 5th poll to avoid overhead — ~5 min refresh)
    let putListSnapshot = null;
    if (pollCount % 5 === 0 || pollCount <= 1) {
      try { putListSnapshot = computePutList(); } catch (e) { console.error('[Flow] Put list error:', e.message); }
    }

    lastSnapshot = {
      ts: new Date().toISOString(),
      stages: stageSnapshots,
      ovenETAs,
      rates,
      machineStatus,
      slaPacing,
      stockConstraints,
      recommendations: stmts.getPendingRecs.all() || [],
      putList: putListSnapshot || (lastSnapshot?.putList || null),
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

  // ── Put List ──

  getPutList() {
    try {
      return computePutList();
    } catch (e) {
      console.error('[PutList] computePutList crashed:', e.message, e.stack?.split('\n').slice(0,3).join('\n'));
      return null;
    }
  },

  // ── Readiness Dashboard — what can we process NOW vs what's blocked ──

  getReadiness() {
    try {
      const { dviTrace, dviJobIndex, itempath } = adapters;
      if (!dviTrace || !dviJobIndex) return null;

      const allJobs = dviTrace.getJobs();
      const active = allJobs.filter(j =>
        j.status !== 'SHIPPED' && j.status !== 'CANCELED' &&
        j.stage !== 'SHIPPED' && j.stage !== 'SHIPPING' && j.stage !== 'CANCELED'
      );

      // Get stock by OPC across all warehouses
      let whStock = { WH1: {}, WH2: {}, WH3: {} };
      try { if (itempath?.getWarehouseStock) whStock = itempath.getWarehouseStock(); } catch {}
      const totalStock = {}; // opc → total qty
      for (const wh of ['WH1', 'WH2', 'WH3']) {
        for (const [sku, qty] of Object.entries(whStock[wh] || {})) {
          totalStock[sku] = (totalStock[sku] || 0) + qty;
        }
      }

      // Get materials for alternative suggestions
      const inv = itempath ? itempath.getInventory() : { materials: [] };
      const stockByMaterial = {};
      for (const m of (inv.materials || [])) {
        if (!m.sku || m.qty <= 0) continue;
        const matKeys = ['PLY', 'BLY', 'H67', 'B67', 'CR39', 'TRV', 'S67'];
        for (const mat of matKeys) {
          if ((m.coatingType || '').toUpperCase().includes(mat) || (m.name || '').toUpperCase().includes(mat)) {
            if (!stockByMaterial[mat]) stockByMaterial[mat] = [];
            stockByMaterial[mat].push({ sku: m.sku, qty: m.qty, warehouse: m.warehouse });
          }
        }
      }
      for (const arr of Object.values(stockByMaterial)) arr.sort((a, b) => b.qty - a.qty);

      // Classify every active job
      const inProcess = [];     // already past Kardex — in production
      const readyToProcess = []; // at INCOMING/AT_KARDEX and we have lenses
      const needAlternative = []; // out of stock but surfacing — can substitute
      const trueOutOfStock = []; // out of stock, SV or no alternatives
      const nelJobs = [];        // currently stuck at NEL

      const pastKardexStages = ['SURFACING', 'COATING', 'CUTTING', 'ASSEMBLY', 'QC', 'HOLD', 'BREAKAGE'];
      const prePickStages = ['INCOMING', 'AT_KARDEX', 'NEL'];

      for (const j of active) {
        const xml = dviJobIndex.get(j.job_id);
        const opc = xml?.lensOpc || null;
        const coating = xml?.coating || 'Unknown';
        const material = xml?.lensMat || 'Unknown';
        const lensType = xml?.lensType || 'S';
        const isSurfacing = lensType !== 'S';
        const rush = j.rush === 'Y' || xml?.rush === 'Y';

        const jobInfo = {
          jobId: j.job_id, stage: j.stage, opc, coating, material, lensType,
          isSurfacing, rush, daysInLab: j.daysInLab || 0,
        };

        // Already in production — past the Kardex
        if (pastKardexStages.includes(j.stage)) {
          inProcess.push(jobInfo);
          continue;
        }

        // NEL — stuck
        if (j.stage === 'NEL') {
          nelJobs.push(jobInfo);
          // Check if we can suggest alternatives
          const matKey = material.toUpperCase();
          if (isSurfacing && stockByMaterial[matKey]?.length > 0) {
            const alt = stockByMaterial[matKey].find(a => a.sku !== opc);
            if (alt) {
              jobInfo.alternative = { sku: alt.sku, qty: alt.qty, warehouse: alt.warehouse };
              needAlternative.push(jobInfo);
            } else {
              trueOutOfStock.push(jobInfo);
            }
          } else {
            trueOutOfStock.push(jobInfo);
          }
          continue;
        }

        // Pre-pick (INCOMING, AT_KARDEX) — check if we have stock
        if (prePickStages.includes(j.stage)) {
          const stockQty = opc ? (totalStock[opc] || 0) : 0;
          if (stockQty >= 2) {
            readyToProcess.push(jobInfo);
          } else if (isSurfacing) {
            const matKey = material.toUpperCase();
            const alt = stockByMaterial[matKey]?.find(a => a.sku !== opc && a.qty >= 2);
            if (alt) {
              jobInfo.alternative = { sku: alt.sku, qty: alt.qty, warehouse: alt.warehouse };
              needAlternative.push(jobInfo);
            } else {
              trueOutOfStock.push(jobInfo);
            }
          } else {
            trueOutOfStock.push(jobInfo);
          }
          continue;
        }

        // Everything else
        inProcess.push(jobInfo);
      }

      const totalWip = active.length;
      const processableNow = inProcess.length + readyToProcess.length;

      return {
        totalWip,
        inProcess: inProcess.length,
        readyToProcess: readyToProcess.length,
        needAlternative: needAlternative.length,
        trueOutOfStock: trueOutOfStock.length,
        nelCount: nelJobs.length,
        processableNow,
        processablePct: totalWip > 0 ? Math.round((processableNow / totalWip) * 100) : 100,
        blockedTotal: needAlternative.length + trueOutOfStock.length,
        // Breakdown for display
        readyJobs: { sv: readyToProcess.filter(j => !j.isSurfacing).length, surf: readyToProcess.filter(j => j.isSurfacing).length },
        alternativeJobs: needAlternative.slice(0, 50),
        outOfStockJobs: trueOutOfStock.slice(0, 50),
        rushBlocked: [...needAlternative, ...trueOutOfStock].filter(j => j.rush).length,
        // Top out-of-stock OPCs for reorder
        reorderList: (() => {
          const byOpc = {};
          for (const j of trueOutOfStock) {
            if (!j.opc) continue;
            if (!byOpc[j.opc]) byOpc[j.opc] = { opc: j.opc, coating: j.coating, material: j.material, jobs: 0, rush: 0 };
            byOpc[j.opc].jobs++;
            if (j.rush) byOpc[j.opc].rush++;
          }
          return Object.values(byOpc).sort((a, b) => b.jobs - a.jobs).slice(0, 30);
        })(),
      };
    } catch (e) {
      console.error('[Readiness] Error:', e.message);
      return null;
    }
  },

  // ── NEL (Not Enough Lenses) — stuck jobs with alternative suggestions ──

  getNelAnalysis() {
    try {
      const { dviTrace, dviJobIndex, itempath } = adapters;
      if (!dviTrace || !dviJobIndex) return null;

      const allJobs = dviTrace.getJobs();
      const nelJobs = allJobs.filter(j => j.stage === 'NEL' && j.status !== 'SHIPPED' && j.status !== 'CANCELED');

      const inv = itempath ? itempath.getInventory() : { materials: [] };
      const materials = inv.materials || [];

      // Build stock lookup by material type
      const stockByMaterial = {}; // material → [{ sku, qty, name, warehouse, coatingType }]
      for (const m of materials) {
        if (!m.sku || m.qty <= 0) continue;
        const ct = (m.coatingType || '').toUpperCase();
        // Group by broad material category
        for (const mat of ['PLY', 'BLY', 'H67', 'B67', 'CR39', 'TRV', 'S67']) {
          if (ct.includes(mat) || (m.name || '').toUpperCase().includes(mat)) {
            if (!stockByMaterial[mat]) stockByMaterial[mat] = [];
            stockByMaterial[mat].push({ sku: m.sku, qty: m.qty, name: m.name, warehouse: m.warehouse, coatingType: m.coatingType });
          }
        }
      }
      // Sort each material group by qty descending
      for (const arr of Object.values(stockByMaterial)) arr.sort((a, b) => b.qty - a.qty);

      const results = [];
      for (const j of nelJobs) {
        const xml = dviJobIndex.get(j.job_id);
        if (!xml) continue;

        const opc = xml.lensOpc || null;
        const coating = xml.coating || 'Unknown';
        const material = xml.lensMat || 'Unknown';
        const style = xml.lensStyle || '';
        const lensType = xml.lensType || 'S';
        const isSurfacing = lensType !== 'S';
        const rush = j.rush === 'Y' || xml.rush === 'Y';

        // Find alternatives — same material blanks in stock
        const matKey = material.toUpperCase();
        const alternatives = [];
        if (isSurfacing && stockByMaterial[matKey]) {
          for (const alt of stockByMaterial[matKey].slice(0, 5)) {
            if (alt.sku === opc) continue; // same SKU, skip
            alternatives.push(alt);
          }
        }

        results.push({
          jobId: j.job_id,
          opc,
          coating,
          material,
          style,
          lensType,
          isSurfacing,
          rush,
          daysInLab: j.daysInLab || 0,
          station: j.station || '',
          alternatives,
          action: !isSurfacing ? 'REORDER (SV — no substitution)'
            : alternatives.length > 0 ? `CHANGE BASE: ${alternatives[0].sku} (${alternatives[0].qty} avail${alternatives[0].warehouse ? ' in ' + alternatives[0].warehouse : ''})`
            : 'NO ALTERNATIVES FOUND — REORDER',
        });
      }

      // Sort: rush first, then surfacing (actionable), then SV, then by daysInLab
      results.sort((a, b) => {
        if (a.rush && !b.rush) return -1;
        if (!a.rush && b.rush) return 1;
        if (a.isSurfacing && !b.isSurfacing) return -1;
        if (!a.isSurfacing && b.isSurfacing) return 1;
        return b.daysInLab - a.daysInLab;
      });

      const svCount = results.filter(r => !r.isSurfacing).length;
      const surfCount = results.filter(r => r.isSurfacing).length;
      const withAlts = results.filter(r => r.alternatives.length > 0).length;

      return {
        total: results.length,
        svCount,
        surfCount,
        withAlternatives: withAlts,
        noAlternatives: results.length - withAlts - svCount,
        rushCount: results.filter(r => r.rush).length,
        jobs: results,
      };
    } catch (e) {
      console.error('[NEL] Analysis error:', e.message);
      return null;
    }
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

  // ── Historical Flow Analysis ──

  /**
   * Aggregate stage transitions into hourly buckets per stage per day.
   * Returns data for heatmaps and daily timelines.
   * @param {number} days — how many days back (default 7)
   */
  getHistory(days = 7) {
    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
    const cutoffISO = new Date(cutoff).toISOString();
    const stages = ['PICKING', 'INCOMING', 'SURFACING', 'COATING', 'CUTTING', 'ASSEMBLY', 'SHIPPING'];

    // Query stage transitions + picks_history (Kardex picks)
    const rows = db.prepare(`
      SELECT job_id, to_stage, transition_at FROM stage_transitions
      WHERE transition_at > ? ORDER BY transition_at
    `).all(cutoff);

    // Add picking data from picks_history (Kardex lens blank picks)
    // completed_at is SQLite datetime format: 'YYYY-MM-DD HH:MM:SS'
    const cutoffSqlite = new Date(cutoff).toISOString().replace('T', ' ').slice(0, 19);
    const pickRows = db.prepare(`
      SELECT id, pick_id, completed_at FROM picks_history
      WHERE completed_at > ? ORDER BY completed_at
    `).all(cutoffSqlite);
    for (const p of pickRows) {
      if (!p.completed_at) continue;
      // Parse 'YYYY-MM-DD HH:MM:SS' — add T and Z for reliable parsing
      const ts = new Date(p.completed_at.replace(' ', 'T') + 'Z').getTime();
      if (!isNaN(ts) && ts > cutoff) {
        rows.push({ job_id: p.pick_id || `pick-${p.id}`, to_stage: 'PICKING', transition_at: ts });
      }
    }

    // Count UNIQUE JOBS per date|hour|stage (not duplicate scan events)
    const bucketSets = {};  // key: "date|hour|stage" → Set of job_ids
    const dailySets = {};   // key: "date|stage" → Set of job_ids
    const dates = new Set();

    for (const row of rows) {
      const d = new Date(row.transition_at);
      const date = d.toISOString().split('T')[0];
      const hour = d.getHours();
      const stage = (row.to_stage || '').toUpperCase();
      if (!stages.includes(stage)) continue;

      const key = `${date}|${hour}|${stage}`;
      if (!bucketSets[key]) bucketSets[key] = new Set();
      bucketSets[key].add(row.job_id);

      const dayKey = `${date}|${stage}`;
      if (!dailySets[dayKey]) dailySets[dayKey] = new Set();
      dailySets[dayKey].add(row.job_id);

      dates.add(date);
    }

    // Convert sets to counts
    const buckets = {};
    for (const [k, s] of Object.entries(bucketSets)) buckets[k] = s.size;
    const dailyTotals = {};
    for (const [k, s] of Object.entries(dailySets)) dailyTotals[k] = s.size;

    // Build structured output
    const sortedDates = [...dates].sort();
    const hours = Array.from({ length: 17 }, (_, i) => i + 6); // 6 AM to 10 PM

    // Heatmap: per stage, grid of date × hour
    const heatmap = {};
    for (const stage of stages) {
      heatmap[stage] = sortedDates.map(date => ({
        date,
        dayOfWeek: new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' }),
        hours: hours.map(h => ({
          hour: h,
          count: buckets[`${date}|${h}|${stage}`] || 0,
        })),
        total: dailyTotals[`${date}|${stage}`] || 0,
      }));
    }

    // Hourly averages per stage (across all days — shows the typical pattern)
    const hourlyAvg = {};
    for (const stage of stages) {
      hourlyAvg[stage] = hours.map(h => {
        const counts = sortedDates.map(d => buckets[`${d}|${h}|${stage}`] || 0);
        const sum = counts.reduce((a, b) => a + b, 0);
        return {
          hour: h,
          avg: Math.round((sum / Math.max(1, sortedDates.length)) * 10) / 10,
          max: Math.max(...counts),
          min: Math.min(...counts),
        };
      });
    }

    return {
      days: sortedDates.length,
      dates: sortedDates,
      stages,
      hours,
      heatmap,
      hourlyAvg,
      totalTransitions: rows.length,
    };
  },
};
