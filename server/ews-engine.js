/**
 * ews-engine.js — Early Warning System Engine
 *
 * Core anomaly detection engine for Lab_Assistant.
 * - Stores metric readings in SQLite
 * - Builds rolling baselines segmented by shift slot + day-of-week
 * - Detects anomalies via z-score against baselines
 * - Manages alert lifecycle (firing → acknowledged → resolved)
 * - Routes alerts to Slack
 *
 * USAGE in oven-timer-server.js:
 *   const ews = require('./ews-engine');
 *   ews.start();
 *   app.get('/api/ews/alerts', (req, res) => res.json(ews.getAlerts()));
 *   app.get('/api/ews/baselines', (req, res) => res.json(ews.getBaselines()));
 *   app.get('/api/ews/health', (req, res) => res.json(ews.getHealth()));
 */

'use strict';

const path = require('path');
const Database = require('better-sqlite3');
const fs = require('fs');
const { evaluatePatterns } = require('./ews-patterns');

// ─── CONFIG ────────────────────────────────────────────────────────────────

const POLL_INTERVAL = parseInt(process.env.EWS_POLL_INTERVAL_SEC || '300') * 1000; // 5 min default
const BASELINE_DAYS = parseInt(process.env.EWS_BASELINE_DAYS || '30');
const AUTO_RESOLVE_HOURS = parseInt(process.env.EWS_AUTO_RESOLVE_HOURS || '4');

const THRESHOLDS = {
  P1: parseFloat(process.env.EWS_P1_SIGMA || '3.5'),
  P2: parseFloat(process.env.EWS_P2_SIGMA || '2.5'),
  P3: parseFloat(process.env.EWS_P3_SIGMA || '1.5'),
};

// Minimum samples before baseline is considered reliable
const MIN_BASELINE_SAMPLES = 10;

// Alert dedup window — don't re-fire same metric within this period
const DEDUP_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

// ─── DATABASE ──────────────────────────────────────────────────────────────

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_FILE = path.join(DATA_DIR, 'ews.db');
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');

db.exec(`
  -- Raw metric readings (time series)
  CREATE TABLE IF NOT EXISTS ews_readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    metric TEXT NOT NULL,
    system TEXT NOT NULL,
    value REAL NOT NULL,
    unit TEXT,
    shift_slot TEXT NOT NULL,
    day_of_week INTEGER NOT NULL,
    ts TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ews_readings_metric ON ews_readings(metric, shift_slot, day_of_week);
  CREATE INDEX IF NOT EXISTS idx_ews_readings_ts ON ews_readings(ts);

  -- Computed baselines per metric+shift+dow
  CREATE TABLE IF NOT EXISTS ews_baselines (
    metric TEXT NOT NULL,
    shift_slot TEXT NOT NULL,
    day_of_week INTEGER NOT NULL,
    mean REAL,
    stddev REAL,
    sample_n INTEGER,
    updated_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (metric, shift_slot, day_of_week)
  );

  -- Alert state machine
  CREATE TABLE IF NOT EXISTS ews_alerts (
    id TEXT PRIMARY KEY,
    tier TEXT NOT NULL,
    system TEXT NOT NULL,
    metric TEXT NOT NULL,
    message TEXT NOT NULL,
    detail TEXT,
    deviation REAL,
    baseline REAL,
    current_val REAL,
    unit TEXT,
    status TEXT NOT NULL DEFAULT 'firing',
    fired_at TEXT NOT NULL DEFAULT (datetime('now')),
    acknowledged_at TEXT,
    resolved_at TEXT,
    slack_sent INTEGER DEFAULT 0,
    auto_correlated TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ews_alerts_status ON ews_alerts(status);
  CREATE INDEX IF NOT EXISTS idx_ews_alerts_fired ON ews_alerts(fired_at);
  CREATE INDEX IF NOT EXISTS idx_ews_alerts_tier ON ews_alerts(tier);

  -- Alert history (append-only log)
  CREATE TABLE IF NOT EXISTS ews_alert_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alert_id TEXT NOT NULL,
    event TEXT NOT NULL,
    detail TEXT,
    ts TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ews_hist_alert ON ews_alert_history(alert_id);
`);

// Retention: purge readings older than 90 days
const purgeOldReadings = db.prepare(`
  DELETE FROM ews_readings WHERE ts < datetime('now', '-90 days')
`);

// ─── PREPARED STATEMENTS ───────────────────────────────────────────────────

