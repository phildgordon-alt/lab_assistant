/**
 * time-at-lab.js — Job Lifecycle Tracking & Time-at-Lab Analytics
 *
 * Computes per-stage dwell times from DVI trace event data.
 * Stores job lifecycle records + stage transitions in SQLite.
 * Provides aggregated metrics for dashboards + SLA tracking.
 *
 * USAGE in oven-timer-server.js:
 *   const tal = require('./time-at-lab');
 *   tal.start(dviTrace, dviJobIndex);
 *   app.get('/api/time-at-lab/summary', (req, res) => res.json(tal.getSummary(query)));
 */

'use strict';

const { db } = require('./db');

// ─── SCHEMA ────────────────────────────────────────────────────────────────

// Safe migrations
const migrations = [
  `CREATE TABLE IF NOT EXISTS job_lifecycle (
    job_id TEXT PRIMARY KEY,
    coating TEXT,
    lens_material TEXT,
    lens_type TEXT,
    is_rush INTEGER DEFAULT 0,
    entered_lab_at INTEGER,
    entered_surfacing INTEGER,
    exited_surfacing INTEGER,
    entered_coating INTEGER,
    exited_coating INTEGER,
    entered_cutting INTEGER,
    exited_cutting INTEGER,
    entered_assembly INTEGER,
    exited_assembly INTEGER,
    entered_qc INTEGER,
    exited_qc INTEGER,
    shipped_at INTEGER,
    current_stage TEXT DEFAULT 'INCOMING',
    current_station TEXT,
    minutes_total REAL,
    sla_target_days REAL DEFAULT 48,
    sla_due_at INTEGER,
    sla_met INTEGER,
    rework_count INTEGER DEFAULT 0,
    event_count INTEGER DEFAULT 0,
    updated_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_jl_stage ON job_lifecycle(current_stage)`,
  `CREATE INDEX IF NOT EXISTS idx_jl_entered ON job_lifecycle(entered_lab_at)`,
  `CREATE INDEX IF NOT EXISTS idx_jl_shipped ON job_lifecycle(shipped_at)`,
  `CREATE INDEX IF NOT EXISTS idx_jl_coating ON job_lifecycle(coating)`,
  `CREATE INDEX IF NOT EXISTS idx_jl_sla ON job_lifecycle(sla_due_at) WHERE sla_met IS NULL`,

  `CREATE TABLE IF NOT EXISTS stage_transitions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    from_stage TEXT,
    to_stage TEXT NOT NULL,
    from_station TEXT,
    to_station TEXT,
    operator_id TEXT,
    transition_at INTEGER NOT NULL,
    dwell_minutes REAL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_st_job ON stage_transitions(job_id)`,
  `CREATE INDEX IF NOT EXISTS idx_st_time ON stage_transitions(transition_at)`,
];

for (const sql of migrations) {
  try { db.exec(sql); } catch (e) { /* already exists */ }
}

// ─── PREPARED STATEMENTS ───────────────────────────────────────────────────

const stmts = {
  upsertJob: db.prepare(`
    INSERT INTO job_lifecycle (job_id, coating, lens_material, lens_type, is_rush, entered_lab_at, current_stage, current_station, sla_target_days, sla_due_at, event_count, updated_at)
    VALUES (@job_id, @coating, @lens_material, @lens_type, @is_rush, @entered_lab_at, @current_stage, @current_station, @sla_target_days, @sla_due_at, 1, @updated_at)
    ON CONFLICT(job_id) DO UPDATE SET
      current_stage = excluded.current_stage,
      current_station = excluded.current_station,
      event_count = job_lifecycle.event_count + 1,
      updated_at = excluded.updated_at
  `),

  setShipped: db.prepare(`
    UPDATE job_lifecycle SET shipped_at = ?, current_stage = 'SHIPPED',
      minutes_total = ROUND((? - entered_lab_at) / 60000.0, 1),
      sla_met = CASE WHEN ? <= sla_due_at THEN 1 ELSE 0 END,
      updated_at = ?
    WHERE job_id = ?
  `),

  insertTransition: db.prepare(`
    INSERT INTO stage_transitions (job_id, from_stage, to_stage, from_station, to_station, operator_id, transition_at, dwell_minutes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),

  getJob: db.prepare('SELECT * FROM job_lifecycle WHERE job_id = ?'),
  getTransitions: db.prepare('SELECT * FROM stage_transitions WHERE job_id = ? ORDER BY transition_at'),

  // Analytics queries
  getSummary: db.prepare(`
    SELECT coating, lens_material, lens_type, current_stage,
      COUNT(*) as job_count,
      ROUND(AVG(CASE WHEN shipped_at IS NOT NULL THEN (shipped_at - entered_lab_at) / 86400000.0 END), 1) as avg_days,
      ROUND(AVG(CASE WHEN shipped_at IS NULL THEN (? - entered_lab_at) / 86400000.0 END), 1) as avg_days_active
    FROM job_lifecycle
    WHERE entered_lab_at >= ?
    GROUP BY coating, lens_material, lens_type, current_stage
  `),

  getShippedStats: db.prepare(`
    SELECT
      COUNT(*) as total,
      ROUND(AVG((shipped_at - entered_lab_at) / 86400000.0), 1) as avg_days,
      ROUND(MIN((shipped_at - entered_lab_at) / 86400000.0), 1) as min_days,
      ROUND(MAX((shipped_at - entered_lab_at) / 86400000.0), 1) as max_days,
      SUM(CASE WHEN sla_met = 1 THEN 1 ELSE 0 END) as sla_met,
      SUM(CASE WHEN sla_met = 0 THEN 1 ELSE 0 END) as sla_missed
    FROM job_lifecycle
    WHERE shipped_at IS NOT NULL AND shipped_at >= ?
  `),

  getStageDwells: db.prepare(`
    SELECT to_stage as stage, ROUND(AVG(dwell_minutes), 1) as avg_min,
      ROUND(MIN(dwell_minutes), 1) as min_min, ROUND(MAX(dwell_minutes), 1) as max_min,
      COUNT(*) as transitions
    FROM stage_transitions
    WHERE transition_at >= ? AND dwell_minutes > 0 AND dwell_minutes < 1440
    GROUP BY to_stage
    ORDER BY avg_min DESC
  `),

  getActiveWip: db.prepare(`
    SELECT current_stage, COUNT(*) as count,
      ROUND(AVG((? - entered_lab_at) / 86400000.0), 1) as avg_days,
      ROUND(MAX((? - entered_lab_at) / 86400000.0), 1) as oldest_days
    FROM job_lifecycle
    WHERE shipped_at IS NULL AND current_stage != 'SHIPPED'
    GROUP BY current_stage
  `),

  getAtRisk: db.prepare(`
    SELECT job_id, coating, lens_material, lens_type, current_stage, entered_lab_at,
      sla_target_days, sla_due_at,
      ROUND((? - entered_lab_at) / 86400000.0, 1) as days_elapsed,
      ROUND((sla_due_at - ?) / 86400000.0, 1) as days_remaining
    FROM job_lifecycle
    WHERE shipped_at IS NULL AND sla_due_at IS NOT NULL
    ORDER BY days_remaining ASC
    LIMIT 50
  `),

  getRecentShipped: db.prepare(`
    SELECT job_id, coating, lens_material, lens_type, is_rush, entered_lab_at, shipped_at,
      ROUND((shipped_at - entered_lab_at) / 86400000.0, 1) as total_days, sla_met
    FROM job_lifecycle
    WHERE shipped_at IS NOT NULL
    ORDER BY shipped_at DESC
    LIMIT ?
  `),

  getJobCount: db.prepare('SELECT COUNT(*) as cnt FROM job_lifecycle'),
};

// ─── SLA RULES ─────────────────────────────────────────────────────────────

function getSlaDays(lensType, coating, isRush) {
  if (isRush) return 1;       // 1 day
  if (lensType === 'P' && (coating === 'TRANSITIONS' || coating === 'POLARIZED' || coating === 'MIRROR')) return 3;
  if (lensType === 'P') return 2;
  if (coating === 'TRANSITIONS' || coating === 'POLARIZED') return 2;
  if (lensType === 'S' && (coating === 'HARD_COAT' || coating === 'HARD COAT')) return 1;
  return 2; // default
}

// ─── STAGE MAPPING ─────────────────────────────────────────────────────────

const STAGE_ENTER_FIELDS = {
  'SURFACING': 'entered_surfacing',
  'COATING': 'entered_coating',
  'CUTTING': 'entered_cutting',
  'ASSEMBLY': 'entered_assembly',
  'QC': 'entered_qc',
};
const STAGE_EXIT_FIELDS = {
  'SURFACING': 'exited_surfacing',
  'COATING': 'exited_coating',
  'CUTTING': 'exited_cutting',
  'ASSEMBLY': 'exited_assembly',
  'QC': 'exited_qc',
};

// ─── STATE ─────────────────────────────────────────────────────────────────

let dviTraceRef = null;
let dviJobIndexRef = null;
let lastJobStages = new Map(); // job_id → last known stage

// ─── PROCESS JOB EVENT ─────────────────────────────────────────────────────

function processEvent(evt) {
  const now = Date.now();
  const jobId = evt.jobId;
  const stage = evt.stage;
  const station = evt.station;
  const timestamp = evt.timestamp || now;
  const operator = evt.operator || null;

  if (!jobId || !stage) return;

  // Get XML enrichment
  const xml = dviJobIndexRef?.get(jobId) || {};
  const coating = xml.coating || null;
  const lensMat = xml.lensMat || null;
  const lensType = xml.lensType || null;
  const isRush = (xml.rush === 'Y' || evt.rush === 'Y') ? 1 : 0;

  const slaDays = getSlaDays(lensType, coating, isRush);

  // Upsert job lifecycle
  try {
    stmts.upsertJob.run({
      job_id: jobId,
      coating,
      lens_material: lensMat,
      lens_type: lensType,
      is_rush: isRush,
      entered_lab_at: timestamp,
      current_stage: stage,
      current_station: station,
      sla_target_days: slaDays,
      sla_due_at: timestamp + (slaDays * 86400000),
      updated_at: now,
    });
  } catch (e) { /* ignore duplicate */ }

  // Track stage transitions
  const prevStage = lastJobStages.get(jobId);
  if (prevStage && prevStage.stage !== stage) {
    const dwellMin = Math.round((timestamp - prevStage.timestamp) / 60000 * 10) / 10;

    stmts.insertTransition.run(
      jobId, prevStage.stage, stage, prevStage.station, station, operator, timestamp,
      dwellMin > 0 && dwellMin < 1440 ? dwellMin : null
    );

    // Update enter/exit timestamps on job_lifecycle
    const enterField = STAGE_ENTER_FIELDS[stage];
    const exitField = STAGE_EXIT_FIELDS[prevStage.stage];

    if (enterField) {
      try { db.prepare(`UPDATE job_lifecycle SET ${enterField} = ? WHERE job_id = ? AND ${enterField} IS NULL`).run(timestamp, jobId); } catch (e) {}
    }
    if (exitField) {
      try { db.prepare(`UPDATE job_lifecycle SET ${exitField} = ? WHERE job_id = ?`).run(timestamp, jobId); } catch (e) {}
    }

    // Handle shipped
    if (stage === 'SHIPPED' || stage === 'COMPLETE') {
      try { stmts.setShipped.run(timestamp, timestamp, timestamp, now, jobId); } catch (e) {}
    }
  }

  lastJobStages.set(jobId, { stage, station, timestamp });
}

// ─── BACKFILL FROM EXISTING JOBS ───────────────────────────────────────────

function backfill() {
  if (!dviTraceRef) return;
  const jobs = dviTraceRef.getJobs ? dviTraceRef.getJobs() : [];
  console.log(`[TAL] Backfilling ${jobs.length} jobs...`);

  let count = 0;
  for (const job of jobs) {
    const history = dviTraceRef.getJobHistory ? dviTraceRef.getJobHistory(job.job_id) : null;
    if (!history || !history.events || history.events.length === 0) continue;

    // Process each event in order
    lastJobStages.delete(job.job_id); // reset for clean backfill
    for (const evt of history.events) {
      processEvent({
        jobId: job.job_id,
        stage: evt.stage,
        station: evt.station,
        timestamp: evt.timestamp,
        operator: evt.operator,
        rush: job.rush,
      });
    }
    count++;
  }
  console.log(`[TAL] Backfilled ${count} jobs with stage transitions`);
}

// ─── PUBLIC API ────────────────────────────────────────────────────────────

module.exports = {
  start(dviTrace, dviJobIndex) {
    dviTraceRef = dviTrace;
    dviJobIndexRef = dviJobIndex;

    // Listen for real-time events
    if (dviTrace.on) {
      dviTrace.on('event', (evt) => {
        processEvent(evt);
      });
    }

    // Backfill existing jobs after a delay (let DVI trace load first)
    setTimeout(() => backfill(), 15000);

    console.log('[TAL] Time-at-lab tracking started');
  },

  /** Full job lifecycle with transitions */
  getJob(jobId) {
    const job = stmts.getJob.get(jobId);
    if (!job) return null;
    const transitions = stmts.getTransitions.all(jobId);
    const now = Date.now();

    // Compute per-stage minutes from transitions
    const stageDurations = {};
    for (const t of transitions) {
      if (t.dwell_minutes && t.from_stage) {
        stageDurations[t.from_stage] = (stageDurations[t.from_stage] || 0) + t.dwell_minutes;
      }
    }

    return {
      ...job,
      daysElapsed: job.shipped_at
        ? Math.round((job.shipped_at - job.entered_lab_at) / 86400000 * 10) / 10
        : Math.round((now - job.entered_lab_at) / 86400000 * 10) / 10,
      stageDurations,
      transitions,
      slaStatus: job.sla_met === 1 ? 'met' : job.sla_met === 0 ? 'missed' : (job.sla_due_at && now > job.sla_due_at ? 'breached' : 'on_track'),
    };
  },

  /** Summary stats for a time period */
  getSummary(params = {}) {
    const now = Date.now();
    const period = params.period || '7d';
    const periodMs = period === '24h' ? 86400000 : period === '7d' ? 604800000 : period === '30d' ? 2592000000 : 604800000;
    const since = now - periodMs;

    const shipped = stmts.getShippedStats.get(since);
    const stageDwells = stmts.getStageDwells.all(since);
    const wip = stmts.getActiveWip.all(now, now);
    const atRisk = stmts.getAtRisk.all(now, now);

    // Bottleneck = stage with highest avg dwell
    const bottleneck = stageDwells.length > 0 ? stageDwells[0] : null;

    return {
      period,
      shipped: {
        total: shipped?.total || 0,
        avgHours: shipped?.avg_days || 0,
        minHours: shipped?.min_days || 0,
        maxHours: shipped?.max_days || 0,
        slaCompliance: shipped?.total > 0 ? Math.round(((shipped.sla_met || 0) / shipped.total) * 1000) / 10 : 100,
        slaMet: shipped?.sla_met || 0,
        slaMissed: shipped?.sla_missed || 0,
      },
      stageDwells,
      bottleneck: bottleneck ? { stage: bottleneck.stage, avgMinutes: bottleneck.avg_min } : null,
      wip: wip.map(w => ({
        stage: w.current_stage,
        count: w.count,
        avgHours: w.avg_days,
        oldestHours: w.oldest_days,
      })),
      atRisk: atRisk.filter(j => j.days_remaining != null && j.days_remaining < j.sla_target_days * 0.5).map(j => ({
        jobId: j.job_id,
        coating: j.coating,
        stage: j.current_stage,
        daysElapsed: j.days_elapsed,
        daysRemaining: j.days_remaining,
        slaDays: j.sla_target_days,
        status: j.days_remaining <= 0 ? 'breached' : j.days_remaining < 2 ? 'critical' : 'at_risk',
      })),
      totalTracked: stmts.getJobCount.get()?.cnt || 0,
    };
  },

  /** Recent shipped jobs */
  getRecent(limit = 25) {
    return stmts.getRecentShipped.all(limit);
  },

  /** Current WIP by stage */
  getWip() {
    const now = Date.now();
    return stmts.getActiveWip.all(now, now);
  },

  /** SLA at-risk jobs */
  getAtRisk() {
    const now = Date.now();
    return stmts.getAtRisk.all(now, now);
  },

  /** AI-ready context */
  getAIContext() {
    const summary = this.getSummary({ period: '24h' });
    return {
      source: 'time-at-lab',
      ...summary,
    };
  },
};