const insertReading = db.prepare(`
  INSERT INTO ews_readings (metric, system, value, unit, shift_slot, day_of_week, ts)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const getBaselineValues = db.prepare(`
  SELECT value FROM ews_readings
  WHERE metric = ? AND shift_slot = ? AND day_of_week = ?
    AND ts >= datetime('now', ?)
  ORDER BY ts DESC LIMIT 500
`);

const upsertBaseline = db.prepare(`
  INSERT INTO ews_baselines (metric, shift_slot, day_of_week, mean, stddev, sample_n, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT(metric, shift_slot, day_of_week) DO UPDATE SET
    mean = excluded.mean, stddev = excluded.stddev,
    sample_n = excluded.sample_n, updated_at = excluded.updated_at
`);

const getBaseline = db.prepare(`
  SELECT mean, stddev, sample_n FROM ews_baselines
  WHERE metric = ? AND shift_slot = ? AND day_of_week = ?
`);

const insertAlert = db.prepare(`
  INSERT OR REPLACE INTO ews_alerts
    (id, tier, system, metric, message, detail, deviation, baseline, current_val, unit, status, fired_at, auto_correlated)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'firing', datetime('now'), ?)
`);

const getActiveAlerts = db.prepare(`
  SELECT * FROM ews_alerts WHERE status IN ('firing', 'watch') ORDER BY
    CASE tier WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 ELSE 4 END,
    fired_at DESC
`);

const getAllAlerts = db.prepare(`
  SELECT * FROM ews_alerts ORDER BY fired_at DESC LIMIT 100
`);

const getFiringAlertIds = db.prepare(`
  SELECT id, fired_at FROM ews_alerts WHERE status = 'firing'
`);

const acknowledgeAlert = db.prepare(`
  UPDATE ews_alerts SET acknowledged_at = datetime('now') WHERE id = ?
`);

const resolveAlert = db.prepare(`
  UPDATE ews_alerts SET status = 'resolved', resolved_at = datetime('now') WHERE id = ?
`);

const logAlertEvent = db.prepare(`
  INSERT INTO ews_alert_history (alert_id, event, detail) VALUES (?, ?, ?)
`);

const getAllBaselines = db.prepare(`
  SELECT * FROM ews_baselines ORDER BY metric, shift_slot, day_of_week
`);

const getRecentReadings = db.prepare(`
  SELECT metric, system, value, unit, ts FROM ews_readings
  WHERE metric = ? ORDER BY ts DESC LIMIT ?
`);

const getDistinctMetrics = db.prepare(`
  SELECT DISTINCT metric FROM ews_readings
`);

// ─── SHIFT SLOT LOGIC ─────────────────────────────────────────────────────

function shiftSlot(date) {
  const h = date.getHours();
  if (h >= 6 && h < 14) return 'morning';
  if (h >= 14 && h < 22) return 'afternoon';
  return 'night';
}

// ─── METRIC DIRECTION REGISTRY ────────────────────────────────────────────
// HIGH_BAD: high values are bad (errors, downtime, scrap)
// LOW_BAD: low values are bad (throughput, yield, traffic)

const HIGH_BAD = new Set([
  // Machine / equipment
  'som_devices_in_error', 'som_devices_blocked', 'som_conveyor_errors',
  'som_downtime_minutes', 'som_repeated_failures',
  // Inventory
  'itempath_consumption_rate', 'itempath_stockouts', 'itempath_pick_errors',
  // Production
  'dvi_jobs_in_error', 'dvi_hold_count', 'dvi_wip_pileup',
  'dvi_remake_rate', 'breakage_rate',
  // Cycle times (high = slow = bad)
  'cycle_time_surfacing', 'cycle_time_coating', 'cycle_time_cutting',
  'cycle_time_assembly', 'cycle_time_picking',
  // Coating
  'coating_reject_rate', 'oven_temp_deviation',
  // Network
  'network_devices_offline', 'network_cpu_high', 'network_vlan_bleed',
  'network_alarms_active', 'network_latency_avg', 'network_latency_max',
  // WIP volume
  'dvi_total_wip', 'dvi_aged_wip',
  'dvi_queue_depth_surf', 'dvi_queue_depth_coat', 'dvi_queue_depth_cut',
  'dvi_queue_depth_asse', 'dvi_queue_depth_qc',
  // Maintenance / oven
  'oven_overdue_racks', 'maintenance_open_work_orders',
  // Vision
  'vision_exception_count',
]);

const LOW_BAD = new Set([
  'dvi_throughput_per_hour', 'dvi_yield_rate',
  'itempath_stock_level', 'som_oee',
  'dvi_shipped_per_hour',
  // Network
  'network_wan_status',
  // Vision
  'vision_match_rate',
]);

// ─── ALERT DETAIL TEMPLATES ──────────────────────────────────────────────

const ALERT_DETAILS = {
  som_devices_in_error: 'Machine(s) in error state. Check SOM Control Center for fault codes. Review Schneider KMS for resolution procedures.',
  som_devices_blocked: 'Machine(s) blocked — may indicate upstream starvation or downstream backup. Check conveyor flow.',
  som_conveyor_errors: 'Conveyor errors detected. Check zone sensors and belt positions in SOM. Possible jam or misalignment.',
  som_downtime_minutes: 'Excessive unplanned machine downtime. Check maintenance log in Limble for recent work orders.',
  som_repeated_failures: 'Machine experiencing repeated failures within short period. Likely needs maintenance intervention — not just restart.',
  itempath_consumption_rate: 'Lens blank consumption rate significantly above normal. Possible causes: high remake rate, demand spike, or mis-picks inflating consumption.',
  itempath_stockouts: 'SKUs at zero stock in Kardex. Jobs requiring these blanks will stall at picking.',
  itempath_pick_errors: 'Pick error rate elevated. Check Kardex carousel sensor alignment and operator training.',
  dvi_throughput_per_hour: 'Production throughput below baseline. Check upstream departments for bottlenecks — surfacing queue, coating capacity, machine availability.',
  dvi_jobs_in_error: 'Jobs in error state in DVI. These are stalled and need manual intervention.',
  dvi_hold_count: 'Elevated hold count. Review hold reasons — may indicate systemic quality issue.',
  dvi_wip_pileup: 'WIP accumulating in a single zone beyond normal levels. Downstream bottleneck or capacity constraint.',
  dvi_remake_rate: 'Remake rate above baseline. Check scrap by department to identify the source.',
  dvi_yield_rate: 'Yield dropped below baseline. Review breakage events by department for root cause.',
  cycle_time_surfacing: 'Surfacing cycle time drifting up. Check tool wear, coolant, and chuck alignment.',
  cycle_time_coating: 'Coating cycle time above normal. Check oven temp stability and batch sizes.',
  cycle_time_cutting: 'Edging cycle time above normal. Check wheel condition and tracer accuracy.',
  cycle_time_assembly: 'Assembly cycle time drifting up. May indicate complex Rx mix or staffing issue.',
  coating_reject_rate: 'Coating reject rate elevated. Check oven temperature logs, solution age, and humidity.',
  oven_temp_deviation: 'Oven temperature deviating from setpoint. Possible thermocouple or heating element issue.',
  breakage_rate: 'Overall breakage rate above baseline. Check breakage_events table for department-level breakdown.',
  itempath_stock_level: 'Stock levels critically low across multiple SKUs. Check if replenishment orders are in transit.',
  som_oee: 'Overall Equipment Effectiveness below baseline. Review Availability, Performance, and Quality components separately.',
  dvi_shipped_per_hour: 'Ship rate below baseline. Check if assembly/QC is bottlenecked.',
  // Network
  network_devices_offline: 'Network device(s) offline. Check UniFi controller for affected APs/switches. Verify PoE power and uplink cables. Offline devices may impact production systems on that VLAN.',
  network_cpu_high: 'Network device CPU above 85%. Possible broadcast storm, misconfigured client, or firmware issue. Check UniFi controller for the specific device and review traffic patterns.',
  network_vlan_bleed: 'VLAN isolation violation detected — traffic crossing between VLANs that should be isolated. This is a security event. Check firewall rules and switch port configurations immediately.',
  network_client_count: 'Client count anomaly. A sudden drop may indicate an AP failure or network partition. A sudden spike may indicate a rogue device or scanning activity.',
  network_alarms_active: 'Multiple active UniFi alarms. Review alarm list in UniFi controller for connectivity issues, rogue APs, or DPI alerts.',
  network_wan_status: 'WAN link down at one or both sites. Check ISP status and failover configuration. Production systems relying on cloud APIs (DVI, ItemPath) will be impacted.',
  network_latency_avg: 'Elevated WAN latency. Cloud-dependent systems (DVI, ItemPath) may experience timeouts or stale data. Check ISP status and Site Magic tunnel health.',
  network_latency_max: 'WAN latency spike at one or more sites. Check ISP status and failover configuration. May affect API response times for DVI and ItemPath.',
  dvi_aged_wip: 'Jobs lingering >3 days in production. Check for stuck orders, missing parts, or jobs requiring manual intervention in DVI.',
  dvi_total_wip: 'Total WIP exceeding capacity threshold. Check if upstream is feeding faster than downstream can process. May need to throttle picking.',
  dvi_queue_depth_surf: 'Surfacing queue depth above normal. Check machine availability and tool condition on CNC lathes.',
  dvi_queue_depth_coat: 'Coating queue depth above normal. Check oven availability and batch scheduling.',
  dvi_queue_depth_cut: 'Cutting/edging queue depth above normal. Check edger availability and wheel condition.',
  dvi_queue_depth_asse: 'Assembly queue depth above normal. Check station staffing and job complexity mix.',
  dvi_queue_depth_qc: 'QC queue depth above normal. Check inspector availability and hold rate.',
  oven_overdue_racks: 'Multiple oven racks running past target time. Check oven temperature setpoints vs actuals. Overcooked lenses may need re-inspection.',
};

// ─── LAYER 2: RULE-BASED HARD THRESHOLD DETECTION ────────────────────────
// Hard limits that fire regardless of baseline data. Manufacturing-critical.
// Each rule: { metric, op, threshold, tier, message }

const RULES = [
  // Machine / equipment
  { metric: 'som_devices_in_error',     op: '>=', threshold: 2,  tier: 'P1', message: 'CRITICAL: 2+ machines in error state — production line at risk' },
  { metric: 'som_devices_in_error',     op: '>=', threshold: 1,  tier: 'P2', message: 'WARNING: Machine in error state — check SOM Control Center' },
  { metric: 'som_conveyor_errors',      op: '>=', threshold: 3,  tier: 'P1', message: 'CRITICAL: 3+ conveyor errors — material flow disrupted' },
  { metric: 'som_downtime_minutes',     op: '>=', threshold: 5,  tier: 'P2', message: 'WARNING: 5+ device-minutes downtime this poll — multiple machines may be down' },

  // Inventory
  { metric: 'itempath_stockouts',       op: '>=', threshold: 5,  tier: 'P1', message: 'CRITICAL: 5+ SKUs stocked out — picking will stall' },
  { metric: 'itempath_stockouts',       op: '>=', threshold: 2,  tier: 'P2', message: 'WARNING: 2+ SKUs stocked out in Kardex' },

  // DVI / Production
  { metric: 'dvi_jobs_in_error',        op: '>=', threshold: 10, tier: 'P1', message: 'CRITICAL: 10+ jobs in error — systemic DVI issue' },
  { metric: 'dvi_jobs_in_error',        op: '>=', threshold: 5,  tier: 'P2', message: 'WARNING: 5+ jobs in error state in DVI' },
  { metric: 'dvi_hold_count',           op: '>=', threshold: 15, tier: 'P2', message: 'WARNING: 15+ jobs on hold — review hold reasons for systemic issue' },
  { metric: 'dvi_wip_pileup',           op: '>=', threshold: 50, tier: 'P2', message: 'WARNING: 50+ WIP in single zone — downstream bottleneck' },

  // Quality
  { metric: 'breakage_rate',            op: '>=', threshold: 10, tier: 'P1', message: 'CRITICAL: 10+ breakages today — stop and investigate root cause' },
  { metric: 'breakage_rate',            op: '>=', threshold: 5,  tier: 'P2', message: 'WARNING: 5+ breakages today — elevated breakage rate' },
  { metric: 'coating_reject_rate',      op: '>=', threshold: 15, tier: 'P1', message: 'CRITICAL: 15%+ coating reject rate — check oven temps, solution age, humidity' },
  { metric: 'coating_reject_rate',      op: '>=', threshold: 8,  tier: 'P2', message: 'WARNING: 8%+ coating reject rate — trending above acceptable limits' },

  // Maintenance
  { metric: 'maintenance_active_downtime', op: '>=', threshold: 3, tier: 'P2', message: 'WARNING: 3+ active downtime maintenance events — capacity impact' },

  // Network
  { metric: 'network_devices_offline', op: '>=', threshold: 3,  tier: 'P1', message: 'CRITICAL: 3+ network devices offline — possible switch failure or PoE outage' },
  { metric: 'network_devices_offline', op: '>=', threshold: 1,  tier: 'P2', message: 'WARNING: Network device offline — check UniFi controller' },
  { metric: 'network_vlan_bleed',      op: '>=', threshold: 1,  tier: 'P1', message: 'CRITICAL: VLAN isolation violation — security event, traffic crossing restricted boundary' },
  { metric: 'network_cpu_high',        op: '>=', threshold: 2,  tier: 'P2', message: 'WARNING: 2+ network devices with CPU > 85% — possible broadcast storm or firmware issue' },
  { metric: 'network_alarms_active',   op: '>=', threshold: 5,  tier: 'P2', message: 'WARNING: 5+ active UniFi alarms — review controller for systemic network issues' },

  // OEE
  { metric: 'som_oee',                    op: '<=', threshold: 40,  tier: 'P1', message: 'CRITICAL: OEE below 40% — severe capacity loss, immediate intervention needed' },
  { metric: 'som_oee',                    op: '<=', threshold: 60,  tier: 'P2', message: 'WARNING: OEE below 60% — review availability and performance components' },

  // WIP volume
  { metric: 'dvi_aged_wip',               op: '>=', threshold: 20,  tier: 'P2', message: 'WARNING: 20+ aged WIP jobs (>3 days) — review for stuck orders' },
  { metric: 'dvi_total_wip',              op: '>=', threshold: 100, tier: 'P2', message: 'WARNING: Total WIP exceeding 100 jobs — capacity at risk' },

  // Network latency
  { metric: 'network_latency_avg',        op: '>=', threshold: 100, tier: 'P1', message: 'CRITICAL: WAN latency >100ms — cloud API reliability degraded' },
  { metric: 'network_latency_avg',        op: '>=', threshold: 50,  tier: 'P2', message: 'WARNING: WAN latency elevated (>50ms) — monitor API response times' },

  // Maintenance backlog
  { metric: 'maintenance_open_work_orders', op: '>=', threshold: 10, tier: 'P2', message: 'WARNING: 10+ open maintenance work orders — maintenance backlog growing' },

  // Oven
  { metric: 'oven_overdue_racks',          op: '>=', threshold: 3,  tier: 'P1', message: 'CRITICAL: 3+ oven racks overdue — coating quality at risk, check temps' },

  // Vision
  { metric: 'vision_match_rate',           op: '<=', threshold: 80, tier: 'P2', message: 'WARNING: Vision scan accuracy below 80% — check lighting, camera, lens positioning' },
  { metric: 'vision_match_rate',           op: '<=', threshold: 60, tier: 'P1', message: 'CRITICAL: Vision scan accuracy below 60% — scanner system needs immediate attention' },
  { metric: 'vision_exception_count',      op: '>=', threshold: 20, tier: 'P2', message: 'WARNING: 20+ unresolved vision exceptions — operator review needed' },
];

/**
 * Detect rule violations — hard threshold checks that fire regardless of baseline.
 * Rules are evaluated highest-severity-first per metric so only the worst tier fires.
 * Uses 'rule_' prefix on alert IDs to coexist with z-score alerts.
 */
function detectRuleViolations(readings) {
  const firingIds = new Set(getFiringAlertIds.all().map(a => a.id));
  const readingMap = new Map(readings.map(r => [r.metric, r]));
  const alerts = [];
  const firedMetrics = new Set(); // Track which metrics already fired (highest tier wins)

  // Load rules from database (cached 5-min) with fallback to hardcoded
  let labConfig;
  try { labConfig = require('./lab-config'); } catch (e) { labConfig = null; }
  const activeRules = labConfig ? labConfig.getRules() : RULES;

  // Sort rules: P1 first, then P2, so highest severity fires first per metric
  const sortedRules = [...activeRules].sort((a, b) => {
    const tierOrder = { P1: 1, P2: 2, P3: 3 };
    return (tierOrder[a.tier] || 9) - (tierOrder[b.tier] || 9);
  });

  for (const rule of sortedRules) {
    // Skip disabled rules
    if (rule.enabled === 0 || rule.enabled === false) continue;

    // Skip suppressed rules
    if (rule.suppress_until && new Date(rule.suppress_until) > new Date()) continue;

    // Skip if we already fired a higher-severity rule for this metric
    if (firedMetrics.has(rule.metric)) continue;

    const reading = readingMap.get(rule.metric);
    if (!reading) continue;

    // Evaluate the rule
    let violated = false;
    if (rule.op === '>=') violated = reading.value >= rule.threshold;
    else if (rule.op === '<=') violated = reading.value <= rule.threshold;
    else if (rule.op === '>') violated = reading.value > rule.threshold;
    else if (rule.op === '<') violated = reading.value < rule.threshold;

    if (!violated) continue;

    // Dedup: don't re-fire if already firing
    const alertId = `rule_${rule.metric}_${rule.tier}`;
    if (firingIds.has(alertId)) {
      firedMetrics.add(rule.metric);
      continue;
    }

    const detail = ALERT_DETAILS[rule.metric] || `Hard threshold breached: ${reading.value} ${rule.op} ${rule.threshold}. Immediate review recommended.`;

    insertAlert.run(alertId, rule.tier, reading.system, reading.metric,
      rule.message, detail, null, rule.threshold, reading.value, reading.unit, null);
    logAlertEvent.run(alertId, 'fired', `${rule.tier} RULE: ${rule.message} (value: ${reading.value})`);

    // Record fire in rules DB
    if (labConfig && rule.id) {
      try { labConfig.recordRuleFire(rule.id); } catch (e) { /* ignore */ }
    }

    alerts.push({
      id: alertId,
      tier: rule.tier,
      system: reading.system,
      metric: reading.metric,
      message: rule.message,
      detail,
      deviation: null, // rule-based, no sigma
    });
    totalAlertsFired++;
    firedMetrics.add(rule.metric);
  }

  return alerts;
}

/**
 * Auto-resolve rule-based alerts when the metric drops below the threshold
 */
function autoResolveRuleAlerts(readings) {
  const firingAlerts = getFiringAlertIds.all();
  const readingMap = new Map(readings.map(r => [r.metric, r]));

  for (const alert of firingAlerts) {
    if (!alert.id.startsWith('rule_')) continue;

    // Parse: rule_{metric}_{tier}
    const parts = alert.id.split('_');
    const tier = parts[parts.length - 1];
    const metric = parts.slice(1, -1).join('_');

    const reading = readingMap.get(metric);
    if (!reading) continue;

    // Find the matching rule
    const rule = RULES.find(r => r.metric === metric && r.tier === tier);
    if (!rule) continue;

    // Check if the value has dropped below the threshold (with 10% hysteresis)
    let resolved = false;
    const hysteresis = rule.threshold * 0.9; // 10% below threshold to resolve
    if (rule.op === '>=') resolved = reading.value < hysteresis;
    else if (rule.op === '<=') resolved = reading.value > rule.threshold * 1.1;
    else if (rule.op === '>') resolved = reading.value <= hysteresis;
    else if (rule.op === '<') resolved = reading.value >= rule.threshold * 1.1;

    if (resolved) {
      resolveAlert.run(alert.id);
      logAlertEvent.run(alert.id, 'auto_resolved', `Rule threshold cleared (value: ${reading.value}, threshold: ${rule.threshold})`);
    }
  }
}

// ─── CORE ENGINE ──────────────────────────────────────────────────────────

let collectors = [];  // Array of { name, fn } — registered by ews-collectors.js
let pollTimer = null;
let lastPoll = null;
let lastPollDuration = null;
let pollCount = 0;
let totalReadings = 0;
let totalAlertsFired = 0;

/**
 * Register a collector function. Called by ews-collectors.js
 * @param {string} name
 * @param {function} fn - async () => MetricReading[]
 */
function registerCollector(name, fn) {
  collectors.push({ name, fn });
  console.log(`[EWS] Registered collector: ${name}`);
}

/**
 * Store a single metric reading and return it
 */
function storeReading(metric, system, value, unit) {
  const now = new Date();
  const slot = shiftSlot(now);
  const dow = now.getDay(); // 0=Sun, 1=Mon, ... 6=Sat
  const ts = now.toISOString();
  insertReading.run(metric, system, value, unit, slot, dow, ts);
  return { metric, system, value, unit, shift_slot: slot, day_of_week: dow, ts };
}

/**
 * Store multiple readings in a transaction
 */
const storeReadingsBatch = db.transaction((readings) => {
  const now = new Date();
  const slot = shiftSlot(now);
  const dow = now.getDay();
  const ts = now.toISOString();
  for (const r of readings) {
    insertReading.run(r.metric, r.system, r.value, r.unit, slot, dow, ts);
  }
});

/**
 * Detect anomalies in a batch of readings
 */
function detectAnomalies(readings) {
  const now = new Date();
  const slot = shiftSlot(now);
  const dow = now.getDay();
  const firingIds = new Set(getFiringAlertIds.all().map(a => a.id));
  const alerts = [];

  for (const r of readings) {
    const bl = getBaseline.get(r.metric, slot, dow);
    if (!bl || bl.sample_n < MIN_BASELINE_SAMPLES || bl.stddev < 0.001) {
      continue; // Not enough data for baseline
    }

    const deviation = (r.value - bl.mean) / bl.stddev;

    // Direction check
    let isBad = false;
    let absDev = 0;
    if (HIGH_BAD.has(r.metric)) {
      isBad = deviation > 0;
      absDev = deviation;
    } else if (LOW_BAD.has(r.metric)) {
      isBad = deviation < 0;
      absDev = Math.abs(deviation);
    } else {
      absDev = Math.abs(deviation);
      isBad = true;
    }

    if (!isBad || absDev < THRESHOLDS.P3) continue;

    // Assign tier
    let tier;
    if (absDev >= THRESHOLDS.P1) tier = 'P1';
    else if (absDev >= THRESHOLDS.P2) tier = 'P2';
    else tier = 'P3';

    // Dedup: don't re-fire if already firing for this metric
    const alertId = `${r.metric}_${slot}_${dow}`;
    if (firingIds.has(alertId)) continue;

    const direction = HIGH_BAD.has(r.metric) ? 'above' : 'below';
    const message = `${r.system} ${r.metric.replace(/_/g, ' ')} ${r.value.toFixed(1)} ${r.unit} — ${absDev.toFixed(1)}σ ${direction} baseline (normal: ${bl.mean.toFixed(1)}±${bl.stddev.toFixed(1)})`;
    const detail = ALERT_DETAILS[r.metric] || `Deviation of ${absDev.toFixed(1)}σ detected. Review recent readings and system logs.`;

    insertAlert.run(alertId, tier, r.system, r.metric, message, detail,
      Math.round(absDev * 100) / 100, Math.round(bl.mean * 100) / 100,
      r.value, r.unit, null);
    logAlertEvent.run(alertId, 'fired', `${tier}: ${message}`);

    alerts.push({ id: alertId, tier, system: r.system, metric: r.metric, message, detail, deviation: absDev });
    totalAlertsFired++;
  }

  return alerts;
}

/**
 * Auto-resolve alerts where the metric has returned to normal
 */
function autoResolveAlerts(readings) {
  const now = new Date();
  const slot = shiftSlot(now);
  const dow = now.getDay();
  const firingAlerts = getFiringAlertIds.all();
  const readingMap = new Map(readings.map(r => [r.metric, r]));

  for (const alert of firingAlerts) {
    // Check if this alert's metric is back to normal
    const metricKey = alert.id.split('_').slice(0, -2).join('_'); // strip slot_dow
    const reading = readingMap.get(metricKey);
    if (!reading) continue;

    const bl = getBaseline.get(metricKey, slot, dow);
    if (!bl) continue;

    const deviation = Math.abs((reading.value - bl.mean) / (bl.stddev || 1));
    if (deviation < THRESHOLDS.P3 * 0.8) { // Hysteresis: resolve at 80% of P3 threshold
      resolveAlert.run(alert.id);
      logAlertEvent.run(alert.id, 'auto_resolved', `Metric returned to normal (${deviation.toFixed(1)}σ)`);
    }

    // Also auto-resolve if firing for too long without re-trigger
    const firedAt = new Date(alert.fired_at);
    if (now - firedAt > AUTO_RESOLVE_HOURS * 3600 * 1000) {
      resolveAlert.run(alert.id);
      logAlertEvent.run(alert.id, 'expired', `Auto-resolved after ${AUTO_RESOLVE_HOURS}h`);
    }
  }
}

/**
 * Refresh baselines for all known metrics
 */
function refreshBaselines() {
  const metrics = getDistinctMetrics.all();
  const intervalDays = `-${BASELINE_DAYS} days`;
  let updated = 0;

  const doRefresh = db.transaction(() => {
    for (const { metric } of metrics) {
      for (const slot of ['morning', 'afternoon', 'night']) {
        for (let dow = 0; dow < 7; dow++) {
          const rows = getBaselineValues.all(metric, slot, dow, intervalDays);
          if (rows.length < MIN_BASELINE_SAMPLES) continue;

          const values = rows.map(r => r.value);
          const n = values.length;
          const mean = values.reduce((a, b) => a + b, 0) / n;
          const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / n;
          const stddev = Math.sqrt(variance);

          upsertBaseline.run(metric, slot, dow, mean, stddev, n);
          updated++;
        }
      }
    }
  });

  doRefresh();
  console.log(`[EWS] Baselines refreshed: ${updated} segments updated`);
}

/**
 * Route new alerts to Slack
 */
async function routeAlerts(alerts) {
  const slackWebhook = process.env.SLACK_WEBHOOK || '';
  if (!slackWebhook || alerts.length === 0) return;

  for (const alert of alerts) {
    if (alert.tier !== 'P1' && alert.tier !== 'P2') continue;

    const emoji = alert.tier === 'P1' ? ':red_circle:' : ':large_yellow_circle:';
    const payload = {
      text: `${emoji} *[${alert.tier}] ${alert.system}*\n${alert.message}`,
      attachments: [{
        color: alert.tier === 'P1' ? 'danger' : 'warning',
        text: alert.detail,
        footer: `Lab Assistant EWS · ${alert.deviation.toFixed(1)}σ deviation`,
      }]
    };

    try {
      const fetch = (await import('node-fetch')).default;
      const res = await fetch(slackWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        db.prepare('UPDATE ews_alerts SET slack_sent = 1 WHERE id = ?').run(alert.id);
      }
    } catch (e) {
      console.error(`[EWS] Slack send failed: ${e.message}`);
    }
  }
}

/**
 * Main poll cycle — collect, store, detect, route
 */
async function poll() {
  const start = Date.now();
  console.log('[EWS] ─── Poll cycle start ───');

  let allReadings = [];
  for (const collector of collectors) {
    try {
      const readings = await collector.fn();
      if (readings && readings.length > 0) {
        allReadings = allReadings.concat(readings);
      }
    } catch (e) {
      console.error(`[EWS] Collector "${collector.name}" failed: ${e.message}`);
    }
  }

  if (allReadings.length > 0) {
    storeReadingsBatch(allReadings);
  }

  // Layer 1: Statistical anomaly detection (z-score vs baseline)
  const statAlerts = detectAnomalies(allReadings);
  // Layer 2: Rule-based hard threshold detection
  const ruleAlerts = detectRuleViolations(allReadings);
  // Layer 3: AI pattern inference (multi-metric correlation)
  const now = new Date();
  const slot = shiftSlot(now);
  const dow = now.getDay();
  const patternResults = evaluatePatterns(allReadings, (metric) => {
    const bl = getBaseline.get(metric, slot, dow);
    return bl && bl.sample_n >= MIN_BASELINE_SAMPLES ? bl : null;
  });
  // Convert pattern results to alerts
  const patternAlerts = [];
  const firingIds = new Set(getFiringAlertIds.all().map(a => a.id));
  for (const p of patternResults) {
    const alertId = `pattern_${p.id}`;
    if (firingIds.has(alertId)) continue;
    const tier = p.severity === 'CRITICAL' ? 'P1' : p.severity === 'HIGH' ? 'P2' : 'P3';
    insertAlert.run(alertId, tier, 'Pattern', p.id, p.message,
      p.recommended_action, Math.round(p.confidence * 100) / 100, null, null, null, p.name);
    logAlertEvent.run(alertId, 'fired', `${tier} PATTERN: ${p.name} (${Math.round(p.confidence * 100)}% confidence)`);
    patternAlerts.push({ id: alertId, tier, system: 'Pattern', metric: p.id, message: p.message, detail: p.recommended_action, deviation: p.confidence });
    totalAlertsFired++;
  }
  const newAlerts = [...statAlerts, ...ruleAlerts, ...patternAlerts];

  autoResolveAlerts(allReadings);
  autoResolveRuleAlerts(allReadings);

  if (newAlerts.length > 0) {
    const statCount = statAlerts.length;
    const ruleCount = ruleAlerts.length;
    const patternCount = patternAlerts.length;
    console.log(`[EWS] ${newAlerts.length} new alerts (${statCount} statistical, ${ruleCount} rule-based, ${patternCount} pattern): ${newAlerts.map(a => `${a.tier}:${a.metric}`).join(', ')}`);
    await routeAlerts(newAlerts);
  }

  totalReadings += allReadings.length;
  pollCount++;
  lastPoll = new Date().toISOString();
  lastPollDuration = Date.now() - start;

  console.log(`[EWS] Poll complete: ${allReadings.length} readings, ${newAlerts.length} alerts (${lastPollDuration}ms)`);
}

// ─── PUBLIC API ───────────────────────────────────────────────────────────

function start() {
  console.log(`[EWS] Starting Early Warning System (poll every ${POLL_INTERVAL / 1000}s)`);

  // Initial baseline refresh
  refreshBaselines();

  // Run first poll after a brief delay (let adapters initialize)
  setTimeout(() => {
    poll();
    // Schedule recurring polls
    pollTimer = setInterval(poll, POLL_INTERVAL);
    // Refresh baselines hourly
    setInterval(refreshBaselines, 3600 * 1000);
    // Purge old readings daily
    setInterval(() => purgeOldReadings.run(), 24 * 3600 * 1000);
  }, 15000); // 15s startup delay

  console.log('[EWS] Engine started');
}

function stop() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  console.log('[EWS] Engine stopped');
}

function getAlerts(filter) {
  if (filter === 'all') return getAllAlerts.all();
  return getActiveAlerts.all();
}

function getBaselinesData() {
  return getAllBaselines.all();
}

function getMetricHistory(metric, limit = 24) {
  return getRecentReadings.all(metric, limit);
}

function acknowledge(alertId) {
  acknowledgeAlert.run(alertId);
  logAlertEvent.run(alertId, 'acknowledged', null);
}

function resolve(alertId) {
  resolveAlert.run(alertId);
  logAlertEvent.run(alertId, 'resolved', 'Manual resolution');
}

function getHealth() {
  const activeAlerts = getActiveAlerts.all();
  const p1 = activeAlerts.filter(a => a.tier === 'P1' && a.status === 'firing').length;
  const p2 = activeAlerts.filter(a => a.tier === 'P2' && a.status === 'firing').length;
  const p3 = activeAlerts.filter(a => a.tier === 'P3').length;

  return {
    status: p1 > 0 ? 'critical' : p2 > 0 ? 'warning' : 'ok',
    lastPoll,
    lastPollDuration,
    pollCount,
    pollInterval: POLL_INTERVAL / 1000,
    collectors: collectors.map(c => c.name),
    totalReadings,
    totalAlertsFired,
    activeAlerts: { p1, p2, p3, total: activeAlerts.length },
    thresholds: THRESHOLDS,
    baselineDays: BASELINE_DAYS,
  };
}

/**
 * Get AI-ready context for situation report
 */
function getAIContext() {
  const activeAlerts = getActiveAlerts.all();
  const baselines = getAllBaselines.all();

  return {
    source: 'Early Warning System',
    activeAlerts: activeAlerts.map(a => ({
      id: a.id,
      tier: a.tier,
      system: a.system,
      metric: a.metric,
      message: a.message,
      detail: a.detail,
      deviation: a.deviation,
      baseline: a.baseline,
      current: a.current_val,
      unit: a.unit,
      status: a.status,
      fired_at: a.fired_at,
    })),
    baselineCount: baselines.length,
    health: getHealth(),
  };
}

module.exports = {
  start,
  stop,
  registerCollector,
  storeReading,
  poll,
  getAlerts,
  getBaselines: getBaselinesData,
  getMetricHistory,
  acknowledge,
  resolve,
  getHealth,
  getAIContext,
  refreshBaselines,
  // Expose for collectors
  shiftSlot,
  HIGH_BAD,
  LOW_BAD,
  // Layer 2
  RULES,
  detectRuleViolations,
};
